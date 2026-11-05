require('dotenv').config();

// B4: comp / waive of a "Drink Plan Extras" invoice.
//   - PATCH /api/invoices/:id {status:'void'} on an extras invoice voids it,
//     logs extras_comped, and (comp mode) takes the FOLDED portion (the whole
//     invoice when any add-on or bar line folded; never a syrup-only one) off
//     proposals.total_price as a protected comp line (compLine.js, audit
//     PRC-01): the line lands in adjustments and the pricing snapshot, the
//     snapshot total moves with total_price, the add-on row stays, and a
//     re-price at the catalog afterwards lands on the comped total instead of
//     billing the add-on again; then the payment status ladder re-runs.
//   - The shared helper's path-switch mode (reconcileTotalPrice:false) voids +
//     audits but leaves total_price untouched (used by submit's add-to-balance
//     re-submit).
//   - Voiding an extras invoice with payments applied is refused (409).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const invoicesRouter = require('./invoices');
const { voidExtrasInvoiceWithReconcile } = require('../utils/invoiceHelpers');
const { calculateProposal } = require('../utils/pricingEngine');
const { computeCatalogSnapshot } = require('../utils/proposalExtrasFold');
const { COMP_LABEL } = require('../utils/adjustmentRules');

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
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch {} resolve({ status: res.statusCode, body: j, raw: d }); }); }
    );
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

// `snapshot` (an engine-shaped object) is stored as given, and as {} when
// absent: pricing_snapshot is JSONB NOT NULL DEFAULT '{}' (schema.sql), so {}
// is what a legacy row really holds. `adjustments` stays NULL when absent
// (the column is nullable). The optional pricing inputs seed a row
// computeCatalogSnapshot can re-price (it needs the whole row).
async function seedProposal({ totalPrice, snapshot = null, adjustments = null, packageId = null, guestCount = 75, hours = 4, numBars = 1, amountPaid = 100 }) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Void Test', $1) RETURNING id`,
    [`void-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, pricing_snapshot, adjustments,
                            package_id, guest_count, event_duration_hours, num_bars, num_bartenders,
                            gratuity_rate, tip_jar, event_type, event_timezone)
     VALUES ($1, 'deposit_paid', $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, NULL, 0, true, 'wedding', 'America/Chicago')
     RETURNING id`,
    [c.rows[0].id, totalPrice, amountPaid, JSON.stringify(snapshot === null ? {} : snapshot),
      adjustments === null ? null : JSON.stringify(adjustments), packageId, guestCount, hours, numBars]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

async function seedExtrasInvoice(proposalId, { amountDue, amountPaid = 0, lines }) {
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Drink Plan Extras', $3, $4, 'sent') RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`, amountDue, amountPaid]
  );
  const invoiceId = inv.rows[0].id;
  for (const l of lines) {
    await pool.query(
      `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, line_total, source_type, source_id)
       VALUES ($1, $2, 1, $3, $3, $4, $5)`,
      [invoiceId, l.description, l.line_total, l.source_type, l.source_id ?? null]
    );
  }
  return invoiceId;
}

async function totalPriceOf(proposalId) {
  const r = await pool.query('SELECT total_price FROM proposals WHERE id = $1', [proposalId]);
  return Number(r.rows[0].total_price);
}
async function rowOf(proposalId) {
  const r = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
  return r.rows[0];
}
// computeCatalogSnapshot refuses the pool: run it on a transaction client that is rolled back.
async function repriceAtCatalog(proposalId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const row = (await c.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [proposalId])).rows[0];
    return await computeCatalogSnapshot(c, row);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
async function statusOf(invoiceId) {
  const r = await pool.query('SELECT status FROM invoices WHERE id = $1', [invoiceId]);
  return r.rows[0].status;
}
async function compLog(proposalId) {
  const r = await pool.query(
    `SELECT details->>'amount_cents' AS amt, details->>'reason' AS reason, actor_type
       FROM proposal_activity_log WHERE action = 'extras_comped' AND proposal_id = $1 ORDER BY id`,
    [proposalId]
  );
  return r.rows;
}

