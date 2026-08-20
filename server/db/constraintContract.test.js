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

test('the live dev DB satisfies the contract', async () => {
  // This assertion was withheld when the guard first shipped, because dev
  // genuinely violated it: shifts_status_check was ABSENT there, its DO-block ADD
  // having failed forever against three rows carrying status='confirmed' — a
  // value no schema definition allows and no production code writes. A
  // permanently red guard is one nobody reads, so the check ran advisory-only
  // and printed a note instead.
  //
  // Dev was repaired 2026-08-14 (owner-approved): shifts 16 and 18 → 'completed'
  // (both past, 16 on a completed proposal, 18 orphaned), shift 7761 → 'filled'
  // (the CANCEL-LINE WALK fixture — its event is in the FUTURE on a deposit_paid
  // proposal, so 'completed' would have contradicted the shift-closure sweep's
  // own rule that it only closes a shift once the end instant has passed AND the
  // proposal is completed). The constraint is live on dev again, so the guard
  // enforces rather than advises.
  //
  // If this goes red, dev has drifted — read the violation, do not delete the
  // assertion.
  const violations = await findViolatedConstraintContracts(pool);
  assert.deepEqual(violations, []);
});

// ── (b) the static check: schema.sql's paired definitions must agree ─────────

// schema.sql defines a CHECK constraint in THREE forms, and Postgres gives all
// three the SAME name:
//
//   ALTER TABLE t ADD CONSTRAINT t_col_check CHECK (...)   -- explicitly named
//   CREATE TABLE t ( col ... CHECK (...) )                 -- unnamed, inline
//   ALTER TABLE t ADD COLUMN col ... CHECK (...)           -- unnamed, on add
//
// For an unnamed CHECK, Postgres derives `<table>_<column>_check` when the
// expression references exactly one column and `<table>_check` otherwise, then
// suffixes the `check` label on collision (ChooseConstraintName). So an inline
// CHECK and a later ADD CONSTRAINT are two definitions of ONE constraint, and if
// their bodies differ the file contradicts itself.
//
// The first version of this check parsed only the ADD form and said so in its
// scope comment. That blind spot was not theoretical: FIVE constraints were
// divergent that way, including proposal_payments_payment_type_check (MONEY —
// the inline body omitted three payment types the live code writes) and
// users_role_check (AUTH — the inline body omitted 'manager'). All five are
// aligned in the same change that taught this collector to see them.
//
// The inline form's live blast radius is FRESH-DB-ONLY: `CREATE TABLE IF NOT
// EXISTS` is a no-op on a populated database, so the inline body never re-applies
// and neither prod nor dev was ever at risk from it. The reason to close it
// anyway is the NEXT person — widen a value list inline-first and, before this,
// you got a green suite and a green boot, which is the exact outcome this file
// exists to end.
//
// SCOPE, stated honestly, because the first version of this file claimed less
// than it delivered and the second claimed MORE. What is NOT covered:
//   - Non-CHECK constraints. Seven FOREIGN KEYs are genuinely divergent today
//     (inline `REFERENCES users(id)` vs a later ADD carrying `ON DELETE SET
//     NULL`, e.g. shifts_created_by_fkey). They are deliberately left out: the
//     inline and ADD spellings of an FK differ structurally even when they mean
//     the same thing, so a text comparator would emit seven immediate false
//     positives, and a checker that cries wolf is one people stop reading. A
//     later ADD CONSTRAINT converges them in the same boot. The sharper issue
//     there -- all eight sharing one EXCEPTION handler, so one failure silently
//     rolled back the lot -- was FIXED 2026-08-20: that section is now one
//     conrelid-pinned guarded DO block per FK with no handler, so failures are
//     isolated and loud. The exclusion above still stands on its own reasoning;
//     only the "recorded on the fix list" part is obsolete.
//   - Quoted identifiers (`CREATE TABLE "t"`, `ADD CONSTRAINT "x"`). Postgres
//     preserves their case; nothing in this file uses them.
//   - `LIKE other_table INCLUDING CONSTRAINTS`, and a table created inside a
//     `DO $$` block. Neither occurs here.
//   - Two unnamed CHECKs on ONE column item: only the first is collected.
//   - The collision suffix is derived from the statement alone, so it cannot know
//     about a same-named constraint added elsewhere in the file.
// Each of these is absent from schema.sql today, verified; they are listed so the
// next reader knows the edge of the guarantee instead of inferring a wider one.

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
    'Direction-safe, and the narrower LATER definition is intentional. THREE sites: the '
    + 'CREATE TABLE inline CHECK and the second ALTER both carry the FINAL list, and the '
    + 'first ALTER is the WIDER transitional one — so a partial run accepts everything live '
    + 'code writes, never the reverse. The value the final list drops is "cancelled", a '
    + 'RETIRED proposal status; cancellation is now archived + archive_reason. Aligning the '
    + 'first ALTER DOWN to the other two would be safe but pointless; aligning the other two '
    + 'UP to it would re-admit a value the product deliberately stopped using.'],
  ['clients_source_check',
    'Identical value lists. The ONLY difference is the trailing NOT VALID on the ALTER, which '
    + 'skips validation of pre-existing rows and never changes what a WRITE may contain — so '
    + 'neither site is the narrow one and there is no window to be caught in. It is inert at '
    + 'the inline site by construction: a table being CREATEd has no rows to validate. Recorded '
    + 'here rather than normalized away in the comparator, because NOT VALID is a real modifier '
    + 'and a checker that silently ignored it would hide a genuine difference somewhere else.'],
]);

