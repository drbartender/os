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
const crypto = require('node:crypto');
const Sentry = require('@sentry/node');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const {
  ValidationError,
  ConflictError,
  NotFoundError,
  PermissionError,
  PayloadTooLargeError,
} = require('../utils/errors');
const { hoursToEvent } = require('../utils/shiftTime');
const { notifyAdminCategory } = require('../utils/adminNotifications');
const { getEventTypeLabel } = require('../utils/eventTypes');
const { ADMIN_URL } = require('../utils/urls');
const { sendEmail } = require('../utils/email');
const { broadcastCoverRequest } = require('../utils/coverBroadcast');
const { sendAndLogSms } = require('../utils/sms');
const { staff_drop_to_management_sms } = require('../utils/smsTemplates');

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

// ──────────────────────────────────────────────────────────────────────────
// Task 24: POST /requests/:requestId/request-cover  (in 72h-336h window)
// ──────────────────────────────────────────────────────────────────────────
//
// Two-phase: Transaction A (fast: validate + flip cover_requested_at + admin
// notify) commits quickly. Then OUTSIDE the transaction, broadcastCoverRequest
// fans out to qualified teammates. The split keeps the row lock window short
// (the broadcast itself can take a couple of seconds across 25-row chunks
// with 250ms gaps).

const MAX_COVER_REASON_LEN = 500;

