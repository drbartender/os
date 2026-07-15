'use strict';

/**
 * Refund pending sweep (B6) — heals stranded 'pending' proposal_refunds rows.
 *
 * refundExecute writes a 'pending' row BEFORE calling Stripe (crash-safety), and
 * a pending row deliberately blocks refund headroom (e97dfec). Two failure
 * quadrants leave that pending row with no healer:
 *   1. A crash between the INSERT and Stripe success → no refund exists at
 *      Stripe, so no charge.refunded webhook ever adopts it. It strands forever,
 *      permanently under-refunding and invisible in the admin history view.
 *   2. An ambiguous Stripe error (connection timeout, 5xx) now LEAVES the row
 *      pending (refundExecute split), so a real refund may exist at Stripe while
 *      our row still says pending.
 *
 * This sweep is the only reconciler that consults Stripe as the source of truth
 * for those rows: for each aged pending row it lists the charge's refunds and
 * either ADOPTS a matching one (through applyRefundReconciliation, the single
 * P6.4 authority) or, when Stripe confirms no refund exists, marks the row
 * 'failed'. It mirrors the stripePayoutSync DI/test-hook pattern.
 *
 * ONE-CONNECTION RULE: stripe.refunds.list() completes BEFORE pool.connect();
 * the adoption transaction runs entirely on the held client; the client
 * notification tail runs AFTER release.
 */

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { getStripe } = require('./stripeClient');
const { applyRefundReconciliation } = require('./refundHelpers');
const { sendRefundClientNotification } = require('./refundClientNotify');

const AGE_MINUTES = 30;   // don't touch a row until Stripe's SDK retries/in-flight creates have settled
const BATCH_LIMIT = 25;   // rows healed per tick (ORDER BY created_at ASC)

let testStripe = null;
function _setStripeClientForTests(fake) {
  if (process.env.NODE_ENV === 'production') throw new Error('test hook disabled in production');
  testStripe = fake;
}
function client(opts) { return (opts && opts.stripe) || testStripe || getStripe(); }

// Warn-once-then-daily for permanently-ambiguous rows (NULL intent, multiple
// same-amount candidates, ...). In-memory Map keyed by refund row id; a redeploy
// resets it (worst case: one re-warn per deploy, bounded). Entries are pruned
// once they age well past the re-warn interval so the Map can't grow unbounded.
const WARN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const warnedAt = new Map();

function pruneWarnMap(now) {
  for (const [id, at] of warnedAt) {
    if (now - at > 2 * WARN_INTERVAL_MS) warnedAt.delete(id);
  }
}

function warnOnce(row, message, extra = {}) {
  const now = Date.now();
  const last = warnedAt.get(row.id);
  if (last !== undefined && now - last < WARN_INTERVAL_MS) return; // re-warn at most daily
  warnedAt.set(row.id, now);
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage(`refund_pending_sweep: ${message}`, {
      level: 'warning',
      tags: { scheduler: 'refund_pending_sweep', outcome: 'ambiguous_pending' },
      extra: { proposalId: row.proposal_id, rowId: row.id, amount: row.amount, ...extra },
    });
  }
}

// Adopt a Stripe refund onto its pending row through the single reconciliation
// authority. One pooled connection: BEGIN → apply → COMMIT → release, then the
// email-only client notification tails AFTER release, gated on recon.applied.
async function adoptCandidate(row, candidate) {
  const dbClient = await pool.connect();
  let recon;
  try {
    await dbClient.query('BEGIN');
    recon = await applyRefundReconciliation(
      {
        proposalId: Number(row.proposal_id),
        stripeRefundId: candidate.id,
        paymentIntentId: row.stripe_payment_intent_id,
        paymentId: row.payment_id,
        amountCents: row.amount,
        reason: row.reason,
        issuedBy: null,
      },
      dbClient
    );
    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, {
        tags: { scheduler: 'refund_pending_sweep', outcome: 'adopt_error' },
        extra: { proposalId: row.proposal_id, rowId: row.id, stripeRefundId: candidate.id },
      });
    }
    console.error('refund_pending_sweep adoption failed:', err);
    return false;
  } finally {
    dbClient.release();
  }
  // Post-release tail. Only the sweep that APPLIED the adoption emails the
  // client (source 'pending_sweep', email-only), mirroring the sync route + the
  // webhook so a redelivery can never double-send.
  if (recon && recon.applied) {
    await sendRefundClientNotification({
      proposalId: row.proposal_id,
      amountCents: row.amount,
      source: 'pending_sweep',
    });
  }
  return recon ? recon.applied : false;
}

