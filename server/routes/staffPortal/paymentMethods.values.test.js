require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';
// No .env on a gate or audit box: the real auth middleware still verifies a
// token, so the secret falls back to a fixed test value when none is set.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'payment-method-values-test';

/**
 * One allowed set and one eligibility rule for preferred_payment_method, in
 * every writer (audit 2026-11-05, POUT-10).
 *
 * Three writers carried their own lists: me.js had no zelle, the staff
 * portal's PUT had no other, admin/users.js validated nothing, and only the
 * staff portal's PUT checked that the chosen method had something to pay to,
 * so PATCH /api/me/tip-page stored direct_deposit with no bank numbers on
 * file and the admin's Pay panel opened on it with nothing to pay to. Every
 * writer now validates against PAYMENT_METHOD_VALUES (the set the Pay panel
 * mirrors) and refuses a CHANGED method that isPreferredEligible rejects.
 *
 * Harness: the real routers and the real auth middleware over node:http, with
 * pool.query and pool.connect replaced by an in-memory stub keyed on the SQL
 * text (the stripePayoutSync.unconfigured.test.js pattern), recording writes
 * instead of executing them. No database.
 *
 * Run: node --test server/routes/staffPortal/paymentMethods.values.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { PAYMENT_METHOD_VALUES, isPreferredEligible } = require('./paymentMethods');
const meRouter = require('../me');
const contractorTipPageRouter = require('../admin/contractorTipPage');
const payrollRouter = require('../admin/payroll');
const usersRouter = require('../admin/users');

if (process.env.NODE_ENV === 'production') {
  throw new Error('paymentMethods.values.test.js refuses to run against production');
}

const STAFF_ID = 601;
const ADMIN_ID = 602;
const ROLES = { [STAFF_ID]: 'staff', [ADMIN_ID]: 'admin' };

let server, baseUrl;
const realQuery = pool.query;
const realConnect = pool.connect;
let paymentRow;   // the subject's payment_profiles row
let writes;       // every INSERT/UPDATE issued

function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (sql.startsWith('SELECT id, email, role, onboarding_status')) {
    const role = ROLES[params[0]];
    if (!role) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        id: params[0], email: `user${params[0]}@example.com`, role, onboarding_status: 'approved',
        can_hire: false, can_staff: false, token_version: 0, pre_hired: false, presence_lead_rank: null,
      }],
      rowCount: 1,
    };
  }
  if (sql === 'SELECT role FROM users WHERE id = $1') return { rows: [{ role: 'staff' }], rowCount: 1 };
  if (sql.startsWith('SELECT preferred_payment_method, venmo_handle, cashapp_handle, paypal_url, zelle_handle')) {
    return { rows: [paymentRow], rowCount: 1 };
  }
  if (sql.startsWith('SELECT preferred_name FROM contractor_profiles')) {
    return { rows: [{ preferred_name: 'Old Name' }], rowCount: 1 };
  }
  if (/^(INSERT|UPDATE) /.test(sql)) {
    writes.push({ sql, params });
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

function tokenFor(id) {
  return jwt.sign({ userId: id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${token}`,
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = d ? JSON.parse(d) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: j, raw: d });
      });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

before(async () => {
  pool.query = (text, params) => Promise.resolve(answer(text, params));
  pool.connect = () => Promise.resolve({
    query: (text, params) => Promise.resolve(answer(text, params)),
    release: () => {},
  });
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/me', meRouter);
  app.use('/api/admin', contractorTipPageRouter);
  app.use('/api/admin', payrollRouter);
  app.use('/api/admin', usersRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    console.error('[payment-method-values harness] unhandled:', err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  writes = [];
  // A zelle handle on file, no bank numbers, no preferred method yet.
  paymentRow = {
    preferred_payment_method: null, venmo_handle: null, cashapp_handle: null, paypal_url: null,
    zelle_handle: 'staffer@example.com', routing_number: null, account_number: null,
  };
});

after(async () => {
  pool.query = realQuery;
  pool.connect = realConnect;
  if (server) await new Promise((r) => server.close(r));
});

const paymentWrites = () => writes.filter((w) => w.sql.includes('payment_profiles'));

test('the shared set is the seven methods the Pay panel mirrors, and the eligibility rule covers all of them', () => {
  assert.deepEqual([...PAYMENT_METHOD_VALUES].sort(),
    ['cashapp', 'check', 'direct_deposit', 'other', 'paypal', 'venmo', 'zelle']);
  assert.equal(isPreferredEligible('other', {}), true, 'paid by hand: nothing to have on file');
  assert.equal(isPreferredEligible('check', {}), true);
  assert.equal(isPreferredEligible('direct_deposit', { routing_number: 'enc:x' }), false, 'both bank numbers or neither');
  assert.equal(isPreferredEligible('zelle', { zelle_handle: 'a@example.com' }), true);
  assert.equal(isPreferredEligible('vemno', {}), false);
});

test('PATCH /api/me/tip-page refuses a method outside the set', async () => {
  const r = await req('PATCH', '/api/me/tip-page', tokenFor(STAFF_ID), { preferred_payment_method: 'vemno' });
  assert.equal(r.status, 400, r.raw);
  assert.deepEqual(paymentWrites(), []);
});

test('PATCH /api/me/tip-page refuses direct_deposit with no bank numbers on file', async () => {
  const r = await req('PATCH', '/api/me/tip-page', tokenFor(STAFF_ID), { preferred_payment_method: 'direct_deposit' });
  assert.equal(r.status, 400, r.raw);
  assert.ok(r.body.fieldErrors && r.body.fieldErrors.preferred_payment_method, 'keyed to the field');
  assert.deepEqual(paymentWrites(), [], 'nothing stored');
});

test('PATCH /api/me/tip-page accepts zelle (now in the set) when its handle is on file, and a handle saved in the same request counts', async () => {
  const zelle = await req('PATCH', '/api/me/tip-page', tokenFor(STAFF_ID), { preferred_payment_method: 'zelle' });
  assert.equal(zelle.status, 200, zelle.raw);
  assert.equal(paymentWrites().length, 1);
  writes = [];
  const withHandle = await req('PATCH', '/api/me/tip-page', tokenFor(STAFF_ID),
    { venmo_handle: '@sam-tips', preferred_payment_method: 'venmo' });
  assert.equal(withHandle.status, 200, withHandle.raw);
  assert.equal(paymentWrites().length, 1);
});

// A stored or resent method is never a 400 on its own account, but it is never
// stored unpayable either: when the row as it will be after this write cannot
// pay it, it is cleared to NULL and the response says so (L1 of the verify
// pass; the staff portal PATCH's own rule).
test('PATCH /api/me/tip-page clears, and reports, a resent stored method the row can no longer pay', async () => {
  paymentRow.preferred_payment_method = 'direct_deposit'; // stored before the rule, no bank data
  const r = await req('PATCH', '/api/me/tip-page', tokenFor(STAFF_ID),
    { venmo_handle: '@sam-tips', preferred_payment_method: 'direct_deposit' });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.preferred_cleared, true);
  const upsert = paymentWrites()[0];
  assert.ok(upsert.sql.includes('preferred_payment_method'), 'the method column is written');
  assert.equal(upsert.params[upsert.params.length - 1], null, 'written as NULL, never as direct_deposit');
});

test('PATCH /api/me/tip-page clears a resent venmo when its handle is cleared in the same request', async () => {
  paymentRow.venmo_handle = 'sam-tips';
  paymentRow.preferred_payment_method = 'venmo';
  const r = await req('PATCH', '/api/me/tip-page', tokenFor(STAFF_ID),
    { venmo_handle: '', preferred_payment_method: 'venmo' });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.preferred_cleared, true);
  const upsert = paymentWrites()[0];
  assert.ok(upsert.sql.includes('venmo_handle') && upsert.sql.includes('preferred_payment_method'));
  assert.deepEqual(upsert.params.slice(1), [null, null], 'the handle and the method both go to NULL');
});

test('PATCH /api/me/tip-page clears the stored method when the handle it depends on is cleared alone', async () => {
  paymentRow.venmo_handle = 'sam-tips';
  paymentRow.preferred_payment_method = 'venmo';
  const r = await req('PATCH', '/api/me/tip-page', tokenFor(STAFF_ID), { venmo_handle: '' });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.preferred_cleared, true);
  const upsert = paymentWrites()[0];
  assert.ok(upsert.sql.includes('preferred_payment_method'), 'the method is cleared with the handle');
  assert.deepEqual(upsert.params.slice(1), [null, null]);
});

test('PATCH /api/me/tip-page leaves a payable stored method alone when another handle is cleared', async () => {
  paymentRow.venmo_handle = 'sam-tips';
  paymentRow.preferred_payment_method = 'venmo';
  const r = await req('PATCH', '/api/me/tip-page', tokenFor(STAFF_ID), { cashapp_handle: '' });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.preferred_cleared, false);
  const upsert = paymentWrites()[0];
  assert.ok(!upsert.sql.includes('preferred_payment_method'), 'the method column is not touched');
});

test('PATCH /api/admin/contractors/:id/tip-page refuses a method outside the set and an unpayable new election', async () => {
  const bad = await req('PATCH', `/api/admin/contractors/${STAFF_ID}/tip-page`, tokenFor(ADMIN_ID), { preferred_payment_method: 'vemno' });
  assert.equal(bad.status, 400, bad.raw);
  const dd = await req('PATCH', `/api/admin/contractors/${STAFF_ID}/tip-page`, tokenFor(ADMIN_ID), { preferred_payment_method: 'direct_deposit' });
  assert.equal(dd.status, 400, dd.raw);
  assert.deepEqual(paymentWrites(), []);
  const ok = await req('PATCH', `/api/admin/contractors/${STAFF_ID}/tip-page`, tokenFor(ADMIN_ID), { preferred_payment_method: 'zelle' });
  assert.equal(ok.status, 200, ok.raw);
});

test('POST /api/admin/payroll/payouts/:id/mark-paid refuses a method outside the shared set before any query', async () => {
  const r = await req('POST', '/api/admin/payroll/payouts/1/mark-paid', tokenFor(ADMIN_ID),
    { payment_method: 'vemno', payment_handle: 'x', expected_total_cents: 100 });
  assert.equal(r.status, 400, r.raw);
  assert.deepEqual(writes, []);
});

test('PUT /api/admin/users/:id/profile refuses a method outside the set and an unpayable new election, keyed to the field', async () => {
  const bad = await req('PUT', `/api/admin/users/${STAFF_ID}/profile`, tokenFor(ADMIN_ID), { preferred_payment_method: 'vemno' });
  assert.equal(bad.status, 400, bad.raw);
  assert.ok(bad.body.fieldErrors.preferred_payment_method);
  const dd = await req('PUT', `/api/admin/users/${STAFF_ID}/profile`, tokenFor(ADMIN_ID), { preferred_payment_method: 'direct_deposit' });
  assert.equal(dd.status, 400, dd.raw);
  assert.ok(dd.body.fieldErrors.preferred_payment_method);
  assert.deepEqual(writes, [], 'nothing written on a refused save');
});

// The profile upsert's params: user_id, preferred_payment_method, payment_username,
// routing_number, account_number, keep routing, keep account.
const profileUpsert = () => writes.find((w) => w.sql.includes('INSERT INTO payment_profiles'));

test('PUT /api/admin/users/:id/profile accepts a payable election, and clears, reporting it, a resent one the row can no longer pay', async () => {
  const zelle = await req('PUT', `/api/admin/users/${STAFF_ID}/profile`, tokenFor(ADMIN_ID), { preferred_payment_method: 'zelle' });
  assert.equal(zelle.status, 200, zelle.raw);
  assert.equal(zelle.body.preferred_cleared, false);
  assert.equal(profileUpsert().params[1], 'zelle');
  writes = [];
  paymentRow.preferred_payment_method = 'direct_deposit'; // stored before the rule, no bank data
  const resend = await req('PUT', `/api/admin/users/${STAFF_ID}/profile`, tokenFor(ADMIN_ID), { preferred_payment_method: 'direct_deposit' });
  assert.equal(resend.status, 200, resend.raw, 'a resend never blocks the save');
  assert.equal(resend.body.preferred_cleared, true, 'but the unpayable method is not kept');
  assert.equal(profileUpsert().params[1], null, 'stored as NULL, never as direct_deposit');
});

// L1 of the verify pass: direct_deposit resent beside blanked bank numbers used
// to be stored with NULL numbers, because the rule only ran when the method
// changed. Eligibility now reads the row as it will be after the write.
test('PUT /api/admin/users/:id/profile clears a resent direct_deposit when the bank numbers are blanked in the same save', async () => {
  paymentRow.preferred_payment_method = 'direct_deposit';
  paymentRow.routing_number = 'enc:routing';
  paymentRow.account_number = 'enc:account';
  const r = await req('PUT', `/api/admin/users/${STAFF_ID}/profile`, tokenFor(ADMIN_ID),
    { preferred_payment_method: 'direct_deposit', routing_number: '', account_number: '' });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.preferred_cleared, true);
  const up = profileUpsert();
  assert.equal(up.params[1], null, 'the method goes to NULL with the numbers');
  assert.equal(up.params[3], null, 'routing cleared');
  assert.equal(up.params[4], null, 'account cleared');
  assert.equal(up.params[5], false, 'not kept');
  assert.equal(up.params[6], false, 'not kept');
});
