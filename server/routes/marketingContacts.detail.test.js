require('dotenv').config();
process.env.NODE_ENV = 'test';

// Route tests for GET /api/marketing/contacts/:id — the drawer.
//
// Harness notes are the same set pinned in marketingContacts.list.test.js:
// users has no name/password column, auth reads decoded.userId, AppError
// carries statusCode not status, and fixture emails must not be .invalid.
//
// message_log needs proposal_id AND recipient (both NOT NULL); scheduled_messages
// needs an explicit sent_at or a status='sent' row is invisible to the history.

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
const EMAIL = `dtl-${NONCE}@mkt-test.example`;
let server, base, adminToken, managerToken, adminUserId, clientId, proposalId;

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
    [`dtl-admin-${NONCE}@mkt-test.example`]
  );
  adminUserId = a.rows[0].id;
  const m = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'manager', 'approved') RETURNING id`,
    [`dtl-mgr-${NONCE}@mkt-test.example`]
  );
  adminToken = jwt.sign({ userId: adminUserId, tokenVersion: 0 }, process.env.JWT_SECRET);
  managerToken = jwt.sign({ userId: m.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET);

  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id', [`DTL ${NONCE}`, EMAIL]);
  clientId = c.rows[0].id;

  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_type, venue_name, status, total_price, amount_paid)
     VALUES ($1, CURRENT_DATE - 60, 'corporate-event', 'Some Office', 'completed', 900, 900) RETURNING id`,
    [clientId]);
  proposalId = p.rows[0].id;

  // HUMAN-sent: sent_by set.
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, subject, status, sent_by, created_at)
     VALUES ($1,$2,'email','proposal_sent',$3,'Your proposal is ready','sent',$4, NOW() - INTERVAL '30 days')`,
    [proposalId, clientId, EMAIL, adminUserId]);

  // SCHEDULER-sent: sent_by NULL. 2,165 of 2,200 prod rows look like this.
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, subject, status, created_at)
     VALUES ($1,$2,'email','review_request',$3,'How was your event?','sent', NOW() - INTERVAL '28 days')`,
    [proposalId, clientId, EMAIL]);
});

after(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE recipient_type = $1 AND recipient_id = $2',
    ['client', clientId]);
  await pool.query('DELETE FROM message_log WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM client_tags WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`dtl-%-${NONCE}@mkt-test.example`]);
  server.close();
  await pool.end();
});

before(() => {
  const app = express();
  app.use(express.json());
  app.use('/api/marketing', router);
  app.use((err, _req, res, _next) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test('returns identity, tags, lifetime, events, and message history', async () => {
  const r = await req('GET', `/api/marketing/contacts/${clientId}`, adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, clientId);
  assert.equal(r.body.email, EMAIL);
  assert.ok(Array.isArray(r.body.tags));
  assert.ok(Array.isArray(r.body.events));
  assert.ok(Array.isArray(r.body.messages));
  assert.equal(typeof r.body.lifetime_dollars, 'number');
});

test('the event list carries what the drawer renders', async () => {
  const ev = (await req('GET', `/api/marketing/contacts/${clientId}`, adminToken)).body.events;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].event_type, 'corporate-event');
  assert.equal(ev[0].venue_name, 'Some Office');
  assert.equal(ev[0].amount, 900);
});

test('message history distinguishes automated from human', async () => {
  // The whole point of the drawer: "the system emailed them" and "I emailed
  // them" are different facts when deciding whether to reach out again.
  const msgs = (await req('GET', `/api/marketing/contacts/${clientId}`, adminToken)).body.messages;
  const human = msgs.find(m => m.kind === 'proposal_sent');
  const system = msgs.find(m => m.kind === 'review_request');
  assert.ok(human && system, 'both fixture messages should appear');
  assert.equal(human.automated, false, 'sent_by set means a human sent it');
  assert.equal(system.automated, true, 'sent_by NULL means the scheduler sent it');
});

test('message history is newest first', async () => {
  const msgs = (await req('GET', `/api/marketing/contacts/${clientId}`, adminToken)).body.messages;
  for (let i = 1; i < msgs.length; i++) {
    assert.ok(new Date(msgs[i - 1].at) >= new Date(msgs[i].at), 'not newest first');
  }
});

test('a paid client reads as derived: paid', async () => {
  const b = (await req('GET', `/api/marketing/contacts/${clientId}`, adminToken)).body;
  assert.equal(b.derived, 'paid');
  assert.ok(b.last_event, 'a completed past event should supply last_event');
});

test('do-not-contact set through the real endpoint reads back whole in the drawer', async () => {
  // Set via the ENDPOINT, not raw SQL: only the endpoint stamps
  // marketing_excluded_at, and the drawer shows the operator when it was set
  // so they know what they are undoing. A raw UPDATE leaves that null, which
  // is how the first draft of this test passed a broken expectation.
  const put = await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, adminToken,
    { excluded: true, reason: 'asked us to stop' });
  assert.equal(put.status, 200);

  const b = (await req('GET', `/api/marketing/contacts/${clientId}`, adminToken)).body;
  assert.equal(b.do_not_contact, true);
  assert.equal(b.do_not_contact_reason, 'asked us to stop');
  assert.ok(b.do_not_contact_at, 'the drawer needs to show when it was set');
  assert.equal(b.mailable, false);
  assert.equal(b.held_back_reason, 'do_not_contact');

  const cleared = await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, adminToken,
    { excluded: false });
  assert.equal(cleared.status, 200);
  const after1 = (await req('GET', `/api/marketing/contacts/${clientId}`, adminToken)).body;
  assert.equal(after1.do_not_contact, false);
  assert.equal(after1.do_not_contact_at, null, 'clearing must null the timestamp too');
  assert.equal(after1.mailable, true);
});

test('404s an unknown contact', async () => {
  assert.equal((await req('GET', '/api/marketing/contacts/99999999', adminToken)).status, 404);
});

test('400s a non-numeric and an out-of-int4-range id rather than 500ing', async () => {
  assert.equal((await req('GET', '/api/marketing/contacts/abc', adminToken)).status, 400);
  assert.equal((await req('GET', '/api/marketing/contacts/3000000000', adminToken)).status, 400);
});

test('a manager cannot read a contact record', async () => {
  assert.equal((await req('GET', `/api/marketing/contacts/${clientId}`, managerToken)).status, 403);
});

test('an unauthenticated caller cannot', async () => {
  assert.equal((await req('GET', `/api/marketing/contacts/${clientId}`, null)).status, 401);
});
