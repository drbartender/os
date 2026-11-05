// The dispute ledger's arithmetic (audit PAY-04, 2026-11-05): what a
// withdrawal writes through the reconciler under 'dispute' scope, and what a
// reinstatement reverses.
//
// PURE: a scripted transaction client answers every read by SQL shape and
// records every statement; nothing else is stubbed, so the real
// applyRefundReconciliation runs with its dispute scope. The report's cents: a
// 90000 balance payment linked to a locked, paid Balance invoice on a 100000
// contract paid in full.
//
//   node --test server/utils/disputeLedger.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recordDisputeWithdrawal, reverseDisputeWithdrawal, findDisputedPayment } = require('./disputeLedger');

function scripted({ status = 'balance_paid', totalPrice = '1000.00', amountPaid = '1000.00', refundRow = null, reversals = [] } = {}) {
  const queries = [];
  let paid = Number(amountPaid);
  const client = {
    queries,
    async query(text, params) {
      queries.push({ text, params });
      if (/FROM proposals WHERE id = \$1 FOR UPDATE/.test(text)) return { rows: [{ status, total_price: totalPrice, amount_paid: String(paid) }], rowCount: 1 };
      if (/FROM proposal_refunds WHERE stripe_refund_id = \$1 AND status = 'succeeded'/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO proposal_refunds/.test(text)) return { rows: [{ id: 900 }], rowCount: 1 };
      if (/FROM invoice_payments ip\s+JOIN invoices i ON i\.id = ip\.invoice_id\s+WHERE ip\.payment_id = \$1 AND i\.label = ANY/.test(text)) return { rows: [], rowCount: 0 }; // not off-ledger
      if (/AS headroom/.test(text)) return { rows: [{ headroom: 0 }], rowCount: 1 };
      if (/HAVING SUM\(ip\.amount\) > 0/.test(text)) {
        return { rows: [{ invoice_id: 77, invoice_label: 'Balance', invoice_locked: true, net_applied: 90000 }], rowCount: 1 };
      }
      if (/UPDATE invoices/.test(text) && /RETURNING amount_due, amount_paid/.test(text)) {
        // The Balance invoice: due 90000; paid moves by the statement's delta.
        const delta = Number(params[0]);
        const dropsDue = /amount_due\s*=\s*GREATEST/.test(text);
        return { rows: [{ amount_due: dropsDue ? 90000 - delta : 90000, amount_paid: /\+ \$1/.test(text) ? delta : 90000 - delta }], rowCount: 1 };
      }
      if (/UPDATE proposals/.test(text) && /amount_paid = GREATEST\(amount_paid - \(\$2/.test(text)) {
        paid -= Number(params[1]) / 100;
        return { rows: [{ total_price: totalPrice, amount_paid: String(paid), total_price_override: null }], rowCount: 1 };
      }
      if (/UPDATE proposals SET amount_paid = amount_paid \+ \(\$1/.test(text)) {
        paid += Number(params[0]) / 100;
        return { rows: [{ total_price: totalPrice, amount_paid: String(paid) }], rowCount: 1 };
      }
      if (/FROM proposal_refunds\s+WHERE stripe_refund_id = \$1 AND proposal_id = \$2 AND status = 'succeeded' AND total_scope = 'dispute'/.test(text)) {
        return { rows: refundRow ? [refundRow] : [], rowCount: refundRow ? 1 : 0 };
      }
      if (/WHERE ip\.refund_id = \$1 AND ip\.amount < 0/.test(text)) return { rows: reversals, rowCount: reversals.length };
      return { rows: [], rowCount: 1 };
    },
  };
  return client;
}

const sql = (client, re) => client.queries.filter((q) => re.test(q.text));

test('a withdrawal lowers amount_paid by the disputed cents, re-opens the invoice at its full demand, leaves total_price alone and demotes the status with autopay disarmed', async () => {
  const client = scripted();
  const recon = await recordDisputeWithdrawal({
    proposalId: 4242, paymentId: 501, paymentIntentId: 'pi_balance', disputeId: 'dp_1', amountCents: 90000, disputeReason: 'fraudulent',
  }, client);
  assert.equal(recon.applied, true);

  const ins = sql(client, /INSERT INTO proposal_refunds/)[0];
  assert.equal(ins.params[3], 'dp_1', 'the dispute id in stripe_refund_id');
  assert.equal(ins.params[4], 90000);
  assert.match(ins.params[5], /Chargeback: Stripe dispute dp_1/);
  assert.equal(ins.params[8], 'dispute', 'total_scope');

  const invUpd = sql(client, /UPDATE invoices\s+SET amount_paid = GREATEST/)[0];
  assert.ok(invUpd, 'the Balance invoice credit is reversed');
  assert.doesNotMatch(invUpd.text, /amount_due\s*=/, 'the demand is NOT lowered: the invoice is owed again');
  assert.equal(invUpd.params[0], 90000);
  const statusUpd = sql(client, /UPDATE invoices SET status = \$1/)[0];
  assert.equal(statusUpd.params[0], 'partially_paid', 'paid 0 of 90000: payable again');
  const reversal = sql(client, /INSERT INTO invoice_payments/)[0];
  assert.deepEqual(reversal.params, [77, 501, -90000, 900]);

  const money = sql(client, /UPDATE proposals\s+SET total_price = GREATEST/)[0];
  assert.equal(money.params[0], 0, 'contract cents: total_price does not move');
  assert.equal(money.params[1], 90000, 'amount_paid drops by the whole withdrawal');
  const statusMove = sql(client, /UPDATE proposals SET status = \$1, autopay_enrolled = false/)[0];
  assert.ok(statusMove, 'balance_paid -> deposit_paid disarms autopay');
  assert.equal(statusMove.params[0], 'deposit_paid');
  assert.ok(sql(client, /'dispute_funds_withdrawn'/).length === 1);
  const log = sql(client, /'refund_issued'/)[0];
  assert.equal(JSON.parse(log.params[3]).total_scope, 'dispute');
});

test('a reinstatement re-credits the invoice, restores amount_paid, promotes the status back and marks the row failed', async () => {
  const client = scripted({
    status: 'deposit_paid', amountPaid: '100.00',
    refundRow: { id: 900, payment_id: 501, amount: 90000 },
    reversals: [{ invoice_id: 77, take: 90000, label: 'Balance' }],
  });
  const r = await reverseDisputeWithdrawal({ proposalId: 4242, disputeId: 'dp_1' }, client);
  assert.deepEqual(r, { reversed: true, amountCents: 90000 });
  const credit = sql(client, /INSERT INTO invoice_payments/)[0];
  assert.deepEqual(credit.params, [77, 501, 90000, 900], 'a positive row stamped with the same refund id');
  const invUpd = sql(client, /UPDATE invoices SET amount_paid = amount_paid \+ \$1/)[0];
  assert.equal(invUpd.params[0], 90000);
  assert.equal(sql(client, /UPDATE invoices SET status = \$1/)[0].params[0], 'paid');
  assert.ok(sql(client, /SET locked = true/).length === 1, 'a fully re-paid invoice locks again');
  const money = sql(client, /UPDATE proposals SET amount_paid = amount_paid \+/)[0];
  assert.equal(money.params[0], 90000);
  const statusMove = sql(client, /UPDATE proposals SET status = \$1 WHERE/)[0];
  assert.equal(statusMove.params[0], 'balance_paid', 'the ladder promotes in both directions');
  assert.doesNotMatch(statusMove.text, /autopay_enrolled/, 'autopay is not re-armed');
  const rowUpd = sql(client, /UPDATE proposal_refunds SET status = 'failed'/)[0];
  assert.deepEqual(rowUpd.params, [900]);
  assert.ok(sql(client, /'dispute_funds_reinstated'/).length === 1);
});

test('a reinstatement with no recorded withdrawal (or one already reversed) writes nothing', async () => {
  const client = scripted({ status: 'deposit_paid', amountPaid: '100.00' });
  const r = await reverseDisputeWithdrawal({ proposalId: 4242, disputeId: 'dp_1' }, client);
  assert.deepEqual(r, { reversed: false, amountCents: 0 });
  assert.equal(sql(client, /^\s*(UPDATE|INSERT)/).length, 0, 'reads only (the FOR UPDATE locks), no writes');
});

test('findDisputedPayment nets earlier refunds and disputes out of the remainder', async () => {
  const db = { async query(text, params) {
    assert.match(text, /pr\.status IN \('succeeded', 'pending'\)/);
    return { rows: [{ id: 501, proposal_id: 4242, amount: 90000, remaining: 40000 }], rowCount: 1, params };
  } };
  assert.deepEqual(await findDisputedPayment('pi_balance', db), { id: 501, proposalId: 4242, amountCents: 90000, remainingCents: 40000 });
  assert.equal(await findDisputedPayment(null, db), null);
});
