/**
 * Roll a card tip that matched a shift in a frozen pay period forward onto
 * each bartender's payout in the open period containing today. The synthetic
 * payout_events row references the ORIGINAL shift so the line still labels
 * back to its true event — the period it lives in is just "where the money
 * lands now."
 *
 * Idempotent via tips.rolled_forward_at: a second call is a no-op.
 * Aggregates: multiple late tips for the same original shift, rolled forward
 * into the same open period, accumulate on one (payout_id, shift_id) row per
 * bartender via ON CONFLICT DO UPDATE.
 */
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { findOpenPeriodForDate } = require('./payrollProcessing');
const { payPeriodForDate, computePayday } = require('./payrollPeriods');
const { splitEvenly } = require('./payrollMath');
const { chicagoTodayYmd } = require('./businessTime');

async function rollForwardLateTip(tipId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the tip and check idempotency + preconditions.
    const tipRes = await client.query(
      `SELECT id, shift_id, amount_cents, fee_cents, rolled_forward_at, target_user_id
         FROM tips WHERE id = $1 FOR UPDATE`,
      [tipId]
    );
    const tip = tipRes.rows[0];
    if (!tip || !tip.shift_id || tip.rolled_forward_at) {
      await client.query('ROLLBACK');
      return null;
    }
    // Bartenders on the original shift. Stub users (cc_id LIKE 'legacy_cc:%')
    // are filtered out of the per-bartender split (they can't be paid through
    // Stripe Connect). If ALL bartenders are stubs, the rollforward is skipped
    // (recoverable: rolled_forward_at stays NULL and a deferral marker is set so
    // the retry sweep can replay after a future de-stub). If NO bartenders at
    // all, the tip is marked rolled forward (permanent: nothing to retry).
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
        `UPDATE tips SET rolled_forward_at = NOW(), deferred_at = NULL,
                defer_kind = NULL, defer_attempts = 0 WHERE id = $1`, [tipId]);
      await client.query('COMMIT');
      return { bartenders: 0 };
    }

    if (bartenders.length === 0) {
      // Every approved bartender is a legacy_cc stub (can't pay them through
      // Stripe Connect). Recoverable: rolled_forward_at stays NULL and we COMMIT
      // a deferral marker (mirroring the frozen-today branch) so the retry sweep
      // re-attempts once a bartender is de-stubbed. COALESCE keeps the original
      // deferred_at across repeat retries; defer_attempts bounds the auto-retry.
      await client.query(
        `UPDATE tips
            SET deferred_at = COALESCE(deferred_at, NOW()),
                defer_kind = 'roll_forward',
                defer_attempts = defer_attempts + 1
          WHERE id = $1`,
        [tipId]
      );
      await client.query('COMMIT');
      Sentry.captureMessage('rollForwardLateTip: all shift bartenders are legacy_cc stubs; skipping', {
        level: 'info',
        tags: { util: 'payrollLateTip', step: 'skip_all_stubs' },
        extra: { tipId, shiftId: tip.shift_id, stubCount },
      });
      return { skipped: true, reason: 'all_bartenders_are_legacy_cc_stubs' };
    }

    // Find/create the open period containing today. "Today" is the business
    // day in America/Chicago, not the server's UTC/GMT day: a late-evening
    // roll-forward in Chicago must land in the CURRENT Tue-Mon period, not next
    // week's (which the UTC day would pick once past ~6-7pm Central).
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
      // Today's period is itself frozen (atypical, recoverable). Discard the no-op
      // period upsert, then persist a deferral marker on a fresh connection.
      await client.query('ROLLBACK');
      try {
        // Guard on rolled_forward_at IS NULL so a placement that committed during
        // this race is never re-flagged (no resurrection / double-pay).
        await pool.query(
          `UPDATE tips
              SET deferred_at = COALESCE(deferred_at, NOW()),
                  defer_kind = 'roll_forward',
                  defer_attempts = defer_attempts + 1
            WHERE id = $1 AND rolled_forward_at IS NULL`,
          [tipId]
        );
      } catch (markErr) {
        Sentry.captureException(markErr, {
          tags: { util: 'payrollLateTip', step: 'defer_mark_failed' }, extra: { tipId },
        });
      }
      Sentry.captureMessage("rollForwardLateTip: today's period is non-open; deferring", {
        level: 'warning',
        tags: { util: 'payrollLateTip', step: 'defer_frozen_today' },
        extra: { tipId, periodStatus: period.status },
      });
      return null;
    }

    // Split the tip across bartenders.
    const n = bartenders.length;
    const grossShares = splitEvenly(Number(tip.amount_cents), n);
    const feeShares = splitEvenly(Number(tip.fee_cents || 0), n);

    const touched = [];
    for (let i = 0; i < n; i += 1) {
      const userId = bartenders[i];
      const gross = grossShares[i];
      const fee = feeShares[i];
      const net = gross - fee;

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

      // Aggregate INSERT: ON CONFLICT adds to the existing line. wage,
      // gratuity, hours, rate stay 0 (this is a tip-only synthetic row).
      // No line-level GREATEST(0, ...) floor (seam-sweep H1, 2026-07-02): this
      // late tip may roll forward onto a row that already carries a NEGATIVE
      // cross-period clawback adjustment_cents. Flooring the line here would
      // erase that debt residual before the payout-level clamp sums it (silent,
      // permanent under-collection — the exact H1 leak). Mirrors the floorless
      // contract in payrollClawback.js / payrollAccrual.js; the payout total is
      // still clamped at 0 below, so money out is never negative.
      await client.query(
        `INSERT INTO payout_events
           (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
            card_tip_gross_cents, card_tip_fee_cents, card_tip_net_cents, line_total_cents)
         VALUES ($1, $2, 0, 0, 0, 0, $3, $4, $5, $5)
         ON CONFLICT (payout_id, shift_id) DO UPDATE SET
           card_tip_gross_cents = payout_events.card_tip_gross_cents + EXCLUDED.card_tip_gross_cents,
           card_tip_fee_cents   = payout_events.card_tip_fee_cents   + EXCLUDED.card_tip_fee_cents,
           card_tip_net_cents   = payout_events.card_tip_net_cents   + EXCLUDED.card_tip_net_cents,
           line_total_cents     =
             payout_events.wage_cents + payout_events.gratuity_share_cents
             + payout_events.card_tip_net_cents + EXCLUDED.card_tip_net_cents
             + payout_events.adjustment_cents`,
        [payoutId, tip.shift_id, gross, fee, net]
      );
    }

    // Recompute every touched payout's total.
    await client.query(
      `UPDATE payouts po SET total_cents = GREATEST(0, COALESCE((
         SELECT SUM(line_total_cents) FROM payout_events WHERE payout_id = po.id
       ), 0))
       WHERE po.id = ANY($1)`,
      [touched]
    );

    // Mark idempotent.
    await client.query(
      `UPDATE tips SET rolled_forward_at = NOW(), deferred_at = NULL,
              defer_kind = NULL, defer_attempts = 0 WHERE id = $1`, [tipId]);
    await client.query('COMMIT');
    return { bartenders: n, period_id: period.id };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    Sentry.captureException(err, { tags: { util: 'payrollLateTip' } });
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { rollForwardLateTip };
