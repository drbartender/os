// Admin invoice POST and PATCH: the label is a money key and the figures are
// money (audit PAY-08, 2026-11-05).
//
// THE DEFECT. Every money seam dispatches on the invoice label (the Balance
// refresh rewrites a 'Balance' invoice's amount_due from the total; the
// cancellation retainer reads 'Deposit'; the refund scope, the fee netting
// and the delta cancel read the label sets), but the admin routes fenced only
// the off-ledger label: an admin could mint or rename an invoice into
// 'Balance' (the next reprice then rewrote its demand and createBalanceInvoice
// never minted the real one), rename the paid Deposit away (the retainer then
// read 0 and a client cancel refunded it), create an invoice at 1e308 (a 500
// on the INTEGER column) or write a negative line the public page printed,
// and the lines never had to sum to the amount. The routes now refuse every
// system label on a minted or renamed invoice and any rename of a
// system-labelled invoice, validate the amount and each line as finite money
// under a cap, and derive amount_due from the lines when lines are given
// (refusing an amount that disagrees).
//
// PURE: the pool is stubbed on the shared pool object (the auth lookup and the
// PATCH's existing-row read); the refusals all land before any write.
//
//   node --test server/routes/invoices.labelGuard.test.js
process.env.SEND_NOTIFICATIONS = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'invoice-label-guard-test-secret';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const invoicesRouter = require('./invoices');

const ADMIN = { id: 9001, email: 'invoice-labels@example.com', role: 'admin', onboarding_status: 'approved', token_version: 0, presence_lead_rank: null };
let existing; // the PATCH target: { locked, amount_paid, label, proposal_id }
const writes = [];
let server, baseUrl, realQuery, realConnect;