// Compare SEMANTICS, not formatting. Two definitions that differ only in spacing
// around parens and commas are the same constraint, and flagging that pair would
// be a false positive — the fastest way to teach everyone to ignore this check.
//
// Whitespace is collapsed OUTSIDE string literals only. Inside one it is data:
// IN ('a b') and IN ('a  b') are different permitted values, and folding them
// together would make the comparator quietly unsound in the one direction that
// matters (two real value lists reading as identical).
function normalizeBody(raw) {
  let out = '';
  let buf = '';
  let i = 0;
  const flush = () => {
    out += buf.replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1');
    buf = '';
  };
  while (i < raw.length) {
    if (raw[i] === "'") {
      flush();
      const end = endOfString(raw, i);
      out += raw.slice(i, end);
      i = end;
      continue;
    }
    buf += raw[i];
    i += 1;
  }
  flush();
  return out.trim();
}

// Index just past the single-quoted literal starting at s[i]. SQL escapes a
// quote by DOUBLING it, and schema.sql really does carry those ('Bartender''s
// Picks'), so a backslash-based scanner would desync here.
function endOfString(s, i) {
  i += 1;
  while (i < s.length) {
    if (s[i] === "'" && s[i + 1] === "'") { i += 2; continue; }
    if (s[i] === "'") return i + 1;
    i += 1;
  }
  return i;
}

// Strip SQL comments WITHOUT walking into string literals. A naive /--[^\n]*/
// would eat the rest of the line from inside any literal containing "--", and a
// stripper that desyncs is worse than none: it silently shrinks what the
// collector can see while the suite stays green. The CSS palette checker shipped
// with exactly that failure mode (one stray apostrophe collapsed the sheet to 10
// rules and it still printed the tick).
function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      const end = endOfString(sql, i);
      out += sql.slice(i, end);
      i = end;
    } else if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;   // the \n is copied next pass
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
    } else {
      out += sql[i];
      i += 1;
    }
  }
  return out;
}

