// Client authentication (separate from staff auth)

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { clientAuth } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const { clientOtp } = require('../utils/emailTemplates');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError } = require('../utils/errors');

const router = express.Router();

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts. Please try again later.', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/client-auth/request — send OTP to client email
router.post('/request', otpLimiter, asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) throw new ValidationError({ email: 'Email is required' });

  const result = await pool.query(
    'SELECT id, name, email FROM clients WHERE LOWER(email) = LOWER($1)',
    [email]
  );
  const client = result.rows[0];

  if (!client) {
    // Neutral success response to avoid user enumeration.
    return res.json({ success: true });
  }

  // Generate 6-digit OTP
  const otp = crypto.randomInt(100000, 999999).toString();
  const hash = await bcrypt.hash(otp, 12);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  await pool.query(
    'UPDATE clients SET auth_token = $1, auth_token_expires_at = $2, auth_token_attempts = 0 WHERE id = $3',
    [hash, expiresAt, client.id]
  );

  // Send OTP email. Swallow send failures so we don't leak a user-enumeration
  // signal (known vs unknown emails) and don't leave an orphaned OTP in the DB.
  const template = clientOtp({ name: client.name, otp });
  try {
    await sendEmail({
      to: client.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
  } catch (mailErr) {
    console.error('OTP email send failed:', mailErr);
    try {
      await pool.query(
        'UPDATE clients SET auth_token = NULL, auth_token_expires_at = NULL WHERE id = $1',
        [client.id]
      );
    } catch (cleanupErr) {
      console.error('OTP cleanup after mail failure failed:', cleanupErr);
    }
  }

  // Always return the same neutral success response to avoid enumeration.
  return res.json({ success: true });
}));

// POST /api/client-auth/verify — verify OTP and return JWT
router.post('/verify', otpLimiter, asyncHandler(async (req, res) => {
  const { email, otp } = req.body;
  const fieldErrors = {};
  if (!email) fieldErrors.email = 'Email is required';
  if (!otp) fieldErrors.otp = 'Code is required';
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);

  const result = await pool.query(
    'SELECT id, name, email, phone, auth_token, auth_token_expires_at, token_version FROM clients WHERE LOWER(email) = LOWER($1)',
    [email]
  );
  const client = result.rows[0];

  if (!client || !client.auth_token || !client.auth_token_expires_at) {
    throw new ValidationError({ otp: 'This code is invalid or has expired' });
  }

  // Check expiry
  if (new Date() > new Date(client.auth_token_expires_at)) {
    throw new ValidationError({ otp: 'This code is invalid or has expired' });
  }

  // Per-account attempt ceiling. Defense-in-depth vs. distributed brute force
  // that the IP-based rate limiter can't see (e.g., attacker rotating IPs).
  // The increment IS the claim and runs BEFORE the compare, as one conditional
  // UPDATE (audit 2026-11-05 AUTH-04): the old read-then-compare-then-increment
  // order let N concurrent guesses all read the same count, all pass the
  // ceiling and all get a ~250 ms compare, so a burst from enough addresses
  // bypassed the limit entirely. Zero rows is the ceiling (or a token that went
  // away under us): the 6th attempt invalidates the OTP entirely and the user
  // must request a new code. The compare runs against the hash the claim
  // returned, never the pre-claim read.
  const claim = await pool.query(
    `UPDATE clients
        SET auth_token_attempts = COALESCE(auth_token_attempts, 0) + 1
      WHERE id = $1 AND auth_token IS NOT NULL AND COALESCE(auth_token_attempts, 0) < 5
      RETURNING auth_token, auth_token_expires_at`,
    [client.id]
  );
  if (!claim.rows[0]) {
    // Invalidate the OTP entirely (the user must request a new code), but return
    // the SAME neutral 400 as the wrong/unknown/expired cases (F6). A distinct 409
    // RATE_LIMITED was a membership oracle — it revealed the email existed AND had
    // a live OTP. The invalidation here still enforces the ceiling.
    await pool.query(
      'UPDATE clients SET auth_token = NULL, auth_token_expires_at = NULL, auth_token_attempts = 0 WHERE id = $1',
      [client.id]
    );
    throw new ValidationError({ otp: 'This code is invalid or has expired' });
  }

  // Check OTP hash. A wrong code is already counted by the claim above.
  const valid = await bcrypt.compare(otp, claim.rows[0].auth_token);
  if (!valid) {
    throw new ValidationError({ otp: 'This code is invalid or has expired' });
  }

  // Clear token fields (and reset attempt counter) on success.
  await pool.query(
    'UPDATE clients SET auth_token = NULL, auth_token_expires_at = NULL, auth_token_attempts = 0 WHERE id = $1',
    [client.id]
  );

  // Issue JWT
  const token = jwt.sign(
    { id: client.id, email: client.email, role: 'client', tokenVersion: client.token_version ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    client: { id: client.id, name: client.name, email: client.email, phone: client.phone },
  });
}));

// GET /api/client-auth/me — get current client
router.get('/me', clientAuth, asyncHandler(async (req, res) => {
  res.json({ client: { id: req.user.id, name: req.user.name, email: req.user.email, phone: req.user.phone } });
}));

module.exports = router;
