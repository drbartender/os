require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const sync = require('./stripePayoutSync');

if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');

const N = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const poId = `po_test_${N}`;
const txnA = `txn_test_${N}_a`;
const txnB = `txn_test_${N}_b`;

// Fake Stripe client: only the surface the module touches.
function fakeStripe({ payouts = [], txnsByPayout = {}, recentTxns = [] } = {}) {
  const page = (arr) => ({ data: arr, has_more: false });
  return {
    payouts: { list: async () => page(payouts) },
    balanceTransactions: {
      list: async (params = {}) => page(params.payout ? (txnsByPayout[params.payout] || []) : recentTxns),
    },
  };
}
const payoutObj = (over = {}) => ({
  id: poId, object: 'payout', amount: 53345, currency: 'usd', status: 'paid',
  created: 1782776371, arrival_date: 1782777600, automatic: true, livemode: true,
  method: 'standard', description: 'STRIPE PAYOUT', failure_code: null, failure_message: null,
  ...over,
});
const chargeTxn = (id, over = {}) => ({
  id, object: 'balance_transaction', type: 'charge', reporting_category: 'charge',
  amount: 45000, fee: 1335, net: 43665, available_on: 1782604800,
  description: `test charge ${N}`,
  source: { id: `ch_test_${N}`, object: 'charge', payment_intent: `pi_test_${N}` },
  ...over,
});

after(async () => {
  await pool.query('DELETE FROM stripe_payout_lines WHERE stripe_balance_txn_id LIKE $1', [`txn_test_${N}%`]);
  await pool.query('DELETE FROM stripe_payouts WHERE stripe_payout_id LIKE $1', [`po_test_${N}%`]);
  // Task 3 fixture cleanup (FK order): links first, then owners.
  await pool.query('DELETE FROM invoice_payments WHERE invoice_id = $1', [invoiceId]);
  await pool.query('DELETE FROM proposal_refunds WHERE id = $1', [refundId]);
  await pool.query('DELETE FROM invoices WHERE id = $1', [invoiceId]);
  await pool.query('DELETE FROM tips WHERE id = $1', [tipId]);
  await pool.query('DELETE FROM proposal_payments WHERE id = $1', [paymentId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE name = $1', [`PayoutTest ${N}`]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('syncPayout upserts payout row and claims its lines; double-run converges', async () => {
  const stripe = fakeStripe({ txnsByPayout: { [poId]: [
    { id: `txn_test_${N}_self`, type: 'payout', reporting_category: 'payout', amount: -53345, fee: 0, net: -53345, source: poId },
    chargeTxn(txnA),
  ] } });
  await sync.syncPayout(payoutObj(), { stripe });
  await sync.syncPayout(payoutObj(), { stripe }); // replay
  const p = (await pool.query('SELECT * FROM stripe_payouts WHERE stripe_payout_id=$1', [poId])).rows;
  assert.equal(p.length, 1);
  assert.equal(p[0].amount_cents, 53345);
  assert.ok(p[0].lines_synced_at);
  const l = (await pool.query('SELECT * FROM stripe_payout_lines WHERE stripe_balance_txn_id LIKE $1', [`txn_test_${N}%`])).rows;
  assert.equal(l.length, 1); // the payout's own txn is skipped
  assert.equal(l[0].payout_id, p[0].id);
});

test('syncPayout skips livemode:false', async () => {
  const r = await sync.syncPayout(payoutObj({ id: `po_test_${N}_tm`, livemode: false }), { stripe: fakeStripe() });
  assert.equal(r.skipped, 'livemode');
  const p = await pool.query('SELECT 1 FROM stripe_payouts WHERE stripe_payout_id=$1', [`po_test_${N}_tm`]);
  assert.equal(p.rows.length, 0);
});

test('pending path inserts with NULL payout_id and NEVER un-claims a claimed line', async () => {
  const stripe = fakeStripe({ recentTxns: [chargeTxn(txnA), chargeTxn(txnB, { amount: 10000, fee: 320, net: 9680 })] });
  await sync.syncPendingTransactions({ stripe });
  const rows = (await pool.query(
    'SELECT stripe_balance_txn_id, payout_id FROM stripe_payout_lines WHERE stripe_balance_txn_id IN ($1,$2) ORDER BY stripe_balance_txn_id',
    [txnA, txnB])).rows;
  // txnA was claimed by the payout in the earlier test and MUST keep its payout_id.
  assert.ok(rows.find(r => r.stripe_balance_txn_id === txnA).payout_id, 'pending path un-claimed a settled line');
  assert.equal(rows.find(r => r.stripe_balance_txn_id === txnB).payout_id, null);
});

// ============================================================
// Task 3: matcher fixtures + cases
// ============================================================
// Fixtures: one client+proposal+payment (with PI), one invoice link, one refund, one tip.
let proposalId, paymentId, invoiceId, refundId, tipId, userId;
before(async () => {
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id`,
    [`PayoutTest ${N}`, `payout-test-${N}@test.local`]);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_type, status) VALUES ($1,'cocktail_party','confirmed') RETURNING id`,
    [c.rows[0].id]);
  proposalId = p.rows[0].id;
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
     VALUES ($1,$2,'deposit',45000,'succeeded') RETURNING id`, [proposalId, `pi_test_${N}`]);
  paymentId = pay.rows[0].id;
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due) VALUES ($1,$2,'Invoice',45000) RETURNING id`,
    [proposalId, `INV-T${String(N).slice(-6)}`]);
  invoiceId = inv.rows[0].id;
  await pool.query(`INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1,$2,45000)`,
    [invoiceId, paymentId]);
  // proposal_refunds has NO amount_cents column (it is `amount`, cents) and
  // three NOT NULL columns with no defaults; any values satisfying them are
  // fine for the matcher test (it reads only id + proposal_id).
  const ref = await pool.query(
    `INSERT INTO proposal_refunds (proposal_id, payment_id, amount, reason,
       total_price_before, total_price_after, stripe_refund_id)
     VALUES ($1,$2,5000,'matcher test fixture',45000,40000,$3) RETURNING id`,
    [proposalId, paymentId, `re_test_${N}`]);
  refundId = ref.rows[0].id;
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1,'x','staff') RETURNING id`,
    [`payout-tip-${N}@test.local`]);
  userId = u.rows[0].id;
  const tip = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, stripe_payment_intent_id, tipped_at)
     VALUES (gen_random_uuid(),$1,2000,$2,NOW()) RETURNING id`, [userId, `pi_tip_${N}`]);
  tipId = tip.rows[0].id;
});