// End of one constraint body: the statement's `;`, or a top-level comma, which
// separates the actions of a multi-action ALTER. Depth-0 commas cannot occur
// inside a constraint body itself — every list a constraint carries (IN (...),
// UNIQUE (a, b), REFERENCES t(a, b)) is parenthesised — so a comma at depth 0 is
// always the next action. Scanning rather than a lazy `.*?;` also stops a
// semicolon INSIDE a string literal from truncating the body.
function endOfConstraintBody(s, from) {
  let i = from;
  let depth = 0;
  while (i < s.length) {
    if (s[i] === "'") { i = endOfString(s, i); continue; }
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') depth -= 1;
    else if (depth === 0 && (s[i] === ';' || s[i] === ',')) return i;
    i += 1;
  }
  return s.length;
}

// ADD CONSTRAINT <name> <body>. Names are lower-cased because Postgres folds
// unquoted identifiers, so USERS_ROLE_CHECK and users_role_check are one
// constraint; keying them separately would hide a divergence between them.
function collectConstraintBodies(sql) {
  const bodies = new Map();
  const re = /ADD\s+CONSTRAINT\s+([A-Za-z0-9_]+)\s+/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1].toLowerCase();
    const bodyStart = m.index + m[0].length;
    const body = sql.slice(bodyStart, endOfConstraintBody(sql, bodyStart));
    if (!bodies.has(name)) bodies.set(name, new Set());
    bodies.get(name).add(normalizeBody(body));
    re.lastIndex = bodyStart;   // a later ADD in the same ALTER must still match
  }
  return bodies;
}

// A THIRD auto-named form: `ALTER TABLE t ADD COLUMN c <type> ... CHECK (...)`.
// Postgres names it exactly like the inline form, `<table>_<column>_check`. Two
// live sites: service_packages.bar_type and payout_events.held_state. Neither has
// an ADD CONSTRAINT sibling today, so there is no divergence to report — but the
// repo's own way of widening a list is a guarded DROP + ADD CONSTRAINT swap,
// which would pair with either name, and without this collector that pair would
// go unseen. That is the same shape that produced the inline blind spot.
function collectAddColumnCheckBodies(sql) {
  const bodies = new Map();
  const names = [];
  const re = /ALTER\s+TABLE\s+(?:[A-Za-z0-9_]+\.)?([A-Za-z0-9_]+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)\s/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const statement = sql.slice(m.index, endOfConstraintBody(sql, m.index));
    const c = checkOf(statement);
    if (!c) continue;
    // `ADD COLUMN c TEXT CONSTRAINT foo CHECK (...)` names it explicitly; the
    // match is unanchored here because the statement starts with ALTER TABLE.
    const explicit = /\bCONSTRAINT\s+([A-Za-z0-9_]+)\s+CHECK/i.exec(statement);
    const name = explicit ? explicit[1].toLowerCase() : `${m[1].toLowerCase()}_${m[2].toLowerCase()}_check`;
    names.push(name);
    if (!bodies.has(name)) bodies.set(name, new Set());
    bodies.get(name).add(normalizeBody(`CHECK (${c.expr})`));
  }
  return { bodies, names };
}

// Paren-balanced CREATE TABLE bodies. Literals are skipped so a '(' inside one
// cannot move the depth counter. An unbalanced block is COUNTED, never silently
// dropped — a parse that quietly loses a table is the vacuous-green shape again.
function createTableBodies(sql) {
  const blocks = [];
  let unbalanced = 0;
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[A-Za-z0-9_]+\.)?([A-Za-z0-9_]+)\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    let i = m.index + m[0].length;
    const start = i;
    let depth = 1;
    while (i < sql.length && depth > 0) {
      if (sql[i] === "'") { i = endOfString(sql, i); continue; }
      if (sql[i] === '(') depth += 1;
      else if (sql[i] === ')') depth -= 1;
      i += 1;
    }
    if (depth !== 0) { unbalanced += 1; continue; }
    blocks.push({ table: m[1].toLowerCase(), body: sql.slice(start, i - 1) });
  }
  return { blocks, unbalanced };
}

