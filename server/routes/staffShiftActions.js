/**
 * Staff portal Drop / Cover marketplace endpoints (spec §6.5).
 *
 * Lives in its own router (mounted at /api/shifts in server/index.js, AFTER
 * routes/shifts.js) so the existing shifts.js stays under its 1000-line hard
 * cap as Phase 5 lands 5 new endpoints. Pattern matches server/routes/proposals/
 * (per-concern split, composition router).
 *
 * Endpoints (across Tasks 23-27):
 *   POST   /api/shifts/requests/:requestId/drop              (Task 23 — clean)
 *   POST   /api/shifts/requests/:requestId/request-cover     (Task 24)
 *   POST   /api/shifts/requests/:shiftId/claim-cover         (Task 25)
 *   POST   /api/shifts/requests/:requestId/emergency-drop    (Task 26)
 *   DELETE /api/shifts/requests/:requestId                    (Task 27 — staff withdraw)
 *
 * All endpoints require `auth`. None of them are admin-only — they're the
 * staffer's own self-service flows. Ownership is enforced inside the handler
 * via `sr.user_id = req.user.id` predicates plus 403 responses on mismatch.
 */

const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const {
  ValidationError,
  ConflictError,
  NotFoundError,
  PermissionError,
} = require('../utils/errors');
const { hoursToEvent } = require('../utils/shiftTime');
const { notifyAdminCategory } = require('../utils/adminNotifications');
const { getEventTypeLabel } = require('../utils/eventTypes');
const { ADMIN_URL } = require('../utils/urls');

const router = express.Router();
router.use(auth);

// Mode-window thresholds (spec §6.5). Hours from now to event start.
const CLEAN_DROP_MIN_HOURS = 336;        // >= 14 days out
const COVER_REQUEST_MIN_HOURS = 72;      // >= 72h
const COVER_REQUEST_MAX_HOURS = 336;     // < 14d
// emergency-drop: hoursToEvent < 72

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Look up the shift_request + linked shift + pay_period for an action.
 * Locks the shift_request row FOR UPDATE so concurrent drop/cover/withdraw
 * actions serialize. Caller MUST be inside a transaction (uses `dbClient`).
 *
 * Returns the joined row or null if not found.
 */
async function loadRequestContextForUpdate(dbClient, requestId) {
  // payout_events links a SHIFT (not a shift_request) to a payout; payouts
  // carry (pay_period_id, contractor_id). To resolve THIS user's pay-period
  // status for THIS shift we match on (pe.shift_id, po.contractor_id =
  // sr.user_id). A NULL pay_period_status means no payout has been
  // assembled yet, which is the common case for upcoming shifts.
  const { rows } = await dbClient.query(
    `SELECT sr.id AS request_id,
            sr.user_id,
            sr.status,
            sr.position,
            sr.cover_requested_at,
            sr.cover_reason,
            sr.dropped_at,
            sr.drop_reason,
            sr.drop_emergency,
            sr.replaced_by_request_id,
            s.id AS shift_id,
            s.event_date,
            s.start_time,
            s.end_time,
            s.location,
            s.status AS shift_status,
            s.proposal_id,
            s.event_type AS shift_event_type,
            s.event_type_custom AS shift_event_type_custom,
            COALESCE(c.name, s.client_name) AS client_name,
            pp.status AS pay_period_status
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       LEFT JOIN proposals p ON p.id = s.proposal_id
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN payout_events pe ON pe.shift_id = s.id
       LEFT JOIN payouts po ON po.id = pe.payout_id AND po.contractor_id = sr.user_id
       LEFT JOIN pay_periods pp ON pp.id = po.pay_period_id
      WHERE sr.id = $1
      FOR UPDATE OF sr`,
    [requestId]
  );
  return rows[0] || null;
}

/**
 * Format the event_date as "Saturday, August 15" (UTC anchor avoids
 * positive-offset day rollover). Falls through to 'TBD' on missing/invalid.
 */
