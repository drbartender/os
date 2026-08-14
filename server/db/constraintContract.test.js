require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, findViolatedConstraintContracts, CONSTRAINT_CONTRACT } = require('./index');

if (process.env.NODE_ENV === 'production') {
  throw new Error('constraintContract.test.js refuses to run against production');
}

// Schema-trap sweep, 2026-08-14. schema.sql is re-executed on EVERY boot and is
// not transactional end to end, so a constraint defined twice with differing
// bodies is live in its NARROW form for the seconds between the two blocks —
// every boot, not only an interrupted one. The DO $$ ... EXCEPTION WHEN OTHERS
// THEN NULL wrapper then swallows any failure, so before this guard a narrowed
// or entirely absent constraint booted green.
//
// Two halves are tested here:
//   (a) the runtime guard, findViolatedConstraintContracts, exercised on mocks;
//   (b) a DB-FREE static check that schema.sql's own paired definitions agree,
//       which is what stops the pairing decaying again after someone widens one
//       site and forgets the other. That is exactly how this bug was born.

after(async () => { await pool.end(); });

// ── (a) the runtime guard ───────────────────────────────────────────────────

const defFor = (values) => `CHECK ((status = ANY (ARRAY[${values.map((v) => `'${v}'::text`).join(', ')}])))`;
const allPresent = () => CONSTRAINT_CONTRACT.map(({ constraint, mustContain }) => ({
  conname: constraint,
  def: defFor(mustContain),
}));

test('manifest is never empty — an empty contract would be a vacuous guard', () => {
  assert.ok(CONSTRAINT_CONTRACT.length >= 1);
  for (const entry of CONSTRAINT_CONTRACT) {
    assert.ok(entry.constraint, 'every entry names a constraint');
    assert.ok(Array.isArray(entry.mustContain) && entry.mustContain.length >= 1,
      `${entry.constraint} must require at least one value, or it asserts nothing`);
  }
});

test('every contracted constraint present and wide → no violations', async () => {
  const db = { query: async () => ({ rows: allPresent() }) };
  assert.deepEqual(await findViolatedConstraintContracts(db), []);
});

test('a constraint missing entirely → reported as ABSENT, not silently skipped', async () => {
  const [absent, ...rest] = CONSTRAINT_CONTRACT;
  const db = { query: async () => ({ rows: allPresent().filter((r) => r.conname !== absent.constraint) }) };
  const violations = await findViolatedConstraintContracts(db);
  assert.equal(violations.length, 1);
  assert.match(violations[0], new RegExp(`^${absent.constraint} is ABSENT`));
  assert.ok(rest.length === 0 || !violations[0].includes(rest[0].constraint));
});

test('a constraint NARROWED by one value → reported, naming the missing value', async () => {
  // The real bug shape: scheduled_messages_status_check without 'processing',
  // the dispatcher's own claim state. Every claim then raises 23514, and the
  // dispatcher's generic catch records status='failed', which is TERMINAL — so
  // the batch is not retried, it is permanently dropped.
  const target = CONSTRAINT_CONTRACT.find((c) => c.mustContain.length > 1) || CONSTRAINT_CONTRACT[0];
  const dropped = target.mustContain[0];
  const rows = allPresent().map((r) => (r.conname === target.constraint
    ? { conname: r.conname, def: defFor(target.mustContain.filter((v) => v !== dropped)) }
    : r));
  const violations = await findViolatedConstraintContracts({ query: async () => ({ rows }) });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /is NARROWED/);
  assert.match(violations[0], new RegExp(dropped));
});

test('varchar columns render ::character varying and still match', async () => {
  // pg_get_constraintdef casts to the column type; shifts.status is VARCHAR, so
  // its def reads 'open'::character varying. The quoted literal is unchanged,
  // which is why the check matches on that and not on the cast.
  const rows = CONSTRAINT_CONTRACT.map(({ constraint, mustContain }) => ({
    conname: constraint,
    def: `CHECK (((status)::text = ANY ((ARRAY[${mustContain.map((v) => `'${v}'::character varying`).join(', ')}])::text[])))`,
  }));
  assert.deepEqual(await findViolatedConstraintContracts({ query: async () => ({ rows }) }), []);
});

