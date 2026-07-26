require('dotenv').config();

// proposal_refunds.total_scope (lane cancel-line-server, plan Task 2).
// 'overpayment' refunds return money the client overpaid AFTER the fold
// already corrected total_price; reconciliation must not re-lower the total
// (the double-lower) and must not touch invoice amount_due (owned by
// refreshUnlockedInvoices). 'contract' (the default) keeps today's Approach-A
// behavior byte-for-byte. The scope lives ON the row so webhook/sweeper
// adoption honors it with no caller memory.
// Run ALONE against the shared dev DB:
//   node -r dotenv/config --test server/utils/refundHelpers.scope.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const { applyRefundReconciliation } = require('./refundHelpers');
const { clawbackTipByPaymentIntent } = require('./payrollClawback');

if (process.env.NODE_ENV === 'production') {
  throw new Error('refundHelpers.scope.test.js refuses to run against production');
}

const NONCE = `scope-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let seq = 0;
const seededClients = [];
const seededProposals = [];

// One proposal in the post-fold overpaid state: total_price 800, amount_paid
// 1000, one 'paid' Balance invoice holding all 100000 cents, one succeeded
// payment fully linked to it. Optionally a pending refund row carrying a scope.
// dueCents defaults to the realistic fully-paid geometry (due == paid); an
// UNLOCKED invoice models the post-refresh state (due already rebuilt lower).
async function seedOverpaid({
  pendingScope = null, pendingCents = 20000, locked = true, dueCents = 100000,
  label = 'Balance', invStatus = 'paid',
} = {}) {
  seq += 1;
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`Scope Test ${NONCE}`, `${NONCE}-${seq}@example.com`]
  );
  seededClients.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, event_timezone,
                            event_date, event_start_time, event_duration_hours,
                            total_price, amount_paid, pricing_snapshot, autopay_enrolled)
     VALUES ($1, 'balance_paid', 'wedding', 'America/Chicago',
             CURRENT_DATE + 30, '18:00', 4, 800, 1000, '{}'::jsonb, false)
     RETURNING id`,
    [c.rows[0].id]
  );
  const proposalId = p.rows[0].id;
  seededProposals.push(proposalId);
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, $5, $3, 100000, $6, $4) RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`, dueCents, locked, label, invStatus]
  );
  const intent = `pi_scope_${NONCE}_${seq}`;
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
     VALUES ($1, 'balance', 100000, 'succeeded', $2) RETURNING id`,
    [proposalId, intent]
  );
  await pool.query('INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)',
    [inv.rows[0].id, pay.rows[0].id, 100000]);
  if (pendingScope) {
    await pool.query(
      `INSERT INTO proposal_refunds
         (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
          total_price_before, total_price_after, issued_by, status, total_scope)
       VALUES ($1, $2, $3, $4, 'seeded pending', 800, 800, NULL, 'pending', $5)`,
      [proposalId, pay.rows[0].id, intent, pendingCents, pendingScope]
    );
  }
  return { proposalId, invId: inv.rows[0].id, paymentId: pay.rows[0].id, intent };
}

