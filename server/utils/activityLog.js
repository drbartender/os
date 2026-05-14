const Sentry = require('@sentry/node');
const { pool } = require('../db');

/**
 * Append-only activity event writers + status-change note writers for the
 * applicant timeline. Two flavors:
 *
 *   - Transaction-scoped (caller owns the client, errors propagate so caller
 *     decides whether to ROLLBACK).
 *   - Best-effort post-COMMIT (uses a fresh pool connection so an audit
 *     failure CANNOT poison or roll back the caller's already-committed
 *     primary state change — Postgres marks a transaction as aborted on any
 *     statement error, so the only safe way to make audit truly best-effort
 *     is to write outside the transaction).
 *
 * Caller naming convention: pass the route path or handler name as `source`
 * for Sentry tags.
 *
 * KEEP IN SYNC WITH:
 *   - schema.sql `application_activity` (event_type enum noted in comment)
 *   - schema.sql `interview_notes`
 *   - client/src/pages/admin/applicationDetail/components/TimelineCard.js (EVENT_LABELS)
 */

// ── application_activity ─────────────────────────────────────────────────

/**
 * Transactional: throws on failure so caller can ROLLBACK.
 * @param {object} client  pg Client (or pool — both have .query)
 * @param {{user_id:number, actor_id:number, event_type:string, metadata?:object}} fields
 */
async function writeActivity(client, { user_id, actor_id, event_type, metadata }) {
  await client.query(
    `INSERT INTO application_activity (user_id, actor_id, event_type, metadata)
     VALUES ($1, $2, $3, $4)`,
    [user_id, actor_id, event_type, metadata ? JSON.stringify(metadata) : null]
  );
}

/**
 * Best-effort: runs on a separate pool connection AFTER the caller has
 * committed. Never throws — failures land in Sentry + console.error.
 * @param {{user_id:number, actor_id:number, event_type:string, metadata?:object, source:string}} fields
 */
async function writeActivityBestEffort({ user_id, actor_id, event_type, metadata, source }) {
  try {
    await pool.query(
      `INSERT INTO application_activity (user_id, actor_id, event_type, metadata)
       VALUES ($1, $2, $3, $4)`,
      [user_id, actor_id, event_type, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (logErr) {
    console.error(`[${source}] application_activity log failed:`, logErr);
    Sentry.captureException(logErr, {
      tags: { route: source, step: 'audit_activity' },
      extra: { user_id, actor_id, event_type, metadata },
    });
  }
}

// ── interview_notes ──────────────────────────────────────────────────────

/**
 * Best-effort status-change note. Runs on a separate pool connection AFTER
 * commit. Never throws.
 * @param {{user_id:number, admin_id:number, note:string, source:string}} fields
 */
async function writeInterviewNoteBestEffort({ user_id, admin_id, note, source }) {
  try {
    await pool.query(
      `INSERT INTO interview_notes (user_id, admin_id, note, note_type)
       VALUES ($1, $2, $3, 'status_change')`,
      [user_id, admin_id, note]
    );
  } catch (logErr) {
    console.error(`[${source}] interview_notes log failed:`, logErr);
    Sentry.captureException(logErr, {
      tags: { route: source, step: 'audit_note' },
      extra: { user_id, admin_id, note },
    });
  }
}

module.exports = {
  writeActivity,
  writeActivityBestEffort,
  writeInterviewNoteBestEffort,
};
