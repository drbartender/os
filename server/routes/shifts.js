const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { sendSMS, normalizePhone } = require('../utils/sms');
const { geocodeAddress } = require('../utils/geocode');
const { autoAssignShift } = require('../utils/autoAssign');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');
const { getEventTypeLabel } = require('../utils/eventTypes');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError, PermissionError } = require('../utils/errors');
const { ADMIN_URL } = require('../utils/urls');

const router = express.Router();

// ─── Permission helpers ────────────────────────────────────────────

/** Admin or manager with can_staff permission */
function requireStaffing(req, res, next) {
  if (req.user.role === 'admin') return next();
  if (req.user.role === 'manager' && req.user.can_staff) return next();
  return res.status(403).json({ error: 'Staffing access required.' });
}

/** Staff who have completed onboarding (or admin/manager) */
function requireOnboarded(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'manager') return next();
  const allowed = ['submitted', 'reviewed', 'approved'];
  if (allowed.includes(req.user.onboarding_status)) return next();
  return res.status(403).json({ error: 'Complete your onboarding to access shifts.' });
}

// ─── Staff-facing routes ──────────────────────────────────────────

/** GET /shifts — open upcoming shifts for staff; all shifts for admin/manager */
router.get('/', auth, requireOnboarded, asyncHandler(async (req, res) => {
  const isManager = req.user.role === 'admin' || req.user.role === 'manager';

  if (isManager) {
    const result = await pool.query(`
      SELECT s.*,
        u.email AS created_by_email,
        p.total_price AS proposal_total,
        p.amount_paid AS proposal_amount_paid,
        COALESCE(p.guest_count, s.guest_count) AS proposal_guest_count,
        p.token AS proposal_token,
        p.status AS proposal_status,
        COALESCE(c.name, s.client_name) AS client_name,
        COALESCE(c.phone, s.client_phone) AS client_phone,
        COALESCE(c.email, s.client_email) AS client_email,
        (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status != 'denied') AS request_count,
        (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status = 'approved') AS approved_count
      FROM shifts s
      LEFT JOIN users u ON u.id = s.created_by
      LEFT JOIN proposals p ON p.id = s.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      ORDER BY s.event_date ASC
      LIMIT 500
    `);
    return res.json(result.rows);
  }

  // Staff: only open upcoming shifts, with their own request status
  const result = await pool.query(`
    SELECT s.*,
      sr.id   AS my_request_id,
      sr.status AS my_request_status,
      sr.position AS my_request_position
    FROM shifts s
    LEFT JOIN shift_requests sr ON sr.shift_id = s.id AND sr.user_id = $1
    WHERE s.status = 'open' AND s.event_date >= CURRENT_DATE
    ORDER BY s.event_date ASC
    LIMIT 500
  `, [req.user.id]);
  res.json(result.rows);
}));

/** GET /shifts/unstaffed-upcoming — admin-facing list of upcoming shifts that
 *  still need staffing. Smaller than the full /shifts dump and pre-filtered
 *  server-side so the AssignToEventModal can render without fetching ~500 rows.
 *  Uses the same `positions_needed::jsonb` pattern as admin.js badge-counts;
 *  the schema migration normalized every row to a valid JSON array, so the
 *  cast is safe in practice. */
