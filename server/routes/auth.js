const express = require('express');
const Sentry = require('@sentry/node');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError } = require('../utils/errors');
const { seedContractorProfileFromApplication } = require('../utils/contractorSeed');
const { writeActivityBestEffort, writeInterviewNoteBestEffort } = require('../utils/activityLog');

const router = express.Router();

// Per-account login lockout
const loginAttempts = new Map(); // email -> { count, firstAttempt }
const MAX_ATTEMPTS = 10;
const LOCKOUT_WINDOW = 15 * 60 * 1000; // 15 minutes

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Simple email format check — rejects obvious non-emails before hitting the DB
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Password must have uppercase, lowercase, and a digit
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

// Register
router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const fieldErrors = {};
  if (!email) fieldErrors.email = 'Email is required';
  else if (!EMAIL_RE.test(email)) fieldErrors.email = 'Please enter a valid email address';
  if (!password) fieldErrors.password = 'Password is required';
  else if (!PASSWORD_RE.test(password)) {
    fieldErrors.password = 'Password must be at least 8 characters with uppercase, lowercase, and a number.';
  }
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows[0]) {
    throw new ValidationError({ email: 'An account with this email already exists' });
  }

  const hash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, role, onboarding_status, token_version',
    [email.toLowerCase(), hash]
  );
  const user = result.rows[0];

  // Create onboarding progress record
  await pool.query(
    'INSERT INTO onboarding_progress (user_id, account_created) VALUES ($1, true)',
    [user.id]
  );

  const token = jwt.sign(
    { userId: user.id, tokenVersion: user.token_version ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.status(201).json({ token, user: { ...user, has_application: false } });
}));

// Register as a pre-hired contractor — open URL hand-off from admin
// (see docs/superpowers/specs/2026-05-13-pre-hire-onboarding-design.md).
// Identical to POST /register except the new user has pre_hired=true so the
// application-submit handler can promote them to 'hired' (instead of 'applied')
// and seed contractor_profiles automatically — skipping the admin-review wait.
router.post('/register-pre-hired', authLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const fieldErrors = {};
  if (!email) fieldErrors.email = 'Email is required';
  else if (!EMAIL_RE.test(email)) fieldErrors.email = 'Please enter a valid email address';
  if (!password) fieldErrors.password = 'Password is required';
  else if (!PASSWORD_RE.test(password)) {
    fieldErrors.password = 'Password must be at least 8 characters with uppercase, lowercase, and a number.';
  }
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);

  const normalizedEmail = email.toLowerCase();

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  if (existing.rows[0]) {
    throw new ValidationError({ email: 'An account with this email already exists' });
  }

  const hash = await bcrypt.hash(password, 12);

  // Wrap users + onboarding_progress in one transaction so a partial failure
  // can't leave a pre_hired user with no progress row (the existing /register
  // endpoint tolerates that via a defensive seed in the admin hire path; we
  // tighten this new endpoint because pre_hired is load-bearing for the next
  // step). The audit-log INSERT is written AFTER COMMIT via writeActivityBestEffort.
  const client = await pool.connect();
  let user;
  try {
    await client.query('BEGIN');

    const userRes = await client.query(
      `INSERT INTO users (email, password_hash, pre_hired)
       VALUES ($1, $2, true)
       RETURNING id, email, role, onboarding_status, token_version, pre_hired`,
      [normalizedEmail, hash]
    );
    user = userRes.rows[0];

    await client.query(
      'INSERT INTO onboarding_progress (user_id, account_created) VALUES ($1, true)',
      [user.id]
    );

    await client.query('COMMIT');
  } catch (txErr) {
    try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    // Narrow the unique-violation mapping: only treat the users.email collision
    // as a duplicate-email error. A 23505 on the onboarding_progress.user_id
    // constraint (rare — would require a leftover row from a deleted-and-recreated
    // user) should NOT lie about its cause to the caller.
    if (txErr && txErr.code === '23505' && (txErr.constraint === 'users_email_key' || txErr.table === 'users')) {
      throw new ValidationError({ email: 'An account with this email already exists' });
    }
    throw txErr;
  } finally {
    client.release();
  }

  // Audit trail (post-commit, best-effort) — distinguishes /onboarding signups
  // from /register signups so a recruit who registers but never applies still
  // appears in the activity feed.
  await writeActivityBestEffort({
    user_id: user.id,
    actor_id: user.id,
    event_type: 'pre_hire_registered',
    metadata: { via: 'register_pre_hired_endpoint' },
    source: 'POST /auth/register-pre-hired',
  });

  const token = jwt.sign(
    { userId: user.id, tokenVersion: user.token_version ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.status(201).json({ token, user: { ...user, has_application: false } });
}));