// Split a CREATE TABLE body on TOP-LEVEL commas (one column or table constraint
// per item). Commas inside CHECK (x IN ('a','b')) must not split.
function splitTopLevelItems(body) {
  const items = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    if (body[i] === "'") { i = endOfString(body, i); continue; }
    if (body[i] === '(') depth += 1;
    else if (body[i] === ')') depth -= 1;
    else if (body[i] === ',' && depth === 0) { items.push(body.slice(start, i)); start = i + 1; }
    i += 1;
  }
  items.push(body.slice(start));
  return items.map((s) => s.trim()).filter(Boolean);
}

const TABLE_LEVEL_ITEM = /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|EXCLUDE|LIKE)\b/i;

function checkOf(item) {
  const m = /\bCHECK\s*\(/i.exec(item);
  if (!m) return null;
  let i = m.index + m[0].length;
  const start = i;
  let depth = 1;
  while (i < item.length && depth > 0) {
    if (item[i] === "'") { i = endOfString(item, i); continue; }
    if (item[i] === '(') depth += 1;
    else if (item[i] === ')') depth -= 1;
    i += 1;
  }
  if (depth !== 0) return null;
  const named = /^CONSTRAINT\s+([A-Za-z0-9_]+)\s+CHECK/i.exec(item);
  return { expr: item.slice(start, i - 1), explicitName: named ? named[1].toLowerCase() : null };
}

function columnNamesOf(items) {
  const cols = new Set();
  for (const item of items) {
    if (TABLE_LEVEL_ITEM.test(item)) continue;
    const m = /^"?([a-z_][a-z0-9_]*)"?\s/i.exec(item);
    if (m) cols.add(m[1].toLowerCase());
  }
  return cols;
}

// Which columns the expression references, found by intersecting its identifiers
// with the table's REAL column names. That sidesteps having to know all of SQL's
// keyword vocabulary; the residual imprecision is a column whose name is also a
// type or function name used in the same expression (none in this file). The
// consequence of getting it wrong is a mis-derived NAME, i.e. a pair this check
// fails to notice — never a false alarm — and the probe test below pins the rule
// itself against a live server.
function referencedColumns(expr, cols) {
  const seen = new Set();
  // eslint-plugin-security flags this as an unsafe regex; it is a false positive.
  // The two alternation branches are disjoint on their first character ([^'] vs
  // the first ' of ''), so every prefix has exactly one parse and there is
  // nothing to backtrack over. Measured linear to 20k chars.
  const withoutLiterals = expr.replace(/'(?:[^']|'')*'/g, "''");
  for (const [word] of withoutLiterals.matchAll(/[a-z_][a-z0-9_]*/gi)) {
    const w = word.toLowerCase();
    if (cols.has(w)) seen.add(w);
  }
  return seen;
}

// ChooseConstraintName suffixes the LABEL, not the whole name, so the collision
// series reads `t_c_check`, `t_c_check1`, `t_c_check2`. Pinned by probe below.
function autoConstraintName(table, refs, taken) {
  const base = refs.size === 1 ? `${table}_${[...refs][0]}_check` : `${table}_check`;
  let name = base;
  let pass = 0;
  while (taken.has(name)) { pass += 1; name = `${base}${pass}`; }
  return name;
}

function collectInlineCheckBodies(sql) {
  const bodies = new Map();
  const names = [];
  const sites = new Map();   // name -> { table, item, expr } for the first site seen
  const { blocks, unbalanced } = createTableBodies(sql);
  for (const { table, body } of blocks) {
    const items = splitTopLevelItems(body);
    const cols = columnNamesOf(items);
    const taken = new Set();
    for (const item of items) {
      const c = checkOf(item);
      if (!c) continue;
      const name = c.explicitName
        || autoConstraintName(table, referencedColumns(c.expr, cols), taken);
      taken.add(name);
      names.push(name);
      if (!bodies.has(name)) bodies.set(name, new Set());
      bodies.get(name).add(normalizeBody(`CHECK (${c.expr})`));
      if (!sites.has(name)) sites.set(name, { table, item, expr: c.expr });
    }
  }
  return { bodies, names, sites, tableCount: blocks.length, unbalanced };
}

