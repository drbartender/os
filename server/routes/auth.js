const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Simple email format check — rejects obvious non-emails before hitting the DB
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Register
router.post('/register', authLimiter, async (req, res) => {
  const { email, password, notifications_opt_in } = req.body;

  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows[0]) return res.status(409).json({ error: 'An account with this email already exists' });

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, notifications_opt_in) VALUES ($1, $2, $3) RETURNING id, email, role, onboarding_status',
      [email.toLowerCase(), hash, notifications_opt_in || false]
    );
    const user = result.rows[0];

    // Create onboarding progress record
    await pool.query(
      'INSERT INTO onboarding_progress (user_id, account_created) VALUES ($1, true)',
      [user.id]
    );

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { ...user, has_application: false } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    if (user.onboarding_status === 'deactivated') {
      return res.status(403).json({ error: 'This account has been deactivated. Contact admin.' });
    }
    if (user.role === 'staff' && user.onboarding_status === 'rejected') {
      return res.status(403).json({ error: 'Your application was not selected at this time. Questions? Contact contact@drbartender.com' });
    }

    // Check if user has an application on file
    const appResult = await pool.query('SELECT id FROM applications WHERE user_id = $1', [user.id]);

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const { password_hash: _, ...safeUser } = user;
    res.json({ token, user: { ...safeUser, has_application: appResult.rows.length > 0 } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user (includes has_application flag for routing)
router.get('/me', auth, async (req, res) => {
  try {
    const appResult = await pool.query('SELECT id FROM applications WHERE user_id = $1', [req.user.id]);
    res.json({ user: { ...req.user, has_application: appResult.rows.length > 0 } });
  } catch (_err) {
    res.json({ user: req.user });
  }
});

// Forgot password — request reset link
router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    // Always return success to prevent email enumeration
    const result = await pool.query('SELECT id, email FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];

    if (user) {
      // Generate token and store with 1-hour expiry
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Invalidate any existing tokens for this user
      await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);

      await pool.query(
        'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [user.id, token, expiresAt]
      );

      // Build reset URL
      const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
      const resetUrl = `${clientUrl}/reset-password/${token}`;

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
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset password — set new password with token
router.post('/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    // Find valid token
    const result = await pool.query(
      'SELECT * FROM password_reset_tokens WHERE token = $1 AND expires_at > NOW()',
      [token]
    );
    const resetRecord = result.rows[0];

    if (!resetRecord) {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    }

    // Hash new password and update user
    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, resetRecord.user_id]);

    // Invalidate the token
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [resetRecord.user_id]);

    res.json({ message: 'Password reset successfully.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
