const express = require('express');
const { pool } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const { geocodeAddress, buildAddressString, delay } = require('../utils/geocode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { uploadFile } = require('../utils/storage');
const { encrypt, decrypt } = require('../utils/encryption');
const { isValidUpload } = require('../utils/fileValidation');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError, PermissionError } = require('../utils/errors');
const DOMPurify = createDOMPurify(new JSDOM('').window);

const BLOG_SANITIZE_OPTIONS = {
  ALLOWED_TAGS: ['h2', 'h3', 'p', 'br', 'strong', 'em', 'a', 'img', 'figure', 'figcaption', 'ul', 'ol', 'li', 'blockquote', 'hr'],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'target', 'rel', 'class'],
};

const router = express.Router();

// ─── Onboarding Users (paginated) ─────────────────────────────────

router.get('/users', auth, adminOnly, asyncHandler(async (req, res) => {
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
}));

// Get single user record (full detail — includes application data)
router.get('/users/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = req.params.id;

  const [userRes, progressRes, profileRes, agreementRes, paymentRes, appRes] = await Promise.all([
    pool.query('SELECT id, email, role, onboarding_status, notifications_opt_in, can_hire, can_staff, created_at, updated_at FROM users WHERE id = $1', [userId]),
    pool.query('SELECT * FROM onboarding_progress WHERE user_id = $1', [userId]),
    pool.query('SELECT * FROM contractor_profiles WHERE user_id = $1', [userId]),
    pool.query('SELECT * FROM agreements WHERE user_id = $1', [userId]),
    pool.query('SELECT * FROM payment_profiles WHERE user_id = $1', [userId]),
    pool.query('SELECT * FROM applications WHERE user_id = $1', [userId])
  ]);

  if (!userRes.rows[0]) throw new NotFoundError('User not found');

  const payment = paymentRes.rows[0] || {};
  if (payment) {
    if (payment.routing_number) { const raw = decrypt(payment.routing_number); payment.routing_number = '****' + raw.slice(-4); }
    if (payment.account_number) { const raw = decrypt(payment.account_number); payment.account_number = '****' + raw.slice(-4); }
  }

  res.json({
    user: userRes.rows[0],
    progress: progressRes.rows[0] || {},
    profile: profileRes.rows[0] || {},
    agreement: agreementRes.rows[0] || {},
    payment,
    application: appRes.rows[0] || {}
  });
}));

