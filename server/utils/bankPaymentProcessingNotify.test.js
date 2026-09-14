// server/utils/bankPaymentProcessingNotify.test.js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { bankPaymentProcessingClient } = require('./lifecycleEmailTemplates');
const emailTemplates = require('./emailTemplates');
// Spy on the admin fan-out BEFORE the notifier binds it, so the category
// branch (the point of the admin email) is asserted, not assumed.
const adminCalls = [];
require('./adminNotifications').notifyAdminCategory = async (args) => { adminCalls.push(args); return { sent: 1 }; };
const { notifyClientBankPaymentProcessing, notifyAdminBankPaymentProcessing } = require('./bankPaymentProcessingNotify');

if (process.env.NODE_ENV === 'production') {
  throw new Error('bankPaymentProcessingNotify.test.js refuses to run against production');
}

const MARK = `bpn-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const clientIds = [];
const proposalIds = [];

async function seed({ emailStatus = 'ok', email = `${MARK}-${clientIds.length}@example.com` } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email, email_status) VALUES ('Bank Notify Test', $1, $2) RETURNING id`,
    [email, emailStatus]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid, pricing_snapshot, token, event_date, event_timezone)
     VALUES ($1, 'deposit_paid', 'Cocktail Party', 500, 100, '{}'::jsonb, $2, DATE '2026-09-19', 'America/Chicago') RETURNING id`,
    [c.rows[0].id, crypto.randomUUID()]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

after(async () => {
  if (proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('bankPaymentProcessingClient > subject, dollars, noun, the clearing line, no em dash', () => {
  const t = bankPaymentProcessingClient({
    clientName: 'Thekla Eftychiadou', amountCents: 40000, paymentType: 'invoice',
    eventTypeLabel: 'Cocktail Party', eventDate: 'Saturday, September 19', proposalUrl: 'https://drbartender.com/proposal/x',
  });
  assert.equal(t.subject, 'We received your bank payment');
  assert.match(t.html, /\$400\.00/);
  // The plan's template renders the AMOUNT in <strong>, then the noun outside it;
  // this regex asserts the same four things the plan's version did (dollars, the
  // 'payment' noun, the event label, the date) against that markup.
  assert.match(t.html, /<strong>\$400\.00<\/strong> payment for your <strong>Cocktail Party<\/strong> on Saturday, September 19/);
  assert.match(t.text, /four to six business days to clear/);
  assert.match(t.text, /nothing more is needed from you/);
  assert.ok(!t.html.includes('—') && !t.text.includes('—'));
  const dep = bankPaymentProcessingClient({ clientName: 'A', amountCents: 10000, paymentType: 'deposit', eventTypeLabel: 'event', eventDate: null, proposalUrl: 'u' });
  assert.match(dep.text, /\$100\.00 deposit for your event\./);
  assert.equal(emailTemplates.bankPaymentProcessingClient, bankPaymentProcessingClient, 're-exported for property access');
});

test('notifyClientBankPaymentProcessing > sends (logged only under the test flag) for a good address', async () => {
  const id = await seed();
  const r = await notifyClientBankPaymentProcessing({ proposalId: id, amountCents: 40000, paymentType: 'invoice' });
  assert.deepEqual(r, { sent: true });
});

test('notifyClientBankPaymentProcessing > a bad address is skipped the way the receipt skips it', async () => {
  const id = await seed({ emailStatus: 'bad' });
  const r = await notifyClientBankPaymentProcessing({ proposalId: id, amountCents: 40000, paymentType: 'invoice' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'bad_contact');
});

test('notifyClientBankPaymentProcessing > never throws: an unknown proposal resolves sent:false', async () => {
  const r = await notifyClientBankPaymentProcessing({ proposalId: -1, amountCents: 1, paymentType: 'deposit' });
  assert.equal(r.sent, false);
});

test('notifyAdminBankPaymentProcessing > a deposit is an urgent booking, an invoice payment is routine finance, and it never throws', async () => {
  const id = await seed();
  adminCalls.length = 0;
  const r = await notifyAdminBankPaymentProcessing({ proposalId: id, amountCents: 10000, paymentType: 'deposit' });
  assert.equal(r.sent, true);
  assert.equal(adminCalls.length, 1);
  assert.equal(adminCalls[0].category, 'urgent_booking');
  assert.match(adminCalls[0].subject, /^Bank payment processing: Bank Notify Test \(Cocktail Party\)$/);
  assert.match(adminCalls[0].emailText, /\$100\.00 \(deposit\)/);
  assert.ok(!adminCalls[0].emailText.includes('—'));
  await notifyAdminBankPaymentProcessing({ proposalId: id, amountCents: 40000, paymentType: 'invoice' });
  assert.equal(adminCalls[1].category, 'routine_finance');
  const none = await notifyAdminBankPaymentProcessing({ proposalId: -1, amountCents: 1, paymentType: 'deposit' });
  assert.equal(none.sent, false);
});
