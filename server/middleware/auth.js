const jwt = require('jsonwebtoken');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { AppError, PermissionError } = require('../utils/errors');

// Log access-control failures so a deliberate probe by a logged-in staff
// account is visible. OWASP A09 — admin/manager routes are the highest-
// stakes surface, so a 403 here is worth knowing about.
function logRoleDenial(req, requiredLabel) {
  try {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage(`Access denied: ${requiredLabel}`, {
        level: 'warning',
        tags: { event: 'role_denial', required: requiredLabel },
        extra: {
          user_id: req.user?.id || null,
          role: req.user?.role || null,
          method: req.method,
          path: req.originalUrl,
        },
      });
    }
  } catch (_) { /* never let logging break the response */ }
}

// Rejections route through next(AppError) — NOT res.status().json() and NOT a bare
// throw. `auth`/`clientAuth` are async, so a throw becomes an unhandled rejection in
// Express 4 (it doesn't await middleware); next(err) hands the AppError to the global
// error middleware, which emits the canonical { error, code } envelope so client-side
// `data.code` branching works the same here as for any route-thrown AppError.

const auth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return next(new AppError('No token provided', 401, 'NO_TOKEN'));

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query(
      'SELECT id, email, role, onboarding_status, can_hire, can_staff, token_version, pre_hired FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (!result.rows[0]) return next(new AppError('User not found', 401, 'USER_NOT_FOUND'));
    const u = result.rows[0];
    // Reject JWTs signed before the last password reset (token_version bump invalidates old sessions).
    if ((u.token_version ?? 0) !== (decoded.tokenVersion ?? 0)) {
      return next(new AppError('Session expired — please log in again', 401, 'TOKEN_VERSION_MISMATCH'));
    }
    // Block deactivated/rejected/suspended for every role EXCEPT admin. Admin is
    // exempt so a mis-set status can't lock the owner out of their own recovery
    // path; managers AND staff are gated (closes the suspended-manager bypass —
    // the check previously fired only for role 'staff').
    if (u.role !== 'admin') {
      if (u.onboarding_status === 'deactivated') {
        return next(new AppError('This account has been deactivated. Contact admin.', 403, 'ACCOUNT_DEACTIVATED'));
      }
      if (u.onboarding_status === 'rejected') {
        return next(new AppError('Your application was not selected at this time.', 403, 'APPLICATION_REJECTED'));
      }
      if (u.onboarding_status === 'suspended') {
        return next(new AppError('This account is temporarily suspended. Contact admin.', 403, 'ACCOUNT_SUSPENDED'));
      }
    }
    // Strip token_version from req.user — route handlers don't need it.
    const { token_version: _, ...userForReq } = u;
    req.user = userForReq;
    next();
  } catch (err) {
    return next(new AppError('Invalid token', 401, 'INVALID_TOKEN'));
  }
};

const adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    logRoleDenial(req, 'admin');
    return next(new PermissionError('Admin access required'));
  }
  next();
};

const requireAdminOrManager = (req, res, next) => {
  if (req.user?.role === 'admin' || req.user?.role === 'manager') return next();
  logRoleDenial(req, 'admin_or_manager');
  return next(new PermissionError('Admin access required.'));
};

const clientAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return next(new AppError('No token provided', 401, 'NO_TOKEN'));

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'client') return next(new AppError('Invalid token', 401, 'INVALID_TOKEN'));
    const result = await pool.query('SELECT id, name, email, phone FROM clients WHERE id = $1', [decoded.id]);
    if (!result.rows[0]) return next(new AppError('Client not found', 401, 'CLIENT_NOT_FOUND'));
    req.user = { ...result.rows[0], role: 'client' };
    next();
  } catch (err) {
    return next(new AppError('Invalid token', 401, 'INVALID_TOKEN'));
  }
};

module.exports = { auth, adminOnly, requireAdminOrManager, clientAuth };
