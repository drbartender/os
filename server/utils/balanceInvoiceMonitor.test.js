// Balance-invoice monitor: both directions of the invariant
//
//     Σ(open invoice remaining) ≤ owed,  owed = total_price − amount_paid
//
// SHARED DEV DB NOTE: the monitor scans every proposal in the database, so it
// will legitimately alert on unrelated rows. No test asserts a global count.
// Each asserts on ITS OWN fixture proposal, by looking for the activity-log
// row the monitor writes. The one global assertion is the internal invariant
// candidates === alerted + throttled, which holds regardless of what else is
// in the DB.
//
// Run alone: node -r dotenv/config --test server/utils/balanceInvoiceMonitor.test.js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  monitorMissingBalanceInvoices,
  OVER_ACTION,
  UNDER_ACTION,
} = require('./balanceInvoiceMonitor');

let seq = 0;
const made = [];

async function fixture({ status = 'deposit_paid', total, paid, invoices = [] }) {
  if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');
  const tag = `${process.pid}-${++seq}`;
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'other') RETURNING id`,
    [`Monitor Fixture ${tag}`, `monitor-${tag}@example.com`]
  );
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, guest_count, total_price, amount_paid, deposit_amount, status)
     VALUES ($1, '2026-12-01', 50, $2, $3, 100, $4) RETURNING id`,
    [c.rows[0].id, total, paid, status]
  );
  const invIds = [];
  for (const inv of invoices) {
    const r = await pool.query(
      `INSERT INTO invoices (proposal_id, label, amount_due, amount_paid, status, locked, invoice_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [p.rows[0].id, inv.label, inv.due, inv.paid || 0, inv.status || 'sent',
        inv.locked || false, `MN${tag}${invIds.length}`]
    );
    invIds.push(r.rows[0].id);
  }
  const f = { clientId: c.rows[0].id, proposalId: p.rows[0].id, invoiceIds: invIds };
  made.push(f);
  return f;
}

async function alertsFor(proposalId) {
  const { rows } = await pool.query(
    `SELECT action, details FROM proposal_activity_log
      WHERE proposal_id = $1 AND action IN ($2, $3) ORDER BY id`,
    [proposalId, OVER_ACTION, UNDER_ACTION]
  );
  return rows;
}

test.after(async () => {
  for (const f of made) {
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [f.proposalId]);
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id = ANY($1)', [f.invoiceIds]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [f.proposalId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [f.proposalId]);
    await pool.query('DELETE FROM clients WHERE id = $1', [f.clientId]);
  }
  await pool.end();
});

// ── OVER-BILLED: the four live shapes from the 2026-07-28 incident ──────────

test('alerts when a bespoke invoice exceeds what is owed (Brandon shape)', async () => {
  const f = await fixture({
    total: 420, paid: 350,
    invoices: [
      { label: 'Deposit', due: 10000, paid: 10000, status: 'paid', locked: true },
      { label: 'Balance', due: 25000, paid: 25000, status: 'paid', locked: true },
      { label: 'Additional Services', due: 15000 },
    ],
  });
  await monitorMissingBalanceInvoices();
  const rows = await alertsFor(f.proposalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, OVER_ACTION);
  assert.equal(rows[0].details.excess_cents, 8000, 'billed 15000 against 7000 owed');
});

test('alerts when an invoice is open against a fully paid proposal (Cathy shape)', async () => {
  const f = await fixture({
    total: 1192.5, paid: 1192.5,
    invoices: [{ label: 'Additional Services', due: 18500 }],
  });
  await monitorMissingBalanceInvoices();
  const rows = await alertsFor(f.proposalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, OVER_ACTION);
  assert.equal(rows[0].details.excess_cents, 18500);
  assert.equal(rows[0].details.owed_cents, 0);
});

test('alerts when a Balance ignores a payment with no locked invoice (David shape)', async () => {
  const f = await fixture({ total: 1100, paid: 100, invoices: [{ label: 'Balance', due: 110000 }] });
  await monitorMissingBalanceInvoices();
  const rows = await alertsFor(f.proposalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, OVER_ACTION);
  assert.equal(rows[0].details.excess_cents, 10000, 'exactly the unbacked deposit');
});

test('alerts on an over-billed quote-stage proposal (over runs outside booked statuses)', async () => {
  const f = await fixture({ status: 'sent', total: 500, paid: 0, invoices: [{ label: 'Balance', due: 60000 }] });
  await monitorMissingBalanceInvoices();
  const rows = await alertsFor(f.proposalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, OVER_ACTION);
});

// ── UNDER-COVERED: the 2026-07-21 spec's shapes ─────────────────────────────

test('alerts when a confirmed proposal has a balance and no invoice at all (CC shape)', async () => {
  const f = await fixture({ status: 'confirmed', total: 800, paid: 100, invoices: [] });
  await monitorMissingBalanceInvoices();
  const rows = await alertsFor(f.proposalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, UNDER_ACTION);
  assert.equal(rows[0].details.balance_cents, 70000);
});

test('alerts when the only Balance invoice is voided', async () => {
  const f = await fixture({
    status: 'confirmed', total: 800, paid: 100,
    invoices: [{ label: 'Balance', due: 70000, status: 'void' }],
  });
  await monitorMissingBalanceInvoices();
  const rows = await alertsFor(f.proposalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, UNDER_ACTION);
});

test('alerts when the only open invoice is zero-due', async () => {
  const f = await fixture({
    status: 'deposit_paid', total: 800, paid: 100,
    invoices: [{ label: 'Balance', due: 0 }],
  });
  await monitorMissingBalanceInvoices();
  const rows = await alertsFor(f.proposalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, UNDER_ACTION);
});

// ── QUIET ───────────────────────────────────────────────────────────────────

test('quiet when an open Balance exactly carries the balance', async () => {
  const f = await fixture({ total: 800, paid: 100, invoices: [{ label: 'Balance', due: 70000 }] });
  await monitorMissingBalanceInvoices();
  assert.deepEqual(await alertsFor(f.proposalId), []);
});

test('quiet when a bespoke-label invoice exactly carries the balance (Iga shape)', async () => {
  const f = await fixture({ total: 600, paid: 500, invoices: [{ label: 'Gratuity Balance', due: 10000 }] });
  await monitorMissingBalanceInvoices();
  assert.deepEqual(await alertsFor(f.proposalId), []);
});

test('quiet at deposit stage: an open Deposit under owed on a sent proposal', async () => {
  const f = await fixture({ status: 'sent', total: 2000, paid: 0, invoices: [{ label: 'Deposit', due: 10000 }] });
  await monitorMissingBalanceInvoices();
  assert.deepEqual(await alertsFor(f.proposalId), [], 'a partial bill is a deliberate under-bill');
});

test('quiet for archived, completed, balance_paid and zero-balance proposals', async () => {
  const shapes = [
    { status: 'archived', total: 800, paid: 0, invoices: [] },
    { status: 'completed', total: 800, paid: 0, invoices: [] },
    { status: 'balance_paid', total: 800, paid: 800, invoices: [] },
    { status: 'deposit_paid', total: 800, paid: 800, invoices: [] },
  ];
  const fs = [];
  for (const s of shapes) fs.push(await fixture(s));
  await monitorMissingBalanceInvoices();
  for (const f of fs) assert.deepEqual(await alertsFor(f.proposalId), []);
});

test('quiet when the money columns are NULL', async () => {
  const f = await fixture({ status: 'confirmed', total: 800, paid: 0, invoices: [] });
  await pool.query('UPDATE proposals SET total_price = NULL, amount_paid = NULL WHERE id = $1', [f.proposalId]);
  await monitorMissingBalanceInvoices();
  assert.deepEqual(await alertsFor(f.proposalId), []);
});

// ── MECHANICS ───────────────────────────────────────────────────────────────

test('throttle: a second run inside 24h writes no second row and counts throttled', async () => {
  const f = await fixture({ total: 420, paid: 350, invoices: [{ label: 'Additional Services', due: 15000 }] });

  await monitorMissingBalanceInvoices();
  assert.equal((await alertsFor(f.proposalId)).length, 1);

  const second = await monitorMissingBalanceInvoices();
  assert.equal((await alertsFor(f.proposalId)).length, 1, 'no second row for the same proposal');
  assert.ok(second.throttled >= 1, 'the still-offending proposal counts as throttled');
});

test('an expired throttle marker lets the proposal alert again', async () => {
  const f = await fixture({ total: 420, paid: 350, invoices: [{ label: 'Additional Services', due: 15000 }] });
  await monitorMissingBalanceInvoices();
  await pool.query(
    `UPDATE proposal_activity_log SET created_at = NOW() - INTERVAL '25 hours'
      WHERE proposal_id = $1 AND action = $2`,
    [f.proposalId, OVER_ACTION]
  );
  await monitorMissingBalanceInvoices();
  assert.equal((await alertsFor(f.proposalId)).length, 2);
});

test('the activity row carries the figures and the invoice labels', async () => {
  const f = await fixture({
    total: 420, paid: 350,
    invoices: [
      { label: 'Balance', due: 25000, paid: 25000, status: 'paid', locked: true },
      { label: 'Additional Services', due: 15000 },
    ],
  });
  await monitorMissingBalanceInvoices();
  const [row] = await alertsFor(f.proposalId);
  assert.equal(row.details.admin_notified, true, 'the row IS the throttle marker');
  assert.equal(row.details.payable_cents, 15000);
  assert.equal(row.details.owed_cents, 7000);
  assert.equal(row.details.invoice_labels, 'Balance, Additional Services');
});

test('candidates always equals alerted plus throttled', async () => {
  await fixture({ total: 420, paid: 350, invoices: [{ label: 'Additional Services', due: 15000 }] });
  const r = await monitorMissingBalanceInvoices();
  assert.equal(r.candidates, r.alerted + r.throttled);
  assert.ok(r.candidates >= 1);
});

test('quiet on an overpaid proposal with no open invoices (Emiline shape)', async () => {
  // owed is negative here. Without the PAYABLE_SUM > 0 guard, `0 > -6000` made
  // this report as over-billed forever, breaking the zero-alerts deploy gate.
  const f = await fixture({
    status: 'confirmed', total: 300, paid: 360,
    invoices: [
      { label: 'Drink Plan Extras', due: 6000, paid: 6000, status: 'paid', locked: true },
      { label: 'Balance', due: 20000, paid: 20000, status: 'paid', locked: true },
    ],
  });
  await monitorMissingBalanceInvoices();
  assert.deepEqual(await alertsFor(f.proposalId), []);
});

test('still alerts on an overpaid proposal that DOES have an open invoice', async () => {
  const f = await fixture({
    status: 'deposit_paid', total: 300, paid: 360,
    invoices: [{ label: 'Additional Services', due: 5000 }],
  });
  await monitorMissingBalanceInvoices();
  const rows = await alertsFor(f.proposalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, OVER_ACTION);
});
