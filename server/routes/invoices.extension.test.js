require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// Task 8: the public invoice GET's `extension` block + the off-ledger label
// guard on admin invoice create/rename.
//
//   - GET /api/invoices/t/:token returns `extension` nested INSIDE the invoice
//     object (Task 15's client reads data.invoice and nothing else; the shape
//     guard below is the explicit regression test for that contract).
//   - The block is null for every ordinary invoice, so Deposit/Balance links
//     already in client inboxes are byte-unaffected.
//   - An unknown terms_version degrades to terms: null (pay stays disabled),
//     never a 500 on a client's payment page.
//   - POST /api/invoices/proposal/:proposalId and PATCH /:id REFUSE any label
//     in OFF_LEDGER_INVOICE_LABELS: the webhook keys its amount_paid roll-up
//     skip on the label alone, so minting or renaming an invoice INTO
//     'Service Extension' would silently take its money off-ledger.
//
// publicLimiter budget: 20 requests / 15 min / IP with no test skip. This suite
// makes 5 public GETs; the label-guard requests are auth'd admin routes and do
// not count.

// Belt-and-braces stub (plan instruction): invoices.js does not require the
// notify module today, but stubbing before the router loads keeps this suite
// send-proof if a transitive import ever changes.
const notify = require('../utils/serviceExtensionNotify');
notify.notifyClientOfRequest = async () => ({ sms: 'sent', email: 'sent', reachable: true });
notify.alertAdminsRequestSent = async () => {};
notify.alertAdminsProblem = async () => {};
notify.notifyStaffOfOutcome = async () => ({ notified: [], unreachable: [] });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { CURRENT_EXTENSION_TERMS_VERSION } = require('../data/extensionTermsCopy');
const invoicesRouter = require('./invoices');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoices.extension.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminToken, adminUserId;
const proposalIds = [];
const clientIds = [];

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
                   ...(buf ? { 'Content-Type': 'application/json', 'Content-Length': buf.length } : {}) } },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j, raw: d }); }); }
    );
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