// Update user status (expanded for application + onboarding statuses)
router.put('/users/:id/status', auth, adminOnly, asyncHandler(async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['in_progress', 'applied', 'interviewing', 'hired', 'rejected', 'submitted', 'reviewed', 'approved', 'deactivated'];
  if (!validStatuses.includes(status)) {
    throw new ValidationError({ status: 'Invalid status' });
  }

  // Get current status before changing (for the audit log)
  const currentRes = await pool.query(
    "SELECT onboarding_status FROM users WHERE id=$1 AND role IN ('staff','manager')",
    [req.params.id]
  );
  if (!currentRes.rows[0]) throw new NotFoundError('User not found');
  const oldStatus = currentRes.rows[0].onboarding_status;

  const result = await pool.query(
    "UPDATE users SET onboarding_status=$1 WHERE id=$2 AND role IN ('staff','manager') RETURNING id, email, onboarding_status",
    [status, req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('User not found');

  // When hiring, ensure onboarding progress record exists and seed the contractor
  // profile from the application so admin + contractor views have the data immediately.
  if (status === 'hired') {
    const progressExists = await pool.query('SELECT id FROM onboarding_progress WHERE user_id = $1', [req.params.id]);
    if (!progressExists.rows[0]) {
      await pool.query(
        'INSERT INTO onboarding_progress (user_id, account_created) VALUES ($1, true)',
        [req.params.id]
      );
    }

    // Only seed/overwrite if the contractor hasn't yet filled in their profile.
    // A filled-in profile always has preferred_name; an empty/skeleton row does not.
    const existing = await pool.query(
      'SELECT preferred_name, hire_date FROM contractor_profiles WHERE user_id = $1',
      [req.params.id]
    );
    const isSkeletonOrMissing = !existing.rows[0] || !existing.rows[0].preferred_name;

    if (isSkeletonOrMissing) {
      const appRes = await pool.query('SELECT * FROM applications WHERE user_id = $1', [req.params.id]);
      if (appRes.rows[0]) {
        // Populate contractor_profiles from the application. Preserve an existing
        // hire_date if one was already set (re-hire or status-toggle case).
        await pool.query(`
          INSERT INTO contractor_profiles (
            user_id, preferred_name, phone, email, birth_month, birth_day, birth_year,
            street_address, city, state, zip_code,
            travel_distance, reliable_transportation,
            equipment_portable_bar, equipment_cooler, equipment_table_with_spandex,
            equipment_none_but_open, equipment_no_space,
            emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
            alcohol_certification_file_url, alcohol_certification_filename,
            resume_file_url, resume_filename,
            headshot_file_url, headshot_filename,
            hire_date
          )
          SELECT
            u.id, a.full_name, a.phone, u.email, a.birth_month, a.birth_day, a.birth_year,
            a.street_address, a.city, a.state, a.zip_code,
            a.travel_distance, a.reliable_transportation,
            COALESCE(a.equipment_portable_bar, false), COALESCE(a.equipment_cooler, false),
            COALESCE(a.equipment_table_with_spandex, false), COALESCE(a.equipment_none_but_open, false),
            COALESCE(a.equipment_no_space, false),
            a.emergency_contact_name, a.emergency_contact_phone, a.emergency_contact_relationship,
            a.basset_file_url, a.basset_filename,
            a.resume_file_url, a.resume_filename,
            a.headshot_file_url, a.headshot_filename,
            COALESCE($2::date, CURRENT_DATE)
          FROM users u
          JOIN applications a ON a.user_id = u.id
          WHERE u.id = $1
          ON CONFLICT (user_id) DO UPDATE SET
            preferred_name = EXCLUDED.preferred_name,
            phone = EXCLUDED.phone,
            email = EXCLUDED.email,
            birth_month = EXCLUDED.birth_month,
            birth_day = EXCLUDED.birth_day,
            birth_year = EXCLUDED.birth_year,
            street_address = EXCLUDED.street_address,
            city = EXCLUDED.city,
            state = EXCLUDED.state,
            zip_code = EXCLUDED.zip_code,
            travel_distance = EXCLUDED.travel_distance,
            reliable_transportation = EXCLUDED.reliable_transportation,
            equipment_portable_bar = EXCLUDED.equipment_portable_bar,
            equipment_cooler = EXCLUDED.equipment_cooler,
            equipment_table_with_spandex = EXCLUDED.equipment_table_with_spandex,
            equipment_none_but_open = EXCLUDED.equipment_none_but_open,
            equipment_no_space = EXCLUDED.equipment_no_space,
            emergency_contact_name = EXCLUDED.emergency_contact_name,
            emergency_contact_phone = EXCLUDED.emergency_contact_phone,
            emergency_contact_relationship = EXCLUDED.emergency_contact_relationship,
            alcohol_certification_file_url = EXCLUDED.alcohol_certification_file_url,
            alcohol_certification_filename = EXCLUDED.alcohol_certification_filename,
            resume_file_url = EXCLUDED.resume_file_url,
            resume_filename = EXCLUDED.resume_filename,
            headshot_file_url = EXCLUDED.headshot_file_url,
            headshot_filename = EXCLUDED.headshot_filename,
            hire_date = EXCLUDED.hire_date
        `, [req.params.id, existing.rows[0]?.hire_date || null]);
      } else {
        // No application on file (rare — direct admin hire) — just ensure a skeleton row with hire_date
        await pool.query(`
          INSERT INTO contractor_profiles (user_id, hire_date)
          VALUES ($1, CURRENT_DATE)
          ON CONFLICT (user_id) DO UPDATE SET hire_date = COALESCE(contractor_profiles.hire_date, CURRENT_DATE)
        `, [req.params.id]);
      }
    } else {
      // Contractor has already filled in their profile — only ensure hire_date is set
      await pool.query(`
        UPDATE contractor_profiles SET hire_date = COALESCE(hire_date, CURRENT_DATE)
        WHERE user_id = $1
      `, [req.params.id]);
    }
  }

  // Log status change as a system note in the interview_notes table
  if (oldStatus !== status) {
    const toLabel = s => (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    try {
      await pool.query(
        `INSERT INTO interview_notes (user_id, admin_id, note, note_type) VALUES ($1, $2, $3, 'status_change')`,
        [req.params.id, req.user.id, `${toLabel(oldStatus)} → ${toLabel(status)}`]
      );
    } catch (logErr) {
      // Audit log failures should not block the status change
      console.error('Status change log failed:', logErr);
    }
  }

  res.json(result.rows[0]);
}));

// Update user profile (admin editing contractor info)
router.put('/users/:id/profile', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const {
    preferred_name, phone, email: profileEmail, birth_month, birth_day, birth_year,
    city, state, street_address, zip_code, travel_distance, reliable_transportation,
    equipment_portable_bar, equipment_cooler, equipment_table_with_spandex,
    equipment_none_but_open, equipment_no_space, equipment_will_pickup,
    emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
    preferred_payment_method, payment_username, routing_number, account_number,
  } = req.body;

  // Upsert contractor profile
  await pool.query(`
    INSERT INTO contractor_profiles (
      user_id, preferred_name, phone, email, birth_month, birth_day, birth_year,
      city, state, street_address, zip_code, travel_distance, reliable_transportation,
      equipment_portable_bar, equipment_cooler, equipment_table_with_spandex,
      equipment_none_but_open, equipment_no_space, equipment_will_pickup,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relationship
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    ON CONFLICT (user_id) DO UPDATE SET
      preferred_name=$2, phone=$3, email=$4, birth_month=$5, birth_day=$6, birth_year=$7,
      city=$8, state=$9, street_address=$10, zip_code=$11, travel_distance=$12, reliable_transportation=$13,
      equipment_portable_bar=$14, equipment_cooler=$15, equipment_table_with_spandex=$16,
      equipment_none_but_open=$17, equipment_no_space=$18, equipment_will_pickup=$19,
      emergency_contact_name=$20, emergency_contact_phone=$21, emergency_contact_relationship=$22
  `, [
    userId, preferred_name || null, phone || null, profileEmail || null,
    birth_month || null, birth_day || null, birth_year || null,
    city || null, state || null, street_address || null, zip_code || null,
    travel_distance || null, reliable_transportation || null,
    equipment_portable_bar || false, equipment_cooler || false, equipment_table_with_spandex || false,
    equipment_none_but_open || false, equipment_no_space || false, equipment_will_pickup || false,
    emergency_contact_name || null, emergency_contact_phone || null, emergency_contact_relationship || null,
  ]);

  // Geocode address in background (fire-and-forget; failures logged only)
  if (street_address || city || state || zip_code) {
    geocodeAddress(buildAddressString({ street_address, city, state, zip_code }))
      .then(coords => {
        if (coords) {
          pool.query('UPDATE contractor_profiles SET lat = $1, lng = $2 WHERE user_id = $3', [coords.lat, coords.lng, userId]);
        }
      })
      .catch(err => console.error('[Admin] Geocode error:', err.message));
  }

  // Upsert payment profile
  await pool.query(`
    INSERT INTO payment_profiles (user_id, preferred_payment_method, payment_username, routing_number, account_number)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (user_id) DO UPDATE SET
      preferred_payment_method=$2, payment_username=$3, routing_number=$4, account_number=$5
  `, [userId, preferred_payment_method || null, payment_username || null, routing_number ? encrypt(routing_number) : null, account_number ? encrypt(account_number) : null]);

  // Return updated data
  const [profileRes, paymentRes] = await Promise.all([
    pool.query('SELECT * FROM contractor_profiles WHERE user_id = $1', [userId]),
    pool.query('SELECT * FROM payment_profiles WHERE user_id = $1', [userId]),
  ]);

  const payment = paymentRes.rows[0] || {};
  if (payment.routing_number) { const raw = decrypt(payment.routing_number); payment.routing_number = '****' + raw.slice(-4); }
  if (payment.account_number) { const raw = decrypt(payment.account_number); payment.account_number = '****' + raw.slice(-4); }

  res.json({ profile: profileRes.rows[0] || {}, payment });
}));

