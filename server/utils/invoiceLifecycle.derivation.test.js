// Derivation invariant for open invoices (2026-07-28 over-billing incident).
//
//   Σ(open invoice amount_due) ≤ owed,  owed = total_price − amount_paid
//
// Not equality: a partial bill (Deposit, Drink Plan Extras) is a deliberate
// under-bill. Over-billing is never correct.
//
// Shared dev DB conventions: run alone (node -r dotenv/config --test), one
// synthetic client/proposal per case, cleaned up in finally.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { refreshUnlockedInvoices } = require('./invoiceLifecycle');
const {
  PARTIAL_BILL_LABELS,
  TOTAL_TRACKING_INVOICE_LABELS,
} = require('./proposalMoneyShared');

let seq = 0;
async function fixture({ total, paid, deposit = 100, invoices }) {
  if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');
  const tag = `${process.pid}-${++seq}`;
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ('Derivation Fixture', $1, 'other') RETURNING id`,
    [`derivation-${tag}@example.com`]
  );
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, guest_count, total_price, amount_paid, deposit_amount, status)
     VALUES ($1, '2026-12-01', 50, $2, $3, $4, 'deposit_paid') RETURNING id`,
    [c.rows[0].id, total, paid, deposit]
  );
  const made = [];
  for (const inv of invoices) {
    const r = await pool.query(
      `INSERT INTO invoices (proposal_id, label, amount_due, amount_paid, status, locked, invoice_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [p.rows[0].id, inv.label, inv.due, inv.paid || 0, inv.status || 'sent',
        inv.locked || false, `DV${tag}${made.length}`]
    );
    made.push({ ...inv, id: r.rows[0].id });
  }
  return { clientId: c.rows[0].id, proposalId: p.rows[0].id, invoices: made };
}

async function cleanup(f) {
  await pool.query('DELETE FROM invoice_line_items WHERE invoice_id = ANY($1)', [f.invoices.map((i) => i.id)]);
  await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [f.proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [f.proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [f.clientId]);
}

async function amountOf(id) {
  const { rows: [row] } = await pool.query('SELECT amount_due, amount_paid, status FROM invoices WHERE id = $1', [id]);
  return { due: Number(row.amount_due), paid: Number(row.amount_paid), status: row.status };
}

test.after(async () => { await pool.end(); });

test('partial-bill labels are exactly Deposit and Drink Plan Extras', () => {
  assert.deepEqual([...PARTIAL_BILL_LABELS].sort(), ['Deposit', 'Drink Plan Extras']);
});

// Regression pin. Widening the refresh to every label (2026-07-28) makes it
// tempting to widen this too, since it reads like "labels the refresh manages".
// It is not that. It is "labels whose demand the CANCEL transaction already
// rebuilt before the refund fires", and widening it re-opens the RC1 phantom
// balance on a fully-paid bespoke invoice. See the constant's comment.
test('TOTAL_TRACKING_INVOICE_LABELS stays narrow and does not follow the refresh', () => {
  assert.deepEqual([...TOTAL_TRACKING_INVOICE_LABELS].sort(), ['Balance', 'Full Payment']);
  for (const label of ['Additional Services', 'Gratuity Balance', 'Drink Plan Extras']) {
    assert.equal(
      TOTAL_TRACKING_INVOICE_LABELS.includes(label), false,
      `${label} must keep dropping amount_due on an overpayment refund`
    );
  }
});

// ── Mechanism A: the locked-invoice-sum proxy (David Luebke, prop 51) ────────

test('Balance derives from amount_paid when no locked invoice backs the payment', async () => {
  const f = await fixture({ total: 1100, paid: 100, invoices: [{ label: 'Balance', due: 110000 }] });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 100000);
  } finally { await cleanup(f); }
});

test('external_paid is not subtracted twice (it already lives inside amount_paid)', async () => {
  const f = await fixture({ total: 930, paid: 100, invoices: [{ label: 'Balance', due: 1 }] });
  try {
    await pool.query('UPDATE proposals SET external_paid = 100 WHERE id = $1', [f.proposalId]);
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 83000);
  } finally { await cleanup(f); }
});

// ── Mechanism B: bespoke labels the old code `continue`d past ────────────────

test('a bespoke remainder label re-derives on a price decrease (Brandon shape)', async () => {
  const f = await fixture({ total: 420, paid: 350, invoices: [{ label: 'Additional Services', due: 15000 }] });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 7000);
  } finally { await cleanup(f); }
});

test('a remainder invoice deriving to zero is voided, not left open at $0 (Cathy shape)', async () => {
  const f = await fixture({ total: 1192.5, paid: 1192.5, invoices: [{ label: 'Additional Services', due: 18500 }] });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    const got = await amountOf(f.invoices[0].id);
    assert.equal(got.due, 0);
    assert.equal(got.status, 'void');
  } finally { await cleanup(f); }
});

// ── Partial bills are capped, never raised ──────────────────────────────────

test('an open Deposit keeps deposit_amount and is never raised to owed', async () => {
  const f = await fixture({ total: 1000, paid: 0, deposit: 100, invoices: [{ label: 'Deposit', due: 10000 }] });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 10000);
  } finally { await cleanup(f); }
});

test('an open Deposit is capped when it exceeds what is still owed', async () => {
  const f = await fixture({ total: 100, paid: 60, deposit: 100, invoices: [{ label: 'Deposit', due: 10000 }] });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 4000);
  } finally { await cleanup(f); }
});

test('Drink Plan Extras keeps its own figure when it fits, remainder takes the rest', async () => {
  const f = await fixture({
    total: 500, paid: 100,
    invoices: [{ label: 'Drink Plan Extras', due: 15500 }, { label: 'Balance', due: 50000 }],
  });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 15500, 'extras untouched when it fits');
    assert.equal((await amountOf(f.invoices[1].id)).due, 24500, 'remainder = 40000 owed - 15500 extras');
  } finally { await cleanup(f); }
});

test('Drink Plan Extras capped to zero is flagged, never auto-voided (Eve shape)', async () => {
  const f = await fixture({ total: 550, paid: 550, invoices: [{ label: 'Drink Plan Extras', due: 15500 }] });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    const got = await amountOf(f.invoices[0].id);
    assert.equal(got.due, 0, 'capped at owed');
    assert.notEqual(got.status, 'void', 'void must route through voidExtrasInvoiceWithReconcile');
  } finally { await cleanup(f); }
});

// ── The floor: a settled invoice stays settled ──────────────────────────────

test('a fully paid unlocked invoice is not dragged below what it collected (RC1 guard)', async () => {
  const f = await fixture({
    total: 800, paid: 1000,
    invoices: [{ label: 'Additional Services', due: 100000, paid: 100000, status: 'paid' }],
  });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    const got = await amountOf(f.invoices[0].id);
    assert.equal(got.due, 100000, 'due floors at amount_paid so refundHelpers can drop both together');
    assert.notEqual(got.status, 'void', 'never void an invoice with payments applied');
  } finally { await cleanup(f); }
});

test('locked invoices are never modified', async () => {
  const f = await fixture({
    total: 420, paid: 350,
    invoices: [{ label: 'Balance', due: 25000, paid: 25000, status: 'paid', locked: true }],
  });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    const got = await amountOf(f.invoices[0].id);
    assert.equal(got.due, 25000);
    assert.equal(got.status, 'paid');
  } finally { await cleanup(f); }
});

test('two remainder invoices: nothing is written', async () => {
  const f = await fixture({
    total: 500, paid: 0,
    invoices: [{ label: 'Additional Services', due: 10000 }, { label: 'Gratuity Balance', due: 20000 }],
  });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 10000, 'refuses to guess an allocation');
    assert.equal((await amountOf(f.invoices[1].id)).due, 20000);
  } finally { await cleanup(f); }
});

test('Gratuity Balance is a remainder bill and tracks owed (Iga shape)', async () => {
  const f = await fixture({ total: 600, paid: 500, invoices: [{ label: 'Gratuity Balance', due: 10000 }] });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 10000);
  } finally { await cleanup(f); }
});
