process.env.NODE_ENV = 'test';
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const START = '-- ─── Menu art generator (spec 2026-10-01-menu-art-generator) ───';
const END = '-- ─── end Menu art generator ───';

// Just the menu art block, so the live half applies exactly this DDL and the
// pure half cannot be satisfied by a same-named column elsewhere in the file.
function menuArtDdl() {
  const a = schemaSql.indexOf(START);
  const b = schemaSql.indexOf(END);
  assert.ok(a !== -1 && b > a, 'the menu art block sits between its two markers in schema.sql');
  return schemaSql.slice(a, b);
}

function tableBody(ddl, table) {
  const head = `CREATE TABLE IF NOT EXISTS ${table} (\n`;
  const a = ddl.indexOf(head);
  const b = ddl.indexOf('\n);', a);
  assert.ok(a !== -1 && b > a, `${table} is created IF NOT EXISTS inside the block`);
  return ddl.slice(a + head.length, b);
}

// A CREATE TABLE body as { column: definition } plus its table-level
// constraint lines, whitespace collapsed, so each table is compared whole: a
// missing, extra or reworded column fails, not only a missing one.
function parseBody(body) {
  const columns = {};
  const constraints = [];
  for (const raw of body.split('\n')) {
    const line = raw.replace(/--.*$/, '').trim().replace(/,$/, '').replace(/\s+/g, ' ');
    if (!line) continue;
    if (/^(UNIQUE|CHECK|PRIMARY KEY|FOREIGN KEY|CONSTRAINT)\b/.test(line)) {
      constraints.push(line);
    } else {
      const sp = line.indexOf(' ');
      columns[line.slice(0, sp)] = line.slice(sp + 1);
    }
  }
  return { columns, constraints };
}

// ── Pure: the DDL text ──────────────────────────────────────────────────────

