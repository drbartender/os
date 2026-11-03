require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { encrypt, decrypt } = require('../../utils/encryption');
const usersRouter = require('./users');

if (process.env.NODE_ENV === 'production') {
  throw new Error('users.bankMask.test.js refuses to run against production');
}

// Published routing numbers, made-up account numbers, a 555 phone; no person's data.
const ROUTING = '011000015';
const ACCOUNT = '000123456';
const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminId, adminToken, subjectId;

function put(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request(`${baseUrl}${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

async function stored() {
  const { rows } = await pool.query('SELECT routing_number, account_number FROM payment_profiles WHERE user_id = $1', [subjectId]);
  const r = rows[0] || {};
  return {
    routing: r.routing_number ? decrypt(r.routing_number) : null,
    account: r.account_number ? decrypt(r.account_number) : null,
  };
}

async function resetBank() {
  await pool.query(
    'UPDATE payment_profiles SET routing_number = $2, account_number = $3 WHERE user_id = $1',
    [subjectId, encrypt(ROUTING), encrypt(ACCOUNT)]
  );
}

// What the admin page sends: its whole edit form, seeded from GET, with the bank
// fields as the masked display values unless the admin typed over them.
function form(overrides) {
  return {
    phone: '(312) 555-0100',
    preferred_payment_method: 'direct_deposit',
    routing_number: '****0015',
    account_number: '****3456',
    ...overrides,
  };
}

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`,
    [`bank-mask-admin-${NONCE}@example.com`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);
  const s = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
    [`bank-mask-subject-${NONCE}@example.com`]
  );
  subjectId = s.rows[0].id;
  await pool.query('INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)', [subjectId, 'Test Subject']);
  await pool.query(
    `INSERT INTO payment_profiles (user_id, preferred_payment_method, routing_number, account_number)
     VALUES ($1, 'direct_deposit', $2, $3)`,
    [subjectId, encrypt(ROUTING), encrypt(ACCOUNT)]
  );

  const app = express();
  app.use(express.json());
  app.use('/api/admin', usersRouter);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, fieldErrors: err.fieldErrors });
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (subjectId) {
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [subjectId]);
    await pool.query('DELETE FROM payment_profiles WHERE user_id = $1', [subjectId]);
  }
  for (const id of [adminId, subjectId].filter(Boolean)) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await pool.end();
});

test('saving a phone change with the masked values keeps the real bank numbers', async () => {
  await resetBank();
  const res = await put(`/api/admin/users/${subjectId}/profile`, form({ phone: '(312) 555-0199' }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await stored(), { routing: ROUTING, account: ACCOUNT });
  // And the response still shows them masked, never in full.
  assert.equal(res.body.payment.routing_number, '****0015');
});

test('new valid numbers typed over the masks replace the old', async () => {
  await resetBank();
  const res = await put(`/api/admin/users/${subjectId}/profile`, form({ routing_number: '021000021', account_number: '987650001' }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await stored(), { routing: '021000021', account: '987650001' });
});

test('an invalid account number is refused and nothing changes', async () => {
  await resetBank();
  const phoneOf = async () => (await pool.query('SELECT phone FROM contractor_profiles WHERE user_id = $1', [subjectId])).rows[0].phone;
  const phoneBefore = await phoneOf();
  const res = await put(`/api/admin/users/${subjectId}/profile`, form({ account_number: '12', phone: '(312) 555-0142' }));
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors && res.body.fieldErrors.account_number, JSON.stringify(res.body));
  assert.deepEqual(await stored(), { routing: ROUTING, account: ACCOUNT });
  // The refusal came before the profile write: the phone did not change either.
  assert.equal(await phoneOf(), phoneBefore);
});

test('a legacy number stored with a dash is kept on an unrelated save', async () => {
  // Stored before any format check; the admin page shows it as four stars and its
  // last four characters, dash included, and sends that back on a phone edit.
  const LEGACY = '1234-56-78';
  await pool.query('UPDATE payment_profiles SET account_number = $2 WHERE user_id = $1', [subjectId, encrypt(LEGACY)]);
  const shown = '****' + LEGACY.slice(-4);
  const res = await put(`/api/admin/users/${subjectId}/profile`, form({ account_number: shown, phone: '(312) 555-0177' }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await stored()).account, LEGACY);
});

test('bank fields left out of the save keep numbers saved after the page opened', async () => {
  // The admin page leaves out a bank field the admin did not edit, so a staffer
  // who saved numbers after the admin opened the page keeps them.
  await resetBank();
  const body = form({ phone: '(312) 555-0166' });
  delete body.routing_number;
  delete body.account_number;
  const res = await put(`/api/admin/users/${subjectId}/profile`, body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await stored(), { routing: ROUTING, account: ACCOUNT });
});

test('blank bank fields clear the numbers, as an admin clearing them means', async () => {
  await resetBank();
  const res = await put(`/api/admin/users/${subjectId}/profile`, form({ routing_number: '', account_number: '' }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await stored(), { routing: null, account: null });
});