// Update user permissions (role + flags)
router.put('/users/:id/permissions', auth, adminOnly, asyncHandler(async (req, res) => {
  const { role, can_hire, can_staff } = req.body;
  const validRoles = ['staff', 'manager'];
  if (role && !validRoles.includes(role)) {
    throw new ValidationError({ role: 'Invalid role' });
  }

  const current = await pool.query('SELECT id, role FROM users WHERE id = $1', [req.params.id]);
  if (!current.rows[0]) throw new NotFoundError('User not found');
  if (current.rows[0].role === 'admin') {
    throw new ConflictError('Cannot change admin permissions.', 'ADMIN_IMMUTABLE');
  }

  const newRole = role || current.rows[0].role;
  const result = await pool.query(
    `UPDATE users SET role = $1, can_hire = $2, can_staff = $3
     WHERE id = $4
     RETURNING id, email, role, can_hire, can_staff`,
    [newRole, can_hire ?? false, can_staff ?? false, req.params.id]
  );
  res.json(result.rows[0]);
}));

// ─── Applications ─────────────────────────────────────────────────

// List all applications (paginated)
// ?archived=true returns only rejected/archived applicants
// Default returns all active (non-rejected) applicants
router.get('/applications', auth, adminOnly, asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const archived = req.query.archived === 'true';

  // Status filter: archived view shows only rejected; default shows only applied/interviewing
  const statusClause = archived
    ? "u.onboarding_status = 'rejected'"
    : "u.onboarding_status IN ('applied', 'interviewing')";

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
    // Active status counts (only applied/interviewing)
    pool.query(`
      SELECT u.onboarding_status, COUNT(*) as count
      FROM users u INNER JOIN applications a ON a.user_id = u.id
      WHERE u.role IN ('staff', 'manager') AND u.onboarding_status IN ('applied', 'interviewing')
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
}));

// Get single application detail with interview notes
router.get('/applications/:userId', auth, adminOnly, asyncHandler(async (req, res) => {
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

  if (!userRes.rows[0]) throw new NotFoundError('User not found');
  if (!appRes.rows[0]) throw new NotFoundError('Application not found');

  res.json({
    user: userRes.rows[0],
    application: appRes.rows[0],
    notes: notesRes.rows
  });
}));

// ─── Active Staff ─────────────────────────────────────────────────

router.get('/active-staff', auth, asyncHandler(async (req, res) => {
  // Admin or managers with can_staff
  if (req.user.role !== 'admin' && !(req.user.role === 'manager' && req.user.can_staff)) {
    throw new PermissionError('Access denied.');
  }

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
}));

// ─── Managers ─────────────────────────────────────────────────────

router.get('/managers', auth, adminOnly, asyncHandler(async (req, res) => {
  const result = await pool.query(
    "SELECT id, email, role, can_hire, can_staff, created_at FROM users WHERE role = 'manager' ORDER BY created_at DESC"
  );
  res.json({ managers: result.rows });
}));

// Elevate an existing staff member to manager
router.post('/managers', auth, adminOnly, asyncHandler(async (req, res) => {
  const { user_id, can_hire, can_staff } = req.body;
  if (!user_id) throw new ValidationError({ user_id: 'user_id is required.' });

  // Verify the user exists and is staff
  const existing = await pool.query('SELECT id, role FROM users WHERE id = $1', [user_id]);
  if (!existing.rows[0]) throw new NotFoundError('User not found.');
  if (existing.rows[0].role === 'manager') {
    throw new ConflictError('User is already a manager.', 'ALREADY_MANAGER');
  }
  if (existing.rows[0].role === 'admin') {
    throw new ConflictError('Cannot change admin role.', 'ADMIN_IMMUTABLE');
  }
  const result = await pool.query(
    `UPDATE users SET role = 'manager', can_hire = $1, can_staff = $2
     WHERE id = $3
     RETURNING id, email, role, can_hire, can_staff, created_at`,
    [can_hire || false, can_staff || false, user_id]
  );
  res.status(200).json(result.rows[0]);
}));

router.put('/managers/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const { can_hire, can_staff, email } = req.body;
  const result = await pool.query(
    `UPDATE users SET can_hire = $1, can_staff = $2, email = COALESCE($3, email)
     WHERE id = $4 AND role = 'manager'
     RETURNING id, email, role, can_hire, can_staff`,
    [can_hire ?? false, can_staff ?? false, email || null, req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Manager not found.');
  res.json(result.rows[0]);
}));

// Demote manager back to staff (don't delete the account)
router.delete('/managers/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `UPDATE users SET role = 'staff', can_hire = false, can_staff = false
     WHERE id = $1 AND role = 'manager' RETURNING id`,
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Manager not found.');
  res.json({ success: true });
}));

// ─── Interview Notes ──────────────────────────────────────────────

// Add interview note
router.post('/applications/:userId/notes', auth, adminOnly, asyncHandler(async (req, res) => {
  const { note } = req.body;
  if (!note || !note.trim()) {
    throw new ValidationError({ note: 'Note cannot be empty.' });
  }

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
}));

// Delete interview note
router.delete('/notes/:noteId', auth, adminOnly, asyncHandler(async (req, res) => {
  const result = await pool.query('DELETE FROM interview_notes WHERE id = $1 RETURNING id', [req.params.noteId]);
  if (!result.rows[0]) throw new NotFoundError('Note not found');
  res.json({ success: true });
}));

// ─── Test Email ──────────────────────────────────────────────────

router.post('/test-email', auth, adminOnly, asyncHandler(async (req, res) => {
  const { to } = req.body;
  if (!to) throw new ValidationError({ to: 'Recipient email (to) is required.' });

  const result = await sendEmail({
    to,
    subject: 'Dr. Bartender - Test Email',
    html: `
      <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <h1 style="color: #2d1810; text-align: center;">Dr. Bartender</h1>
        <p style="color: #333; font-size: 16px; text-align: center;">
          If you're reading this, email sending is working!
        </p>
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;" />
        <p style="color: #999; font-size: 12px; text-align: center;">
          This is a test email from drbartender.com
        </p>
      </div>
    `,
  });
  res.json({ success: true, id: result.id });
}));

// ─── Seniority Management ────────────────────────────────────────

// Get seniority info for a user
router.get('/users/:id/seniority', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = req.params.id;

  const [profileRes, eventsRes] = await Promise.all([
    pool.query(
      'SELECT hire_date, seniority_adjustment FROM contractor_profiles WHERE user_id = $1',
      [userId]
    ),
    pool.query(`
      SELECT COUNT(*) AS events_worked
      FROM shift_requests sr
      JOIN shifts s ON s.id = sr.shift_id
      WHERE sr.user_id = $1 AND sr.status = 'approved' AND s.event_date < CURRENT_DATE
    `, [userId])
  ]);

  const profile = profileRes.rows[0] || {};
  const eventsWorked = parseInt(eventsRes.rows[0]?.events_worked || 0, 10);

  let tenureMonths = 0;
  if (profile.hire_date) {
    const hire = new Date(profile.hire_date);
    const now = new Date();
    tenureMonths = Math.max(0, (now.getFullYear() - hire.getFullYear()) * 12 + (now.getMonth() - hire.getMonth()));
  }

  const seniorityAdjustment = profile.seniority_adjustment || 0;
  const computedScore = eventsWorked * 0.7 + tenureMonths * 0.3 + seniorityAdjustment;

  res.json({
    hire_date: profile.hire_date,
    seniority_adjustment: seniorityAdjustment,
    events_worked: eventsWorked,
    tenure_months: tenureMonths,
    computed_score: Math.round(computedScore * 100) / 100,
  });
}));

// Update seniority adjustment and hire_date
router.put('/users/:id/seniority', auth, adminOnly, asyncHandler(async (req, res) => {
  const { seniority_adjustment, hire_date } = req.body;
  await pool.query(`
    UPDATE contractor_profiles
    SET seniority_adjustment = COALESCE($1, seniority_adjustment),
        hire_date = COALESCE($2, hire_date)
    WHERE user_id = $3
  `, [
    seniority_adjustment !== null && seniority_adjustment !== undefined ? seniority_adjustment : null,
    hire_date || null,
    req.params.id
  ]);

  res.json({ success: true });
}));

// ─── App Settings ────────────────────────────────────────────────

router.get('/settings', auth, adminOnly, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT key, value FROM app_settings');
  const settings = {};
  for (const row of result.rows) {
    settings[row.key] = row.value;
  }
  res.json(settings);
}));

router.put('/settings', auth, adminOnly, asyncHandler(async (req, res) => {
  const entries = Object.entries(req.body);
  if (entries.length === 0) throw new ValidationError({ _form: 'No settings provided.' });

  for (const [key, value] of entries) {
    await pool.query(`
      INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
    `, [key, String(value)]);
  }

  const result = await pool.query('SELECT key, value FROM app_settings');
  const settings = {};
  for (const row of result.rows) {
    settings[row.key] = row.value;
  }
  res.json(settings);
}));

// ─── Backfill Geocodes ──────────────────────────────────────────

router.post('/backfill-geocodes', auth, adminOnly, asyncHandler(async (req, res) => {
  // Backfill contractor_profiles
  const profiles = await pool.query(`
    SELECT user_id, street_address, city, state, zip_code
    FROM contractor_profiles
    WHERE lat IS NULL AND (street_address IS NOT NULL OR city IS NOT NULL)
  `);

  let profileCount = 0;
  for (const p of profiles.rows) {
    const addr = buildAddressString(p);
    if (!addr) continue;
    const coords = await geocodeAddress(addr);
    if (coords) {
      await pool.query('UPDATE contractor_profiles SET lat = $1, lng = $2 WHERE user_id = $3', [coords.lat, coords.lng, p.user_id]);
      profileCount++;
    }
    await delay(1100); // Nominatim rate limit
  }

  // Backfill shifts
  const shifts = await pool.query(`
    SELECT id, location FROM shifts WHERE lat IS NULL AND location IS NOT NULL
  `);

  let shiftCount = 0;
  for (const s of shifts.rows) {
    const coords = await geocodeAddress(s.location);
    if (coords) {
      await pool.query('UPDATE shifts SET lat = $1, lng = $2 WHERE id = $3', [coords.lat, coords.lng, s.id]);
      shiftCount++;
    }
    await delay(1100);
  }

  // Backfill hire_date for hired staff without one
  const hireResult = await pool.query(`
    UPDATE contractor_profiles cp
    SET hire_date = u.created_at::date
    FROM users u
    WHERE cp.user_id = u.id
      AND cp.hire_date IS NULL
      AND u.onboarding_status IN ('hired', 'submitted', 'reviewed', 'approved')
  `);

  res.json({
    profiles_geocoded: profileCount,
    shifts_geocoded: shiftCount,
    hire_dates_backfilled: hireResult.rowCount,
  });
}));

// ─── Blog Posts (admin CRUD) ─────────────────────────────────────

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// List all posts (drafts + published) — excludes body (large HTML blob)
router.get('/blog', auth, adminOnly, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;
  const result = await pool.query(
    `SELECT id, slug, title, excerpt, cover_image_url, published, published_at, created_at, updated_at
     FROM blog_posts
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  res.json(result.rows);
}));

