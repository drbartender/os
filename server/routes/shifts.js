const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { sendSMS, normalizePhone } = require('../utils/sms');
const { geocodeAddress } = require('../utils/geocode');
const { autoAssignShift } = require('../utils/autoAssign');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');

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
router.get('/', auth, requireOnboarded, async (req, res) => {
  try {
    const isManager = req.user.role === 'admin' || req.user.role === 'manager';

    if (isManager) {
      const result = await pool.query(`
        SELECT s.*,
          u.email AS created_by_email,
          p.total_price AS proposal_total,
          p.guest_count AS proposal_guest_count,
          p.token AS proposal_token,
          p.status AS proposal_status,
          c.name AS client_name,
          c.phone AS client_phone,
          c.email AS client_email,
          (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status != 'denied') AS request_count,
          (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status = 'approved') AS approved_count
        FROM shifts s
        LEFT JOIN users u ON u.id = s.created_by
        LEFT JOIN proposals p ON p.id = s.proposal_id
        LEFT JOIN clients c ON c.id = p.client_id
        ORDER BY s.event_date ASC
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
    `, [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /shifts/my-requests — current user's shift history (with team for approved) */
router.get('/my-requests', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sr.*, s.event_name, s.event_date, s.start_time, s.end_time, s.location, s.status AS shift_status
      FROM shift_requests sr
      JOIN shifts s ON s.id = sr.shift_id
      WHERE sr.user_id = $1
      ORDER BY s.event_date DESC
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
          COALESCE(cp.preferred_name, u.first_name || ' ' || u.last_name, u.email) AS name
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /shifts/by-proposal/:proposalId — fetch shift for a specific proposal */
router.get('/by-proposal/:proposalId', auth, requireStaffing, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*,
        (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status != 'denied') AS request_count,
        (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status = 'approved') AS approved_count
      FROM shifts s
      WHERE s.proposal_id = $1
      LIMIT 1
    `, [req.params.proposalId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'No shift found for this proposal.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /shifts/:id/request — staff requests to work a shift */
router.post('/:id/request', auth, requireOnboarded, async (req, res) => {
  const { position, notes } = req.body;
  try {
    const shiftRes = await pool.query(
      "SELECT id FROM shifts WHERE id = $1 AND status = 'open'",
      [req.params.id]
    );
    if (!shiftRes.rows[0]) {
      return res.status(404).json({ error: 'Shift not available.' });
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
          SELECT s.event_name, s.event_date, cp.preferred_name
          FROM shifts s LEFT JOIN contractor_profiles cp ON cp.user_id = $2
          WHERE s.id = $1
        `, [req.params.id, req.user.id]);
        const si = shiftInfo.rows[0];
        const staffName = si?.preferred_name || req.user.email || 'A staff member';
        const eventDate = si?.event_date
          ? new Date(si.event_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
          : 'TBD';
        const clientUrl = process.env.CLIENT_URL || 'https://admin.drbartender.com';
        const tpl = emailTemplates.shiftRequestAdmin({ staffName, eventName: si?.event_name, eventDate, position: position || 'Bartender', adminUrl: `${clientUrl}/admin/shifts` });
        await sendEmail({ to: adminEmail, ...tpl });
      }
    } catch (emailErr) {
      console.error('Shift request email failed (non-blocking):', emailErr);
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /shifts/requests/:requestId — staff cancels their own request */
router.delete('/requests/:requestId', auth, async (req, res) => {
  try {
    const isManager = req.user.role === 'admin' || req.user.role === 'manager';
    const result = isManager
      ? await pool.query('DELETE FROM shift_requests WHERE id = $1 RETURNING id', [req.params.requestId])
      : await pool.query('DELETE FROM shift_requests WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.requestId, req.user.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Request not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin / Staffing manager routes ─────────────────────────────

/** POST /shifts — create a new shift */
router.post('/', auth, requireStaffing, async (req, res) => {
  const { event_name, event_date, start_time, end_time, location, positions_needed, notes,
          equipment_required, auto_assign_days_before, lat, lng } = req.body;
  if (!event_name || !event_date) {
    return res.status(400).json({ error: 'Event name and date are required.' });
  }
  try {
    const result = await pool.query(`
      INSERT INTO shifts (event_name, event_date, start_time, end_time, location, positions_needed, notes,
                          equipment_required, auto_assign_days_before, lat, lng, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *
    `, [
      event_name, event_date,
      start_time || null, end_time || null,
      location || null,
      positions_needed ? JSON.stringify(positions_needed) : '[]',
      notes || null,
      equipment_required ? JSON.stringify(equipment_required) : '[]',
      auto_assign_days_before !== null && auto_assign_days_before !== undefined ? auto_assign_days_before : null,
      lat || null, lng || null,
      req.user.id
    ]);

    // Geocode location in background if no lat/lng provided
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

    res.status(201).json(shift);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /shifts/:id — update a shift */
router.put('/:id', auth, requireStaffing, async (req, res) => {
  const { event_name, event_date, start_time, end_time, location, positions_needed, notes, status,
          equipment_required, auto_assign_days_before, setup_minutes_before, lat, lng } = req.body;
  try {
    const result = await pool.query(`
      UPDATE shifts SET
        event_name = $1, event_date = $2,
        start_time = $3, end_time = $4, location = $5,
        positions_needed = $6, notes = $7,
        status = COALESCE($8, status),
        equipment_required = $9,
        auto_assign_days_before = $10,
        lat = COALESCE($11, lat), lng = COALESCE($12, lng),
        setup_minutes_before = COALESCE($14, setup_minutes_before)
      WHERE id = $13 RETURNING *
    `, [
      event_name, event_date,
      start_time || null, end_time || null,
      location || null,
      positions_needed ? JSON.stringify(positions_needed) : '[]',
      notes || null, status || null,
      equipment_required ? JSON.stringify(equipment_required) : '[]',
      auto_assign_days_before !== null && auto_assign_days_before !== undefined ? auto_assign_days_before : null,
      lat || null, lng || null,
      req.params.id,
      setup_minutes_before !== null && setup_minutes_before !== undefined ? parseInt(setup_minutes_before, 10) : null,
    ]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Shift not found.' });

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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /shifts/:id — delete a shift */
router.delete('/:id', auth, requireStaffing, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM shifts WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Shift not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /shifts/:id/assign — admin manually assigns a staff member */
router.post('/:id/assign', auth, requireStaffing, async (req, res) => {
  const { user_id, position } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required.' });

  try {
    // Verify the shift exists
    const shiftRes = await pool.query('SELECT * FROM shifts WHERE id = $1', [req.params.id]);
    if (!shiftRes.rows[0]) return res.status(404).json({ error: 'Shift not found.' });

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
          ? new Date(shift.event_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
          : 'TBD';
        const time = shift.start_time && shift.end_time
          ? `${shift.start_time}–${shift.end_time}`
          : shift.start_time || 'TBD';
        const location = shift.location || 'TBD';
        const name = cp.preferred_name ? `, ${cp.preferred_name}` : '';

        await sendSMS({
          to: normalizePhone(cp.phone) || cp.phone,
          body: `Hey${name}! You've been assigned to ${shift.event_name} on ${date} at ${time} — ${location}. See you there! - Dr. Bartender`,
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
          ? new Date(shift.event_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
          : 'TBD';
        const tpl = emailTemplates.shiftRequestApproved({
          staffName: cpRes2.rows[0]?.preferred_name || 'there',
          eventName: shift.event_name,
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /shifts/:id/requests — get all requests for a shift */
router.get('/:id/requests', auth, requireStaffing, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sr.*, u.email, cp.preferred_name, cp.phone
      FROM shift_requests sr
      JOIN users u ON u.id = sr.user_id
      LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
      WHERE sr.shift_id = $1
      ORDER BY sr.created_at ASC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /shifts/requests/:requestId — approve or deny a request */
router.put('/requests/:requestId', auth, requireStaffing, async (req, res) => {
  const { status } = req.body;
  if (!['approved', 'denied', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  try {
    const result = await pool.query(
      'UPDATE shift_requests SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.requestId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Request not found.' });

    // SMS the staff member when their request is approved
    if (status === 'approved') {
      try {
        const infoRes = await pool.query(`
          SELECT s.event_name, s.event_date, s.start_time, s.end_time, s.location,
                 cp.phone, cp.preferred_name
          FROM shift_requests sr
          JOIN shifts s ON s.id = sr.shift_id
          LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
          WHERE sr.id = $1
        `, [req.params.requestId]);

        const info = infoRes.rows[0];
        if (info?.phone) {
          const date = info.event_date
            ? new Date(info.event_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
            : 'TBD';
          const time = info.start_time && info.end_time
            ? `${info.start_time}–${info.end_time}`
            : info.start_time || 'TBD';
          const location = info.location || 'TBD';
          const name = info.preferred_name ? `, ${info.preferred_name}` : '';

          await sendSMS({
            to: normalizePhone(info.phone) || info.phone,
            body: `Hey${name}! You've been confirmed for ${info.event_name} on ${date} at ${time} — ${location}. See you there! - Dr. Bartender`,
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
          SELECT s.event_name, s.event_date, s.start_time, s.end_time, s.location,
                 cp.preferred_name
          FROM shift_requests sr
          JOIN shifts s ON s.id = sr.shift_id
          LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
          WHERE sr.id = $1
        `, [req.params.requestId])).rows[0];
        if (staffEmail && infoForEmail) {
          const date = infoForEmail.event_date
            ? new Date(infoForEmail.event_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
            : 'TBD';
          const tpl = emailTemplates.shiftRequestApproved({
            staffName: infoForEmail.preferred_name || 'there',
            eventName: infoForEmail.event_name,
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /shifts/:id/auto-assign — run auto-assign algorithm on pending requests */
router.post('/:id/auto-assign', auth, requireStaffing, async (req, res) => {
  const { dry_run } = req.body;
  try {
    // Ensure shift has lat/lng; geocode if missing
    const shiftRes = await pool.query('SELECT id, location, lat, lng FROM shifts WHERE id = $1', [req.params.id]);
    if (!shiftRes.rows[0]) return res.status(404).json({ error: 'Shift not found.' });

    const shift = shiftRes.rows[0];
    if (shift.lat === null && shift.lng === null && shift.location) {
      const coords = await geocodeAddress(shift.location);
      if (coords) {
        await pool.query('UPDATE shifts SET lat = $1, lng = $2 WHERE id = $3', [coords.lat, coords.lng, shift.id]);
      }
    }

    const result = await autoAssignShift(req.params.id, { dryRun: !!dry_run });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
