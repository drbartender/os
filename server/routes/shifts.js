const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { sendSMS } = require('../utils/sms');

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
          (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status != 'denied') AS request_count
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

/** GET /shifts/my-requests — current user's shift history */
router.get('/my-requests', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sr.*, s.event_name, s.event_date, s.start_time, s.end_time, s.location, s.status AS shift_status
      FROM shift_requests sr
      JOIN shifts s ON s.id = sr.shift_id
      WHERE sr.user_id = $1
      ORDER BY s.event_date DESC
    `, [req.user.id]);
    res.json(result.rows);
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
  const { event_name, event_date, start_time, end_time, location, positions_needed, notes } = req.body;
  if (!event_name || !event_date) {
    return res.status(400).json({ error: 'Event name and date are required.' });
  }
  try {
    const result = await pool.query(`
      INSERT INTO shifts (event_name, event_date, start_time, end_time, location, positions_needed, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
    `, [
      event_name, event_date,
      start_time || null, end_time || null,
      location || null,
      positions_needed ? JSON.stringify(positions_needed) : '[]',
      notes || null,
      req.user.id
    ]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /shifts/:id — update a shift */
router.put('/:id', auth, requireStaffing, async (req, res) => {
  const { event_name, event_date, start_time, end_time, location, positions_needed, notes, status } = req.body;
  try {
    const result = await pool.query(`
      UPDATE shifts SET
        event_name = $1, event_date = $2,
        start_time = $3, end_time = $4, location = $5,
        positions_needed = $6, notes = $7,
        status = COALESCE($8, status)
      WHERE id = $9 RETURNING *
    `, [
      event_name, event_date,
      start_time || null, end_time || null,
      location || null,
      positions_needed ? JSON.stringify(positions_needed) : '[]',
      notes || null, status || null,
      req.params.id
    ]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Shift not found.' });
    res.json(result.rows[0]);
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
            to: info.phone,
            body: `Hey${name}! You've been confirmed for ${info.event_name} on ${date} at ${time} — ${location}. See you there! - Dr. Bartender`,
          });
        }
      } catch (smsErr) {
        console.error('SMS notification failed (non-blocking):', smsErr.message);
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