// Import blog posts from blog_posts.json (one-time migration)
router.post('/blog/import', auth, adminOnly, asyncHandler(async (req, res) => {
  const fs = require('fs');
  const importDir = path.resolve(__dirname, '../..', 'blog-import');
  const jsonPath = path.join(importDir, 'blog_posts.json');
  const imagesDir = path.join(importDir, 'images');

  if (!fs.existsSync(jsonPath)) {
    throw new NotFoundError('blog_posts.json not found on server');
  }

  const posts = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const results = [];

  const uploadImg = async (filename) => {
    const fullPath = path.join(imagesDir, path.basename(filename));
    if (!fs.existsSync(fullPath)) return null;
    const data = fs.readFileSync(fullPath);
    const ext = path.extname(filename);
    const name = `blog_${uuidv4()}${ext}`;
    await uploadFile(data, name);
    return `/api/blog/images/${name}`;
  };

  const parseBlocks = (text) => {
    const blocks = [];
    const sections = text.split(/\n{2,}/);
    for (const raw of sections) {
      const section = raw.trim();
      if (!section) continue;
      const lines = section.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length === 1 && section.length < 100 && !section.endsWith('.') && !section.startsWith('"') && !section.startsWith('\u201C')) {
        blocks.push({ type: 'heading', content: section, level: 'h2' });
      } else {
        blocks.push({ type: 'text', content: section });
      }
    }
    return blocks;
  };

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const postNum = i + 1;

    // Upload cover image
    const coverFilename = `cover-post${postNum}.webp`;
    let coverUrl = null;
    if (fs.existsSync(path.join(imagesDir, coverFilename))) {
      coverUrl = await uploadImg(coverFilename);
    }

    // Parse body into blocks
    const blocks = parseBlocks(post.body);

    // Upload inline images
    const imageBlocks = [];
    for (const img of (post.images || [])) {
      const url = await uploadImg(img.local_path);
      if (url) imageBlocks.push({ type: 'image', url, caption: img.alt || '' });
    }

    // Distribute images after headings
    let imgIdx = 0;
    const finalBlocks = [];
    for (const block of blocks) {
      finalBlocks.push(block);
      if (block.type === 'heading' && imgIdx < imageBlocks.length) {
        finalBlocks.push(imageBlocks[imgIdx++]);
      }
    }
    while (imgIdx < imageBlocks.length) finalBlocks.push(imageBlocks[imgIdx++]);

    const body = JSON.stringify(finalBlocks);
    const firstText = finalBlocks.find(b => b.type === 'text');
    const excerpt = firstText ? firstText.content.slice(0, 200).replace(/\n/g, ' ').trim() + '...' : '';

    const result = await pool.query(
      `INSERT INTO blog_posts (title, slug, excerpt, body, cover_image_url, published, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [post.title, post.slug, excerpt, body, coverUrl, true, new Date(post.date)]
    );

    results.push({
      title: post.title,
      status: result.rows.length ? 'imported' : 'skipped (slug exists)',
      id: result.rows[0]?.id || null
    });
  }

  res.json({ imported: results.filter(r => r.status === 'imported').length, skipped: results.filter(r => r.status !== 'imported').length, results });
}));

// Create post
router.post('/blog', auth, adminOnly, asyncHandler(async (req, res) => {
  let { title, slug, excerpt, body, cover_image_url, published, published_at } = req.body; // eslint-disable-line prefer-const
  if (!title || !body) {
    const fieldErrors = {};
    if (!title) fieldErrors.title = 'Title is required';
    if (!body) fieldErrors.body = 'Body is required';
    throw new ValidationError(fieldErrors);
  }
  body = DOMPurify.sanitize(body, BLOG_SANITIZE_OPTIONS);
  if (!slug) slug = slugify(title);
  if (published_at) {
    published_at = new Date(published_at);
  } else {
    published_at = published ? new Date() : null;
  }

  try {
    const result = await pool.query(
      `INSERT INTO blog_posts (title, slug, excerpt, body, cover_image_url, published, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [title, slug, excerpt, body, cover_image_url || null, !!published, published_at]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505' && err.constraint?.includes('slug')) {
      throw new ConflictError('A post with that slug already exists', 'DUPLICATE_SLUG');
    }
    throw err;
  }
}));

