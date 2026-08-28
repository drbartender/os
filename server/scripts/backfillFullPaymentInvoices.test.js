// server/scripts/backfillFullPaymentInvoices.test.js
// The one-off repair for the bookings whose Deposit invoice absorbed $100 of
// a full payment (spec 2026-08-28 §5). Selection is by shape. The write
// records the FULL before-state so it can be reversed by hand, and refuses
// to run without an --expect set that matches the selection exactly.
require('dotenv').config();

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { selectCandidates, excludeReason, applyCandidate, parseArgs, main } = require('./backfillFullPaymentInvoices');

if (process.env.NODE_ENV === 'production') {
  throw new Error('backfillFullPaymentInvoices.test.js refuses to run against production');
}

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
let seq = 0;
const clientIds = [];
const proposalIds = [];

const CONSISTENT_SNAPSHOT = { package: { name: 'The Core Reaction', base_cost: 550 }, total: 550 };

async function seedStranded({ externalPaid = 0, totalPrice = 550, paymentCents = 55000, status = 'completed', withLines = true, pricingSnapshot = CONSISTENT_SNAPSHOT } = {}) {
  seq += 1;
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`, [`Backfill Test ${seq}`, `bf-${NONCE}-${seq}@example.test`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, external_paid, payment_type,
                            pricing_snapshot, event_date, event_start_time, event_duration_hours, event_type)
     VALUES ($1, $2, $3, $3, 100, $4, 'full',
             $5::jsonb,
             CURRENT_DATE - INTERVAL '10 days', '6:00 PM', 4, 'Cocktail Party') RETURNING id`,
    [c.rows[0].id, status, totalPrice, externalPaid, JSON.stringify(pricingSnapshot)]
  );
  const proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  const i = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked, locked_at)
     VALUES ($1, $2, 'Deposit', 10000, 10000, 'paid', true, NOW()) RETURNING id`,
    [proposalId, `BF${NONCE}${seq}`]
  );
  if (withLines) {
    await pool.query(
      `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, line_total, source_type, source_id)
       VALUES ($1, 'Deposit', 1, 10000, 10000, 'manual', NULL)`,
      [i.rows[0].id]
    );
  }
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
     VALUES ($1, $2, 'full', $3, 'succeeded') RETURNING id`,
    [proposalId, `pi_bf_${NONCE}_${seq}`, paymentCents]
  );
  await pool.query(`INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 10000)`, [i.rows[0].id, pay.rows[0].id]);
  return { proposalId, invoiceId: i.rows[0].id, paymentId: pay.rows[0].id };
}

async function seedRefund(proposalId, paymentId, amountCents = 55000) {
  await pool.query(
    `INSERT INTO proposal_refunds (proposal_id, payment_id, amount, reason,
                                   total_price_before, total_price_after, status)
     VALUES ($1, $2, $3, 'Backfill test refund', 550.00, 500.00, 'succeeded')`,
    [proposalId, paymentId, amountCents]
  );
}