router.get('/unstaffed-upcoming', auth, requireStaffing, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT s.id, s.event_date, s.start_time, s.end_time, s.location, s.guest_count,
           s.event_type, s.event_type_custom, s.positions_needed, s.proposal_id,
           COALESCE(c.name, s.client_name) AS client_name,
           (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status != 'denied') AS request_count,
           (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status = 'approved') AS approved_count
    FROM shifts s
    LEFT JOIN proposals p ON p.id = s.proposal_id
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE s.status = 'open'
      AND s.event_date >= CURRENT_DATE
      AND jsonb_typeof(s.positions_needed::jsonb) = 'array'
      AND (SELECT COUNT(*) FROM shift_requests sr2 WHERE sr2.shift_id = s.id AND sr2.status = 'approved')
          < jsonb_array_length(s.positions_needed::jsonb)
    ORDER BY s.event_date ASC, s.start_time ASC
    LIMIT 200
  `);
  res.json(result.rows);
}));

/** GET /shifts/user/:userId/events — event history for a user (staff or admin) */
router.get('/user/:userId/events', auth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (isNaN(userId)) throw new ValidationError({ userId: 'Invalid user ID.' });

  // Staff can only view their own events; admin/manager can view anyone's
  const isManager = req.user.role === 'admin' || req.user.role === 'manager';
  if (!isManager && req.user.id !== userId) {
    throw new PermissionError('Access denied.');
  }

  const result = await pool.query(`
    SELECT s.id, s.event_date, s.start_time, s.end_time, s.location,
           s.event_type, s.event_type_custom,
           sr.position, sr.status AS request_status,
           p.event_type AS proposal_event_type,
           p.event_type_custom AS proposal_event_type_custom,
           COALESCE(c.name, s.client_name) AS client_name,
           COALESCE(p.guest_count, s.guest_count) AS guest_count
    FROM shift_requests sr
    JOIN shifts s ON s.id = sr.shift_id
    LEFT JOIN proposals p ON p.id = s.proposal_id
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE sr.user_id = $1 AND sr.status = 'approved'
    ORDER BY s.event_date DESC
    LIMIT 500
  `, [userId]);

  const today = new Date().toISOString().slice(0, 10);
  const getDateStr = (d) => {
    if (!d) return null;
    if (typeof d === 'string') return d.slice(0, 10);
    return d.toISOString().slice(0, 10);
  };
  const upcoming = result.rows
    .filter(r => { const ds = getDateStr(r.event_date); return ds && ds >= today; })
    .sort((a, b) => new Date(a.event_date) - new Date(b.event_date));
  const past = result.rows
    .filter(r => { const ds = getDateStr(r.event_date); return !ds || ds < today; });

  res.json({ upcoming, past });
}));

/** GET /shifts/my-requests — current user's shift history (with team for approved) */
router.get('/my-requests', auth, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT sr.*, s.event_type, s.event_type_custom, s.client_name,
           s.event_date, s.start_time, s.end_time, s.location, s.status AS shift_status
    FROM shift_requests sr
    JOIN shifts s ON s.id = sr.shift_id
    WHERE sr.user_id = $1
    ORDER BY s.event_date DESC
    LIMIT 500
  `, [req.user.id]);

  const requests = result.rows;

  // Fetch approved teammates for shifts where this user is approved
  const approvedShiftIds = requests
    .filter(r => r.status === 'approved')
    .map(r => r.shift_id);

  let teamsMap = new Map();
  if (approvedShiftIds.length > 0) {
    const teamRes = await pool.query(`
      SELECT sr.shift_id, sr.user_id, sr.position,
        COALESCE(cp.preferred_name, u.email) AS name
      FROM shift_requests sr
      JOIN users u ON u.id = sr.user_id
      LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
      WHERE sr.shift_id = ANY($1) AND sr.status = 'approved'
      ORDER BY name ASC
    `, [approvedShiftIds]);

    for (const row of teamRes.rows) {
      if (!teamsMap.has(row.shift_id)) teamsMap.set(row.shift_id, []);
      teamsMap.get(row.shift_id).push(row);
    }
  }

  // Attach team to each request, moving current user to top
  const enriched = requests.map(r => {
    const team = teamsMap.get(r.shift_id) || [];
    // Move current user to top of list
    const sorted = [...team];
    const myIdx = sorted.findIndex(t => t.user_id === req.user.id);
    if (myIdx > 0) {
      const [me] = sorted.splice(myIdx, 1);
      sorted.unshift(me);
    }
    return { ...r, team: r.status === 'approved' ? sorted : [] };
  });

  res.json(enriched);
}));

/** GET /shifts/by-proposal/:proposalId — return every shift attached to a
 *  proposal as an array. A single proposal can spawn multiple shifts
 *  (e.g. multi-day events). Avoids the EventDetailPage shipping the full
 *  /shifts list to the browser just to filter for one proposal.
 *  LIMIT 100 is defensive — a single event with >100 shifts is unheard of,
 *  but it bounds the worst case if a future bug ever creates a runaway loop. */
