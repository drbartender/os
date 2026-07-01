require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');

// ── (a) Pure, DB-free assertions on schema.sql content ──────────────────────
// These are the TDD gate: they pass the moment the DDL block is present and are
// deterministic (no DB, no network), so they run in every environment.
test('schema.sql declares pending_call idempotently with the locked columns', () => {
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS pending_call \(/);
  assert.match(schemaSql, /user_id\s+BIGINT NOT NULL UNIQUE/);
  assert.match(schemaSql, /target_e164\s+TEXT NOT NULL/);
  assert.match(
    schemaSql,
    /status\s+TEXT NOT NULL DEFAULT 'awaiting_confirm'\s+CHECK \(status IN \('awaiting_confirm','dialing'\)\)/
  );
  assert.match(schemaSql, /CREATE INDEX IF NOT EXISTS idx_pending_call_call_sid[\s\S]*?ON pending_call\s*\(call_sid\)/);
});

test('schema.sql declares call_audit idempotently with a created_at index', () => {
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS call_audit \(/);
  assert.match(schemaSql, /triggered_by\s+BIGINT/);
  assert.match(schemaSql, /status\s+TEXT NOT NULL/);
  assert.match(schemaSql, /CREATE INDEX IF NOT EXISTS idx_call_audit_created_at[\s\S]*?ON call_audit\s*\(created_at\)/);
});

test('schema.sql declares telegram_update with update_id as PK', () => {
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS telegram_update \(/);
  assert.match(schemaSql, /update_id\s+BIGINT PRIMARY KEY/);
});

// ── (b) DB-integration: apply the idempotent DDL and verify via catalog ──────
// Skips when DATABASE_URL is unset (pure tests above still cover content).
// Applying CREATE TABLE/INDEX IF NOT EXISTS is safe against the shared dev DB:
// the tables are net-new, so there is no FK/teardown collision with other suites.
const HAS_DB = !!process.env.DATABASE_URL;
const dbTest = HAS_DB ? test : test.skip;

let pool;
// Extract just the VA-calling block (from its banner comment to EOF) so the test
// applies exactly the DDL this task added, not the whole 3k-line schema.
function vaCallingDdl() {
  const marker = '-- Zul VA Calling';
  const idx = schemaSql.indexOf(marker);
  assert.ok(idx !== -1, 'VA-calling DDL block must be present in schema.sql');
  return schemaSql.slice(idx);
}

before(async () => {
  if (!HAS_DB) return;
  ({ pool } = require('../db'));
  const ddl = vaCallingDdl();
  // Apply twice to prove idempotency (IF NOT EXISTS must not error on re-run).
  await pool.query(ddl);
  await pool.query(ddl);
});

after(async () => {
  if (!HAS_DB || !pool) return;
  await pool.end();
});

dbTest('all three tables exist in the public schema', async () => {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('pending_call','call_audit','telegram_update')
      ORDER BY table_name`
  );
  assert.deepEqual(
    rows.map((r) => r.table_name),
    ['call_audit', 'pending_call', 'telegram_update']
  );
});

dbTest('pending_call has the locked columns/types and unique user_id', async () => {
  const { rows } = await pool.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pending_call'
      ORDER BY column_name`
  );
  const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
  assert.equal(byName.user_id.data_type, 'bigint');
  assert.equal(byName.user_id.is_nullable, 'NO');
  assert.equal(byName.target_e164.data_type, 'text');
  assert.equal(byName.target_e164.is_nullable, 'NO');
  assert.equal(byName.status.is_nullable, 'NO');
  assert.equal(byName.expires_at.data_type, 'timestamp with time zone');
  assert.equal(byName.expires_at.is_nullable, 'NO');

  // user_id UNIQUE (upsert conflict target).
  const { rows: uq } = await pool.query(
    `SELECT 1 FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'pending_call'
        AND tc.constraint_type = 'UNIQUE'
        AND kcu.column_name = 'user_id'`
  );
  assert.equal(uq.length, 1, 'pending_call.user_id must be UNIQUE');
});

dbTest('the status CHECK rejects an out-of-domain value', async () => {
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO pending_call (user_id, target_e164, status, expires_at)
         VALUES (-999001, '+13125550000', 'bogus', NOW() + INTERVAL '2 minutes')`
      ),
    /violates check constraint/i
  );
});

dbTest('expected indexes exist (call_sid, created_at)', async () => {
  const { rows } = await pool.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('idx_pending_call_call_sid','idx_call_audit_created_at')
      ORDER BY indexname`
  );
  assert.deepEqual(
    rows.map((r) => r.indexname),
    ['idx_call_audit_created_at', 'idx_pending_call_call_sid']
  );
});

dbTest('telegram_update update_id is the primary key', async () => {
  const { rows } = await pool.query(
    `SELECT tc.constraint_type, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'telegram_update'
        AND tc.constraint_type = 'PRIMARY KEY'`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].column_name, 'update_id');
});