// Resolve ONE aged pending row against Stripe. Returns 'adopted' | 'failed' |
// 'skipped'. NEVER holds a pooled connection across the Stripe list() call.
async function processRow(stripe, row) {
  let list;
  try {
    // AMENDMENT (b): a THROWN list error (wrong mode under STRIPE_TEST_MODE_UNTIL,
    // outage) SKIPS the row — it stays pending, is Sentry-tagged, and NEVER
    // reaches the mark-failed branch. Mark-failed fires only on a successful,
    // intent-filtered, candidate-less list.
    list = await stripe.refunds.list({ payment_intent: row.stripe_payment_intent_id, limit: 100 });
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, {
        tags: { scheduler: 'refund_pending_sweep', outcome: 'list_error_skip' },
        extra: { proposalId: row.proposal_id, rowId: row.id, paymentIntentId: row.stripe_payment_intent_id },
      });
    }
    return 'skipped';
  }

  const data = Array.isArray(list && list.data) ? list.data : [];
  // Candidates = Stripe refunds not failed/canceled whose id is NOT already
  // recorded in proposal_refunds.
  const candidates = [];
  for (const r of data) {
    if (r.status === 'failed' || r.status === 'canceled') continue;
    const existing = await pool.query('SELECT 1 FROM proposal_refunds WHERE stripe_refund_id = $1', [r.id]);
    if (existing.rows.length === 0) candidates.push(r);
  }

  // Match by metadata row-id anchor first (exact); else fall back to a unique
  // amount match. Multiple same-amount unmatched candidates: never guess.
  let candidate = candidates.find(
    (r) => r.metadata && String(r.metadata.proposal_refund_row_id) === String(row.id)
  );
  if (!candidate) {
    const sameAmount = candidates.filter((r) => r.amount === row.amount);
    if (sameAmount.length === 1) {
      candidate = sameAmount[0];
    } else if (sameAmount.length > 1) {
      warnOnce(row, `${sameAmount.length} same-amount unmatched refund candidates on this intent; leaving pending`);
      return 'skipped';
    }
  }

  if (candidate) {
    const applied = await adoptCandidate(row, candidate);
    return applied ? 'adopted' : 'skipped';
  }

  // No candidate on a SUCCESSFUL, intent-filtered list → the refund never
  // reached Stripe. Guarded mark-failed so a concurrent webhook adoption (which
  // sets status + stripe_refund_id) wins the race instead of being clobbered.
  const upd = await pool.query(
    `UPDATE proposal_refunds SET status = 'failed'
      WHERE id = $1 AND status = 'pending' AND stripe_refund_id IS NULL`,
    [row.id]
  );
  if (upd.rowCount > 0) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage('refund_pending_sweep: stranded pre-Stripe pending row marked failed', {
        level: 'warning',
        tags: { scheduler: 'refund_pending_sweep', outcome: 'strand_healed' },
        extra: { proposalId: row.proposal_id, rowId: row.id, amount: row.amount },
      });
    }
    return 'failed';
  }
  return 'skipped'; // lost the race to a concurrent adoption — nothing to do
}

/**
 * Sweep aged, stranded 'pending' refund rows and reconcile them against Stripe.
 * @param {{stripe?:object}} [opts]  DI Stripe client (falls back to the test hook, then getStripe()).
 * @returns {Promise<{skipped?:string, scanned:number, adopted:number, failed:number, untouched:number}>}
 */
async function sweepStalePendingRefunds(opts = {}) {
  const stripe = client(opts);
  if (!stripe) return { skipped: 'payments_unconfigured' }; // no-op when Stripe isn't configured

  pruneWarnMap(Date.now());

  // AMENDMENT (a): NULL-intent aged rows are unadoptable — stripe-node drops an
  // undefined param, so refunds.list would go ACCOUNT-WIDE and the unique-amount
  // fallback could adopt a FOREIGN proposal's refund (ledger corruption). They
  // are Sentry-warned (deduped) and SKIPPED here — never listed.
  const nullIntent = await pool.query(
    `SELECT id, proposal_id, amount FROM proposal_refunds
      WHERE status = 'pending' AND stripe_refund_id IS NULL
        AND stripe_payment_intent_id IS NULL
        AND created_at < NOW() - make_interval(mins => $1)
      ORDER BY created_at ASC LIMIT $2`,
    [AGE_MINUTES, BATCH_LIMIT]
  );
  for (const row of nullIntent.rows) {
    warnOnce(row, 'aged pending refund row has NULL payment_intent (unadoptable; skipped)');
  }

  const { rows } = await pool.query(
    `SELECT id, proposal_id, payment_id, stripe_payment_intent_id, amount, reason, created_at
       FROM proposal_refunds
      WHERE status = 'pending'
        AND stripe_refund_id IS NULL
        AND stripe_payment_intent_id IS NOT NULL
        AND created_at < NOW() - make_interval(mins => $1)
      ORDER BY created_at ASC
      LIMIT $2`,
    [AGE_MINUTES, BATCH_LIMIT]
  );

  let adopted = 0, failed = 0, untouched = 0;
  for (const row of rows) {
    const outcome = await processRow(stripe, row);
    if (outcome === 'adopted') adopted += 1;
    else if (outcome === 'failed') failed += 1;
    else untouched += 1;
  }
  return { scanned: rows.length, adopted, failed, untouched };
}

module.exports = { sweepStalePendingRefunds, _setStripeClientForTests };
