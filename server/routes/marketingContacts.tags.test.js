require('dotenv').config();
process.env.NODE_ENV = 'test';

// Route tests for the marketing tag + do-not-contact write surface.
//
// HARNESS NOTES (each of these was gotten wrong once; do not "simplify" them):
//   - `users` has NO `name` and NO `password`. Columns are id, email,
//     password_hash, role, onboarding_status (schema.sql:12-20). The role CHECK
//     was widened to ('staff','admin','manager') at schema.sql:294-296.
//   - `auth` verifies decoded.userId and compares decoded.tokenVersion against
//     the row's token_version (auth.js:38,46). NOT decoded.id, and the role
//     comes from the DB row, never from the token.
//   - AppError carries `statusCode`, NOT `status` (errors.js:6). Reading
//     err.status yields res.status(undefined), which throws and hangs the
//     request forever rather than failing loudly.
//   - Fixture emails must NOT be .invalid: that domain is suppressed by the
//     marketing mailability rules, so such a fixture can never be mailable.

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
let server, base, adminToken, managerToken, adminUserId, clientId;

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

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'admin', 'approved') RETURNING id`,
    [`mkt-admin-${NONCE}@mkt-test.example`]
  );
  adminUserId = a.rows[0].id;
  const m = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'manager', 'approved') RETURNING id`,
    [`mkt-mgr-${NONCE}@mkt-test.example`]
  );

  adminToken = jwt.sign({ userId: adminUserId, tokenVersion: 0 }, process.env.JWT_SECRET);
  managerToken = jwt.sign({ userId: m.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET);

  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [`MKT ${NONCE}`, `mkt-${NONCE}@mkt-test.example`]
  );
  clientId = c.rows[0].id;

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
  // Children before parents; pool.end() last.
  await pool.query('DELETE FROM client_tags WHERE client_id = $1', [clientId]);
  await pool.query("DELETE FROM admin_audit_log WHERE metadata->>'client_id' = $1", [String(clientId)]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`mkt-%-${NONCE}@mkt-test.example`]);
  server.close();
  await pool.end();
});

// ─── Tags ──────────────────────────────────────────────────────────

test('sets tags and returns them in vocabulary order', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken,
    { tags: ['birthday', 'corporate'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tags, ['corporate', 'birthday']);
});

test('replaces the whole set, so removal works', async () => {
  await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: ['corporate'] });
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: [] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tags, []);
  const { rows } = await pool.query('SELECT 1 FROM client_tags WHERE client_id = $1', [clientId]);
  assert.equal(rows.length, 0, 'an empty array must clear every tag');
});

test('records who set each tag', async () => {
  await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: ['wedding'] });
  const { rows } = await pool.query(
    'SELECT set_by, set_at FROM client_tags WHERE client_id = $1 AND tag = $2', [clientId, 'wedding']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].set_by, adminUserId);
  assert.ok(rows[0].set_at instanceof Date);
  await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: [] });
});

test('de-duplicates a repeated tag in the payload', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken,
    { tags: ['corporate', 'corporate'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tags, ['corporate']);
  await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: [] });
});

test('rejects an unknown tag', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: ['vip'] });
  assert.equal(r.status, 400);
});

test('rejects do-not-contact, which is not a client_tags value', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken,
    { tags: ['do-not-contact'] });
  assert.equal(r.status, 400);
  const { rows } = await pool.query(
    "SELECT 1 FROM client_tags WHERE client_id = $1 AND tag = 'do-not-contact'", [clientId]);
  assert.equal(rows.length, 0);
});

test('rejects a non-array body', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: 'corporate' });
  assert.equal(r.status, 400);
});

test('rejects a missing body', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, {});
  assert.equal(r.status, 400);
});

test('404s an unknown client', async () => {
  const r = await req('PUT', '/api/marketing/contacts/99999999/tags', adminToken, { tags: [] });
  assert.equal(r.status, 404);
});

test('400s a non-numeric id rather than 500ing', async () => {
  const r = await req('PUT', '/api/marketing/contacts/abc/tags', adminToken, { tags: [] });
  assert.equal(r.status, 400);
});