after(async () => {
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    // Before proposal_payments and proposals: proposal_refunds RESTRICTs both.
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('selection finds the stranded shape and reports the true payment amount', async () => {
  const s = await seedStranded();
  const mine = (await selectCandidates(pool)).find((r) => r.proposal_id === s.proposalId);
  assert.ok(mine, 'the seeded row is a candidate');
  assert.equal(mine.invoice_id, s.invoiceId);
  assert.equal(mine.payment_id, s.paymentId);
  assert.equal(Number(mine.payment_amount), 55000);
  assert.equal(Number(mine.amount_due), 10000);
  assert.equal(Number(mine.link_amount), 10000);
  assert.equal(excludeReason(mine), null);
});

test('the CC-transfer cohort is selected by shape but excluded by reason', async () => {
  const s = await seedStranded({ externalPaid: 100 });
  const mine = (await selectCandidates(pool)).find((r) => r.proposal_id === s.proposalId);
  assert.ok(mine);
  assert.equal(excludeReason(mine), 'external_paid');
});

test('excludeReason: legal hold, refunds and an overpayment are skips; a clean row is null', () => {
  const base = { proposal_id: 1, external_paid: '0', refund_count: 0, total_price: '550.00', payment_amount: 55000, cancelled_at: null, proposal_status: 'completed', other_payments: 0, payment_type: 'full' };
  assert.equal(excludeReason({ ...base, other_payments: 1 }), 'other_payment', 'the repair is for ONE payment');
  assert.equal(excludeReason({ ...base, payment_type: 'invoice' }), 'non_contract_payment', 'payroll fee netting is only neutral for contract types');
  assert.equal(excludeReason({ ...base, proposal_id: 600 }), 'legal_hold');
  assert.equal(excludeReason({ ...base, refund_count: 1 }), 'has_refund');
  assert.equal(excludeReason({ ...base, cancelled_at: new Date() }), 'cancelled', 'a promised refund figure must not move');
  assert.equal(excludeReason({ ...base, proposal_status: 'archived' }), 'cancelled');
  assert.equal(excludeReason({ ...base, external_paid: '25.00' }), 'external_paid');
  assert.equal(excludeReason({ ...base, total_price: '400.00' }), 'exceeds_contract');
  assert.equal(excludeReason(base), null);
});

test('parseArgs: --apply requires --expect, and --expect parses to a set of ids', () => {
  assert.deepEqual(parseArgs(['node', 'x']), { apply: false, expect: null });
  assert.deepEqual(parseArgs(['node', 'x', '--expect', '774,770']), { apply: false, expect: new Set([774, 770]) });
  assert.deepEqual(parseArgs(['node', 'x', '--apply', '--expect', '774']), { apply: true, expect: new Set([774]) });
  assert.throws(() => parseArgs(['node', 'x', '--apply']), /--expect/);

  // A malformed token must stop the run, not be silently dropped until the
  // shrunken list happens to match the selection.
  assert.throws(() => parseArgs(['node', 'x', '--apply', '--expect', '442,45O']), /45O/);
  assert.throws(() => parseArgs(['node', 'x', '--expect', '442,45O']), /45O/);
  assert.throws(() => parseArgs(['node', 'x', '--expect', '442,']), /--expect/, 'a trailing comma is not id 0');
  assert.throws(() => parseArgs(['node', 'x', '--expect', '']), /--expect/, 'an empty value is not an empty expectation');
  assert.throws(() => parseArgs(['node', 'x', '--expect', '--apply']), /--expect/, 'the next flag is not a value');
  // Duplicates collapse and are not an error.
  assert.deepEqual(parseArgs(['node', 'x', '--expect', '774,774']), { apply: false, expect: new Set([774]) });
});

test('apply rewrites the invoice and the link, regenerates lines when the total matches, records the full before-state, and is idempotent', async () => {
  const s = await seedStranded();
  const [cand] = (await selectCandidates(pool)).filter((r) => r.proposal_id === s.proposalId);
  const out = await applyCandidate(pool, cand);
  assert.equal(out.linesRegenerated, true);

  const inv = (await pool.query('SELECT label, amount_due, amount_paid, status, locked FROM invoices WHERE id = $1', [s.invoiceId])).rows[0];
  assert.equal(inv.label, 'Full Payment');
  assert.equal(Number(inv.amount_due), 55000);
  assert.equal(Number(inv.amount_paid), 55000);
  assert.equal(inv.status, 'paid');
  assert.equal(inv.locked, true);
  const link = (await pool.query('SELECT amount FROM invoice_payments WHERE invoice_id = $1 AND payment_id = $2', [s.invoiceId, s.paymentId])).rows[0];
  assert.equal(Number(link.amount), 55000);
  const lines = (await pool.query('SELECT description FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id', [s.invoiceId])).rows;
  assert.equal(lines[0].description, 'The Core Reaction', 'regenerated from the snapshot');

  const bc = (await pool.query("SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'invoice_backfilled_to_full'", [s.proposalId])).rows;
  assert.equal(bc.length, 1);
  const d = bc[0].details;
  assert.equal(d.from_label, 'Deposit');
  assert.equal(d.from_amount_due, 10000);
  assert.equal(d.from_amount_paid, 10000);
  assert.equal(d.from_link_amount, 10000);
  assert.equal(d.to_amount_due, 55000);
  assert.equal(d.lines_regenerated, true);
  assert.equal(d.from_line_items.length, 1, 'the prior lines are preserved in the breadcrumb');
  assert.equal(d.from_line_items[0].description, 'Deposit');

  const again = (await selectCandidates(pool)).filter((r) => r.proposal_id === s.proposalId);
  assert.equal(again.length, 0, 'no longer a candidate: idempotent');
});

test('apply leaves the lines alone when the proposal total has moved since the payment', async () => {
  // The total moved UP. A total BELOW the payment is now refused outright by the
  // contract cap, so an up-move is the only way left to reach total_moved.
  const s = await seedStranded({ totalPrice: 600, paymentCents: 55000 });
  const [cand] = (await selectCandidates(pool)).filter((r) => r.proposal_id === s.proposalId);
  assert.ok(cand, 'still the stranded shape');
  const out = await applyCandidate(pool, cand);
  assert.equal(out.linesRegenerated, false);
  const lines = (await pool.query('SELECT description FROM invoice_line_items WHERE invoice_id = $1', [s.invoiceId])).rows;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].description, 'Deposit', 'untouched');
  assert.equal(Number((await pool.query('SELECT amount_due FROM invoices WHERE id = $1', [s.invoiceId])).rows[0].amount_due), 55000, 'the receipt still says what was paid');
});

