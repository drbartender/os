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

// DROP INDEX matcher. Deliberately wide: CONCURRENTLY is valid here because
// initDb runs statements outside a transaction, a schema-qualified or quoted
// name is the same index, and `DROP INDEX a, b` drops both. A narrower regex
// silently under-reports, and this scan's whole value is that a green result
// means something.
const DROP_INDEX_RE = /\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?((?:"?[A-Za-z_][A-Za-z0-9_]*"?\.)?"?[A-Za-z_][A-Za-z0-9_]*"?)/gi;

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
    const isDo = /^DO\s*\$/i.test(body);
    // A DO block is exempt ONLY if it actually tests the live catalog. Skipping
    // every DO block on the assumption it is conditional let an unconditional
    // drop return under a cargo-culted wrapper with the whole suite green --
    // the exact defect class this file exists to prevent.
    if (isDo && /\bpg_index\b/i.test(body)) continue;
    for (const m of body.matchAll(DROP_INDEX_RE)) {
      bareDrops += 1;
      const name = (m[1] || '').toLowerCase().replace(/^public\./, '').replace(/"/g, '');
      if (created.has(name)) offenders.push(name);
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

  // Variants an adversarial pass demonstrated slipping past the first version.
  const variants = {
    'DO block with no catalog test': `
      DO $$ BEGIN DROP INDEX IF EXISTS idx_demo_guard; END $$;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_demo_guard ON t (a);`,
    'schema-qualified': `
      DROP INDEX public.idx_demo_guard;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_demo_guard ON t (a);`,
    CONCURRENTLY: `
      DROP INDEX CONCURRENTLY idx_demo_guard;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_demo_guard ON t (a);`,
    quoted: `
      DROP INDEX IF EXISTS "idx_demo_guard";
      CREATE UNIQUE INDEX IF NOT EXISTS idx_demo_guard ON t (a);`,
  };
  for (const [label, sql] of Object.entries(variants)) {
    assert.deepStrictEqual(bareDropRecreatePairs(sql).offenders, ['idx_demo_guard'], `missed: ${label}`);
  }

  // A DO block that DOES test the catalog is the shape we ship, and stays clean.
  const conditional = `
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_index i WHERE i.indisunique) THEN
        DROP INDEX public.idx_demo_guard;
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_demo_guard ON t (a);`;
  assert.deepStrictEqual(bareDropRecreatePairs(conditional).offenders, []);
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
    table: 'scheduled_messages',
    wants: /processing/,
    // Every shape a check in the DO block exists to catch. Without a fixture per
    // check, a reviewer demonstrated that DELETING a check leaves the suite green
    // -- so each of these exists to make one condition load-bearing.
    stale: {
      'pending-only predicate (the shape this migrated FROM)': `
        CREATE UNIQUE INDEX idx_scheduled_messages_pending_uniq
          ON scheduled_messages (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
          WHERE status = 'pending'`,
      'processing-only predicate (pins the %pending% half)': `
        CREATE UNIQUE INDEX idx_scheduled_messages_pending_uniq
          ON scheduled_messages (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
          WHERE status = 'processing'`,
      'NOT unique (enforces nothing)': `
        CREATE INDEX idx_scheduled_messages_pending_uniq
          ON scheduled_messages (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
          WHERE status IN ('pending', 'processing')`,
      'WRONG column tuple (right name, wrong guard)': `
        CREATE UNIQUE INDEX idx_scheduled_messages_pending_uniq
          ON scheduled_messages (entity_id, entity_type, message_type)
          WHERE status IN ('pending', 'processing')`,
      'no predicate at all': `
        CREATE UNIQUE INDEX idx_scheduled_messages_pending_uniq
          ON scheduled_messages (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)`,
    },
  },
  {
    name: 'idx_sms_messages_twilio_sid',
    table: 'sms_messages',
    wants: /UNIQUE/,
    stale: {
      'NON-UNIQUE (the shape this migrated FROM)': 'CREATE INDEX idx_sms_messages_twilio_sid ON sms_messages(twilio_sid) WHERE twilio_sid IS NOT NULL',
      'unique but NOT partial (pins the indpred check)': 'CREATE UNIQUE INDEX idx_sms_messages_twilio_sid ON sms_messages(twilio_sid)',
      // Unique AND partial, so this fixture isolates the COLUMN check: it passes
      // every other condition and is still the wrong dedupe guard.
      'WRONG column (right name, wrong guard)': 'CREATE UNIQUE INDEX idx_sms_messages_twilio_sid ON sms_messages(id) WHERE twilio_sid IS NOT NULL',
    },
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

  for (const [label, ddl] of Object.entries(g.stale)) {
    test(`${g.name} > STALE (${label}) is migrated, not left alone`, async () => {
      await inRollback(async (client) => {
        await client.query(`DROP INDEX ${g.name}`);
        await client.query(ddl);
        const staleDef = await defOf(client, g.name);
        assert.ok(staleDef, 'the stale fixture built');

        for (const st of statementsFor(g.name)) await client.query(st);

        const fixed = await defOf(client, g.name);
        assert.ok(fixed, 'the index exists again');
        assert.match(fixed, g.wants, 'a database on the old shape must be migrated');
        assert.notStrictEqual(fixed, staleDef, 'and it must genuinely differ from the stale shape');
        // The correct guard is on the right table with the right arity.
        const shape = await client.query(
          `SELECT i.indnatts, c2.relname AS tbl FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid
             JOIN pg_class c2 ON c2.oid = i.indrelid
            WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace`, [g.name]);
        assert.strictEqual(shape.rows[0].tbl, g.table, 'rebuilt on the right table');
      });
    });
  }
}
