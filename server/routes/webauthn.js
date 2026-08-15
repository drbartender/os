const express = require('express');
const Sentry = require('@sentry/node');
const jwt = require('jsonwebtoken');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { webauthnLimiter } = require('../middleware/rateLimiters');
const { AppError, ValidationError, ConflictError, NotFoundError } = require('../utils/errors');

// WebAuthn passkey unlock for the phone admin surface (mobile-admin spec
// 2026-08-13 section 8). Mounted under /api/auth/webauthn/ so every response,
// including a failed assertion, sits inside the client's /auth/ 401-exclusion
// prefix and can never fire SessionExpiryHandler. assert-verify is the ONLY
// minting site for the 12-hour phone token; password login keeps its 7d mints.

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function rpId() {
  return process.env.WEBAUTHN_RP_ID
    || (process.env.NODE_ENV === 'production' ? 'admin.drbartender.com' : 'localhost');
}

function expectedOrigins() {
  if (process.env.WEBAUTHN_ORIGIN) return [process.env.WEBAUTHN_ORIGIN];
  return process.env.NODE_ENV === 'production'
    ? ['https://admin.drbartender.com']
    : ['http://localhost:3000', 'http://admin.localhost:3000'];
}

function captureWebauthnEvent(event, extra, level = 'warning') {
  try {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage(event, { level, tags: { event }, extra });
    }
  } catch (_) { /* telemetry must never break auth */ }
}

// The challenge the authenticator actually signed, straight out of
// clientDataJSON. The DB consume below proves WE issued it (single-use, TTL,
// kind); the verify call then proves the signature covers this same string.
function challengeFromClientData(response) {
  try {
    const json = JSON.parse(
      Buffer.from(response.response.clientDataJSON, 'base64').toString('utf8')
    );
    return typeof json.challenge === 'string' ? json.challenge : null;
  } catch (_) {
    return null;
  }
}

async function storeChallenge(kind, challenge, userId) {
  // Opportunistic sweep: no scheduler for a table this small.
  await pool.query('DELETE FROM webauthn_challenges WHERE expires_at < NOW()');
  await pool.query(
    'INSERT INTO webauthn_challenges (challenge, user_id, kind, expires_at) VALUES ($1, $2, $3, $4)',
    [challenge, userId, kind, new Date(Date.now() + CHALLENGE_TTL_MS)]
  );
}

// Single use: the DELETE is the claim, so two concurrent verifies of the same
// challenge cannot both win. Returns true when this caller claimed it.
async function consumeChallenge(kind, challenge, userId) {
  const r = await pool.query(
    `DELETE FROM webauthn_challenges
     WHERE challenge = $1 AND kind = $2 AND expires_at > NOW()
       AND user_id IS NOT DISTINCT FROM $3
     RETURNING id`,
    [challenge, kind, userId]
  );
  return r.rows.length > 0;
}

