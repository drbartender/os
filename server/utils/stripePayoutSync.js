/**
 * Stripe payout tracking — read-side mirror sync (spec 2026-07-01).
 * All ingest paths converge here through idempotent upserts keyed on Stripe ids.
 * OWNERSHIP RULE: only syncPayout ever sets/changes payout_id on a line; the
 * pending path is insert-only (ON CONFLICT DO NOTHING), or it would un-claim
 * settled lines and flip them back to "in transit".
 */
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { getStripe, isTestMode } = require('./stripeClient');
const { notifyAdminCategory } = require('./adminNotifications');

const RECHECK_DAYS = 30;
let lastSweepAt = null;
let inFlight = null;
let testStripe = null;

function _setStripeClientForTests(fake) {
  if (process.env.NODE_ENV === 'production') throw new Error('test hook disabled in production');
  testStripe = fake;
}
function client(opts) { return (opts && opts.stripe) || testStripe || getStripe(); }
const ts = (unix) => (unix ? new Date(unix * 1000) : null);

async function listAll(listFn, params) {
  const out = [];
  let starting_after;
  for (;;) {
    const page = await listFn({ limit: 100, ...params, ...(starting_after ? { starting_after } : {}) });
    out.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return out;
}

function lineFieldsFromTxn(txn) {
  const src = (txn.source && typeof txn.source === 'object') ? txn.source : {};
  const srcId = typeof txn.source === 'string' ? txn.source : (src.id || null);
  return {
    txn_type: txn.type,
    reporting_category: txn.reporting_category || null,
    amount_cents: txn.amount,
    fee_cents: txn.fee || 0,
    net_cents: txn.net,
    available_on: ts(txn.available_on),
    description: txn.description || null,
    stripe_charge_id: src.charge || (srcId && srcId.startsWith('ch_') ? srcId : null),
    stripe_payment_intent_id: src.payment_intent || null,
    stripe_refund_id: srcId && srcId.startsWith('re_') ? srcId : null,
  };
}

async function upsertPayoutRow(p) {
  const { rows } = await pool.query(
    `INSERT INTO stripe_payouts (stripe_payout_id, amount_cents, currency, status,
       created_at_stripe, arrival_date, automatic, livemode, method, description,
       failure_code, failure_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (stripe_payout_id) DO UPDATE SET
       status = EXCLUDED.status, arrival_date = EXCLUDED.arrival_date,
       failure_code = EXCLUDED.failure_code, failure_message = EXCLUDED.failure_message,
       updated_at = NOW()
     RETURNING id, lines_synced_at`,
    [p.id, p.amount, p.currency || 'usd', p.status, ts(p.created), ts(p.arrival_date),
     p.automatic !== false, p.livemode !== false, p.method || null, p.description || null,
     p.failure_code || null, p.failure_message || null]);
  return rows[0];
}

// Claiming upsert — the ONLY place payout_id is ever written.
async function upsertLineForPayout(payoutRowId, f) {
  const { rows } = await pool.query(
    `INSERT INTO stripe_payout_lines (stripe_balance_txn_id, payout_id, txn_type,
       reporting_category, amount_cents, fee_cents, net_cents, available_on, description,
       stripe_charge_id, stripe_payment_intent_id, stripe_refund_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (stripe_balance_txn_id) DO UPDATE SET payout_id = EXCLUDED.payout_id, updated_at = NOW()
     RETURNING id, matched_kind`,
    [f.id, payoutRowId, f.txn_type, f.reporting_category, f.amount_cents, f.fee_cents,
     f.net_cents, f.available_on, f.description, f.stripe_charge_id,
     f.stripe_payment_intent_id, f.stripe_refund_id]);
  return rows[0];
}

// Pending path — insert-only by design (ownership rule).
async function insertPendingLine(f) {
  const { rows } = await pool.query(
    `INSERT INTO stripe_payout_lines (stripe_balance_txn_id, payout_id, txn_type,
       reporting_category, amount_cents, fee_cents, net_cents, available_on, description,
       stripe_charge_id, stripe_payment_intent_id, stripe_refund_id)
     VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (stripe_balance_txn_id) DO NOTHING
     RETURNING id`,
    [f.id, f.txn_type, f.reporting_category, f.amount_cents, f.fee_cents, f.net_cents,
     f.available_on, f.description, f.stripe_charge_id, f.stripe_payment_intent_id,
     f.stripe_refund_id]);
  return rows[0] || null; // null = already existed
}

async function syncPayout(payoutObj, opts = {}) {
  if (payoutObj.livemode === false) return { skipped: 'livemode' };
  const stripe = client(opts);
  const row = await upsertPayoutRow(payoutObj);
  if (payoutObj.status === 'paid') {
    const txns = await listAll(
      (p) => stripe.balanceTransactions.list({ ...p, payout: payoutObj.id, expand: ['data.source'] }), {});
    for (const txn of txns) {
      if (txn.type === 'payout') continue; // the payout's own negative txn
      const line = await upsertLineForPayout(row.id, { id: txn.id, ...lineFieldsFromTxn(txn) });
      await matchLine(line.id); // Task 3
    }
    await pool.query('UPDATE stripe_payouts SET lines_synced_at = NOW(), updated_at = NOW() WHERE id = $1', [row.id]);
  }
  return { id: row.id };
}

async function syncPendingTransactions(opts = {}) {
  // Test-mode guard: without an injected client, getStripe() returns the TEST
  // client while STRIPE_TEST_MODE_UNTIL is active. Balance transactions carry no
  // livemode field, so a per-txn guard cannot work — refuse the whole ingest.
  if (!opts.stripe && isTestMode()) return { skipped: 'test_mode' };
  const stripe = client(opts);
  const since = Math.floor(Date.now() / 1000) - RECHECK_DAYS * 86400;
  const txns = await listAll(
    (p) => stripe.balanceTransactions.list({ ...p, created: { gte: since }, expand: ['data.source'] }), {});
  for (const txn of txns) {
    if (txn.type === 'payout') continue;
    const inserted = await insertPendingLine({ id: txn.id, ...lineFieldsFromTxn(txn) });
    if (inserted) await matchLine(inserted.id);
  }
}

const ADJUSTMENT_CATS = ['adjustment', 'other_adjustment', 'fee', 'payout_failure', 'stripe_fee'];

async function matchLine(lineId) {
  const { rows } = await pool.query('SELECT * FROM stripe_payout_lines WHERE id = $1', [lineId]);
  const line = rows[0];
  if (!line) return;
  const cat = line.reporting_category || line.txn_type;
  let kind = 'unmatched';
  let paymentId = null, tipId = null, refundId = null, proposalId = null, invoiceId = null;

  if (cat === 'refund' && line.stripe_refund_id) {
    const r = await pool.query(
      'SELECT id, proposal_id FROM proposal_refunds WHERE stripe_refund_id = $1', [line.stripe_refund_id]);
    if (r.rows[0]) { kind = 'refund'; refundId = r.rows[0].id; proposalId = r.rows[0].proposal_id; }
  } else if (line.stripe_payment_intent_id) {
    // The CATEGORY decides the kind; the PI only resolves the links. A fee
    // adjustment with a resolvable PI must stay 'adjustment', never masquerade
    // as revenue.
    // Any dispute-family category (dispute, dispute_reversal, ...) stays a
    // dispute; it must never land in the 'payment' revenue bucket via its PI.
    const linkedKind = cat.startsWith('dispute') ? 'dispute'
      : ADJUSTMENT_CATS.includes(cat) ? 'adjustment' : 'payment';
    // Scope to the succeeded row: a PI can carry both a failed and a succeeded
    // proposal_payments row; only the succeeded one is real (and matches the
    // partial unique index idx_proposal_payments_intent_unique).
    const p = await pool.query(
      "SELECT id, proposal_id FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = 'succeeded'",
      [line.stripe_payment_intent_id]);
    if (p.rows[0]) {
      kind = linkedKind;
      paymentId = p.rows[0].id; proposalId = p.rows[0].proposal_id;
      const inv = await pool.query(
        'SELECT invoice_id FROM invoice_payments WHERE payment_id = $1 ORDER BY id DESC LIMIT 1', [paymentId]);
      if (inv.rows[0]) invoiceId = inv.rows[0].invoice_id;
    } else {
      const t = await pool.query('SELECT id FROM tips WHERE stripe_payment_intent_id = $1',
        [line.stripe_payment_intent_id]);
      if (t.rows[0]) { kind = linkedKind === 'payment' ? 'tip' : linkedKind; tipId = t.rows[0].id; }
    }
  }
  // Fee-adjustment family: label as adjustment even when unresolvable to a proposal.
  if (kind === 'unmatched' && ADJUSTMENT_CATS.includes(cat)) kind = 'adjustment';
  await pool.query(
    `UPDATE stripe_payout_lines SET matched_kind=$2, proposal_payment_id=$3, tip_id=$4,
       proposal_refund_id=$5, proposal_id=$6, invoice_id=$7, updated_at=NOW() WHERE id=$1`,
    [lineId, kind, paymentId, tipId, refundId, proposalId, invoiceId]);
}

async function alertFailedPayout(stripePayoutId, opts = {}) {
  const notify = opts.notify || notifyAdminCategory;
  // Atomic claim — never check-then-act; webhook retry, sweep, and tab-open sync race.
  const claim = await pool.query(
    `UPDATE stripe_payouts SET alerted_at = NOW()
     WHERE stripe_payout_id = $1 AND alerted_at IS NULL RETURNING id, amount_cents, failure_code, failure_message, arrival_date`,
    [stripePayoutId]);
  if (claim.rowCount !== 1) return { alreadyAlerted: true };
  const p = claim.rows[0];
  const amt = `$${(p.amount_cents / 100).toFixed(2)}`;
  try {
    await notify({
      category: 'stripe_payout_failed',
      subject: `Stripe payout FAILED: ${amt} (${p.failure_code || 'unknown'})`,
      emailText: `A Stripe payout of ${amt} to the bank account failed.\n\nReason: ${p.failure_message || p.failure_code || 'unknown'}\nPayout: ${stripePayoutId}\n\nCheck the bank account in the Stripe dashboard; Stripe pauses payouts until it is fixed.`,
      emailHtml: null, // adminNotifications falls back to text
    });
  } catch (err) {
    // Un-claim so the sweep retries the alert.
    await pool.query('UPDATE stripe_payouts SET alerted_at = NULL WHERE stripe_payout_id = $1', [stripePayoutId]);
    throw err;
  }
  return { alerted: true };
}

const STALE_MS = 15 * 60 * 1000;

async function sweep(opts = {}) {
  // Test-mode guard: fire BEFORE any client resolution. Without an injected
  // client, getStripe() returns the TEST client while STRIPE_TEST_MODE_UNTIL is
  // active, which would mirror test-mode balance txns into the live tables.
  // Injected-client callers (backfill) assert live themselves.
  if (!opts.stripe && isTestMode()) return { skipped: 'test_mode' };
  if (inFlight) return inFlight;
  if (!opts.force && lastSweepAt && Date.now() - new Date(lastSweepAt).getTime() < STALE_MS) {
    return { fresh: true }; // staleness gate lives here, not in the client
  }
  inFlight = (async () => {
    const stripe = client(opts);
    const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM stripe_payouts');
    // Full history on bootstrap (empty table) OR when a caller forces it (backfill
    // --full); otherwise the 30-day re-check window. Forcing --full recovers from a
    // partial bootstrap that left the table non-empty and silently narrowed re-runs.
    const fullHistory = opts.fullHistory === true || n === 0;
    const params = fullHistory ? {}
      : { created: { gte: Math.floor(Date.now() / 1000) - RECHECK_DAYS * 86400 } };
    const payouts = await listAll((p) => stripe.payouts.list({ ...p, ...params }), {});
    for (const p of payouts) {
      if (p.livemode === false) continue;
      // Per-payout isolation: one payout whose line fetch throws must not abort the
      // rest of the run (pending ingest, re-match, failed-payout alerts, lastSweepAt).
      try {
        const existing = await pool.query(
          'SELECT status, lines_synced_at FROM stripe_payouts WHERE stripe_payout_id = $1', [p.id]);
        const needLines = p.status === 'paid' &&
          (!existing.rows[0] || !existing.rows[0].lines_synced_at || existing.rows[0].status !== p.status);
        if (needLines) await syncPayout(p, { stripe });
        else await upsertPayoutRow(p); // cheap status/arrival refresh, no line fetch
      } catch (err) {
        Sentry.captureException(err, { tags: { sweep: 'stripe_payout', payout: p.id } });
      }
    }
    await syncPendingTransactions({ stripe });
    // Re-match: heals webhook-before-payment-row ordering races.
    const unmatched = await pool.query(
      `SELECT id FROM stripe_payout_lines WHERE matched_kind = 'unmatched'
       AND (stripe_payment_intent_id IS NOT NULL OR stripe_refund_id IS NOT NULL)`);
    for (const r of unmatched.rows) await matchLine(r.id);
    // Alert any failed payout not yet alerted (belt and braces for a missed webhook).
    const failed = await pool.query(
      `SELECT stripe_payout_id FROM stripe_payouts WHERE status = 'failed' AND alerted_at IS NULL`);
    for (const f of failed.rows) await alertFailedPayout(f.stripe_payout_id, opts);
    // Stuck-line signal: amber flags nobody watches need a Sentry pulse.
    const stuck = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stripe_payout_lines
       WHERE matched_kind = 'unmatched' AND payout_id IS NOT NULL AND created_at < NOW() - INTERVAL '7 days'`);
    if (stuck.rows[0].n > 0) {
      Sentry.captureMessage(`stripe-payouts: ${stuck.rows[0].n} line(s) unmatched for >7 days`, { level: 'warning' });
    }
    lastSweepAt = new Date().toISOString();
  })().finally(() => { inFlight = null; });
  return inFlight;
}

module.exports = {
  syncPayout, syncPendingTransactions, matchLine, sweep, alertFailedPayout,
  getLastSweepAt: () => lastSweepAt,
  _setStripeClientForTests,
};
