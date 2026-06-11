// Re-run placement for tips that deferred while the open pay period was frozen.
// Idempotent, single-flight, attempt-capped. Fired off the response path after a
// successful accrual and from the admin Retry button.
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { rollForwardLateTip } = require('./payrollLateTip');
const { clawbackTip } = require('./payrollClawback');

const MAX_DEFER_ATTEMPTS = 25; // a stuck tip drops from auto-retry but stays on the admin list
const SWEEP_LIMIT = 200;
let sweepInFlight = false;

async function retryDeferredTips() {
  if (sweepInFlight) return { skipped: true, reason: 'in_flight', scanned: 0, resolved: 0, redeferred: 0, errors: 0 };
  sweepInFlight = true;
  const summary = { scanned: 0, resolved: 0, redeferred: 0, errors: 0 };
  try {
    const { rows } = await pool.query(
      `SELECT id, defer_kind, defer_target_cents FROM tips
        WHERE deferred_at IS NOT NULL AND defer_attempts < $1
        ORDER BY deferred_at ASC LIMIT $2`,
      [MAX_DEFER_ATTEMPTS, SWEEP_LIMIT]
    );
    summary.scanned = rows.length;
    for (const t of rows) {
      try {
        if (t.defer_kind === 'roll_forward') await rollForwardLateTip(t.id);
        else if (t.defer_kind === 'clawback') await clawbackTip(t.id, Number(t.defer_target_cents));
        const chk = await pool.query('SELECT deferred_at FROM tips WHERE id = $1', [t.id]);
        if (chk.rows[0] && chk.rows[0].deferred_at === null) summary.resolved += 1; // placed OR clawed
        else summary.redeferred += 1;
      } catch (err) {
        summary.errors += 1;
        Sentry.captureException(err, { tags: { util: 'payrollDeferredRetry', step: 'retry_one' }, extra: { tipId: t.id } });
      }
    }
    Sentry.addBreadcrumb({ category: 'payroll', message: 'deferred-tip sweep', level: 'info', data: summary });
    return summary;
  } finally {
    sweepInFlight = false;
  }
}

module.exports = { retryDeferredTips, MAX_DEFER_ATTEMPTS };
