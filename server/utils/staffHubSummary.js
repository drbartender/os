/**
 * The Staff hub's "open pay run" line is DERIVED from the date, never read
 * from a pay_periods row: rows are created lazily by ensurePayPeriod when the
 * first shift of the week accrues (usually Saturday), so on a Wednesday the
 * row does not exist yet and a row-based subtitle would go blank or fall back
 * to last week. This helper is pure; the caller does the one LEFT JOIN.
 */
const { payPeriodForDate, computePayday } = require('./payrollPeriods');

/**
 * @param {object} args
 * @param {string} args.todayYmd today's business date, 'YYYY-MM-DD' (Chicago)
 * @param {object|null} args.row the pay_periods row for the derived start_date,
 *   joined with a payout count, or null when the row does not exist yet
 * @returns {{ start_date: string, end_date: string, payday: string,
 *   exists: boolean, status: string|null, payouts_accrued: number }}
 */
function summarizeOpenPeriod({ todayYmd, row }) {
  const { startDate, endDate } = payPeriodForDate(todayYmd);
  const payday = computePayday(endDate);
  return {
    start_date: startDate,
    end_date: endDate,
    payday,
    exists: !!row,
    status: row ? row.status : null,
    payouts_accrued: row ? Number(row.payouts_accrued || 0) : 0,
  };
}

module.exports = { summarizeOpenPeriod };
