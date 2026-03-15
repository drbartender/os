const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');

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
    const { password_hash, ...safeUser } = user;
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
  } catch (err) {
    res.json({ user: req.user });
  }
});

module.exports = router;