// Mark the current user as a pre-hired contractor. Used by the /onboarding
// landing page when an already-logged-in user visits it (returning recruit,
// or someone who registered at /register before being told about /onboarding).
// Handles three cases inside one transaction:
//   - 'in_progress' (no application yet)        → just set pre_hired=true
//   - 'applied'     (application submitted)     → flip status to 'hired' AND
//                                                  seed contractor_profiles
//                                                  (same as POST /application would
//                                                  have done if pre_hired was true
//                                                  at submit time) AND write
//                                                  audit entries to interview_notes
//                                                  + application_activity
//   - anything else (already 'hired'/'interviewing'/'rejected'/etc.) → no-op
// Rate-limited via authLimiter and gated to role='staff' (admins/managers have
// no business setting pre_hired on themselves). No emails fire — the recruit
// is already on /onboarding and lands on /welcome immediately; the admin gets
// the application_activity trail in lieu of an inbox notification, mirroring
// the choice in POST /application for pre_hired submitters.
router.post('/claim-pre-hire', authLimiter, auth, asyncHandler(async (req, res) => {
  // Pre-hire is a contractor-onboarding concept — admins and managers shouldn't
  // self-flag (the data state would be nonsensical and the flag has no effect
  // on their flows). Treat as a no-op for non-staff. Admins/managers don't
  // have applications by design, so has_application is false.
  if (req.user.role !== 'staff') {
    return res.json({ user: { ...req.user, has_application: false } });
  }

  const status = req.user.onboarding_status;
  if (status !== 'in_progress' && status !== 'applied') {
    // Already past the application gate (or rejected/deactivated). The flag's
    // only effect is at application-submit time, which is past — back-filling
    // it now would be pointless. Return the current user unchanged.
    // has_application is implicit: only 'in_progress' can have no application.
    return res.json({ user: { ...req.user, has_application: true } });
  }

  const client = await pool.connect();
  let updated;
  let promoted = false;
  try {
    await client.query('BEGIN');

    // Re-read the user row WITH ROW-LEVEL LOCK before reading status. Without
    // this, an admin moving the user 'applied' → 'interviewing' (or 'rejected'
    // etc.) concurrently with the /onboarding visit could be silently
    // overwritten by our UPDATE. Mirrors the same guard in POST /application.
    const lockRes = await client.query(
      `SELECT pre_hired, onboarding_status FROM users WHERE id = $1 FOR UPDATE`,
      [req.user.id]
    );
    if (lockRes.rows.length === 0) {
      throw new ConflictError('Account not found', 'NOT_FOUND');
    }
    const freshStatus = lockRes.rows[0].onboarding_status;

    if (freshStatus === 'applied') {
      // Flip 'applied' → 'hired' AND seed contractor_profiles, mirroring what
      // POST /application would have done if pre_hired had been true at submit.
      const r = await client.query(
        `UPDATE users SET pre_hired = true, onboarding_status = 'hired' WHERE id = $1
         RETURNING id, email, role, onboarding_status, can_hire, can_staff, pre_hired`,
        [req.user.id]
      );
      updated = r.rows[0];
      await seedContractorProfileFromApplication(client, req.user.id, null);
      promoted = true;
    } else if (freshStatus === 'in_progress') {
      // 'in_progress' — flag only; the application submit will promote them later.
      const r = await client.query(
        `UPDATE users SET pre_hired = true WHERE id = $1
         RETURNING id, email, role, onboarding_status, can_hire, can_staff, pre_hired`,
        [req.user.id]
      );
      updated = r.rows[0];
    } else {
      // Status changed between auth-middleware read and our FOR UPDATE — the
      // user is no longer eligible for the pre-hire promotion (e.g. admin
      // moved them to 'interviewing', 'rejected', etc. while we were running).
      // Treat as a no-op: roll back, return the current user without writes.
      await client.query('ROLLBACK');
      const appResult = await pool.query('SELECT id FROM applications WHERE user_id = $1', [req.user.id]);
      return res.json({ user: { ...req.user, onboarding_status: freshStatus, has_application: appResult.rows.length > 0 } });
    }

    await client.query('COMMIT');
  } catch (txErr) {
    try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw txErr;
  } finally {
    client.release();
  }

  // Audit writes run AFTER COMMIT (best-effort) on separate pool connections,
  // pipelined via Promise.all so the two writes don't sequentially block each
  // other. They cannot affect the primary state change.
  if (promoted) {
    await Promise.all([
      writeInterviewNoteBestEffort({
        user_id: req.user.id,
        admin_id: req.user.id,
        note: 'Applied → Hired (via /onboarding self-claim)',
        source: 'POST /auth/claim-pre-hire',
      }),
      writeActivityBestEffort({
        user_id: req.user.id,
        actor_id: req.user.id,
        event_type: 'status_changed',
        metadata: { from: 'applied', to: 'hired', via: 'claim_pre_hire' },
        source: 'POST /auth/claim-pre-hire',
      }),
    ]);
  } else {
    await writeActivityBestEffort({
      user_id: req.user.id,
      actor_id: req.user.id,
      event_type: 'pre_hire_claimed',
      metadata: { via: 'claim_pre_hire' },
      source: 'POST /auth/claim-pre-hire',
    });
  }

  // has_application is now derivable without an extra SELECT: a 'promoted'
  // user transitioned 'applied' → 'hired' so by definition has an application.
  // A non-promoted user (status was 'in_progress') has no application yet.
  // The 'no-op' early-return paths above still need the SELECT for the few
  // statuses where we can't short-circuit (e.g. 'interviewing' might or might
  // not have one — though in practice 'interviewing' always does).
  res.json({ user: { ...updated, has_application: promoted } });
}));

