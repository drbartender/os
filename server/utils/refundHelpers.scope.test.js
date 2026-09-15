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
  // No totalScope param, exactly as the stale-pending sweeper calls it: the
  // ROW decides. (refund.created passes an explicit scope instead, and only
  // when it has no validated row of its own.)
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

test('Approach A on a NOT-overpaid proposal: contract refund lowers the total', async () => {
  // paid == total, the ordinary shape. Kept from the reverted RC3 work as a
  // second pin on the shipped Approach-A behavior.
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

// ── Uncredited headroom (spec 2026-09-15 section 4b) ────────────────────────
// A payment can EXCEED the invoice it paid: linkPaymentToInvoice caps the
// invoice credit at that invoice's remaining due, while the webhook rolls the
// whole intent into proposals.amount_paid. Those uncredited cents sit on no
// invoice, so an overpayment refund of them must reverse no invoice. Before
// this rule the walk reversed CREDITED money instead, leaving a locked invoice
// demanding money on an unchanged contract.
async function seedOverflow({ label = 'Balance', locked = true, payCents = 90000, dueCents = 50000 } = {}) {
  seq += 1;
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`Overflow Test ${NONCE}`, `${NONCE}-of-${seq}@example.com`]
  );
  seededClients.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, event_timezone,
                            event_date, event_start_time, event_duration_hours,
                            total_price, amount_paid, pricing_snapshot, autopay_enrolled)
     VALUES ($1, 'balance_paid', 'wedding', 'America/Chicago',
             CURRENT_DATE + 30, '18:00', 4, $2, $3, '{}'::jsonb, false)
     RETURNING id`,
    [c.rows[0].id, dueCents / 100, payCents / 100]
  );
  const proposalId = p.rows[0].id;
  seededProposals.push(proposalId);
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, $3, $4, $4, 'paid', $5) RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`, label, dueCents, locked]
  );
  const intent = `pi_of_${NONCE}_${seq}`;
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
     VALUES ($1, 'balance', $2, 'succeeded', $3) RETURNING id`,
    [proposalId, payCents, intent]
  );
  // Credited only up to the invoice's due, exactly as linkPaymentToInvoice does.
  await pool.query('INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)',
    [inv.rows[0].id, pay.rows[0].id, dueCents]);
  return { proposalId, invId: inv.rows[0].id, paymentId: pay.rows[0].id, intent };
}

const money = (pid) => pool.query('SELECT total_price, amount_paid, status FROM proposals WHERE id = $1', [pid])
  .then((r) => r.rows[0]);
const invoiceRow = (id) => pool.query('SELECT amount_due, amount_paid, status FROM invoices WHERE id = $1', [id])
  .then((r) => r.rows[0]);

test('overpayment scope absorbs UNCREDITED headroom: the locked invoice is untouched and the contract stands', async () => {
  // $900 paid, $500 contract, the invoice was only ever credited $500.
  const o = await seedOverflow();
  const r = await reconcile(o, { refundId: `re_${NONCE}_of1`, amountCents: 40000, totalScope: 'overpayment' });
  assert.equal(r.applied, true);
  const m = await money(o.proposalId);
  assert.equal(Number(m.total_price), 500, 'contract stands');
  assert.equal(Number(m.amount_paid), 500, 'amount_paid drops by the full refund');
  assert.equal(m.status, 'balance_paid', 'paid still covers the total, so no demotion');
  const inv = await invoiceRow(o.invId);
  assert.equal(inv.amount_due, 50000, 'locked invoice still demands what the contract says');
  assert.equal(inv.amount_paid, 50000, 'its credit is untouched');
  assert.equal(inv.status, 'paid');
  const links = await pool.query('SELECT COUNT(*)::int AS n FROM invoice_payments WHERE payment_id = $1', [o.paymentId]);
  assert.equal(links.rows[0].n, 1, 'no reversal row: these cents were on no invoice');
  const log = await pool.query(
    `SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'refund_issued'`,
    [o.proposalId]
  );
  assert.equal(log.rows[0].details.total_scope, 'overpayment');
  assert.equal(log.rows[0].details.uncredited_absorbed_cents, 40000);
});

test('a SECOND overpayment refund on the same charge finds no headroom left and reverses the invoice', async () => {
  const o = await seedOverflow();
  await reconcile(o, { refundId: `re_${NONCE}_of2a`, amountCents: 40000, totalScope: 'overpayment' });
  // Headroom is spent; this one must come off the credited money.
  await reconcile(o, { refundId: `re_${NONCE}_of2b`, amountCents: 10000, totalScope: 'overpayment' });
  const inv = await invoiceRow(o.invId);
  assert.equal(inv.amount_paid, 40000, 'the credit is reversed the second time');
  assert.equal(inv.amount_due, 40000, 'locked invoice drops its demand too, so it stays settled');
  const m = await money(o.proposalId);
  assert.equal(Number(m.amount_paid), 400, 'both refunds left amount_paid');
  assert.equal(Number(m.total_price), 500, 'overpayment scope never lowers the contract');
});

test('a payment linked to an OFF-LEDGER invoice never absorbs headroom, and its refund leaves amount_paid alone', async () => {
  const o = await seedOverflow({ label: 'Service Extension', payCents: 90000, dueCents: 50000 });
  await reconcile(o, { refundId: `re_${NONCE}_of3`, amountCents: 20000, totalScope: 'overpayment' });
  const inv = await invoiceRow(o.invId);
  assert.equal(inv.amount_paid, 30000, 'the extension invoice IS reversed: absorption was skipped');
  const m = await money(o.proposalId);
  assert.equal(Number(m.amount_paid), 900, 'off-ledger dollars never entered amount_paid, so they never leave it');
  assert.equal(Number(m.total_price), 500, 'and the contract is untouched');
});

test('contract scope ignores headroom entirely: the invoice walk is unchanged', async () => {
  const o = await seedOverflow();
  await reconcile(o, { refundId: `re_${NONCE}_of4`, amountCents: 20000, totalScope: 'contract' });
  const inv = await invoiceRow(o.invId);
  assert.equal(inv.amount_paid, 30000, 'contract scope still reverses credited money');
  const m = await money(o.proposalId);
  assert.equal(Number(m.total_price), 300, 'and still lowers the contract by the contract portion');
});

test('a pendingRowId belonging to ANOTHER proposal is never adopted (defense in depth)', async () => {
  // The webhook validates the row id Stripe echoed back before passing it, but
  // the reconciler must not depend on that: the id is externally supplied, and
  // an unscoped lookup would let another proposal's row decide this refund's
  // money rule AND be stamped succeeded against this refund's id, stranding its
  // own refund forever.
  const victim = await seedOverpaid({ pendingScope: 'overpayment', pendingCents: 20000 });
  const victimRow = await pool.query(
    `SELECT id FROM proposal_refunds WHERE proposal_id = $1 AND status = 'pending'`,
    [victim.proposalId]
  );
  const other = await seedOverflow();
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    await applyRefundReconciliation({
      proposalId: other.proposalId,
      stripeRefundId: `re_${NONCE}_crossproposal`,
      paymentIntentId: other.intent,
      paymentId: other.paymentId,
      amountCents: 20000,
      reason: 'cross-proposal attempt',
      issuedBy: null,
      totalScope: 'contract',
      pendingRowId: victimRow.rows[0].id,
    }, dbClient);
    await dbClient.query('COMMIT');
  } finally {
    dbClient.release();
  }
  const untouched = await pool.query(
    'SELECT status, stripe_refund_id, total_scope FROM proposal_refunds WHERE id = $1',
    [victimRow.rows[0].id]
  );
  assert.equal(untouched.rows[0].status, 'pending', "the other proposal's row is left alone");
  assert.equal(untouched.rows[0].stripe_refund_id, null);
  const fresh = await pool.query(
    'SELECT proposal_id, total_scope FROM proposal_refunds WHERE stripe_refund_id = $1',
    [`re_${NONCE}_crossproposal`]
  );
  assert.equal(Number(fresh.rows[0].proposal_id), other.proposalId, 'a fresh row on the right proposal');
  assert.equal(fresh.rows[0].total_scope, 'contract', "the caller's scope stood, not the foreign row's");
  const vm = await money(victim.proposalId);
  assert.equal(Number(vm.amount_paid), 1000, "the other proposal's money never moved");
});

test('cancel-line geometry: a full payment credited only to a Deposit invoice absorbs headroom and leaves that invoice alone', async () => {
  // 22 of 103 succeeded prod payments carry uncredited headroom, and this is the
  // dominant shape: a `full` payment linked only to the $100 Deposit invoice.
  // Cancel-line issues overpayment-scope refunds, so this block DOES fire there.
  // The deposit really was paid and its invoice should keep saying so; before
  // the headroom rule the walk zeroed it instead. Pinning the delta because the
  // cancel-line suites use only fully-credited or wholly-unlinked fixtures.
  const o = await seedOverflow({ label: 'Deposit', payCents: 100000, dueCents: 10000 });
  await reconcile(o, { refundId: `re_${NONCE}_cl`, amountCents: 20000, totalScope: 'overpayment' });
  const inv = await invoiceRow(o.invId);
  assert.equal(inv.amount_due, 10000, 'the Deposit invoice still demands its deposit');
  assert.equal(inv.amount_paid, 10000, 'and still records it as paid');
  assert.equal(inv.status, 'paid');
  const m = await money(o.proposalId);
  assert.equal(Number(m.amount_paid), 800, 'the refund came off the uncredited part');
  assert.equal(Number(m.total_price), 100, 'overpayment scope never re-lowers the folded total');
});