// All three forms, merged under the one name Postgres would give them.
function collectAllConstraintBodies(rawSql) {
  const sql = stripSqlComments(rawSql);
  const bodies = collectConstraintBodies(sql);
  const inline = collectInlineCheckBodies(sql);
  const addColumn = collectAddColumnCheckBodies(sql);
  for (const source of [inline.bodies, addColumn.bodies]) {
    for (const [name, set] of source) {
      if (!bodies.has(name)) bodies.set(name, new Set());
      for (const body of set) bodies.get(name).add(body);
    }
  }
  return { bodies, inline, addColumn };
}

const readSchema = () => fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

test('every CHECK defined more than once — inline, ADD COLUMN, or ADD CONSTRAINT — has IDENTICAL bodies', () => {
  const { bodies } = collectAllConstraintBodies(readSchema());

  const divergentNames = [...bodies.entries()].filter(([, set]) => set.size > 1).map(([n]) => n);

  const unadjudicated = divergentNames
    .filter((n) => !ADJUDICATED_DIVERGENCE.has(n))
    .map((n) => `${n}:\n    ${[...bodies.get(n)].join('\n    ')}`);

  assert.deepEqual(unadjudicated, [],
    'A constraint defined twice with DIFFERING bodies is live in its narrower form for '
    + 'the seconds between the two blocks on EVERY boot, and the DO-block wrapper swallows '
    + 'the failure. An unnamed inline CHECK in CREATE TABLE counts: Postgres auto-names it '
    + 'exactly what a later ADD CONSTRAINT uses. Make every definition identical, or '
    + 'adjudicate it in ADJUDICATED_DIVERGENCE with a real reason.\n  ' + unadjudicated.join('\n  '));

  // A stale allowlist entry is its own bug: it implies a divergence was reviewed
  // when the pair has since been aligned (or renamed), so the next reader trusts
  // a note about something that no longer exists.
  const stale = [...ADJUDICATED_DIVERGENCE.keys()].filter((n) => !divergentNames.includes(n));
  assert.deepEqual(stale, [],
    `ADJUDICATED_DIVERGENCE names constraint(s) that no longer diverge — delete the entr(ies): ${stale.join(', ')}`);
});

test('the collectors actually see this schema (a parse collapse must not read as green)', () => {
  const { bodies, inline } = collectAllConstraintBodies(readSchema());

  assert.equal(inline.unbalanced, 0,
    `${inline.unbalanced} CREATE TABLE block(s) failed to paren-balance — the parser lost them`);
  assert.ok(inline.tableCount >= 60, `only ${inline.tableCount} CREATE TABLE blocks parsed; expected 60+`);
  assert.ok(inline.names.length >= 60, `only ${inline.names.length} inline CHECKs parsed; expected 60+`);
  assert.ok(bodies.size >= 100, `only ${bodies.size} constraint names collected; expected 100+`);

  // Name-level pins. TEN inline CHECKs share a name with an ADD CONSTRAINT; the
  // six pinned here are the ones that were DIVERGENT (four of the ten already
  // agreed and are not at risk of a silent revert). If the derivation drifts, the
  // collector stops comparing the very pairs it was written for, silently.
  for (const name of ['users_role_check', 'proposal_payments_payment_type_check',
    'proposals_status_check', 'sms_messages_status_check',
    'service_addons_applies_to_check', 'clients_source_check']) {
    assert.ok(inline.names.includes(name), `inline collector no longer derives ${name}`);
  }

  // Body-level pins on the two that carry real risk, so an alignment cannot be
  // quietly reverted at the inline site. AUTH: 'manager'. MONEY: the three
  // drink-plan/invoice payment types the Stripe webhook writes.
  const inlineBody = (n) => [...inline.bodies.get(n)][0];
  assert.match(inlineBody('users_role_check'), /'manager'/);
  for (const v of ['drink_plan_extras', 'drink_plan_with_balance', 'invoice']) {
    assert.match(inlineBody('proposal_payments_payment_type_check'), new RegExp(`'${v}'`));
  }
});

