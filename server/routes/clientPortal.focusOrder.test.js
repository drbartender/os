require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const clientPortalRouter = require('./clientPortal');

// Fix #9 (P1.2): the portal focus picker must prefer a BOOKED proposal over a
// newer draft that shares the same event date/time. Regression source: Allyson
// Gietl's portal focused a `viewed` draft instead of her booked event because
// the ORDER BY was `created_at DESC` with no status precedence.

let server, baseUrl;
const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = `cp-order-%-${NONCE}@example.com`;

function request(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => { let d = ''; res.on('data', c => d += c);
        res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch { /* HTML */ }
          resolve({ status: res.statusCode, body: j, raw: d }); }); });
    req.on('error', reject); req.end();
  });
}
const clientToken = (id, email) => jwt.sign({ id, email, role: 'client' }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function mkClient(tag) {
  const email = `cp-order-${tag}-${NONCE}@example.com`;
  const r = await pool.query('INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id', [`CP ${tag}`, email]);
  return { id: r.rows[0].id, email, token: clientToken(r.rows[0].id, email) };
}
async function mkProposal(clientId, { status = 'sent', date = null, start = null, total = '4800.00', paid = '0' }) {
  const r = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_start_time, total_price, amount_paid, event_type)
     VALUES ($1,$2,$3,$4,$5,$6,'wedding') RETURNING id, token`,
    [clientId, status, date, start, total, paid]);
  return r.rows[0];
}
const setCreatedAt = (id, interval) => pool.query(`UPDATE proposals SET created_at = NOW() - INTERVAL '${interval}' WHERE id = $1`, [id]);

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/client-portal', clientPortalRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise(r => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => {
  await pool.query("DELETE FROM invoices WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1))", [EMAIL_LIKE]);
  await pool.query("DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1)", [EMAIL_LIKE]);
  await pool.query("DELETE FROM clients WHERE email LIKE $1", [EMAIL_LIKE]);
  await new Promise(r => server.close(r));
});

test('booked proposal wins over a newer same-date/time draft', async () => {
  const c = await mkClient('booked-wins');
  const draft = await mkProposal(c.id, { status: 'viewed', date: '2099-08-15', start: '17:00' });
  const booked = await mkProposal(c.id, { status: 'deposit_paid', date: '2099-08-15', start: '17:00' });
  // Force the booked row OLDER so the legacy `created_at DESC` ordering would
  // have shadowed it with the newer draft. Status-first ordering must still pick booked.
  await setCreatedAt(booked.id, '2 days');
  const res = await request('/api/client-portal/home', c.token);
  assert.equal(res.body.focus.token, booked.token);
  assert.equal(res.body.focus.booked, true);
});

test('among two booked, soonest date/time still wins (ordering preserved)', async () => {
  const c = await mkClient('booked-vs-booked');
  const later = await mkProposal(c.id, { status: 'confirmed', date: '2099-09-20', start: '18:00' });
  const sooner = await mkProposal(c.id, { status: 'deposit_paid', date: '2099-08-20', start: '12:00' });
  // Make `sooner` the newer row too, to prove date beats created_at within a status tier.
  await setCreatedAt(later.id, '1 day');
  const res = await request('/api/client-portal/home', c.token);
  assert.equal(res.body.focus.token, sooner.token);
});

test('a booked LATER event outranks an unbooked SOONER one (bookings never shadowed)', async () => {
  const c = await mkClient('booked-beats-sooner');
  const soonerDraft = await mkProposal(c.id, { status: 'sent', date: '2099-08-01' });
  const laterBooked = await mkProposal(c.id, { status: 'deposit_paid', date: '2099-09-01' });
  const res = await request('/api/client-portal/home', c.token);
  assert.equal(res.body.focus.token, laterBooked.token);
  assert.notEqual(res.body.focus.token, soonerDraft.token);
});

test('no booked proposal: newest draft still wins among same date/time', async () => {
  const c = await mkClient('all-drafts');
  const old = await mkProposal(c.id, { status: 'sent', date: '2099-07-10', start: '15:00' });
  const fresh = await mkProposal(c.id, { status: 'viewed', date: '2099-07-10', start: '15:00' });
  await setCreatedAt(old.id, '3 days');
  const res = await request('/api/client-portal/home', c.token);
  assert.equal(res.body.focus.token, fresh.token);
});
