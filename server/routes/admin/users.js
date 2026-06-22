const express = require('express');
const Sentry = require('@sentry/node');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../db');
const { auth, adminOnly, requireAdminOrManager } = require('../../middleware/auth');
const { sendEmail } = require('../../utils/email');
const emailTemplates = require('../../utils/emailTemplates');
const { STAFF_URL } = require('../../utils/urls');
const { geocodeAddress, buildAddressString } = require('../../utils/geocode');
const { encrypt, decrypt } = require('../../utils/encryption');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError, PermissionError } = require('../../utils/errors');
const { validatePhone } = require('../../utils/phone');
const {
  createTipPaymentLink,
  deactivateTipPaymentLink,
} = require('../../utils/tipPaymentLinks');
const { activateTipPage, deactivateTipPage } = require('../../utils/tipPageLifecycle');
const { normalizeTipHandlesInPlace } = require('../../utils/tipHandleValidation');
const { logAdminAction } = require('../../utils/adminAuditLog');
const { seedContractorProfileFromApplication } = require('../../utils/contractorSeed');
const { writeActivityBestEffort, writeInterviewNoteBestEffort } = require('../../utils/activityLog');

const router = express.Router();

// ─── Onboarding Users (paginated) ─────────────────────────────────

router.get('/users', auth, adminOnly, asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  const [usersResult, countResult] = await Promise.all([
    pool.query(`
      SELECT
        u.id, u.email, u.role, u.onboarding_status, u.notifications_opt_in, u.created_at, u.updated_at, u.cc_id,
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
router.get('/users/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = req.params.id;

  const [userRes, progressRes, profileRes, agreementRes, paymentRes, appRes] = await Promise.all([
    pool.query('SELECT id, email, role, onboarding_status, notifications_opt_in, can_hire, can_staff, created_at, updated_at, cc_id FROM users WHERE id = $1', [userId]),
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

  // Least-privilege for managers (this route is open to admin + manager). A
  // manager manages/evaluates/schedules staff, but the payroll/financial tier
  // stays admin-only — managers don't process payouts (those routes are
  // adminOnly). So withhold the whole payment_profiles row (bank is masked above
  // regardless, plus payment handle / method / stripe ids) and the W-9 tax
  // document. Operational + evaluation data (profile, application answers,
  // resume/headshot/BASSET, scorecard, shifts) stays visible.
  const isManager = req.user.role !== 'admin';
  const profile = profileRes.rows[0] || {};
  const application = appRes.rows[0] || {};
  if (isManager) {
    if ('w9_file_url' in profile) profile.w9_file_url = null;
    if ('w9_file_url' in application) application.w9_file_url = null;
  }

  res.json({
    user: userRes.rows[0],
    progress: progressRes.rows[0] || {},
    profile,
    agreement: agreementRes.rows[0] || {},
    payment: isManager ? {} : payment,
    application
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

    // Clear pre_hired on rejection/deactivation. The flag is a one-time
    // bypass of the admin-review gate (see server/routes/auth.js POST
    // /register-pre-hired); a contractor who's been rejected should not be
    // able to auto-rehire themselves if later restored — they need fresh
    // admin review. The application-submit handler also defense-in-depth
    // gates the pre-hire branch on status==='in_progress'.
    const clearPreHired = (status === 'rejected' || status === 'deactivated');
    result = clearPreHired
      ? await client.query(
          "UPDATE users SET onboarding_status=$1, pre_hired=false WHERE id=$2 AND role IN ('staff','manager') RETURNING id, email, onboarding_status",
          [status, req.params.id]
        )
      : await client.query(
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
          await seedContractorProfileFromApplication(client, req.params.id, existing.rows[0]?.hire_date || null);
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

    await client.query('COMMIT');
  } catch (txErr) {
    try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw txErr;
  } finally {
    client.release();
  }

  // Audit writes + applicantName lookup run AFTER COMMIT, pipelined via
  // Promise.all so the three calls don't serialize. They used to live inside
  // the transaction with an inner try/catch — but Postgres marks a transaction
  // as aborted the moment any statement errors, so a JS catch around
  // client.query() can't rescue the primary state change from a log-row
  // failure. The post-COMMIT pattern + best-effort helpers gives us truly
  // best-effort audit.
  //
  // The nameRes read is unlocked-by-design — between COMMIT and this read a
  // parallel contractor profile update could change preferred_name. That's
  // acceptable: the email should reflect the freshest name anyway, and the
  // window is sub-second.
  if (oldStatus !== status) {
    const toLabel = s => (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const noteText = `${toLabel(oldStatus)} → ${toLabel(status)}`;
    const [, , nameRes] = await Promise.all([
      writeInterviewNoteBestEffort({
        user_id: req.params.id,
        admin_id: req.user.id,
        note: noteText,
        source: 'PUT /admin/users/:id/status',
      }),
      writeActivityBestEffort({
        user_id: req.params.id,
        actor_id: req.user.id,
        event_type: 'status_changed',
        metadata: { from: oldStatus, to: status, via: 'admin_users_endpoint' },
        source: 'PUT /admin/users/:id/status',
      }),
      pool.query(
        `SELECT cp.preferred_name AS profile_name, a.full_name AS app_name
         FROM users u
         LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
         LEFT JOIN applications a ON a.user_id = u.id
         WHERE u.id = $1`,
        [req.params.id]
      ),
    ]);
    applicantName = nameRes.rows[0]?.profile_name || nameRes.rows[0]?.app_name || null;
  }

  // Tip-page lifecycle. Runs AFTER COMMIT — Stripe ops can't be rolled back,
  // and the helpers are best-effort (no-op if no Stripe link / payment profile).
  // Deactivate when flipping INTO an off-funnel state; reactivate when flipping
  // BACK to an active state from a previously-deactivated/rejected one.
  if (oldStatus !== status) {
    if (status === 'rejected' || status === 'deactivated') {
      await deactivateTipPage(req.params.id);
    } else if (
      (oldStatus === 'rejected' || oldStatus === 'deactivated') &&
      ['hired', 'in_progress', 'submitted', 'reviewed', 'approved'].includes(status)
    ) {
      await activateTipPage(req.params.id);
    }
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

  // Legacy CC stub users (cc_id LIKE 'legacy_cc:%') are seeded with
  // onboarding_status='deactivated' so they're invisible to the default
  // staff roster. The opt-in `?include_stubs=true` widens the filter so the
  // StaffDashboard can render them with a visual badge. Default behavior
  // is preserved for every other caller.
  const includeStubs = req.query.include_stubs === 'true';
  const statusList = includeStubs
    ? `'approved', 'reviewed', 'submitted', 'deactivated'`
    : `'approved', 'reviewed', 'submitted'`;

  const [staffResult, countResult] = await Promise.all([
    pool.query(`
      SELECT
        u.id, u.email, u.role, u.onboarding_status, u.created_at, u.cc_id,
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
        AND u.onboarding_status IN (${statusList})
        AND op.onboarding_completed = true
      ORDER BY COALESCE(cp.preferred_name, u.email) ASC
      LIMIT $1 OFFSET $2
    `, [limit, offset]),
    pool.query(`
      SELECT COUNT(*) FROM users u
      JOIN onboarding_progress op ON op.user_id = u.id
      WHERE u.role IN ('staff', 'manager')
        AND u.onboarding_status IN (${statusList})
        AND op.onboarding_completed = true
    `)
  ]);

  // Defense-in-depth: redact stub email for non-admin callers. Mirrors the
  // same pattern in /admin/cc-import/search/users (Batch 9). The `.local`
  // stub email is contractor-identity-derived and should not surface to
  // managers, even though the badge is intentionally visible to them.
  const rows = staffResult.rows;
  if (req.user.role !== 'admin') {
    for (const r of rows) {
      if (typeof r.cc_id === 'string' && r.cc_id.startsWith('legacy_cc:')) {
        r.email = '(redacted)';
      }
    }
  }

  res.json({
    staff: rows,
    total: parseInt(countResult.rows[0].count),
    page,
    pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
  });
}));

// ─── cc-import re-trigger affordances (Task 22) ──────────────────
//
// Returns the proposal ids on which this user is an approved participant AND
// at least one OTHER participant is a legacy CC stub (cc_id LIKE 'legacy_cc:%').
// The admin UI uses this to decide whether to show the "Re-accrue payouts"
// affordance: if non-empty, the operator can re-run payroll accrual against
// each listed proposal after the stub has been linked / removed.
//
// Spec reference: docs/superpowers/specs/2026-05-25-checkcherry-import-design.md §9.3.E.
router.get('/users/:id/stub-co-participated-proposals', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new ValidationError(undefined, 'id must be an integer');

  const userCheck = await pool.query(`SELECT id FROM users WHERE id = $1`, [id]);
  if (userCheck.rowCount === 0) throw new NotFoundError('user not found');

  const { rows } = await pool.query(`
    SELECT DISTINCT s.proposal_id
      FROM shift_requests sr
      JOIN shifts s ON s.id = sr.shift_id
     WHERE sr.user_id = $1 AND sr.status = 'approved'
       AND EXISTS (
         SELECT 1
           FROM shift_requests sr2
           JOIN shifts s2 ON s2.id = sr2.shift_id
           JOIN users u ON u.id = sr2.user_id
          WHERE s2.proposal_id = s.proposal_id
            AND u.cc_id LIKE 'legacy_cc:%'
       )
  `, [id]);
  res.json({ proposal_ids: rows.map(r => r.proposal_id) });
}));

// ─── Seniority Management ────────────────────────────────────────

// Get seniority info for a user
router.get('/users/:id/seniority', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
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
      WHERE sr.user_id = $1 AND sr.status = 'approved' AND sr.dropped_at IS NULL AND s.event_date < CURRENT_DATE
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

// ─── Per-Contractor Tip Page Actions ─────────────────────────────
// Admin/manager surface for managing a contractor's tip page: edit handles,
// rotate or generate the Stripe Payment Link, and toggle the page on/off.
// `regenerate-stripe` preserves tip_page_token so existing printed QRs keep
// working — only the Stripe link rotates.

const ALLOWED_PAYMENT_METHODS = ['venmo', 'cashapp', 'paypal', 'check', 'direct_deposit', 'other'];

// Managers shouldn't be able to mutate an admin's tip page (rotate their Stripe
// link, change their handles, or deactivate them). Admins can mutate anyone.
async function ensureNonAdminTargetForManager(req, userId) {
  if (req.user.role === 'admin') return;
  const r = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
  if (r.rows[0]?.role === 'admin') {
    throw new PermissionError('Managers cannot modify an admin user tip page');
  }
}

// PATCH — admin override of handles + payroll preference + preferred_name
router.patch('/contractors/:userId/tip-page', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId)) throw new ValidationError('invalid userId');
  await ensureNonAdminTargetForManager(req, userId);

  const fields = {};
  for (const k of ['venmo_handle', 'cashapp_handle', 'paypal_url', 'preferred_payment_method']) {
    if (k in req.body) fields[k] = req.body[k];
  }

  // Empty-string preferred_payment_method = "form left this blank" → no-op,
  // not silent clear. Explicit null clears (consistent with /api/me/tip-page).
  if ('preferred_payment_method' in fields && fields.preferred_payment_method === '') {
    delete fields.preferred_payment_method;
  }
  if ('preferred_payment_method' in fields && fields.preferred_payment_method
      && !ALLOWED_PAYMENT_METHODS.includes(fields.preferred_payment_method)) {
    throw new ValidationError('invalid preferred_payment_method');
  }

  // Validate + normalize handle formats (paypal_url especially — flows into an
  // <a href> on the public tip page so anything off paypal.me is rejected).
  normalizeTipHandlesInPlace(fields);

  if ('preferred_name' in req.body) {
    await pool.query(
      'UPDATE contractor_profiles SET preferred_name = $1, updated_at = NOW() WHERE user_id = $2',
      [String(req.body.preferred_name || '').trim() || null, userId]
    );
  }

  if (Object.keys(fields).length > 0) {
    const cols = Object.keys(fields);
    const setClause = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await pool.query(`
      INSERT INTO payment_profiles (user_id, ${cols.join(', ')})
      VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
      ON CONFLICT (user_id) DO UPDATE SET ${setClause}, updated_at = NOW()
    `, [userId, ...cols.map(c => fields[c] || null)]);
  }
  res.json({ ok: true });
}));

// POST — emergency rotation: issue a NEW tip_page_token AND a new Stripe link.
// Use only when the existing public URL is compromised (printed QR card was
// photographed, screenshot leaked, etc.). Customers with the old QR can no
// longer pay through it. In-flight Stripe sessions on the old link will fail
// or, if completed in the brief gap, get dropped at the webhook because the
// metadata token won't match the rotated DB token.
router.post('/contractors/:userId/tip-page/rotate-token', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId)) throw new ValidationError('invalid userId');
  await ensureNonAdminTargetForManager(req, userId);

  const { rows } = await pool.query(`
    SELECT pp.tip_page_token, pp.stripe_payment_link_id, cp.preferred_name
    FROM payment_profiles pp
    LEFT JOIN contractor_profiles cp ON cp.user_id = pp.user_id
    WHERE pp.user_id = $1
  `, [userId]);
  const row = rows[0];
  if (!row || !row.tip_page_token) throw new NotFoundError('contractor has no tip page');

  // Best-effort retire of the old Stripe link FIRST so the leaked URL stops
  // accepting new payments immediately. The webhook drops any in-flight
  // session whose old token no longer matches DB after the rotation below.
  if (row.stripe_payment_link_id) {
    try { await deactivateTipPaymentLink(row.stripe_payment_link_id); }
    catch (err) { console.error('[tip-admin] retire old link on rotate failed', err.message); }
  }

  const newToken = uuidv4();
  const { url, id } = await createTipPaymentLink({
    userId,
    displayName: row.preferred_name,
    token: newToken,
  });

  await pool.query(`
    UPDATE payment_profiles
    SET tip_page_token = $1,
        stripe_payment_link_url = $2,
        stripe_payment_link_id = $3,
        updated_at = NOW()
    WHERE user_id = $4
  `, [newToken, url, id, userId]);

  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: userId,
    action: 'tip_token_rotate',
    metadata: {
      oldTokenPrefix: row.tip_page_token.slice(0, 8),
      newTokenPrefix: newToken.slice(0, 8),
      oldStripeLinkId: row.stripe_payment_link_id || null,
      newStripeLinkId: id,
    },
  });

  res.json({ ok: true, token: newToken, url });
}));

// POST — rotate the Stripe Payment Link (deactivate old, create new). Token unchanged.
router.post('/contractors/:userId/tip-page/regenerate-stripe', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId)) throw new ValidationError('invalid userId');
  await ensureNonAdminTargetForManager(req, userId);

  const { rows } = await pool.query(`
    SELECT pp.tip_page_token, pp.stripe_payment_link_id, cp.preferred_name
    FROM payment_profiles pp
    LEFT JOIN contractor_profiles cp ON cp.user_id = pp.user_id
    WHERE pp.user_id = $1
  `, [userId]);
  const row = rows[0];
  if (!row || !row.tip_page_token) throw new NotFoundError('contractor has no tip page');

  if (row.stripe_payment_link_id) {
    try { await deactivateTipPaymentLink(row.stripe_payment_link_id); }
    catch (err) { console.error('[tip-admin] deactivate old link failed', err.message); }
  }

  const { url, id } = await createTipPaymentLink({
    userId,
    displayName: row.preferred_name,
    token: row.tip_page_token,
  });
  await pool.query(
    'UPDATE payment_profiles SET stripe_payment_link_url = $1, stripe_payment_link_id = $2 WHERE user_id = $3',
    [url, id, userId]
  );

  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: userId,
    action: 'tip_stripe_regenerate',
    metadata: {
      tokenPrefix: row.tip_page_token.slice(0, 8),
      oldStripeLinkId: row.stripe_payment_link_id || null,
      newStripeLinkId: id,
    },
  });

  res.json({ ok: true, url });
}));

// POST — create a Stripe link when one is missing (and ensure a token exists).
// Fails 409 if a link already exists — forces an explicit regenerate call.
router.post('/contractors/:userId/tip-page/generate-stripe', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId)) throw new ValidationError('invalid userId');
  await ensureNonAdminTargetForManager(req, userId);

  const { rows } = await pool.query(`
    SELECT pp.tip_page_token, pp.stripe_payment_link_url, cp.preferred_name
    FROM payment_profiles pp
    LEFT JOIN contractor_profiles cp ON cp.user_id = pp.user_id
    WHERE pp.user_id = $1
  `, [userId]);
  const row = rows[0];

  if (row && row.stripe_payment_link_url) {
    throw new ConflictError('Stripe link already exists; use regenerate', 'STRIPE_LINK_EXISTS');
  }

  let token = row && row.tip_page_token;
  if (!token) {
    token = uuidv4();
    await pool.query(`
      INSERT INTO payment_profiles (user_id, tip_page_token, tip_page_active)
      VALUES ($1, $2, TRUE)
      ON CONFLICT (user_id) DO UPDATE SET tip_page_token = COALESCE(payment_profiles.tip_page_token, $2)
    `, [userId, token]);
  }

  const displayName = (row && row.preferred_name) || 'your bartender';
  const { url, id } = await createTipPaymentLink({ userId, displayName, token });
  await pool.query(
    'UPDATE payment_profiles SET stripe_payment_link_url = $1, stripe_payment_link_id = $2 WHERE user_id = $3',
    [url, id, userId]
  );
  res.json({ ok: true, url });
}));

// POST — disable the page + deactivate Stripe link
router.post('/contractors/:userId/tip-page/deactivate', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId)) throw new ValidationError('invalid userId');
  await ensureNonAdminTargetForManager(req, userId);
  await deactivateTipPage(userId);
  res.json({ ok: true });
}));

// POST — re-enable the page + reactivate Stripe link
router.post('/contractors/:userId/tip-page/activate', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId)) throw new ValidationError('invalid userId');
  await ensureNonAdminTargetForManager(req, userId);
  await activateTipPage(userId);
  res.json({ ok: true });
}));

// ─── Tips Activity + Feedback Queue ──────────────────────────────

// All tips activity (admin-only — exposes customer emails + tip amounts)
router.get('/tips', auth, adminOnly, asyncHandler(async (req, res) => {
  const { bartender_id, from, to } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const cursor = parseInt(req.query.cursor, 10) || null;

  const filters = ['1=1'];
  const params = [];
  if (bartender_id) {
    filters.push(`t.target_user_id = $${params.length + 1}`);
    params.push(parseInt(bartender_id, 10));
  }
  if (from) {
    filters.push(`t.tipped_at >= $${params.length + 1}`);
    params.push(from);
  }
  if (to) {
    filters.push(`t.tipped_at <= $${params.length + 1}`);
    params.push(to);
  }
  if (cursor) {
    filters.push(`t.id < $${params.length + 1}`);
    params.push(cursor);
  }

  params.push(limit);
  const { rows } = await pool.query(`
    SELECT t.id, t.amount_cents, t.tipped_at, t.customer_email,
           cp.preferred_name AS bartender_name, t.target_user_id
    FROM tips t
    LEFT JOIN contractor_profiles cp ON cp.user_id = t.target_user_id
    WHERE ${filters.join(' AND ')}
    ORDER BY t.id DESC
    LIMIT $${params.length}
  `, params);

  res.json({
    tips: rows,
    next_cursor: rows.length === limit ? rows[rows.length - 1].id : null,
  });
}));

// Feedback queue (admin-only — exposes submitter emails + comments)
router.get('/tip-feedback', auth, adminOnly, asyncHandler(async (req, res) => {
  const status = req.query.status === 'reviewed' ? 'reviewed'
              : req.query.status === 'all' ? 'all' : 'unreviewed';

  let where = 'reviewed_at IS NULL';
  if (status === 'reviewed') where = 'reviewed_at IS NOT NULL';
  if (status === 'all') where = '1=1';

  const { rows } = await pool.query(`
    SELECT f.id, f.target_user_id, f.rating, f.comment, f.submitter_email,
           f.created_at, f.reviewed_at,
           cp.preferred_name AS bartender_name
    FROM tip_page_feedback f
    LEFT JOIN contractor_profiles cp ON cp.user_id = f.target_user_id
    WHERE ${where}
    ORDER BY f.created_at DESC
    LIMIT 200
  `);
  res.json({ feedback: rows });
}));

// Mark feedback reviewed (admin-only — mirrors the feedback view's gate)
router.post('/tip-feedback/:id/review', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new ValidationError('invalid id');

  await pool.query(`
    UPDATE tip_page_feedback
    SET reviewed_at = NOW(), reviewed_by = $1
    WHERE id = $2
  `, [req.user.id, id]);
  res.json({ ok: true });
}));

module.exports = router;