before(async () => {
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id`,
    [`void-admin-${NONCE}@example.com`, await bcrypt.hash('x', 4)]
  );
  adminUserId = admin.rows[0].id;
  adminToken = jwt.sign({ userId: adminUserId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) { const b = { error: err.message, code: err.code }; if (err.fieldErrors) b.fieldErrors = err.fieldErrors; return res.status(err.statusCode).json(b); }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => {
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  if (adminUserId) await pool.query('DELETE FROM users WHERE id = $1', [adminUserId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('comp syrup-only: voids, total_price unchanged, logs extras_comped', async () => {
  const p = await seedProposal({ totalPrice: 1000 });
  const inv = await seedExtrasInvoice(p, { amountDue: 6000, lines: [
    { description: 'Hand-Crafted Syrups (2 bottles)', line_total: 6000, source_type: 'fee' },
  ] });
  const r = await request('PATCH', `/api/invoices/${inv}`, { token: adminToken, body: { status: 'void' } });
  assert.equal(r.status, 200, r.raw);
  assert.equal(await statusOf(inv), 'void');
  assert.equal(await totalPriceOf(p), 1000, 'syrup-only comp must not touch total_price');
  const log = await compLog(p);
  assert.equal(log.length, 1);
  assert.equal(Number(log[0].amt), 6000);
  assert.equal(log[0].actor_type, 'admin');
});

test('comp mixed add-on/bar/syrup: removes the FULL extras from total_price as a comp line the snapshot carries too', async () => {
  // A pay-now submit WITH add-ons runs calculateProposal, which folds add-ons,
  // bar AND new syrups into total_price (pricingEngine.js:366). So the whole
  // invoice must come back out on comp, not just addon+bar. Seed total_price =
  // base 1000 + the $310 extras that submit folded in, with the snapshot the
  // fold wrote (its total agrees with total_price).
  const snapshot = {
    package: { name: 'Test Package', base_cost: 1000 },
    breakdown: [{ label: 'Test Package (4hrs, 75 guests)', amount: 1000 }, { label: 'Champagne Toast (75 guests)', amount: 200 },
      { label: 'Bar Rental (1 bar)', amount: 50 }, { label: 'Handcrafted Syrups (2 bottles)', amount: 60 }],
    adjustments: [], addons: [{ id: 42, name: 'Champagne Toast', billing_type: 'per_guest', rate: 2.5, quantity: 75, line_total: 200 }],
    gratuity: { total: 0 }, subtotal: 1310, total: 1310,
  };
  const p = await seedProposal({ totalPrice: 1310, snapshot, adjustments: [] });
  const inv = await seedExtrasInvoice(p, { amountDue: 31000, lines: [
    { description: 'Champagne Toast (75 guests)', line_total: 20000, source_type: 'addon', source_id: 42 },
    { description: 'Portable Bar Rental', line_total: 5000, source_type: 'fee' },
    { description: 'Hand-Crafted Syrups (2 bottles)', line_total: 6000, source_type: 'fee' },
  ] });
  const r = await request('PATCH', `/api/invoices/${inv}`, { token: adminToken, body: { status: 'void' } });
  assert.equal(r.status, 200, r.raw);
  assert.equal(await statusOf(inv), 'void');
  // Whole $310 (addon 200 + bar 50 + syrup 60) comes back out: 1310 -> 1000.
  assert.equal(await totalPriceOf(p), 1000);
  const log = await compLog(p);
  assert.equal(Number(log[0].amt), 31000);

  // The comp line (audit PRC-01): in the adjustments column and the snapshot,
  // protected by source, visible to the client, the snapshot total moved by
  // the same cents, the add-on row still on the snapshot, and the row's status
  // restored (paid 100 against 1000 stays deposit_paid, so no move here).
  const row = await rowOf(p);
  const invoiceNumber = (await pool.query('SELECT invoice_number FROM invoices WHERE id = $1', [inv])).rows[0].invoice_number;
  const line = { type: 'discount', label: `${COMP_LABEL} (${invoiceNumber})`, amount: 310, visible: true, source: 'comp' };
  assert.deepEqual(row.adjustments, [line]);
  assert.deepEqual(row.pricing_snapshot.adjustments, [line]);
  assert.equal(Number(row.pricing_snapshot.total), 1000, 'snapshot.total equals total_price after the comp');
  assert.deepEqual(row.pricing_snapshot.breakdown[4], { label: line.label, amount: -310, visible: true });
  assert.equal(row.pricing_snapshot.addons.length, 1, 'the comped add-on is still delivered');
  assert.equal(row.status, 'deposit_paid');
});

test('comp on a legacy row (the {} snapshot the column defaults to): total_price drops, the line lands in the column and the snapshot, no total is invented', async () => {
  const p = await seedProposal({ totalPrice: 1310 });
  const inv = await seedExtrasInvoice(p, { amountDue: 25000, lines: [
    { description: 'Champagne Toast (75 guests)', line_total: 20000, source_type: 'addon', source_id: 42 },
    { description: 'Portable Bar Rental', line_total: 5000, source_type: 'fee' },
  ] });
  const r = await request('PATCH', `/api/invoices/${inv}`, { token: adminToken, body: { status: 'void' } });
  assert.equal(r.status, 200, r.raw);
  assert.equal(await totalPriceOf(p), 1060);
  const row = await rowOf(p);
  assert.equal(row.adjustments.length, 1);
  assert.equal(row.adjustments[0].source, 'comp');
  assert.equal(row.adjustments[0].amount, 250);
  assert.deepEqual(row.adjustments[0].comped_addons, [{ addon_id: 42, cents: 20000 }]);
  // {} is an object: it takes the line, and nothing else (no total, no
  // breakdown row) is written into a snapshot that never had them.
  assert.deepEqual(row.pricing_snapshot, { adjustments: row.adjustments });
});

test('after a comp, a re-price at the catalog lands on the comped total instead of billing the add-on again', async () => {
  // The audit's re-bill: the comped add-on row survives the comp (the client
  // still receives it), so the next editor save, drink-plan fold or
  // cancel-line prices it again. The comp line nets it. Real catalog rows: The
  // Core Reaction and the Champagne Toast add-on from the dev catalog.
  const pkg = (await pool.query("SELECT * FROM service_packages WHERE slug = 'the-core-reaction'")).rows[0];
  const toast = (await pool.query("SELECT * FROM service_addons WHERE slug = 'champagne-toast'")).rows[0];
  assert.ok(pkg && toast, 'dev catalog is missing The Core Reaction or the Champagne Toast');
  const priced = calculateProposal({
    pkg, guestCount: 75, durationHours: 4, numBars: 1, numBartenders: null,
    addons: [{ ...toast, quantity: 1 }], syrupSelections: [], adjustments: [], totalPriceOverride: null,
    gratuityRate: 0, tipJar: true, gratuityFloorRate: null,
  });
  const toastCents = Math.round(priced.addons[0].line_total * 100);
  assert.ok(toastCents > 0);
  const p = await seedProposal({
    totalPrice: priced.total, snapshot: priced, adjustments: [], packageId: pkg.id, guestCount: 75, hours: 4, numBars: 1,
    amountPaid: priced.total,
  });
  await pool.query(
    `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [p, toast.id, toast.name, toast.billing_type, toast.rate, priced.addons[0].quantity, priced.addons[0].line_total]
  );
  const inv = await seedExtrasInvoice(p, { amountDue: toastCents, lines: [
    { description: `${toast.name} (75 guests)`, line_total: toastCents, source_type: 'addon', source_id: toast.id },
  ] });

  const r = await request('PATCH', `/api/invoices/${inv}`, { token: adminToken, body: { status: 'void' } });
  assert.equal(r.status, 200, r.raw);
  const compedTotalCents = Math.round(priced.total * 100) - toastCents;
  assert.equal(Math.round((await totalPriceOf(p)) * 100), compedTotalCents);
  const row = await rowOf(p);
  assert.equal(Math.round(Number(row.pricing_snapshot.total) * 100), compedTotalCents);
  assert.equal(row.status, 'balance_paid', 'paid in full at the comped total');

  // The re-bill check: the add-on row is still there and prices again at the
  // catalog; the comp line nets it, so the catalog total IS the comped total.
  const addonRows = await pool.query('SELECT addon_id FROM proposal_addons WHERE proposal_id = $1', [p]);
  assert.deepEqual(addonRows.rows.map((x) => x.addon_id), [toast.id], 'the comped add-on row stays');
  const repriced = await repriceAtCatalog(p);
  assert.equal(Math.round(repriced.total * 100), compedTotalCents, 'a re-price does not climb back');
  assert.equal(repriced.addons.length, 1);
  assert.equal(repriced.adjustments.length, 1);
  assert.equal(repriced.adjustments[0].source, 'comp');
});