test('scopes the catalog lookup to the public schema', async () => {
  let sql = '';
  await findViolatedConstraintContracts({ query: async (q) => { sql = q; return { rows: allPresent() }; } });
  assert.match(sql, /nspname\s*=\s*'public'/);
});

test('propagates a catalog error (initDb wraps it into an alert, never a boot crash)', async () => {
  const db = { query: async () => { throw new Error('ECONNREFUSED'); } };
  await assert.rejects(() => findViolatedConstraintContracts(db), /ECONNREFUSED/);
});

test('runs against the live dev DB without throwing, and returns an array', async () => {
  // Deliberately NOT asserting []. As of 2026-08-14 dev genuinely violates the
  // contract: shifts_status_check is ABSENT there, because its DO-block ADD has
  // been failing forever against three rows carrying status='confirmed' (a value
  // no schema definition allows, written by the unvalidated PUT /shifts/:id).
  // That is a REAL finding this guard surfaced on its first run, not test flake.
  // Asserting [] here would make the suite permanently red, and a permanently
  // red guard is one nobody reads — the exact failure mode criticalIndexes.test.js
  // documents. Restore the assertion once dev is repaired.
  const violations = await findViolatedConstraintContracts(pool);
  assert.ok(Array.isArray(violations));
  if (violations.length > 0) console.log('  note: live DB violations →', violations);
});

// ── (b) the static check: schema.sql's paired definitions must agree ─────────

// Divergent pairs that have been looked at individually and are NOT traps. Each
// needs a reason that survives re-reading, because "it was already like that" is
// how the real traps stayed in the file. A stale entry fails the suite below, so
// this list cannot quietly rot.
const ADJUDICATED_DIVERGENCE = new Map([
  ['proposals_gratuity_jar_check',
    'MONEY, and deliberately left alone. Both sites are guarded: the earlier is '
    + 'IF NOT EXISTS so it never drops an existing constraint, and the later swaps it '
    + 'only when pg_get_constraintdef shows the floor-rate arm missing. The pair '
    + 'self-converges on the next boot even from an interrupted one. Verified 2026-08-14: '
    + 'prod and dev both carry the correct three-clause definition. Widening the earlier '
    + 'body would be harmless but this is a live money CHECK and it needs no touch.'],
  ['proposals_status_check',
    'Direction-safe, and the narrower LATER definition is intentional. The earlier body '
    + 'is the WIDER transitional one, so a partial run accepts everything live code writes '
    + '(never the reverse). The value it drops is "cancelled", which is a RETIRED proposal '
    + 'status — cancellation is now archived + archive_reason. Aligning the pair would '
    + 're-admit a value the product deliberately stopped using.'],
]);

// Compare SEMANTICS, not formatting. Two definitions that differ only in spacing
// around parens and commas are the same constraint, and flagging that pair would
// be a false positive — the fastest way to teach everyone to ignore this check.
function normalizeBody(raw) {
  return raw.replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();
}

// ADD CONSTRAINT <name> ... up to the statement-terminating semicolon.
function collectConstraintBodies(sql) {
  const bodies = new Map();
  const re = /ADD\s+CONSTRAINT\s+([a-z0-9_]+)\s+([\s\S]*?);/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const [, name, rawBody] = m;
    if (!bodies.has(name)) bodies.set(name, new Set());
    bodies.get(name).add(normalizeBody(rawBody));
  }
  return bodies;
}

