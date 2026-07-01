'use strict';

// Request -> approval money seam, extracted from shifts.js (which hit the
// 1000-line hard cap). Three handlers: a staffer requests a shift (ranked
// roles), an admin manually assigns, and an admin approves/denies a request.
// `position` is the only money-sensitive field here — payroll's tip split keys
// on LOWER(position) = 'bartender' — so it is resolved from the staffer's
// ranked requested_positions (or an explicit admin override) at approval time,
// never defaulted. shifts.js mounts these on its router with the shared
// auth / requireStaffing / requireOnboarded middleware.

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendSMS, normalizePhone } = require('../utils/sms');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');
const { notifyAdminCategory } = require('../utils/adminNotifications');
const { getEventTypeLabel } = require('../utils/eventTypes');
const { subtractMinutesFromTime } = require('../utils/setupTime');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { ADMIN_URL } = require('../utils/urls');
const { scheduleStaffShiftMessages } = require('../utils/staffShiftHandlers');
const { confirmStaffingIfFullyStaffed } = require('../utils/lastMinuteStaffingConfirmation');
const { suppressBeoNudgesForStaffers } = require('../utils/beoHandlers');
const { approveAndCascade } = require('../utils/coverApprovalCascade');
const { parsePositionsNeeded } = require('../utils/positionsNeeded');
const { canonicalizeRole } = require('../utils/staffingRoles');
const { computeRemaining, classifyRequest } = require('../utils/staffingClassification');
const { sendWaitlistJoinEmail } = require('../utils/staffingEmailTemplates');

// Equipment tokens a shift can require staff to transport (kept in sync with the
// staff LogisticsTag + admin equipment picker).
const EQUIPMENT_TOKENS = ['portable_bar', 'cooler', 'table_with_spandex'];

/**
 * Parse a shifts.equipment_required TEXT column ('[]' default) to an array of
 * known tokens. Tolerant of NULL / malformed JSON (-> []), so a logistics check
 * never throws on a legacy row.
 */
function parseEquipment(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((t) => typeof t === 'string');
}

/** A shift requires transport when it lists equipment OR needs a supply run. */
function shiftRequiresTransport(shift) {
  return parseEquipment(shift.equipment_required).length > 0 || shift.supply_run_required === true;
}

/** Parse a shift_requests.requested_positions TEXT column to canonical roles. */
function parseRequestedPositions(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const entry of arr) {
    const role = canonicalizeRole(entry);
    if (role && !out.includes(role)) out.push(role);
  }
  return out;
}

