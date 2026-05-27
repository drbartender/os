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
const { isLegacyCcStubUser } = require('./payrollGuards');

async function clawbackTip(tipId, newCumulativeRefundedCents) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tipRes = await client.query(
      `SELECT id, shift_id, amount_cents, fee_cents, refunded_amount_cents, target_user_id
         FROM tips WHERE id = $1 FOR UPDATE`,
      [tipId]
    );
    const tip = tipRes.rows[0];
    if (!tip) { await client.query('ROLLBACK'); return null; }

    // cc-import: tips paid TO a legacy_cc:* stub bartender never had a modern
    // payout to claw back FROM (stubs are imports-only, no Stripe Connect).
    // Fires BEFORE any DB writes — leaves refunded_amount_cents at the prior
    // value so a re-run after a future de-stub can replay. clawbackTipByPaymentIntent
    // inherits this skip automatically since it calls clawbackTip internally.
    if (await isLegacyCcStubUser(tip.target_user_id, client)) {
      Sentry.captureMessage('clawbackTip: target is legacy_cc stub; skipping', {
        level: 'info',
        tags: { util: 'payrollClawback', step: 'skip_legacy_cc_stub' },
        extra: { tipId, targetUserId: tip.target_user_id },
      });
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'legacy_cc_stub_target' };
    }

    const original = Number(tip.amount_cents);
    const newAmt = Math.max(0, Math.min(Number(newCumulativeRefundedCents) || 0, original));
    const oldAmt = Number(tip.refunded_amount_cents || 0);
    const delta = newAmt - oldAmt;
    if (delta <= 0) { await client.query('ROLLBACK'); return { delta: 0 }; }

    // If the tip was never assigned to a shift, there's no line to claw back
    // FROM — just track the new cumulative and exit.
    if (!tip.shift_id) {
      await client.query('UPDATE tips SET refunded_amount_cents = $1 WHERE id = $2', [newAmt, tipId]);
      await client.query('COMMIT');
      return { delta, bartenders: 0 };
    }

    const bartendersRes = await client.query(
      `SELECT sr.user_id FROM shift_requests sr
        WHERE sr.shift_id = $1 AND sr.status = 'approved'
          AND LOWER(sr.position) = 'bartender'
        ORDER BY sr.user_id`,
      [tip.shift_id]
    );
    const bartenders = bartendersRes.rows.map(r => r.user_id);
    if (bartenders.length === 0) {
      await client.query('UPDATE tips SET refunded_amount_cents = $1 WHERE id = $2', [newAmt, tipId]);
      await client.query('COMMIT');
      return { delta, bartenders: 0 };
    }

    // Proportional fee on the delta.
    const feeDelta = original > 0
      ? Math.round(Number(tip.fee_cents || 0) * delta / original)
      : 0;
    const netDelta = delta - feeDelta;
    const perBartenderShares = splitEvenly(netDelta, bartenders.length);

    // Find/create the open period containing today.
    const todayYmd = new Date().toISOString().slice(0, 10);
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
      // Defer: don't move cumulative either, so a later retry can do this work.
      // Log to Sentry so a persistent defer doesn't silently disappear.
      Sentry.captureMessage("clawbackTip: today's period is non-open; deferring", {
        level: 'warning',
        tags: { util: 'payrollClawback', step: 'defer_frozen_today' },
        extra: { tipId, periodStatus: period.status, delta, newAmt },
      });
      await client.query('ROLLBACK');
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

      // ON CONFLICT: ADD to existing adjustment_cents, append to adjustment_note.
      await client.query(
        `INSERT INTO payout_events
           (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
            adjustment_cents, adjustment_note, line_total_cents)
         VALUES ($1, $2, 0, 0, 0, 0, $3, $4, GREATEST(0, $3))
         ON CONFLICT (payout_id, shift_id) DO UPDATE SET
           adjustment_cents = payout_events.adjustment_cents + EXCLUDED.adjustment_cents,
           adjustment_note  = COALESCE(payout_events.adjustment_note, '') ||
             CASE WHEN payout_events.adjustment_note IS NULL OR payout_events.adjustment_note = ''
                  THEN '' ELSE '; ' END ||
             EXCLUDED.adjustment_note,
           line_total_cents = GREATEST(0,
             payout_events.wage_cents + payout_events.gratuity_share_cents
             + payout_events.card_tip_net_cents
             + payout_events.adjustment_cents + EXCLUDED.adjustment_cents)`,
        [payoutId, tip.shift_id, negAdj, note]
      );
    }

    await client.query(
      `UPDATE payouts po SET total_cents = GREATEST(0, COALESCE((
         SELECT SUM(line_total_cents) FROM payout_events WHERE payout_id = po.id
       ), 0))
       WHERE po.id = ANY($1)`,
      [touched]
    );

    await client.query('UPDATE tips SET refunded_amount_cents = $1 WHERE id = $2', [newAmt, tipId]);
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
 */
async function clawbackTipByPaymentIntent(paymentIntentId, newCumulativeCents) {
  if (!paymentIntentId || !Number.isInteger(newCumulativeCents) || newCumulativeCents <= 0) return;
  const { rows } = await pool.query(
    'SELECT id FROM tips WHERE stripe_payment_intent_id = $1',
    [paymentIntentId]
  );
  if (!rows[0]) return;
  try { await clawbackTip(rows[0].id, newCumulativeCents); }
  catch (err) { Sentry.captureException(err, { tags: { webhook: 'tip_clawback', step: 'clawback' } }); }
}

module.exports = { clawbackTip, clawbackTipByPaymentIntent };
