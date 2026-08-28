// server/utils/invoiceLinking.overflowAlert.test.js
// spec 2026-08-28 §4e: an overflow reaches Dallas by email, from AFTER the
// transaction commits. The link itself only returns the figures; the caller
// emails from its post-commit tail. notifyAdminCategory runs pool.query, and
// calling it while the caller holds a transaction client is the
// one-pooled-connection deadlock this codebase has hit twice.
require('dotenv').config();
process.env.SENTRY_DSN_SERVER = '';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoiceLinking.overflowAlert.test.js refuses to run against production');
}

const notifyCalls = [];
const captureNotify = async (args) => { notifyCalls.push(args); return { emailed: 1, texted: 0 }; };
require('./adminNotifications').notifyAdminCategory = captureNotify;
const realWarn = console.warn;
console.warn = () => {};

const { linkPaymentToInvoice, linkOpenContractInvoice, notifyLinkOverflow } = require('./invoiceLinking');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
let clientId, proposalId, invoiceId, paymentId;

after(async () => {
  console.warn = realWarn;
  if (invoiceId) await pool.query('DELETE FROM invoice_payments WHERE invoice_id = $1', [invoiceId]);
  if (invoiceId) await pool.query('DELETE FROM invoices WHERE id = $1', [invoiceId]);
  if (proposalId) {
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('an overflowing link credits the cap, returns the figures and ids, and sends NO email itself', async () => {
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ('Overflow Alert', $1) RETURNING id`, [`ovf-${NONCE}@example.test`]);
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, event_date, event_start_time, event_duration_hours, event_type)
     VALUES ($1, 'accepted', 550, 550, 100, CURRENT_DATE + INTERVAL '30 days', '6:00 PM', 4, 'Cocktail Party') RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  const i = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Deposit', 10000, 0, 'sent', false) RETURNING id`,
    [proposalId, `OVF${NONCE}`]
  );
  invoiceId = i.rows[0].id;
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status) VALUES ($1, 'full', 55000, 'succeeded') RETURNING id`,
    [proposalId]
  );
  paymentId = pay.rows[0].id;

  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await linkPaymentToInvoice(invoiceId, paymentId, 55000, client);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  assert.equal(result.linked, true);
  assert.equal(result.creditedCents, 10000);
  assert.equal(result.overflowCents, 45000);
  assert.equal(result.proposalId, proposalId);
  assert.equal(result.invoiceId, invoiceId);
  assert.equal(notifyCalls.length, 0, 'the link never emails from inside the transaction');
});

test('notifyLinkOverflow emails the money-anomaly lane once, email only, naming the figures', async () => {
  await notifyLinkOverflow({ proposalId: 774, invoiceId: 336, paymentId: 362, amountCents: 55000, creditCents: 10000, overflowCents: 45000 });
  assert.equal(notifyCalls.length, 1);
  const call = notifyCalls[0];
  assert.equal(call.category, 'payment_failure');
  assert.ok(call.subject.includes('#774'), `subject names the proposal: ${call.subject}`);
  assert.ok(call.emailText.includes('$450.00'), `text names the dropped amount: ${call.emailText}`);
  assert.ok(call.emailText.includes('$100.00'), `text names the credited amount: ${call.emailText}`);
  assert.equal(call.smsBody, undefined, 'email only; SMS costs money');
});

test('notifyLinkOverflow never throws when the notifier fails', async () => {
  require('./adminNotifications').notifyAdminCategory = async () => { throw new Error('resend down'); };
  try {
    await assert.doesNotReject(() => notifyLinkOverflow({ proposalId: 1, invoiceId: 2, paymentId: 3, amountCents: 100, creditCents: 50, overflowCents: 50 }));
  } finally {
    // Put the capturing stub back, or every test appended below this one
    // silently inherits a notifier that throws.
    require('./adminNotifications').notifyAdminCategory = captureNotify;
  }
});

test('notifyLinkOverflow never rejects when called with no argument at all', async () => {
  // Parameter destructuring runs during BINDING, outside the try, so a bare call
  // used to reject past the catch. The destructure now lives inside the try over
  // `args || {}`, which covers notifyLinkOverflow(null) as well as this one.
  // Tasks 3 to 5 call this from webhook post-commit tails, where an unhandled
  // rejection is the whole risk. The call count proves it reached the notifier
  // rather than being swallowed on the way in.
  const before = notifyCalls.length;
  await assert.doesNotReject(() => notifyLinkOverflow());
  assert.equal(notifyCalls.length, before + 1, 'the bare call got past binding and actually sent');
});

test('notifyLinkOverflow never rejects on a null argument either (destructure inside the try)', async () => {
  const before = notifyCalls.length;
  await assert.doesNotReject(() => notifyLinkOverflow(null));
  assert.equal(notifyCalls.length, before + 1, 'null got past binding and reached the notifier');
});

test('notifyLinkOverflow reads the link result spread straight through (creditedCents), never "$0.00 was credited"', async () => {
  const before = notifyCalls.length;
  await notifyLinkOverflow({ proposalId: 774, invoiceId: 336, paymentId: 362, amountCents: 55000, creditedCents: 10000, overflowCents: 45000 });
  const call = notifyCalls[before];
  assert.ok(call.emailText.includes('$100.00 was credited'), `credited figure comes from creditedCents: ${call.emailText}`);
  assert.ok(!call.emailText.includes('$0.00'), `no zero figure anywhere: ${call.emailText}`);
});

test('a refused link carries the whole payment as overflow, with the ids the email needs', async () => {
  // The first test left the invoice paid and locked; a second credit is refused.
  const res = await linkPaymentToInvoice(invoiceId, paymentId, 5000, pool);
  assert.equal(res.linked, false);
  assert.equal(res.reason, 'not_payable');
  assert.equal(res.creditedCents, 0);
  assert.equal(res.overflowCents, 5000, 'to the ledger a refused credit is a total overflow');
  assert.equal(res.proposalId, proposalId);
  assert.equal(res.invoiceId, invoiceId);
});

test('linkOpenContractInvoice: a zero-due open invoice refuses, and the payload emails as a total overflow', async () => {
  // A 'sent' row with nothing due is the shape refreshUnlockedInvoices can leave
  // behind after a price drop; before, the capture went unlinked with only a
  // Sentry warning. Now the shared link returns the payload and the email fires.
  const zero = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Balance', 0, 0, 'sent', false) RETURNING id`,
    [proposalId, `OVZ${NONCE}`]
  );
  try {
    const payload = await linkOpenContractInvoice(proposalId, paymentId, 5000, pool);
    assert.ok(payload, 'a refusal is an overflow payload, not null');
    assert.equal(payload.linked, false);
    assert.equal(payload.reason, 'no_remaining_due');
    assert.equal(payload.overflowCents, 5000);
    assert.equal(payload.creditCents, 0);
    assert.equal(payload.amountCents, 5000);
    assert.equal(payload.paymentId, paymentId);
    assert.equal(payload.invoiceId, zero.rows[0].id);
    const before = notifyCalls.length;
    await notifyLinkOverflow(payload);
    const call = notifyCalls[before];
    assert.ok(call.emailText.includes('refused the credit (no_remaining_due)'), call.emailText);
    assert.ok(call.emailText.includes('$50.00 has no invoice'), call.emailText);
  } finally {
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id = $1', [zero.rows[0].id]);
    await pool.query('DELETE FROM invoices WHERE id = $1', [zero.rows[0].id]);
  }
});

test('linkOpenContractInvoice: no open invoice at all is null, not a payload', async () => {
  // The invoice from the first test is paid and locked; nothing is open.
  assert.equal(await linkOpenContractInvoice(proposalId, paymentId, 5000, pool), null);
});
