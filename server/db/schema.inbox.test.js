require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

if (process.env.NODE_ENV === 'production') {
  throw new Error('schema.inbox.test.js refuses to run against production');
}

const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const START = '-- ─── Inbox (spec docs/superpowers/specs/2026-10-06-inbox-design.md, section 7) ───';
const END = '-- ─── end Inbox ───';
// Fixed, so before() also clears whatever a crashed earlier run left behind.
const TAG = 'schema-inbox-test';

function inboxDdl() {
  const a = schemaSql.indexOf(START);
  const b = schemaSql.indexOf(END);
  assert.ok(a !== -1 && b > a, 'the Inbox block sits between its two markers in schema.sql');
  return schemaSql.slice(a, b);
}

// ── Pure: the DDL text ──────────────────────────────────────────────────────

test('inbox_actions: six actions, until_at only on a snooze, the person index', () => {
  const ddl = inboxDdl();
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS inbox_actions \(/);
  assert.match(ddl, /action TEXT NOT NULL CHECK \(action IN \('claim','release','done','snooze','wake','reopen'\)\)/);
  assert.match(ddl, /CHECK \(\(action = 'snooze'\) = \(until_at IS NOT NULL\)\)/);
  assert.match(ddl, /user_id INTEGER REFERENCES users\(id\) ON DELETE SET NULL/);
  assert.match(ddl, /undone_at TIMESTAMPTZ/);
  assert.match(ddl, /CREATE INDEX IF NOT EXISTS idx_inbox_actions_person ON inbox_actions\(person_key, created_at DESC\)/);
});

test('inbox_seen is one row per person; inbox_reads is unique per (kind, subject_ref)', () => {
  const ddl = inboxDdl();
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS inbox_seen \(\s*person_key TEXT PRIMARY KEY,/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS inbox_reads \(/);
  assert.match(ddl, /status TEXT NOT NULL CHECK \(status IN \('pending','ok','error','refused'\)\)/);
  assert.match(ddl, /attempts INTEGER NOT NULL DEFAULT 1/);
  assert.match(ddl, /UNIQUE \(kind, subject_ref\)/);
});

test('each enumerated CHECK is also a DO-block DROP + ADD with the identical list', () => {
  const ddl = inboxDdl();
  for (const [table, name, list] of [
    ['inbox_actions', 'inbox_actions_action_check', "action IN ('claim','release','done','snooze','wake','reopen')"],
    ['inbox_reads', 'inbox_reads_kind_check', "kind IN ('inbound','outbound')"],
    ['inbox_reads', 'inbox_reads_status_check', "status IN ('pending','ok','error','refused')"],
  ]) {
    assert.ok(ddl.includes(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name};`), `${name} drop`);
    assert.ok(ddl.includes(`ALTER TABLE ${table} ADD CONSTRAINT ${name}\n    CHECK (${list});`), `${name} add`);
  }
});

test('inbox_sends reserves one send per send_id, before the text goes out', () => {
  const ddl = inboxDdl();
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS inbox_sends \(\s*send_id UUID PRIMARY KEY,\s*person_key TEXT NOT NULL,\s*user_id INTEGER REFERENCES users\(id\) ON DELETE SET NULL,\s*created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\),\s*result JSONB\s*\);/);
  assert.ok(!/idx_sms_messages_send_id/.test(ddl.replace(/--[^\n]*/g, '')), 'the unique-index design is replaced, not doubled');
});

// ── Live: the block applied twice to the dev DB ─────────────────────────────

let pool;

async function clean() {
  await pool.query('DELETE FROM inbox_actions WHERE person_key LIKE $1', [`${TAG}%`]);
  await pool.query('DELETE FROM inbox_reads WHERE subject_ref LIKE $1', [`${TAG}%`]);
  await pool.query('DELETE FROM inbox_sends WHERE person_key LIKE $1', [`${TAG}%`]);
}

before(async () => {
  ({ pool } = require('./index'));
  const ddl = inboxDdl();
  await pool.query(ddl);
  await pool.query(ddl);
  await clean();
});

after(async () => {
  if (!pool) return;
  await clean();
  await pool.end();
});

test('live: a snooze needs until_at, nothing else may carry it, and unknown actions are refused', async () => {
  const key = `${TAG}-c-1`;
  const refused = (e) => e.code === '23514';
  await assert.rejects(pool.query("INSERT INTO inbox_actions (person_key, action) VALUES ($1, 'snooze')", [key]), refused);
  await assert.rejects(pool.query("INSERT INTO inbox_actions (person_key, action, until_at) VALUES ($1, 'claim', NOW())", [key]), refused);
  await assert.rejects(pool.query("INSERT INTO inbox_actions (person_key, action) VALUES ($1, 'archive')", [key]), refused);
  const ok = await pool.query(
    "INSERT INTO inbox_actions (person_key, action, until_at) VALUES ($1, 'snooze', NOW() + INTERVAL '1 hour') RETURNING id",
    [key]
  );
  assert.ok(ok.rows[0].id > 0);
});

test('live: one read per (kind, subject_ref), and only the four statuses', async () => {
  const ref = `${TAG}-sms:1`;
  await pool.query("INSERT INTO inbox_reads (kind, subject_ref, person_key, status) VALUES ('inbound', $1, 'c-1', 'pending')", [ref]);
  await assert.rejects(
    pool.query("INSERT INTO inbox_reads (kind, subject_ref, person_key, status) VALUES ('inbound', $1, 'c-1', 'ok')", [ref]),
    (e) => e.code === '23505'
  );
  await assert.rejects(
    pool.query("INSERT INTO inbox_reads (kind, subject_ref, person_key, status) VALUES ('outbound', $1, 'c-1', 'done')", [ref]),
    (e) => e.code === '23514'
  );
});

test('live: the first reservation of a send_id wins; a second is a no-op the route can read back', async () => {
  const sendId = require('node:crypto').randomUUID();
  const reserve = () => pool.query(
    'INSERT INTO inbox_sends (send_id, person_key) VALUES ($1, $2) ON CONFLICT (send_id) DO NOTHING RETURNING send_id',
    [sendId, `${TAG}-c-1`]
  );
  assert.equal((await reserve()).rowCount, 1);
  assert.equal((await reserve()).rowCount, 0);
  await pool.query('UPDATE inbox_sends SET result = $2::jsonb WHERE send_id = $1', [sendId, JSON.stringify({ status: 201 })]);
  const { rows } = await pool.query('SELECT result FROM inbox_sends WHERE send_id = $1', [sendId]);
  assert.deepEqual(rows[0].result, { status: 201 });
  await assert.rejects(
    pool.query('INSERT INTO inbox_sends (send_id, person_key) VALUES ($1, $2)', ['not-a-uuid', `${TAG}-c-1`]),
    (e) => e.code === '22P02'
  );
});
