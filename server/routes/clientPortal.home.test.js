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

let server, baseUrl;
const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = `cp-home-%-${NONCE}@example.com`;

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
  const email = `cp-home-${tag}-${NONCE}@example.com`;
  const r = await pool.query('INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id', [`CP ${tag}`, email]);
  return { id: r.rows[0].id, email, token: clientToken(r.rows[0].id, email) };
}
async function mkProposal(clientId, { status = 'sent', date = null, start = null, total = '4800.00', paid = '0', reason = null }) {
  const r = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_start_time, total_price, amount_paid, event_type, archive_reason)
     VALUES ($1,$2,$3,$4,$5,$6,'wedding',$7) RETURNING id, token`,
    [clientId, status, date, start, total, paid, reason]);
  return r.rows[0];
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/client-portal', clientPortalRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise(r => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => {
  await pool.query("DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1)", [EMAIL_LIKE]);
  await pool.query("DELETE FROM clients WHERE email LIKE $1", [EMAIL_LIKE]);
  await new Promise(r => server.close(r));
});

test('no token -> 401', async () => { assert.equal((await request('/api/client-portal/home', null)).status, 401); });

test('brand-new client: focus null, empty archive, no draft', async () => {
  const c = await mkClient('new');
  const res = await request('/api/client-portal/home', c.token);
  assert.equal(res.status, 200); assert.equal(res.body.focus, null);
  assert.deepEqual(res.body.archive, []); assert.equal(res.body.has_quote_draft, false);
});

test('single upcoming booked -> focus, money in dollars, count 1', async () => {
  const c = await mkClient('one');
  await mkProposal(c.id, { status: 'deposit_paid', date: '2099-10-03', total: '4800.00', paid: '1000.00' });
  const res = await request('/api/client-portal/home', c.token);
  assert.ok(res.body.focus); assert.equal(res.body.focus.booked, true);
  assert.equal(res.body.focus.total_price, 4800); assert.equal(res.body.focus.balance_due, 3800);
  assert.equal(res.body.upcoming_count, 1);
});

test('IDOR: B sees only B rows, never A', async () => {
  const a = await mkClient('idorA'); const b = await mkClient('idorB');
  const ap = await mkProposal(a.id, { status: 'deposit_paid', date: '2099-11-01' });
  const bp = await mkProposal(b.id, { status: 'deposit_paid', date: '2099-12-01' });
  const res = await request('/api/client-portal/home', b.token);
  assert.equal(res.body.focus.token, bp.token);
  assert.notEqual(res.body.focus.token, ap.token);
});

test('two-plus upcoming -> soonest is focus, count 2', async () => {
  const c = await mkClient('two');
  await mkProposal(c.id, { status: 'deposit_paid', date: '2099-09-01' });
  const soon = await mkProposal(c.id, { status: 'sent', date: '2099-08-01' });
  const res = await request('/api/client-portal/home', c.token);
  assert.equal(res.body.focus.token, soon.token); assert.equal(res.body.upcoming_count, 2);
});

test('same-date tie-break: earlier start_time wins', async () => {
  const c = await mkClient('tie');
  const late = await mkProposal(c.id, { status: 'sent', date: '2099-07-01', start: '18:00' });
  const early = await mkProposal(c.id, { status: 'sent', date: '2099-07-01', start: '12:00' });
  const res = await request('/api/client-portal/home', c.token);
  assert.equal(res.body.focus.token, early.token);
});

test('null-date draft becomes focus only when no dated upcoming (no countdown)', async () => {
  const c = await mkClient('null');
  await mkProposal(c.id, { status: 'draft', date: null });
  const res = await request('/api/client-portal/home', c.token);
  assert.ok(res.body.focus); assert.equal(res.body.focus.event_date, null);
});

test('hidden-rows-only (cancelled-archive) -> brand-new (focus null, archive empty)', async () => {
  const c = await mkClient('hidden');
  await mkProposal(c.id, { status: 'archived', date: '2099-06-01', reason: 'client_cancelled' });
  const res = await request('/api/client-portal/home', c.token);
  assert.equal(res.body.focus, null); assert.deepEqual(res.body.archive, []);
});

test('expired unbooked-past -> not focus, not archive', async () => {
  const c = await mkClient('expired');
  await mkProposal(c.id, { status: 'sent', date: '2020-01-01' });
  const res = await request('/api/client-portal/home', c.token);
  assert.equal(res.body.focus, null); assert.deepEqual(res.body.archive, []);
});

test('completed past -> archive, not focus', async () => {
  const c = await mkClient('done');
  await mkProposal(c.id, { status: 'completed', date: '2020-01-01', total: '2500.00', paid: '2500.00' });
  const res = await request('/api/client-portal/home', c.token);
  assert.equal(res.body.focus, null); assert.equal(res.body.archive.length, 1);
  assert.equal(res.body.archive[0].status, 'completed');
});

test('detail endpoint exposes drink_plan_token + venue trio (parity)', async () => {
  const c = await mkClient('detail');
  const p = await mkProposal(c.id, { status: 'deposit_paid', date: '2099-12-01' });
  await pool.query('UPDATE proposals SET venue_city = $2, venue_state = $3 WHERE id = $1', [p.id, 'Chicago', 'IL']);
  await pool.query('INSERT INTO drink_plans (proposal_id, submitted_at) VALUES ($1, NULL)', [p.id]);
  const res = await request(`/api/client-portal/proposals/${p.token}`, c.token);
  assert.equal(res.status, 200);
  assert.ok('drink_plan_token' in res.body.proposal);
  assert.equal(res.body.proposal.venue_city, 'Chicago');
});
test('detail endpoint: unowned token -> 404 (JSON, not HTML)', async () => {
  const a = await mkClient('own'); const b = await mkClient('other');
  const p = await mkProposal(a.id, { status: 'sent', date: '2099-01-01' });
  const res = await request(`/api/client-portal/proposals/${p.token}`, b.token);
  assert.equal(res.status, 404);
});
