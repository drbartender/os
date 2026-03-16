const express = require('express');
const { pool } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

// ─── Onboarding Users (paginated) ─────────────────────────────────

router.get('/users', auth, adminOnly, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const [usersResult, countResult] = await Promise.all([
      pool.query(`
        SELECT
          u.id, u.email, u.role, u.onboarding_status, u.notifications_opt_in, u.created_at, u.updated_at,
          op.account_created, op.welcome_viewed, op.field_guide_completed, op.agreement_completed,
          op.contractor_profile_completed, op.payday_protocols_completed, op.onboarding_completed,
          op.last_completed_step, op.updated_at as progress_updated_at,
          cp.preferred_name, cp.phone as profile_phone,
          ag.full_name as signed_name, ag.signed_at
        FROM users u
        LEFT JOIN onboarding_progress op ON op.user_id = u.id
        LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
        LEFT JOIN agreements ag ON ag.user_id = u.id
        WHERE u.role IN ('staff', 'manager')
          AND u.onboarding_status IN ('hired','in_progress','submitted','reviewed','approved','deactivated')
        ORDER BY u.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]),
      pool.query(`SELECT COUNT(*) FROM users WHERE role IN ('staff', 'manager') AND onboarding_status IN ('hired','in_progress','submitted','reviewed','approved','deactivated')`)
    ]);

    res.json({
      users: usersResult.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
      limit
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single user record (full detail — includes application data)
router.get('/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const userId = req.params.id;

    const [userRes, progressRes, profileRes, agreementRes, paymentRes, appRes] = await Promise.all([
      pool.query('SELECT id, email, role, onboarding_status, notifications_opt_in, can_hire, can_staff, created_at, updated_at FROM users WHERE id = $1', [userId]),
      pool.query('SELECT * FROM onboarding_progress WHERE user_id = $1', [userId]),
      pool.query('SELECT * FROM contractor_profiles WHERE user_id = $1', [userId]),
      pool.query('SELECT * FROM agreements WHERE user_id = $1', [userId]),
      pool.query('SELECT * FROM payment_profiles WHERE user_id = $1', [userId]),
      pool.query('SELECT * FROM applications WHERE user_id = $1', [userId])
    ]);

    if (!userRes.rows[0]) return res.status(404).json({ error: 'User not found' });

    res.json({
      user: userRes.rows[0],
      progress: progressRes.rows[0] || {},
      profile: profileRes.rows[0] || {},
      agreement: agreementRes.rows[0] || {},
      payment: paymentRes.rows[0] || {},
      application: appRes.rows[0] || {}
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user status (expanded for application + onboarding statuses)
router.put('/users/:id/status', auth, adminOnly, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['in_progress', 'applied', 'interviewing', 'hired', 'rejected', 'submitted', 'reviewed', 'approved', 'deactivated'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  try {
    // Get current status before changing (for the audit log)
    const currentRes = await pool.query(
      "SELECT onboarding_status FROM users WHERE id=$1 AND role IN ('staff','manager')",
      [req.params.id]
    );
    if (!currentRes.rows[0]) return res.status(404).json({ error: 'User not found' });
    const oldStatus = currentRes.rows[0].onboarding_status;

    const result = await pool.query(
      "UPDATE users SET onboarding_status=$1 WHERE id=$2 AND role IN ('staff','manager') RETURNING id, email, onboarding_status",
      [status, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });

    // When hiring, ensure onboarding progress record exists
    if (status === 'hired') {
      const progressExists = await pool.query('SELECT id FROM onboarding_progress WHERE user_id = $1', [req.params.id]);
      if (!progressExists.rows[0]) {
        await pool.query(
          'INSERT INTO onboarding_progress (user_id, account_created) VALUES ($1, true)',
          [req.params.id]
        );
      }
    }

    // Log status change as a system note in the interview_notes table
    if (oldStatus !== status) {
      const toLabel = s => (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      pool.query(
        `INSERT INTO interview_notes (user_id, admin_id, note, note_type) VALUES ($1, $2, $3, 'status_change')`,
        [req.params.id, req.user.id, `${toLabel(oldStatus)} → ${toLabel(status)}`]
      ).catch(err => console.error('Status change log failed:', err));
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user profile (admin editing contractor info)
router.put('/users/:id/profile', auth, adminOnly, async (req, res) => {
  const userId = req.params.id;
  const {
    preferred_name, phone, email: profileEmail, birth_month, birth_day, birth_year,
    city, state, street_address, zip_code, travel_distance, reliable_transportation,
    equipment_portable_bar, equipment_cooler, equipment_table_with_spandex,
    equipment_none_but_open, equipment_no_space,
    emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
    preferred_payment_method, payment_username, routing_number, account_number,
  } = req.body;

  try {
    // Upsert contractor profile
    await pool.query(`
      INSERT INTO contractor_profiles (
        user_id, preferred_name, phone, email, birth_month, birth_day, birth_year,
        city, state, street_address, zip_code, travel_distance, reliable_transportation,
        equipment_portable_bar, equipment_cooler, equipment_table_with_spandex,
        equipment_none_but_open, equipment_no_space,
        emergency_contact_name, emergency_contact_phone, emergency_contact_relationship
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT (user_id) DO UPDATE SET
        preferred_name=$2, phone=$3, email=$4, birth_month=$5, birth_day=$6, birth_year=$7,
        city=$8, state=$9, street_address=$10, zip_code=$11, travel_distance=$12, reliable_transportation=$13,
        equipment_portable_bar=$14, equipment_cooler=$15, equipment_table_with_spandex=$16,
        equipment_none_but_open=$17, equipment_no_space=$18,
        emergency_contact_name=$19, emergency_contact_phone=$20, emergency_contact_relationship=$21
    `, [
      userId, preferred_name || null, phone || null, profileEmail || null,
      birth_month || null, birth_day || null, birth_year || null,
      city || null, state || null, street_address || null, zip_code || null,
      travel_distance || null, reliable_transportation || null,
      equipment_portable_bar || false, equipment_cooler || false, equipment_table_with_spandex || false,
      equipment_none_but_open || false, equipment_no_space || false,
      emergency_contact_name || null, emergency_contact_phone || null, emergency_contact_relationship || null,
    ]);

    // Upsert payment profile
    await pool.query(`
      INSERT INTO payment_profiles (user_id, preferred_payment_method, payment_username, routing_number, account_number)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (user_id) DO UPDATE SET
        preferred_payment_method=$2, payment_username=$3, routing_number=$4, account_number=$5
    `, [userId, preferred_payment_method || null, payment_username || null, routing_number || null, account_number || null]);

    // Return updated data
    const [profileRes, paymentRes] = await Promise.all([
      pool.query('SELECT * FROM contractor_profiles WHERE user_id = $1', [userId]),
      pool.query('SELECT * FROM payment_profiles WHERE user_id = $1', [userId]),
    ]);

    res.json({ profile: profileRes.rows[0] || {}, payment: paymentRes.rows[0] || {} });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user permissions (role + flags)
router.put('/users/:id/permissions', auth, adminOnly, async (req, res) => {
  const { role, can_hire, can_staff } = req.body;
  const validRoles = ['staff', 'manager'];
  if (role && !validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });

  try {
    const current = await pool.query('SELECT id, role FROM users WHERE id = $1', [req.params.id]);
    if (!current.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (current.rows[0].role === 'admin') return res.status(400).json({ error: 'Cannot change admin permissions.' });

    const newRole = role || current.rows[0].role;
    const result = await pool.query(
      `UPDATE users SET role = $1, can_hire = $2, can_staff = $3
       WHERE id = $4
       RETURNING id, email, role, can_hire, can_staff`,
      [newRole, can_hire ?? false, can_staff ?? false, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Applications ─────────────────────────────────────────────────

// List all applications (paginated)
// ?archived=true returns only rejected/archived applicants
// Default returns all active (non-rejected) applicants
router.get('/applications', auth, adminOnly, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const archived = req.query.archived === 'true';

    // Status filter: archived view shows only rejected; default excludes rejected
    const statusClause = archived
      ? "u.onboarding_status = 'rejected'"
      : "u.onboarding_status != 'rejected'";

    const [appsResult, countResult, statusCountsResult, archivedCountResult] = await Promise.all([
      pool.query(`
        SELECT
          u.id, u.email, u.onboarding_status, u.created_at,
          a.full_name, a.phone, a.city, a.state, a.positions_interested,
          a.has_bartending_experience, a.bartending_years, a.setup_confidence,
          a.headshot_file_url, a.created_at as applied_at,
          a.travel_distance, a.available_saturdays,
          a.reliable_transportation, a.comfortable_working_alone
        FROM users u
        INNER JOIN applications a ON a.user_id = u.id
        WHERE u.role IN ('staff', 'manager') AND ${statusClause}
        ORDER BY a.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]),
      pool.query(
        `SELECT COUNT(*) FROM applications a INNER JOIN users u ON u.id = a.user_id WHERE u.role IN ('staff', 'manager') AND ${statusClause}`
      ),
      // Active status counts (always excludes rejected)
      pool.query(`
        SELECT u.onboarding_status, COUNT(*) as count
        FROM users u INNER JOIN applications a ON a.user_id = u.id
        WHERE u.role IN ('staff', 'manager') AND u.onboarding_status != 'rejected'
        GROUP BY u.onboarding_status
      `),
      // Archived (rejected) count — always returned regardless of view
      pool.query(
        `SELECT COUNT(*) FROM applications a INNER JOIN users u ON u.id = a.user_id WHERE u.role IN ('staff', 'manager') AND u.onboarding_status = 'rejected'`
      )
    ]);

    // Build statusCounts for the active tabs (all = sum of non-rejected)
    const statusCounts = {};
    let activeTotal = 0;
    statusCountsResult.rows.forEach(r => {
      statusCounts[r.onboarding_status] = parseInt(r.count);
      activeTotal += parseInt(r.count);
    });
    statusCounts.all = activeTotal;

    const archivedCount = parseInt(archivedCountResult.rows[0].count);

    res.json({
      applications: appsResult.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
      limit,
      statusCounts,
      archivedCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single application detail with interview notes
router.get('/applications/:userId', auth, adminOnly, async (req, res) => {
  try {
    const userId = req.params.userId;

    const [userRes, appRes, notesRes] = await Promise.all([
      pool.query('SELECT id, email, role, onboarding_status, created_at FROM users WHERE id = $1', [userId]),
      pool.query('SELECT * FROM applications WHERE user_id = $1', [userId]),
      pool.query(`
        SELECT n.*, u.email as admin_email
        FROM interview_notes n
        LEFT JOIN users u ON u.id = n.admin_id
        WHERE n.user_id = $1
        ORDER BY n.created_at DESC
      `, [userId])
    ]);

    if (!userRes.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (!appRes.rows[0]) return res.status(404).json({ error: 'Application not found' });

    res.json({
      user: userRes.rows[0],
      application: appRes.rows[0],
      notes: notesRes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Active Staff ─────────────────────────────────────────────────

router.get('/active-staff', auth, async (req, res) => {
  // Admin or managers with can_staff
  if (req.user.role !== 'admin' && !(req.user.role === 'manager' && req.user.can_staff)) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const [staffResult, countResult] = await Promise.all([
      pool.query(`
        SELECT
          u.id, u.email, u.role, u.onboarding_status, u.created_at,
          cp.preferred_name, cp.phone, cp.city, cp.state,
          cp.travel_distance, cp.reliable_transportation,
          cp.equipment_portable_bar, cp.equipment_cooler, cp.equipment_table_with_spandex,
          a.positions_interested,
          op.onboarding_completed, ag.signed_at
        FROM users u
        JOIN onboarding_progress op ON op.user_id = u.id
        LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
        LEFT JOIN applications a ON a.user_id = u.id
        LEFT JOIN agreements ag ON ag.user_id = u.id
        WHERE u.role IN ('staff', 'manager')
          AND u.onboarding_status IN ('approved', 'reviewed', 'submitted')
          AND op.onboarding_completed = true
        ORDER BY COALESCE(cp.preferred_name, u.email) ASC
        LIMIT $1 OFFSET $2
      `, [limit, offset]),
      pool.query(`
        SELECT COUNT(*) FROM users u
        JOIN onboarding_progress op ON op.user_id = u.id
        WHERE u.role IN ('staff', 'manager')
          AND u.onboarding_status IN ('approved', 'reviewed', 'submitted')
          AND op.onboarding_completed = true
      `)
    ]);

    res.json({
      staff: staffResult.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Managers ─────────────────────────────────────────────────────

router.get('/managers', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, email, role, can_hire, can_staff, created_at FROM users WHERE role = 'manager' ORDER BY created_at DESC"
    );
    res.json({ managers: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Elevate an existing staff member to manager
router.post('/managers', auth, adminOnly, async (req, res) => {
  const { user_id, can_hire, can_staff } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required.' });
  try {
    // Verify the user exists and is staff
    const existing = await pool.query('SELECT id, role FROM users WHERE id = $1', [user_id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'User not found.' });
    if (existing.rows[0].role === 'manager') return res.status(409).json({ error: 'User is already a manager.' });
    if (existing.rows[0].role === 'admin') return res.status(400).json({ error: 'Cannot change admin role.' });
    const result = await pool.query(
      `UPDATE users SET role = 'manager', can_hire = $1, can_staff = $2
       WHERE id = $3
       RETURNING id, email, role, can_hire, can_staff, created_at`,
      [can_hire || false, can_staff || false, user_id]
    );
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/managers/:id', auth, adminOnly, async (req, res) => {
  const { can_hire, can_staff, email } = req.body;
  try {
    const result = await pool.query(
      `UPDATE users SET can_hire = $1, can_staff = $2, email = COALESCE($3, email)
       WHERE id = $4 AND role = 'manager'
       RETURNING id, email, role, can_hire, can_staff`,
      [can_hire ?? false, can_staff ?? false, email || null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Manager not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Demote manager back to staff (don't delete the account)
router.delete('/managers/:id', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE users SET role = 'staff', can_hire = false, can_staff = false
       WHERE id = $1 AND role = 'manager' RETURNING id`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Manager not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Interview Notes ──────────────────────────────────────────────

// Add interview note
router.post('/applications/:userId/notes', auth, adminOnly, async (req, res) => {
  const { note } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ error: 'Note cannot be empty.' });

  try {
    await pool.query(
      'INSERT INTO interview_notes (user_id, admin_id, note) VALUES ($1, $2, $3)',
      [req.params.userId, req.user.id, note.trim()]
    );

    const notesRes = await pool.query(`
      SELECT n.*, u.email as admin_email
      FROM interview_notes n
      LEFT JOIN users u ON u.id = n.admin_id
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC
    `, [req.params.userId]);

    res.status(201).json(notesRes.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete interview note
router.delete('/notes/:noteId', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM interview_notes WHERE id = $1 RETURNING id', [req.params.noteId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Note not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