before(async () => {
  realQuery = pool.query; realConnect = pool.connect;
  pool.query = async function stubbed(text, params) {
    if (/FROM users WHERE id = \$1/.test(text)) return { rows: [ADMIN], rowCount: 1 };
    if (/SELECT locked, amount_paid, label, proposal_id FROM invoices WHERE id = \$1/.test(text)) return { rows: [existing], rowCount: 1 };
    if (/^\s*UPDATE invoices/.test(text)) { writes.push({ text, params }); return { rows: [{ id: params[params.length - 1], ...existing }], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };
  pool.connect = async () => ({
    release() {},
    async query(text, params) {
      writes.push({ text, params });
      if (/SELECT id FROM proposals WHERE id = \$1/.test(text)) return { rows: [{ id: 4242 }], rowCount: 1 };
      if (/nextval/.test(text)) return { rows: [{ val: 77 }], rowCount: 1 };
      if (/INSERT INTO invoices/.test(text)) return { rows: [{ id: 77, proposal_id: 4242, label: params[2], amount_due: params[3], status: 'draft' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  pool.query = realQuery; pool.connect = realConnect;
  if (server) await new Promise((r) => server.close(r));
});
beforeEach(() => { writes.length = 0; existing = { locked: false, amount_paid: 0, label: 'Damage fee', proposal_id: 4242 }; });

function send(method, path, body) {
  const payload = JSON.stringify(body);
  const token = jwt.sign({ userId: ADMIN.id, tokenVersion: 0 }, process.env.JWT_SECRET);
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${token}` } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject); r.write(payload); r.end();
  });
}
const inserted = () => writes.filter((w) => /INSERT INTO invoices/.test(w.text));

test('POST refuses every system label (contract, total-tracking, in-total-price, delta, extras, off-ledger), case-insensitively', async () => {
  for (const label of ['Balance', 'Deposit', 'Full Payment', 'Additional Services', 'Enhancement Lab', 'Drink Plan Extras', 'Service Extension', 'balance', ' DEPOSIT ']) {
    const r = await send('POST', '/api/invoices/proposal/4242', { label, amount: 250 });
    assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.fieldErrors && r.body.fieldErrors.label, `${label}: a label field error`);
  }
  assert.equal(inserted().length, 0, 'nothing minted');
});

test('POST still mints a free-text manual invoice, at the amount in cents', async () => {
  const r = await send('POST', '/api/invoices/proposal/4242', { label: 'Damage fee', amount: 250 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(inserted().length, 1);
  assert.equal(inserted()[0].params[3], 25000);
});

test('POST refuses an amount that is not finite money, or over the cap', async () => {
  for (const amount of [Infinity, 1e308, -5, 0, NaN, '250', 1000001]) {
    const r = await send('POST', '/api/invoices/proposal/4242', { label: 'Damage fee', amount });
    assert.equal(r.status, 400, `${String(amount)}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.fieldErrors && r.body.fieldErrors.amount, `${String(amount)}: an amount field error`);
  }
  assert.equal(inserted().length, 0);
});

test('POST refuses a negative, non-finite or over-cap line, and a fractional quantity', async () => {
  for (const line of [{ amount: -50 }, { amount: Infinity }, { amount: 1000001 }, { amount: 10, quantity: 1.5 }, { amount: 10, quantity: 0 }]) {
    const r = await send('POST', '/api/invoices/proposal/4242', { label: 'Damage fee', amount: 10, line_items: [{ description: 'x', quantity: 1, ...line }] });
    assert.equal(r.status, 400, `${JSON.stringify(line)}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.fieldErrors && r.body.fieldErrors.line_items, `${JSON.stringify(line)}: a line_items field error`);
  }
  assert.equal(inserted().length, 0);
});

test('POST derives amount_due from the lines and refuses an amount that disagrees with them', async () => {
  const lines = [{ description: 'Broken glassware', quantity: 4, amount: 12.5 }, { description: 'Cleaning', quantity: 1, amount: 75 }];
  const agree = await send('POST', '/api/invoices/proposal/4242', { label: 'Damage fee', amount: 125, line_items: lines });
  assert.equal(agree.status, 201, JSON.stringify(agree.body));
  assert.equal(inserted()[0].params[3], 12500, 'the lines sum');
  writes.length = 0;
  const alone = await send('POST', '/api/invoices/proposal/4242', { label: 'Damage fee', line_items: lines });
  assert.equal(alone.status, 201, JSON.stringify(alone.body));
  assert.equal(inserted()[0].params[3], 12500, 'lines alone set the amount');
  writes.length = 0;
  const disagree = await send('POST', '/api/invoices/proposal/4242', { label: 'Damage fee', amount: 200, line_items: lines });
  assert.equal(disagree.status, 400, JSON.stringify(disagree.body));
  assert.ok(disagree.body.fieldErrors.amount);
  assert.equal(inserted().length, 0);
});

test('PATCH refuses renaming an ordinary invoice INTO a system label', async () => {
  for (const label of ['Balance', 'Deposit', 'Full Payment', 'Drink Plan Extras', 'Additional Services']) {
    const r = await send('PATCH', '/api/invoices/77', { label });
    assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
  }
  assert.equal(writes.filter((w) => /UPDATE invoices/.test(w.text)).length, 0);
});

test('PATCH refuses renaming a system-labelled invoice at all (the paid Deposit is the retainer)', async () => {
  for (const label of ['Deposit', 'Balance', 'Full Payment', 'Additional Services', 'Enhancement Lab', 'Drink Plan Extras']) {
    existing = { locked: false, amount_paid: 10000, label, proposal_id: 4242 };
    const r = await send('PATCH', '/api/invoices/77', { label: 'Paid deposit' });
    assert.equal(r.status, 409, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'SYSTEM_LABEL_LOCKED');
  }
  assert.equal(writes.filter((w) => /UPDATE invoices/.test(w.text)).length, 0);
});

test('PATCH still renames a manual invoice to another free-text label, and still voids it', async () => {
  const r = await send('PATCH', '/api/invoices/77', { label: 'Breakage fee' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(writes.filter((w) => /UPDATE invoices/.test(w.text)).length, 1);
  writes.length = 0;
  const v = await send('PATCH', '/api/invoices/77', { status: 'void' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
});
