/**
 * DB helpers shared by the payroll portal routes. Each helper accepts an
 * executor (pool OR a pg client mid-transaction) so callers can either run
 * standalone or join a transaction the route already opened.
 */

/**
 * Find the OPEN pay period that contains the given calendar date (YYYY-MM-DD).
 * Returns the row { id, start_date, end_date, payday, status } or null.
 * Used to resolve "current period" on the worklist.
 */
async function findOpenPeriodForDate(executor, ymd) {
  const { rows } = await executor.query(
    `SELECT id, start_date, end_date, payday, status
       FROM pay_periods
      WHERE status = 'open'
        AND $1::date BETWEEN start_date AND end_date
      ORDER BY start_date DESC
      LIMIT 1`,
    [ymd]
  );
  return rows[0] || null;
}

/**
 * Sum a payout's line items and write the result to payouts.total_cents.
 * Returns the new total. Floors at 0 as a defensive belt — line_total_cents
 * already floors at the write path, so this only matters if a future bug
 * lets a negative line through.
 */
async function recomputePayoutTotal(executor, payoutId) {
  const { rows } = await executor.query(
    `UPDATE payouts po
        SET total_cents = GREATEST(0, COALESCE((
              SELECT SUM(line_total_cents) FROM payout_events WHERE payout_id = po.id
            ), 0))
      WHERE po.id = $1
      RETURNING total_cents`,
    [payoutId]
  );
  return rows[0] ? Number(rows[0].total_cents) : 0;
}

/**
 * If every payout in the period is `paid`, flip the period to `paid`.
 * Returns true if the flip happened, false if there is still a pending payout
 * (or if the period was not in `processing` to begin with).
 */
async function maybeFinalizePeriod(executor, periodId) {
  const { rows: countRows } = await executor.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending
       FROM payouts WHERE pay_period_id = $1`,
    [periodId]
  );
  if (Number(countRows[0].pending) > 0) return false;
  const { rowCount } = await executor.query(
    `UPDATE pay_periods SET status = 'paid'
      WHERE id = $1 AND status = 'processing'`,
    [periodId]
  );
  return rowCount > 0;
}

module.exports = { findOpenPeriodForDate, recomputePayoutTotal, maybeFinalizePeriod };
