require('dotenv').config();
process.env.NODE_ENV = 'test';

// The connector's call log (spec 2026-11-19 section 7.4): a failed insert
// never fails the call it records (Sentry gets the outcome, not the row); a
// withheld piece is written once however often it is read, and only that
// first call is told to email; the tripwire's count of different clients per
// grant per window; the refusal rows carry no grant.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../../db');
const grants = require('./grants');
const callLog = require('./callLog');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let admin; let grantId;
const callIds = [];

before(async () => {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id`,
    [`connector-calllog-${NONCE}@example.com`]
  );
  admin = r.rows[0];
  await pool.query("UPDATE connector_grants SET revoked_at = NOW(), revoked_reason = 'replaced' WHERE revoked_at IS NULL");
  const g = await pool.query(
    `INSERT INTO connector_grants (user_id, token_version, client_id, expires_at)
     VALUES ($1, 0, $2, NOW() + INTERVAL '180 days') RETURNING id`,
    [admin.id, grants.CLIENT_ID]
  );
  grantId = g.rows[0].id;
});

after(async () => {
  if (callIds.length) await pool.query('DELETE FROM connector_calls WHERE id = ANY($1::bigint[])', [callIds]);
  await pool.query('DELETE FROM connector_calls WHERE grant_id = $1', [grantId]);
  await pool.query('DELETE FROM connector_grants WHERE id = $1', [grantId]);
  await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
  callLog.__setCapture((err, ctx) => { void err; void ctx; });
  await pool.end();
});

test('a failed insert resolves null and reports to Sentry without the row', async () => {
  const captured = [];
  callLog.__setCapture((err, ctx) => { captured.push({ err, ctx }); });
  const broken = { query: async () => { throw new Error('connection reset'); } };
  const out = await callLog.recordCall({ grantId, toolName: 'client', recordIds: ['c-1'], outcome: 'ok' }, broken);
  assert.equal(out, null);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].ctx.tags.outcome, 'ok');
  assert.equal(JSON.stringify(captured[0].ctx).includes('c-1'), false, 'no record ids in the report');
  // An outcome the table does not take is refused the same quiet way.
  assert.equal(await callLog.recordCall({ grantId, outcome: 'bogus' }), null);
  assert.equal(captured.length, 2);
});

test('a refusal carries no grant and the caller\'s address; a served call needs its grant', async () => {
  const id = await callLog.recordCall({ callerAddress: '198.51.100.4', outcome: 'refused_token' });
  callIds.push(id);
  const row = (await pool.query('SELECT grant_id, caller_address, outcome FROM connector_calls WHERE id = $1', [id])).rows[0];
  assert.deepEqual(row, { grant_id: null, caller_address: '198.51.100.4', outcome: 'refused_token' });
  callLog.__setCapture(() => {});
  assert.equal(await callLog.recordCall({ outcome: 'ok' }), null, 'the table refuses an ok row with no grant');
});

test('a refusal is written once per window per IPv6 /64, not once per address in it', async () => {
  callLog.__resetRefusalWindow();
  const first = await callLog.recordRefusal({ callerAddress: '2001:db8:7:7::1', outcome: 'refused_address' });
  assert.ok(first, 'the first refusal in the /64 is written');
  callIds.push(first);
  assert.equal(await callLog.recordRefusal({ callerAddress: '2001:db8:7:7::2', outcome: 'refused_address' }), null,
    'another address in the same /64 is dropped');
  const other = await callLog.recordRefusal({ callerAddress: '2001:db8:7:8::1', outcome: 'refused_address' });
  assert.ok(other, 'another /64 is written');
  callIds.push(other);
  const row = (await pool.query('SELECT caller_address FROM connector_calls WHERE id = $1', [first])).rows[0];
  assert.equal(row.caller_address, '2001:db8:7:7::1', 'the logged address stays whole');
  callLog.__resetRefusalWindow();
});

test('a withheld piece is written once, and only the first call is told to email', async () => {
  const ref = `thread-msg-${NONCE}`;
  const firsts = await Promise.all([1, 2, 3].map(() => callLog.recordWithheldOnce({
    grantId, toolName: 'thread', withheldRef: ref, recordIds: ['p-key'], clientId: 77001,
  })));
  assert.deepEqual(firsts.filter(Boolean).length, 1);
  assert.equal(await callLog.recordWithheldOnce({ grantId, toolName: 'thread', withheldRef: ref }), false);
  const rows = await pool.query("SELECT COUNT(*)::int AS n FROM connector_calls WHERE withheld_ref = $1 AND outcome = 'withheld'", [ref]);
  assert.equal(rows.rows[0].n, 1);
});

test('the tripwire count: different clients of served calls in the window, per grant', async () => {
  for (const clientId of [88001, 88002, 88002, 88003]) {
    await callLog.recordCall({ grantId, toolName: 'client', clientId, outcome: 'ok' });
  }
  await callLog.recordCall({ grantId, toolName: 'client', clientId: 88004, outcome: 'refused_tripwire' });
  assert.equal(await callLog.countRecentClients(grantId), 3, 'three different served clients; the refused one is not counted');
  assert.equal(await callLog.countRecentClients(grantId, { now: new Date(Date.now() + 2 * 60 * 60 * 1000) }), 0,
    'the window rolls');
});