function formatEventDateLong(eventDate) {
  if (!eventDate) return 'TBD';
  let ymd;
  if (eventDate instanceof Date) {
    if (Number.isNaN(eventDate.getTime())) return 'TBD';
    const y = eventDate.getFullYear();
    const m = String(eventDate.getMonth() + 1).padStart(2, '0');
    const d = String(eventDate.getDate()).padStart(2, '0');
    ymd = `${y}-${m}-${d}`;
  } else {
    ymd = String(eventDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return 'TBD';
  }
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return 'TBD';
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * After a drop / cover-request, flip the parent shift to 'open' iff no other
 * staffer remains approved-AND-not-dropped on it. Idempotent (no-op if other
 * staffers remain or shift was already open). Caller MUST be inside the same
 * transaction as the drop UPDATE.
 */
async function maybeReopenShift(dbClient, shiftId) {
  const { rows } = await dbClient.query(
    `SELECT COUNT(*)::int AS active_count
       FROM shift_requests
      WHERE shift_id = $1
        AND status = 'approved'
        AND dropped_at IS NULL`,
    [shiftId]
  );
  if (rows[0].active_count === 0) {
    await dbClient.query(
      `UPDATE shifts SET status = 'open' WHERE id = $1`,
      [shiftId]
    );
  }
}

/**
 * Suppress all pending scheduled_messages targeting this user for this shift.
 * Caller MUST pass the in-transaction dbClient so the suppression atomically
 * coincides with the drop UPDATE.
 */
async function suppressPendingMessagesForUserShift(dbClient, shiftId, userId) {
  await dbClient.query(
    `UPDATE scheduled_messages
        SET status = 'suppressed'
      WHERE entity_type = 'shift'
        AND entity_id = $1
        AND recipient_id = $2
        AND status = 'pending'`,
    [shiftId, userId]
  );
}

/**
 * Fire an urgent_staffing notification to management. Non-blocking the
 * happy-path response (we await inside the request handler post-COMMIT;
 * notifyAdminCategory itself is best-effort per-recipient).
 *
 * `daysOut` controls whether SMS is included: spec §6.5 says SMS only when
 * the event is within 7 days. Email always.
 */
async function notifyManagementOfAction({
  category,
  subject,
  emailHtml,
  emailText,
  smsBody,
  daysOut,
}) {
  const args = {
    category,
    subject,
    emailHtml,
    emailText,
  };
  if (smsBody && Number.isFinite(daysOut) && daysOut <= 7) {
    args.smsBody = smsBody;
  }
  try {
    await notifyAdminCategory(args);
  } catch (err) {
    // notifyAdminCategory swallows its own errors, but defensive try/catch
    // here keeps a future refactor from breaking the request flow.
    Sentry.captureException(err, { tags: { feature: 'staff-shift-actions', category } });
    console.error('[staffShiftActions] notifyAdminCategory threw:', err.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Task 23: POST /requests/:requestId/drop  (clean drop, >= 336h out)
// ──────────────────────────────────────────────────────────────────────────

router.post('/requests/:requestId/drop', asyncHandler(async (req, res) => {
  const requestId = parseInt(req.params.requestId, 10);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    throw new ValidationError({ requestId: 'Invalid request id.' });
  }

  const dbClient = await pool.connect();
  let ctx;
  let droppedAt;
  try {
    await dbClient.query('BEGIN');

    ctx = await loadRequestContextForUpdate(dbClient, requestId);
    if (!ctx) {
      throw new NotFoundError('Request not found.');
    }
    if (ctx.user_id !== req.user.id) {
      throw new PermissionError('You can only drop your own shift requests.');
    }
    if (ctx.status !== 'approved') {
      throw new ConflictError('Only approved shifts can be dropped.', 'not_approved');
    }
    if (ctx.dropped_at) {
      throw new ConflictError('This shift was already dropped.', 'already_dropped');
    }
    if (ctx.pay_period_status === 'processing') {
      throw new ConflictError(
        'This shift falls in a pay period that is being processed; contact management.',
        'pay_period_processing'
      );
    }

    const hoursOut = hoursToEvent({ event_date: ctx.event_date, start_time: ctx.start_time });
    if (hoursOut === null) {
      throw new ConflictError('Could not determine shift start time.', 'unparseable_shift_time');
    }
    if (hoursOut < CLEAN_DROP_MIN_HOURS) {
      throw new ConflictError(
        'Clean drops require at least 14 days notice. Use Request Cover or Emergency Drop instead.',
        'wrong_mode'
      );
    }

    const upd = await dbClient.query(
      `UPDATE shift_requests
          SET status = 'denied',
              dropped_at = NOW(),
              drop_reason = 'clean_drop'
        WHERE id = $1
        RETURNING dropped_at`,
      [requestId]
    );
    droppedAt = upd.rows[0]?.dropped_at;

    await maybeReopenShift(dbClient, ctx.shift_id);
    await suppressPendingMessagesForUserShift(dbClient, ctx.shift_id, req.user.id);

    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    dbClient.release();
  }

  // Post-commit: notify management (best-effort). SMS only when <=7d out, but
  // a clean-drop is always >=14d so SMS never fires here; email always.
  const eventTypeLabel = getEventTypeLabel({
    event_type: ctx.shift_event_type,
    event_type_custom: ctx.shift_event_type_custom,
  });
  const eventDateLong = formatEventDateLong(ctx.event_date);
  const subject = `Staff drop: ${eventTypeLabel} on ${eventDateLong}`;
  const text = [
    `A staffer dropped their shift cleanly (more than 14 days out).`,
    ``,
    `Event: ${eventTypeLabel}${ctx.client_name ? ' for ' + ctx.client_name : ''}`,
    `Date: ${eventDateLong}`,
    `Time: ${ctx.start_time || 'TBD'} - ${ctx.end_time || 'TBD'}`,
    `Location: ${ctx.location || 'TBD'}`,
    `Position: ${ctx.position || 'staff'}`,
    ``,
    `The shift is back in the open pool if no other staffers remain assigned.`,
    `Review in the admin dashboard: ${ADMIN_URL}/staffing`,
  ].join('\n');
  const html = `<p>A staffer dropped their shift cleanly (more than 14 days out).</p>
    <p><strong>Event:</strong> ${eventTypeLabel}${ctx.client_name ? ' for ' + ctx.client_name : ''}<br>
    <strong>Date:</strong> ${eventDateLong}<br>
    <strong>Time:</strong> ${ctx.start_time || 'TBD'} to ${ctx.end_time || 'TBD'}<br>
    <strong>Location:</strong> ${ctx.location || 'TBD'}<br>
    <strong>Position:</strong> ${ctx.position || 'staff'}</p>
    <p>The shift is back in the open pool if no other staffers remain assigned.</p>
    <p><a href="${ADMIN_URL}/staffing">Review in admin dashboard</a></p>`;

  // hoursOut is always >= 336 here (>=14d), so SMS suppressed by daysOut > 7.
  await notifyManagementOfAction({
    category: 'urgent_staffing',
    subject,
    emailHtml: html,
    emailText: text,
    smsBody: null,
    daysOut: 999,
  });

  res.json({
    success: true,
    request_id: requestId,
    shift_id: ctx.shift_id,
    dropped_at: droppedAt,
    drop_reason: 'clean_drop',
  });
}));

module.exports = router;