test('the regenerate decision comes from the total read under the lock, not the selection snapshot', async () => {
  const s = await seedStranded({ totalPrice: 550, paymentCents: 55000 });
  const [cand] = (await selectCandidates(pool)).filter((r) => r.proposal_id === s.proposalId);
  assert.ok(cand, 'selected while the total still matched the payment');
  assert.equal(Number(cand.total_price), 550, 'the snapshot the selection carries would say regenerate');

  // The total moves after selection and before apply. Upward: below the payment
  // the contract cap refuses the proposal before the regenerate decision runs.
  await pool.query('UPDATE proposals SET total_price = 600 WHERE id = $1', [s.proposalId]);

  const out = await applyCandidate(pool, cand);
  assert.equal(out.linesRegenerated, false, 'decided from the locked read, not the stale snapshot');
  const lines = (await pool.query('SELECT description FROM invoice_line_items WHERE invoice_id = $1', [s.invoiceId])).rows;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].description, 'Deposit', 'untouched');

  const d = (await pool.query("SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'invoice_backfilled_to_full'", [s.proposalId])).rows[0].details;
  assert.equal(d.total_price_at_apply, '600.00', 'the breadcrumb records the total this transaction read');
  assert.equal(d.lines_regenerated, false);
  assert.equal(d.lines_skipped_reason, 'total_moved');
  assert.equal(Number((await pool.query('SELECT amount_due FROM invoices WHERE id = $1', [s.invoiceId])).rows[0].amount_due), 55000, 'the receipt still says what was paid');
});

test('lines are left alone when the generated lines do not sum to the payment', async () => {
  // An empty snapshot stands in for the real hazard: generateLineItemsFromProposal
  // builds from pricing_snapshot + addons and never reads total_price_override, so on
  // an override'd or legacy proposal its lines can sum to something other than the
  // money collected. The in-tx total check passes here (550 === the 55000 payment);
  // only the generated sum catches it.
  const s = await seedStranded({ totalPrice: 550, paymentCents: 55000, pricingSnapshot: {} });
  const [cand] = (await selectCandidates(pool)).filter((r) => r.proposal_id === s.proposalId);
  assert.ok(cand, 'the total still matches, so the total check alone would regenerate');

  const out = await applyCandidate(pool, cand);
  assert.equal(out.linesRegenerated, false, 'refused: the generated lines do not sum to what was paid');
  assert.equal(out.linesSkippedReason, 'generated_sum_mismatch');

  const lines = (await pool.query('SELECT description FROM invoice_line_items WHERE invoice_id = $1', [s.invoiceId])).rows;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].description, 'Deposit', 'the prior line is untouched, not replaced by an empty set');

  const d = (await pool.query("SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'invoice_backfilled_to_full'", [s.proposalId])).rows[0].details;
  assert.equal(d.lines_regenerated, false);
  assert.equal(d.lines_skipped_reason, 'generated_sum_mismatch');
  assert.equal(Number((await pool.query('SELECT amount_due FROM invoices WHERE id = $1', [s.invoiceId])).rows[0].amount_due), 55000, 'the money is still corrected');
});

test('apply refuses and rolls back when a refund landed after selection', async () => {
  const s = await seedStranded();
  const [cand] = (await selectCandidates(pool)).filter((r) => r.proposal_id === s.proposalId);
  assert.ok(cand, 'clean at selection time');
  assert.equal(excludeReason(cand), null, 'nothing to skip it on yet');

  // The window the selection cannot close: a refund lands between the SELECT and
  // the write. excludeReason ran on a snapshot that no longer describes the row.
  await seedRefund(s.proposalId, s.paymentId);

  await assert.rejects(() => applyCandidate(pool, cand), /acquired a refund/);

  const inv = (await pool.query('SELECT label, amount_due, amount_paid FROM invoices WHERE id = $1', [s.invoiceId])).rows[0];
  assert.equal(inv.label, 'Deposit', 'rolled back whole');
  assert.equal(Number(inv.amount_due), 10000);
  assert.equal(Number(inv.amount_paid), 10000);
  const link = (await pool.query('SELECT amount FROM invoice_payments WHERE id = $1', [cand.link_id])).rows[0];
  assert.equal(Number(link.amount), 10000, 'the link is untouched too');
  const bc = (await pool.query("SELECT 1 FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'invoice_backfilled_to_full'", [s.proposalId])).rowCount;
  assert.equal(bc, 0, 'a rolled-back apply leaves no breadcrumb claiming it happened');
});