// Upload blog image
router.post('/blog/upload-image', auth, adminOnly, asyncHandler(async (req, res) => {
  if (!req.files?.image) {
    throw new ValidationError({ image: 'No image provided' });
  }
  const file = req.files.image;
  if (!isValidUpload(file)) {
    throw new ValidationError({ image: 'Invalid file type. Use JPEG, PNG, or WebP.' });
  }
  // Only allow image types (not PDF)
  const mime = file.mimetype?.toLowerCase() || '';
  if (mime === 'application/pdf') {
    throw new ValidationError({ image: 'PDF files are not allowed for blog images.' });
  }

  const ext = path.extname(file.name);
  const filename = `blog_${uuidv4()}${ext}`;
  await uploadFile(file.data, filename);

  res.json({ url: `/api/blog/images/${filename}` });
}));

// Update post
router.put('/blog/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, slug, excerpt, cover_image_url, published, published_at: reqPublishedAt } = req.body;
  const body = req.body.body ? DOMPurify.sanitize(req.body.body, BLOG_SANITIZE_OPTIONS) : req.body.body;

  // Fetch current state to check publish transition
  const current = await pool.query('SELECT * FROM blog_posts WHERE id = $1', [id]);
  if (current.rows.length === 0) {
    throw new NotFoundError('Post not found');
  }

  const post = current.rows[0];
  // Use explicitly provided date, or auto-set on first publish
  let published_at;
  if (reqPublishedAt) {
    published_at = new Date(reqPublishedAt);
  } else if (published && !post.published && !post.published_at) {
    published_at = new Date();
  } else {
    published_at = post.published_at;
  }

  try {
    const result = await pool.query(
      `UPDATE blog_posts
       SET title = $1, slug = $2, excerpt = $3, body = $4, cover_image_url = $5,
           published = $6, published_at = $7
       WHERE id = $8
       RETURNING *`,
      [title, slug, excerpt, body, cover_image_url || null, !!published, published_at, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505' && err.constraint?.includes('slug')) {
      throw new ConflictError('A post with that slug already exists', 'DUPLICATE_SLUG');
    }
    throw err;
  }
}));

// Delete post
router.delete('/blog/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'DELETE FROM blog_posts WHERE id = $1 RETURNING id',
    [req.params.id]
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('Post not found');
  }
  res.json({ message: 'Post deleted' });
}));

// ─── Badge Counts ───────────────────────────────────────────────

/** GET /api/admin/badge-counts — sidebar notification counts */
router.get('/badge-counts', auth, adminOnly, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM proposals WHERE status IN ('sent', 'viewed', 'modified'))::int AS pending_proposals,
      (SELECT COUNT(*) FROM shifts
       WHERE event_date >= CURRENT_DATE AND status = 'open'
         AND positions_needed IS NOT NULL AND positions_needed != '[]'
         AND (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = shifts.id AND sr.status = 'approved')
             < json_array_length(positions_needed::json)
      )::int AS unstaffed_events,
      (SELECT COUNT(*) FROM applications WHERE onboarding_status = 'applied')::int AS new_applications
  `);
  res.json(result.rows[0]);
}));

module.exports = router;
