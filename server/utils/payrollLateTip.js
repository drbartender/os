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

async function rollForwardLateTip(tipId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the tip and check idempotency + preconditions.
    const tipRes = await client.query(
      `SELECT id, shift_id, amount_cents, fee_cents, rolled_forward_at
         FROM tips WHERE id = $1 FOR UPDATE`,
      [tipId]
    );
    const tip = tipRes.rows[0];
    if (!tip || !tip.shift_id || tip.rolled_forward_at) {
      await client.query('ROLLBACK');
      return null;
    }

    // Bartenders on the original shift.
    const bartendersRes = await client.query(
      `SELECT sr.user_id FROM shift_requests sr
        WHERE sr.shift_id = $1 AND sr.status = 'approved'
          AND LOWER(sr.position) = 'bartender'
        ORDER BY sr.user_id`,
      [tip.shift_id]
    );
    const bartenders = bartendersRes.rows.map(r => r.user_id);
    if (bartenders.length === 0) {
      // No bartenders to pay; flag the tip so we don't retry indefinitely.
      await client.query('UPDATE tips SET rolled_forward_at = NOW() WHERE id = $1', [tipId]);
      await client.query('COMMIT');
      return { bartenders: 0 };
    }

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
      // Today's period is itself frozen (atypical and recoverable). Defer:
      // mark NOT rolled so a retry once a new period opens can pick this up.
      // Log to Sentry so a persistent defer doesn't silently disappear.
      Sentry.captureMessage("rollForwardLateTip: today's period is non-open; deferring", {
        level: 'warning',
        tags: { util: 'payrollLateTip', step: 'defer_frozen_today' },
        extra: { tipId, periodStatus: period.status },
      });
      await client.query('ROLLBACK');
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
      await client.query(
        `INSERT INTO payout_events
           (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
            card_tip_gross_cents, card_tip_fee_cents, card_tip_net_cents, line_total_cents)
         VALUES ($1, $2, 0, 0, 0, 0, $3, $4, $5, GREATEST(0, $5))
         ON CONFLICT (payout_id, shift_id) DO UPDATE SET
           card_tip_gross_cents = payout_events.card_tip_gross_cents + EXCLUDED.card_tip_gross_cents,
           card_tip_fee_cents   = payout_events.card_tip_fee_cents   + EXCLUDED.card_tip_fee_cents,
           card_tip_net_cents   = payout_events.card_tip_net_cents   + EXCLUDED.card_tip_net_cents,
           line_total_cents     = GREATEST(0,
             payout_events.wage_cents + payout_events.gratuity_share_cents
             + payout_events.card_tip_net_cents + EXCLUDED.card_tip_net_cents
             + payout_events.adjustment_cents)`,
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
    await client.query('UPDATE tips SET rolled_forward_at = NOW() WHERE id = $1', [tipId]);
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
