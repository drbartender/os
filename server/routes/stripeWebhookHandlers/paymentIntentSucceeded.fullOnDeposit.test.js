// A FULL payment on a deposit-terms proposal (spec 2026-08-28 §4b). Before
// this lane the webhook credited 100 dollars of a 550 dollar capture onto the
// send-time Deposit invoice and dropped 450 into a Sentry warning. Afterwards
// there is exactly one contract invoice, Full Payment, at the capture amount,
// paid and locked, and the link overflows nothing. A DEPOSIT payment on the
// same shape is pinned unchanged, and a full intent on an ARCHIVED proposal
// never upgrades.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
process.env.SENTRY_DSN_SERVER = '';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('paymentIntentSucceeded.fullOnDeposit.test.js refuses to run against production');
}

const overflowCalls = [];
require('../../utils/email').sendEmail = async () => ({ skipped: true });
require('../../utils/adminNotifications').notifyAdminCategory = async () => ({ emailed: 0, texted: 0 });
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};
require('../../utils/marketingHandlers').cancelMarketingForProposal = async () => {};
require('../../utils/depositPaidSchedulers').scheduleDepositPaidReminders = async () => {};
require('../../utils/stripePaymentNotifications').sendPaymentNotifications = async () => {};
require('../../utils/lastMinuteAlert').notifyLastMinuteBooking = () => {};
require('../../utils/invoiceHelpers').notifyLinkOverflow = async (args) => { overflowCalls.push(args); };

const handlePaymentIntentSucceeded = require('./paymentIntentSucceeded');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
let seq = 0;
const clientIds = [];
const proposalIds = [];

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };

async function seed({ paymentType, status = 'accepted' }) {
  seq += 1;
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ('Full On Deposit', $1) RETURNING id`, [`fod-${NONCE}-${seq}@example.test`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, external_paid,
                            pricing_snapshot, event_date, event_start_time, event_duration_hours,
                            event_type, payment_type, client_signed_at, balance_due_date)
     VALUES ($1, $2, 550, 0, 100, 0,
             '{"package": {"name": "The Core Reaction", "base_cost": 350}, "total": 550}'::jsonb,
             CURRENT_DATE + INTERVAL '30 days', '6:00 PM', 4, 'Cocktail Party', $3, NOW(),
             CURRENT_DATE + INTERVAL '16 days')
     RETURNING id`,
    [c.rows[0].id, status, paymentType]
  );
  proposalIds.push(p.rows[0].id);
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Deposit', 10000, 0, 'sent', false)`,
    [p.rows[0].id, `FOD${NONCE}${seq}`]
  );
  return p.rows[0].id;
}

function event({ proposalId, paymentType, amountCents }) {
  return { data: { object: { id: `pi_test_${NONCE}_${seq}`, amount: amountCents, payment_method: null, metadata: { proposal_id: String(proposalId), payment_type: paymentType } } } };
}

const contractInvoices = async (proposalId) => (await pool.query(
  `SELECT id, label, amount_due, amount_paid, status, locked FROM invoices
    WHERE proposal_id = $1 AND status <> 'void' AND label IN ('Deposit', 'Balance', 'Full Payment') ORDER BY id`, [proposalId]
)).rows;
const upgrades = async (proposalId) => (await pool.query(
  "SELECT 1 FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'invoice_upgraded_to_full'", [proposalId]
)).rowCount;

after(async () => {
  console.warn = realWarn;
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = ANY($2::int[])', ['proposal', ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('a FULL payment on deposit terms ends with one Full Payment invoice at the capture, paid, locked, no overflow, no email', async () => {
  const proposalId = await seed({ paymentType: 'full' });
  warnings.length = 0;
  await handlePaymentIntentSucceeded(event({ proposalId, paymentType: 'full', amountCents: 55000 }));

  const invs = await contractInvoices(proposalId);
  assert.equal(invs.length, 1, `expected one contract invoice, got ${JSON.stringify(invs)}`);
  assert.equal(invs[0].label, 'Full Payment');
  assert.equal(Number(invs[0].amount_due), 55000);
  assert.equal(Number(invs[0].amount_paid), 55000);
  assert.equal(invs[0].status, 'paid');
  assert.equal(invs[0].locked, true);
  const link = (await pool.query('SELECT amount FROM invoice_payments WHERE invoice_id = $1', [invs[0].id])).rows;
  assert.equal(link.length, 1);
  assert.equal(Number(link[0].amount), 55000);
  const prop = (await pool.query('SELECT status, amount_paid FROM proposals WHERE id = $1', [proposalId])).rows[0];
  assert.equal(prop.status, 'balance_paid');
  assert.equal(Number(prop.amount_paid), 550);
  assert.equal(await upgrades(proposalId), 1, 'one upgrade breadcrumb');
  assert.equal(warnings.filter((w) => w.includes('overflow_capped')).length, 0, `overflow warned: ${warnings.join(' | ')}`);
  assert.equal(overflowCalls.length, 0, 'no overflow email');
});

test('a DEPOSIT payment on the same shape is unchanged: Deposit paid, Balance minted, no upgrade', async () => {
  const proposalId = await seed({ paymentType: 'deposit' });
  await handlePaymentIntentSucceeded(event({ proposalId, paymentType: 'deposit', amountCents: 10000 }));
  const invs = await contractInvoices(proposalId);
  assert.equal(invs.length, 2, JSON.stringify(invs));
  const dep = invs.find((i) => i.label === 'Deposit');
  const bal = invs.find((i) => i.label === 'Balance');
  assert.ok(dep && bal);
  assert.equal(Number(dep.amount_paid), 10000);
  assert.equal(dep.status, 'paid');
  assert.equal(dep.locked, true);
  assert.equal(Number(bal.amount_due), 45000);
  assert.equal(bal.status, 'sent');
  assert.equal(await upgrades(proposalId), 0);
});

test('a FULL intent settling on an ARCHIVED proposal never upgrades its invoice', async () => {
  const proposalId = await seed({ paymentType: 'full', status: 'archived' });
  await handlePaymentIntentSucceeded(event({ proposalId, paymentType: 'full', amountCents: 55000 }));
  const invs = await contractInvoices(proposalId);
  assert.equal(invs.length, 1);
  assert.equal(invs[0].label, 'Deposit', 'a cancelled event keeps its invoice shape; the admin refunds');
  assert.equal(await upgrades(proposalId), 0);
});
