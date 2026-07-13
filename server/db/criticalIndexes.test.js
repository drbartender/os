require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, findMissingCriticalIndexes } = require('./index');

if (process.env.NODE_ENV === 'production') {
  throw new Error('criticalIndexes.test.js refuses to run against production');
}

// F7 review follow-up: initDb swallows 23505 (IDEMPOTENT_PG_CODES), so a
// money-integrity UNIQUE index that fails to build on pre-existing duplicate data
// would leave the guard silently absent. findMissingCriticalIndexes is the boot-time
// assertion that surfaces that case; initDb routes any miss into its Sentry alert.

after(async () => { await pool.end(); });

test('present on the real dev DB → returns [] (the F7 index is applied)', async () => {
  // A non-empty result here is itself a real signal: the money guard is missing.
  const missing = await findMissingCriticalIndexes(pool);
  assert.deepEqual(missing, [], `expected no missing critical indexes, got ${JSON.stringify(missing)}`);
});

test('DB has none of them → reports the index as missing', async () => {
  const emptyDb = { query: async () => ({ rows: [] }) };
  const missing = await findMissingCriticalIndexes(emptyDb);
  assert.deepEqual(missing, ['uq_invoice_payments_positive_link']);
});

test('DB reports the index present → returns []', async () => {
  const okDb = { query: async () => ({ rows: [{ indexname: 'uq_invoice_payments_positive_link' }] }) };
  const missing = await findMissingCriticalIndexes(okDb);
  assert.deepEqual(missing, []);
});

test('scopes the lookup to the public schema (removes the multi-schema false-negative)', async () => {
  let capturedSql = '';
  const spyDb = {
    query: async (sql) => { capturedSql = sql; return { rows: [{ indexname: 'uq_invoice_payments_positive_link' }] }; },
  };
  await findMissingCriticalIndexes(spyDb);
  assert.match(capturedSql, /schemaname\s*=\s*'public'/, 'lookup must be scoped to the public schema');
});

test('propagates a catalog query error (initDb wraps it into a non-fatal alert, not a boot crash)', async () => {
  const throwingDb = { query: async () => { throw new Error('ECONNREFUSED'); } };
  await assert.rejects(() => findMissingCriticalIndexes(throwingDb), /ECONNREFUSED/);
});
