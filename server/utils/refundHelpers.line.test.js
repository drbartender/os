require('dotenv').config();
// server/utils/refundHelpers.line.test.js
'use strict';
// Every contract refund writes its Refund line (spec 2026-10-16 section 6,
// plan Task R2; Review Focus 3 and 4). Drives applyRefundReconciliation
// directly with fixture rows, the one code path the panel, Cancel event, the
// stale-pending sweep and the refund.created webhook all share. No Stripe
// object is created: the refund ids here are synthetic strings. A held
// booking is a synthetic id ADDED through __setLegalHoldIdsForTest.
//
// Run ALONE against the shared dev DB:
//   node --test server/utils/refundHelpers.line.test.js
const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const { applyRefundReconciliation } = require('./refundHelpers');
const { validateAdjustments } = require('./adjustmentRules');
const { __setLegalHoldIdsForTest } = require('./legalHold');
const { GRATUITY_LABEL, SHARED_GRATUITY_LABEL } = require('./gratuityLabels');

if (process.env.NODE_ENV === 'production') {
  throw new Error('refundHelpers.line.test.js refuses to run against production');
}

const NONCE = `rhl-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let seq = 0;
const seededClients = [];
const seededProposals = [];

afterEach(() => __setLegalHoldIdsForTest(null));

const DISCOUNT_A = { type: 'discount', label: 'Test discount A', amount: 50, visible: true };
// Package, a staffing Shared Gratuity row, one add-on, an ordinary discount and
// the client Gratuity row (gratuity 40): subtotal 1250, total 1240.
const bookingSnapshot = (total = 1240) => ({
  package: { name: 'Test Package', base_cost: 1000 },
  breakdown: [
    { label: 'Test Package (4hrs, 120 guests)', amount: 1000 },
    { label: SHARED_GRATUITY_LABEL, amount: 100 },
    { label: 'Test Add-on A', amount: 150 },
    { label: 'Test discount A', amount: -50 },
    { label: GRATUITY_LABEL, amount: 40 },
  ],
  adjustments: [DISCOUNT_A],
  gratuity: { rate: 10, tip_jar: true, staff_count: 1, hours: 4, staff_noun: 'bartender', total: 40, floor_rate: null },
  subtotal: 1250,
  total,
});

const refundLine = (refundId, amount) => ({
  type: 'discount', label: 'Refund', amount, visible: true, source: 'refund', refund_id: refundId,
});

// One paid booking. `links` are the invoices the one succeeded payment funded,
// in walk order (the reconciler walks by invoice id): { label, cents }.
// paidCents may exceed the links (uncredited headroom). A pending row is
// seeded when pendingScope is given, as refundExecute writes one.
async function seed({
  totalDollars = 1240, paidCents = 124000, override = null,
  snapshot = bookingSnapshot(), adjustments = [DISCOUNT_A],
  links = [{ label: 'Balance', cents: 124000 }],
  pendingScope = null, pendingCents = 28500,
} = {}) {
  seq += 1;
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`Refund Line Recon Test ${NONCE}`, `${NONCE}-${seq}@example.com`]
  );
  seededClients.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, event_timezone,
                            event_date, event_start_time, event_duration_hours,
                            total_price, total_price_override, amount_paid,
                            adjustments, pricing_snapshot, autopay_enrolled, updated_at)
     VALUES ($1, 'balance_paid', 'wedding', 'America/Chicago',
             CURRENT_DATE + 30, '18:00', 4, $2, $3, $4, $5::jsonb, $6::jsonb,
             false, NOW() - INTERVAL '1 day')
     RETURNING id`,
    [c.rows[0].id, totalDollars, override, paidCents / 100,
      JSON.stringify(adjustments), JSON.stringify(snapshot)]
  );
  const proposalId = p.rows[0].id;
  seededProposals.push(proposalId);
  const intent = `pi_${NONCE}_${seq}`;
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
     VALUES ($1, 'balance', $2, 'succeeded', $3) RETURNING id`,
    [proposalId, paidCents, intent]
  );
  for (const link of links) {
    const inv = await pool.query(
      `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
       VALUES ($1, $2, $3, $4, $4, 'paid', true) RETURNING id`,
      [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`, link.label, link.cents]
    );
    await pool.query('INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)',
      [inv.rows[0].id, pay.rows[0].id, link.cents]);
  }
  let pendingRowId = null;
  if (pendingScope) {
    const pr = await pool.query(
      `INSERT INTO proposal_refunds
         (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
          total_price_before, total_price_after, issued_by, status, total_scope)
       VALUES ($1, $2, $3, $4, 'seeded pending', $5, $5, NULL, 'pending', $6)
       RETURNING id`,
      [proposalId, pay.rows[0].id, intent, pendingCents, totalDollars, pendingScope]
    );
    pendingRowId = pr.rows[0].id;
  }
  return { proposalId, paymentId: pay.rows[0].id, intent, pendingRowId };
}

