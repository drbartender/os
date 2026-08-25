require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, splitStatements, CRITICAL_INDEXES } = require('./index');

if (process.env.NODE_ENV === 'production') {
  throw new Error('schemaIndexGuards.test.js refuses to run against production');
}

// Backlog §3, 2026-08-25. schema.sql is replayed on EVERY boot and initDb runs
// each statement standalone with no wrapping transaction (db/index.js), so a
// bare `DROP INDEX` followed by `CREATE INDEX` of the SAME NAME leaves that
// index genuinely absent for the gap between the two statements — every deploy,
// not only an interrupted one. Both affected guards are dedupe guards, and the
// old instance is still serving webhooks while the new one runs initDb.
//
// CRITICAL_INDEXES already catches PERMANENT absence loudly. It cannot see the
// transient window, because it runs after the schema apply, when the index is
// back. Closing the window is what this lane does.
//
// The house pattern for a redefinition, spelled out at the idx_email_sends_
// client_sent site, is to create under a NEW name and drop the old — create
// first, so no instant has neither. That is unavailable here without rippling a
// rename through CRITICAL_INDEXES, two test files and two code comments, so
// these two use the other zero-window shape: drop ONLY when the live index is
// actually stale, which makes the steady-state boot a no-op.

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');

after(async () => { await pool.end(); });

/** Strip -- and /* *\/ comments so a name MENTIONED in prose is not read as DDL. */
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

// ── (a) the static guard: DB-free, and the half that stops this coming back ──

/**
 * Index names dropped by an UNCONDITIONAL statement that this same SQL also
 * creates — the drop-then-recreate shape that leaves a boot-length hole.
 * A drop inside a DO block is excluded: those test the live index first and
 * drop only a stale one, so a healthy boot never executes the DROP at all.
 */
function bareDropRecreatePairs(sql) {
  const created = new Set(
    [...stripSqlComments(sql).matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi)]
      .map((m) => m[1].toLowerCase())
  );
  const offenders = [];
  let bareDrops = 0;
  for (const stmt of splitStatements(sql)) {
    const body = stripSqlComments(stmt).trim();
    if (/^DO\s*\$/i.test(body)) continue;
    for (const m of body.matchAll(/\bDROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
      bareDrops += 1;
      if (created.has(m[1].toLowerCase())) offenders.push(m[1].toLowerCase());
    }
  }
  return { offenders, bareDrops, created: created.size };
}

test('the scan catches the defect it exists for (a green result must mean something)', () => {
  // The exact shape both guards carried until 2026-08-25.
  const defective = `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_demo_guard ON t (a) WHERE s = 'pending';
    DROP INDEX IF EXISTS idx_demo_guard;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_demo_guard ON t (a) WHERE s IN ('pending', 'processing');
  `;
  assert.deepStrictEqual(bareDropRecreatePairs(defective).offenders, ['idx_demo_guard']);

  // The conditional shape they carry now, which must read as clean.
  const fixed = `
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_index WHERE false) THEN
        DROP INDEX idx_demo_guard;
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_demo_guard ON t (a) WHERE s IN ('pending', 'processing');
  `;
  assert.deepStrictEqual(bareDropRecreatePairs(fixed).offenders, []);

  // And a legitimate RETIREMENT — dropped, never recreated — stays clean.
  const retirement = 'DROP INDEX IF EXISTS idx_demo_retired;';
  assert.deepStrictEqual(bareDropRecreatePairs(retirement).offenders, []);
});

test('no DROP INDEX in schema.sql names an index schema.sql also CREATEs', () => {
  // The four legitimate DROP INDEXes in this file are RETIREMENTS: three drop a
  // name nothing recreates, one drops the old name beside a create under a new
  // one. Each is a permanent no-op after its first run. A drop-then-create of
  // the SAME name is the defect shape, and it is the one this asserts against.
  const { offenders, bareDrops, created } = bareDropRecreatePairs(schema);
  assert.ok(created >= 50 && bareDrops >= 4, 'the collector actually sees this schema');
  assert.deepStrictEqual(offenders, [],
    `dropped and recreated under the same name by unconditional statements, so the index is absent for the gap on every boot: ${offenders.join(', ')}`);
});