test('the ADD COLUMN ... CHECK form is collected too', () => {
  // The third auto-named form, and the one this file's own comments denied the
  // existence of until 2026-08-14. Two live sites; neither has an ADD CONSTRAINT
  // sibling today, so the value here is entirely about the next widening.
  const { addColumn, bodies } = collectAllConstraintBodies(readSchema());
  for (const name of ['service_packages_bar_type_check', 'payout_events_held_state_check']) {
    assert.ok(addColumn.names.includes(name), `ADD COLUMN collector no longer derives ${name}`);
    assert.ok(bodies.has(name), `${name} did not reach the merged map`);
  }

  // And it must actually MERGE with an ADD CONSTRAINT of the same name, or it is
  // collecting into a corner where no comparison happens.
  const merged = collectAllConstraintBodies(`
    ALTER TABLE zz_ac ADD COLUMN IF NOT EXISTS s TEXT CHECK (s IN ('a','b'));
    ALTER TABLE zz_ac DROP CONSTRAINT IF EXISTS zz_ac_s_check;
    ALTER TABLE zz_ac ADD CONSTRAINT zz_ac_s_check CHECK (s IN ('a','b','c'));
  `).bodies;
  assert.equal(merged.get('zz_ac_s_check').size, 2,
    'an ADD COLUMN CHECK must be compared against a same-named ADD CONSTRAINT');
});

test('constraint names are folded to lower case, as Postgres folds them', () => {
  // Unquoted identifiers are case-insensitive in Postgres, so these are ONE
  // constraint. Keying them separately would hide a real divergence.
  const { bodies } = collectAllConstraintBodies(`
    CREATE TABLE IF NOT EXISTS zz_case ( s TEXT CHECK (s IN ('a','b')) );
    ALTER TABLE zz_case ADD CONSTRAINT ZZ_CASE_S_CHECK CHECK (s IN ('a','b','c'));
  `);
  assert.equal(bodies.get('zz_case_s_check').size, 2);
});

test('a semicolon inside a literal does not truncate an ADD body', () => {
  // With a lazy .*?; capture both of these truncate to the same prefix and the
  // divergence disappears.
  const { bodies } = collectAllConstraintBodies(`
    ALTER TABLE zz_semi ADD CONSTRAINT zz_semi_s_check CHECK (s <> 'x;y' AND s IN ('a'));
    ALTER TABLE zz_semi ADD CONSTRAINT zz_semi_s_check CHECK (s <> 'x;y' AND s IN ('a','b'));
  `);
  assert.equal(bodies.get('zz_semi_s_check').size, 2);
});

test('a multi-action ALTER records each constraint separately', () => {
  const { bodies } = collectAllConstraintBodies(`
    ALTER TABLE zz_multi ADD CONSTRAINT zz_multi_a_check CHECK (a IN ('x')),
                         ADD CONSTRAINT zz_multi_b_check CHECK (b IN ('y'));
  `);
  assert.equal(bodies.get('zz_multi_a_check').size, 1);
  assert.match([...bodies.get('zz_multi_a_check')][0], /^CHECK\(a IN\('x'\)\)$/);
  assert.ok(bodies.has('zz_multi_b_check'), 'the second action must be collected');
});

test('whitespace INSIDE a literal is data, not formatting', () => {
  // IN ('a b') and IN ('a  b') permit different values; collapsing both would
  // make two real value lists compare equal.
  const { bodies } = collectAllConstraintBodies(`
    ALTER TABLE zz_ws ADD CONSTRAINT zz_ws_s_check CHECK (s IN ('a b'));
    ALTER TABLE zz_ws ADD CONSTRAINT zz_ws_s_check CHECK (s IN ('a  b'));
  `);
  assert.equal(bodies.get('zz_ws_s_check').size, 2);
});