test('400s an out-of-int4-range id rather than 500ing on 22003', async () => {
  // Number.isInteger(parseInt('3000000000', 10)) is true, so a naive guard
  // passes and the value reaches an integer column.
  for (const path of ['tags', 'do-not-contact']) {
    const body = path === 'tags' ? { tags: [] } : { excluded: false };
    const r = await req('PUT', `/api/marketing/contacts/3000000000/${path}`, adminToken, body);
    assert.equal(r.status, 400, `${path} did not reject an out-of-range id`);
  }
});

test('rejects an over-long reason, so the audit row is never silently dropped', async () => {
  // logAdminAction discards metadata over 8 KB by reporting to Sentry and
  // returning normally, so an unbounded reason would suppress someone with a
  // 200 and no trail.
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, adminToken,
    { excluded: true, reason: 'x'.repeat(501) });
  assert.equal(r.status, 400);
  const { rows } = await pool.query('SELECT marketing_excluded FROM clients WHERE id = $1', [clientId]);
  assert.equal(rows[0].marketing_excluded, false);
});

test('a tag write is audited, so removals are not untraceable', async () => {
  await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: ['corporate'] });
  await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: [] });
  const { rows } = await pool.query(
    `SELECT metadata FROM admin_audit_log
      WHERE action = 'marketing.tags.set' AND metadata->>'client_id' = $1
      ORDER BY created_at DESC LIMIT 1`, [String(clientId)]);
  assert.equal(rows.length, 1, 'tag writes are not audited');
  assert.deepEqual(rows[0].metadata.tags, [], 'the removal itself must be recorded');
});

test('a manager cannot write tags', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, managerToken, { tags: ['corporate'] });
  assert.equal(r.status, 403);
});

test('an unauthenticated caller cannot write tags', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, null, { tags: ['corporate'] });
  assert.equal(r.status, 401);
});

// ─── Do-not-contact ────────────────────────────────────────────────

test('setting do-not-contact requires a reason', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, adminToken,
    { excluded: true });
  assert.equal(r.status, 400);
  const { rows } = await pool.query('SELECT marketing_excluded FROM clients WHERE id = $1', [clientId]);
  assert.equal(rows[0].marketing_excluded, false);
});

test('setting do-not-contact rejects a blank reason', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, adminToken,
    { excluded: true, reason: '   ' });
  assert.equal(r.status, 400);
});

test('rejects a non-boolean excluded', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, adminToken,
    { excluded: 'yes', reason: 'x' });
  assert.equal(r.status, 400);
});

test('sets do-not-contact with a reason, actor, and timestamp', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, adminToken,
    { excluded: true, reason: 'Asked not to be emailed on the review reply' });
  assert.equal(r.status, 200);
  assert.equal(r.body.excluded, true);
  const { rows } = await pool.query(
    `SELECT marketing_excluded, marketing_excluded_reason, marketing_excluded_at, marketing_excluded_by
     FROM clients WHERE id = $1`, [clientId]);
  assert.equal(rows[0].marketing_excluded, true);
  assert.equal(rows[0].marketing_excluded_reason, 'Asked not to be emailed on the review reply');
  assert.ok(rows[0].marketing_excluded_at instanceof Date);
  assert.equal(rows[0].marketing_excluded_by, adminUserId);
});

test('writes an audit row with the client id in metadata, not target_user_id', async () => {
  const { rows } = await pool.query(
    `SELECT target_user_id, metadata FROM admin_audit_log
      WHERE action = 'marketing.do_not_contact.set' AND metadata->>'client_id' = $1
      ORDER BY created_at DESC LIMIT 1`, [String(clientId)]);
  assert.equal(rows.length, 1, 'audit row missing');
  assert.equal(rows[0].target_user_id, null, 'target_user_id FKs to users; a client is not a user');
  assert.equal(rows[0].metadata.reason, 'Asked not to be emailed on the review reply');
});

test('clearing nulls the reason, actor, and timestamp', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, adminToken,
    { excluded: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.excluded, false);
  const { rows } = await pool.query(
    `SELECT marketing_excluded, marketing_excluded_reason, marketing_excluded_at, marketing_excluded_by
     FROM clients WHERE id = $1`, [clientId]);
  assert.equal(rows[0].marketing_excluded, false);
  assert.equal(rows[0].marketing_excluded_reason, null);
  assert.equal(rows[0].marketing_excluded_at, null);
  assert.equal(rows[0].marketing_excluded_by, null);
});

