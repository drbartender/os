// Daily cleanup of stale pending_email_changes rows (spec §6.10 step 10).
//
// Consumed rows are kept for 7 days as a thin audit trail before purge —
// staff_audit_log holds the durable record. Expired-but-never-consumed rows
// are also purged after 7 days (they sit at most 7 days past their expiry,
// which is itself 24h after creation).

const Sentry = require('@sentry/node');
const { pool } = require('../db');

async function purgeExpiredPendingEmailChanges() {
  try {
    const res = await pool.query(
      `DELETE FROM pending_email_changes
        WHERE consumed_at IS NOT NULL
           OR expires_at < NOW() - INTERVAL '7 days'`
    );
    if (res.rowCount > 0) {
      console.log(`[pending_email_change_cleanup] deleted ${res.rowCount} stale rows`);
    }
    return res.rowCount;
  } catch (err) {
    try {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(err, {
          tags: { component: 'pendingEmailChangeCleanup' },
        });
      }
    } catch (_) { /* swallow */ }
    throw err;
  }
}

module.exports = { purgeExpiredPendingEmailChanges };