function createWebauthnRouter(overrides = {}) {
  const impl = {
    verifyRegistrationResponse,
    verifyAuthenticationResponse,
    ...overrides,
  };
  const router = express.Router();

  router.post('/register-options', webauthnLimiter, auth, asyncHandler(async (req, res) => {
    const creds = await pool.query(
      'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1',
      [req.user.id]
    );
    const options = await generateRegistrationOptions({
      rpName: 'DrB OS',
      rpID: rpId(),
      // The userHandle: assert-verify cross-checks it against the credential
      // row, so it must decode back to the user id.
      userID: Buffer.from(String(req.user.id)),
      userName: req.user.email,
      attestationType: 'none',
      excludeCredentials: creds.rows.map((c) => {
        // The route always writes JSON.stringify, but a hand-edited row must
        // degrade to no hint, never 500 the endpoint for this user.
        let transports;
        try { transports = c.transports ? JSON.parse(c.transports) : undefined; } catch (_) { transports = undefined; }
        return { id: c.credential_id, transports };
      }),
      // residentKey required: unlock is usernameless (assert-options sends no
      // allowCredentials; the platform authenticator picks the passkey).
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    await storeChallenge('register', options.challenge, req.user.id);
    res.json(options);
  }));

  router.post('/register-verify', webauthnLimiter, auth, asyncHandler(async (req, res) => {
    const { response, label } = req.body || {};
    if (!response || !response.response) {
      throw new ValidationError({ response: 'Missing WebAuthn response' });
    }
    const challenge = challengeFromClientData(response);
    if (!challenge || !(await consumeChallenge('register', challenge, req.user.id))) {
      throw new AppError('This enrollment attempt expired. Try again.', 400, 'WEBAUTHN_CHALLENGE_INVALID');
    }
    let verification;
    try {
      verification = await impl.verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: expectedOrigins(),
        expectedRPID: rpId(),
        requireUserVerification: true,
      });
    } catch (err) {
      captureWebauthnEvent('webauthn_register_failed', { user_id: req.user.id, message: err.message });
      throw new AppError('Passkey enrollment failed.', 400, 'WEBAUTHN_VERIFY_FAILED');
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new AppError('Passkey enrollment failed.', 400, 'WEBAUTHN_VERIFY_FAILED');
    }
    const { credential } = verification.registrationInfo;
    const inserted = await pool.query(
      `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, label)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (credential_id) DO NOTHING
       RETURNING id, label, created_at`,
      [
        req.user.id,
        credential.id,
        isoBase64URL.fromBuffer(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports || []),
        String(label || 'This phone').slice(0, 100),
      ]
    );
    if (!inserted.rows[0]) {
      throw new ConflictError('This passkey is already enrolled.', 'WEBAUTHN_DUPLICATE');
    }
    captureWebauthnEvent('webauthn_registered', { user_id: req.user.id }, 'info');
    res.status(201).json({ credential: inserted.rows[0] });
  }));

  router.get('/credentials', webauthnLimiter, auth, asyncHandler(async (req, res) => {
    const r = await pool.query(
      `SELECT id, label, created_at, last_used_at
       FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ credentials: r.rows });
  }));

  router.delete('/credentials/:id', webauthnLimiter, auth, asyncHandler(async (req, res) => {
    // Integer-range guard: an out-of-int4 id raises 22003 in Postgres and
    // 500s (same shape as the repo's 22P02 UUID-token lesson).
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) {
      throw new ValidationError({ id: 'Invalid credential id' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const del = await client.query(
        'DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2 RETURNING id',
        [id, req.user.id]
      );
      if (!del.rows[0]) {
        await client.query('ROLLBACK');
        throw new NotFoundError('Passkey not found');
      }
      // Revocation kills the LIVE tokens too (spec section 8): the per-user
      // token_version bump is a global logout by design, this session
      // included. The desktop performing the revoke simply logs back in.
      await client.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [req.user.id]);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
      throw e;
    } finally {
      client.release();
    }
    captureWebauthnEvent('webauthn_revoked', { user_id: req.user.id, credential_row: id }, 'info');
    res.json({ ok: true });
  }));

  router.post('/assert-options', webauthnLimiter, asyncHandler(async (req, res) => {
    const options = await generateAuthenticationOptions({
      rpID: rpId(),
      userVerification: 'required',
      // Usernameless: the platform authenticator picks the resident passkey.
      allowCredentials: [],
    });
    await storeChallenge('assert', options.challenge, null);
    res.json(options);
  }));

  router.post('/assert-verify', webauthnLimiter, asyncHandler(async (req, res) => {
    const { response } = req.body || {};
    if (!response || !response.id || !response.response) {
      throw new ValidationError({ response: 'Missing WebAuthn response' });
    }
    const challenge = challengeFromClientData(response);
    if (!challenge || !(await consumeChallenge('assert', challenge, null))) {
      throw new AppError('This unlock attempt expired. Try again.', 400, 'WEBAUTHN_CHALLENGE_INVALID');
    }

    // Uniform failure envelope for everything below: the endpoint must not be
    // usable to enumerate credential ids or account states. The DISCRIMINATING
    // code goes to Sentry only; the caller always sees the same status, message
    // AND code (the global error middleware emits err.code, so a per-case code
    // here would leak which branch fired: mid-lane security review, 2026-08-14).
    const fail = (code, extra) => {
      captureWebauthnEvent('webauthn_assert_failed', { code, ...extra });
      return new ConflictError('Unlock failed. Use your password.', 'WEBAUTHN_UNLOCK_FAILED');
    };

    const credRes = await pool.query(
      `SELECT wc.id AS cred_row_id, wc.user_id, wc.credential_id, wc.public_key, wc.counter,
              u.email, u.role, u.onboarding_status, u.can_hire, u.can_staff, u.token_version, u.pre_hired,
              cp.preferred_name
       FROM webauthn_credentials wc
       JOIN users u ON u.id = wc.user_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = wc.user_id
       WHERE wc.credential_id = $1`,
      [response.id]
    );
    const row = credRes.rows[0];
    if (!row) throw fail('WEBAUTHN_UNKNOWN_CREDENTIAL', {});

    // userHandle, when the authenticator reports one, must decode to the
    // account this credential belongs to. Type-guarded: Buffer.from throws on
    // non-strings, which would break the uniform envelope with a 500.
    const rawHandle = response.response.userHandle;
    const userHandle = typeof rawHandle === 'string'
      ? Buffer.from(rawHandle, 'base64').toString('utf8')
      : null;
    if (userHandle && userHandle !== String(row.user_id)) {
      throw fail('WEBAUTHN_USERHANDLE_MISMATCH', { user_id: row.user_id });
    }

    let verification;
    try {
      verification = await impl.verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: expectedOrigins(),
        expectedRPID: rpId(),
        credential: {
          id: row.credential_id,
          publicKey: isoBase64URL.toBuffer(row.public_key),
          counter: Number(row.counter),
        },
        requireUserVerification: true,
      });
    } catch (err) {
      throw fail('WEBAUTHN_VERIFY_FAILED', { user_id: row.user_id, message: err.message });
    }
    if (!verification.verified) throw fail('WEBAUTHN_VERIFY_FAILED', { user_id: row.user_id });

    // Same account-state gates as password login (routes/auth.js login).
    // These stay distinguishable on purpose (login parity) and are only
    // reachable behind a valid signed assertion.
    if (row.onboarding_status === 'deactivated') {
      throw new ConflictError('This account has been deactivated. Contact admin.', 'ACCOUNT_DEACTIVATED');
    }
    if (row.role === 'staff' && row.onboarding_status === 'rejected') {
      throw new ConflictError('Your application was not selected at this time. Questions? Contact contact@drbartender.com', 'APPLICATION_REJECTED');
    }

    // Cloned-credential signal (spec section 8): a stored counter > 0 that
    // fails to advance. Android authenticators that always report 0 never
    // trip this (0 stays 0). The UPDATE is the claim (atomic, so two
    // concurrent assertions cannot interleave a read-then-write and store a
    // regressed counter): zero rows = regression.
    const { newCounter } = verification.authenticationInfo;
    const advanced = await pool.query(
      `UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW()
       WHERE id = $2 AND (counter = 0 OR counter < $1) RETURNING id`,
      [newCounter, row.cred_row_id]
    );
    if (!advanced.rows[0]) {
      captureWebauthnEvent('webauthn_counter_regression',
        { user_id: row.user_id, credential_row: row.cred_row_id }, 'error');
      throw new ConflictError('Unlock failed. Use your password.', 'WEBAUTHN_UNLOCK_FAILED');
    }
    const appResult = await pool.query('SELECT id FROM applications WHERE user_id = $1', [row.user_id]);

    // The ONLY minting site for the phone-lifetime token (spec section 8):
    // 12 hours, credentialId claim is informational (audit lines + Sentry
    // context; middleware/auth.js never looks credentials up per-request).
    const token = jwt.sign(
      { userId: row.user_id, tokenVersion: row.token_version ?? 0, credentialId: row.credential_id },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    captureWebauthnEvent('webauthn_unlock', { user_id: row.user_id }, 'info');
    res.json({
      token,
      user: {
        id: row.user_id,
        email: row.email,
        role: row.role,
        onboarding_status: row.onboarding_status,
        can_hire: row.can_hire,
        can_staff: row.can_staff,
        pre_hired: row.pre_hired,
        preferred_name: row.preferred_name,
        has_application: appResult.rows.length > 0,
      },
    });
  }));

  return router;
}

module.exports = createWebauthnRouter();
module.exports.createWebauthnRouter = createWebauthnRouter;