test('clearing writes its own audit row', async () => {
  const { rows } = await pool.query(
    `SELECT 1 FROM admin_audit_log
      WHERE action = 'marketing.do_not_contact.cleared' AND metadata->>'client_id' = $1`,
    [String(clientId)]);
  assert.equal(rows.length, 1);
});

test('404s an unknown client', async () => {
  const r = await req('PUT', '/api/marketing/contacts/99999999/do-not-contact', adminToken,
    { excluded: false });
  assert.equal(r.status, 404);
});

test('a manager cannot set do-not-contact', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, managerToken,
    { excluded: true, reason: 'nope' });
  assert.equal(r.status, 403);
});

// ─── Clearing a bad email_status (lane mkt-f) ──────────────────────

test('an admin can clear a bad email_status, and only to ok', async () => {
  // email_status='bad' gates proposals, invoices and agreements, and nothing in
  // the product ever wrote it back: one bounce was a one-way door repairable
  // only by hand-editing the database.
  await pool.query("UPDATE clients SET email_status = 'bad' WHERE id = $1", [clientId]);

  const ok = await req('PUT', `/api/marketing/contacts/${clientId}/email-status`, adminToken, { status: 'ok' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email_status, 'ok');

  const { rows } = await pool.query('SELECT email_status FROM clients WHERE id = $1', [clientId]);
  assert.equal(rows[0].email_status, 'ok');
});

test('the endpoint refuses to MARK an address bad', async () => {
  // An address is marked bad by delivery evidence from the webhook, never by
  // hand. Allowing it here would let a stray click gate someone's invoices.
  const bad = await req('PUT', `/api/marketing/contacts/${clientId}/email-status`, adminToken, { status: 'bad' });
  assert.equal(bad.status, 400);
  const junk = await req('PUT', `/api/marketing/contacts/${clientId}/email-status`, adminToken, {});
  assert.equal(junk.status, 400);
});

test('clearing email_status does not touch the do-not-contact flag', async () => {
  // Two separate decisions: "your address works again" and "we still do not
  // market to you". Collapsing them would quietly re-enrol an excluded contact.
  await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, adminToken,
    { excluded: true, reason: 'separate decision' });
  await pool.query("UPDATE clients SET email_status = 'bad' WHERE id = $1", [clientId]);

  const r = await req('PUT', `/api/marketing/contacts/${clientId}/email-status`, adminToken, { status: 'ok' });
  assert.equal(r.status, 200);

  const { rows } = await pool.query(
    'SELECT email_status, marketing_excluded FROM clients WHERE id = $1', [clientId]);
  assert.equal(rows[0].email_status, 'ok');
  assert.equal(rows[0].marketing_excluded, true, 'do-not-contact must survive an email_status repair');

  await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, adminToken, { excluded: false });
});

test('a manager cannot clear an email_status', async () => {
  assert.equal(
    (await req('PUT', `/api/marketing/contacts/${clientId}/email-status`, managerToken, { status: 'ok' })).status,
    403);
});

test('clearing an already-ok email_status is idempotent, not a 404', async () => {
  // The bad-only guard must not make a repeat call look like a missing contact.
  await pool.query("UPDATE clients SET email_status = 'bad' WHERE id = $1", [clientId]);
  const first = await req('PUT', `/api/marketing/contacts/${clientId}/email-status`, adminToken, { status: 'ok' });
  assert.equal(first.status, 200);
  assert.equal(first.body.changed, true);

  const second = await req('PUT', `/api/marketing/contacts/${clientId}/email-status`, adminToken, { status: 'ok' });
  assert.equal(second.status, 200, 'a repeat repair must not 404 — the contact exists');
  assert.equal(second.body.email_status, 'ok');
  assert.equal(second.body.changed, false);
});

test('a genuinely missing contact still 404s', async () => {
  assert.equal(
    (await req('PUT', '/api/marketing/contacts/99999999/email-status', adminToken, { status: 'ok' })).status,
    404);
});
