// Card disputes on proposal charges and on tips (audit PAY-04 and POUT-06,
// 2026-11-05).
//
// THE DEFECTS. (PAY-04) The dispatcher routed only funds_withdrawn and
// funds_reinstated, and both handlers only clawed TIPS: a chargeback on a
// deposit, balance, full, invoice or extras payment changed nothing (the row
// stayed paid, no refund-ledger row, no admin alert), so a later refund or
// cancellation could return money the bank had already taken. (POUT-06) The
// tip clawback was handed dispute.amount as if it were the cumulative refunded
// total, so a tip partly refunded 3,000 and then disputed for the remaining
// 7,000 clawed 4,000 instead of 7,000.
//
// PURE, the narrowest seam: the handlers are called directly with their
// events; pool.query answers the lookups; pool.connect hands the withdrawal a
// scripted client; the reconciler, the clawback and the admin alert are
// observed through stubs installed on their modules before the handler is
// required (the handler destructures them at load).
//
//   node --test server/routes/stripeWebhookHandlers/disputes.test.js
process.env.SEND_NOTIFICATIONS = 'false';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../../db');

const reconCalls = [];
require('../../utils/refundHelpers').applyRefundReconciliation = async (args) => { reconCalls.push(args); return { applied: true }; };
// The tip clawback is NOT stubbed: the real clawbackTip runs against the
// scripted transaction client below (an unplaced tip, shift_id NULL, takes the
// two-statement path: the locked read, then the refunded_amount_cents write),
// so the cumulative it writes is what the test observes.
const adminAlerts = [];
require('../../utils/adminNotifications').notifyAdminCategory = async (args) => { adminAlerts.push(args); };

const { handleDisputeCreated, handleDisputeFundsWithdrawn, handleDisputeFundsReinstated } = require('./disputes');

// What the database holds: at most one tip and one proposal payment per intent.
let tips = {};        // pi -> { id, amount_cents, refunded_amount_cents }
let payments = {};    // pi -> { id, proposal_id, amount, remaining }
let seenDisputes = new Set();
const queries = [];
const txQueries = [];

