// createBalanceInvoice's idempotency on an open Full Payment invoice (round 2
// L1, 2026-11-05).
//
// THE DEFECT. The helper refused a second Balance only when a Balance already
// existed, so a partial payment on a row whose open contract invoice is a Full
// Payment invoice (the admin record-payment door after PAY-05, and the webhook
// deposit branch on the same shape) minted a Balance beside it: two open
// invoices demanding the same remainder. The guard now also stands down while
// an open Full Payment invoice (sent or partially_paid) demands the remainder,
// inside the helper so every caller is covered.
//
// PURE: a scripted client answers the helper's reads by SQL shape and records
// every statement.
//
//   node --test server/utils/invoiceLifecycle.balanceGuard.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBalanceInvoice } = require('./invoiceLifecycle');

function scriptedClient({ blocking = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (/FROM invoices WHERE proposal_id = \$1 AND status <> 'void'\s+AND \(label = 'Balance'/.test(text)) {
        return { rows: blocking, rowCount: blocking.length };
      }
      if (/SELECT total_price, amount_paid, balance_due_date/.test(text)) {
        return { rows: [{ total_price: '1000.00', amount_paid: '100.00', balance_due_date: null }], rowCount: 1 };
      }
      if (/nextval\('invoice_number_seq'\)/.test(text)) return { rows: [{ val: 42 }], rowCount: 1 };
      if (/INSERT INTO invoices/.test(text)) {
        return { rows: [{ id: 900, proposal_id: params[0], label: params[2], amount_due: params[3], status: params[4] }], rowCount: 1 };
      }
      if (/FROM proposals p\s+LEFT JOIN service_packages sp/.test(text)) {
        return { rows: [{ id: 4242, pricing_snapshot: { total: 1000, base_cost: 1000 }, package_id: null, total_price: '1000.00', package_name: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}
const mints = (client) => client.calls.filter((c) => /INSERT INTO invoices/.test(c.text));

test('an open Full Payment invoice already demanding the remainder: no Balance is minted', async () => {
  const client = scriptedClient({ blocking: [{ id: 66 }] });
  assert.equal(await createBalanceInvoice(4242, client), null);
  assert.equal(mints(client).length, 0);
  const guard = client.calls[0].text;
  assert.match(guard, /label = 'Balance'/);
  assert.match(guard, /label = 'Full Payment' AND status IN \('sent', 'partially_paid'\)/, 'only an OPEN Full Payment stands in the way');
  assert.match(guard, /status <> 'void'/);
});

test('nothing in the way: the Balance is minted at the netted remainder', async () => {
  const client = scriptedClient();
  const inv = await createBalanceInvoice(4242, client);
  assert.ok(inv, 'minted');
  assert.equal(mints(client).length, 1);
  assert.equal(mints(client)[0].params[2], 'Balance');
  assert.equal(mints(client)[0].params[3], 90000, '100000 - 10000');
});