async function makePendingLine(id, fields) {
  const { rows } = await pool.query(
    `INSERT INTO stripe_payout_lines (stripe_balance_txn_id, txn_type, reporting_category,
       amount_cents, fee_cents, net_cents, stripe_charge_id, stripe_payment_intent_id, stripe_refund_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [id, fields.txn_type || 'charge', fields.reporting_category || 'charge',
     fields.amount_cents ?? 1000, fields.fee_cents ?? 30, fields.net_cents ?? 970,
     fields.stripe_charge_id || null, fields.stripe_payment_intent_id || null,
     fields.stripe_refund_id || null]);
  return rows[0].id;
}
const lineRow = async (id) =>
  (await pool.query('SELECT * FROM stripe_payout_lines WHERE id=$1', [id])).rows[0];

test('matcher: charge with known PI -> payment + proposal + invoice', async () => {
  const id = await makePendingLine(`txn_test_${N}_m1`, { stripe_payment_intent_id: `pi_test_${N}` });
  await sync.matchLine(id);
  const r = await lineRow(id);
  assert.equal(r.matched_kind, 'payment');
  assert.equal(r.proposal_payment_id, paymentId);
  assert.equal(r.proposal_id, proposalId);
  assert.equal(r.invoice_id, invoiceId);
});

test('matcher: charge with tip PI -> tip', async () => {
  const id = await makePendingLine(`txn_test_${N}_m2`, { stripe_payment_intent_id: `pi_tip_${N}` });
  await sync.matchLine(id);
  const r = await lineRow(id);
  assert.equal(r.matched_kind, 'tip');
  assert.equal(r.tip_id, tipId);
});

test('matcher: refund txn -> refund with proposal from the refund row', async () => {
  const id = await makePendingLine(`txn_test_${N}_m3`, {
    txn_type: 'refund', reporting_category: 'refund',
    amount_cents: -5000, net_cents: -5000, fee_cents: 0, stripe_refund_id: `re_test_${N}` });
  await sync.matchLine(id);
  const r = await lineRow(id);
  assert.equal(r.matched_kind, 'refund');
  assert.equal(r.proposal_refund_id, refundId);
  assert.equal(r.proposal_id, proposalId);
});

test('matcher: dispute txn resolves via PI as dispute', async () => {
  const id = await makePendingLine(`txn_test_${N}_m4`, {
    txn_type: 'adjustment', reporting_category: 'dispute',
    amount_cents: -45000, net_cents: -46500, fee_cents: 1500,
    stripe_payment_intent_id: `pi_test_${N}` });
  await sync.matchLine(id);
  const r = await lineRow(id);
  assert.equal(r.matched_kind, 'dispute');
  assert.equal(r.proposal_payment_id, paymentId);
});

test('matcher: adjustment category -> adjustment even without links', async () => {
  const id = await makePendingLine(`txn_test_${N}_m5`, {
    txn_type: 'adjustment', reporting_category: 'other_adjustment', amount_cents: -100, net_cents: -100, fee_cents: 0 });
  await sync.matchLine(id);
  assert.equal((await lineRow(id)).matched_kind, 'adjustment');
});

test('matcher: unknown PI stays unmatched', async () => {
  const id = await makePendingLine(`txn_test_${N}_m6`, { stripe_payment_intent_id: `pi_nope_${N}` });
  await sync.matchLine(id);
  assert.equal((await lineRow(id)).matched_kind, 'unmatched');
});

test('matcher: adjustment with a resolvable PI stays adjustment, links kept', async () => {
  const id = await makePendingLine(`txn_test_${N}_m7`, {
    txn_type: 'adjustment', reporting_category: 'other_adjustment',
    amount_cents: -500, net_cents: -500, fee_cents: 0,
    stripe_payment_intent_id: `pi_test_${N}` });
  await sync.matchLine(id);
  const r = await lineRow(id);
  assert.equal(r.matched_kind, 'adjustment'); // never masquerades as revenue
  assert.equal(r.proposal_payment_id, paymentId);
});

// ============================================================
// Task 4: sweep + bootstrap + atomic failed-payout alert
// (poF/poH rows are nonce-scoped `po_test_${N}%`, covered by the after() cleanup)
// ============================================================
test('sweep bootstraps full history on empty table, 30-day window otherwise', async () => {
  // The fake records the params it was called with.
  let seenParams = [];
  const stripe = {
    payouts: { list: async (p) => { seenParams.push(p); return { data: [], has_more: false }; } },
    balanceTransactions: { list: async () => ({ data: [], has_more: false }) },
  };
  await sync.sweep({ stripe, notify: async () => {}, force: true });
  // Table is NOT empty here (earlier tests inserted poId), so expect created.gte:
  assert.ok(seenParams[0].created && seenParams[0].created.gte, 'expected 30-day window');
});

test('alertFailedPayout fires exactly once under concurrent callers', async () => {
  const poF = `po_test_${N}_fail`;
  await pool.query(
    `INSERT INTO stripe_payouts (stripe_payout_id, amount_cents, status, created_at_stripe, failure_message)
     VALUES ($1, 9999, 'failed', NOW(), 'account_closed')`, [poF]);
  let sends = 0;
  const notify = async () => { sends += 1; };
  await Promise.all([
    sync.alertFailedPayout(poF, { notify }),
    sync.alertFailedPayout(poF, { notify }),
    sync.alertFailedPayout(poF, { notify }),
  ]);
  assert.equal(sends, 1);
  await sync.alertFailedPayout(poF, { notify }); // later retry
  assert.equal(sends, 1);
});

test('concurrent sweeps share one in-flight run', async () => {
  let listCalls = 0;
  const stripe = {
    payouts: { list: async (p) => { listCalls += 1; await new Promise(r => setTimeout(r, 50)); return { data: [], has_more: false }; } },
    balanceTransactions: { list: async () => ({ data: [], has_more: false }) },
  };
  const o = { stripe, notify: async () => {}, force: true };
  await Promise.all([sync.sweep(o), sync.sweep(o)]);
  assert.equal(listCalls, 1);
});

test('sweep without force skips when fresh (15-minute staleness gate)', async () => {
  let listCalls = 0;
  const stripe = { payouts: { list: async () => { listCalls += 1; return { data: [], has_more: false }; } },
    balanceTransactions: { list: async () => ({ data: [], has_more: false }) } };
  const r = await sync.sweep({ stripe, notify: async () => {} }); // a forced sweep just ran above
  assert.equal(r.fresh, true);
  assert.equal(listCalls, 0);
});

test('partial-failure heal: failed line fetch leaves lines_synced_at NULL, sweep retries', async () => {
  const poH = `po_test_${N}_heal`;
  const failing = {
    payouts: { list: async () => ({ data: [], has_more: false }) },
    balanceTransactions: { list: async () => { throw new Error('stripe 500'); } },
  };
  await assert.rejects(sync.syncPayout(payoutObj({ id: poH }), { stripe: failing }));
  let row = (await pool.query('SELECT lines_synced_at FROM stripe_payouts WHERE stripe_payout_id=$1', [poH])).rows[0];
  assert.equal(row.lines_synced_at, null);
  const healing = fakeStripe({
    payouts: [payoutObj({ id: poH })],
    txnsByPayout: { [poH]: [chargeTxn(`txn_test_${N}_heal`)] },
  });
  await sync.sweep({ stripe: healing, notify: async () => {}, force: true });
  row = (await pool.query('SELECT lines_synced_at FROM stripe_payouts WHERE stripe_payout_id=$1', [poH])).rows[0];
  assert.ok(row.lines_synced_at, 'sweep did not heal the failed line fetch');
});

// ============================================================
// Review-fix findings 1-5
// ============================================================

test('matcher: dispute_reversal category -> dispute (not payment), links kept [finding 4]', async () => {
  const id = await makePendingLine(`txn_test_${N}_m8`, {
    txn_type: 'adjustment', reporting_category: 'dispute_reversal',
    amount_cents: 45000, net_cents: 43500, fee_cents: -1500,
    stripe_payment_intent_id: `pi_test_${N}` });
  await sync.matchLine(id);
  const r = await lineRow(id);
  assert.equal(r.matched_kind, 'dispute'); // must never masquerade as revenue
  assert.equal(r.proposal_payment_id, paymentId);
  assert.equal(r.proposal_id, proposalId);
});

test('matcher: proposal_payments lookup is scoped to succeeded (ignores a failed dup) [finding 5]', async () => {
  const dup = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
     VALUES ($1,$2,'deposit',45000,'failed') RETURNING id`, [proposalId, `pi_test_${N}`]);
  try {
    const id = await makePendingLine(`txn_test_${N}_m9`, { stripe_payment_intent_id: `pi_test_${N}` });
    await sync.matchLine(id);
    const r = await lineRow(id);
    assert.equal(r.matched_kind, 'payment');
    assert.equal(r.proposal_payment_id, paymentId, 'resolves the succeeded row, not the failed dup');
  } finally {
    await pool.query('DELETE FROM proposal_payments WHERE id = $1', [dup.rows[0].id]);
  }
});