test('the inline auto-name derivation matches what Postgres really assigns', async () => {
  // The derivation is a claim about the SERVER's behavior, so it is pinned
  // against the server rather than against a reading of its source. The same
  // CREATE TABLE text goes to both the collector and Postgres, and the two name
  // sets must be equal. Covers all three branches: one referenced column ->
  // <table>_<col>_check; two or more -> <table>_check; and the collision series
  // that suffixes the LABEL (_check1), which is the part most likely to be wrong.
  const probeSql = `CREATE TABLE zz_name_probe (
    a TEXT CHECK (a IN ('x','y')),
    b INTEGER CHECK (b > 0),
    c INTEGER,
    CHECK (b < 100),
    CHECK (b < c),
    CHECK (b + c > 0)
  )`;

  const derived = collectInlineCheckBodies(probeSql).names;

  const client = await pool.connect();
  let actual;
  try {
    await client.query('BEGIN');
    // TEMP + ROLLBACK: nothing is written to the shared dev database.
    await client.query(probeSql.replace('CREATE TABLE', 'CREATE TEMP TABLE'));
    const { rows } = await client.query(
      `SELECT conname FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'zz_name_probe' AND c.contype = 'c'
        ORDER BY c.oid`
    );
    actual = rows.map((r) => r.conname);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }

  assert.deepEqual([...derived].sort(), [...actual].sort(),
    `derivation disagrees with Postgres.\n  derived: ${derived}\n  actual:  ${actual}`);
  assert.ok(actual.includes('zz_name_probe_check1'),
    'probe did not exercise the collision suffix — it is no longer proving the hard part');
});