// SCOPE, stated honestly because the first version of this test claimed more
// than it delivered. The collector parses `ALTER TABLE ... ADD CONSTRAINT` only.
// It is BLIND to the file's other duplicate-definition form: an unnamed inline
// CHECK inside CREATE TABLE, which Postgres auto-names `<table>_<col>_check` —
// exactly the string a later ADD CONSTRAINT uses. Five constraints are currently
// defined twice that way with DIFFERING bodies and this check says nothing:
//
//   proposal_payments_payment_type_check  inline ('deposit','balance','full') vs
//                                         ADD (+drink_plan_extras, +drink_plan_with_balance,
//                                         +invoice)                          MONEY
//   users_role_check                      inline ('staff','admin') vs ADD (+manager)   AUTH
//   proposals_status_check                inline lacks 'archived', which live code
//                                         writes constantly — and this THIRD site is
//                                         narrower than either adjudicated one
//   sms_messages_status_check             inline lacks 'received'
//   service_addons_applies_to_check       inline lacks 'class'
//
// Live blast radius today is FRESH-DB-ONLY: `CREATE TABLE IF NOT EXISTS` is a
// no-op on a populated database, so the inline body never re-applies and prod is
// unaffected. That is why this is recorded rather than fixed here. The hazard is
// the NEXT person who widens a value list inline-first, or adds a table whose
// inline CHECK is later widened — they would get a green suite and a green boot,
// which is the exact failure this file exists to end. Extending the collector to
// inline CHECKs (deriving Postgres's auto-name, including its dedup suffixes) is
// the real fix and wants its own lane.
test('every constraint defined more than once VIA ALTER TABLE ADD CONSTRAINT has IDENTICAL bodies', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const bodies = collectConstraintBodies(sql);

  const divergentNames = [...bodies.entries()].filter(([, set]) => set.size > 1).map(([n]) => n);

  const unadjudicated = divergentNames
    .filter((n) => !ADJUDICATED_DIVERGENCE.has(n))
    .map((n) => `${n}:\n    ${[...bodies.get(n)].join('\n    ')}`);

  assert.deepEqual(unadjudicated, [],
    'A constraint defined twice with DIFFERING bodies is live in its narrower form for '
    + 'the seconds between the two blocks on EVERY boot, and the DO-block wrapper swallows '
    + 'the failure. Make every definition identical, or adjudicate it in '
    + 'ADJUDICATED_DIVERGENCE with a real reason.\n  ' + unadjudicated.join('\n  '));

  // A stale allowlist entry is its own bug: it implies a divergence was reviewed
  // when the pair has since been aligned (or renamed), so the next reader trusts
  // a note about something that no longer exists.
  const stale = [...ADJUDICATED_DIVERGENCE.keys()].filter((n) => !divergentNames.includes(n));
  assert.deepEqual(stale, [],
    `ADJUDICATED_DIVERGENCE names constraint(s) that no longer diverge — delete the entr(ies): ${stale.join(', ')}`);
});

test('the static check can actually detect divergence (it is not vacuously green)', () => {
  // The SAME collector, fed a deliberately divergent pair. If this ever stops
  // finding the divergence, the test above is asserting nothing.
  const divergent = collectConstraintBodies(`
    DO $$ BEGIN
      ALTER TABLE t ADD CONSTRAINT zz_demo_check CHECK (s IN ('a','b'));
    EXCEPTION WHEN OTHERS THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE t ADD CONSTRAINT zz_demo_check CHECK (s IN ('a','b','c'));
    EXCEPTION WHEN OTHERS THEN NULL; END $$;
  `);
  assert.equal(divergent.get('zz_demo_check').size, 2, 'must see a real value difference as divergent');
});

test('formatting alone is NOT divergence (no false positive on whitespace)', () => {
  // The users_onboarding pair differs only in spaces around parens and commas.
  // Flagging that would be a false positive, and a checker that cries wolf is one
  // people stop reading — the same trap the CSS palette checker fell into.
  const sameValues = collectConstraintBodies(`
    ALTER TABLE t ADD CONSTRAINT zz_fmt_check CHECK (s IN ('a','b','c'));
    ALTER TABLE t ADD CONSTRAINT zz_fmt_check CHECK (s IN ( 'a','b', 'c' ));
  `);
  assert.equal(sameValues.get('zz_fmt_check').size, 1, 'whitespace-only differences must normalize to one body');
});