router.get('/by-proposal/:proposalId', auth, requireStaffing, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT s.*,
      (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status != 'denied') AS request_count,
      (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status = 'approved') AS approved_count
    FROM shifts s
    WHERE s.proposal_id = $1
    ORDER BY s.event_date ASC, s.start_time ASC, s.id ASC
    LIMIT 100
  `, [req.params.proposalId]);
  res.json(result.rows);
}));

/** GET /shifts/detail/:id — single shift details (admin/manager only) */
router.get('/detail/:id', auth, requireStaffing, asyncHandler(async (req, res) => {
  // Shift and its requests are independent lookups — Promise.all saves a round-trip.
  const [result, reqResult] = await Promise.all([
    pool.query(`
      SELECT s.*,
        COALESCE(c.name, s.client_name) AS client_name,
        COALESCE(c.phone, s.client_phone) AS client_phone,
        COALESCE(c.email, s.client_email) AS client_email,
        p.total_price AS proposal_total,
        p.token AS proposal_token,
        (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status != 'denied') AS request_count,
        (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status = 'approved') AS approved_count
      FROM shifts s
      LEFT JOIN proposals p ON p.id = s.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      WHERE s.id = $1
    `, [req.params.id]),
    pool.query(`
      SELECT sr.*,
        COALESCE(cp.preferred_name, u.email) AS staff_name,
        u.email AS staff_email,
        cp.city AS staff_city
      FROM shift_requests sr
      JOIN users u ON u.id = sr.user_id
      LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
      WHERE sr.shift_id = $1
      ORDER BY sr.status ASC, sr.created_at ASC
    `, [req.params.id]),
  ]);
  if (!result.rows[0]) throw new NotFoundError('Shift not found.');

  res.json({ shift: result.rows[0], requests: reqResult.rows });
}));

/** POST /shifts/:id/request — staff requests to work a shift */
router.post('/:id/request', auth, requireOnboarded, asyncHandler(async (req, res) => {
  const { position, notes } = req.body;
  const shiftRes = await pool.query(
    "SELECT id FROM shifts WHERE id = $1 AND status = 'open'",
    [req.params.id]
  );
  if (!shiftRes.rows[0]) {
    throw new NotFoundError('Shift not available.');
  }
  const result = await pool.query(`
    INSERT INTO shift_requests (shift_id, user_id, position, notes)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (shift_id, user_id) DO UPDATE SET position = $3, notes = $4, status = 'pending'
    RETURNING *
  `, [req.params.id, req.user.id, position || null, notes || null]);

  // Notify admin of new shift request (non-blocking)
  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      const shiftInfo = await pool.query(`
        SELECT s.event_type, s.event_type_custom, s.event_date, cp.preferred_name
        FROM shifts s LEFT JOIN contractor_profiles cp ON cp.user_id = $2
        WHERE s.id = $1
      `, [req.params.id, req.user.id]);
      const si = shiftInfo.rows[0];
      const staffName = si?.preferred_name || req.user.email || 'A staff member';
      const eventDate = si?.event_date
        ? new Date(si.event_date).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })
        : 'TBD';
      const tpl = emailTemplates.shiftRequestAdmin({
        staffName,
        eventTypeLabel: getEventTypeLabel({ event_type: si?.event_type, event_type_custom: si?.event_type_custom }),
        eventDate,
        position: position || 'Bartender',
        adminUrl: `${ADMIN_URL}/staffing`,
      });
      await sendEmail({ to: adminEmail, ...tpl });
    }
  } catch (emailErr) {
    console.error('Shift request email failed (non-blocking):', emailErr);
  }

  res.status(201).json(result.rows[0]);
}));

/** DELETE /shifts/requests/:requestId — staff cancels their own request */
router.delete('/requests/:requestId', auth, asyncHandler(async (req, res) => {
  const isManager = req.user.role === 'admin' || req.user.role === 'manager';
  const result = isManager
    ? await pool.query('DELETE FROM shift_requests WHERE id = $1 RETURNING id', [req.params.requestId])
    : await pool.query('DELETE FROM shift_requests WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.requestId, req.user.id]);
  if (!result.rows[0]) throw new NotFoundError('Request not found.');
  res.json({ success: true });
}));

// ─── Admin / Staffing manager routes ─────────────────────────────

/** POST /shifts — create a new shift */
router.post('/', auth, requireStaffing, asyncHandler(async (req, res) => {
  const { event_type, event_type_custom, event_date, start_time, end_time, location, positions_needed, notes,
          equipment_required, auto_assign_days_before, lat, lng,
          client_name, client_email, client_phone, guest_count, event_duration_hours } = req.body;
  if (!event_date) {
    throw new ValidationError({ event_date: 'Event date is required.' });
  }

  const pgClient = await pool.connect();
  let shift;
  try {
    await pgClient.query('BEGIN');

    // 1. Create or find client record
    let clientId = null;
    if (client_name) {
      const existing = client_email
        ? await pgClient.query('SELECT id FROM clients WHERE email = $1 LIMIT 1', [client_email])
        : { rows: [] };
      if (existing.rows[0]) {
        clientId = existing.rows[0].id;
      } else {
        const clientRes = await pgClient.query(
          'INSERT INTO clients (name, email, phone, source) VALUES ($1, $2, $3, $4) RETURNING id',
          [client_name, client_email || null, client_phone || null, 'direct']
        );
        clientId = clientRes.rows[0].id;
      }
    }

    // 2. Create a proposal record so the full event detail page works
    const guestCountInt = guest_count ? parseInt(guest_count, 10) : 50;
    const durationFloat = event_duration_hours ? parseFloat(event_duration_hours) : 4;
    const proposalRes = await pgClient.query(`
      INSERT INTO proposals (client_id, event_type, event_type_custom, event_date, event_start_time,
                             event_duration_hours, event_location, guest_count,
                             status, pricing_snapshot, total_price, created_by, admin_notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed', '{}', 0, $9, $10) RETURNING *
    `, [
      clientId, event_type || null, event_type_custom || null,
      event_date, start_time || null,
      durationFloat, location || null, guestCountInt,
      req.user.id, 'Manually created event — no contract or payment on file.'
    ]);
    const proposal = proposalRes.rows[0];

    // 3. Create the shift linked to the proposal
    const shiftRes = await pgClient.query(`
      INSERT INTO shifts (event_type, event_type_custom, event_date, start_time, end_time, location, positions_needed, notes,
                          equipment_required, auto_assign_days_before, lat, lng, created_by, proposal_id,
                          client_name, client_email, client_phone, guest_count, event_duration_hours)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *
    `, [
      event_type || null, event_type_custom || null,
      event_date,
      start_time || null, end_time || null,
      location || null,
      positions_needed ? JSON.stringify(positions_needed) : '[]',
      notes || null,
      equipment_required ? JSON.stringify(equipment_required) : '[]',
      auto_assign_days_before !== null && auto_assign_days_before !== undefined ? auto_assign_days_before : null,
      lat || null, lng || null,
      req.user.id, proposal.id,
      client_name || null, client_email || null, client_phone || null,
      guestCountInt, durationFloat
    ]);

    await pgClient.query('COMMIT');
    shift = shiftRes.rows[0];
  } catch (err) {
    try { await pgClient.query('ROLLBACK'); } catch (_e) { /* already rolled back */ }
    throw err;
  } finally {
    pgClient.release();
  }

  // Geocode location in background
  if (!lat && !lng && location) {
    geocodeAddress(location)
      .then(coords => {
        if (coords) {
          pool.query('UPDATE shifts SET lat = $1, lng = $2 WHERE id = $3', [coords.lat, coords.lng, shift.id]);
        }
      })
      .catch(err => console.error('[Shifts] Geocode error:', err.message));
  }

  res.status(201).json(shift);
}));

/** PUT /shifts/:id — update a shift */
router.put('/:id', auth, requireStaffing, asyncHandler(async (req, res) => {
  const { event_type, event_type_custom, event_date, start_time, end_time, location, positions_needed, notes, status,
          equipment_required, auto_assign_days_before, setup_minutes_before, lat, lng,
          client_name, client_email, client_phone, guest_count, event_duration_hours } = req.body;
  // PATCH semantics: missing fields preserve existing values via COALESCE.
  // The previous version sent '[]' for omitted positions_needed /
  // equipment_required, silently wiping staffing + gear when the admin only
  // edited a date or note. Pass null for omitted JSONB fields so COALESCE
  // keeps the prior row.
  const result = await pool.query(`
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
      event_duration_hours = COALESCE($20, event_duration_hours)
    WHERE id = $14 RETURNING *
  `, [
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
  ]);
  if (!result.rows[0]) throw new NotFoundError('Shift not found.');

  // Re-geocode if location changed and no explicit lat/lng
  const shift = result.rows[0];
  if (!lat && !lng && location) {
    geocodeAddress(location)
      .then(coords => {
        if (coords) {
          pool.query('UPDATE shifts SET lat = $1, lng = $2 WHERE id = $3', [coords.lat, coords.lng, shift.id]);
        }
      })
      .catch(err => console.error('[Shifts] Geocode error:', err.message));
  }

  res.json(shift);
}));

/** DELETE /shifts/:id — delete a shift */
router.delete('/:id', auth, requireStaffing, asyncHandler(async (req, res) => {
  const result = await pool.query('DELETE FROM shifts WHERE id = $1 RETURNING id', [req.params.id]);
  if (!result.rows[0]) throw new NotFoundError('Shift not found.');
  res.json({ success: true });
}));

/** POST /shifts/:id/assign — admin manually assigns a staff member */
router.post('/:id/assign', auth, requireStaffing, asyncHandler(async (req, res) => {
  const { user_id, position } = req.body;
  if (!user_id) throw new ValidationError({ user_id: 'user_id is required.' });

  // Verify the shift exists
  const shiftRes = await pool.query('SELECT * FROM shifts WHERE id = $1', [req.params.id]);
  if (!shiftRes.rows[0]) throw new NotFoundError('Shift not found.');

  // Insert or update the shift request as approved
  const result = await pool.query(`
    INSERT INTO shift_requests (shift_id, user_id, position, status)
    VALUES ($1, $2, $3, 'approved')
    ON CONFLICT (shift_id, user_id) DO UPDATE SET status = 'approved', position = $3, updated_at = NOW()
    RETURNING *
  `, [req.params.id, user_id, position || 'Bartender']);

  const request = result.rows[0];
  const shift = shiftRes.rows[0];

  // Send SMS notification (non-blocking)
  try {
    const cpRes = await pool.query(
      'SELECT preferred_name, phone FROM contractor_profiles WHERE user_id = $1',
      [user_id]
    );
    const cp = cpRes.rows[0];
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

      await sendSMS({
        to: normalizePhone(cp.phone) || cp.phone,
        body: `Hey${name}! You've been assigned to the ${ctx} on ${date} at ${time} — ${location}. See you there! - Dr. Bartender`,
      });
    }
  } catch (smsErr) {
    console.error('SMS notification failed (non-blocking):', smsErr.message);
  }

  // Send email notification (non-blocking)
  try {
    const userRes = await pool.query('SELECT email FROM users WHERE id = $1', [user_id]);
    const staffEmail = userRes.rows[0]?.email;
    const cpRes2 = await pool.query(
      'SELECT preferred_name FROM contractor_profiles WHERE user_id = $1',
      [user_id]
    );
    if (staffEmail) {
      const date = shift.event_date
        ? new Date(shift.event_date).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })
        : 'TBD';
      const tpl = emailTemplates.shiftRequestApproved({
        staffName: cpRes2.rows[0]?.preferred_name || 'there',
        eventTypeLabel: getEventTypeLabel({ event_type: shift.event_type, event_type_custom: shift.event_type_custom }),
        eventDate: date,
        startTime: shift.start_time || 'TBD',
        endTime: shift.end_time || 'TBD',
        location: shift.location || 'TBD',
      });
      await sendEmail({ to: staffEmail, ...tpl });
    }
  } catch (emailErr) {
    console.error('Staff assignment email failed (non-blocking):', emailErr.message);
  }

  res.status(201).json(request);
}));

