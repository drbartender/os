'use strict';

// Shift-lifecycle mutation handlers, extracted from shifts.js (which sits under
// the 1000-line hard cap). Two bulky route bodies live here: the shift UPDATE
// (PATCH-semantic PUT /:id with equipment validation + BEO-cancel transaction)
// and the first-class cancel / unassign action. Money-adjacent (proposal->shift
// sync; staffing seam) — cancel-or-unassign denies approved shift_requests and
// suppresses BEO nudges. shifts.js mounts these on its router with the shared
// auth / requireStaffing middleware. EQUIPMENT_TOKENS is the closed logistics
// set, owned by shifts.approval.js and reused here for the PUT validation.

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { geocodeAddress } = require('../utils/geocode');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { suppressBeoNudgesForStaffers } = require('../utils/beoHandlers');
const { notifyStaffOfCancellation } = require('../utils/staffShiftHandlers');
const { EQUIPMENT_TOKENS } = require('./shifts.approval');

// ─── PUT /shifts/:id ──────────────────────────────────────────────
//
// Update a shift. PATCH semantics: missing JSONB fields preserve prior values
// via COALESCE. A status='cancelled' edit wraps the UPDATE + BEO suppression in
// a transaction; non-cancel edits stay on the single-statement path.
async function updateShiftHandler(req, res) {
  const { event_type, event_type_custom, event_date, start_time, end_time, location, positions_needed, notes, status,
          equipment_required, auto_assign_days_before, setup_minutes_before, lat, lng,
          client_name, client_email, client_phone, guest_count, event_duration_hours, supply_run } = req.body;
  // Equipment tokens are a closed set; reject anything else so the logistics
  // tag + transport gate never key off an unknown value. Only validated when
  // the field is present (PATCH semantics keep the prior value otherwise).
  if (equipment_required !== undefined) {
    if (!Array.isArray(equipment_required)
        || equipment_required.some((t) => typeof t !== 'string' || !EQUIPMENT_TOKENS.includes(t))) {
      throw new ValidationError({ equipment_required: 'Invalid equipment selection.' });
    }
  }
  if (supply_run !== undefined && typeof supply_run !== 'boolean') {
    throw new ValidationError({ supply_run: 'supply_run must be a boolean.' });
  }
  // PATCH semantics: missing fields preserve existing values via COALESCE.
  // The previous version sent '[]' for omitted positions_needed /
  // equipment_required, silently wiping staffing + gear when the admin only
  // edited a date or note. Pass null for omitted JSONB fields so COALESCE
  // keeps the prior row. supply_run is a manual override: when sent it sets
  // supply_run_required AND flags supply_run_overridden so syncShiftsFromProposal
  // stops recomputing it; editing equipment_required never touches supply fields.
  const updateSql = `
    UPDATE shifts SET
      event_type = $1, event_type_custom = $2,
      event_date = COALESCE($3, event_date),
      start_time = $4, end_time = $5, location = $6,
      positions_needed = COALESCE($7, positions_needed),
      notes = $8,
      status = COALESCE($9, status),
      equipment_required = COALESCE($10, equipment_required),
      auto_assign_days_before = $11,
      lat = COALESCE($12, lat), lng = COALESCE($13, lng),
      setup_minutes_before = COALESCE($15, setup_minutes_before),
      client_name = COALESCE($16, client_name),
      client_email = COALESCE($17, client_email),
      client_phone = COALESCE($18, client_phone),
      guest_count = COALESCE($19, guest_count),
      event_duration_hours = COALESCE($20, event_duration_hours),
      supply_run_required = CASE WHEN $21::boolean IS NULL THEN supply_run_required ELSE $21::boolean END,
      supply_run_overridden = CASE WHEN $21::boolean IS NULL THEN supply_run_overridden ELSE true END,
      updated_at = NOW()
    WHERE id = $14 RETURNING *
  `;
  const updateParams = [
    event_type || null, event_type_custom || null, event_date || null,
    start_time || null, end_time || null,
    location || null,
    positions_needed !== undefined ? JSON.stringify(positions_needed) : null,
    notes || null, status || null,
    equipment_required !== undefined ? JSON.stringify(equipment_required) : null,
    auto_assign_days_before !== null && auto_assign_days_before !== undefined ? auto_assign_days_before : null,
    lat || null, lng || null,
    req.params.id,
    setup_minutes_before !== null && setup_minutes_before !== undefined ? parseInt(setup_minutes_before, 10) : null,
    client_name || null, client_email || null, client_phone || null,
    guest_count ? parseInt(guest_count, 10) : null,
    event_duration_hours ? parseFloat(event_duration_hours) : null,
    supply_run === undefined ? null : supply_run,
  ];

  // BEO: shift-cancel path wraps UPDATE + suppression in a transaction so
  // that a downstream suppression failure rolls back the cancel. Non-cancel
  // edits stay on the pre-existing single-statement path.
  let result;
  if (status === 'cancelled') {
    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');
      result = await dbClient.query(updateSql, updateParams);
      if (!result.rows[0]) throw new NotFoundError('Shift not found.');
      const approvedRes = await dbClient.query(
        `SELECT user_id FROM shift_requests WHERE shift_id = $1 AND status = 'approved'`,
        [req.params.id]
      );
      const userIds = approvedRes.rows.map((r) => r.user_id);
      const proposalIdForBeo = result.rows[0].proposal_id;
      if (proposalIdForBeo && userIds.length > 0) {
        await suppressBeoNudgesForStaffers(proposalIdForBeo, userIds, dbClient, 'staffer_unassigned: generic PUT shift cancelled');
      }
      await dbClient.query('COMMIT');
    } catch (err) {
      try { await dbClient.query('ROLLBACK'); } catch (_e) { /* already rolled back */ }
      throw err;
    } finally {
      dbClient.release();
    }
  } else {
    result = await pool.query(updateSql, updateParams);
    if (!result.rows[0]) throw new NotFoundError('Shift not found.');
  }

  // Re-geocode if location changed and no explicit lat/lng
  const shift = result.rows[0];
  if (!lat && !lng && location) {
    geocodeAddress(location)
      .then(coords => {
        if (coords) {
          return pool.query('UPDATE shifts SET lat = $1, lng = $2 WHERE id = $3', [coords.lat, coords.lng, shift.id]);
        }
      })
      .catch(err => console.error('[Shifts] Geocode error:', err.message));
  }

  res.json(shift);
}