test('every index CRITICAL_INDEXES names is defined exactly once in schema.sql', () => {
  // Two disagreeing definitions of one name is how the pending-uniq window was
  // born: the narrow definition ran first, the wide one dropped and replaced it.
  // With IF NOT EXISTS the earlier one silently wins on a database that has the
  // name already, so two definitions can never be relied on to agree.
  const bare = stripSqlComments(schema);
  for (const name of CRITICAL_INDEXES) {
    const n = [...bare.matchAll(new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}\\b`, 'gi'))].length;
    assert.strictEqual(n, 1, `${name} is CREATEd ${n} times in schema.sql; a contracted index needs one definition`);
  }
});

// ── (b) the behavioural half: run the REAL statements against a real database ──

/** The statements initDb runs that actually touch `name` (comments stripped). */
function statementsFor(name) {
  const re = new RegExp(`\\b(?:DROP|CREATE)\\s+(?:UNIQUE\\s+)?INDEX\\b[\\s\\S]*?\\b${name}\\b|\\b${name}\\b[\\s\\S]*?\\bDROP\\s+INDEX`, 'i');
  return splitStatements(schema).filter((s) => re.test(stripSqlComments(s)));
}

/** Run `fn(client)` inside a transaction that is always rolled back. */
async function inRollback(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

const oidOf = async (client, name) => {
  const r = await client.query("SELECT c.oid FROM pg_class c WHERE c.relname = $1 AND c.relkind = 'i'", [name]);
  return r.rowCount ? r.rows[0].oid : null;
};
const defOf = async (client, name) => {
  const r = await client.query('SELECT indexdef FROM pg_indexes WHERE indexname = $1', [name]);
  return r.rowCount ? r.rows[0].indexdef : null;
};

const GUARDS = [
  {
    name: 'idx_scheduled_messages_pending_uniq',
    // The stale shape this migrated FROM: the pending-only predicate, which
    // stopped guarding a row the moment the dispatcher claimed it.
    stale: `CREATE UNIQUE INDEX idx_scheduled_messages_pending_uniq
              ON scheduled_messages (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
              WHERE status = 'pending'`,
    wants: /processing/,
  },
  {
    name: 'idx_sms_messages_twilio_sid',
    // The stale shape this migrated FROM: a NON-UNIQUE index of the same name,
    // which indexes lookups but enforces no webhook-retry dedupe at all.
    stale: 'CREATE INDEX idx_sms_messages_twilio_sid ON sms_messages(twilio_sid) WHERE twilio_sid IS NOT NULL',
    wants: /UNIQUE/,
  },
];

for (const g of GUARDS) {
  test(`${g.name} > the statements are found and actually run`, async () => {
    const stmts = statementsFor(g.name);
    assert.ok(stmts.length >= 1, 'a collector that finds nothing would make every test below vacuous');
    await inRollback(async (client) => {
      for (const s of stmts) await client.query(s);
    });
  });

  test(`${g.name} > a boot against a CORRECT index never drops it (no window)`, async () => {
    await inRollback(async (client) => {
      const before = await oidOf(client, g.name);
      assert.ok(before, 'the dev DB carries this index; without it the test proves nothing');

      for (const s of statementsFor(g.name)) await client.query(s);

      // A same-oid index was never dropped. A dropped-and-recreated index gets a
      // new oid even when the definition is identical, so this distinguishes the
      // fixed shape from the old one — which is the whole point of the lane.
      assert.strictEqual(await oidOf(client, g.name), before,
        'the index was dropped and rebuilt, so a boot still has a window with no guard');
    });
  });

  test(`${g.name} > a boot against a STALE index still upgrades it`, async () => {
    await inRollback(async (client) => {
      await client.query(`DROP INDEX ${g.name}`);
      await client.query(g.stale);
      const staleDef = await defOf(client, g.name);
      assert.doesNotMatch(staleDef, g.wants, 'the fixture really is the stale shape');

      for (const s of statementsFor(g.name)) await client.query(s);

      const fixed = await defOf(client, g.name);
      assert.ok(fixed, 'the index exists again');
      assert.match(fixed, g.wants, 'a database still on the old shape must be migrated, not left alone');
    });
  });
}
