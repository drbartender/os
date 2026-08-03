// Shift-keyed staff event-details surface (spec 2026-07-22).
//
// GET /api/shifts/:shiftId/event-details — full payload for the staff page.
// GET /api/shifts/:shiftId/menu-print    — R2 proxy download of the bar-menu
//                                          print file (assigned staff + admin).
//
// Why shift-keyed: the staff portal navigates by shiftId, and the old page had
// to hunt its own proposalId across three list feeds before it could load
// anything. One round trip now, and a deep link works cold.
//
// Mounted at /api/shifts AFTER server/routes/shifts.js. Express matches in mount
// order and shifts.js has no two-segment `/:x/:y` GET that could swallow these,
// so the specific paths here are reached; keep it that way if shifts.js grows.

const express = require('express');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pool } = require('../db');
const { auth, requireOnboarded } = require('../middleware/auth');
const { beoReadLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../middleware/asyncHandler');
const { NotFoundError, PermissionError, ExternalServiceError } = require('../utils/errors');
const { authorizeEventRead, buildEventDetailsPayload } = require('../utils/eventDetailsPayload');
const { getSignedUrl } = require('../utils/storage');

const router = express.Router();

/**
 * Load a readable shift. A cancelled shift is indistinguishable from a missing
 * one on purpose: staff should not learn that a cancelled event exists by the
 * shape of the error.
 */
async function loadShift(shiftId) {
  if (!Number.isFinite(shiftId)) throw new NotFoundError('Shift not found.');
  const r = await pool.query(
    `SELECT s.id, s.proposal_id, s.status, s.event_date, s.start_time, s.end_time,
            s.location, s.guest_count, s.event_type, s.event_type_custom, s.client_name,
            s.positions_needed, s.equipment_required, s.supply_run_required,
            s.setup_minutes_before
       FROM shifts s WHERE s.id = $1`,
    [shiftId]
  );
  const row = r.rows[0];
  if (!row || row.status === 'cancelled') throw new NotFoundError('Shift not found.');
  return row;
}

router.get('/:shiftId/event-details', auth, requireOnboarded, beoReadLimiter, asyncHandler(async (req, res) => {
  const shiftId = parseInt(req.params.shiftId, 10);
  const shift = await loadShift(shiftId);

  // Legacy manual shift with no proposal: still requestable, so the brief must
  // render from shift data alone rather than 404 on a shift staff can see in
  // the open-shifts list.
  if (!shift.proposal_id) {
    const my = await pool.query(
      `SELECT id, status, position, requested_positions FROM shift_requests
        WHERE shift_id = $1 AND user_id = $2 AND status != 'denied' AND dropped_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      [shiftId, req.user.id]
    );
    const mine = my.rows[0] || null;
    const isAssigned = !!mine && mine.status === 'approved';
    const isPrivileged = req.user.role === 'admin' || req.user.role === 'manager';
    return res.json({
      shift_id: shiftId,
      proposal: null,
      client: { name: shift.client_name || null, phone: null },
      package: null,
      drink_plan: null,
      shopping_list_status: null,
      addons: [],
      shift_requests: [],
      team_roster: [],
      // Same shape as the proposal path so consumers never branch on null.
      menu_print: { status: 'not_required' },
      shifts: [{
        id: shift.id,
        event_date: shift.event_date,
        start_time: shift.start_time,
        end_time: shift.end_time,
        location: shift.location,
        guest_count: shift.guest_count,
        event_type: shift.event_type,
        event_type_custom: shift.event_type_custom,
        client_name: shift.client_name,
        positions_needed: shift.positions_needed,
        equipment_required: shift.equipment_required,
        supply_run_required: shift.supply_run_required,
        setup_minutes_before: shift.setup_minutes_before,
        approved_by_role: {},
        cover_requested_at: null,
        cover_for_first_initial: null,
        my_request_id: mine ? mine.id : null,
        my_request_status: mine ? mine.status : null,
        my_position: mine ? mine.position : null,
        my_requested_positions: mine ? mine.requested_positions : null,
      }],
      viewer: {
        // Mirrors buildEventDetailsPayload exactly: a manager who is STAFFED on
        // the event is a worker, not an admin viewer (audit 3c W1). Diverging
        // here would render the admin view to a staffed manager on manual
        // shifts only, which is precisely the bug the shared builder fixed.
        is_admin: isPrivileged && !isAssigned,
        is_assigned: isAssigned,
        is_acknowledged: false,
      },
    });
  }

  await authorizeEventRead(req, shift.proposal_id);
  const payload = await buildEventDetailsPayload(req, shift.proposal_id);
  res.json({ ...payload, shift_id: shiftId });
}));

router.get('/:shiftId/menu-print', auth, requireOnboarded, beoReadLimiter, asyncHandler(async (req, res) => {
  const shiftId = parseInt(req.params.shiftId, 10);
  const shift = await loadShift(shiftId);
  if (!shift.proposal_id) throw new NotFoundError('No menu print file for this event.');

  // Downloading is an ASSIGNED-staff action, not a browsing one: the file is
  // the deliverable a working staffer prints, and the read-ungating deliberately
  // did not extend to it.
  const isPrivileged = req.user.role === 'admin' || req.user.role === 'manager';
  if (!isPrivileged) {
    const r = await pool.query(
      `SELECT 1 FROM shift_requests sr
         JOIN shifts s ON s.id = sr.shift_id
        WHERE s.proposal_id = $1 AND sr.user_id = $2
          AND sr.status = 'approved' AND sr.dropped_at IS NULL AND s.status != 'cancelled'
        LIMIT 1`,
      [shift.proposal_id, req.user.id]
    );
    if (!r.rowCount) throw new PermissionError('Only assigned staff can download the menu file.');
  }

  const p = await pool.query('SELECT menu_print_key FROM proposals WHERE id = $1', [shift.proposal_id]);
  const key = p.rows[0] && p.rows[0].menu_print_key;
  if (!key) throw new NotFoundError('No menu print file for this event.');
  // Path-traversal guard. Keys are server-generated under menu-print/<id>/, so
  // pin BOTH the per-proposal prefix and reject any traversal segment: a prefix
  // check alone would accept `menu-print/../<anything>` and, worse, would let a
  // key belonging to one proposal be served under another.
  const expectedPrefix = `menu-print/${shift.proposal_id}/`;
  if (!key.startsWith(expectedPrefix) || key.includes('..') || key.includes('//')) {
    throw new NotFoundError('No menu print file for this event.');
  }

  const url = await getSignedUrl(key);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  let upstream;
  try {
    upstream = await fetch(url, { signal: ac.signal });
  } catch (err) {
    throw new ExternalServiceError('r2', err, 'Menu file is temporarily unavailable.');
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) {
    throw new ExternalServiceError('r2', new Error(`Upstream returned ${upstream.status}`), 'Menu file is temporarily unavailable.');
  }
  const ext = (key.split('.').pop() || 'pdf').replace(/[^a-z0-9]/gi, '');
  res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="bar-menu-${shift.proposal_id}.${ext}"`);
  // no-cache, not max-age: this URL is stable but the object behind it is
  // replaceable (a re-upload mints a new key and repoints the column). Caching
  // for an hour would hand a staffer yesterday's menu to print and carry to the
  // venue with no signal anything was wrong. ETag lets the browser revalidate
  // cheaply; the key changes on every upload, so its digest is a free correct
  // validator (the key itself stays server-side).
  res.set('Cache-Control', 'private, no-cache');
  res.set('ETag', `"${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}"`);
  // Stream, never buffer: a print-resolution file can run to the 10MB upload
  // cap, and holding it whole in memory per download is the failure mode. A
  // mid-stream R2 error can only destroy the socket (headers are gone), which
  // the client sees as a failed download — the honest outcome.
  const len = upstream.headers.get('content-length');
  if (len) res.set('Content-Length', len);
  const body = Readable.fromWeb(upstream.body);
  body.on('error', () => res.destroy());
  body.pipe(res);
}));

module.exports = router;
