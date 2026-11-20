// The admin search's SQL, pinned byte for byte (lane connector-shared-reads,
// plan 2026-11-19). runGlobalSearch gained an opt-in hold exclusion; the admin
// search (GET /api/admin/search, the command palette) passes none and must
// send the four queries it always sent, text and parameters alike. The hashes
// were taken from the code BEFORE the exclusion was added. Pure: the pool's
// query is stubbed, nothing reaches a database.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../db');

const calls = [];
db.pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; };
const { runGlobalSearch } = require('./globalSearch');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('no exclusion: the four texts and parameters the admin search always sent', async () => {
  calls.length = 0;
  await runGlobalSearch('Gandalf 555-0142');
  assert.deepEqual(calls.map((c) => sha(c.sql)), [
    '6a95e20f8acb6c406edb4ba611cb7172955856b98498c1f73c4528a35bc060b7', // clients
    '1b865a0f66f9e988f84433b116d131f37805366ec50d7fbf733a4326e4f52c58', // proposals
    'ae64cc7d5677e5411ddc46f653855f2ea10959eb60caaecc6130223616a612f4', // events
    'c95bb2b4d63ff8fc3cd4e570245566ee312ebc52fae7f6d01d9f5aaeab08f85b', // staff
  ]);
  for (const c of calls) assert.deepEqual(c.params, ['%gandalf 555-0142%', '%5550142%', 6]);
});

test('with an exclusion the three record groups bind it and the staff group is unchanged', async () => {
  calls.length = 0;
  await runGlobalSearch('gandalf', { exclude: { proposalIds: [11, 12], clientIds: [21] } });
  assert.deepEqual(calls.map((c) => c.params.slice(3)), [[[21]], [[11, 12], [21]], [[11, 12], [21]], []]);
  assert.equal(sha(calls[3].sql), 'c95bb2b4d63ff8fc3cd4e570245566ee312ebc52fae7f6d01d9f5aaeab08f85b');
  for (const c of calls.slice(0, 3)) assert.match(c.sql, /= ANY\(\$4::int\[\]\)[\s\S]*LIMIT \$3/, 'the exclusion is before the LIMIT');
});
