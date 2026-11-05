// Balance-invoice monitor: owed nets money collected outside the contract
// (audit PAY-01, 2026-11-05). DB-BACKED: run alone against the shared dev DB.
//
//   node -r dotenv/config --test server/utils/balanceInvoiceMonitor.netting.test.js
//
// The monitor's OWED_CENTS was total_price - amount_paid. A paid syrup-only
// Drink Plan Extras invoice (or a paid manual invoice) rolls into amount_paid
// but never into total_price, so after such a payment the monitor read the
// client as owing LESS than the contract: a correct Balance invoice looked
// over-billed (a false alert every 24h), and a Balance invoice the same bug
// wrote short never looked under-covered. OWED_CENTS now adds the SQL twin of
// invoiceExtras.sumOffContractPaidCents (offContractPaidCentsSql). The pure
// pin of the twin's partition is invoiceExtras.contractBalance.test.js; this
// suite runs its arithmetic.
//
// SHARED DEV DB NOTE (as balanceInvoiceMonitor.test.js): the monitor scans
// every proposal, so each test asserts on ITS OWN fixture's activity-log rows.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { monitorMissingBalanceInvoices, OVER_ACTION, UNDER_ACTION } = require('./balanceInvoiceMonitor');

if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');

let seq = 0;
const made = [];

async function fixture({ status = 'deposit_paid', total, paid, invoices = [] }) {
  const tag = `${process.pid}-${++seq}-${crypto.randomBytes(2).toString('hex')}`;
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'other') RETURNING id`,
    [`Netting Fixture ${tag}`, `netting-${tag}@example.com`]
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
        inv.locked || false, `NT${tag}${invIds.length}`]
    );
    invIds.push(r.rows[0].id);
    for (const line of inv.lines || []) {
      await pool.query(
        `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, line_total, source_type)
         VALUES ($1, $2, 1, $3, $3, $4)`,
        [r.rows[0].id, line.description, line.cents, line.source_type]
      );
    }
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

const SYRUPS = [
  { description: 'Blackberry syrup', cents: 3000, source_type: 'fee' },
  { description: 'Vanilla syrup', cents: 3000, source_type: 'fee' },
];

test('quiet: a paid syrup-only extras invoice beside a correct 90000 Balance (the report shape)', async () => {
  const f = await fixture({
    total: 1000, paid: 160,
    invoices: [
      { label: 'Deposit', due: 10000, paid: 10000, status: 'paid', locked: true },
      { label: 'Drink Plan Extras', due: 6000, paid: 6000, status: 'paid', locked: true, lines: SYRUPS },
      { label: 'Balance', due: 90000 },
    ],
  });
  await monitorMissingBalanceInvoices();
  assert.deepEqual(await alertsFor(f.proposalId), [], 'owed is 90000, payable is 90000: no alert in either direction');
});

test('under-covered: a Balance the old arithmetic wrote short (84000) against the 90000 still owed', async () => {
  const f = await fixture({
    total: 1000, paid: 160,
    invoices: [
      { label: 'Deposit', due: 10000, paid: 10000, status: 'paid', locked: true },
      { label: 'Drink Plan Extras', due: 6000, paid: 6000, status: 'paid', locked: true, lines: SYRUPS },
      { label: 'Balance', due: 84000 },
    ],
  });
  await monitorMissingBalanceInvoices();
  const rows = await alertsFor(f.proposalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, UNDER_ACTION);
  assert.equal(Number(rows[0].details.balance_cents), 90000);
  assert.equal(Number(rows[0].details.payable_cents), 84000);
});

test('a FOLDED extras invoice (an addon line) is contract money: not netted, and the shape stays quiet', async () => {
  // total 1105 = 1000 + the 105 the fold added; paid 205 = deposit + extras.
  const f = await fixture({
    total: 1105, paid: 205,
    invoices: [
      { label: 'Deposit', due: 10000, paid: 10000, status: 'paid', locked: true },
      { label: 'Drink Plan Extras', due: 10500, paid: 10500, status: 'paid', locked: true,
        lines: [{ description: 'Banquet Server', cents: 7500, source_type: 'addon' }, { description: 'Blackberry syrup', cents: 3000, source_type: 'fee' }] },
      { label: 'Balance', due: 90000 },
    ],
  });
  await monitorMissingBalanceInvoices();
  assert.deepEqual(await alertsFor(f.proposalId), []);
});

test('a paid manual invoice is netted too: the Balance it sits beside is not over-billed', async () => {
  const f = await fixture({
    total: 1000, paid: 350,
    invoices: [
      { label: 'Deposit', due: 10000, paid: 10000, status: 'paid', locked: true },
      { label: 'Damage fee', due: 25000, paid: 25000, status: 'paid', locked: true },
      { label: 'Balance', due: 90000 },
    ],
  });
  await monitorMissingBalanceInvoices();
  assert.deepEqual(await alertsFor(f.proposalId), [], 'owed is 100000 - 35000 + 25000 = 90000');
});
