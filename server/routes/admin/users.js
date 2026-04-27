const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const { sendEmail } = require('../../utils/email');
const emailTemplates = require('../../utils/emailTemplates');
const { STAFF_URL } = require('../../utils/urls');
const { geocodeAddress, buildAddressString } = require('../../utils/geocode');
const { encrypt, decrypt } = require('../../utils/encryption');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError, PermissionError } = require('../../utils/errors');
const { validatePhone } = require('../../utils/phone');

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
  const { status, customMessage } = req.body;
  const validStatuses = ['in_progress', 'applied', 'interviewing', 'hired', 'rejected', 'submitted', 'reviewed', 'approved', 'deactivated'];
  if (!validStatuses.includes(status)) {
    throw new ValidationError({ status: 'Invalid status' });
  }

  // Defense-in-depth cap on the admin-supplied personal note so the email body
  // (and the customMessageBlock that gets esc()'d into HTML) can't grow without bound.
  if (customMessage !== undefined && customMessage !== null) {
    if (typeof customMessage !== 'string') {
      throw new ValidationError({ customMessage: 'Personal note must be a string.' });
    }
    if (customMessage.length > 2000) {
      throw new ValidationError({ customMessage: 'Personal note must be 2000 characters or fewer.' });
    }
  }

  // All writes in this handler (users status + onboarding_progress seed + contractor_profiles
  // seed from application + audit log) share one transaction so a partial failure can't leave
  // a user flipped to 'hired' with a half-seeded profile.
  const client = await pool.connect();
  let result;
  let oldStatus;
  let applicantName = null;
  try {
    await client.query('BEGIN');

    // Lock the user row so a concurrent status change can't slip between our read and write
    const currentRes = await client.query(
      "SELECT onboarding_status FROM users WHERE id=$1 AND role IN ('staff','manager') FOR UPDATE",
      [req.params.id]
    );
    if (!currentRes.rows[0]) throw new NotFoundError('User not found');
    oldStatus = currentRes.rows[0].onboarding_status;

    result = await client.query(
      "UPDATE users SET onboarding_status=$1 WHERE id=$2 AND role IN ('staff','manager') RETURNING id, email, onboarding_status",
      [status, req.params.id]
    );
    if (!result.rows[0]) throw new NotFoundError('User not found');

    // When hiring, ensure onboarding progress record exists and seed the contractor
    // profile from the application so admin + contractor views have the data immediately.
    if (status === 'hired') {
      const progressExists = await client.query('SELECT id FROM onboarding_progress WHERE user_id = $1', [req.params.id]);
      if (!progressExists.rows[0]) {
        await client.query(
          'INSERT INTO onboarding_progress (user_id, account_created) VALUES ($1, true)',
          [req.params.id]
        );
      }

      // Lock the (possibly absent) contractor_profiles row so the skeleton-vs-filled check
      // and the subsequent seed are atomic — prevents clobbering a name the contractor
      // saves between our read and our write.
      const existing = await client.query(
        'SELECT preferred_name, hire_date FROM contractor_profiles WHERE user_id = $1 FOR UPDATE',
        [req.params.id]
      );
      const isSkeletonOrMissing = !existing.rows[0] || !existing.rows[0].preferred_name;

      if (isSkeletonOrMissing) {
        const appExists = await client.query('SELECT 1 FROM applications WHERE user_id = $1 LIMIT 1', [req.params.id]);
        if (appExists.rows[0]) {
          // Populate contractor_profiles from the application. Preserve an existing
          // hire_date if one was already set (re-hire or status-toggle case).
          // KEEP IN SYNC WITH schema.sql contractor_profiles + PUT /users/:id/profile.
          await client.query(`
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
          await client.query(`
            INSERT INTO contractor_profiles (user_id, hire_date)
            VALUES ($1, CURRENT_DATE)
            ON CONFLICT (user_id) DO UPDATE SET hire_date = COALESCE(contractor_profiles.hire_date, CURRENT_DATE)
          `, [req.params.id]);
        }
      } else {
        // Contractor has already filled in their profile — only ensure hire_date is set
        await client.query(`
          UPDATE contractor_profiles SET hire_date = COALESCE(hire_date, CURRENT_DATE)
          WHERE user_id = $1
        `, [req.params.id]);
      }
    }

    // Log status change as a system note in the interview_notes table.
    // Audit log failures should not block the primary status change, so swallow the error.
    if (oldStatus !== status) {
      const toLabel = s => (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      try {
        await client.query(
          `INSERT INTO interview_notes (user_id, admin_id, note, note_type) VALUES ($1, $2, $3, 'status_change')`,
          [req.params.id, req.user.id, `${toLabel(oldStatus)} → ${toLabel(status)}`]
        );
      } catch (logErr) {
        console.error('Status change log failed:', logErr);
      }

      // Look up applicant display name for the status-change email (sent after COMMIT).
      // Prefer the contractor's chosen preferred_name; fall back to the application full_name.
      const nameRes = await client.query(
        `SELECT cp.preferred_name AS profile_name, a.full_name AS app_name
         FROM users u
         LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
         LEFT JOIN applications a ON a.user_id = u.id
         WHERE u.id = $1`,
        [req.params.id]
      );
      applicantName = nameRes.rows[0]?.profile_name || nameRes.rows[0]?.app_name || null;
    }

    await client.query('COMMIT');
  } catch (txErr) {
    try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw txErr;
  } finally {
    client.release();
  }

  // Send status-change email after COMMIT so a send failure can't roll back the
  // primary status change. Internal-only states (in_progress, reviewed, approved)
  // skip email by design — no entry in pickStatusEmail returns null.
  if (oldStatus !== status) {
    const tpl = pickStatusEmail(status, { applicantName, customMessage, staffPortalUrl: STAFF_URL });
    if (tpl) {
      try {
        await sendEmail({ to: result.rows[0].email, subject: tpl.subject, html: tpl.html, text: tpl.text });
      } catch (emailErr) {
        console.error('Status-change email failed:', emailErr);
        Sentry.captureException(emailErr, {
          tags: { route: 'PUT /admin/users/:id/status', step: 'email' },
          extra: { userId: req.params.id, oldStatus, newStatus: status },
        });
      }
    }
  }

  res.json(result.rows[0]);
}));

// Map a status value to an email template factory. Returns null for internal
// states (in_progress, reviewed, approved, applied, submitted) that should not
// notify the applicant. 'applied' is auto-set on application submission and
// already triggers applicationReceivedConfirmation from POST /application —
// re-firing it here on an admin status revert would send the user a duplicate
// "we received your application" email. 'submitted' is an onboarding-progress
// state, not an application state, so no email applies.
function pickStatusEmail(status, ctx) {
  if (status === 'interviewing') return emailTemplates.applicationInterviewInvite(ctx);
  if (status === 'hired') return emailTemplates.applicationHired(ctx);
  if (status === 'rejected') return emailTemplates.applicationRejected(ctx);
  if (status === 'deactivated') return emailTemplates.applicationDeactivated(ctx);
  return null;
}

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
    hourly_rate,
  } = req.body;

  // hourly_rate is optional in the payload — when omitted we leave the column
  // alone (COALESCE keeps the existing value, defaulting to $20 on first insert).
  let rate = null;
  if (hourly_rate !== undefined && hourly_rate !== null && hourly_rate !== '') {
    const n = Number(hourly_rate);
    if (!Number.isFinite(n) || n < 0 || n > 1000) {
      throw new ValidationError({ hourly_rate: 'Hourly rate must be between $0 and $1000.' });
    }
    rate = n;
  }

  const fieldErrors = {};
  const phoneCheck = validatePhone(phone);
  if (phoneCheck.error) fieldErrors.phone = phoneCheck.error;
  const ecPhoneCheck = validatePhone(emergency_contact_phone);
  if (ecPhoneCheck.error) fieldErrors.emergency_contact_phone = ecPhoneCheck.error;
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);

  // Upsert contractor profile
  await pool.query(`
    INSERT INTO contractor_profiles (
      user_id, preferred_name, phone, email, birth_month, birth_day, birth_year,
      city, state, street_address, zip_code, travel_distance, reliable_transportation,
      equipment_portable_bar, equipment_cooler, equipment_table_with_spandex,
      equipment_none_but_open, equipment_no_space, equipment_will_pickup,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
      hourly_rate
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,COALESCE($23, 20.00))
    ON CONFLICT (user_id) DO UPDATE SET
      preferred_name=$2, phone=$3, email=$4, birth_month=$5, birth_day=$6, birth_year=$7,
      city=$8, state=$9, street_address=$10, zip_code=$11, travel_distance=$12, reliable_transportation=$13,
      equipment_portable_bar=$14, equipment_cooler=$15, equipment_table_with_spandex=$16,
      equipment_none_but_open=$17, equipment_no_space=$18, equipment_will_pickup=$19,
      emergency_contact_name=$20, emergency_contact_phone=$21, emergency_contact_relationship=$22,
      hourly_rate=COALESCE($23, contractor_profiles.hourly_rate)
  `, [
    userId, preferred_name || null, phoneCheck.value, profileEmail || null,
    birth_month || null, birth_day || null, birth_year || null,
    city || null, state || null, street_address || null, zip_code || null,
    travel_distance || null, reliable_transportation || null,
    equipment_portable_bar || false, equipment_cooler || false, equipment_table_with_spandex || false,
    equipment_none_but_open || false, equipment_no_space || false, equipment_will_pickup || false,
    emergency_contact_name || null, ecPhoneCheck.value, emergency_contact_relationship || null,
    rate,
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
    tenureMonths = Math.max(0, (now.getUTCFullYear() - hire.getUTCFullYear()) * 12 + (now.getUTCMonth() - hire.getUTCMonth()));
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

module.exports = router;
