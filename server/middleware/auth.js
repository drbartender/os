const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const auth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query(
      'SELECT id, email, role, onboarding_status, can_hire, can_staff, token_version FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (!result.rows[0]) return res.status(401).json({ error: 'User not found' });
    const u = result.rows[0];
    // Reject JWTs signed before the last password reset (token_version bump invalidates old sessions).
    if ((u.token_version ?? 0) !== (decoded.tokenVersion ?? 0)) {
      return res.status(401).json({ error: 'Session expired — please log in again', code: 'TOKEN_VERSION_MISMATCH' });
    }
    // Block deactivated/rejected — but only for regular staff, not admins/managers
    if (u.role === 'staff') {
      if (u.onboarding_status === 'deactivated') {
        return res.status(403).json({ error: 'This account has been deactivated. Contact admin.' });
      }
      if (u.onboarding_status === 'rejected') {
        return res.status(403).json({ error: 'Your application was not selected at this time.' });
      }
    }
    // Strip token_version from req.user — route handlers don't need it.
    const { token_version: _, ...userForReq } = u;
    req.user = userForReq;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

const requireAdminOrManager = (req, res, next) => {
  if (req.user?.role === 'admin' || req.user?.role === 'manager') return next();
  return res.status(403).json({ error: 'Admin access required.' });
};

const clientAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'client') return res.status(401).json({ error: 'Invalid token' });
    const result = await pool.query('SELECT id, name, email, phone FROM clients WHERE id = $1', [decoded.id]);
    if (!result.rows[0]) return res.status(401).json({ error: 'Client not found' });
    req.user = { ...result.rows[0], role: 'client' };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = { auth, adminOnly, requireAdminOrManager, clientAuth };
