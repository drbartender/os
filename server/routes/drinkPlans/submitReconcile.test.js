require('dotenv').config();

// F2 integration test. A drink-plan submit that adds a financial side effect
// (here: a portable-bar rental) recomputes proposals.total_price from the
// package. When that new total outruns amount_paid on a FULLY-PAID proposal,
// the handler must (a) demote balance_paid -> deposit_paid and disarm autopay
// (reconcileProposalPaymentStatus), and (b) bill the delta on a fresh
// "Additional Services" invoice (createAdditionalInvoiceIfNeeded), because the
// existing Balance invoice is locked and refreshUnlockedInvoices can't re-bill
// it. Before the fix, status stayed balance_paid ("Paid in Full" while owing)
// and the delta was billed nowhere.
//
// Hand-rolled harness in the style of submitExtras.test.js: real express app +
// real drinkPlans router, driven over HTTP (public token route, no auth).
// Runs against the dev DB; every seeded row is torn down in after(). Rows are
// nonce-suffixed so a crashed prior run can't collide.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const drinkPlansRouter = require('../drinkPlans');

let server;
let baseUrl;
let clientId;
let proposalId;
let planToken;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const bodyBuf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

before(async () => {
  // Pick a per_guest, non-class package so the recomputed total is guest-driven
  // and comfortably exceeds our deliberately-low seeded total (mirrors
  // crud.demotion.test.js package selection).
  const pk = await pool.query(
    "SELECT id FROM service_packages WHERE is_active = true AND pricing_type = 'per_guest' AND bar_type <> 'class' ORDER BY id LIMIT 1"
  );
  assert.ok(pk.rows[0], 'need an active per_guest, non-class package seeded');
  const pkgId = pk.rows[0].id;

  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551212') RETURNING id",
    [`Reconcile Test ${NONCE}`, `reconcile-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  // Fully paid at a deliberately LOW old total ($100 = amount_paid), status
  // balance_paid, autopay armed. The submit's package recompute will push
  // total_price well above $100, so amount_paid can no longer cover it.
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, package_id, event_type, guest_count, num_bars,
        total_price, amount_paid, autopay_enrolled, pricing_snapshot)
     VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             'balance_paid', $2, 'birthday-party', 75, 1,
             100, 100, true, '{}'::jsonb)
     RETURNING id`,
    [clientId, pkgId]
  );
  proposalId = p.rows[0].id;

  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email)
     VALUES ($1, 'draft', '{}'::jsonb, $2, $3) RETURNING id, token`,
    [proposalId, `Reconcile Test ${NONCE}`, `reconcile-${NONCE}@example.com`]
  );
  planToken = dp.rows[0].token;

  // A LOCKED, fully-paid Balance invoice — the "Paid in Full" state whose
  // presence makes createAdditionalInvoiceIfNeeded fire on the delta.
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Balance', 10000, 10000, 'paid', true)`,
    [proposalId, `INV-${crypto.randomBytes(4).toString('hex')}`]
  );

  const app = express();
  app.use(express.json());
  app.use('/api/drink-plans', drinkPlansRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  // Let fire-and-forget submit side-effects (shopping-list gen, email lookup)
  // settle before we tear down the pool.
  await new Promise((r) => setTimeout(r, 300));
  await pool.query("DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)", [proposalId]);
  await pool.query("DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)", [proposalId]);
  await pool.query("DELETE FROM invoices WHERE proposal_id=$1", [proposalId]);
  await pool.query("DELETE FROM proposal_addons WHERE proposal_id=$1", [proposalId]);
  await pool.query("DELETE FROM proposal_activity_log WHERE proposal_id=$1", [proposalId]);
  await pool.query("DELETE FROM drink_plans WHERE proposal_id=$1", [proposalId]);
  await pool.query("DELETE FROM proposals WHERE id=$1", [proposalId]);
  await pool.query("DELETE FROM clients WHERE id=$1", [clientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('fully-paid submit with a bar rental demotes status, disarms autopay, and bills the delta on an Additional Services invoice', async () => {
  const res = await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: {
      status: 'submitted',
      paid_separately: false, // add-to-balance branch
      selections: { logistics: { addBarRental: true } },
    },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'submitted');

  const prop = await pool.query(
    'SELECT status, total_price, amount_paid, autopay_enrolled FROM proposals WHERE id = $1',
    [proposalId]
  );
  const row = prop.rows[0];
  assert.ok(Number(row.total_price) > 100, 'package recompute pushed total_price above the fully-paid old total');
  assert.strictEqual(row.status, 'deposit_paid', 'status must demote balance_paid -> deposit_paid when the new total outruns amount_paid');
  assert.strictEqual(row.autopay_enrolled, false, 'autopay must be disarmed on the was-fully-paid transition');

  // The delta (newTotal - $100) must land on exactly one non-void
  // "Additional Services" invoice (the Balance invoice is locked).
  const expectedDeltaCents = Math.round((Number(row.total_price) - 100) * 100);
  const addl = await pool.query(
    `SELECT amount_due FROM invoices
      WHERE proposal_id = $1 AND label = 'Additional Services' AND status <> 'void'`,
    [proposalId]
  );
  assert.strictEqual(addl.rows.length, 1, 'exactly one Additional Services invoice for the delta');
  assert.strictEqual(addl.rows[0].amount_due, expectedDeltaCents);
});

test('deposit_paid submit must NOT double-bill the delta (refreshed Balance already absorbs it)', async () => {
  // The COMMON drink-plan state: deposit paid, so a paid+locked Deposit invoice AND
  // an unlocked 'sent' Balance invoice coexist. refreshUnlockedInvoices rebuilds the
  // Balance to (newTotal - lockedDeposit), already folding the extras delta in. If
  // createAdditionalInvoiceIfNeeded ALSO fires (its only guard is "any locked invoice
  // exists" — the Deposit satisfies it), the delta is billed twice. Assert the total
  // open obligation equals (newTotal - amountPaid), i.e. no double-bill.
  const pk = await pool.query(
    "SELECT id FROM service_packages WHERE is_active = true AND pricing_type = 'per_guest' AND bar_type <> 'class' ORDER BY id LIMIT 1"
  );
  const pkgId = pk.rows[0].id;
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id",
    [`Recon DP ${NONCE}`, `recon-dp-${NONCE}@example.com`]
  );
  const dpClientId = c.rows[0].id;
  // total $500, deposit $100 paid → status deposit_paid.
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, package_id, event_type, guest_count, num_bars,
        total_price, amount_paid, deposit_amount, autopay_enrolled, pricing_snapshot)
     VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             'deposit_paid', $2, 'birthday-party', 75, 1,
             500, 100, 100, true, '{}'::jsonb)
     RETURNING id`,
    [dpClientId, pkgId]
  );
  const dpPropId = p.rows[0].id;
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email)
     VALUES ($1, 'draft', '{}'::jsonb, $2, $3) RETURNING token`,
    [dpPropId, `Recon DP ${NONCE}`, `recon-dp-${NONCE}@example.com`]
  );
  const dpToken = dp.rows[0].token;
  // Paid+locked Deposit ($100) and unlocked 'sent' Balance ($400) — the deposit_paid shape.
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Deposit', 10000, 10000, 'paid', true)`,
    [dpPropId, `INVD-${crypto.randomBytes(4).toString('hex')}`]
  );
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Balance', 40000, 0, 'sent', false)`,
    [dpPropId, `INVB-${crypto.randomBytes(4).toString('hex')}`]
  );

  try {
    const res = await request('PUT', `/api/drink-plans/t/${dpToken}`, {
      body: { status: 'submitted', paid_separately: false, selections: { logistics: { addBarRental: true } } },
    });
    assert.strictEqual(res.status, 200);
    const prop = (await pool.query('SELECT total_price, amount_paid FROM proposals WHERE id = $1', [dpPropId])).rows[0];
    const newTotalCents = Math.round(Number(prop.total_price) * 100);
    const paidCents = Math.round(Number(prop.amount_paid) * 100);
    // Sum of all OPEN (non-void, unpaid-remainder) obligations across invoices.
    const openSum = (await pool.query(
      `SELECT COALESCE(SUM(amount_due - amount_paid), 0)::int AS owed
         FROM invoices WHERE proposal_id = $1 AND status <> 'void'`,
      [dpPropId]
    )).rows[0].owed;
    assert.strictEqual(
      openSum, newTotalCents - paidCents,
      `open obligation must equal newTotal - amountPaid (no double-bill). Got ${openSum}, expected ${newTotalCents - paidCents} (delta billed twice = ${openSum - (newTotalCents - paidCents)} cents over)`
    );
  } finally {
    await pool.query("DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)", [dpPropId]);
    await pool.query("DELETE FROM invoices WHERE proposal_id=$1", [dpPropId]);
    await pool.query("DELETE FROM proposal_addons WHERE proposal_id=$1", [dpPropId]);
    await pool.query("DELETE FROM proposal_activity_log WHERE proposal_id=$1", [dpPropId]);
    await pool.query("DELETE FROM drink_plans WHERE proposal_id=$1", [dpPropId]);
    await pool.query("DELETE FROM proposals WHERE id=$1", [dpPropId]);
    await pool.query("DELETE FROM clients WHERE id=$1", [dpClientId]);
  }
});