// Login
router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    throw new ConflictError('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  const normalizedEmail = email.toLowerCase();

  // Check per-account lockout
  const attempts = loginAttempts.get(normalizedEmail);
  if (attempts) {
    if (Date.now() - attempts.firstAttempt > LOCKOUT_WINDOW) {
      loginAttempts.delete(normalizedEmail);
    } else if (attempts.count >= MAX_ATTEMPTS) {
      throw new ConflictError('Too many attempts. Please try again later.', 'RATE_LIMITED');
    }
  }

  const result = await pool.query('SELECT u.id, u.email, u.role, u.onboarding_status, u.can_hire, u.can_staff, u.password_hash, u.token_version, cp.preferred_name FROM users u LEFT JOIN contractor_profiles cp ON cp.user_id = u.id WHERE u.email = $1', [normalizedEmail]);
  const user = result.rows[0];
  if (!user) {
    throw new ConflictError('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    // Track failed attempt
    const existing = loginAttempts.get(normalizedEmail);
    if (existing && Date.now() - existing.firstAttempt <= LOCKOUT_WINDOW) {
      existing.count += 1;
    } else {
      loginAttempts.set(normalizedEmail, { count: 1, firstAttempt: Date.now() });
    }
    console.warn('Failed login attempt for', email, 'from IP', req.ip);
    throw new ConflictError('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  // Clear lockout on successful login
  loginAttempts.delete(normalizedEmail);

  if (user.onboarding_status === 'deactivated') {
    throw new ConflictError('This account has been deactivated. Contact admin.', 'ACCOUNT_DEACTIVATED');
  }
  if (user.role === 'staff' && user.onboarding_status === 'rejected') {
    throw new ConflictError('Your application was not selected at this time. Questions? Contact contact@drbartender.com', 'APPLICATION_REJECTED');
  }

  // Check if user has an application on file
  const appResult = await pool.query('SELECT id FROM applications WHERE user_id = $1', [user.id]);

  const token = jwt.sign(
    { userId: user.id, tokenVersion: user.token_version ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  const { password_hash: _, ...safeUser } = user;
  res.json({ token, user: { ...safeUser, has_application: appResult.rows.length > 0 } });
}));

// Get current user (includes has_application flag for routing)
router.get('/me', auth, asyncHandler(async (req, res) => {
  try {
    // One round trip for both the routing flag and the staff display name.
    // preferred_name lives on contractor_profiles (NULL for admins / pre-hire),
    // and the client shell + HomePage greeting read it to avoid showing the
    // email local-part.
    const ctx = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM applications WHERE user_id = $1) AS has_application,
              (SELECT preferred_name FROM contractor_profiles WHERE user_id = $1) AS preferred_name`,
      [req.user.id]
    );
    res.json({ user: { ...req.user, has_application: ctx.rows[0].has_application, preferred_name: ctx.rows[0].preferred_name } });
  } catch (_err) {
    // Surface the failed lookup to Sentry (the fallback below hides it from the client),
    // then preserve existing behavior: still return req.user so the session keeps working.
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(_err, { tags: { route: 'auth.me' } });
    }
    res.json({ user: req.user });
  }
}));

// Forgot password — request reset link
router.post('/forgot-password', authLimiter, asyncHandler(async (req, res) => {
  const { email } = req.body;
  // Missing OR malformed input can't match a real account: short-circuit before
  // the DB lookup with the same generic response, so neither the absence of an
  // email nor its format can enumerate accounts. Both cases return identically.
  if (!email || !EMAIL_RE.test(email)) {
    return res.json({ message: 'If an account exists with that email, a password reset link has been sent.' });
  }

  // Always return success to prevent email enumeration
  const result = await pool.query('SELECT id, email FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = result.rows[0];

  if (user) {
    // Generate a high-entropy raw token for the email link, but store ONLY a
    // SHA-256 hash so a DB/log/backup leak can't be used to take over accounts.
    // (UUIDs were too low-entropy AND stored as plaintext — both fixed here.)
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Invalidate any existing tokens for this user
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);

    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    );

    // Build reset URL with the raw token (the only place it ever exists in plaintext)
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
    const resetUrl = `${clientUrl}/reset-password/${rawToken}`;

    await sendEmail({
      to: user.email,
      subject: 'Reset Your Password — Dr. Bartender',
      html: `
        <div style="font-family: Georgia, serif; max-width: 500px; margin: 0 auto; padding: 2rem;">
          <h2 style="color: #3e2a1a;">Password Reset</h2>
          <p style="color: #6b5a4e; line-height: 1.6;">
            We received a request to reset the password for your Dr. Bartender account.
            Click the link below to set a new password:
          </p>
          <p style="margin: 1.5rem 0;">
            <a href="${resetUrl}" style="background: #3e2a1a; color: #fff; padding: 0.75rem 1.5rem; border-radius: 8px; text-decoration: none; display: inline-block;">
              Reset Password
            </a>
          </p>
          <p style="color: #8a7a6a; font-size: 0.85rem; line-height: 1.5;">
            This link expires in 1 hour. If you didn't request this, you can safely ignore this email.
          </p>
        </div>
      `,
      text: `Reset your Dr. Bartender password: ${resetUrl}\n\nThis link expires in 1 hour.`,
    }).catch(err => {
      console.error('Failed to send reset email:', err);
    });
  }

  res.json({ message: 'If an account exists with that email, a password reset link has been sent.' });
}));

// Reset password — set new password with token
router.post('/reset-password', authLimiter, asyncHandler(async (req, res) => {
  const { token, password } = req.body;

  const fieldErrors = {};
  if (!token) fieldErrors.token = 'Reset token is required';
  if (!password) fieldErrors.password = 'Password is required';
  else if (!PASSWORD_RE.test(password)) {
    fieldErrors.password = 'Password must be at least 8 characters with uppercase, lowercase, and a number.';
  }
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);

  // Hash the submitted raw token and look up by hash — the DB never holds the
  // raw token, so a DB leak yields nothing the attacker can use.
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const result = await pool.query(
    'SELECT * FROM password_reset_tokens WHERE token = $1 AND expires_at > NOW()',
    [tokenHash]
  );
  const resetRecord = result.rows[0];

  if (!resetRecord) {
    throw new ValidationError({ token: 'This reset link is invalid or has expired' });
  }

  // Hash new password and update user; bump token_version to invalidate existing JWTs.
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    'UPDATE users SET password_hash = $1, token_version = token_version + 1, updated_at = NOW() WHERE id = $2',
    [hash, resetRecord.user_id]
  );

  // Invalidate the reset token
  await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [resetRecord.user_id]);

  res.json({ message: 'Password reset successfully.' });
}));

module.exports = router;