// ─── POST /shifts/:id/request ─────────────────────────────────────
//
// Staff requests to work a shift, supplying a ranked `requested_positions`
// array (their role preference order). `position` is intentionally NOT set
// here — it is resolved at approval. The request is classified actionable
// (an open slot exists for one ranked role) or waitlisted (none open); a
// waitlist-join email fires once, only on the transition INTO waitlisted.
async function requestShiftHandler(req, res) {
  const { requested_positions, transport_acknowledged, notes } = req.body;

  // Load the shift + its per-role approved-active aggregate in one round trip.
  const shiftRes = await pool.query(
    `SELECT s.id, s.positions_needed, s.equipment_required, s.supply_run_required,
            s.event_type, s.event_type_custom, s.event_date,
            (SELECT COALESCE(jsonb_object_agg(position, c), '{}'::jsonb)
               FROM (SELECT position, COUNT(*) c FROM shift_requests
                      WHERE shift_id = s.id AND status = 'approved' AND dropped_at IS NULL
                        AND position IS NOT NULL
                      GROUP BY position) g) AS approved_by_role
       FROM shifts s
      WHERE s.id = $1 AND s.status = 'open'`,
    [req.params.id]
  );
  const shift = shiftRes.rows[0];
  if (!shift) throw new NotFoundError('Shift not available.');

  // Validate ranked roles: non-empty, deduped canonical, all in the roster.
  const roster = parsePositionsNeeded(shift.positions_needed);
  const rosterSet = new Set(roster);
  const roles = [...new Set((Array.isArray(requested_positions) ? requested_positions : [])
    .map(canonicalizeRole)
    .filter(Boolean))];
  if (roles.length === 0) {
    throw new ValidationError({ requested_positions: 'Select at least one role you can work.' });
  }
  const unknown = roles.find((r) => !rosterSet.has(r));
  if (unknown) {
    throw new ValidationError({ requested_positions: `This event does not need a ${unknown}.` });
  }

  // Re-check the transport acknowledgment against the CURRENT logistics flags on
  // every submit (re-require-on-escalation): if equipment/supply was added since
  // a prior request, the staffer must ack again.
  const transportRequired = shiftRequiresTransport(shift);
  if (transportRequired && transport_acknowledged !== true) {
    throw new ValidationError({ transport_acknowledged: 'Please acknowledge the equipment / supply transport requirement.' });
  }

  // Classify against open slots (the staffer's own pending row is not approved,
  // so approved_by_role already excludes it). Track the prior state so the
  // waitlist-join email fires only on the transition INTO waitlisted.
  const remaining = computeRemaining(roster, shift.approved_by_role || {});
  const newState = classifyRequest(roles, remaining).state;

  const existing = await pool.query(
    'SELECT requested_positions, status FROM shift_requests WHERE shift_id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  const prior = existing.rows[0];
  // "Already on the waitlist before this submit" = an existing pending row whose
  // ranked roles are all currently full. Computed against the CURRENT remaining
  // so a re-rank that stays waitlisted does not re-send (the email fires once).
  const priorWaitlisted = !!prior && prior.status === 'pending'
    && classifyRequest(parseRequestedPositions(prior.requested_positions), remaining).state === 'waitlisted';

  // Upsert: store the ranked roles, clear position (resolved at approval), and
  // stamp the transport ack only when actually required AND given (clears a
  // stale ack when the event is no longer transport-required). A staffer
  // re-requesting after a denial counts as a fresh BEO cycle.
  const result = await pool.query(`
    INSERT INTO shift_requests (shift_id, user_id, requested_positions, position, notes, transport_acknowledged_at)
    VALUES ($1, $2, $3, NULL, $4, CASE WHEN $5 THEN NOW() ELSE NULL END)
    ON CONFLICT (shift_id, user_id) DO UPDATE
      SET requested_positions = $3,
          position = NULL,
          notes = $4,
          status = 'pending',
          transport_acknowledged_at = CASE WHEN $5 THEN NOW() ELSE NULL END,
          beo_acknowledged_at = CASE WHEN shift_requests.status = 'denied' THEN NULL ELSE shift_requests.beo_acknowledged_at END
    RETURNING *
  `, [req.params.id, req.user.id, JSON.stringify(roles), notes || null, transportRequired && transport_acknowledged === true]);

  // Requester's preferred name (used by whichever notification branch runs).
  const cp = await pool.query(
    'SELECT preferred_name FROM contractor_profiles WHERE user_id = $1',
    [req.user.id]
  );
  const preferredName = cp.rows[0]?.preferred_name || null;

  if (newState === 'waitlisted') {
    // Transition into waitlisted only: low-key email, fire once across re-ranks.
    // Best-effort, mirroring the actionable branch below: sendWaitlistJoinEmail
    // is already non-throwing, but wrap locally so the 201 can never become a
    // 500 on a send failure regardless of that module's internal contract.
    if (!priorWaitlisted) {
      try {
        const eventLabel = getEventTypeLabel({ event_type: shift.event_type, event_type_custom: shift.event_type_custom });
        await sendWaitlistJoinEmail({ to: req.user.email, staffName: preferredName, eventLabel });
      } catch (emailErr) {
        console.error('Waitlist-join email failed (non-blocking):', emailErr);
      }
    }
  } else {
    // Actionable: notify admins subscribed to urgent_staffing (non-blocking).
    try {
      const staffName = preferredName || req.user.email || 'A staff member';
      const eventDate = shift.event_date
        ? new Date(shift.event_date).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })
        : 'TBD';
      const tpl = emailTemplates.shiftRequestAdmin({
        staffName,
        eventTypeLabel: getEventTypeLabel({ event_type: shift.event_type, event_type_custom: shift.event_type_custom }),
        eventDate,
        position: roles.join(', '),
        adminUrl: `${ADMIN_URL}/staffing`,
      });
      await notifyAdminCategory({
        category: 'urgent_staffing',
        subject: tpl.subject,
        emailHtml: tpl.html,
        emailText: tpl.text,
      });
    } catch (emailErr) {
      console.error('Shift request notification failed (non-blocking):', emailErr);
    }
  }

  res.status(201).json(result.rows[0]);
}