let refundSeq = 0;
async function reconcile(o, { amountCents = 28500, totalScope = null, pendingRowId = null, stripeRefundId } = {}) {
  refundSeq += 1;
  const reId = stripeRefundId || `re_${NONCE}_${refundSeq}`;
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const recon = await applyRefundReconciliation({
      proposalId: o.proposalId,
      stripeRefundId: reId,
      paymentIntentId: o.intent,
      paymentId: o.paymentId,
      amountCents,
      reason: 'test refund',
      issuedBy: null,
      totalScope,
      pendingRowId,
      allowPendingHeuristic: false,
    }, dbClient);
    await dbClient.query('COMMIT');
    return { recon, stripeRefundId: reId };
  } catch (e) {
    await dbClient.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    dbClient.release();
  }
}

async function refundRowId(stripeRefundId) {
  const r = await pool.query(
    `SELECT id FROM proposal_refunds WHERE stripe_refund_id = $1 AND status = 'succeeded'`,
    [stripeRefundId]
  );
  assert.equal(r.rows.length, 1);
  return r.rows[0].id;
}

// The row as the editor's staleness guard and the money columns see it.
async function readRow(proposalId) {
  const r = await pool.query(
    `SELECT adjustments, pricing_snapshot, total_price, amount_paid, total_price_override,
            updated_at, md5(COALESCE(adjustments, '[]'::jsonb)::text) AS token
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const row = r.rows[0];
  return {
    ...row,
    total: Number(row.total_price),
    paid: Number(row.amount_paid),
    override: row.total_price_override === null ? null : Number(row.total_price_override),
  };
}

const refundLines = (row) => (row.adjustments || []).filter((a) => a && a.source === 'refund');

after(async () => {
  if (seededProposals.length) {
    const ids = seededProposals;
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (seededClients.length) {
    await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [seededClients]);
  }
  await pool.end();
});

test('a $285 contract refund writes one Refund line with the refund row id, syncs the snapshot and moves the editor token', async () => {
  // Both ways a succeeded row comes to exist: the caller's pending row adopted
  // (the panel and Cancel event), and a fresh row (a dashboard refund).
  for (const pendingScope of ['contract', null]) {
    const o = await seed({ pendingScope });
    const before = await readRow(o.proposalId);
    const { recon, stripeRefundId } = await reconcile(o, { pendingRowId: o.pendingRowId });
    assert.equal(recon.applied, true);
    const rid = await refundRowId(stripeRefundId);
    if (o.pendingRowId) assert.equal(rid, o.pendingRowId);
    assert.equal(typeof rid, 'number');

    const row = await readRow(o.proposalId);
    assert.deepEqual(row.adjustments, [DISCOUNT_A, refundLine(rid, 285)]);
    assert.equal(typeof row.adjustments[1].refund_id, 'number'); // never a string

    const want = bookingSnapshot(955);
    want.adjustments = [DISCOUNT_A, refundLine(rid, 285)];
    want.breakdown = [...want.breakdown.slice(0, 4),
      { label: 'Refund', amount: -285, visible: true }, want.breakdown[4]];
    assert.deepEqual(row.pricing_snapshot, want);

    assert.equal(row.total, 955);
    assert.equal(row.paid, 955);
    assert.ok(row.updated_at.getTime() > before.updated_at.getTime());
    assert.notEqual(row.token, before.token); // a tab that saw the old lines is refused

    const v = validateAdjustments(row.adjustments); // the next editor save is accepted
    assert.equal(v.error, null);
    assert.deepEqual(v.value, row.adjustments);
  }
});

test('an overpayment-scope refund writes no line', async () => {
  // $200 paid above the contract, sitting uncredited on the charge.
  const o = await seed({ paidCents: 144000, pendingScope: 'overpayment', pendingCents: 20000 });
  const before = await readRow(o.proposalId);
  const { recon } = await reconcile(o, { amountCents: 20000, pendingRowId: o.pendingRowId });
  assert.equal(recon.applied, true);
  const row = await readRow(o.proposalId);
  assert.deepEqual(row.adjustments, before.adjustments);
  assert.deepEqual(row.pricing_snapshot, before.pricing_snapshot);
  assert.equal(row.total, 1240);
  assert.equal(row.paid, 1240);
});

test('a refund on an Additional Services invoice (extra scope) writes no line', async () => {
  const o = await seed({ paidCents: 20000, links: [{ label: 'Additional Services', cents: 20000 }] });
  const before = await readRow(o.proposalId);
  const { recon } = await reconcile(o, { amountCents: 20000 });
  assert.equal(recon.applied, true);
  const row = await readRow(o.proposalId);
  assert.deepEqual(row.adjustments, before.adjustments);
  assert.deepEqual(row.pricing_snapshot, before.pricing_snapshot);
  assert.equal(row.total, 1240); // extra scope never lowers the contract
});

test('a refund that walks a contract and an extra invoice writes a line for the contract part only, the exact total drop', async () => {
  // The walk takes the Additional Services link first ($200, extra) and then
  // $285 of the Balance link (contract).
  const o = await seed({
    totalDollars: 1440, paidCents: 144000, snapshot: bookingSnapshot(1440),
    links: [{ label: 'Additional Services', cents: 20000 }, { label: 'Balance', cents: 124000 }],
  });
  const { stripeRefundId } = await reconcile(o, { amountCents: 48500 });
  const rid = await refundRowId(stripeRefundId);
  const row = await readRow(o.proposalId);
  assert.deepEqual(refundLines(row), [refundLine(rid, 285)]);
  assert.equal(row.total, 1155);                 // 1440 - 285
  assert.equal(row.pricing_snapshot.total, 1155); // the same drop
  assert.equal(row.paid, 955);                   // 1440 - 485
});

test('re-running the same refund (applied: false) writes nothing more', async () => {
  const o = await seed();
  const first = await reconcile(o);
  const once = await readRow(o.proposalId);
  const again = await reconcile(o, { stripeRefundId: first.stripeRefundId });
  assert.equal(again.recon.applied, false);
  const twice = await readRow(o.proposalId);
  assert.deepEqual(twice.adjustments, once.adjustments);
  assert.deepEqual(twice.pricing_snapshot, once.pricing_snapshot);
  assert.equal(refundLines(twice).length, 1);
  assert.equal(twice.total, 955);
  assert.equal(twice.pricing_snapshot.total, 955);
});

test('Review Focus 3: on a booking whose snapshot drifted from total_price, both drop by exactly the refund and the drift stays', async () => {
  // The plan's shape (snapshot $20 above total_price) and prod 59's (total_price
  // $20 above its snapshot). Neither column is re-derived from the other.
  for (const snapshotTotal of [1260, 1220]) {
    const o = await seed({ snapshot: bookingSnapshot(snapshotTotal) });
    const { stripeRefundId } = await reconcile(o);
    const rid = await refundRowId(stripeRefundId);
    const row = await readRow(o.proposalId);
    assert.equal(row.total, 955);
    assert.equal(row.pricing_snapshot.total, snapshotTotal - 285);
    assert.equal(row.pricing_snapshot.total - row.total, snapshotTotal - 1240); // drift preserved
    assert.deepEqual(refundLines(row), [refundLine(rid, 285)]);
    assert.deepEqual(row.pricing_snapshot.adjustments.filter((a) => a.source === 'refund'),
      [refundLine(rid, 285)]);
  }
});

test('Review Focus 4: one overpayment and one contract refund on one booking leave exactly one line, the contract refund\'s', async () => {
  const o = await seed({ paidCents: 144000 }); // $200 uncredited headroom
  const over = await reconcile(o, { amountCents: 20000, totalScope: 'overpayment' });
  const contract = await reconcile(o, { amountCents: 28500, totalScope: 'contract' });
  const overId = await refundRowId(over.stripeRefundId);
  const contractId = await refundRowId(contract.stripeRefundId);
  assert.notEqual(overId, contractId);
  const row = await readRow(o.proposalId);
  assert.deepEqual(refundLines(row), [refundLine(contractId, 285)]);
  assert.deepEqual(row.pricing_snapshot.adjustments.filter((a) => a.source === 'refund'),
    [refundLine(contractId, 285)]);
  assert.equal(row.total, 955);
  assert.equal(row.paid, 955); // 1440 - 200 - 285
});

test('on an override booking (step 1 window) the line is written and the override is lowered, as today', async () => {
  const snapshot = { ...bookingSnapshot(800), total_price_override: 800 };
  const o = await seed({ totalDollars: 800, paidCents: 80000, override: 800, snapshot,
    links: [{ label: 'Balance', cents: 80000 }] });
  const { stripeRefundId } = await reconcile(o, { amountCents: 20000 });
  const rid = await refundRowId(stripeRefundId);
  const row = await readRow(o.proposalId);
  assert.equal(row.total, 600);
  assert.equal(row.override, 600);
  assert.equal(row.paid, 600);
  assert.deepEqual(row.adjustments, [DISCOUNT_A, refundLine(rid, 200)]);
  assert.equal(row.pricing_snapshot.total, 600);
});

test('a legal-hold booking reconciles its money unchanged and gets no line', async () => {
  const o = await seed();
  const before = await readRow(o.proposalId);
  __setLegalHoldIdsForTest([o.proposalId]);
  const { recon, stripeRefundId } = await reconcile(o);
  assert.equal(recon.applied, true);
  await refundRowId(stripeRefundId); // the refund row succeeded
  const row = await readRow(o.proposalId);
  assert.equal(row.total, 955);
  assert.equal(row.paid, 955);
  assert.deepEqual(row.adjustments, before.adjustments);
  assert.deepEqual(row.pricing_snapshot, before.pricing_snapshot);
  const log = await pool.query(
    `SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'refund_issued'`,
    [o.proposalId]
  );
  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0].details.contract_cents, 28500);
});

test('a hold list that cannot be read never rolls back the money: it reconciles, with no line', async () => {
  // A refactor that moves LEGAL_HOLD_PROPOSAL_IDS makes isLegalHold throw.
  // Stripe already moved this money, so the reconciliation must still land.
  const sweep = require('./staleProposalSweep');
  const real = sweep.LEGAL_HOLD_PROPOSAL_IDS;
  const o = await seed();
  const before = await readRow(o.proposalId);
  const originalError = console.error;
  console.error = () => {}; // the writer reports the skip; keep the run quiet
  sweep.LEGAL_HOLD_PROPOSAL_IDS = undefined;
  let out;
  try {
    out = await reconcile(o);
  } finally {
    sweep.LEGAL_HOLD_PROPOSAL_IDS = real;
    console.error = originalError;
  }
  assert.equal(out.recon.applied, true);
  await refundRowId(out.stripeRefundId);
  const row = await readRow(o.proposalId);
  assert.equal(row.total, 955);
  assert.equal(row.paid, 955);
  assert.deepEqual(row.adjustments, before.adjustments);
  assert.deepEqual(row.pricing_snapshot, before.pricing_snapshot);
});

test('two concurrent reconciliations of one refund apply it once: one line, one drop', async () => {
  // Two deliveries of one Stripe refund on two connections at once: the
  // proposals row lock makes the second wait, then see the first's succeeded
  // row. Both ways a row comes to exist: an adopted pending row (the panel's
  // reconcile and the sweep both adopting the issuing path's row), where the
  // row lock is the only guard (without it, total_price and amount_paid drop
  // twice), and a fresh insert, which the unique index on stripe_refund_id
  // also guards.
  for (const [i, opts] of [{ pendingScope: 'contract' }, {}].entries()) {
    const o = await seed(opts);
    const sameId = `re_${NONCE}_concurrent_${i}`;
    const results = await Promise.all([
      reconcile(o, { stripeRefundId: sameId, pendingRowId: o.pendingRowId }),
      reconcile(o, { stripeRefundId: sameId, pendingRowId: o.pendingRowId }),
    ]);
    assert.deepEqual(results.map((r) => r.recon.applied).sort(), [false, true], JSON.stringify(opts));
    const rid = await refundRowId(sameId);
    if (o.pendingRowId) assert.equal(rid, o.pendingRowId);
    const row = await readRow(o.proposalId);
    assert.deepEqual(refundLines(row), [refundLine(rid, 285)]);
    assert.equal(row.pricing_snapshot.breakdown.filter((r) => r.label === 'Refund').length, 1);
    assert.equal(row.total, 955);
    assert.equal(row.paid, 955);
    assert.equal(row.pricing_snapshot.total, 955);
  }
});
