const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError } = require('../utils/errors');

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
  const { email, password, notifications_opt_in } = req.body;

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
    'INSERT INTO users (email, password_hash, notifications_opt_in) VALUES ($1, $2, $3) RETURNING id, email, role, onboarding_status, token_version',
    [email.toLowerCase(), hash, notifications_opt_in || false]
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

  const result = await pool.query('SELECT id, email, role, onboarding_status, can_hire, can_staff, password_hash, token_version FROM users WHERE email = $1', [normalizedEmail]);
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
    const appResult = await pool.query('SELECT id FROM applications WHERE user_id = $1', [req.user.id]);
    res.json({ user: { ...req.user, has_application: appResult.rows.length > 0 } });
  } catch (_err) {
    // Preserve existing fallback behavior — if the lookup fails, still return the user
    res.json({ user: req.user });
  }
}));

// Forgot password — request reset link
router.post('/forgot-password', authLimiter, asyncHandler(async (req, res) => {
  const { email } = req.body;
  // Keep generic success response for enumeration safety; still validate basic input
  if (!email) throw new ValidationError({ email: 'Email is required' });

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