// ─── POST /shifts/:id/assign ──────────────────────────────────────
//
// Admin manually assigns a staff member to a shift. `position` is REQUIRED and
// must canonicalize to a known role — the old `|| 'Bartender'` default is gone,
// so a missing/garbage role is a 400, never a silent Bartender write.
async function assignShiftHandler(req, res) {
  const { user_id, position } = req.body;
  if (!user_id) throw new ValidationError({ user_id: 'user_id is required.' });

  const role = canonicalizeRole(position);
  if (!role) throw new ValidationError({ position: 'A valid role (Bartender, Banquet Server, or Barback) is required.' });

  // Verify the shift exists
  const shiftRes = await pool.query('SELECT * FROM shifts WHERE id = $1', [req.params.id]);
  if (!shiftRes.rows[0]) throw new NotFoundError('Shift not found.');

  // Verify the target is a real, onboarded worker (staff OR manager — managers are a worker
  // class, same as the messages.js recipient allow-list and the self-request path) before
  // creating the request. A typo, stale id, or non-worker (admin) would otherwise insert an
  // orphan shift_request whose downstream SMS/email blocks silently no-op (audit 3c).
  const eligible = await pool.query(
    "SELECT id FROM users WHERE id = $1 AND role IN ('staff','manager') AND onboarding_status IN ('submitted','reviewed','approved') LIMIT 1",
    [user_id]
  );
  if (!eligible.rows[0]) throw new NotFoundError('User not eligible for assignment.');

  // Insert or update the shift request as approved.
  // BEO: clear any stale ack unconditionally — admin re-approving means a
  // fresh assignment cycle; the prior ack (if any) was for the previous one.
  const result = await pool.query(`
    INSERT INTO shift_requests (shift_id, user_id, position, status)
    VALUES ($1, $2, $3, 'approved')
    ON CONFLICT (shift_id, user_id) DO UPDATE
      SET status = 'approved',
          position = $3,
          beo_acknowledged_at = NULL,
          updated_at = NOW()
    RETURNING *
  `, [req.params.id, user_id, role]);

  const request = result.rows[0];
  const shift = shiftRes.rows[0];

  // Over-fill audit (advisory, best-effort): the admin UI routes approvals
  // through /assign, so this is where over-fills are recorded. Log when this
  // assignment puts `role` over its roster count, EXCLUDING the assignee's own
  // prior approved row so a plain re-assign is never counted as an over-fill.
  if (shift.proposal_id) {
    try {
      const others = await pool.query(
        `SELECT position, COUNT(*)::int AS c FROM shift_requests
          WHERE shift_id = $1 AND status = 'approved' AND dropped_at IS NULL
            AND position IS NOT NULL AND user_id <> $2
          GROUP BY position`,
        [req.params.id, user_id]
      );
      const approvedByRole = {};
      for (const r of others.rows) approvedByRole[r.position] = r.c;
      const remaining = computeRemaining(parsePositionsNeeded(shift.positions_needed), approvedByRole);
      if ((remaining[role] || 0) <= 0) {
        await pool.query(
          `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
           VALUES ($1, 'staffing_overfill', 'admin', $2, $3)`,
          [shift.proposal_id, req.user.id, JSON.stringify({ role, request_id: request.id, shift_id: shift.id, via: 'assign' })]
        );
      }
    } catch (ofErr) {
      console.error('[shifts] over-fill audit log failed (non-blocking):', ofErr.message);
    }
  }

  // Fetch the assignee's email + contractor profile ONCE; both the SMS and
  // email notification blocks below read from this single row (SMS uses
  // phone + preferred_name, email uses email + preferred_name). Best-effort:
  // a fetch failure must not break the (already-created) assignment response,
  // so swallow it and let both blocks no-op.
  const recipient = await pool.query(
    'SELECT u.email, cp.preferred_name, cp.phone FROM users u LEFT JOIN contractor_profiles cp ON cp.user_id = u.id WHERE u.id = $1',
    [user_id]
  ).then(r => r.rows[0] || {}).catch((e) => {
    console.error('Assignment notification fetch failed (non-blocking):', e.message);
    return {};
  });

  // Send SMS notification (non-blocking)
  try {
    const cp = recipient;
    if (cp?.phone) {
      const date = shift.event_date
        ? new Date(shift.event_date).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })
        : 'TBD';
      const time = shift.start_time && shift.end_time
        ? `${shift.start_time}–${shift.end_time}`
        : shift.start_time || 'TBD';
      const location = shift.location || 'TBD';
      const name = cp.preferred_name ? `, ${cp.preferred_name}` : '';
      const label = getEventTypeLabel({ event_type: shift.event_type, event_type_custom: shift.event_type_custom });
      const ctx = shift.client_name ? `${label} at ${shift.client_name}` : label;
      // Setup/arrival clock time (start − minutes, default 60). Null when start
      // time is missing/unparseable → omit the clause so we never send "by null".
      const setupTime = subtractMinutesFromTime(shift.start_time, shift.setup_minutes_before ?? 60);
      const setupText = setupTime ? ` Please arrive by ${setupTime} to set up.` : '';

      await sendSMS({
        to: normalizePhone(cp.phone) || cp.phone,
        body: `Hey${name}! You've been assigned to the ${ctx} on ${date} at ${time} — ${location}.${setupText} See you there! - Dr. Bartender`,
      });
    }
  } catch (smsErr) {
    console.error('SMS notification failed (non-blocking):', smsErr.message);
  }

  // Send email notification (non-blocking)
  try {
    const staffEmail = recipient.email;
    if (staffEmail) {
      const date = shift.event_date
        ? new Date(shift.event_date).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })
        : 'TBD';
      // shift comes from SELECT * so setup_minutes_before is in hand. Back-of-
      // house setup clock time; null start time → template omits the row.
      const setupTime = subtractMinutesFromTime(shift.start_time, shift.setup_minutes_before ?? 60);
      const tpl = emailTemplates.shiftRequestApproved({
        staffName: recipient.preferred_name || 'there',
        eventTypeLabel: getEventTypeLabel({ event_type: shift.event_type, event_type_custom: shift.event_type_custom }),
        eventDate: date,
        startTime: shift.start_time || 'TBD',
        endTime: shift.end_time || 'TBD',
        location: shift.location || 'TBD',
        setupTime,
      });
      await sendEmail({ to: staffEmail, ...tpl });
    }
  } catch (emailErr) {
    console.error('Staff assignment email failed (non-blocking):', emailErr.message);
  }

  // If this assignment fills the shift, clear the proposal's last-minute hold
  // AND fire Touch 2.2 (client confirmation email + SMS naming the bartender).
  // Fire-and-forget: the helper has its own outer try/catch + Sentry; awaiting
  // would block the response on Resend + Twilio round-trips. The .catch is
  // belt-and-suspenders so a future refactor that lets a rejection escape the
  // helper still lands a route-tagged Sentry event.
  confirmStaffingIfFullyStaffed(req.params.id).catch((confErr) => {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(confErr, { tags: { route: 'shifts/assign', issue: 'staffing-confirmation' } });
    }
    console.error('[shifts] staffing-confirmation hook failed (non-blocking):', confErr.message);
  });

  // Schedule the day-before reminder + post-event thank-you SMS for everyone
  // approved on this shift (idempotent). Best-effort: a scheduling failure
  // must never break the assignment response.
  try {
    await scheduleStaffShiftMessages(req.params.id);
  } catch (schedErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(schedErr, { tags: { route: 'shifts/assign', issue: 'staff-sms-schedule' } });
    }
    console.error('[shifts] staff SMS scheduling failed (non-blocking):', schedErr.message);
  }

  res.status(201).json(request);
}