// ─── POST /shifts/:id/cancel-or-unassign ──────────────────────────
//
// First-class cancel / unassign action.
//
// mode='cancel'   — sets shifts.status='cancelled' and denies every non-denied
//                   shift_requests row. Affected set = currently-approved staff.
// mode='unassign' — requires `user_id`. Flips that staffer's approved request
//                   to 'denied'. Affected set = that one staffer.
//
// Pending shift_reminder / staff_thank_you rows for the affected staffer(s) are
// suppressed.
//
// Staff notification (spec 3.18) is admin-toggled and best-effort: when
// notify_assigned_staff is true, fires SMS/email per notify_sms / notify_email
// AFTER commit. Both sub-flags default false.
async function cancelOrUnassignShiftHandler(req, res) {
  const { mode, user_id, notify_assigned_staff, notify_sms, notify_email } = req.body;
  if (mode !== 'cancel' && mode !== 'unassign') {
    throw new ValidationError({ mode: "mode must be 'cancel' or 'unassign'." });
  }
  const shiftId = parseInt(req.params.id, 10);
  if (Number.isNaN(shiftId)) throw new ValidationError({ id: 'Invalid shift id.' });

  let unassignUserId = null;
  if (mode === 'unassign') {
    unassignUserId = parseInt(user_id, 10);
    if (Number.isNaN(unassignUserId)) {
      throw new ValidationError({ user_id: 'user_id is required to unassign a staffer.' });
    }
  }

  const dbClient = await pool.connect();
  let affectedUserIds = [];
  const kind = mode === 'cancel' ? 'cancelled' : 'unassigned';
  try {
    await dbClient.query('BEGIN');

    const shiftRes = await dbClient.query('SELECT id, proposal_id FROM shifts WHERE id = $1', [shiftId]);
    if (!shiftRes.rows[0]) throw new NotFoundError('Shift not found.');
    const proposalIdForBeo = shiftRes.rows[0].proposal_id;

    if (mode === 'cancel') {
      const approved = await dbClient.query(
        "SELECT user_id FROM shift_requests WHERE shift_id = $1 AND status = 'approved'",
        [shiftId]
      );
      affectedUserIds = approved.rows.map((r) => r.user_id);
      await dbClient.query("UPDATE shifts SET status = 'cancelled' WHERE id = $1", [shiftId]);
      await dbClient.query(
        "UPDATE shift_requests SET status = 'denied' WHERE shift_id = $1 AND status != 'denied'",
        [shiftId]
      );
      await dbClient.query(
        `UPDATE scheduled_messages SET status = 'suppressed', error_message = 'shift cancelled'
          WHERE entity_type = 'shift' AND entity_id = $1
            AND message_type IN ('shift_reminder', 'staff_thank_you')
            AND status = 'pending'`,
        [shiftId]
      );
    } else {
      const upd = await dbClient.query(
        "UPDATE shift_requests SET status = 'denied' WHERE shift_id = $1 AND user_id = $2 AND status = 'approved' RETURNING id",
        [shiftId, unassignUserId]
      );
      if (!upd.rows[0]) {
        throw new NotFoundError('No approved assignment found for that staffer on this shift.');
      }
      affectedUserIds = [unassignUserId];
      await dbClient.query(
        `UPDATE scheduled_messages SET status = 'suppressed', error_message = 'staff unassigned'
          WHERE entity_type = 'shift' AND entity_id = $1
            AND recipient_type = 'staff' AND recipient_id = $2
            AND message_type IN ('shift_reminder', 'staff_thank_you')
            AND status = 'pending'`,
        [shiftId, unassignUserId]
      );
    }

    // BEO: suppress pending nudges for affected staffers on the proposal.
    // The helper's NOT EXISTS guard keeps the nudge for staffers who still
    // hold an approved active shift elsewhere on this multi-shift proposal.
    if (proposalIdForBeo && affectedUserIds.length > 0) {
      await suppressBeoNudgesForStaffers(proposalIdForBeo, affectedUserIds, dbClient, `staffer_unassigned: cancel-or-unassign (${mode})`);
    }

    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err;
  } finally {
    dbClient.release();
  }

  if (notify_assigned_staff === true && (notify_sms === true || notify_email === true)) {
    try {
      await notifyStaffOfCancellation({
        shiftId,
        staffUserIds: affectedUserIds,
        kind,
        sms: notify_sms === true,
        email: notify_email === true,
      });
    } catch (notifyErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(notifyErr, { tags: { route: 'shifts/cancel-or-unassign', issue: 'staff-notify' } });
      }
      console.error('[shifts] cancel/unassign staff notify failed (non-blocking):', notifyErr.message);
    }
  }

  res.json({ success: true, mode, affected_staff: affectedUserIds.length });
}

module.exports = {
  updateShiftHandler,
  cancelOrUnassignShiftHandler,
};
