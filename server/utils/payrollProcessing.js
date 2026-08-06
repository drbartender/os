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
 * THE single writer of payouts.total_cents (spec 2026-08-06 §3.3). Sums the
 * payout's event lines PLUS its payable duty lines and clamps the WHOLE sum at
 * 0, so H1 clawback debt nets against duty pay before the floor (events -$50,
 * duty +$20 pays $0, not $20). "Payable" duty = removed_at IS NULL AND
 * (held_state IS NULL OR held_state = 'confirmed'). Every recompute site in
 * payroll routes through here (or the bulk variant below); any other
 * `UPDATE payouts SET total_cents` in the codebase is a defect.
 */
const PAYOUT_TOTAL_SQL = `
  GREATEST(0,
    COALESCE((SELECT SUM(line_total_cents) FROM payout_events WHERE payout_id = po.id), 0)
    + COALESCE((SELECT SUM(amount_cents) FROM payout_duty_lines
                 WHERE payout_id = po.id AND removed_at IS NULL
                   AND (held_state IS NULL OR held_state = 'confirmed')), 0)
  )`;

async function recomputePayoutTotal(executor, payoutId) {
  const { rows } = await executor.query(
    `UPDATE payouts po SET total_cents = ${PAYOUT_TOTAL_SQL}
      WHERE po.id = $1
      RETURNING total_cents`,
    [payoutId]
  );
  return rows[0] ? Number(rows[0].total_cents) : 0;
}

/**
 * Bulk variant for the sweep/clawback/late-tip callers that recompute many
 * payouts in one statement. Same formula, one round trip. Returns rows of
 * { id, total_cents } for callers that need the results (clawback's
 * residual alarm reads a raw sum separately).
 */
async function recomputePayoutTotals(executor, payoutIds) {
  if (!payoutIds || !payoutIds.length) return [];
  const { rows } = await executor.query(
    `UPDATE payouts po SET total_cents = ${PAYOUT_TOTAL_SQL}
      WHERE po.id = ANY($1)
      RETURNING po.id, total_cents`,
    [payoutIds]
  );
  return rows;
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

module.exports = {
  findOpenPeriodForDate, recomputePayoutTotal, recomputePayoutTotals,
  maybeFinalizePeriod,
};