// ─── PUT /shifts/requests/:requestId ──────────────────────────────
//
// Admin approves or denies a request. On approval (non cover-swap), `position`
// is resolved from the staffer's ranked requested_positions against the open
// slots, or from an explicit admin override. An unresolvable approval (all the
// staffer's ranked roles full, no override) is a 400 and leaves position
// untouched. Cover-swap approvals keep their own already-resolved position via
// approveAndCascade (the claimer's role was set at claim time).
async function approveOrDenyRequestHandler(req, res) {
  const { status, position: overridePosition } = req.body;
  if (!['approved', 'denied', 'pending'].includes(status)) {
    throw new ValidationError({ status: 'Invalid status.' });
  }

  // BEO: capture prior state for branching. approved → denied suppresses BEO
  // (staffer is dropping out of the cycle). approved (re-promote) clears any
  // stale ack from a prior cycle. Also capture replaced_by_request_id so the
  // approval branch can run the cover-swap cascade when present (Task 25).
  // positions_needed + approved_by_role + requested_positions drive the money
  // seam: resolving which role this approval fills.
  const pre = await pool.query(
    `SELECT sr.status AS prior_status, sr.user_id, sr.replaced_by_request_id,
            sr.requested_positions, s.proposal_id, s.id AS shift_id, s.positions_needed,
            (SELECT COALESCE(jsonb_object_agg(position, c), '{}'::jsonb)
               FROM (SELECT position, COUNT(*) c FROM shift_requests
                      WHERE shift_id = s.id AND status = 'approved' AND dropped_at IS NULL
                        AND position IS NOT NULL
                      GROUP BY position) g) AS approved_by_role
       FROM shift_requests sr JOIN shifts s ON s.id = sr.shift_id
      WHERE sr.id = $1`,
    [req.params.requestId]
  );
  if (!pre.rows[0]) throw new NotFoundError('Request not found.');
  const { prior_status, user_id: srUserId, proposal_id: srProposalId,
          replaced_by_request_id: replacedByRequestId,
          requested_positions: srRequestedPositions, shift_id: srShiftId,
          positions_needed: srPositionsNeeded, approved_by_role: srApprovedByRole } = pre.rows[0];

  let result;
  if (status === 'approved') {
    if (replacedByRequestId) {
      // Cover-swap approval. Cascade extracted to coverApprovalCascade.js;
      // runs in one transaction so deny+suppress+BEO-nudge land atomically.
      // The claimer's position was resolved at claim time, so it is preserved.
      await approveAndCascade(pool, replacedByRequestId, parseInt(req.params.requestId, 10));
      result = await pool.query(`SELECT * FROM shift_requests WHERE id = $1`, [req.params.requestId]);
    } else {
      // Resolve the role this approval fills. An explicit admin override wins;
      // otherwise pick the staffer's top ranked role that still has an open
      // slot. Unresolvable (no override, no open ranked role) → 400.
      const remaining = computeRemaining(parsePositionsNeeded(srPositionsNeeded), srApprovedByRole || {});
      const requestedRoles = parseRequestedPositions(srRequestedPositions);
      const resolvedRole = overridePosition
        ? canonicalizeRole(overridePosition)
        : classifyRequest(requestedRoles, remaining).resolvableRole;
      if (!resolvedRole) {
        throw new ValidationError({ position: 'Cannot resolve a role for this approval — pick a role or open a slot.' });
      }
      result = await pool.query(
        `UPDATE shift_requests SET status = 'approved', position = $2, beo_acknowledged_at = NULL
          WHERE id = $1 RETURNING *`,
        [req.params.requestId, resolvedRole]
      );
      // Over-fill bookkeeping (advisory, best-effort, AFTER the write so a failed
      // approval never logs and a failed log never fails the approval): an admin
      // override onto a role with no open slot is allowed but recorded (same
      // activity-log pattern as eventCreation's staffing_shrink_capped).
      if ((remaining[resolvedRole] || 0) <= 0 && srProposalId) {
        try {
          await pool.query(
            `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
             VALUES ($1, 'staffing_overfill', 'admin', $2, $3)`,
            [srProposalId, req.user.id, JSON.stringify({ role: resolvedRole, request_id: parseInt(req.params.requestId, 10), shift_id: srShiftId })]
          );
        } catch (logErr) {
          console.error('[shifts] over-fill audit log failed (non-blocking):', logErr.message);
        }
      }
    }
  } else if (status === 'denied') {
    result = await pool.query(
      `UPDATE shift_requests SET status = 'denied', beo_acknowledged_at = NULL
        WHERE id = $1 RETURNING *`,
      [req.params.requestId]
    );
    if (prior_status === 'approved' && srProposalId) {
      await suppressBeoNudgesForStaffers(srProposalId, [srUserId], pool, 'staffer_unassigned: PUT request denied');
    }
  } else {
    result = await pool.query(
      `UPDATE shift_requests SET status = $1 WHERE id = $2 RETURNING *`,
      [status, req.params.requestId]
    );
  }
  if (!result.rows[0]) throw new NotFoundError('Request not found.');

  // SMS the staff member when their request is approved
  if (status === 'approved') {
    // Fetch the staffer's email + contractor profile + shift fields ONCE; both
    // the SMS and email blocks below read from this single row (superset of the
    // columns each needs; email gates on info.email, SMS gates on info.phone).
    // Best-effort: a fetch failure must not break the (already-committed)
    // approval response, so swallow it and let both blocks no-op.
    const info = await pool.query(`
      SELECT u.email,
             s.event_type, s.event_type_custom, s.client_name,
             s.event_date, s.start_time, s.end_time, s.location,
             s.setup_minutes_before,
             cp.phone, cp.preferred_name
      FROM shift_requests sr
      JOIN shifts s ON s.id = sr.shift_id
      JOIN users u ON u.id = sr.user_id
      LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
      WHERE sr.id = $1
    `, [req.params.requestId]).then(r => r.rows[0]).catch((e) => {
      console.error('Shift approval notification fetch failed (non-blocking):', e.message);
      return undefined;
    });

    try {
      if (info?.phone) {
        const date = info.event_date
          ? new Date(info.event_date).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })
          : 'TBD';
        const time = info.start_time && info.end_time
          ? `${info.start_time}–${info.end_time}`
          : info.start_time || 'TBD';
        const location = info.location || 'TBD';
        const name = info.preferred_name ? `, ${info.preferred_name}` : '';
        const label = getEventTypeLabel({ event_type: info.event_type, event_type_custom: info.event_type_custom });
        const ctx = info.client_name ? `${label} at ${info.client_name}` : label;
        // Setup/arrival clock time (start − minutes, default 60). Null when start
        // time is missing/unparseable → omit the clause so we never send "by null".
        const setupTime = subtractMinutesFromTime(info.start_time, info.setup_minutes_before ?? 60);
        const setupText = setupTime ? ` Please arrive by ${setupTime} to set up.` : '';

        await sendSMS({
          to: normalizePhone(info.phone) || info.phone,
          body: `Hey${name}! You've been confirmed for the ${ctx} on ${date} at ${time} — ${location}.${setupText} See you there! - Dr. Bartender`,
        });
      }
    } catch (smsErr) {
      console.error('SMS notification failed (non-blocking):', smsErr.message);
    }

    // Email the staff member (non-blocking)
    try {
      const staffEmail = info?.email;
      if (staffEmail && info) {
        const date = info.event_date
          ? new Date(info.event_date).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })
          : 'TBD';
        // Back-of-house setup clock time (start − minutes, default 60). null when
        // start time is missing/unparseable → template omits the row entirely.
        const setupTime = subtractMinutesFromTime(info.start_time, info.setup_minutes_before ?? 60);
        const tpl = emailTemplates.shiftRequestApproved({
          staffName: info.preferred_name || 'there',
          eventTypeLabel: getEventTypeLabel({ event_type: info.event_type, event_type_custom: info.event_type_custom }),
          eventDate: date,
          startTime: info.start_time || 'TBD',
          endTime: info.end_time || 'TBD',
          location: info.location || 'TBD',
          setupTime,
        });
        await sendEmail({ to: staffEmail, ...tpl });
      }
    } catch (emailErr) {
      console.error('Shift approval email failed (non-blocking):', emailErr);
    }

    // Approving this request may have fully staffed the shift, so clear the
    // linked proposal's last-minute hold AND fire Touch 2.2 if so.
    // result.rows[0] is the updated shift_request, so its shift_id is in hand.
    // Fire-and-forget with belt-and-suspenders .catch (mirrors the /assign
    // call site above, see comment there).
    confirmStaffingIfFullyStaffed(result.rows[0].shift_id).catch((confErr) => {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(confErr, { tags: { route: 'shifts/approve', issue: 'staffing-confirmation' } });
      }
      console.error('[shifts] staffing-confirmation hook failed (non-blocking):', confErr.message);
    });

    // Schedule staff reminder + thank-you SMS (idempotent, best-effort).
    try {
      await scheduleStaffShiftMessages(result.rows[0].shift_id);
    } catch (schedErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(schedErr, { tags: { route: 'shifts/approve', issue: 'staff-sms-schedule' } });
      }
      console.error('[shifts] staff SMS scheduling failed (non-blocking):', schedErr.message);
    }
  }

  res.json(result.rows[0]);
}

module.exports = {
  requestShiftHandler,
  assignShiftHandler,
  approveOrDenyRequestHandler,
  // Exported for the logistics-edit validation in shifts.js PUT /:id.
  EQUIPMENT_TOKENS,
};
