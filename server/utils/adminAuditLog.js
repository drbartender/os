const Sentry = require('@sentry/node');
const { pool } = require('../db');

// Persistent record of admin actions on user-owned resources. Designed for
// post-incident traceability ("who rotated whose tip token, when, from what
// to what?") rather than real-time alerting. Writes are best-effort — a
// logging failure must NOT block the underlying business action.
async function logAdminAction({ actorUserId, targetUserId, action, metadata }) {
  if (!action || typeof action !== 'string') {
    // Defensive — a missing `action` would store an undifferentiated row.
    // Failing loud here is fine because logAdminAction is only called from
    // server code we control, never from request bodies.
    throw new Error('adminAuditLog: action is required');
  }
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (actor_user_id, target_user_id, action, metadata)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        Number.isInteger(actorUserId) ? actorUserId : null,
        Number.isInteger(targetUserId) ? targetUserId : null,
        action.slice(0, 100),
        JSON.stringify(metadata || {}),
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
