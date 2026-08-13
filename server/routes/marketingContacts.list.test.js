require('dotenv').config();
process.env.NODE_ENV = 'test';

// Route tests for the marketing contact READ surface.
//
// HARNESS NOTES (each was gotten wrong once; do not "simplify"):
//   - `users` has NO `name` and NO `password`; role CHECK allows manager.
//   - `auth` verifies decoded.userId + decoded.tokenVersion, not decoded.id.
//   - AppError carries `statusCode`, not `status`; reading `status` yields
//     res.status(undefined), which throws and HANGS the request.
//   - `clients.communication_preferences` is JSONB NOT NULL with a three-key
//     default, so the tri-state "absent key" case needs '{}'::jsonb, and
//     setting it NULL raises 23502.
//   - Fixture emails must NOT be .invalid; MAILABLE_SQL suppresses that domain.
//
// FIXTURE DISCIPLINE: everything is created in before() and destroyed in
// after(). A test that mutates the fixture restores it in its own body.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const router = require('./marketingContacts');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `mkt-${NONCE}@mkt-test.example`;
let server, base, adminToken, managerToken, clientId;

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const mine = (body) => body.contacts.find(c => c.id === clientId);

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'admin', 'approved') RETURNING id`,
    [`mkt-admin-${NONCE}@mkt-test.example`]
  );
  const m = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'manager', 'approved') RETURNING id`,
    [`mkt-mgr-${NONCE}@mkt-test.example`]
  );
  adminToken = jwt.sign({ userId: a.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET);
  managerToken = jwt.sign({ userId: m.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET);

  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [`MKT ${NONCE}`, EMAIL]
  );
  clientId = c.rows[0].id;

  // A booked Check Cherry ledger row: makes this contact a PAST CLIENT with no
  // native proposal at all, which is the Check Cherry cohort the audiences must
  // not drop. total_cost_cents is CENTS; 76000 must read as $760, not $76,000.
  await pool.query(
    `INSERT INTO legacy_cc_proposals (cc_id, status, client_email_normalized, event_date, total_cost_cents)
     VALUES ($1, 'booked', $2, CURRENT_DATE - 400, 76000)`,
    [`cc-${NONCE}`, EMAIL]
  );

  const app = express();
  app.use(express.json());
  app.use('/api/marketing', router);
  app.use((err, _req, res, _next) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    const body = { error: err.message, code: err.code };
    if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
    res.status(status).json(body);
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await pool.query('DELETE FROM legacy_cc_proposals WHERE cc_id LIKE $1', [`cc-${NONCE}%`]);
  await pool.query('DELETE FROM client_tags WHERE client_id = $1', [clientId]);
  await pool.query("DELETE FROM admin_audit_log WHERE metadata->>'client_id' = $1", [String(clientId)]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`mkt-%-${NONCE}@mkt-test.example`]);
  server.close();
  await pool.end();
});

test('a clean contact is mailable with no held-back reason', async () => {
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  assert.equal(r.status, 200);
  const row = mine(r.body);
  assert.ok(row, 'fixture contact missing from the list');
  assert.equal(row.mailable, true);
  assert.equal(row.held_back_reason, null);
});

test('a client with NO preference keys is mailable (tri-state)', async () => {
  // The column is JSONB NOT NULL with a three-key default, so the absent-key
  // case is only reachable by writing an empty object. NULL raises 23502.
  await pool.query(`UPDATE clients SET communication_preferences = '{}'::jsonb WHERE id = $1`, [clientId]);
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  assert.equal(mine(r.body).mailable, true);
});

test('marketing_enabled false reports unsubscribed', async () => {
  await pool.query(
    `UPDATE clients SET communication_preferences =
       jsonb_set(communication_preferences, '{marketing_enabled}', 'false') WHERE id = $1`, [clientId]);
  const row = mine((await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken)).body);
  assert.equal(row.mailable, false);
  assert.equal(row.held_back_reason, 'unsubscribed');
  await pool.query(`UPDATE clients SET communication_preferences = '{}'::jsonb WHERE id = $1`, [clientId]);
});

test('do-not-contact outranks a bounce, and buckets stay exclusive', async () => {
  // A row that is BOTH excluded and bounced must land in exactly one bucket.
  // Independent COUNT FILTERs would count it twice and the panel would never
  // reconcile with the rows.
  await pool.query(
    `UPDATE clients SET marketing_excluded = true, marketing_excluded_reason = 'both',
                        email_status = 'bad' WHERE id = $1`, [clientId]);
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  const h = r.body.held_back;
  assert.equal(mine(r.body).held_back_reason, 'do_not_contact');
  assert.equal(h.do_not_contact, 1);
  assert.equal(h.bounced, 0, 'the same row was counted in two buckets');
  assert.equal(h.do_not_contact + h.unsubscribed + h.bounced + h.no_address + h.mailable,
    r.body.total, 'buckets do not partition the base');
  await pool.query(
    `UPDATE clients SET marketing_excluded = false, marketing_excluded_reason = NULL,
                        email_status = 'ok' WHERE id = $1`, [clientId]);
});

