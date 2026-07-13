/**
 * Auto-clawback for a card tip that was already paid out and is now being
 * refunded (or chargeback funds were withdrawn during a dispute). The
 * bartender's pro-rata share of the clawback amount lands as a NEGATIVE
 * adjustment_cents on a synthetic payout_events row in the bartender's
 * open-period payout, keyed by the ORIGINAL shift so the line labels back.
 *
 * Idempotent via tips.refunded_amount_cents: the function only ever moves
 * the delta beyond what was already clawed, so a webhook replay with the
 * same cumulative is delta=0 and no-ops.
 */
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { findOpenPeriodForDate } = require('./payrollProcessing');
const { payPeriodForDate, computePayday } = require('./payrollPeriods');
const { splitEvenly } = require('./payrollMath');
const { chicagoTodayYmd } = require('./businessTime');

async function clawbackTip(tipId, newCumulativeRefundedCents) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tipRes = await client.query(
      `SELECT id, shift_id, amount_cents, fee_cents, refunded_amount_cents, target_user_id,
              deferred_at, defer_kind
         FROM tips WHERE id = $1 FOR UPDATE`,
      [tipId]
    );
    const tip = tipRes.rows[0];
    if (!tip) { await client.query('ROLLBACK'); return null; }

    const original = Number(tip.amount_cents);
    const newAmt = Math.max(0, Math.min(Number(newCumulativeRefundedCents) || 0, original));
    const oldAmt = Number(tip.refunded_amount_cents || 0);
    const delta = newAmt - oldAmt;
    if (delta <= 0) { await client.query('ROLLBACK'); return { delta: 0 }; }

    // §3.6: a refund on a tip still roll_forward-deferred (never placed) must not
    // claw a line that doesn't exist. Record the refund, cancel the roll-forward.
    if (tip.shift_id && tip.deferred_at && tip.defer_kind === 'roll_forward') {
      await client.query(
        `UPDATE tips SET refunded_amount_cents = $1, rolled_forward_at = NOW(),
                deferred_at = NULL, defer_kind = NULL, defer_target_cents = NULL, defer_attempts = 0
          WHERE id = $2`,
        [newAmt, tipId]
      );
      await client.query('COMMIT');
      return { delta, bartenders: 0, unplaced: true };
    }

    // If the tip was never assigned to a shift, there's no line to claw back
    // FROM — just track the new cumulative and exit.
    if (!tip.shift_id) {
      await client.query(
        `UPDATE tips SET refunded_amount_cents = $1, deferred_at = NULL,
                defer_kind = NULL, defer_target_cents = NULL, defer_attempts = 0
          WHERE id = $2`, [newAmt, tipId]);
      await client.query('COMMIT');
      return { delta, bartenders: 0 };
    }

    const bartendersRes = await client.query(
      `SELECT sr.user_id, (u.cc_id LIKE 'legacy_cc:%') AS is_stub
         FROM shift_requests sr
         JOIN users u ON u.id = sr.user_id
        WHERE sr.shift_id = $1 AND sr.status = 'approved' AND sr.dropped_at IS NULL
          AND LOWER(sr.position) = 'bartender'
        ORDER BY sr.user_id`,
      [tip.shift_id]
    );
    const allBartenders = bartendersRes.rows;
    const bartenders = allBartenders.filter(r => !r.is_stub).map(r => r.user_id);
    const stubCount = allBartenders.length - bartenders.length;

    if (allBartenders.length === 0) {
      await client.query(
        `UPDATE tips SET refunded_amount_cents = $1, deferred_at = NULL,
                defer_kind = NULL, defer_target_cents = NULL, defer_attempts = 0
          WHERE id = $2`, [newAmt, tipId]);
      await client.query('COMMIT');
      return { delta, bartenders: 0 };
    }

    if (bartenders.length === 0) {
      // All shift bartenders are stubs — recoverable: do NOT advance
      // refunded_amount_cents so a future de-stub can replay.
      Sentry.captureMessage('clawbackTip: all shift bartenders are legacy_cc stubs; skipping', {
        level: 'info',
        tags: { util: 'payrollClawback', step: 'skip_all_stubs' },
        extra: { tipId, shiftId: tip.shift_id, stubCount },
      });
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'all_bartenders_are_legacy_cc_stubs' };
    }

    // Fee share of this refund slice, computed cumulatively so rounding at each
    // partial-refund boundary never drifts a cent: the fee owed on the new
    // cumulative refunded total minus the fee already clawed on the prior one.
    // (A per-delta round can lose a cent across multiple partial refunds, e.g.
    // 100c tip / 33c fee refunded in two 50c slices claws 34c not 33c.)
    const feeCents = Number(tip.fee_cents || 0);
    const feeDelta = original > 0
      ? Math.round(feeCents * newAmt / original) - Math.round(feeCents * oldAmt / original)
      : 0;
    const netDelta = delta - feeDelta;
    const perBartenderShares = splitEvenly(netDelta, bartenders.length);

    // Find/create the open period containing today. "Today" is the business day
    // in America/Chicago, not the server's UTC/GMT day: a late-evening clawback
    // in Chicago must land in the CURRENT Tue-Mon period, not next week's (which
    // the UTC day would pick once past ~6-7pm Central).
    const todayYmd = chicagoTodayYmd();
    let period = await findOpenPeriodForDate(client, todayYmd);
    if (!period) {
      const { startDate, endDate } = payPeriodForDate(todayYmd);
      const payday = computePayday(endDate);
      const ins = await client.query(
        `INSERT INTO pay_periods (start_date, end_date, payday, status)
         VALUES ($1, $2, $3, 'open')
         ON CONFLICT (start_date) DO UPDATE SET status = pay_periods.status
         RETURNING id, status`,
        [startDate, endDate, payday]
      );
      period = ins.rows[0];
    }
    if (period.status !== 'open') {
      // Defer: don't move the cumulative; persist a marker (with the target) so a
      // retry can re-apply this clawback once a period opens.
      await client.query('ROLLBACK');
      try {
        // Reuse this client (a rolled-back client is back in autocommit and fully
        // reusable) rather than pool.query(), which would take a SECOND pooled
        // connection while we still hold this one. On a refund/dispute webhook storm
        // enough handlers each holding two connections exhaust the pool.
        await client.query(
          `UPDATE tips
              SET deferred_at = COALESCE(deferred_at, NOW()),
                  defer_kind = 'clawback', defer_target_cents = $2,
                  defer_attempts = defer_attempts + 1
            WHERE id = $1 AND refunded_amount_cents < $2`,
          [tipId, newAmt]
        );
      } catch (markErr) {
        Sentry.captureException(markErr, {
          tags: { util: 'payrollClawback', step: 'defer_mark_failed' }, extra: { tipId },
        });
      }
      Sentry.captureMessage("clawbackTip: today's period is non-open; deferring", {
        level: 'warning',
        tags: { util: 'payrollClawback', step: 'defer_frozen_today' },
        extra: { tipId, periodStatus: period.status, delta, newAmt },
      });
      return null;
    }

    // Note includes the delta AND the cumulative refunded amount so an admin
    // reading the audit trail can distinguish multiple partial refunds.
    const note = `Chargeback on tip ${tipId}: +$${(delta / 100).toFixed(2)} (cumulative $${(newAmt / 100).toFixed(2)})`;
    const touched = [];
    for (let i = 0; i < bartenders.length; i += 1) {
      const userId = bartenders[i];
      const negAdj = -perBartenderShares[i];

      const poRes = await client.query(
        `INSERT INTO payouts (pay_period_id, contractor_id)
         VALUES ($1, $2)
         ON CONFLICT (pay_period_id, contractor_id) DO UPDATE
           SET pay_period_id = EXCLUDED.pay_period_id
         RETURNING id`,
        [period.id, userId]
      );
      const payoutId = poRes.rows[0].id;
      touched.push(payoutId);

      // Lines may go NEGATIVE (seam-sweep H1, decided 2026-07-02): a clawback
      // whose original wage line lives in a prior (already-paid) period lands
      // as a fresh synthetic row keyed by the ORIGINAL shift, and its negative
      // line_total is what actually reduces this period's pay. The old
      // GREATEST(0, ...) floor zeroed exactly that row, so cross-period
      // clawbacks were silently never collected. The payout-level total is
      // still clamped at 0 below (money out can't be negative); the negative
      // nets against the bartender's other lines first.
      // ON CONFLICT: ADD to existing adjustment_cents, append to adjustment_note.
      await client.query(
        `INSERT INTO payout_events
           (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
            adjustment_cents, adjustment_note, line_total_cents)
         VALUES ($1, $2, 0, 0, 0, 0, $3, $4, $3)
         ON CONFLICT (payout_id, shift_id) DO UPDATE SET
           adjustment_cents = payout_events.adjustment_cents + EXCLUDED.adjustment_cents,
           adjustment_note  = COALESCE(payout_events.adjustment_note, '') ||
             CASE WHEN payout_events.adjustment_note IS NULL OR payout_events.adjustment_note = ''
                  THEN '' ELSE '; ' END ||
             EXCLUDED.adjustment_note,
           line_total_cents =
             payout_events.wage_cents + payout_events.gratuity_share_cents
             + payout_events.card_tip_net_cents
             + payout_events.adjustment_cents + EXCLUDED.adjustment_cents`,
        [payoutId, tip.shift_id, negAdj, note]
      );
    }

    const totalsRes = await client.query(
      `UPDATE payouts po SET total_cents = GREATEST(0, COALESCE((
         SELECT SUM(line_total_cents) FROM payout_events WHERE payout_id = po.id
       ), 0))
       WHERE po.id = ANY($1)
       RETURNING po.id, po.contractor_id, po.total_cents,
         COALESCE((SELECT SUM(line_total_cents) FROM payout_events WHERE payout_id = po.id), 0) AS raw_sum`,
      [touched]
    );
    // If the payout-level clamp engaged (raw sum below zero), the clamped
    // remainder is uncollectible from this period's payout. Warn loudly so the
    // admin can recover it manually (future wages, direct repayment).
    for (const row of totalsRes.rows) {
      const rawSum = Number(row.raw_sum);
      if (rawSum < 0) {
        Sentry.captureMessage('clawbackTip: payout clamped at 0; residual uncollected', {
          level: 'warning',
          tags: { util: 'payrollClawback', step: 'payout_clamp_residual' },
          extra: { tipId, payoutId: row.id, contractorId: row.contractor_id, residualCents: rawSum },
        });
      }
    }

    await client.query(
      `UPDATE tips SET refunded_amount_cents = $1, deferred_at = NULL,
              defer_kind = NULL, defer_target_cents = NULL, defer_attempts = 0
        WHERE id = $2`, [newAmt, tipId]);
    await client.query('COMMIT');
    return { delta, bartenders: bartenders.length, period_id: period.id };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already */ }
    Sentry.captureException(err, { tags: { util: 'payrollClawback' } });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Webhook entry point: look up the tip by Stripe payment_intent and run a
 * clawback for the new cumulative refunded amount. No-ops when the
 * payment_intent isn't a tip (e.g. a proposal payment refund).
 *
 * Errors propagate so the Stripe webhook returns 5xx and Stripe retries the
 * full delivery. clawbackTip is idempotent via tips.refunded_amount_cents
 * (delta=0 second pass), so retry is safe.
 */
async function clawbackTipByPaymentIntent(paymentIntentId, newCumulativeCents) {
  if (!paymentIntentId || !Number.isInteger(newCumulativeCents) || newCumulativeCents <= 0) return;
  const { rows } = await pool.query(
    'SELECT id FROM tips WHERE stripe_payment_intent_id = $1',
    [paymentIntentId]
  );
  if (!rows[0]) return;
  await clawbackTip(rows[0].id, newCumulativeCents);
}

module.exports = { clawbackTip, clawbackTipByPaymentIntent };
