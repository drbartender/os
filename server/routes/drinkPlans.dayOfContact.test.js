// GET /api/drink-plans/by-proposal/:proposalId?fields=day_of_contact
//
// The phone event detail shows the day-of contact and nothing else from the
// drink plan. This projection exists so that is ALL the phone reads, and all
// the admin service worker stores: the full read carries the plan's
// write-capable token, the internal notes and the venue access notes clients
// type gate codes into (lane ma-e2, security checkpoint, 2026-09-29).

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

if (process.env.NODE_ENV === 'production') {
  throw new Error('drinkPlans.dayOfContact.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = (label) => `day-of-${NONCE}-${label}@example.com`;
const ids = { users: [], proposals: [], clients: [], plans: [] };
let server, baseUrl, adminToken, staffToken;
let withContact, withoutContact, blankName, noPlan;

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
async function makeUser(label, role) {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', $2, 'approved', 0) RETURNING id, token_version`,
    [EMAIL(label), role]
  );
  ids.users.push(r.rows[0].id);
  return jwt.sign({ userId: r.rows[0].id, tokenVersion: r.rows[0].token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
async function seedProposal() {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, guest_count, event_type, total_price, amount_paid)
     VALUES ($1, 'deposit_paid', CURRENT_DATE + 30, 100, 'wedding-reception', 1000, 100) RETURNING id`,
    [ids.clients[0]]
  );
  ids.proposals.push(p.rows[0].id);
  return p.rows[0].id;
}
async function seedPlan(proposalId, selections) {
  const r = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, admin_notes, client_email)
     VALUES ($1, 'draft', $2::jsonb, 'internal: client is slow to pay', $3) RETURNING id`,
    [proposalId, JSON.stringify(selections), EMAIL('client')]
  );
  ids.plans.push(r.rows[0].id);
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/drink-plans', require('./drinkPlans'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    return res.status(500).json({ error: 'Internal error' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });

  adminToken = await makeUser('admin', 'admin');
  staffToken = await makeUser('staff', 'staff');
  const c = await pool.query(`INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550000') RETURNING id`,
    [`DayOf ${NONCE}`, EMAIL('client')]);
  ids.clients.push(c.rows[0].id);

  withContact = await seedProposal();
  withoutContact = await seedProposal();
  blankName = await seedProposal();
  noPlan = await seedProposal();
  await seedPlan(withContact, {
    logistics: {
      dayOfContact: { name: ' Marcus Keller ', phone: '(312) 555-0142' },
      accessNotes: 'gate code 4471, loading dock on the alley',
      parking: 'street',
    },
    menuStyle: 'house',
  });
  await seedPlan(withoutContact, { logistics: { accessNotes: 'side door' } });
  await seedPlan(blankName, { logistics: { dayOfContact: { name: '   ', phone: '3125550142' } } });
});

after(async () => {
  await pool.query('DELETE FROM drink_plans WHERE id = ANY($1::int[])', [ids.plans]);
  await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids.proposals]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [ids.clients]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids.users]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('the projection returns the name and the phone, and NOTHING else', async () => {
  const r = await get(`/api/drink-plans/by-proposal/${withContact}?fields=day_of_contact`, adminToken);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { day_of_contact: { name: 'Marcus Keller', phone: '(312) 555-0142' } });
  const wire = JSON.stringify(r.body);
  for (const secret of ['4471', 'loading dock', 'slow to pay', 'token', 'selections', EMAIL('client')]) {
    assert.equal(wire.includes(secret), false, `the projection leaked ${secret}`);
  }
});

test('a plan with no day-of contact, or a blank name, answers null', async () => {
  const a = await get(`/api/drink-plans/by-proposal/${withoutContact}?fields=day_of_contact`, adminToken);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, { day_of_contact: null });
  const b = await get(`/api/drink-plans/by-proposal/${blankName}?fields=day_of_contact`, adminToken);
  assert.deepEqual(b.body, { day_of_contact: null });
});

test('no drink plan is a 404, as on the full read', async () => {
  const r = await get(`/api/drink-plans/by-proposal/${noPlan}?fields=day_of_contact`, adminToken);
  assert.equal(r.status, 404);
  assert.equal((await get(`/api/drink-plans/by-proposal/${noPlan}`, adminToken)).status, 404);
});

test('an unknown projection and a malformed id are 400, never 500', async () => {
  assert.equal((await get(`/api/drink-plans/by-proposal/${withContact}?fields=all`, adminToken)).status, 400);
  assert.equal((await get(`/api/drink-plans/by-proposal/${withContact}?fields=`, adminToken)).status, 400);
  assert.equal((await get(`/api/drink-plans/by-proposal/${withContact}?fields=day_of_contact&fields=token`, adminToken)).status, 400);
  for (const bad of ['abc', '0', '1.5', '99999999999']) {
    assert.equal((await get(`/api/drink-plans/by-proposal/${bad}?fields=day_of_contact`, adminToken)).status, 400, bad);
  }
});

test('the full read is unchanged: the desktop still gets the whole plan', async () => {
  const r = await get(`/api/drink-plans/by-proposal/${withContact}`, adminToken);
  assert.equal(r.status, 200);
  for (const k of ['id', 'token', 'proposal_id', 'selections', 'status', 'admin_notes', 'has_shopping_list', 'extras_unpaid_cents']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r.body, k), `the full read lost ${k}`);
  }
  assert.equal(r.body.selections.logistics.accessNotes, 'gate code 4471, loading dock on the alley');
  assert.equal(Object.prototype.hasOwnProperty.call(r.body, 'day_of_contact'), false);
});

test('staff cannot read either form', async () => {
  assert.equal((await get(`/api/drink-plans/by-proposal/${withContact}?fields=day_of_contact`, staffToken)).status, 403);
  assert.equal((await get(`/api/drink-plans/by-proposal/${withContact}`, staffToken)).status, 403);
  assert.equal((await get(`/api/drink-plans/by-proposal/${withContact}?fields=day_of_contact`)).status, 401);
});