test('sweep isolates a per-payout failure: a bad payout does not abort the rest [finding 2]', async () => {
  const poBad = `po_test_${N}_iso_bad`;
  const poGood = `po_test_${N}_iso_good`;
  const stripe = {
    payouts: { list: async () => ({ data: [payoutObj({ id: poBad }), payoutObj({ id: poGood })], has_more: false }) },
    balanceTransactions: {
      list: async (params = {}) => {
        if (params.payout === poBad) throw new Error('stripe 500 on bad payout lines');
        if (params.payout === poGood) return { data: [chargeTxn(`txn_test_${N}_iso`)], has_more: false };
        return { data: [], has_more: false }; // pending pass
      },
    },
  };
  await sync.sweep({ stripe, notify: async () => {}, force: true });
  const good = (await pool.query('SELECT lines_synced_at FROM stripe_payouts WHERE stripe_payout_id=$1', [poGood])).rows[0];
  assert.ok(good && good.lines_synced_at, 'the good payout still synced despite the bad one throwing');
  assert.ok(sync.getLastSweepAt(), 'sweep completed and stamped lastSweepAt');
});

test('sweep with fullHistory:true uses full-history listing even when table is non-empty [finding 3]', async () => {
  let seenParams = [];
  const stripe = {
    payouts: { list: async (p) => { seenParams.push(p); return { data: [], has_more: false }; } },
    balanceTransactions: { list: async () => ({ data: [], has_more: false }) },
  };
  await sync.sweep({ stripe, notify: async () => {}, force: true, fullHistory: true });
  assert.ok(!seenParams[0].created, 'fullHistory must NOT scope to a 30-day window');
});