test('void with payments applied is refused (409)', async () => {
  const p = await seedProposal({ totalPrice: 1000 });
  const inv = await seedExtrasInvoice(p, { amountDue: 6000, amountPaid: 6000, lines: [
    { description: 'Hand-Crafted Syrups', line_total: 6000, source_type: 'fee' },
  ] });
  const r = await request('PATCH', `/api/invoices/${inv}`, { token: adminToken, body: { status: 'void' } });
  assert.equal(r.status, 409, r.raw);
  assert.equal(await statusOf(inv), 'sent', 'paid invoice stays open');
});

test('helper path-switch mode (reconcileTotalPrice:false): voids but leaves total_price', async () => {
  const p = await seedProposal({ totalPrice: 1000 });
  const inv = await seedExtrasInvoice(p, { amountDue: 25000, lines: [
    { description: 'Champagne Toast (75 guests)', line_total: 20000, source_type: 'addon', source_id: 42 },
    { description: 'Portable Bar Rental', line_total: 5000, source_type: 'fee' },
  ] });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await voidExtrasInvoiceWithReconcile(inv, null, c, { reconcileTotalPrice: false, reason: 'resubmit_add_to_balance' });
    await c.query('COMMIT');
  } finally { c.release(); }
  assert.equal(await statusOf(inv), 'void');
  assert.equal(await totalPriceOf(p), 1000, 'path-switch void must NOT reduce total_price (addon flows to Balance)');
  const log = await compLog(p);
  assert.equal(log[0].reason, 'resubmit_add_to_balance');
  assert.equal(log[0].actor_type, 'system');
});
