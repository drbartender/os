require('dotenv').config();

// The Claude connector's five tables read back from the database schema.sql
// was applied to (spec 2026-11-19; plan lane connector-signin-server,
// acceptance): the tables, the columns the code and the tools lane rely on,
// the constraints that make the sign-in atomic and the log honest, and the
// indexes (the one-unrevoked-grant backstop, the tripwire's (grant, time)
// index, the withheld-once index). Read only: it writes nothing.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('./index');
const { OUTCOMES } = require('../utils/connector/callLog');

if (process.env.NODE_ENV === 'production') {
  throw new Error('schema.connector.test.js refuses to run against production');
}

after(async () => { await pool.end(); });

const TABLES = {
  connector_auth_requests: ['id', 'client_id', 'redirect_uri', 'code_challenge', 'state', 'resource', 'caller_address',
    'user_agent', 'requested_at', 'expires_at', 'used_at', 'outcome', 'grant_id'],
  connector_grants: ['id', 'user_id', 'token_version', 'client_id', 'request_id', 'created_at', 'expires_at',
    'last_used_at', 'revoked_at', 'revoked_reason', 'activated_at'],
  connector_codes: ['id', 'code_hash', 'grant_id', 'client_id', 'redirect_uri', 'code_challenge', 'resource',
    'created_at', 'expires_at', 'used_at'],
  connector_tokens: ['id', 'token_hash', 'kind', 'grant_id', 'created_at', 'expires_at', 'rotated_at', 'revoked_at'],
  connector_calls: ['id', 'grant_id', 'called_at', 'caller_address', 'method', 'tool_name', 'record_ids', 'client_id',
    'result_count', 'duration_ms', 'outcome', 'withheld_ref'],
};

test('the five tables exist with their columns', async () => {
  for (const [table, columns] of Object.entries(TABLES)) {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [table]
    );
    const have = new Set(r.rows.map((x) => x.column_name));
    const missing = columns.filter((c) => !have.has(c));
    assert.deepEqual(missing, [], `${table} is missing ${missing.join(', ')}`);
  }
  const nullable = await pool.query(
    `SELECT table_name, column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND (table_name, column_name) IN
        (('connector_calls', 'grant_id'), ('connector_calls', 'client_id'), ('connector_grants', 'revoked_at'),
         ('connector_grants', 'activated_at'), ('connector_auth_requests', 'state'))`
  );
  assert.equal(nullable.rows.length, 5);
  for (const row of nullable.rows) assert.equal(row.is_nullable, 'YES', `${row.table_name}.${row.column_name} is nullable`);
});

test('the indexes the sign-in, the tripwire and the withheld-once rule rely on', async () => {
  const r = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'connector_%'`
  );
  const byName = Object.fromEntries(r.rows.map((x) => [x.indexname, x.indexdef]));
  assert.match(byName.uq_connector_grants_one_live || '', /UNIQUE.*WHERE \(\(revoked_at IS NULL\) AND \(activated_at IS NOT NULL\)\)/);
  assert.equal(byName.uq_connector_grants_one_unrevoked, undefined, 'the earlier index is gone');
  assert.match(byName.idx_connector_calls_grant_time || '', /\(grant_id, called_at\)/);
  assert.match(byName.uq_connector_calls_withheld_ref || '', /UNIQUE.*\(withheld_ref\) WHERE .*withheld/);
  for (const name of ['connector_codes_code_hash_key', 'connector_tokens_token_hash_key']) {
    assert.match(byName[name] || '', /UNIQUE/, name);
  }
});

test('the constraints: outcomes, kinds, revoke reasons, and a refusal is the only row with no grant', async () => {
  const r = await pool.query(
    `SELECT c.conrelid::regclass::text AS tbl, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c WHERE c.contype = 'c' AND c.conrelid::regclass::text LIKE 'connector_%'`
  );
  const defs = (tbl) => r.rows.filter((x) => x.tbl === tbl).map((x) => x.def).join('\n');
  for (const v of OUTCOMES) {
    assert.ok(defs('connector_calls').includes(`'${v}'`), `connector_calls outcome ${v}`);
  }
  assert.match(defs('connector_calls'), /grant_id IS NOT NULL/);
  for (const v of ['replaced', 'disconnected', 'code_replay', 'refresh_replay', 'unredeemed']) {
    assert.ok(defs('connector_grants').includes(`'${v}'`), `revoked_reason ${v}`);
  }
  assert.ok(defs('connector_tokens').includes("'access'") && defs('connector_tokens').includes("'refresh'"));
  assert.ok(defs('connector_auth_requests').includes("'approved'") && defs('connector_auth_requests').includes("'cancelled'"));
});
