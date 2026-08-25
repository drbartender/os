require('dotenv').config();

// total_price_override must move with total_price on a contract-scope refund
// (lane refund-override-sync, backlog entry "A contract-scope refund on an
// override'd proposal is undone by the next editor save", 2026-08-25).
//
// Every refund path funnels into applyRefundReconciliation's single UPDATE.
// It lowered total_price and left total_price_override alone, so the next
// proposal-editor save carried the stale override forward, the engine
// substituted it, and the post-save pass minted an Additional Services
// invoice for exactly the refunded amount (prod rows 599 and 527).
//
// The override is the service contract; total_price = override + client
// gratuity, and the gratuity is re-derived from gratuity_rate at every price.
// Every dollar reconciled here as contract scope (gratuity dollars included;
// nothing passes a gratuity scope into reconciliation) lowers the override by
// exactly contractCents, which keeps total_price - override equal to the
// derived gratuity so the next re-price is a no-op. Extra-scope and
// overpayment-scope refunds do not move total_price and must not move the
// override either. The last test pins the one known gap: a refund larger than
// the override clamps it at zero while the total keeps the remainder.
//
// Run ALONE against the shared dev DB:
//   node -r dotenv/config --test server/utils/refundHelpers.override.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const { applyRefundReconciliation } = require('./refundHelpers');

if (process.env.NODE_ENV === 'production') {
  throw new Error('refundHelpers.override.test.js refuses to run against production');
}

const NONCE = `ovr-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let seq = 0;
const seededClients = [];
const seededProposals = [];

// One fully-paid proposal: total_price == override (gratuity 0), one paid
// locked invoice holding all the cents, one succeeded payment fully linked to
// it. `override: null` seeds a native (non-override'd) proposal.
async function seed({
  override = 800, totalDollars = 800, paidCents = 80000,
  label = 'Balance', pendingScope = null, pendingCents = 20000,
} = {}) {
  seq += 1;
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`Override Test ${NONCE}`, `${NONCE}-${seq}@example.com`]
  );
  seededClients.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, event_timezone,
                            event_date, event_start_time, event_duration_hours,
                            total_price, total_price_override, amount_paid,
                            pricing_snapshot, autopay_enrolled)
     VALUES ($1, 'balance_paid', 'wedding', 'America/Chicago',
             CURRENT_DATE + 30, '18:00', 4, $2, $3, $4, '{}'::jsonb, false)
     RETURNING id`,
    [c.rows[0].id, totalDollars, override, paidCents / 100]
  );
  const proposalId = p.rows[0].id;
  seededProposals.push(proposalId);
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, $3, $4, $4, 'paid', true) RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`, label, paidCents]
  );
  const intent = `pi_ovr_${NONCE}_${seq}`;
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
     VALUES ($1, 'balance', $2, 'succeeded', $3) RETURNING id`,
    [proposalId, paidCents, intent]
  );
  await pool.query('INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)',
    [inv.rows[0].id, pay.rows[0].id, paidCents]);
  if (pendingScope) {
    await pool.query(
      `INSERT INTO proposal_refunds
         (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
          total_price_before, total_price_after, issued_by, status, total_scope)
       VALUES ($1, $2, $3, $4, 'seeded pending', $5, $5, NULL, 'pending', $6)`,
      [proposalId, pay.rows[0].id, intent, pendingCents, totalDollars, pendingScope]
    );
  }
  return { proposalId, invId: inv.rows[0].id, paymentId: pay.rows[0].id, intent };
}

async function reconcile(o, { amountCents = 20000 } = {}) {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const recon = await applyRefundReconciliation({
      proposalId: o.proposalId,
      stripeRefundId: `re_${NONCE}_${seq}`,
      paymentIntentId: o.intent,
      paymentId: o.paymentId,
      amountCents,
      reason: 'test refund',
      issuedBy: null,
    }, dbClient);
    await dbClient.query('COMMIT');
    return recon;
  } catch (e) {
    await dbClient.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    dbClient.release();
  }
}

async function readMoney(proposalId) {
  const r = await pool.query(
    'SELECT total_price, total_price_override, amount_paid FROM proposals WHERE id = $1',
    [proposalId]
  );
  const row = r.rows[0];
  return {
    total: Number(row.total_price),
    override: row.total_price_override === null ? null : Number(row.total_price_override),
    paid: Number(row.amount_paid),
  };
}

after(async () => {
  for (const pid of seededProposals) {
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)', [pid]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [pid]);
  }
  for (const cid of seededClients) await pool.query('DELETE FROM clients WHERE id = $1', [cid]);
  await pool.end();
});

test('contract-scope refund lowers total_price_override by the same amount as total_price', async () => {
  const o = await seed(); // override 800, total 800, paid 800
  const recon = await reconcile(o, { amountCents: 20000 });
  assert.equal(recon.applied, true);
  const m = await readMoney(o.proposalId);
  assert.equal(m.total, 600);
  assert.equal(m.override, 600);
  assert.equal(m.paid, 600);
});

test('extra-scope refund (non-contract invoice label) leaves the override alone, as it leaves total_price', async () => {
  const o = await seed({ label: 'Additional Services' });
  await reconcile(o, { amountCents: 20000 });
  const m = await readMoney(o.proposalId);
  assert.equal(m.total, 800);    // extra scope never shrinks the contract
  assert.equal(m.override, 800); // so the override stands too
  assert.equal(m.paid, 600);
});

test('overpayment-scope refund leaves the override alone, as it leaves total_price', async () => {
  const o = await seed({ pendingScope: 'overpayment', paidCents: 100000, totalDollars: 800, override: 800 });
  await reconcile(o, { amountCents: 20000 });
  const m = await readMoney(o.proposalId);
  assert.equal(m.total, 800);
  assert.equal(m.override, 800);
  assert.equal(m.paid, 800);
});

test('a native proposal (null override) stays null', async () => {
  const o = await seed({ override: null });
  await reconcile(o, { amountCents: 20000 });
  const m = await readMoney(o.proposalId);
  assert.equal(m.total, 600);
  assert.equal(m.override, null);
});

test('the override clamps at zero exactly like total_price', async () => {
  const o = await seed({ override: 100, totalDollars: 100, paidCents: 10000 });
  await reconcile(o, { amountCents: 20000 }); // refund more than the contract
  const m = await readMoney(o.proposalId);
  assert.equal(m.total, 0);
  assert.equal(m.override, 0);
  assert.equal(m.paid, 0);
});

test('a gratuity slice above the override is preserved: both columns drop by the same amount', async () => {
  // override 800 + derived gratuity 100 = total 900, fully paid
  const o = await seed({ override: 800, totalDollars: 900, paidCents: 90000 });
  await reconcile(o, { amountCents: 20000 });
  const m = await readMoney(o.proposalId);
  assert.equal(m.total, 700);
  assert.equal(m.override, 600);
  assert.equal(m.total - m.override, 100); // the gratuity slice survives the refund
});

test('known gap: a refund larger than the override clamps it at zero while the total keeps the remainder', async () => {
  // override 100 + derived gratuity 50 = total 150; refund 120 exceeds the service contract
  const o = await seed({ override: 100, totalDollars: 150, paidCents: 15000 });
  await reconcile(o, { amountCents: 12000 });
  const m = await readMoney(o.proposalId);
  assert.equal(m.total, 30);
  assert.equal(m.override, 0);
  // total - override is now 30, not the derived 50: the next re-price bills the $20 gap.
  // Pinned so the limitation is visible, not so it is desired.
});
