// cancelOpenInvoiceIntents must distinguish a Stripe FAILURE from a legitimate
// skip, so the stale-proposal sweep's heal pass can be bounded instead of
// retrying every intent forever. Run alone:
//   node -r dotenv/config --test server/utils/invoiceVoid.failed.test.js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { cancelOpenInvoiceIntents, _setStripeForTests } = require('./invoiceVoid');

let seq = 0;
const madeProposals = [];

async function fixtureWithPendingSession(piId) {
  if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');
  const tag = `${process.pid}-${++seq}`;
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'other') RETURNING id`,
    [`VoidFail Fixture ${tag}`, `voidfail-${tag}@example.com`]
  );
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, guest_count, total_price, amount_paid, status)
     VALUES ($1, '2026-12-01', 50, 500, 0, 'viewed') RETURNING id`,
    [c.rows[0].id]
  );
  const proposalId = p.rows[0].id;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, status, stripe_payment_intent_id)
     VALUES ($1, 'pending', $2)`,
    [proposalId, piId]
  );
  madeProposals.push(proposalId);
  return proposalId;
}

test.after(async () => {
  _setStripeForTests(null);
  for (const id of madeProposals) {
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [id]);
    const { rows } = await pool.query('SELECT client_id FROM proposals WHERE id = $1', [id]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
    if (rows[0]) await pool.query('DELETE FROM clients WHERE id = $1', [rows[0].client_id]);
  }
  await pool.end();
});

test('a Stripe retrieve failure is counted in failed, not silently dropped', async () => {
  const proposalId = await fixtureWithPendingSession(`pi_fail_${process.pid}_${seq}`);
  _setStripeForTests({
    paymentIntents: {
      retrieve: async () => { throw new Error('stripe is down'); },
      cancel: async () => { throw new Error('unreachable'); },
    },
  });
  const res = await cancelOpenInvoiceIntents(proposalId, 999);
  assert.equal(res.checked, 1);
  assert.equal(res.canceled, 0);
  assert.equal(res.failed, 1, 'a thrown retrieve must be reported as failed');
});

test('a legitimate skip is NOT counted as failed', async () => {
  const proposalId = await fixtureWithPendingSession(`pi_skip_${process.pid}_${seq}`);
  _setStripeForTests({
    // Not cancelable, and metadata points at a different invoice: both are
    // legitimate skips, and a heal pass must never retry them.
    paymentIntents: {
      retrieve: async (id) => ({ id, status: 'processing', metadata: { invoice_id: '12345' } }),
      cancel: async () => { throw new Error('should not be called'); },
    },
  });
  const res = await cancelOpenInvoiceIntents(proposalId, 999);
  assert.equal(res.checked, 1);
  assert.equal(res.canceled, 0);
  assert.equal(res.failed, 0, 'a skip is not a failure');
});