test('apply refuses when the invoice no longer matches the selected shape', async () => {
  const s = await seedStranded();
  const [cand] = (await selectCandidates(pool)).filter((r) => r.proposal_id === s.proposalId);
  assert.ok(cand);

  // One cent stands in for any concurrent write to the row the selection
  // measured. The candidate's numbers are no longer the row's, and the rewrite
  // would be built from the stale reading.
  await pool.query('UPDATE invoices SET amount_paid = amount_paid + 1 WHERE id = $1', [s.invoiceId]);

  await assert.rejects(() => applyCandidate(pool, cand), /no longer matches/);

  const inv = (await pool.query('SELECT label, amount_due, amount_paid, locked FROM invoices WHERE id = $1', [s.invoiceId])).rows[0];
  assert.equal(inv.label, 'Deposit');
  assert.equal(Number(inv.amount_due), 10000);
  assert.equal(Number(inv.amount_paid), 10001, 'unchanged apart from the bump');
  assert.equal(inv.locked, true);
});

test('apply refuses a payment above the contract', async () => {
  // total_price 400 against a 550 payment still selects by shape (amount_paid >=
  // total_price, pp.amount > amount_due), but writing it would leave a locked,
  // client-visible Full Payment invoice billing 150 more than the contract, and
  // amount_due == amount_paid is exactly the shape balanceInvoiceMonitor cannot
  // see. An overpayment is a hand repair, so the script refuses rather than
  // guessing which of the two numbers is the error.
  const s = await seedStranded({ totalPrice: 400, paymentCents: 55000 });
  const [cand] = (await selectCandidates(pool)).filter((r) => r.proposal_id === s.proposalId);
  assert.ok(cand, 'the overpaid row is still the stranded shape');
  assert.equal(excludeReason(cand), 'exceeds_contract', 'the dry run shows it as a skip, not a FAILED line');

  // And the under-lock cap holds on its own if a caller bypasses excludeReason.
  await assert.rejects(() => applyCandidate(pool, cand), /exceeds contract/);

  const inv = (await pool.query('SELECT label, amount_due, amount_paid FROM invoices WHERE id = $1', [s.invoiceId])).rows[0];
  assert.equal(inv.label, 'Deposit');
  assert.equal(Number(inv.amount_due), 10000);
  assert.equal(Number(inv.amount_paid), 10000);
});

test('an invoice carrying a legacy reversal has two link rows and is not a candidate', async () => {
  const s = await seedStranded();
  // A LEGACY refund reversal: negative, sharing (invoice_id, payment_id) with the
  // positive link, refund_id NULL because it predates the stamp. schema.sql makes
  // uq_invoice_payments_positive_link partial on amount > 0 precisely so this row
  // is allowed to exist. The rewrite assumes exactly one link on the invoice, so
  // the selection must not list this shape: --expect demands an exact match, and
  // listing a row the apply always refuses would wedge the run.
  await pool.query('INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, -2500)', [s.invoiceId, s.paymentId]);
  await seedRefund(s.proposalId, s.paymentId, 2500);

  const mine = (await selectCandidates(pool)).find((r) => r.proposal_id === s.proposalId);
  assert.equal(mine, undefined, 'two link rows is not the stranded shape');
});
test('main exits nonzero when a proposal fails, and zero when they all apply', async () => {
  const fake = {
    proposal_id: 12345, client_name: 'Fake', total_price: '550.00', external_paid: '0', refund_count: 0,
    invoice_id: 1, invoice_number: 'X1', label: 'Deposit', amount_due: 10000, invoice_amount_paid: 10000,
    link_id: 1, link_amount: 10000, payment_id: 1, payment_amount: 55000, payment_type: 'full', other_payments: 0,
  };
  const db = { query: () => Promise.resolve({ rows: [fake] }) };
  const argv = ['node', 'x', '--apply', '--expect', '12345'];

  const realLog = console.log;
  const realError = console.error;
  const priorExitCode = process.exitCode;
  console.log = () => {};
  console.error = () => {};
  try {
    process.exitCode = 0;
    await main(argv, { db, applyOne: () => Promise.reject(new Error('boom')) });
    assert.equal(process.exitCode, 1, 'a rolled-back proposal must not look like a clean run');

    process.exitCode = 0;
    await main(argv, { db, applyOne: () => Promise.resolve({ linesRegenerated: true, linesSkippedReason: null }) });
    assert.equal(process.exitCode, 0, 'a fully applied run stays clean');
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = priorExitCode === undefined ? 0 : priorExitCode;
  }
});