async function reconcile(o, { refundId, amountCents = 20000, totalScope } = {}) {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const recon = await applyRefundReconciliation({
      proposalId: o.proposalId,
      stripeRefundId: refundId,
      paymentIntentId: o.intent,
      paymentId: o.paymentId,
      amountCents,
      reason: 'test refund',
      issuedBy: null,
      ...(totalScope ? { totalScope } : {}),
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

before(async () => { /* per-test seeds */ });

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

let first; // shared by tests 1 and 4 (replay)
let firstRefundId;

test('overpayment scope, LOCKED invoice: both figures drop, no phantom balance; total_price untouched', async () => {
  // Realistic fully-paid geometry: locked contract invoice with due == paid.
  // The refresh never touches locked invoices, so the refund must drop BOTH
  // figures or the settled invoice flips to a client-visible partially_paid
  // phantom balance (merge-fleet code-review, 2026-07-24).
  first = await seedOverpaid({ pendingScope: 'overpayment' }); // locked, due 100000
  firstRefundId = `re_${NONCE}_1`;
  const recon = await reconcile(first, { refundId: firstRefundId });
  assert.equal(recon.applied, true);
  const p = (await pool.query('SELECT total_price, amount_paid, status FROM proposals WHERE id = $1', [first.proposalId])).rows[0];
  assert.equal(Number(p.total_price), 800);      // NOT re-lowered
  assert.equal(Number(p.amount_paid), 800);      // 1000 - 200
  assert.equal(p.status, 'balance_paid');        // paid >= total: no demotion
  const inv = (await pool.query('SELECT amount_due, amount_paid, status FROM invoices WHERE id = $1', [first.invId])).rows[0];
  assert.equal(Number(inv.amount_due), 80000);   // locked: dropped WITH paid
  assert.equal(Number(inv.amount_paid), 80000);  // 100000 - 20000
  assert.equal(inv.status, 'paid');              // stays settled at the corrected figure
  const rev = (await pool.query('SELECT amount FROM invoice_payments WHERE payment_id = $1 AND amount < 0', [first.paymentId])).rows;
  assert.equal(rev.length, 1);
  assert.equal(Number(rev[0].amount), -20000);
  const row = (await pool.query('SELECT total_scope, total_price_after FROM proposal_refunds WHERE stripe_refund_id = $1', [firstRefundId])).rows[0];
  assert.equal(row.total_scope, 'overpayment');
  assert.equal(Number(row.total_price_after), 800); // audit figure: total unchanged
});

test('overpayment scope, UNLOCKED invoice: paid-only drop (refresh already rebuilt the demand)', async () => {
  // Post-refresh state: unlocked Balance already rebuilt to the new lower
  // demand (80000) while still holding the original 100000. Dropping due
  // again would mint phantom credit; paid-only lands exactly on due.
  const o = await seedOverpaid({ pendingScope: 'overpayment', locked: false, dueCents: 80000 });
  const recon = await reconcile(o, { refundId: `re_${NONCE}_u` });
  assert.equal(recon.applied, true);
  const p = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  assert.equal(Number(p.total_price), 800);
  const inv = (await pool.query('SELECT amount_due, amount_paid, status FROM invoices WHERE id = $1', [o.invId])).rows[0];
  assert.equal(Number(inv.amount_due), 80000);   // untouched: the refresh owns it
  assert.equal(Number(inv.amount_paid), 80000);  // 100000 - 20000
  assert.equal(inv.status, 'paid');
});

test('contract scope (default) still drops total_price and amount_due', async () => {
  // FIXTURE CORRECTED 2026-07-26: this asserts "contract scope still does
  // Approach A", but it was seeded OVERPAID (total 800 / paid 1000), so what
  // it actually pinned was the defect — a refund of money above the contract
  // lowering the contract anyway. Approach A is about correcting a contract
  // the client still owes against, so the fixture is now paid == total. The
  // overpaid case is covered by the RC3 tests below, which assert the opposite
  // and would have been contradicted by this one.
  const o = await seedOverpaid(); // no pending row, no scope param; locked, due 100000
  await pool.query('UPDATE proposals SET amount_paid = 800 WHERE id = $1', [o.proposalId]);
  const recon = await reconcile(o, { refundId: `re_${NONCE}_2` });
  assert.equal(recon.applied, true);
  const p = (await pool.query('SELECT total_price, amount_paid FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  assert.equal(Number(p.total_price), 600);      // 800 - 200: Approach A unchanged
  assert.equal(Number(p.amount_paid), 600);      // 800 - 200
  const inv = (await pool.query('SELECT amount_due, amount_paid FROM invoices WHERE id = $1', [o.invId])).rows[0];
  assert.equal(Number(inv.amount_due), 80000);   // 100000 - 20000
  assert.equal(Number(inv.amount_paid), 80000);
});

test('webhook-style adoption honors the stored row scope', async () => {
  const o = await seedOverpaid({ pendingScope: 'overpayment' });
  // No totalScope param, exactly as chargeRefunded calls it: the ROW decides.
  const recon = await reconcile(o, { refundId: `re_${NONCE}_3` });
  assert.equal(recon.applied, true);
  const p = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  assert.equal(Number(p.total_price), 800);      // row scope wins: not re-lowered
});

test('idempotent replay + tip clawback no-op', async () => {
  const replay = await reconcile(first, { refundId: firstRefundId });
  assert.equal(replay.applied, false);           // second apply of the same refund id no-ops
  const p = (await pool.query('SELECT amount_paid FROM proposals WHERE id = $1', [first.proposalId])).rows[0];
  assert.equal(Number(p.amount_paid), 800);      // no double drop
  // Spec seam: a cancel-line refund flowing through charge.refunded reaches the
  // tip clawback, which must no-op for a non-tip intent (no tips row exists).
  await clawbackTipByPaymentIntent(first.intent, 20000);
});

// ---- Push-review fixes, 2026-07-26 (fleet findings + prod probe) ----------

test('RC1: overpayment scope on an UNLOCKED non-total-tracking label drops BOTH figures', async () => {
  // The paid-only rule was keyed on `locked` as a proxy for "the refresh already
  // rebuilt this invoice's demand". refreshUnlockedInvoices (invoiceLifecycle
  // :143-153) only rebuilds Balance / Full Payment against total_price; it sets
  // Deposit from deposit_amount and `continue`s past every other label. So an
  // unlocked 'Additional Services' invoice is NOT corrected by anything, and a
  // paid-only drop leaves due > paid -> a client-visible phantom balance on an
  // invoice whose pay link is still live (create-intent accepts partially_paid).
  const o = await seedOverpaid({
    pendingScope: 'overpayment', locked: false, label: 'Additional Services', dueCents: 100000,
  });
  const recon = await reconcile(o, { refundId: `re_${NONCE}_rc1` });
  assert.equal(recon.applied, true);
  const inv = (await pool.query('SELECT amount_due, amount_paid, status FROM invoices WHERE id = $1', [o.invId])).rows[0];
  assert.equal(Number(inv.amount_paid), 80000);
  assert.equal(Number(inv.amount_due), 80000, 'unlocked non-total-tracking label must drop due too');
  assert.equal(inv.status, 'paid', 'must not flip to a phantom partially_paid balance');
  // total_price still must not be re-lowered (that is what overpayment scope is for).
  const p = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  assert.equal(Number(p.total_price), 800);
});

test('RC1: overpayment scope on an UNLOCKED Deposit drops BOTH figures', async () => {
  // Deposit IS refreshed, but from deposit_amount, so a cancel never lowers it
  // and paid-only would strand the same phantom balance.
  const o = await seedOverpaid({
    pendingScope: 'overpayment', locked: false, label: 'Deposit', dueCents: 100000,
  });
  await reconcile(o, { refundId: `re_${NONCE}_rc1b` });
  const inv = (await pool.query('SELECT amount_due, amount_paid FROM invoices WHERE id = $1', [o.invId])).rows[0];
  assert.equal(Number(inv.amount_due), 80000);
  assert.equal(Number(inv.amount_paid), 80000);
});

test('RC1 regression: unlocked Balance still drops paid ONLY (refresh owns its demand)', async () => {
  const o = await seedOverpaid({
    pendingScope: 'overpayment', locked: false, label: 'Balance', dueCents: 80000,
  });
  await reconcile(o, { refundId: `re_${NONCE}_rc1c` });
  const inv = (await pool.query('SELECT amount_due, amount_paid FROM invoices WHERE id = $1', [o.invId])).rows[0];
  assert.equal(Number(inv.amount_due), 80000, 'refresh already rebuilt this: leave it alone');
  assert.equal(Number(inv.amount_paid), 80000);
});

test('RC3: a CONTRACT-scope refund of an overpayment clears it instead of shrinking the contract', async () => {
  // Pre-existing defect, measured on the shipped payment panel 2026-07-26:
  // refunding an overpayment lowered total AND paid by the same amount, so the
  // proposal stayed overpaid by exactly the same figure forever and the
  // contract silently shrank on every attempt. Money paid in excess of the
  // contract is attached to no contract line, so returning it cannot lower the
  // contract. This is the root cause behind the cancel-line retry path too:
  // the panel is where the dialog sends an admin after a failed refund.
  const o = await seedOverpaid();          // total 800, paid 1000, locked Balance
  const recon = await reconcile(o, { refundId: `re_${NONCE}_rc3` }); // $200, default scope
  assert.equal(recon.applied, true);
  const p = (await pool.query('SELECT total_price, amount_paid FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  assert.equal(Number(p.total_price), 800, 'excess refund must NOT lower the contract');
  assert.equal(Number(p.amount_paid), 800, 'money held drops by the refund');
  assert.equal(Number(p.amount_paid) - Number(p.total_price), 0, 'the overpayment is actually cleared');
});

test('RC3: a refund SPANNING the overpayment splits: excess spares the contract, the rest lowers it', async () => {
  // total 800, paid 1000 => 200 excess. Refund 500: 200 is excess (no contract
  // move), 300 is a genuine contract correction.
  const o = await seedOverpaid();
  await reconcile(o, { refundId: `re_${NONCE}_rc3b`, amountCents: 50000 });
  const p = (await pool.query('SELECT total_price, amount_paid FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  assert.equal(Number(p.total_price), 500, '800 - 300 contract portion');
  assert.equal(Number(p.amount_paid), 500, '1000 - 500 refunded');
});

test('RC3 regression: a normal contract refund on a NOT-overpaid proposal is unchanged', async () => {
  // paid == total: no excess, so Approach A applies in full, exactly as shipped.
  const o = await seedOverpaid();
  await pool.query('UPDATE proposals SET amount_paid = 800 WHERE id = $1', [o.proposalId]);
  await reconcile(o, { refundId: `re_${NONCE}_rc3c` });
  const p = (await pool.query('SELECT total_price, amount_paid FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  assert.equal(Number(p.total_price), 600, 'contract refund still corrects the total');
  assert.equal(Number(p.amount_paid), 600);
});

test('RC4: adoption matches the caller OWN pending row, not a same-amount stranded one', async () => {
  // total_scope made the adopted row decide money semantics, but adoption
  // matched only on (intent, amount) ORDER BY created_at ASC. A stranded
  // 'contract' pending row of the same amount on the same charge would
  // silently rewrite the rule for a later cancel-line refund (and vice versa).
  const o = await seedOverpaid({ pendingScope: 'contract' });   // stranded older row
  const mine = await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
        total_price_before, total_price_after, issued_by, status, total_scope)
     VALUES ($1,$2,$3,20000,'mine',800,800,NULL,'pending','overpayment') RETURNING id`,
    [o.proposalId, o.paymentId, o.intent]
  );
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    await applyRefundReconciliation({
      proposalId: o.proposalId,
      stripeRefundId: `re_${NONCE}_rc4`,
      paymentIntentId: o.intent,
      paymentId: o.paymentId,
      amountCents: 20000,
      reason: 'mine',
      issuedBy: null,
      pendingRowId: mine.rows[0].id,     // the caller knows exactly which row is his
    }, dbClient);
    await dbClient.query('COMMIT');
  } finally { dbClient.release(); }
  const adopted = (await pool.query(
    'SELECT id, status FROM proposal_refunds WHERE stripe_refund_id = $1', [`re_${NONCE}_rc4`])).rows[0];
  assert.equal(adopted.id, mine.rows[0].id, 'must adopt the row the caller created');
  const p = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  assert.equal(Number(p.total_price), 800, "own row's overpayment scope must win, not the stranded contract row");
});
