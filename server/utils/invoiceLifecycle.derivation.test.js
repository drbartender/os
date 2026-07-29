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
const { refreshUnlockedInvoices, createAdditionalInvoiceIfNeeded } = require('./invoiceLifecycle');
const {
  PARTIAL_BILL_LABELS,
  REMAINDER_BILL_LABELS,
  DERIVABLE_INVOICE_LABELS,
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

test('Deposit is the only partial bill; Drink Plan Extras is not derivable at all', () => {
  assert.deepEqual([...PARTIAL_BILL_LABELS], ['Deposit']);
  assert.deepEqual([...REMAINDER_BILL_LABELS], ['Balance', 'Full Payment', 'Additional Services']);
  // The allow-list is the whole point: a label outside it may hold money that
  // is not in total_price, so deriving it destroys or cannibalises money.
  for (const label of ['Drink Plan Extras', 'Gratuity Balance', 'Damage Fee', 'Enhancement Lab']) {
    assert.equal(DERIVABLE_INVOICE_LABELS.includes(label), false, `${label} must not be derivable`);
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

test('Drink Plan Extras is untouched and never nets against the Balance', async () => {
  // Syrup-only extras are additive money that never folds into total_price
  // (routes/drinkPlans/submit.js:571). Netting them out of the remainder would
  // shave $155 off the contract to pay for $155 of syrups.
  const f = await fixture({
    total: 500, paid: 100,
    invoices: [{ label: 'Drink Plan Extras', due: 15500 }, { label: 'Balance', due: 50000 }],
  });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 15500, 'extras never derived');
    assert.equal((await amountOf(f.invoices[1].id)).due, 40000, 'Balance takes the FULL owed');
  } finally { await cleanup(f); }
});

test('a fully paid proposal never zeroes or voids a Drink Plan Extras invoice', async () => {
  // owed is 0, but the extras money is outside total_price, so zeroing it would
  // destroy a real $155 demand and delete its itemization.
  const f = await fixture({ total: 550, paid: 550, invoices: [{ label: 'Drink Plan Extras', due: 15500 }] });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    const got = await amountOf(f.invoices[0].id);
    assert.equal(got.due, 15500, 'untouched');
    assert.notEqual(got.status, 'void');
  } finally { await cleanup(f); }
});

test('an admin-created manual invoice survives a refresh untouched', async () => {
  // POST /api/invoices/proposal/:id accepts free-text labels for money that is
  // not in total_price. Deriving one silently voided it and deleted its lines.
  const f = await fixture({ total: 1000, paid: 1000, invoices: [{ label: 'Damage Fee', due: 25000, status: 'draft' }] });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    const got = await amountOf(f.invoices[0].id);
    assert.equal(got.due, 25000);
    assert.equal(got.status, 'draft');
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

test('two open remainders: the priority one absorbs, the other is left alone', async () => {
  // Earlier this wrote NOTHING, which froze whatever over-bill was already on
  // the Balance. Balance outranks Additional Services, so it takes what AS does
  // not already demand: 50000 owed - 10000 = 40000.
  const f = await fixture({
    total: 500, paid: 0,
    invoices: [{ label: 'Additional Services', due: 10000 }, { label: 'Balance', due: 99999 }],
  });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 10000, 'lower priority keeps its figure');
    assert.equal((await amountOf(f.invoices[1].id)).due, 40000, 'Balance absorbs the rest, no longer frozen');
  } finally { await cleanup(f); }
});

test('Gratuity Balance is NOT derivable and is left exactly as-is (Iga shape)', async () => {
  const f = await fixture({ total: 600, paid: 500, invoices: [{ label: 'Gratuity Balance', due: 10000 }] });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 10000, 'correct today, and untouched either way');
  } finally { await cleanup(f); }
});

// ── The seam that double-billed: refresh + createAdditionalInvoiceIfNeeded ───

test('a standing Additional Services invoice absorbs the delta exactly once', async () => {
  // Every caller runs refreshUnlockedInvoices() and THEN
  // createAdditionalInvoiceIfNeeded(). Once the refresh started deriving
  // 'Additional Services', that guard's narrow ('Balance','Full Payment')
  // absorbing check stopped seeing the invoice that had just absorbed the
  // delta, so it minted a second one for the same money.
  const f = await fixture({
    total: 1300, paid: 1000,
    invoices: [
      { label: 'Deposit', due: 10000, paid: 10000, status: 'paid', locked: true },
      { label: 'Balance', due: 90000, paid: 90000, status: 'paid', locked: true },
      { label: 'Additional Services', due: 20000 },
    ],
  });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    // oldTotal 1200 -> new 1300: a $100 increase on a fully-paid-through-1200 proposal.
    const minted = await createAdditionalInvoiceIfNeeded(f.proposalId, 120000);
    assert.equal(minted, null, 'the open Additional Services invoice already absorbed it');

    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount_due - amount_paid), 0) AS payable
         FROM invoices WHERE proposal_id = $1 AND status IN ('sent','partially_paid')`,
      [f.proposalId]
    );
    assert.equal(Number(rows[0].payable), 30000, 'open demand equals owed, not owed + delta');
  } finally { await cleanup(f); }
});

test('with no open remainder, the delta still mints an Additional Services invoice', async () => {
  const f = await fixture({
    total: 1200, paid: 1000,
    invoices: [{ label: 'Balance', due: 100000, paid: 100000, status: 'paid', locked: true }],
  });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    const minted = await createAdditionalInvoiceIfNeeded(f.proposalId, 100000);
    assert.ok(minted, 'nothing could absorb it, so it must be billed');
    assert.equal(Number(minted.amount_due), 20000);
    f.invoices.push({ id: minted.id });
  } finally { await cleanup(f); }
});