test('a fresh table ACCEPTS every value its own inline CHECK permits', async () => {
  // The pairing check above compares TEXT, so it is blind to a column too narrow
  // for the values its CHECK allows — CHECK says yes, VARCHAR(n) raises 22001.
  // That is not hypothetical: proposal_payments.payment_type was created
  // VARCHAR(20) while 'drink_plan_with_balance' is 23 chars, which is why a
  // guarded ALTER ... TYPE VARCHAR(30) exists further down the file. Aligning the
  // inline CHECK without moving the width WITH it would have recreated that
  // overflow on every fresh database, in the money path, silently.
  //
  // Each column definition is taken VERBATIM out of schema.sql and stood up as a
  // one-column TEMP TABLE inside a transaction that always rolls back, so nothing
  // touches the shared dev database.
  const { inline } = collectAllConstraintBodies(readSchema());
  const probes = ['proposal_payments_payment_type_check', 'users_role_check',
    'proposals_status_check', 'sms_messages_status_check',
    'service_addons_applies_to_check', 'clients_source_check'];

  const client = await pool.connect();
  const failures = [];
  try {
    await client.query('BEGIN');
    for (const name of probes) {
      const site = inline.sites.get(name);
      assert.ok(site, `${name} has no inline site — the probe list is stale`);
      const column = /^"?([a-z_][a-z0-9_]*)"?\s/i.exec(site.item)[1];
      const values = [...site.expr.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
      assert.ok(values.length >= 2, `${name}: probe found ${values.length} value(s), not a real list`);

      const table = `zz_width_${name}`;   // keyed on the CONSTRAINT: two probes can share a column name
      await client.query(`CREATE TEMP TABLE ${table} (${site.item})`);
      // SAVEPOINT per insert. Without one the FIRST genuine rejection — the 22001
      // this probe exists to catch — aborts the whole transaction, so every later
      // value reports 25P02 instead of a real diagnosis, the next CREATE throws
      // uncaught, and the collected report never prints. The test would still go
      // red, but it would be useless at the exact moment it fired.
      for (const value of values) {
        await client.query('SAVEPOINT probe_value');
        try {
          await client.query(`INSERT INTO ${table} (${column}) VALUES ($1)`, [value]);
          await client.query('RELEASE SAVEPOINT probe_value');
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT probe_value');
          failures.push(`${name}: '${value}' is permitted by the CHECK but rejected by the column (${err.code} ${err.message})`);
        }
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  assert.deepEqual(failures, [], failures.join('\n  '));
});

test('no derived name reaches the identifier length limit (where Postgres truncates)', () => {
  // Past 63 bytes Postgres truncates, and the derivation would diverge from the
  // real name with no other symptom. Nothing in this file is close; this asserts
  // that stays true rather than assuming it.
  const { inline } = collectAllConstraintBodies(readSchema());
  const tooLong = inline.names.filter((n) => Buffer.byteLength(n) >= 63);
  assert.deepEqual(tooLong, [], `name(s) at/over NAMEDATALEN, derivation unreliable: ${tooLong}`);
});

test('an inline CHECK that disagrees with its ADD sibling IS caught', () => {
  // The pairing test is only worth its green tick if this fails when it should.
  const { bodies } = collectAllConstraintBodies(`
    CREATE TABLE IF NOT EXISTS zz_demo (
      id SERIAL PRIMARY KEY,
      s TEXT CHECK (s IN ('a','b'))
    );
    DO $$ BEGIN
      ALTER TABLE zz_demo ADD CONSTRAINT zz_demo_s_check CHECK (s IN ('a','b','c'));
    EXCEPTION WHEN OTHERS THEN NULL; END $$;
  `);
  assert.equal(bodies.get('zz_demo_s_check').size, 2,
    'inline body and ADD body must land under the same name and be seen as divergent');
});

test('an inline CHECK that AGREES with its ADD sibling is not a false positive', () => {
  const { bodies } = collectAllConstraintBodies(`
    CREATE TABLE IF NOT EXISTS zz_ok (
      s TEXT CHECK (s IN ('a', 'b'))
    );
    ALTER TABLE zz_ok ADD CONSTRAINT zz_ok_s_check CHECK (s IN ('a','b'));
  `);
  assert.equal(bodies.get('zz_ok_s_check').size, 1, 'whitespace-only difference must normalize to one body');
});

test('a commented-out definition is not collected', () => {
  // Otherwise the check reports a divergence against a line that never executes.
  const { bodies } = collectAllConstraintBodies(`
    -- ALTER TABLE zz_c ADD CONSTRAINT zz_c_s_check CHECK (s IN ('old'));
    ALTER TABLE zz_c ADD CONSTRAINT zz_c_s_check CHECK (s IN ('new'));
  `);
  assert.equal(bodies.get('zz_c_s_check').size, 1);
  assert.match([...bodies.get('zz_c_s_check')][0], /'new'/);
});

test('a literal containing -- does not truncate the parse', () => {
  // The reason stripSqlComments walks strings instead of running a regex.
  const { bodies } = collectAllConstraintBodies(`
    ALTER TABLE zz_d ADD CONSTRAINT zz_d_s_check CHECK (s <> 'a--b' AND s <> 'q');
  `);
  assert.equal(bodies.get('zz_d_s_check').size, 1);
  assert.match([...bodies.get('zz_d_s_check')][0], /'q'/);
});

test('a doubled-quote escape does not desync the parse', () => {
  // 'Bartender''s Picks' is real content in schema.sql (20 occurrences).
  //
  // Honest note on what this pins: it pins the OUTCOME, not the mechanism.
  // Deleting the `''` branch in endOfString leaves this green, and that is
  // correct rather than a gap — treating '' as close-then-immediately-reopen
  // covers the identical character span as skipping it, so the two spellings are
  // behaviourally equivalent for every scanner here. The explicit branch stays
  // because it makes the intent legible if this is ever rewritten as something
  // other than a pairwise scanner, where the equivalence would stop holding.
  const { bodies } = collectAllConstraintBodies(`
    CREATE TABLE IF NOT EXISTS zz_e (
      s TEXT CHECK (s IN ('Bartender''s', 'ok'))
    );
  `);
  assert.equal(bodies.get('zz_e_s_check').size, 1);
  assert.match([...bodies.get('zz_e_s_check')][0], /'ok'/);
});

test('the ADD-form static check can actually detect divergence (it is not vacuously green)', () => {
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
