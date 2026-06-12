// Unauthenticated email-change confirmation endpoint (spec section 6.10).
//
// Mounted at /api/me by server/index.js. NO router.use(auth) on purpose: a
// link in the user's inbox is the proof of intent. The lookup is by
// SHA-256(token), so possession of the raw token is enough to confirm — but
// the row carries the user_id, so any Authorization header on the request is
// IGNORED. A B-user JWT cannot redirect the confirmation to user A.
//
// The endpoint also bumps users.token_version so any pre-change JWT (which was
// signed with the OLD tokenVersion) is invalidated, forcing re-auth on the new
// address per spec section 6.10.

const express = require('express');
const Sentry = require('@sentry/node');
const crypto = require('crypto');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { emailChangeConfirmLimiter } = require('../middleware/rateLimiters');
const { sendEmail } = require('../utils/email');
const { emailChangeConfirmed } = require('../utils/lifecycleEmailTemplates');

const router = express.Router();
// Note: NO router.use(auth) — confirm is unauthenticated by design (spec 6.10).

// Stub seam — tests swap sendEmail to avoid hitting real Resend. Mirrors the
// pattern in staffPortal.js.
let _deps = { sendEmail };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

// Constant-time hex-string equality. Buffers must be the same length for
// timingSafeEqual; a wrong-length input is treated as a mismatch (never throws).
function constantTimeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

router.post('/confirm-email-change', emailChangeConfirmLimiter, asyncHandler(async (req, res) => {
  const rawToken = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!rawToken || rawToken.length > 512) {
    return res.status(410).json({ ok: false, reason: 'invalid_or_expired' });
  }

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  // SELECT the pending row. The unique index on token_hash WHERE consumed_at
  // IS NULL means at most one matching row in the not-yet-confirmed state.
  const lookupRes = await pool.query(
    `SELECT id, user_id, new_email, token_hash, expires_at
       FROM pending_email_changes
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > NOW()`,
    [tokenHash]
  );
  const pending = lookupRes.rows[0];
  if (!pending) {
    return res.status(410).json({ ok: false, reason: 'invalid_or_expired' });
  }

  // Defense in depth: re-verify the row's stored hash against the
  // re-derived hash using a constant-time compare. The WHERE clause already
  // matched, so this is only meaningful as protection against edge
  // timing-attack vectors in the SQL layer, but it's cheap and spec-mandated.
  if (!constantTimeHexEqual(pending.token_hash, tokenHash)) {
    return res.status(410).json({ ok: false, reason: 'invalid_or_expired' });
  }

  // Pull the user's current email for the audit log + the confirmation
  // email's recipient (sent to the OLD address per spec).
  const userRes = await pool.query(
    'SELECT id, email FROM users WHERE id = $1',
    [pending.user_id]
  );
  const user = userRes.rows[0];
  if (!user) {
    // The pending row's user was deleted between request and confirm. Treat
    // as invalid — same response shape so we don't leak existence.
    return res.status(410).json({ ok: false, reason: 'invalid_or_expired' });
  }
  const oldEmail = user.email;
  const newEmail = pending.new_email;

  // Transaction: bump email + token_version, consume the pending row, write
  // the audit row. All-or-nothing so a partial commit can't leave the user in
  // a half-changed state.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the pending row and re-check it's still unconsumed INSIDE the transaction.
    // The pre-transaction SELECT above can pass for several concurrent confirms of the
    // same token; this row lock serializes them so only the first bumps token_version +
    // writes the audit row, and the losers bail (audit 3b: double-confirm race).
    const lockRes = await client.query(
      'SELECT consumed_at FROM pending_email_changes WHERE id = $1 FOR UPDATE',
      [pending.id]
    );
    if (!lockRes.rows[0] || lockRes.rows[0].consumed_at !== null) {
      await client.query('ROLLBACK');
      return res.status(410).json({ ok: false, reason: 'invalid_or_expired' });
    }

    await client.query(
      `UPDATE users
          SET email = $2,
              token_version = COALESCE(token_version, 0) + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [pending.user_id, newEmail]
    );

    await client.query(
      `UPDATE pending_email_changes
          SET consumed_at = NOW()
        WHERE id = $1`,
      [pending.id]
    );

    await client.query(
      `INSERT INTO staff_audit_log (user_id, actor_type, actor_id, action, details)
       VALUES ($1, 'staff', $1, 'email_change_confirmed', $2)`,
      [pending.user_id, JSON.stringify({ old_email: oldEmail, new_email: newEmail })]
    );

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* gone */ }
    throw err;
  } finally {
    client.release();
  }

  // Notify the OLD address. Failure is non-fatal — the change already
  // committed; logging-only on the Sentry side.
  if (oldEmail) {
    try {
      const content = emailChangeConfirmed({ oldEmail, newEmail });
      await _deps.sendEmail({ to: oldEmail, ...content });
    } catch (err) {
      try {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(err, {
            tags: { route: 'emailChange.confirm', op: 'send_confirmed' },
            extra: { user_id: pending.user_id },
          });
        }
      } catch (_) { /* swallow */ }
    }
  }

  res.json({ ok: true });
}));

module.exports = router;
module.exports.__setDeps = __setDeps;