test('the block follows the menu-print columns, and everything it references is defined earlier', () => {
  const at = schemaSql.indexOf(START);
  assert.ok(at !== -1 && schemaSql.indexOf('ADD COLUMN IF NOT EXISTS menu_not_required') < at, 'after the menu-print columns');
  for (const re of [/CREATE OR REPLACE FUNCTION update_updated_at_column\(\)/, /CREATE TABLE IF NOT EXISTS users \(/,
    /CREATE TABLE IF NOT EXISTS drink_plans \(/, /CREATE TABLE IF NOT EXISTS proposals \(/]) {
    const m = re.exec(schemaSql);
    assert.ok(m && m.index < at, `${re} is defined before the menu art block`);
  }
});

test('every statement in the block is idempotent', () => {
  const ddl = menuArtDdl().replace(/--[^\n]*/g, '');
  assert.equal((ddl.match(/CREATE TABLE/g) || []).length, 3);
  assert.equal((ddl.match(/CREATE TABLE IF NOT EXISTS/g) || []).length, 3);
  assert.equal((ddl.match(/CREATE (UNIQUE )?INDEX/g) || []).length, 2);
  assert.equal((ddl.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, 2);
  const triggers = [...ddl.matchAll(/CREATE TRIGGER (\w+) BEFORE UPDATE ON (\w+)/g)];
  assert.equal(triggers.length, 2);
  for (const [stmt, name, table] of triggers) {
    // Created only IF ABSENT inside a DO block (never DROP then CREATE, which
    // leaves a no-trigger window on every boot replay).
    const guard = ddl.indexOf(`WHERE tgname = '${name}'\n      AND tgrelid = '${table}'::regclass`);
    assert.ok(guard !== -1 && guard < ddl.indexOf(stmt), `${name} is created only when absent`);
    assert.doesNotMatch(ddl, new RegExp(`DROP TRIGGER[^;]*${name}`));
  }
  // Each ALTER ... ADD CONSTRAINT is guarded by a pg_constraint lookup of the
  // same name. The only DROP is the provider CHECK's own, inside its guard,
  // which runs it once on a database created before 'anthropic' (lane
  // menu-words-claude); nothing else is ever dropped.
  const alters = [...ddl.matchAll(/ALTER TABLE (\w+) ADD CONSTRAINT (\w+)/g)];
  assert.deepEqual(alters.map(([, table, name]) => `${table}.${name}`),
    ['menu_art_calls.menu_art_calls_provider_check', 'menu_drafts.menu_drafts_json_shape_check']);
  for (const [stmt, table, name] of alters) {
    const guard = ddl.indexOf(`WHERE conname = '${name}'\n      AND conrelid = '${table}'::regclass`);
    assert.ok(guard !== -1 && guard < ddl.indexOf(stmt), `${name} is added only when absent`);
  }
  const drops = [...ddl.matchAll(/\bDROP\b[^;]*/g)].map((m) => m[0]);
  assert.deepEqual(drops, ['DROP CONSTRAINT IF EXISTS menu_art_calls_provider_check']);
  assert.ok(ddl.indexOf("AND pg_get_constraintdef(oid) LIKE '%anthropic%'") < ddl.indexOf(drops[0]),
    'the drop runs only while the live CHECK lacks anthropic');
  assert.ok(!menuArtDdl().includes(String.fromCharCode(0x2014)), 'no em dash in the block');
});

// Each table's columns exactly as spec 6 and the plan write them, whitespace
// collapsed. The pure tests compare the DDL text to these; the live test checks
// the catalog against the shape each definition implies, so there is one copy.
const COLUMNS = {
  menu_drafts: {
    id: 'SERIAL PRIMARY KEY',
    proposal_id: 'INTEGER NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE CASCADE',
    drink_plan_id: 'INTEGER REFERENCES drink_plans(id) ON DELETE SET NULL',
    run_id: 'UUID NOT NULL',
    inputs: 'JSONB NOT NULL', content: 'JSONB NOT NULL', plan_fingerprint: 'JSONB NOT NULL',
    dismissed_plan_hash: 'TEXT',
    version: 'INTEGER NOT NULL DEFAULT 1', art_version: 'INTEGER NOT NULL DEFAULT 0',
    approved_version: 'INTEGER', approved_art_version: 'INTEGER',
    approved_print_key: 'TEXT', approved_planner_image_key: 'TEXT',
    approved_at: 'TIMESTAMPTZ', approved_by: 'INTEGER REFERENCES users(id)',
    created_at: 'TIMESTAMPTZ DEFAULT NOW()', updated_at: 'TIMESTAMPTZ DEFAULT NOW()',
  },
  menu_draft_pieces: {
    id: 'SERIAL PRIMARY KEY',
    draft_id: 'INTEGER NOT NULL REFERENCES menu_drafts(id) ON DELETE CASCADE',
    piece_key: 'TEXT NOT NULL', run_id: 'UUID NOT NULL',
    status: "TEXT NOT NULL CHECK (status IN ('pending','working','done','failed'))",
    r2_key: 'TEXT', error: 'TEXT', reroll_note: 'TEXT',
    heartbeat_at: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    started_at: 'TIMESTAMPTZ', finished_at: 'TIMESTAMPTZ',
    tone: "TEXT CHECK (tone IS NULL OR tone IN ('light','dark'))",
    ground_rgb: 'TEXT',
    provider: "TEXT NOT NULL CHECK (provider IN ('openai','gemini'))",
    model: 'TEXT NOT NULL',
    drawn_count: 'INTEGER NOT NULL DEFAULT 0',
  },
  menu_art_calls: {
    id: 'SERIAL PRIMARY KEY',
    proposal_id: 'INTEGER REFERENCES proposals(id) ON DELETE SET NULL',
    piece_key: 'TEXT', run_id: 'UUID',
    kind: "TEXT NOT NULL CHECK (kind IN ('image','text'))",
    status: "TEXT NOT NULL CHECK (status IN ('reserved','sent','ok','failed','released'))",
    provider: "TEXT NOT NULL CHECK (provider IN ('openai','gemini','anthropic'))",
    model: 'TEXT', size: 'TEXT', error: 'TEXT', provider_request_id: 'TEXT',
    created_at: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    updated_at: 'TIMESTAMPTZ',
  },
};

test('menu_drafts: every column, one row per proposal, approved_planner_image_key, the updated_at trigger', () => {
  const ddl = menuArtDdl();
  const { columns, constraints } = parseBody(tableBody(ddl, 'menu_drafts'));
  assert.deepEqual(columns, COLUMNS.menu_drafts);
  assert.deepEqual(constraints, []);
  assert.match(ddl, /IF NOT EXISTS \(\n\s+SELECT 1 FROM pg_trigger\n\s+WHERE tgname = 'update_menu_drafts_updated_at'/);
  assert.match(ddl, /CREATE TRIGGER update_menu_drafts_updated_at BEFORE UPDATE ON menu_drafts\n\s+FOR EACH ROW EXECUTE FUNCTION update_updated_at_column\(\);/);
});

// Lane menu-bar-baseline: the Saved time moves only on a real edit. The trigger
// is swapped in place, once, for one whose WHEN skips a write that changes only
// plan_fingerprint or dismissed_plan_hash.
test('menu_drafts: the updated_at trigger skips a fingerprint-only or dismissal-only write, swapped in place once', () => {
  const ddl = menuArtDdl();
  assert.match(ddl, /AND pg_get_triggerdef\(oid\) LIKE '%dismissed_plan_hash%'\n\s+\) THEN\n\s+CREATE OR REPLACE TRIGGER update_menu_drafts_updated_at BEFORE UPDATE ON menu_drafts/);
  assert.match(ddl, /WHEN \(\(to_jsonb\(OLD\) - ARRAY\['plan_fingerprint', 'dismissed_plan_hash', 'updated_at'\]\)\n\s+IS DISTINCT FROM \(to_jsonb\(NEW\) - ARRAY\['plan_fingerprint', 'dismissed_plan_hash', 'updated_at'\]\)\)/);
});

test('menu_draft_pieces: every column, the status/tone/provider CHECKs, NOT NULL provider and model, drawn_count, one row per piece', () => {
  const { columns, constraints } = parseBody(tableBody(menuArtDdl(), 'menu_draft_pieces'));
  assert.deepEqual(columns, COLUMNS.menu_draft_pieces);
  assert.deepEqual(constraints, ['UNIQUE (draft_id, piece_key)']);
});

test('menu_art_calls: every column, the kind/status/provider CHECKs, no provider default, the created_at index', () => {
  const ddl = menuArtDdl();
  const { columns, constraints } = parseBody(tableBody(ddl, 'menu_art_calls'));
  assert.deepEqual(columns, COLUMNS.menu_art_calls);
  assert.deepEqual(constraints, []);
  // Spelled out on its own: a default would let a call be logged under the wrong provider.
  assert.doesNotMatch(columns.provider, /DEFAULT/);
  assert.match(ddl, /CREATE INDEX IF NOT EXISTS idx_menu_art_calls_created_at ON menu_art_calls \(created_at\);/);
  assert.match(ddl, /CREATE INDEX IF NOT EXISTS idx_menu_art_calls_open_run ON menu_art_calls \(run_id\)\n\s+WHERE status IN \('reserved','sent'\);/);
  assert.match(ddl, /CREATE TRIGGER update_menu_art_calls_updated_at BEFORE UPDATE ON menu_art_calls\n\s+FOR EACH ROW EXECUTE FUNCTION update_updated_at_column\(\);/);
});

test('menu_drafts: the three JSONB columns must hold objects', () => {
  const ddl = menuArtDdl();
  assert.match(ddl, /ADD CONSTRAINT menu_drafts_json_shape_check CHECK \(\n\s+jsonb_typeof\(inputs\) = 'object'\n\s+AND jsonb_typeof\(content\) = 'object'\n\s+AND jsonb_typeof\(plan_fingerprint\) = 'object'\n\s+\);/);
});

// Spec 2026-10-19 section 16 (lane menu-words-claude): the words step runs on
// Claude and its text row records provider 'anthropic'. A database created
// before this change holds the narrow inline CHECK under the same name, so the
// block widens it once, in place, to the inline CHECK's own list.
const PROVIDER_WIDEN = `DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'menu_art_calls_provider_check'
      AND conrelid = 'menu_art_calls'::regclass
      AND pg_get_constraintdef(oid) LIKE '%anthropic%'
  ) THEN
    ALTER TABLE menu_art_calls DROP CONSTRAINT IF EXISTS menu_art_calls_provider_check;
    ALTER TABLE menu_art_calls ADD CONSTRAINT menu_art_calls_provider_check
      CHECK (provider IN ('openai','gemini','anthropic'));
  END IF;
END $$;`;

test('menu_art_calls.provider takes anthropic: the inline CHECK lists it and one guarded statement widens an older one', () => {
  const ddl = menuArtDdl();
  const at = ddl.indexOf(PROVIDER_WIDEN);
  assert.ok(at !== -1, 'the widening is in the menu art block exactly as written here');
  assert.equal(ddl.indexOf(PROVIDER_WIDEN, at + 1), -1, 'once');
  assert.ok(ddl.indexOf('CREATE TABLE IF NOT EXISTS menu_art_calls (') < at, 'after the table it alters');
  const { columns } = parseBody(tableBody(ddl, 'menu_art_calls'));
  assert.ok(PROVIDER_WIDEN.includes(columns.provider.replace(/^TEXT NOT NULL /, '')), 'the same list as the inline CHECK');
  const pieces = parseBody(tableBody(ddl, 'menu_draft_pieces')).columns;
  assert.equal(pieces.provider, "TEXT NOT NULL CHECK (provider IN ('openai','gemini'))", 'the drawings never run on Anthropic');
});

// Spec 2026-10-19 section 15 (lane menu-no-menu-mark): who set the no-menu
// mark. One idempotent ADD COLUMN after menu_not_required, outside the menu
// art block, with its CHECK inline, so a replay that finds the column skips
// the whole statement.
const NOT_REQUIRED_BY = "ALTER TABLE proposals ADD COLUMN IF NOT EXISTS menu_not_required_by TEXT\n"
  + "  CHECK (menu_not_required_by IS NULL OR menu_not_required_by IN ('admin', 'planner'));";

test('proposals.menu_not_required_by: one idempotent ADD COLUMN with its CHECK, after menu_not_required', () => {
  const at = schemaSql.indexOf(NOT_REQUIRED_BY);
  assert.ok(at !== -1, 'the menu_not_required_by statement is in schema.sql exactly as spec 15 writes it');
  assert.equal(schemaSql.indexOf(NOT_REQUIRED_BY, at + 1), -1, 'once');
  assert.ok(schemaSql.indexOf('ADD COLUMN IF NOT EXISTS menu_not_required BOOLEAN') < at, 'after menu_not_required');
  assert.ok(at < schemaSql.indexOf(START), 'before the menu art block, outside it');
});

// ── The menu proofs block (spec 2026-10-19 sections 10.3 and 10.6; lane menu-proof-page) ──
// Its own block after the menu art one: the menu_proofs table and the four
// menu_drafts release columns, every statement idempotent, no data backfill.
const PROOF_START = '-- ─── Menu proofs (spec 2026-10-19 sections 10.3 and 10.6) ───';
const PROOF_END = '-- ─── end Menu proofs ───';

function menuProofDdl() {
  const a = schemaSql.indexOf(PROOF_START);
  const b = schemaSql.indexOf(PROOF_END);
  assert.ok(a !== -1 && b > a, 'the menu proofs block sits between its two markers in schema.sql');
  return schemaSql.slice(a, b);
}

const PROOF_COLUMNS = {
  id: 'SERIAL PRIMARY KEY',
  draft_id: 'INTEGER NOT NULL REFERENCES menu_drafts(id) ON DELETE CASCADE',
  proposal_id: 'INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE',
  token: 'UUID NOT NULL UNIQUE DEFAULT gen_random_uuid()',
  version: 'INTEGER NOT NULL',
  art_version: 'INTEGER NOT NULL',
  r2_key: 'TEXT NOT NULL',
  sent_at: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()',
  sent_by: 'INTEGER REFERENCES users(id) ON DELETE SET NULL',
  sent_to: 'TEXT',
  email_status: "TEXT NOT NULL CHECK (email_status IN ('pending', 'sent', 'failed', 'no_address', 'skipped', 'suppressed'))",
  withdrawn_at: 'TIMESTAMPTZ',
  superseded_at: 'TIMESTAMPTZ',
  answer: "TEXT CHECK (answer IS NULL OR answer IN ('approved', 'changes'))",
  answer_note: 'TEXT',
  answered_at: 'TIMESTAMPTZ',
};

// The release columns, each added by its own ADD COLUMN IF NOT EXISTS (a
// replay that finds the column skips the whole statement, its FK or CHECK too).
const RELEASE_ADDS = [
  'ALTER TABLE menu_drafts ADD COLUMN IF NOT EXISTS released_print_key TEXT;',
  'ALTER TABLE menu_drafts ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;',
  'ALTER TABLE menu_drafts ADD COLUMN IF NOT EXISTS released_by INTEGER REFERENCES users(id) ON DELETE SET NULL;',
  "ALTER TABLE menu_drafts ADD COLUMN IF NOT EXISTS released_via TEXT\n  CHECK (released_via IS NULL OR released_via IN ('client', 'admin'));",
];
const RELEASE_COLUMNS = {
  released_print_key: 'TEXT',
  released_at: 'TIMESTAMPTZ',
  released_by: 'INTEGER REFERENCES users(id) ON DELETE SET NULL',
  released_via: "TEXT CHECK (released_via IS NULL OR released_via IN ('client', 'admin'))",
};

test('menu proofs: its own block, after the menu art block, every statement idempotent, no backfill', () => {
  const at = schemaSql.indexOf(PROOF_START);
  assert.ok(at > schemaSql.indexOf(END), 'after the end of the menu art block');
  assert.equal(schemaSql.indexOf(PROOF_START, at + 1), -1, 'once');
  const ddl = menuProofDdl().replace(/--[^\n]*/g, '');
  assert.equal((ddl.match(/CREATE TABLE/g) || []).length, 1);
  assert.equal((ddl.match(/CREATE TABLE IF NOT EXISTS menu_proofs \(/g) || []).length, 1);
  assert.equal((ddl.match(/CREATE (UNIQUE )?INDEX/g) || []).length, 1);
  assert.equal((ddl.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, 1);
  assert.equal((ddl.match(/ADD COLUMN/g) || []).length, 4);
  assert.equal((ddl.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 4);
  assert.doesNotMatch(ddl, /\bDROP\b/);
  assert.doesNotMatch(ddl, /\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/, 'no data backfill runs from schema.sql');
  assert.doesNotMatch(ddl, /ADD CONSTRAINT/);
  assert.ok(!menuProofDdl().includes(String.fromCharCode(0x2014)), 'no em dash in the block');
});

test('menu_proofs: every column exactly as spec 10.6 writes it, the answer pair CHECK, the draft index', () => {
  const ddl = menuProofDdl();
  const { columns, constraints } = parseBody(tableBody(ddl, 'menu_proofs'));
  assert.deepEqual(columns, PROOF_COLUMNS);
  assert.deepEqual(constraints, ['CHECK ((answer IS NULL) = (answered_at IS NULL))']);
  assert.match(ddl, /CREATE INDEX IF NOT EXISTS idx_menu_proofs_draft ON menu_proofs \(draft_id, sent_at DESC\);/);
  // No stored expiry: the link's life is computed live from the event date.
  assert.doesNotMatch(tableBody(ddl, 'menu_proofs'), /expire/i);
});

test('menu_drafts: the four release columns, one idempotent ADD COLUMN each, released_by ON DELETE SET NULL', () => {
  const ddl = menuProofDdl();
  for (const stmt of RELEASE_ADDS) {
    const at = ddl.indexOf(stmt);
    assert.ok(at !== -1, `in the block exactly: ${stmt}`);
    assert.equal(ddl.indexOf(stmt, at + 1), -1, 'once');
  }
  assert.ok(ddl.indexOf(RELEASE_ADDS[0]) > ddl.indexOf('CREATE TABLE IF NOT EXISTS menu_proofs ('));
});

// ── Live: the block applied twice to the dev DB ─────────────────────────────
// Skips when DATABASE_URL is unset. The three tables are net-new, so applying
// the block is safe on the shared dev DB; every probe row below is written
// inside one transaction that is rolled back, so the suite leaves nothing.
// The menu proofs block is applied the same way: one new table and four new
// nullable columns, additive and idempotent.

const HAS_DB = !!process.env.DATABASE_URL;
const dbTest = HAS_DB ? test : test.skip;
let pool;

before(async () => {
  if (!HAS_DB) return;
  ({ pool } = require('./index'));
  const ddl = menuArtDdl();
  await pool.query(ddl);
  await pool.query(ddl);
  const proofs = menuProofDdl();
  await pool.query(proofs);
  await pool.query(proofs);
});

after(async () => { if (pool) await pool.end(); });

// The information_schema data_type each DDL type word reads back as.
const PG_TYPE = new Map([['SERIAL', 'integer'], ['INTEGER', 'integer'], ['UUID', 'uuid'], ['JSONB', 'jsonb'],
  ['TEXT', 'text'], ['TIMESTAMPTZ', 'timestamp with time zone']]);

dbTest('live: each table has exactly its columns, types, nullability and defaults', async () => {
  const live = { ...COLUMNS, menu_drafts: { ...COLUMNS.menu_drafts, ...RELEASE_COLUMNS }, menu_proofs: PROOF_COLUMNS };
  for (const [table, expected] of Object.entries(live)) {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`, [table]);
    const byName = new Map(rows.map((r) => [r.column_name, r]));
    assert.deepEqual([...byName.keys()].sort(), Object.keys(expected).sort(), `${table} column set`);
    for (const [col, def] of Object.entries(expected)) {
      const r = byName.get(col);
      const word = def.split(' ')[0];
      const dflt = (def.match(/DEFAULT (\S+)/) || [])[1];
      assert.equal(r.data_type, PG_TYPE.get(word), `${table}.${col} type`);
      assert.equal(r.is_nullable, /NOT NULL|PRIMARY KEY/.test(def) ? 'NO' : 'YES', `${table}.${col} nullability`);
      if (word === 'SERIAL') assert.match(r.column_default, /^nextval\(/, `${table}.${col} default`);
      else assert.equal(r.column_default, dflt ? dflt.toLowerCase() : null, `${table}.${col} default`);
    }
  }
});

async function constraintDefs(table) {
  const { rows } = await pool.query(
    'SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass', [table]);
  return Object.fromEntries(rows.map((r) => [r.conname, r.def]));
}
const checkValues = (def) => [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]);

dbTest('live: UNIQUE, foreign keys and CHECK value lists, read back from the catalog', async () => {
  const drafts = Object.values(await constraintDefs('menu_drafts'));
  for (const def of [
    'UNIQUE (proposal_id)',
    'FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE',
    'FOREIGN KEY (drink_plan_id) REFERENCES drink_plans(id) ON DELETE SET NULL',
    'FOREIGN KEY (approved_by) REFERENCES users(id)',
  ]) assert.ok(drafts.includes(def), `menu_drafts: ${def}`);
  const shape = (await constraintDefs('menu_drafts')).menu_drafts_json_shape_check;
  assert.ok(shape, 'menu_drafts_json_shape_check exists');
  for (const col of ['inputs', 'content', 'plan_fingerprint']) {
    assert.match(shape, new RegExp(`jsonb_typeof\\(${col}\\) = 'object'`), `${col} must be an object`);
  }

  const pieces = await constraintDefs('menu_draft_pieces');
  assert.ok(Object.values(pieces).includes('UNIQUE (draft_id, piece_key)'));
  assert.ok(Object.values(pieces).includes('FOREIGN KEY (draft_id) REFERENCES menu_drafts(id) ON DELETE CASCADE'));
  assert.deepEqual(checkValues(pieces.menu_draft_pieces_status_check), ['pending', 'working', 'done', 'failed']);
  assert.deepEqual(checkValues(pieces.menu_draft_pieces_tone_check), ['light', 'dark']);
  assert.match(pieces.menu_draft_pieces_tone_check, /tone IS NULL/);
  assert.deepEqual(checkValues(pieces.menu_draft_pieces_provider_check), ['openai', 'gemini']);

  const calls = await constraintDefs('menu_art_calls');
  assert.ok(Object.values(calls).includes('FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE SET NULL'));
  assert.deepEqual(checkValues(calls.menu_art_calls_kind_check), ['image', 'text']);
  assert.deepEqual(checkValues(calls.menu_art_calls_status_check), ['reserved', 'sent', 'ok', 'failed', 'released']);
  assert.deepEqual(checkValues(calls.menu_art_calls_provider_check), ['openai', 'gemini', 'anthropic']);
  const providerChecks = Object.entries(calls).filter(([, def]) => /^CHECK/.test(def) && /\bprovider\b/.test(def));
  assert.deepEqual(providerChecks.map(([name]) => name), ['menu_art_calls_provider_check'], 'one provider CHECK on the ledger');
});

dbTest('live: the two ledger indexes and the two updated_at triggers exist', async () => {
  const { rows: idx } = await pool.query(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_menu_art_calls_created_at'");
  assert.equal(idx.length, 1);
  assert.match(idx[0].indexdef, /ON (public\.)?menu_art_calls USING btree \(created_at\)/);
  const { rows: open } = await pool.query(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_menu_art_calls_open_run'");
  assert.equal(open.length, 1);
  assert.match(open[0].indexdef, /USING btree \(run_id\) WHERE \(status = ANY \(ARRAY\['reserved'::text, 'sent'::text\]\)\)/);
  const { rows: ledgerTrg } = await pool.query(
    `SELECT 1 FROM pg_trigger WHERE tgrelid = 'menu_art_calls'::regclass
      AND tgname = 'update_menu_art_calls_updated_at' AND NOT tgisinternal`);
  assert.equal(ledgerTrg.length, 1);

  const { rows: trg } = await pool.query(
    `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger
      WHERE tgrelid = 'menu_drafts'::regclass AND tgname = 'update_menu_drafts_updated_at' AND NOT tgisinternal`);
  assert.equal(trg.length, 1);
  assert.match(trg[0].def, /BEFORE UPDATE ON (public\.)?menu_drafts FOR EACH ROW WHEN \(.*dismissed_plan_hash.*\) EXECUTE FUNCTION update_updated_at_column\(\)/);
});

dbTest('live: the constraints enforce, the defaults fill and the trigger fires (all rolled back)', async (t) => {
  const client = await pool.connect();
  // Expects the statement to fail with `code`; a SAVEPOINT per probe keeps the
  // transaction usable after each expected failure.
  const refuses = async (sql, params, code, field) => {
    await client.query('SAVEPOINT probe');
    let err = null;
    try { await client.query(sql, params); } catch (e) { err = e; }
    await client.query('ROLLBACK TO SAVEPOINT probe');
    assert.ok(err, `expected ${code}: ${sql}`);
    assert.equal(err.code, code, `${sql}: ${err.message}`);
    if (field) assert.equal(err.constraint || err.column, field, sql);
  };
  try {
    await client.query('BEGIN');
    const { rows: free } = await client.query(
      `SELECT p.id FROM proposals p WHERE NOT EXISTS (SELECT 1 FROM menu_drafts d WHERE d.proposal_id = p.id)
        ORDER BY p.id LIMIT 1`);
    if (!free.length) { t.skip('no proposal without a draft on this database'); return; }
    const proposalId = free[0].id;
    const run = '00000000-0000-4000-8000-000000000001';
    const draftSql = `INSERT INTO menu_drafts (proposal_id, run_id, inputs, content, plan_fingerprint, updated_at)
                      VALUES ($1, $2, '{}', '{}', '{}', '2000-01-01T00:00:00Z') RETURNING id, version, art_version`;
    const { rows: [draft] } = await client.query(draftSql, [proposalId, run]);
    assert.deepEqual([draft.version, draft.art_version], [1, 0], 'version and art_version defaults');
    await refuses(draftSql, [proposalId, run], '23505', 'menu_drafts_proposal_id_key');
    for (const [col, bad] of [['inputs', 'null'], ['content', '[]'], ['plan_fingerprint', '"x"']]) {
      await refuses(`UPDATE menu_drafts SET ${col} = $2::jsonb WHERE id = $1`, [draft.id, bad],
        '23514', 'menu_drafts_json_shape_check');
    }

    const { rows: [touched] } = await client.query(
      'UPDATE menu_drafts SET version = version + 1 WHERE id = $1 RETURNING updated_at', [draft.id]);
    assert.ok(touched.updated_at > new Date('2000-01-02T00:00:00Z'), 'the trigger restamped updated_at');

    const pieceSql = `INSERT INTO menu_draft_pieces (draft_id, piece_key, run_id, status, tone, provider, model)
                      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING drawn_count, heartbeat_at`;
    const { rows: [piece] } = await client.query(
      pieceSql, [draft.id, 'background', run, 'pending', 'dark', 'openai', 'test-model']);
    assert.equal(piece.drawn_count, 0);
    assert.ok(piece.heartbeat_at instanceof Date);
    await client.query(pieceSql, [draft.id, 'custom:x', run, 'done', null, 'gemini', 'test-model']);
    await refuses(pieceSql, [draft.id, 'background', run, 'pending', null, 'openai', 'm'], '23505',
      'menu_draft_pieces_draft_id_piece_key_key');
    await refuses(pieceSql, [draft.id, 'p1', run, 'queued', null, 'openai', 'm'], '23514', 'menu_draft_pieces_status_check');
    await refuses(pieceSql, [draft.id, 'p2', run, 'pending', 'grey', 'openai', 'm'], '23514', 'menu_draft_pieces_tone_check');
    await refuses(pieceSql, [draft.id, 'p3', run, 'pending', null, 'midjourney', 'm'], '23514', 'menu_draft_pieces_provider_check');
    await refuses(pieceSql, [draft.id, 'p6', run, 'pending', null, 'anthropic', 'm'], '23514', 'menu_draft_pieces_provider_check');
    await refuses(pieceSql, [draft.id, 'p4', run, 'pending', null, null, 'm'], '23502', 'provider');
    await refuses(pieceSql, [draft.id, 'p5', run, 'pending', null, 'openai', null], '23502', 'model');

    await client.query('DELETE FROM menu_drafts WHERE id = $1', [draft.id]);
    const { rows: [left] } = await client.query(
      'SELECT COUNT(*)::int AS n FROM menu_draft_pieces WHERE draft_id = $1', [draft.id]);
    assert.equal(left.n, 0, 'pieces cascade with their draft');

    const callSql = `INSERT INTO menu_art_calls (kind, status, provider) VALUES ($1, $2, $3)
                     RETURNING id, created_at, updated_at`;
    const { rows: [call] } = await client.query(callSql, ['image', 'reserved', 'gemini']);
    assert.ok(call.created_at instanceof Date);
    assert.equal(call.updated_at, null);
    const { rows: [moved] } = await client.query(
      "UPDATE menu_art_calls SET status = 'sent' WHERE id = $1 RETURNING updated_at", [call.id]);
    assert.ok(moved.updated_at instanceof Date, 'the ledger trigger stamps updated_at on a status change');
    await refuses(callSql, ['video', 'reserved', 'openai'], '23514', 'menu_art_calls_kind_check');
    await refuses(callSql, ['text', 'pending', 'openai'], '23514', 'menu_art_calls_status_check');
    const { rows: [claude] } = await client.query(callSql, ['text', 'reserved', 'anthropic']);
    assert.ok(claude.id, 'the ledger takes a text row on anthropic');
    await refuses(callSql, ['text', 'reserved', 'midjourney'], '23514', 'menu_art_calls_provider_check');
    // Leaving provider out must fail: there is no default to fall back on.
    await refuses('INSERT INTO menu_art_calls (kind, status) VALUES ($1, $2)', ['image', 'reserved'], '23502', 'provider');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

// The path dev and production take: the narrow CHECK an older boot left, then
// the widening, twice, inside one transaction that is rolled back.
dbTest('live: a ledger holding the narrow provider CHECK is widened once, in place, and a replay changes nothing', async () => {
  const client = await pool.connect();
  const providerDefs = async () => (await client.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'menu_art_calls'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%provider%'`)).rows;
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE menu_art_calls DROP CONSTRAINT IF EXISTS menu_art_calls_provider_check');
    await client.query("ALTER TABLE menu_art_calls ADD CONSTRAINT menu_art_calls_provider_check CHECK (provider IN ('openai','gemini'))");
    assert.deepEqual(checkValues((await providerDefs())[0].def), ['openai', 'gemini'], 'the old shape');
    await client.query(PROVIDER_WIDEN);
    const once = await providerDefs();
    assert.deepEqual(once.map((r) => [r.conname, checkValues(r.def)]),
      [['menu_art_calls_provider_check', ['openai', 'gemini', 'anthropic']]]);
    await client.query(PROVIDER_WIDEN);
    assert.deepEqual(await providerDefs(), once, 'a replay leaves it as it is');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

dbTest('live: the menu_drafts updated_at trigger carries the WHEN clause after the block is applied', async () => {
  const { rows } = await pool.query(
    "SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'update_menu_drafts_updated_at' AND tgrelid = 'menu_drafts'::regclass");
  assert.equal(rows.length, 1);
  assert.match(rows[0].def, /WHEN .*to_jsonb\(old\.\*\).*dismissed_plan_hash.*IS DISTINCT FROM.*to_jsonb\(new\.\*\)/s);
});

// The column applied twice (the boot replay is idempotent), then read back from
// the catalog; the CHECK is probed inside a transaction that is rolled back.
dbTest('live: proposals.menu_not_required_by is a nullable TEXT whose CHECK takes admin, planner or null', async () => {
  await pool.query(NOT_REQUIRED_BY);
  await pool.query(NOT_REQUIRED_BY);
  const { rows: cols } = await pool.query(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'proposals' AND column_name = 'menu_not_required_by'`);
  assert.equal(cols.length, 1);
  assert.deepEqual(cols[0], { data_type: 'text', is_nullable: 'YES', column_default: null });
  const def = (await constraintDefs('proposals')).proposals_menu_not_required_by_check;
  assert.ok(def, 'proposals_menu_not_required_by_check exists');
  assert.deepEqual(checkValues(def), ['admin', 'planner']);
  assert.match(def, /menu_not_required_by IS NULL/);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Its own client and proposal, inside the rolled-back transaction: no real row is touched.
    const { rows: [c] } = await client.query(
      "INSERT INTO clients (name, email, phone) VALUES ('Schema Probe', 'schema-probe@example.com', '+15555550199') RETURNING id");
    const { rows: [p] } = await client.query(
      `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type)
       VALUES ($1, CURRENT_DATE + 10, '18:00', 4, 'America/Chicago', 'confirmed', 'corporate') RETURNING id`, [c.id]);
    const id = p.id;
    for (const ok of ['admin', 'planner', null]) {
      await client.query('UPDATE proposals SET menu_not_required_by = $2 WHERE id = $1', [id, ok]);
    }
    await client.query('SAVEPOINT probe');
    let err = null;
    try { await client.query("UPDATE proposals SET menu_not_required_by = 'client' WHERE id = $1", [id]); } catch (e) { err = e; }
    assert.ok(err, "'client' is refused");
    assert.equal(err.code, '23514');
    assert.equal(err.constraint, 'proposals_menu_not_required_by_check');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

// The menu proofs block, read back from the catalog after it is applied twice.
dbTest('live: menu_proofs keys, foreign keys and CHECKs, and the release columns, read back from the catalog', async () => {
  const proofs = await constraintDefs('menu_proofs');
  const defs = Object.values(proofs);
  for (const def of [
    'PRIMARY KEY (id)',
    'UNIQUE (token)',
    'FOREIGN KEY (draft_id) REFERENCES menu_drafts(id) ON DELETE CASCADE',
    'FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE',
    'FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL',
  ]) assert.ok(defs.includes(def), `menu_proofs: ${def}`);
  assert.deepEqual(checkValues(proofs.menu_proofs_email_status_check),
    ['pending', 'sent', 'failed', 'no_address', 'skipped', 'suppressed']);
  assert.deepEqual(checkValues(proofs.menu_proofs_answer_check), ['approved', 'changes']);
  assert.match(proofs.menu_proofs_answer_check, /answer IS NULL/);
  assert.match(proofs.menu_proofs_check, /\(answer IS NULL\) = \(answered_at IS NULL\)/);

  const { rows: idx } = await pool.query(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_menu_proofs_draft'");
  assert.equal(idx.length, 1);
  assert.match(idx[0].indexdef, /ON (public\.)?menu_proofs USING btree \(draft_id, sent_at DESC\)/);

  const drafts = await constraintDefs('menu_drafts');
  const releasedBy = Object.values(drafts).filter((d) => /FOREIGN KEY \(released_by\)/.test(d));
  assert.deepEqual(releasedBy, ['FOREIGN KEY (released_by) REFERENCES users(id) ON DELETE SET NULL'], 'one released_by FK, SET NULL');
  assert.deepEqual(checkValues(drafts.menu_drafts_released_via_check), ['client', 'admin']);
  assert.match(drafts.menu_drafts_released_via_check, /released_via IS NULL/);
});

dbTest('live: menu_proofs defaults fill and its CHECKs, the unique token and the cascades enforce (all rolled back)', async () => {
  const client = await pool.connect();
  const refuses = async (sql, params, code, field) => {
    await client.query('SAVEPOINT probe');
    let err = null;
    try { await client.query(sql, params); } catch (e) { err = e; }
    await client.query('ROLLBACK TO SAVEPOINT probe');
    assert.ok(err, `expected ${code}: ${sql}`);
    assert.equal(err.code, code, `${sql}: ${err.message}`);
    if (field) assert.equal(err.constraint || err.column, field, sql);
  };
  try {
    await client.query('BEGIN');
    // Its own client, proposal, user and draft, inside the rolled-back transaction: no real row is touched.
    const { rows: [c] } = await client.query(
      "INSERT INTO clients (name, email, phone) VALUES ('Schema Probe', 'schema-probe@example.com', '+15555550199') RETURNING id");
    const { rows: [p] } = await client.query(
      `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type)
       VALUES ($1, CURRENT_DATE + 10, '18:00', 4, 'America/Chicago', 'confirmed', 'corporate') RETURNING id`, [c.id]);
    const { rows: [u] } = await client.query(
      "INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ('schema-probe-admin@example.com', 'x', 'admin', 'approved') RETURNING id");
    const { rows: [d] } = await client.query(
      `INSERT INTO menu_drafts (proposal_id, run_id, inputs, content, plan_fingerprint)
       VALUES ($1, '00000000-0000-4000-8000-000000000002', '{}', '{}', '{}') RETURNING id, released_print_key, released_at, released_by, released_via`, [p.id]);
    assert.deepEqual([d.released_print_key, d.released_at, d.released_by, d.released_via], [null, null, null, null]);

    const proofSql = `INSERT INTO menu_proofs (draft_id, proposal_id, version, art_version, r2_key, sent_by, email_status)
                      VALUES ($1, $2, 3, 1, $3, $4, $5) RETURNING id, token, sent_at, answer, answered_at, withdrawn_at, superseded_at`;
    const { rows: [proof] } = await client.query(proofSql, [d.id, p.id, `menu-proof/${p.id}/a.jpg`, u.id, 'pending']);
    assert.match(proof.token, /^[0-9a-f-]{36}$/, 'the token fills from gen_random_uuid()');
    assert.ok(proof.sent_at instanceof Date, 'sent_at fills');
    assert.deepEqual([proof.answer, proof.answered_at, proof.withdrawn_at, proof.superseded_at], [null, null, null, null]);
    for (const ok of ['sent', 'failed', 'no_address', 'skipped', 'suppressed']) {
      await client.query(proofSql, [d.id, p.id, `menu-proof/${p.id}/${ok}.jpg`, null, ok]);
    }
    await refuses(proofSql, [d.id, p.id, 'k', null, 'bounced'], '23514', 'menu_proofs_email_status_check');
    await refuses(proofSql, [d.id, p.id, 'k', null, null], '23502', 'email_status');
    await refuses(`INSERT INTO menu_proofs (draft_id, proposal_id, token, version, art_version, r2_key, email_status)
                   VALUES ($1, $2, $3, 1, 1, 'k', 'sent')`, [d.id, p.id, proof.token], '23505', 'menu_proofs_token_key');
    await refuses("UPDATE menu_proofs SET answer = 'maybe', answered_at = NOW() WHERE id = $1", [proof.id], '23514', 'menu_proofs_answer_check');
    await refuses("UPDATE menu_proofs SET answer = 'approved' WHERE id = $1", [proof.id], '23514', 'menu_proofs_check');
    await refuses('UPDATE menu_proofs SET answered_at = NOW() WHERE id = $1', [proof.id], '23514', 'menu_proofs_check');
    await client.query("UPDATE menu_proofs SET answer = 'changes', answer_note = 'x', answered_at = NOW() WHERE id = $1", [proof.id]);

    for (const ok of ['client', 'admin', null]) {
      await client.query('UPDATE menu_drafts SET released_via = $2 WHERE id = $1', [d.id, ok]);
    }
    await refuses("UPDATE menu_drafts SET released_via = 'system' WHERE id = $1", [d.id], '23514', 'menu_drafts_released_via_check');
    await client.query('UPDATE menu_drafts SET released_by = $2 WHERE id = $1', [d.id, u.id]);
    await client.query('DELETE FROM users WHERE id = $1', [u.id]);
    const { rows: [after] } = await client.query(
      'SELECT d.released_by, (SELECT sent_by FROM menu_proofs WHERE id = $2) AS sent_by FROM menu_drafts d WHERE d.id = $1', [d.id, proof.id]);
    assert.deepEqual([after.released_by, after.sent_by], [null, null], 'deleting the user nulls released_by and sent_by');

    await client.query('DELETE FROM menu_drafts WHERE id = $1', [d.id]);
    const { rows: [left] } = await client.query('SELECT COUNT(*)::int AS n FROM menu_proofs WHERE proposal_id = $1', [p.id]);
    assert.equal(left.n, 0, 'proofs cascade with their draft');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});
