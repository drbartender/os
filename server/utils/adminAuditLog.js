const Sentry = require('@sentry/node');
const { pool } = require('../db');

const MAX_METADATA_BYTES = 8 * 1024;

// Persistent record of admin actions on user-owned resources. Designed for
// post-incident traceability ("who rotated whose tip token, when, from what
// to what?") rather than real-time alerting. Writes are best-effort — every
// failure path (validation, oversized metadata, DB error) routes to Sentry
// and console without throwing to the caller, so a logging hiccup can never
// 500 a successful business action.
async function logAdminAction({ actorUserId, targetUserId, action, metadata }) {
  try {
    if (!action || typeof action !== 'string') {
      throw new Error('adminAuditLog: action is required');
    }
    const json = JSON.stringify(metadata || {});
    if (json.length > MAX_METADATA_BYTES) {
      throw new Error(`adminAuditLog: metadata too large (${json.length} bytes, max ${MAX_METADATA_BYTES})`);
    }
    await pool.query(
      `INSERT INTO admin_audit_log (actor_user_id, target_user_id, action, metadata)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        Number.isInteger(actorUserId) ? actorUserId : null,
        Number.isInteger(targetUserId) ? targetUserId : null,
        action.slice(0, 100),
        json,
      ],
    );
  } catch (err) {
    console.error('[adminAuditLog] insert failed', err.message);
    Sentry.captureException(err, {
      tags: { util: 'adminAuditLog', op: 'insert' },
      extra: { action, actorUserId, targetUserId },
    });
  }
}

module.exports = { logAdminAction };
