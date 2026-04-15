const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { clientAuth } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const { clientOtp } = require('../utils/emailTemplates');

const router = express.Router();

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/client-auth/request — send OTP to client email
router.post('/request', otpLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const result = await pool.query(
      'SELECT id, name, email FROM clients WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    const client = result.rows[0];

    if (!client) {
      return res.json({ success: true });
    }

    // Generate 6-digit OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const hash = await bcrypt.hash(otp, 12);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await pool.query(
      'UPDATE clients SET auth_token = $1, auth_token_expires_at = $2 WHERE id = $3',
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
  } catch (err) {
    console.error('Client auth request error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/client-auth/verify — verify OTP and return JWT
router.post('/verify', otpLimiter, async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and code are required' });

  try {
    const result = await pool.query(
      'SELECT id, name, email, phone, auth_token, auth_token_expires_at FROM clients WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    const client = result.rows[0];

    if (!client || !client.auth_token || !client.auth_token_expires_at) {
      return res.status(401).json({ error: 'Invalid or expired code' });
    }

    // Check expiry
    if (new Date() > new Date(client.auth_token_expires_at)) {
      return res.status(401).json({ error: 'Invalid or expired code' });
    }

    // Check OTP hash
    const valid = await bcrypt.compare(otp, client.auth_token);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid or expired code' });
    }

    // Clear token fields
    await pool.query(
      'UPDATE clients SET auth_token = NULL, auth_token_expires_at = NULL WHERE id = $1',
      [client.id]
    );

    // Issue JWT
    const token = jwt.sign(
      { id: client.id, email: client.email, role: 'client' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      client: { id: client.id, name: client.name, email: client.email, phone: client.phone },
    });
  } catch (err) {
    console.error('Client auth verify error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/client-auth/me — get current client
router.get('/me', clientAuth, async (req, res) => {
  res.json({ client: { id: req.user.id, name: req.user.name, email: req.user.email, phone: req.user.phone } });
});

module.exports = router;