const realQuery = pool.query;
const realConnect = pool.connect;
pool.query = async (text, params) => {
  queries.push({ text, params });
  if (/FROM tips WHERE stripe_payment_intent_id/.test(text)) {
    const t = tips[params[0]];
    return { rows: t ? [t] : [], rowCount: t ? 1 : 0 };
  }
  if (/FROM proposal_payments pp/.test(text)) {
    const p = payments[params[0]];
    return { rows: p ? [p] : [], rowCount: p ? 1 : 0 };
  }
  if (/action = 'dispute_opened'/.test(text)) {
    const hit = seenDisputes.has(params[1]);
    return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 };
  }
  if (/INSERT INTO proposal_activity_log/.test(text) && /'dispute_opened'/.test(text)) {
    seenDisputes.add(JSON.parse(params[1]).dispute_id);
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};
pool.connect = async () => ({
  release() {},
  async query(text, params) {
    txQueries.push({ text, params });
    if (/FROM tips WHERE id = \$1 FOR UPDATE/.test(text)) {
      const t = Object.values(tips).find((x) => x.id === params[0]);
      return { rows: t ? [{ ...t, shift_id: null, fee_cents: 0, target_user_id: 1, deferred_at: null, defer_kind: null }] : [], rowCount: t ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
  },
});
const tipWrites = () => txQueries.filter((q) => /UPDATE tips SET refunded_amount_cents = \$1/.test(q.text)).map((q) => q.params);
process.on('exit', () => { pool.query = realQuery; pool.connect = realConnect; });

beforeEach(() => {
  tips = {}; payments = {}; seenDisputes = new Set();
  queries.length = 0; txQueries.length = 0; reconCalls.length = 0; adminAlerts.length = 0;
});

const withdrawn = (over = {}) => ({ data: { object: { id: 'dp_1', payment_intent: 'pi_balance', amount: 90000, reason: 'fraudulent', ...over } } });

test('PAY-04: funds withdrawn on a balance payment are recorded on the refund ledger as a dispute, in a transaction, and the admin is told', async () => {
  payments.pi_balance = { id: 501, proposal_id: 4242, amount: 90000, remaining: 90000 };
  await handleDisputeFundsWithdrawn(withdrawn());
  assert.equal(reconCalls.length, 1, 'the reconciler recorded the withdrawal');
  const r = reconCalls[0];
  assert.equal(r.proposalId, 4242);
  assert.equal(r.paymentId, 501);
  assert.equal(r.paymentIntentId, 'pi_balance');
  assert.equal(r.stripeRefundId, 'dp_1', 'the dispute id is the idempotency anchor');
  assert.equal(r.amountCents, 90000);
  assert.equal(r.totalScope, 'dispute');
  assert.equal(r.allowPendingHeuristic, false);
  assert.match(r.reason, /Chargeback/);
  assert.deepEqual(txQueries.map((q) => q.text).filter((t) => t === 'BEGIN' || t === 'COMMIT'), ['BEGIN', 'COMMIT']);
  assert.ok(txQueries.some((q) => /'dispute_funds_withdrawn'/.test(q.text)), 'an activity row');
  assert.equal(adminAlerts.length, 1);
  assert.match(adminAlerts[0].subject, /Chargeback withdrew \$900\.00 from proposal #4242/);
  assert.equal(tipWrites().length, 0, 'no tip clawback on a proposal charge');
});

test('PAY-04: the withdrawal is capped at what is still on the charge, and an already-refunded charge only alerts', async () => {
  payments.pi_balance = { id: 501, proposal_id: 4242, amount: 90000, remaining: 40000 };
  await handleDisputeFundsWithdrawn(withdrawn());
  assert.equal(reconCalls[0].amountCents, 40000);

  reconCalls.length = 0; adminAlerts.length = 0;
  payments.pi_balance = { id: 501, proposal_id: 4242, amount: 90000, remaining: 0 };
  await handleDisputeFundsWithdrawn(withdrawn({ id: 'dp_2' }));
  assert.equal(reconCalls.length, 0, 'nothing recorded');
  assert.equal(adminAlerts.length, 1);
  assert.match(adminAlerts[0].subject, /already refunded/);
});

test('PAY-04: a dispute on a charge that is neither a tip nor a proposal payment changes nothing', async () => {
  await handleDisputeFundsWithdrawn(withdrawn({ payment_intent: 'pi_unknown' }));
  assert.equal(reconCalls.length, 0);
  assert.equal(adminAlerts.length, 0);
  assert.equal(txQueries.length, 0);
});

test('PAY-04: dispute.created on a proposal charge records it once and alerts once, even when redelivered', async () => {
  payments.pi_balance = { id: 501, proposal_id: 4242, amount: 90000, remaining: 90000 };
  const created = { data: { object: { id: 'dp_1', payment_intent: 'pi_balance', amount: 90000, reason: 'fraudulent', evidence_details: { due_by: 1780000000 } } } };
  await handleDisputeCreated(created);
  await handleDisputeCreated(created);
  const inserts = queries.filter((q) => /INSERT INTO proposal_activity_log/.test(q.text) && /'dispute_opened'/.test(q.text));
  assert.equal(inserts.length, 1);
  assert.equal(JSON.parse(inserts[0].params[1]).dispute_id, 'dp_1');
  assert.equal(adminAlerts.length, 1);
  assert.match(adminAlerts[0].subject, /Chargeback opened on proposal #4242/);
});

test('PAY-04: dispute.created on a tip is left to the tip flow', async () => {
  tips.pi_tip = { id: 7, amount_cents: 10000, refunded_amount_cents: 0 };
  await handleDisputeCreated({ data: { object: { id: 'dp_t', payment_intent: 'pi_tip', amount: 10000 } } });
  assert.equal(adminAlerts.length, 0);
  assert.equal(queries.filter((q) => /INSERT INTO proposal_activity_log/.test(q.text)).length, 0);
});

test('POUT-06: a tip refunded 3,000 then disputed for 7,000 claws to the cumulative 10,000, not to 7,000', async () => {
  tips.pi_tip = { id: 7, amount_cents: 10000, refunded_amount_cents: 3000 };
  await handleDisputeFundsWithdrawn(withdrawn({ payment_intent: 'pi_tip', amount: 7000 }));
  assert.deepEqual(tipWrites(), [[10000, 7]], 'refunded_amount_cents written as the summed cumulative');
  assert.equal(reconCalls.length, 0, 'a tip never touches the proposal ledger');
});

test('POUT-06: the cumulative is capped at the tip amount', async () => {
  tips.pi_tip = { id: 7, amount_cents: 10000, refunded_amount_cents: 3000 };
  await handleDisputeFundsWithdrawn(withdrawn({ payment_intent: 'pi_tip', amount: 9000 }));
  assert.deepEqual(tipWrites(), [[10000, 7]]);
});

test('PAY-04: funds reinstated on a proposal charge reverse the recorded withdrawal in a transaction and alert', async () => {
  payments.pi_balance = { id: 501, proposal_id: 4242, amount: 90000, remaining: 0 };
  const reverseCalls = [];
  require('../../utils/disputeLedger').reverseDisputeWithdrawal = async (args) => { reverseCalls.push(args); return { reversed: true, amountCents: 90000 }; };
  // The handler destructured the real function at load; re-require a fresh
  // copy so the stub is what it calls.
  delete require.cache[require.resolve('./disputes')];
  const fresh = require('./disputes');
  const res = { headersSent: false, body: null, json(b) { this.headersSent = true; this.body = b; return this; } };
  await fresh.handleDisputeFundsReinstated({ data: { object: { id: 'dp_1', payment_intent: 'pi_balance', amount: 90000, created: 1780000000 } } }, res);
  assert.deepEqual(reverseCalls, [{ proposalId: 4242, disputeId: 'dp_1' }]);
  assert.deepEqual(txQueries.map((q) => q.text).filter((t) => t === 'BEGIN' || t === 'COMMIT'), ['BEGIN', 'COMMIT']);
  assert.equal(adminAlerts.length, 1);
  assert.match(adminAlerts[0].subject, /Chargeback won/);
  assert.deepEqual(res.body, { received: true });
});

test('funds reinstated on a tip still rewinds the clawback and acks (unchanged)', async () => {
  tips.pi_tip = { id: 7, amount_cents: 10000, refunded_amount_cents: 10000 };
  const res = { headersSent: false, body: null, json(b) { this.headersSent = true; this.body = b; return this; } };
  await handleDisputeFundsReinstated({ data: { object: { id: 'dp_t', payment_intent: 'pi_tip', amount: 7000 } } }, res);
  assert.deepEqual(res.body, { received: true });
  assert.equal(adminAlerts.length, 0, 'the tip flow notifies through payrollDisputeNotify, not here');
});