test('apply refuses when a second link row landed on the invoice after selection', async () => {
  const s = await seedStranded();
  const mine = (await selectCandidates(pool)).find((r) => r.proposal_id === s.proposalId);
  assert.ok(mine, 'selected by shape');
  assert.equal(excludeReason(mine), null);
  // Between selection and apply a reversal lands with NO proposal_refunds row (an
  // orphan the reconciliation should never produce). Nothing upstream can see it;
  // the under-lock link-set check is what keeps the rewrite from breaking
  // sum(invoice_payments) == invoices.amount_paid.
  await pool.query('INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, -2500)', [s.invoiceId, s.paymentId]);
  await assert.rejects(() => applyCandidate(pool, mine), /link set no longer matches .*2 link rows/);
  const inv = (await pool.query('SELECT label, amount_due, amount_paid FROM invoices WHERE id = $1', [s.invoiceId])).rows[0];
  assert.equal(inv.label, 'Deposit', 'rolled back whole');
  assert.equal(Number(inv.amount_due), 10000);
  assert.equal(Number(inv.amount_paid), 10000);
});
test('apply refuses when a second contract invoice was minted after selection', async () => {
  const s = await seedStranded();
  const mine = (await selectCandidates(pool)).find((r) => r.proposal_id === s.proposalId);
  assert.ok(mine, 'selected by shape');
  // A Balance invoice minted in the window (the deposit rail's createBalanceInvoice)
  // would sit open beside a Full Payment carrying the whole payment.
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Balance', 45000, 0, 'sent')`,
    [s.proposalId, `BAL${NONCE}${seq}`]
  );
  await assert.rejects(() => applyCandidate(pool, mine), /contract invoice set no longer matches .*2 rows/);
  const inv = (await pool.query('SELECT label, amount_due, amount_paid FROM invoices WHERE id = $1', [s.invoiceId])).rows[0];
  assert.equal(inv.label, 'Deposit', 'rolled back whole');
  assert.equal(Number(inv.amount_paid), 10000);
});

test('a second payment is a skip by reason, and one landing after selection is refused under the lock', async () => {
  const s = await seedStranded();
  const first = (await selectCandidates(pool)).find((r) => r.proposal_id === s.proposalId);
  assert.ok(first, 'selected by shape');
  assert.equal(excludeReason(first), null);
  await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status) VALUES ($1, 'balance', 10000, 'succeeded')`,
    [s.proposalId]
  );
  const again = (await selectCandidates(pool)).find((r) => r.proposal_id === s.proposalId);
  assert.ok(again, 'still the stranded shape');
  assert.equal(excludeReason(again), 'other_payment', 'visible on the dry run, out of --expect');
  await assert.rejects(() => applyCandidate(pool, first), /acquired another payment/);
  const inv = (await pool.query('SELECT label, amount_due FROM invoices WHERE id = $1', [s.invoiceId])).rows[0];
  assert.equal(inv.label, 'Deposit', 'rolled back whole');
});

test('apply stamps payment_type full, as both live entrances do', async () => {
  const s = await seedStranded();
  await pool.query("UPDATE proposals SET payment_type = 'deposit' WHERE id = $1", [s.proposalId]);
  const mine = (await selectCandidates(pool)).find((r) => r.proposal_id === s.proposalId);
  assert.ok(mine);
  await applyCandidate(pool, mine);
  const p = (await pool.query('SELECT payment_type FROM proposals WHERE id = $1', [s.proposalId])).rows[0];
  assert.equal(p.payment_type, 'full', 'an archive-to-draft-to-sent recovery must not mint a fresh Deposit invoice');
  const bc = (await pool.query(
    "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'invoice_backfilled_to_full'", [s.proposalId]
  )).rows[0];
  assert.equal(bc.details.payment_type_stamped, true);
});