/** GET /shifts/:id/requests — get all requests for a shift */
router.get('/:id/requests', auth, requireStaffing, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT sr.*, u.email, cp.preferred_name, cp.phone
    FROM shift_requests sr
    JOIN users u ON u.id = sr.user_id
    LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
    WHERE sr.shift_id = $1
    ORDER BY sr.created_at ASC
    LIMIT 500
  `, [req.params.id]);
  res.json(result.rows);
}));

/** PUT /shifts/requests/:requestId — approve or deny a request */
router.put('/requests/:requestId', auth, requireStaffing, asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['approved', 'denied', 'pending'].includes(status)) {
    throw new ValidationError({ status: 'Invalid status.' });
  }
  const result = await pool.query(
    'UPDATE shift_requests SET status = $1 WHERE id = $2 RETURNING *',
    [status, req.params.requestId]
  );
  if (!result.rows[0]) throw new NotFoundError('Request not found.');

  // SMS the staff member when their request is approved
  if (status === 'approved') {
    try {
      const infoRes = await pool.query(`
        SELECT s.event_type, s.event_type_custom, s.client_name,
               s.event_date, s.start_time, s.end_time, s.location,
               cp.phone, cp.preferred_name
        FROM shift_requests sr
        JOIN shifts s ON s.id = sr.shift_id
        LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
        WHERE sr.id = $1
      `, [req.params.requestId]);

      const info = infoRes.rows[0];
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

        await sendSMS({
          to: normalizePhone(info.phone) || info.phone,
          body: `Hey${name}! You've been confirmed for the ${ctx} on ${date} at ${time} — ${location}. See you there! - Dr. Bartender`,
        });
      }
    } catch (smsErr) {
      console.error('SMS notification failed (non-blocking):', smsErr.message);
    }

    // Email the staff member (non-blocking)
    try {
      const userRes = await pool.query('SELECT email FROM users WHERE id = $1', [result.rows[0].user_id]);
      const staffEmail = userRes.rows[0]?.email;
      const infoForEmail = (await pool.query(`
        SELECT s.event_type, s.event_type_custom,
               s.event_date, s.start_time, s.end_time, s.location,
               cp.preferred_name
        FROM shift_requests sr
        JOIN shifts s ON s.id = sr.shift_id
        LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
        WHERE sr.id = $1
      `, [req.params.requestId])).rows[0];
      if (staffEmail && infoForEmail) {
        const date = infoForEmail.event_date
          ? new Date(infoForEmail.event_date).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })
          : 'TBD';
        const tpl = emailTemplates.shiftRequestApproved({
          staffName: infoForEmail.preferred_name || 'there',
          eventTypeLabel: getEventTypeLabel({ event_type: infoForEmail.event_type, event_type_custom: infoForEmail.event_type_custom }),
          eventDate: date,
          startTime: infoForEmail.start_time || 'TBD',
          endTime: infoForEmail.end_time || 'TBD',
          location: infoForEmail.location || 'TBD',
        });
        await sendEmail({ to: staffEmail, ...tpl });
      }
    } catch (emailErr) {
      console.error('Shift approval email failed (non-blocking):', emailErr);
    }
  }

  res.json(result.rows[0]);
}));

/** POST /shifts/:id/auto-assign — run auto-assign algorithm on pending requests */
router.post('/:id/auto-assign', auth, requireStaffing, asyncHandler(async (req, res) => {
  const { dry_run } = req.body;
  // Ensure shift has lat/lng; geocode if missing
  const shiftRes = await pool.query('SELECT id, location, lat, lng FROM shifts WHERE id = $1', [req.params.id]);
  if (!shiftRes.rows[0]) throw new NotFoundError('Shift not found.');

  const shift = shiftRes.rows[0];
  if (shift.lat === null && shift.lng === null && shift.location) {
    const coords = await geocodeAddress(shift.location);
    if (coords) {
      await pool.query('UPDATE shifts SET lat = $1, lng = $2 WHERE id = $3', [coords.lat, coords.lng, shift.id]);
    }
  }

  const result = await autoAssignShift(req.params.id, { dryRun: !!dry_run });
  res.json(result);
}));

module.exports = router;