router.post('/requests/:requestId/request-cover', asyncHandler(async (req, res) => {
  const requestId = parseInt(req.params.requestId, 10);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    throw new ValidationError({ requestId: 'Invalid request id.' });
  }

  const rawReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (rawReason.length > MAX_COVER_REASON_LEN) {
    // Body too large for the cover_reason column slot — return 413 not 400 so
    // the client can distinguish from a missing-field error.
    throw new PayloadTooLargeError(`Reason must be ${MAX_COVER_REASON_LEN} characters or fewer.`, 'reason_too_long');
  }
  // Defensive truncate (caller may also enforce client-side).
  const coverReason = rawReason.slice(0, MAX_COVER_REASON_LEN);

  let ctx;
  let hoursOut;

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    ctx = await loadRequestContextForUpdate(dbClient, requestId);
    if (!ctx) throw new NotFoundError('Request not found.');
    if (ctx.user_id !== req.user.id) {
      throw new PermissionError('You can only request cover for your own shifts.');
    }
    if (ctx.status !== 'approved') {
      throw new ConflictError('Only approved shifts can request cover.', 'not_approved');
    }
    if (ctx.dropped_at) {
      throw new ConflictError('This shift was already dropped.', 'already_dropped');
    }
    if (ctx.cover_requested_at) {
      throw new ConflictError('Cover was already requested for this shift.', 'already_requested');
    }
    if (ctx.pay_period_status === 'processing') {
      throw new ConflictError(
        'This shift falls in a pay period that is being processed; contact management.',
        'pay_period_processing'
      );
    }

    hoursOut = hoursToEvent({ event_date: ctx.event_date, start_time: ctx.start_time });
    if (hoursOut === null) {
      throw new ConflictError('Could not determine shift start time.', 'unparseable_shift_time');
    }
    if (hoursOut < COVER_REQUEST_MIN_HOURS || hoursOut >= COVER_REQUEST_MAX_HOURS) {
      // Outside the 72h..336h window. Caller should switch to clean drop
      // (>=336h) or emergency drop (<72h).
      throw new ConflictError(
        'Request Cover is only available between 72 hours and 14 days before the event. Use Clean Drop or Emergency Drop instead.',
        'wrong_mode'
      );
    }

    await dbClient.query(
      `UPDATE shift_requests
          SET cover_requested_at = NOW(),
              cover_reason = $1
        WHERE id = $2`,
      [coverReason || null, requestId]
    );

    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    dbClient.release();
  }

  // ── Outside the transaction ──────────────────────────────────────────
  // Notify management (best-effort, doesn't block the fan-out). SMS gate:
  // notifyManagementOfAction passes smsBody through only when daysOut <= 7.
  const daysOut = hoursOut / 24;
  const eventTypeLabel = getEventTypeLabel({
    event_type: ctx.shift_event_type,
    event_type_custom: ctx.shift_event_type_custom,
  });
  const eventDateLong = formatEventDateLong(ctx.event_date);
  const subject = `Cover requested: ${eventTypeLabel} on ${eventDateLong}`;
  const text = [
    `A staffer requested cover for an upcoming shift (${Math.round(hoursOut)}h out).`,
    ``,
    `Event: ${eventTypeLabel}${ctx.client_name ? ' for ' + ctx.client_name : ''}`,
    `Date: ${eventDateLong}`,
    `Time: ${ctx.start_time || 'TBD'} - ${ctx.end_time || 'TBD'}`,
    `Location: ${ctx.location || 'TBD'}`,
    `Position: ${ctx.position || 'staff'}`,
    coverReason ? `\nReason: ${coverReason}` : '',
    ``,
    `Qualified teammates are being notified now. Review in the admin dashboard: ${ADMIN_URL}/staffing`,
  ].filter(Boolean).join('\n');
  const html = `<p>A staffer requested cover for an upcoming shift (${Math.round(hoursOut)}h out).</p>
    <p><strong>Event:</strong> ${eventTypeLabel}${ctx.client_name ? ' for ' + ctx.client_name : ''}<br>
    <strong>Date:</strong> ${eventDateLong}<br>
    <strong>Time:</strong> ${ctx.start_time || 'TBD'} to ${ctx.end_time || 'TBD'}<br>
    <strong>Location:</strong> ${ctx.location || 'TBD'}<br>
    <strong>Position:</strong> ${ctx.position || 'staff'}</p>
    ${coverReason ? `<p><strong>Reason:</strong> ${coverReason}</p>` : ''}
    <p>Qualified teammates are being notified now.</p>
    <p><a href="${ADMIN_URL}/staffing">Review in admin dashboard</a></p>`;
  const smsBody = `Cover requested: ${eventTypeLabel} on ${eventDateLong}, ${Math.round(hoursOut)}h out.`;

  await notifyManagementOfAction({
    category: 'urgent_staffing',
    subject,
    emailHtml: html,
    emailText: text,
    smsBody,
    daysOut,
  });

  // Fan out to qualified teammates. Fire-and-forget: the chunked enqueue can
  // take several seconds at the MAX_TARGETS cap (250ms application-level delay
  // per 25-row batch), and the cover_requested_at flip is already committed, so
  // we must not block the HTTP response on it. A broadcast failure is logged to
  // Sentry but never surfaced to the staffer (the cover request still stands;
  // the client ignores the broadcast counts). Detached promise — no await.
  broadcastCoverRequest(ctx.shift_id, req.user.id).catch((err) => {
    Sentry.captureException(err, {
      tags: { feature: 'cover-broadcast', endpoint: 'request-cover' },
      extra: { shift_id: ctx.shift_id, user_id: req.user.id },
    });
    console.error('[staffShiftActions] broadcastCoverRequest threw:', err.message);
  });

  res.json({
    success: true,
    request_id: requestId,
    shift_id: ctx.shift_id,
    cover_requested_at: new Date().toISOString(),
  });
}));

// ──────────────────────────────────────────────────────────────────────────
// Task 25: POST /requests/:shiftId/claim-cover
// ──────────────────────────────────────────────────────────────────────────
//
// A qualified teammate (different position-eligible staffer) claims an open
// cover request. Creates a pending shift_request row tied to the original via
// `replaced_by_request_id`, signs a 7-day swap-token JWT, and emails admins
// an approve-link. Admin then either approves via the email link (POST to
// /api/admin/cover-swaps/:swapToken — wires through the shared cascade) or
// via the normal staffing dashboard (PUT /api/shifts/requests/:requestId,
// where the same cascade fires inside the approval branch).

const SWAP_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