test('lifetime_dollars converts Check Cherry cents, so $760 is not $76,000', async () => {
  const row = mine((await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken)).body);
  assert.ok(row.lifetime_dollars >= 760 && row.lifetime_dollars < 761,
    `expected ~760, got ${row.lifetime_dollars}`);
});

test('a Check Cherry booking alone makes someone a past client', async () => {
  // This fixture has NO native proposal. Gating past-client audiences on
  // proposals only would silently drop the whole Check Cherry cohort.
  const r = await req('GET',
    `/api/marketing/contacts?search=${NONCE}&audience=past-all`, adminToken);
  assert.ok(mine(r.body), 'CC-only client excluded from past-all');
  assert.equal(mine(r.body).derived, 'paid');
});

test('an untagged contact carries a suggestion, a tagged one does not', async () => {
  const before1 = mine((await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken)).body);
  assert.equal(before1.untagged, true);
  await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: ['corporate'] });
  const after1 = mine((await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken)).body);
  assert.equal(after1.suggestion, null);
  assert.deepEqual(after1.tags, ['corporate']);
});

test('filter_counts are scoped to the base, not the active filter', async () => {
  // Selecting Untagged must not zero the other chips. Computing them inside
  // the filtered scope makes it read "All N / Untagged N / Corporate 0".
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}&filter=untagged`, adminToken);
  assert.equal(r.body.contacts.length, 0, 'the tagged fixture should not match untagged');
  assert.ok(r.body.filter_counts.all >= 1, 'chips collapsed to the active filter');
  assert.ok(r.body.filter_counts.corporate >= 1, 'corporate chip lost its count');
  await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: [] });
});

test('filter=corporate narrows the rows', async () => {
  await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: ['corporate'] });
  assert.ok(mine((await req('GET',
    `/api/marketing/contacts?search=${NONCE}&filter=corporate`, adminToken)).body));
  await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: [] });
  assert.equal(mine((await req('GET',
    `/api/marketing/contacts?search=${NONCE}&filter=corporate`, adminToken)).body), undefined);
});

test('mailable_only=true drops held-back contacts entirely', async () => {
  await pool.query(
    `UPDATE clients SET marketing_excluded = true, marketing_excluded_reason = 'x' WHERE id = $1`,
    [clientId]);
  const r = await req('GET',
    `/api/marketing/contacts?search=${NONCE}&mailable_only=true`, adminToken);
  assert.equal(mine(r.body), undefined);
  await pool.query(
    `UPDATE clients SET marketing_excluded = false, marketing_excluded_reason = NULL WHERE id = $1`,
    [clientId]);
});

test('total reflects the base even on a page past the end', async () => {
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}&page=99`, adminToken);
  assert.equal(r.body.contacts.length, 0);
  assert.ok(r.body.total >= 1, 'total came from a row window rather than the aggregate');
});

test('last_contacted and derived are returned, not merely computed', async () => {
  const row = mine((await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken)).body);
  assert.ok('last_contacted' in row, 'last_contacted missing from the response');
  assert.ok('derived' in row, 'derived state missing from the response');
});

test('last_event is a real date, never -Infinity', async () => {
  const row = mine((await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken)).body);
  assert.ok(row.last_event, 'the CC booking should supply a last_event');
  assert.ok(Number.isFinite(Date.parse(row.last_event)), `got ${row.last_event}`);
});

test('every audience resolves through the endpoint', async () => {
  const r = await req('GET', '/api/marketing/audiences', adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 7);
  for (const a of r.body) {
    assert.equal(typeof a.emailable, 'number', `${a.id} returned no count`);
    assert.ok(a.emailable <= a.total, `${a.id}: emailable exceeds total`);
    assert.ok(a.name && a.rule && Array.isArray(a.includes), `${a.id} missing display strings`);
  }
});

test('an unknown audience is a 400, not a 500', async () => {
  assert.equal((await req('GET', '/api/marketing/contacts?audience=nope', adminToken)).status, 400);
});

test('an unknown filter is a 400, not a silently empty list', async () => {
  assert.equal((await req('GET', '/api/marketing/contacts?filter=vip', adminToken)).status, 400);
});

test('a manager cannot read the contact list or the audiences', async () => {
  assert.equal((await req('GET', '/api/marketing/contacts', managerToken)).status, 403);
  assert.equal((await req('GET', '/api/marketing/audiences', managerToken)).status, 403);
});

test('an unauthenticated caller cannot read either', async () => {
  assert.equal((await req('GET', '/api/marketing/contacts', null)).status, 401);
  assert.equal((await req('GET', '/api/marketing/audiences', null)).status, 401);
});