test('sweep refuses to run in test mode without an injected client [finding 1]', async () => {
  const before = (await pool.query(
    'SELECT (SELECT COUNT(*)::int FROM stripe_payouts) po, (SELECT COUNT(*)::int FROM stripe_payout_lines) ln')).rows[0];
  const lastBefore = sync.getLastSweepAt();
  const saved = process.env.STRIPE_TEST_MODE_UNTIL;
  process.env.STRIPE_TEST_MODE_UNTIL = new Date(Date.now() + 86400000).toISOString();
  try {
    const r = await sync.sweep({ notify: async () => {} }); // NO stripe option -> guard fires before client resolution
    assert.deepEqual(r, { skipped: 'test_mode' });
  } finally {
    if (saved === undefined) delete process.env.STRIPE_TEST_MODE_UNTIL;
    else process.env.STRIPE_TEST_MODE_UNTIL = saved;
  }
  const after = (await pool.query(
    'SELECT (SELECT COUNT(*)::int FROM stripe_payouts) po, (SELECT COUNT(*)::int FROM stripe_payout_lines) ln')).rows[0];
  assert.deepEqual(after, before, 'no rows changed by a test-mode-skipped sweep');
  assert.equal(sync.getLastSweepAt(), lastBefore, 'lastSweepAt untouched');
});
