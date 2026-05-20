const Sentry = require('@sentry/node');
const { pool } = require('../db');

/**
 * Record a heartbeat for a scheduler.
 *
 * @param {string} schedulerName - unique identifier (e.g., 'autopay', 'auto_assign')
 * @param {number} expectedIntervalSeconds - how often this scheduler is expected to run
 * @param {'ok' | 'failed'} status - outcome of the latest run
 * @param {string} [errorMessage] - optional error message if status is 'failed'
 */
async function recordHeartbeat(schedulerName, expectedIntervalSeconds, status, errorMessage = null) {
  await pool.query(
    `INSERT INTO scheduler_health (scheduler_name, last_run_at, last_status, expected_interval_seconds, consecutive_failures, last_error, updated_at)
     VALUES ($1, NOW(), $2, $3, $4, $5, NOW())
     ON CONFLICT (scheduler_name) DO UPDATE SET
       last_run_at = EXCLUDED.last_run_at,
       last_status = EXCLUDED.last_status,
       expected_interval_seconds = EXCLUDED.expected_interval_seconds,
       consecutive_failures = CASE
         WHEN EXCLUDED.last_status = 'ok' THEN 0
         ELSE scheduler_health.consecutive_failures + 1
       END,
       last_error = CASE WHEN EXCLUDED.last_status = 'failed' THEN EXCLUDED.last_error ELSE NULL END,
       updated_at = NOW()`,
    [
      schedulerName,
      status,
      expectedIntervalSeconds,
      status === 'failed' ? 1 : 0,
      errorMessage,
    ]
  );
}

/**
 * Wrap a scheduler function so it records heartbeats automatically.
 *
 * Critical design points:
 * - The wrapper does NOT rethrow scheduler errors. We're called from setInterval
 *   timer callbacks; an unhandled rejection there crashes the Node 18+ process.
 *   The scheduler is expected to log/Sentry its own error before throwing.
 * - Heartbeat write failures are caught and logged internally. They must never
 *   propagate out of this wrapper for the same reason.
 * - To detect scheduler failures, the underlying scheduler function MUST rethrow
 *   from its top-level catch block. See Tasks 12-14 for the corresponding
 *   refactors to existing schedulers.
 *
 * @param {string} schedulerName
 * @param {number} expectedIntervalSeconds
 * @param {() => Promise<any>} fn - the scheduler function to wrap
 * @returns {() => Promise<void>}
 */
function wrapScheduler(schedulerName, expectedIntervalSeconds, fn) {
  return async function wrappedScheduler(...args) {
    let status = 'ok';
    let errorMessage = null;
    try {
      await fn(...args);
    } catch (err) {
      status = 'failed';
      errorMessage = err.message;
      console.error(`[${schedulerName}] scheduler error:`, err);
      Sentry.captureException(err, { tags: { scheduler: schedulerName } });
      // Do NOT rethrow — timer callback would surface an unhandled rejection.
    }
    try {
      await recordHeartbeat(schedulerName, expectedIntervalSeconds, status, errorMessage);
    } catch (heartbeatErr) {
      console.error(
        `[schedulerHealth] heartbeat write failed for ${schedulerName}:`,
        heartbeatErr.message
      );
      // Swallow: a heartbeat write failure must never kill the scheduler timer.
    }
  };
}

/**
 * Find schedulers whose last_run_at is older than 2x their expected interval.
 * Returns an array of {scheduler_name, last_run_at, expected_interval_seconds, age_seconds}.
 */
async function checkStaleSchedulers() {
  const { rows } = await pool.query(`
    SELECT
      scheduler_name,
      last_run_at,
      expected_interval_seconds,
      EXTRACT(EPOCH FROM (NOW() - last_run_at))::INTEGER AS age_seconds
    FROM scheduler_health
    WHERE EXTRACT(EPOCH FROM (NOW() - last_run_at)) > (2 * expected_interval_seconds)
  `);
  return rows;
}

/**
 * Background monitor: every 15 minutes, check for stale schedulers and alert Sentry.
 * Called once from server bootstrap (server/index.js).
 */
function startStaleSchedulerMonitor() {
  const INTERVAL_MS = 15 * 60 * 1000;
  setInterval(async () => {
    try {
      const stale = await checkStaleSchedulers();
      if (stale.length > 0) {
        for (const s of stale) {
          Sentry.captureMessage(`Scheduler stale: ${s.scheduler_name}`, {
            level: 'warning',
            tags: { scheduler: s.scheduler_name, monitor: 'staleness' },
            extra: { age_seconds: s.age_seconds, expected_interval_seconds: s.expected_interval_seconds },
          });
          console.warn(
            `[schedulerHealth] STALE: ${s.scheduler_name} (last run ${s.age_seconds}s ago, expected every ${s.expected_interval_seconds}s)`
          );
        }
      }
    } catch (err) {
      console.error('[schedulerHealth] monitor error:', err.message);
    }
  }, INTERVAL_MS);
  console.log('[schedulerHealth] stale-scheduler monitor started');
}

/**
 * Delete the scheduler_health row for a named scheduler. Called from server
 * bootstrap when that scheduler is disabled via env var, so the stale-monitor
 * doesn't alert on a job that was intentionally turned off.
 *
 * Safe to call when no row exists (no-op).
 *
 * @param {string} schedulerName
 */
async function clearHealthRow(schedulerName) {
  try {
    await pool.query('DELETE FROM scheduler_health WHERE scheduler_name = $1', [schedulerName]);
  } catch (err) {
    console.error(`[schedulerHealth] failed to clear row for ${schedulerName}:`, err.message);
  }
}

module.exports = {
  recordHeartbeat,
  wrapScheduler,
  checkStaleSchedulers,
  startStaleSchedulerMonitor,
  clearHealthRow,
};