router.post('/requests/:shiftId/claim-cover', asyncHandler(async (req, res) => {
  const shiftId = parseInt(req.params.shiftId, 10);
  if (!Number.isInteger(shiftId) || shiftId <= 0) {
    throw new ValidationError({ shiftId: 'Invalid shift id.' });
  }

  const dbClient = await pool.connect();
  let swapResult;
  try {
    await dbClient.query('BEGIN');

    // 1. Look up the active cover-requesting shift_request for this shift.
    // Lock the row so concurrent claimants serialize.
    const { rows: origRows } = await dbClient.query(
      `SELECT sr.id AS original_request_id, sr.user_id AS original_user_id,
              sr.position AS original_position,
              s.id AS shift_id, s.status AS shift_status,
              s.positions_needed, s.event_date, s.start_time,
              s.proposal_id, s.event_type AS shift_event_type,
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
        WHERE sr.shift_id = $1
          AND sr.cover_requested_at IS NOT NULL
          AND sr.status = 'approved'
          AND sr.dropped_at IS NULL
        ORDER BY sr.cover_requested_at ASC
        LIMIT 1
        FOR UPDATE OF sr`,
      [shiftId]
    );
    if (origRows.length === 0) {
      throw new ConflictError('No active cover request on this shift.', 'no_active_cover_request');
    }
    const orig = origRows[0];

    if (orig.shift_status === 'cancelled') {
      throw new ConflictError('This shift was cancelled.', 'shift_cancelled');
    }
    if (orig.pay_period_status === 'processing') {
      throw new ConflictError(
        'This shift falls in a pay period that is being processed; contact management.',
        'pay_period_processing'
      );
    }
    if (orig.original_user_id === req.user.id) {
      throw new ConflictError('You cannot claim your own cover.', 'self_claim');
    }

    // 2. Position eligibility: the claimer's contractor_profiles.position must
    // be in shifts.positions_needed.
    const { rows: profileRows } = await dbClient.query(
      `SELECT position FROM contractor_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    const claimerPosition = profileRows[0]?.position || null;
    if (!claimerPosition) {
      throw new PermissionError('Your contractor profile is missing a position.');
    }
    // Parse positions_needed tolerantly (see coverBroadcast.parsePositionsNeeded).
    let positionsNeededList = [];
    try {
      const raw = orig.positions_needed;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        positionsNeededList = parsed.map((p) => (typeof p === 'string' ? p : p?.position)).filter(Boolean);
      } else if (typeof parsed === 'string') {
        positionsNeededList = [parsed];
      }
    } catch {
      positionsNeededList = ['bartender'];
    }
    if (positionsNeededList.length > 0 && !positionsNeededList.includes(claimerPosition)) {
      throw new PermissionError(`Position '${claimerPosition}' is not eligible for this shift.`);
    }

    // 3. UPSERT the claimer's pending request, tying it via
    // replaced_by_request_id to the original. The WHERE clause on ON CONFLICT
    // refuses to clobber an already-approved row (concurrent admin assigning
    // this user to the shift via the normal flow).
    const { rows: upsertRows } = await dbClient.query(
      `INSERT INTO shift_requests (shift_id, user_id, status, position, replaced_by_request_id)
       VALUES ($1, $2, 'pending', $3, $4)
       ON CONFLICT (shift_id, user_id) DO UPDATE
         SET status = 'pending',
             position = EXCLUDED.position,
             replaced_by_request_id = EXCLUDED.replaced_by_request_id,
             dropped_at = NULL,
             drop_reason = NULL,
             cover_requested_at = NULL
         WHERE shift_requests.status <> 'approved'
       RETURNING id`,
      [shiftId, req.user.id, claimerPosition, orig.original_request_id]
    );
    if (upsertRows.length === 0) {
      // The conflict path's WHERE filtered us out — claimer already approved.
      throw new ConflictError('You already have an approved request for this shift.', 'already_approved');
    }
    const newRequestId = upsertRows[0].id;

    // 4. Sign the swap-token JWT. jti adds a uniqueness anchor so a leaked
    // token can be invalidated server-side later (out-of-scope for v1).
    const swapToken = jwt.sign(
      {
        original_request_id: orig.original_request_id,
        new_request_id: newRequestId,
        jti: crypto.randomUUID(),
      },
      process.env.JWT_SECRET,
      { expiresIn: SWAP_TOKEN_TTL_SECONDS }
    );

    await dbClient.query('COMMIT');

    swapResult = {
      original_request_id: orig.original_request_id,
      original_user_id: orig.original_user_id,
      new_request_id: newRequestId,
      shift_id: shiftId,
      swap_token: swapToken,
      shift_context: {
        event_type_label: getEventTypeLabel({
          event_type: orig.shift_event_type,
          event_type_custom: orig.shift_event_type_custom,
        }),
        event_date_long: formatEventDateLong(orig.event_date),
        start_time: orig.start_time,
        client_name: orig.client_name,
        position: claimerPosition,
      },
    };
  } catch (err) {
    await dbClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    dbClient.release();
  }

  // Post-commit: email management with one-click approve link. Failure is
  // logged but NOT rolled back — the admin can still approve via the normal
  // staffing dashboard.
  const approveUrl = `${ADMIN_URL}/admin/shifts/cover-swaps/${swapResult.swap_token}`;
  const sc = swapResult.shift_context;
  const subject = `Cover swap proposal: ${sc.event_type_label} on ${sc.event_date_long}`;
  const text = [
    `A teammate claimed an open cover request. Approve the swap to confirm them on the shift.`,
    ``,
    `Event: ${sc.event_type_label}${sc.client_name ? ' for ' + sc.client_name : ''}`,
    `Date: ${sc.event_date_long}`,
    `Time: ${sc.start_time || 'TBD'}`,
    `Position: ${sc.position}`,
    ``,
    `One-click approve: ${approveUrl}`,
    `(Link expires in 7 days.)`,
  ].join('\n');
  const html = `<p>A teammate claimed an open cover request. Approve the swap to confirm them on the shift.</p>
    <p><strong>Event:</strong> ${sc.event_type_label}${sc.client_name ? ' for ' + sc.client_name : ''}<br>
    <strong>Date:</strong> ${sc.event_date_long}<br>
    <strong>Time:</strong> ${sc.start_time || 'TBD'}<br>
    <strong>Position:</strong> ${sc.position}</p>
    <p style="text-align:center;margin:2rem 0;">
      <a href="${approveUrl}" style="display:inline-block;padding:14px 32px;background:#3b2314;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;font-size:16px;">Approve swap</a>
    </p>
    <p style="font-size:13px;color:#6b4226;">Link expires in 7 days.</p>`;

  try {
    // notifyAdminCategory fans across all admins subscribed to urgent_staffing;
    // we deliberately ride that path so a new admin onboarding picks up these
    // emails automatically.
    await notifyAdminCategory({
      category: 'urgent_staffing',
      subject,
      emailHtml: html,
      emailText: text,
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { feature: 'claim-cover', step: 'notify-admin' },
      extra: { shift_id: swapResult.shift_id, new_request_id: swapResult.new_request_id },
    });
    console.error('[staffShiftActions] claim-cover admin notify failed:', err.message);
  }

  res.json({
    success: true,
    shift_id: swapResult.shift_id,
    new_request_id: swapResult.new_request_id,
    original_request_id: swapResult.original_request_id,
    // We DON'T return swap_token to the staffer — it's an admin secret.
  });
}));

// ──────────────────────────────────────────────────────────────────────────
// Task 26: POST /requests/:requestId/emergency-drop  (<72h, status stays approved)
// ──────────────────────────────────────────────────────────────────────────
//
// The emergency drop is a special case: status stays 'approved' (the staffer
// IS responsible for finding their own cover, per spec §6.5), but
// dropped_at + drop_emergency=true mark the row for the manager dashboard.
// Notifications: notifyAdminCategory (admin users), an ADMIN_PHONE hotline
// SMS (Dallas's personal phone), AND an audit row on proposal_activity_log.

const MIN_EMERGENCY_REASON_LEN = 10;
const MAX_EMERGENCY_REASON_LEN = 500;

router.post('/requests/:requestId/emergency-drop', asyncHandler(async (req, res) => {
  const requestId = parseInt(req.params.requestId, 10);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    throw new ValidationError({ requestId: 'Invalid request id.' });
  }

  const rawReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (rawReason.length < MIN_EMERGENCY_REASON_LEN) {
    throw new ValidationError({
      reason: `Reason must be at least ${MIN_EMERGENCY_REASON_LEN} characters so management understands the situation.`,
    });
  }
  if (rawReason.length > MAX_EMERGENCY_REASON_LEN) {
    throw new PayloadTooLargeError(`Reason must be ${MAX_EMERGENCY_REASON_LEN} characters or fewer.`, 'reason_too_long');
  }
  const reason = rawReason.slice(0, MAX_EMERGENCY_REASON_LEN);

  let ctx;
  let hoursOut;

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    ctx = await loadRequestContextForUpdate(dbClient, requestId);
    if (!ctx) throw new NotFoundError('Request not found.');
    if (ctx.user_id !== req.user.id) {
      throw new PermissionError('You can only emergency-drop your own shift requests.');
    }
    if (ctx.status !== 'approved') {
      throw new ConflictError('Only approved shifts can be emergency-dropped.', 'not_approved');
    }
    if (ctx.dropped_at) {
      throw new ConflictError('This shift was already dropped.', 'already_dropped');
    }
    // Pay-period guard does NOT apply to emergency drops (spec §6.5): the
    // event is by definition <72h out, so it cannot be in a processing
    // period (those run after payday, days after event).

    hoursOut = hoursToEvent({ event_date: ctx.event_date, start_time: ctx.start_time });
    if (hoursOut === null) {
      throw new ConflictError('Could not determine shift start time.', 'unparseable_shift_time');
    }
    if (hoursOut >= 72) {
      throw new ConflictError(
        'Emergency drops are only for events within 72 hours. Use Request Cover or Clean Drop instead.',
        'wrong_mode'
      );
    }

    await dbClient.query(
      `UPDATE shift_requests
          SET dropped_at = NOW(),
              drop_reason = $1,
              drop_emergency = true
        WHERE id = $2`,
      [reason, requestId]
    );

    await suppressPendingMessagesForUserShift(dbClient, ctx.shift_id, req.user.id);

    // Audit row on proposal_activity_log when the shift has a proposal_id.
    // shift.proposal_id is nullable (standalone shifts); skip + Sentry-warn
    // so the gap is visible without breaking the drop.
    if (ctx.proposal_id) {
      await dbClient.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
         VALUES ($1, 'emergency_drop_requested', 'staff', $2, $3::jsonb)`,
        [
          ctx.proposal_id,
          req.user.id,
          JSON.stringify({
            reason,
            hours_out: Math.round(hoursOut * 100) / 100,
            shift_id: ctx.shift_id,
            request_id: requestId,
          }),
        ]
      );
    } else if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage('Emergency drop on standalone shift (no proposal_id)', {
        level: 'warning',
        tags: { feature: 'emergency-drop' },
        extra: { shift_id: ctx.shift_id, request_id: requestId, user_id: req.user.id },
      });
    }

    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    dbClient.release();
  }

  // ── Post-commit notifications ─────────────────────────────────────────
  const eventTypeLabel = getEventTypeLabel({
    event_type: ctx.shift_event_type,
    event_type_custom: ctx.shift_event_type_custom,
  });
  const eventDateLong = formatEventDateLong(ctx.event_date);
  const eventDateShort = (() => {
    if (!ctx.event_date) return 'soon';
    const ymd = ctx.event_date instanceof Date
      ? `${ctx.event_date.getFullYear()}-${String(ctx.event_date.getMonth() + 1).padStart(2, '0')}-${String(ctx.event_date.getDate()).padStart(2, '0')}`
      : String(ctx.event_date).slice(0, 10);
    const d = new Date(`${ymd}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return 'soon';
    return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  })();

  // Look up the staffer's display name for the front-loaded SMS.
  const { rows: staffRows } = await pool.query(
    `SELECT COALESCE(cp.preferred_name, u.email) AS display_name
       FROM users u LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE u.id = $1`,
    [req.user.id]
  );
  const staffName = staffRows[0]?.display_name || 'A staffer';

  const subject = `EMERGENCY DROP: ${eventTypeLabel} on ${eventDateLong} (${Math.round(hoursOut)}h out)`;
  const text = [
    `${staffName} dropped their shift on emergency notice.`,
    ``,
    `Reason: ${reason}`,
    ``,
    `Event: ${eventTypeLabel}${ctx.client_name ? ' for ' + ctx.client_name : ''}`,
    `Date: ${eventDateLong}`,
    `Time: ${ctx.start_time || 'TBD'} - ${ctx.end_time || 'TBD'}`,
    `Location: ${ctx.location || 'TBD'}`,
    `Position: ${ctx.position || 'staff'}`,
    `Hours out: ${Math.round(hoursOut * 10) / 10}`,
    ``,
    `Action required: assign a replacement immediately.`,
    `Review in the admin dashboard: ${ADMIN_URL}/staffing`,
  ].join('\n');
  const html = `<p style="background:#fff4e5;border-left:4px solid #d9822b;padding:12px 16px;">
      <strong>${staffName}</strong> dropped their shift on emergency notice.
    </p>
    <p><strong>Reason:</strong> ${reason}</p>
    <p><strong>Event:</strong> ${eventTypeLabel}${ctx.client_name ? ' for ' + ctx.client_name : ''}<br>
    <strong>Date:</strong> ${eventDateLong}<br>
    <strong>Time:</strong> ${ctx.start_time || 'TBD'} to ${ctx.end_time || 'TBD'}<br>
    <strong>Location:</strong> ${ctx.location || 'TBD'}<br>
    <strong>Position:</strong> ${ctx.position || 'staff'}<br>
    <strong>Hours out:</strong> ${Math.round(hoursOut * 10) / 10}</p>
    <p><strong>Action required:</strong> assign a replacement immediately.</p>
    <p><a href="${ADMIN_URL}/staffing">Review in admin dashboard</a></p>`;
  const adminSmsBody = staff_drop_to_management_sms({
    staff_name: staffName,
    client_name: ctx.client_name,
    event_date_short: eventDateShort,
    hours_to_event: hoursOut,
    reason,
  });

  // Admin-user fan-out (notifyAdminCategory uses the per-user phone). <72h is
  // always within the daysOut <= 7 SMS gate, so SMS fires.
  await notifyManagementOfAction({
    category: 'urgent_staffing',
    subject,
    emailHtml: html,
    emailText: text,
    smsBody: adminSmsBody,
    daysOut: hoursOut / 24,
  });

  // ADMIN_PHONE hotline SMS — separate fan-out target (Dallas's personal
  // phone), distinct from the admin-user-phone broadcast above.
  if (process.env.ADMIN_PHONE) {
    try {
      await sendAndLogSms({
        to: process.env.ADMIN_PHONE,
        body: adminSmsBody,
        clientId: null,
        messageType: 'admin_emergency_drop_hotline',
      });
    } catch (smsErr) {
      Sentry.captureException(smsErr, {
        tags: { feature: 'emergency-drop', channel: 'admin-phone-hotline' },
        extra: { shift_id: ctx.shift_id, user_id: req.user.id },
      });
      console.error('[staffShiftActions] ADMIN_PHONE hotline SMS failed:', smsErr.message);
    }
  } else if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage('Emergency-drop hotline SMS skipped: ADMIN_PHONE not configured', {
      level: 'warning',
      tags: { feature: 'emergency-drop' },
      extra: { shift_id: ctx.shift_id, user_id: req.user.id, hours_out: hoursOut },
    });
  }

  res.json({
    success: true,
    request_id: requestId,
    shift_id: ctx.shift_id,
    dropped_at: new Date().toISOString(),
    drop_emergency: true,
    hours_out: Math.round(hoursOut * 100) / 100,
  });
}));

module.exports = router;