async function seedProposal() {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Ext Invoice GET', $1) RETURNING id`,
    [`ext-inv-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, event_type, pricing_snapshot)
     VALUES ($1, 'deposit_paid', 1000, 100, 'wedding', '{}'::jsonb) RETURNING id`,
    [c.rows[0].id]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

async function seedInvoice(proposalId, { label = 'Balance', status = 'sent', amountDue = 20000 } = {}) {
  const token = crypto.randomUUID();
  const r = await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, $4, $5, 0, $6) RETURNING id`,
    [proposalId, token, `INV${crypto.randomBytes(5).toString('hex')}`, label, amountDue, status]
  );
  return { id: r.rows[0].id, token };
}

async function seedLineItem(invoiceId, { description = 'Bar service', lineTotal = 20000 } = {}) {
  await pool.query(
    `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, line_total, source_type)
     VALUES ($1, $2, 1, $3, $3, 'manual')`,
    [invoiceId, description, lineTotal]
  );
}

async function seedExtension(proposalId, invoiceId, {
  amountCents = 5000,
  termsVersion = CURRENT_EXTENSION_TERMS_VERSION,
  expiresAt = new Date(Date.now() + 2 * 3600 * 1000),
} = {}) {
  const r = await pool.query(
    `INSERT INTO service_extensions
       (proposal_id, invoice_id, contracted_end_time, requested_end_time,
        contracted_duration_hours, requested_duration_hours,
        amount_cents, gratuity_cents, terms_version, status, expires_at)
     VALUES ($1, $2, '10:00 PM', '11:00 PM', 4.0, 5.0, $3, 0, $4, 'pending', $5)
     RETURNING id`,
    [proposalId, invoiceId, amountCents, termsVersion, expiresAt]
  );
  return r.rows[0].id;
}

const getInvoice = (token) => request('GET', `/api/invoices/t/${token}`);

before(async () => {
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id`,
    [`ext-inv-admin-${NONCE}@example.com`, await bcrypt.hash('x', 4)]
  );
  adminUserId = admin.rows[0].id;
  adminToken = jwt.sign({ userId: adminUserId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  // Mirror the production error middleware (inline in server/index.js); the
  // field-error key is fieldErrors (invoices.extrasVoid.test.js precedent).
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const b = { error: err.message, code: err.code };
      if (err.fieldErrors) b.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(b);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => {
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM service_extensions WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  if (adminUserId) await pool.query('DELETE FROM users WHERE id = $1', [adminUserId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// Shared across tests 2, 3 and 5: one extension invoice, driven through
// acceptance in test 3.
let extToken, extExtensionId;

test('an ordinary Balance invoice returns invoice.extension === null and is otherwise unchanged', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p, { label: 'Balance', amountDue: 20000 });
  await seedLineItem(inv.id);

  const r = await getInvoice(inv.token);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${r.raw}`);
  assert.equal(r.body.invoice.extension, null, 'ordinary invoices carry extension === null');
  assert.equal(r.body.invoice.amount_due, 20000, 'amount_due still present');
  assert.ok(Array.isArray(r.body.invoice.line_items), 'line_items array still present');
  assert.equal(r.body.invoice.line_items.length, 1);
});

test('an extension invoice returns the terms block with the requested end time', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p, { label: 'Service Extension', amountDue: 5000 });
  extToken = inv.token;
  extExtensionId = await seedExtension(p, inv.id, { amountCents: 5000 });

  const r = await getInvoice(extToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${r.raw}`);
  const ext = r.body.invoice.extension;
  assert.ok(ext, 'extension block present');
  assert.equal(ext.is_extension, true);
  assert.ok(ext.terms, 'terms rendered for a known version');
  assert.ok(ext.terms.headline.includes('11:00 PM'), `headline carries the requested end time: ${ext.terms.headline}`);
  assert.equal(ext.terms.version, CURRENT_EXTENSION_TERMS_VERSION);
  assert.equal(ext.requires_acceptance, true, 'unaccepted extension requires acceptance');
  assert.equal(ext.requires_payment, true, 'priced extension requires payment');
});

test('after acceptance the same GET reports requires_acceptance false and a non-null accepted_at', async () => {
  // Stamp acceptance directly: client_accepted_at is the exact predicate this
  // block reads. The accept ROUTE is driven end to end in publicAccept.test.js.
  await pool.query('UPDATE service_extensions SET client_accepted_at = NOW() WHERE id = $1', [extExtensionId]);

  const r = await getInvoice(extToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${r.raw}`);
  const ext = r.body.invoice.extension;
  assert.equal(ext.requires_acceptance, false, 'acceptance recorded');
  assert.ok(ext.accepted_at, 'accepted_at returned');
});

test('an unknown terms_version returns terms: null and a 200, never a 500', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p, { label: 'Service Extension', amountDue: 5000 });
  await seedExtension(p, inv.id, { termsVersion: 'bogus' });

  const r = await getInvoice(inv.token);
  assert.equal(r.status, 200, `an unknown terms version must not 500 a payment page: ${r.status} ${r.raw}`);
  const ext = r.body.invoice.extension;
  assert.ok(ext, 'extension block still present');
  assert.equal(ext.terms, null, 'terms degrade to null on an unknown version');
  assert.equal(ext.requires_acceptance, true, 'pay stays gated with no terms to show');
});

test('shape guard: extension lives INSIDE invoice, never top-level', async () => {
  // The explicit regression test for the server/client shape mismatch: a first
  // draft put extension inside invoice on the server while the client read
  // res.data.extension, so the terms block never rendered and the payment gate
  // was permanently open, while every server test passed.
  const r = await getInvoice(extToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${r.raw}`);
  assert.equal(r.body.extension, undefined, 'no top-level extension key');
  assert.notEqual(r.body.invoice.extension, undefined, 'extension is inside invoice');
});

test('label guard: minting or renaming INTO an off-ledger label is refused, ordinary labels still work', async () => {
  const p = await seedProposal();

  // Minting INTO the off-ledger label is refused, and nothing is created.
  const mint = await request('POST', `/api/invoices/proposal/${p}`, {
    token: adminToken,
    body: { label: 'Service Extension', amount: 50 },
  });
  assert.equal(mint.status, 400, `expected 400, got ${mint.status} ${mint.raw}`);
  assert.ok(mint.body.fieldErrors?.label, 'the label field carries the error');
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM invoices WHERE proposal_id = $1', [p]);
  assert.equal(count.rows[0].n, 0, 'no invoice row minted on refusal');

  // An ordinary label still creates fine.
  const ok = await request('POST', `/api/invoices/proposal/${p}`, {
    token: adminToken,
    body: { label: 'Setup Fee', amount: 50 },
  });
  assert.equal(ok.status, 201, `expected 201, got ${ok.status} ${ok.raw}`);
  assert.equal(ok.body.invoice.label, 'Setup Fee');
  const invoiceId = ok.body.invoice.id;

  // Renaming INTO the off-ledger label is refused...
  const rename = await request('PATCH', `/api/invoices/${invoiceId}`, {
    token: adminToken,
    body: { label: 'Service Extension' },
  });
  assert.equal(rename.status, 400, `expected 400, got ${rename.status} ${rename.raw}`);
  assert.ok(rename.body.fieldErrors?.label, 'the label field carries the error');
  const still = await pool.query('SELECT label FROM invoices WHERE id = $1', [invoiceId]);
  assert.equal(still.rows[0].label, 'Setup Fee', 'label unchanged after refusal');

  // ...but an ordinary rename still works.
  const rename2 = await request('PATCH', `/api/invoices/${invoiceId}`, {
    token: adminToken,
    body: { label: 'Rental Fee' },
  });
  assert.equal(rename2.status, 200, `expected 200, got ${rename2.status} ${rename2.raw}`);
  assert.equal(rename2.body.invoice.label, 'Rental Fee');
});

test('label guard, symmetric: renaming OUT of an off-ledger label is refused', async () => {
  // Merge-gate finding: the webhook keys the amount_paid roll-up SKIP on the
  // label alone while the settle keys on invoice_id, so renaming an extension
  // invoice to an ordinary label and paying it would count the money twice.
  const p = await seedProposal();
  const inv = await seedInvoice(p, { label: 'Service Extension', amountDue: 5000 });
  const rename = await request('PATCH', `/api/invoices/${inv.id}`, {
    token: adminToken,
    body: { label: 'Balance' },
  });
  assert.equal(rename.status, 409, `expected 409, got ${rename.status} ${rename.raw}`);
  assert.equal(rename.body.code, 'OFF_LEDGER_LABEL_LOCKED');
  const still = await pool.query('SELECT label FROM invoices WHERE id = $1', [inv.id]);
  assert.equal(still.rows[0].label, 'Service Extension', 'label unchanged after refusal');
});
