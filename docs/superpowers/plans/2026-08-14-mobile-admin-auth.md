# Mobile Admin Auth (lane ma-d-auth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WebAuthn biometric unlock for the phone admin PWA per spec section 8: passkey enrollment, a 12-hour phone JWT minted only by a verified assertion, the 30-minute background lock, desktop credential management with the global-logout revoke, and the AuthContext/SessionExpiryHandler 401-and-transport fixes that make offline cold launch land behind the lock instead of on Login.

**Architecture:** The credential IS the device session: a `webauthn_credentials` row plus a fresh JWT per assertion, no second bearer token. A new route file `server/routes/webauthn.js` mounts under `/api/auth/webauthn/` (inside the client's `/auth/` 401-exclusion prefix) and is the ONLY minting site for the 12h token; `middleware/auth.js` is untouched (the token carries the same `{userId, tokenVersion}` claims plus an informational `credentialId` the middleware ignores). Client-side, a small pure "lock model" module decides when the phone surface locks; one `MobileLockScreen` component renders it in two mounts (a ProtectedRoute gate when no live user, an AdminLayout overlay when the session dies or the 30-minute background timer fires); AuthContext gains a four-way purge law so a transport failure or an expired-token-on-enrolled-phone never wipes the offline cache, while revocation still kills everything.

**Tech Stack:** `@simplewebauthn/server` ^13.3.2 (root package.json) + `@simplewebauthn/browser` ^13.3.0 (client/package.json), both new dependencies. Node 26 `node --test` with the repo's hand-rolled `node:http` harness (no supertest), jest + RTL 13 on the client, `playwright-core` with the CDP virtual authenticator for the browser pass.

**Spec:** `docs/superpowers/specs/2026-08-13-mobile-admin-design.md` section 8 (auth), with sections 7 (offline law), 9 (resume), 11 (testing, auth lane owns the auth-route test debt).

**Scope:** Lane ma-d-auth only. Declared in the foundation plan's lane map (`docs/superpowers/plans/2026-08-13-mobile-admin-foundation.md`), inheriting its review fleet. ma-a-shell and ma-b-pwa are merged AND pushed to prod, so this lane cuts from a main that already carries the phone chrome and the v7 service worker.

**Proven context (verified against the repo 2026-08-14, not from memory):**
- `server/routes/auth.js` mints 7d JWTs at exactly three sites (register :74, register-pre-hired :157, login :349), each `{ userId, tokenVersion }`. `authLimiter` (max 10 / 15 min) lives in this file and has NO test-env skip today. Password reset already bumps `token_version` (:472).
- `server/middleware/auth.js:46` rejects on `token_version` mismatch with code `TOKEN_VERSION_MISMATCH`; an expired/garbled JWT lands in the catch as 401 `INVALID_TOKEN`; a deleted user is 401 `USER_NOT_FOUND`. Extra JWT claims are ignored. Nothing in this lane touches the middleware.
- `client/src/utils/api.js:50`: 401s on URLs starting `/auth/` (axios-relative, baseURL adds `/api`) never dispatch `session-expired`. Everything under `/api/auth/webauthn/` is therefore safe for the unlock path.
- `client/src/context/AuthContext.js`: bootstrap catch purges + clears on ANY `err.status === 401` and clears the token on every rejection (:52-53, the pre-existing transport-clear defect this lane owns); `refreshUser` purges on 401 (:91-95); `login()` (:61) stores the token, sets user, announces the SW namespace.
- `client/src/components/SessionExpiryHandler.js`: `firedRef` once-only guard never resets; on fire it toasts, logs out, navigates `/login`.
- `client/src/components/AdminLayout.js`: `MobileViewProvider` wraps `AdminLayoutInner` (:282-288); the route-restore one-shot and `mobile-route-dead` listener live in the inner component; `document.documentElement` gets `data-app="admin-os"` in an effect (:62-79).
- `client/src/App.js`: `ProtectedRoute` (:295) redirects `/login` when `!user`; `SessionExpiryHandler` mounts at :654 OUTSIDE AdminLayout (no MobileViewContext available there); `SettingsDashboard` route at :606.
- `client/src/hooks/useIsPhone.js`: `PHONE_BREAKPOINT_PX = 700` exported; the media query string `(max-width: 699px)` is module-local (Task 6 exports it).
- `client/public/admin-sw.js`: v7; `API_EXACT` allowlist at :182; late 401/403 evicts the cached entry (:297); per-user namespace via announce; the stub deploy is the only real SW kill.
- `client/src/utils/adminSw.js:46`: `PHONE_LOCAL_KEYS = ['adminDesktopViewOverrides', 'adminLastRoute']`, purged by `purgeMobileAdminState()`.
- `scripts/sensitive-paths.txt` :287-301 ALREADY lists every section-8 path (webauthn.js, auth.js, AuthContext, SessionExpiryHandler, admin-sw.js, admin-manifest.json, the injector) plus `middleware/rateLimiters.js`, `server/db/schema.sql`, `server/index.js`, `.env.example`. No sensitive-list edit is needed in this lane; the fleet fires mechanically.
- `server/middleware/rateLimiters.js` is the shared limiter home; five limiters already use `skip: () => process.env.NODE_ENV === 'test'`.
- Error classes: `ValidationError` 400, `ConflictError` 409 (login failures are 409 `INVALID_CREDENTIALS`), `NotFoundError` 404. The client sees `err.status` / `err.message` / `err.fieldErrors`.
- Server route tests: hand-rolled `node:http` harness, `require('dotenv').config()` + `NODE_ENV='test'` first lines, fixture rows in the SHARED dev DB with nonce'd emails, cleanup in `after` (exemplar: `server/routes/auth.preferredName.test.js`). Suites run ONE AT A TIME from repo root.
- Client tests: no `setupTests.js`; every test imports `'@testing-library/jest-dom'` itself. RTL 13.4.
- `@simplewebauthn` v13 shapes: `generateRegistrationOptions` takes `userID` as a `Uint8Array` (becomes the userHandle), `verifyRegistrationResponse` returns `registrationInfo.credential = { id, publicKey, counter, transports }`, browser calls take `{ optionsJSON }`. Helpers: `isoBase64URL` from `@simplewebauthn/server/helpers`.
- Schema exemplar for hashed-token tables: `pending_email_changes` (`schema.sql:3603`). `users.token_version` at :307. New DDL appends at end of file, idempotent.
- Prod DDL: dev picks up schema.sql on server boot; prod gets the DDL run against Neon BEFORE the push that deploys this code (spec section 8). Neon MCP can write to prod (round-tooth-34649976).

## Global Constraints

- **No em dashes** in any copy, comment prose, or doc text. Commas, colons, parentheses only.
- **Max effort, everywhere.** Every file in this lane is auth. The full 5-agent fleet (code-review, consistency-check, security-review, database-review, second-opinion) runs per-lane before merge; all paths are already sensitive-listed so the push-time fleet re-fires mechanically.
- **Session law:** `POST /api/auth/webauthn/assert-verify` is the ONLY site that mints the 12h token. Password login keeps minting 7d at its three existing sites. No client-declared "I am a phone" flag anywhere; the minting site is the discriminator.
- **RP ID law:** `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` env-overridable; prod defaults `admin.drbartender.com` / `https://admin.drbartender.com`; dev defaults rpID `localhost` with origins `http://localhost:3000` and `http://admin.localhost:3000`. Never a bare-domain RP ID (one bundle serves four hosts; an admin passkey must not assert from the public/hiring/staff origins).
- **Challenge law:** server-issued, DB-stored, single-use (the DELETE is the claim), 5-minute TTL, swept opportunistically on the options endpoints. Assertions without a live matching challenge are rejected.
- **Purge law (client):** four classes of `/auth/me` failure. Revoked (`TOKEN_VERSION_MISMATCH`, `USER_NOT_FOUND`): purge + sign out. Plain 401 with phone unlock NOT armed: purge + sign out (today's behavior). Plain 401 with phone unlock armed (enrolled passkey + phone viewport): keep token artifact and caches, the lock screen owns re-entry. Transport failure or any other status: keep everything.
- **SW law:** unchanged from ma-b (allowlist, transport-failure-only fallback, never non-GET). This lane adds exactly one allowlist path (`/api/auth/me`) and bumps `SW_VERSION`.
- **Uniform assert failures:** unknown credential, userHandle mismatch, failed signature, and counter regression all answer the same 409 envelope to the caller (codes differ for Sentry, message identical), so the endpoint cannot be used to enumerate credential ids.
- **One pooled connection per request** inside any transaction (revoke endpoint); `pool.query` elsewhere.
- **Server tests:** `node --test server/routes/webauthn.test.js` etc., one suite at a time, from repo root (shared dev DB).
- **Client gate:** `cd client && CI=true npx react-scripts build` before any commit touching `client/`.
- **Frontend API calls** through `client/src/utils/api.js` only. CSS appended to `index.css`, scoped `html[data-app="admin-os"]`. New files aim under 300 lines.
- **Explicit staging only**; commit messages carry NO backticks (use plain quotes).
- **Docs law:** README folder tree + Tech Stack + env table, ARCHITECTURE route table + Database Schema + auth section, CLAUDE.md env-vars table, all in this lane (Task 12).

## Lane map

```yaml
lanes:
  - id: ma-d-auth
    phase: 1
    scope: >
      WebAuthn biometric unlock per spec section 8: webauthn_credentials +
      webauthn_challenges tables, register/assert endpoints under
      /api/auth/webauthn/, 12h phone JWT (credential = device session),
      30-minute background lock + lock screen (gate + overlay mounts),
      enrollment nudge + More row, desktop Settings passkey management with
      global-logout revoke, AuthContext purge law + SessionExpiryHandler
      phone claim + guard reset, admin-sw /auth/me allowlist (v8), the full
      server auth-route test suite the spec says this lane owes.
    footprint:
      - package.json
      - package-lock.json
      - server/db/schema.sql
      - server/routes/webauthn.js
      - server/routes/webauthn.test.js
      - server/routes/auth.js
      - server/routes/auth.core.test.js
      - server/middleware/rateLimiters.js
      - server/middleware/rateLimiters.test.js
      - server/index.js
      - .env.example
      - client/package.json
      - client/package-lock.json
      - client/src/hooks/useIsPhone.js
      - client/src/utils/mobileLock.js
      - client/src/utils/mobileLock.test.js
      - client/src/utils/webauthnClient.js
      - client/src/utils/adminSw.js
      - client/public/admin-sw.js
      - client/src/context/AuthContext.js
      - client/src/context/AuthContext.test.js
      - client/src/components/SessionExpiryHandler.js
      - client/src/components/SessionExpiryHandler.test.js
      - client/src/components/mobile/MobileLockScreen.js
      - client/src/components/mobile/MobileLockScreen.test.js
      - client/src/components/mobile/PasskeyEnrollNudge.js
      - client/src/components/mobile/PasskeyEnrollNudge.test.js
      - client/src/components/AdminLayout.js
      - client/src/App.js
      - client/src/pages/mobile/MorePage.js
      - client/src/pages/admin/SecuritySettings.js
      - client/src/pages/admin/SettingsDashboard.js
      - client/src/index.css
      - README.md
      - ARCHITECTURE.md
      - .claude/CLAUDE.md
      - docs/walkthroughs-owed.md
    depends_on: []  # ma-a-shell and ma-b-pwa are merged and pushed; nothing pending blocks this lane
    review_fleet: [code-review, consistency-check, security-review, database-review, second-opinion]
```

---

### Task 1: Dependencies, schema DDL, env contract

**Files:**
- Modify: `package.json` + `package-lock.json` (add `@simplewebauthn/server`)
- Modify: `client/package.json` + `client/package-lock.json` (add `@simplewebauthn/browser`)
- Modify: `server/db/schema.sql` (append two tables)
- Modify: `.env.example` (two vars)

**Interfaces:**
- Produces: tables `webauthn_credentials` (user_id, credential_id UNIQUE, public_key, counter, transports, label, created_at, last_used_at) and `webauthn_challenges` (challenge UNIQUE, user_id NULLABLE, kind register|assert, expires_at); env vars `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` (both optional, defaults in code).

- [ ] **Step 1: Install the server library**

Run from repo root: `npm install @simplewebauthn/server@^13.3.2`
Expected: package.json gains the dependency; `node -e "console.log(Object.keys(require('@simplewebauthn/server')))"` prints the four generate/verify functions.

- [ ] **Step 2: Install the browser library**

Run: `cd client && npm install @simplewebauthn/browser@^13.3.0 && cd ..`

- [ ] **Step 3: Append the DDL to `server/db/schema.sql`** (end of file, idempotent, patterned after `pending_email_changes`)

```sql
-- ─── WebAuthn passkeys (mobile-admin spec 2026-08-13 section 8) ───
-- The credential IS the device session: assert-verify checks a row here and
-- mints a fresh 12h JWT. No separate device token exists. Revoke = delete the
-- row AND bump users.token_version (global logout, deliberate blast radius).
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,        -- base64url, as the authenticator reports it
  public_key TEXT NOT NULL,                  -- base64url COSE public key bytes
  counter BIGINT NOT NULL DEFAULT 0,         -- signature counter; regression = cloned-credential signal
  transports TEXT,                           -- JSON array from registration, feeds excludeCredentials hints
  label VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id);

-- Server-issued WebAuthn challenges: single-use (the DELETE on verify is the
-- claim), 5-minute TTL, swept opportunistically by the options endpoints.
-- user_id is NULL for assert challenges (the phone is locked, nobody is
-- authenticated); register challenges bind to the enrolling user.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id SERIAL PRIMARY KEY,
  challenge VARCHAR(255) NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('register', 'assert')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);
```

- [ ] **Step 4: Apply to the dev DB**

Restart the Claude-managed dev server (boot runs the idempotent schema), then verify:
`node -e "const {pool}=require('./server/db'); pool.query(\"SELECT to_regclass('webauthn_credentials') a, to_regclass('webauthn_challenges') b\").then(r=>{console.log(r.rows[0]); pool.end();})"`
Expected: both non-null.

- [ ] **Step 5: Add the env contract to `.env.example`** (near the auth/JWT block)

```
# WebAuthn (mobile-admin phone unlock, spec 2026-08-13 section 8). Both
# OPTIONAL: code defaults to admin.drbartender.com / https://admin.drbartender.com
# in production and localhost origins in dev. The RP ID is pinned to the admin
# host on purpose: one bundle serves four hosts, and a bare-domain RP ID would
# let an admin passkey assert from the public/hiring/staff origins.
WEBAUTHN_RP_ID=
WEBAUTHN_ORIGIN=
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json client/package.json client/package-lock.json server/db/schema.sql .env.example
git commit -m "ma-d-auth: simplewebauthn deps, webauthn tables, env contract (spec s8)"
```

---

### Task 2: `webauthnLimiter`

**Files:**
- Modify: `server/middleware/rateLimiters.js`
- Modify: `server/middleware/rateLimiters.test.js`

**Interfaces:**
- Produces: `webauthnLimiter` export (15 min window, max 30, IP-keyed, test-env skip), consumed by every route in `server/routes/webauthn.js`.

- [ ] **Step 1: Write the failing test** (append to `rateLimiters.test.js`, matching the file's existing style for asserting limiter config)

```js
test('webauthnLimiter exists, is IP-keyed, and skips in test env', () => {
  const { webauthnLimiter } = require('./rateLimiters');
  assert.equal(typeof webauthnLimiter, 'function');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/middleware/rateLimiters.test.js`
Expected: FAIL (webauthnLimiter undefined).

- [ ] **Step 3: Implement** (before the module.exports block; add `webauthnLimiter` to the export list)

```js
// WebAuthn unlock + enrollment (mobile-admin spec 2026-08-13 section 8).
// Deliberately separate from the login authLimiter in routes/auth.js so
// biometric unlock retries neither ride nor exhaust the password-login
// lockout budget. IP-keyed because assert-options/assert-verify run
// unauthenticated (the phone is locked when they fire). Skipped under
// NODE_ENV=test (matches calcomWebhookLimiter) so the webauthn suite's many
// requests from one address do not trip the bucket.
const webauthnLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many unlock attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test server/middleware/rateLimiters.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/middleware/rateLimiters.js server/middleware/rateLimiters.test.js
git commit -m "ma-d-auth: dedicated webauthn rate limiter, separate from the login budget"
```

---

### Task 3: `server/routes/webauthn.js`: registration + credential management

**Files:**
- Create: `server/routes/webauthn.js`
- Create: `server/routes/webauthn.test.js`
- Modify: `server/index.js` (mount)

**Interfaces:**
- Consumes: `webauthnLimiter` (Task 2), tables (Task 1), `auth` middleware, `AppError`/`ValidationError`/`ConflictError`/`NotFoundError`.
- Produces: module.exports = the router; `module.exports.createWebauthnRouter(overrides)` factory whose `overrides` may replace `verifyRegistrationResponse` / `verifyAuthenticationResponse` (test seam: the library's crypto is its own tested code, the suite pins OUR logic). Endpoints this task: `POST /register-options` (auth), `POST /register-verify` (auth), `GET /credentials` (auth), `DELETE /credentials/:id` (auth). Mounted at `/api/auth/webauthn`.

- [ ] **Step 1: Write the route file**

```js
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
      excludeCredentials: creds.rows.map((c) => ({
        id: c.credential_id,
        transports: c.transports ? JSON.parse(c.transports) : undefined,
      })),
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
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new ValidationError({ id: 'Invalid credential id' });
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

  // assert-options / assert-verify are added in the next task's steps; the
  // factory shape is final from the start.

  return router;
}

module.exports = createWebauthnRouter();
module.exports.createWebauthnRouter = createWebauthnRouter;
```

- [ ] **Step 2: Mount in `server/index.js`** (insert the line IMMEDIATELY BEFORE the existing `/api/auth` mount at :298)

```js
// Webauthn passkey routes live under the /api/auth/ prefix ON PURPOSE (the
// client's 401 interceptor excludes /auth/ URLs from the session-expired
// dispatch); mounted before the auth router so the more specific prefix is
// matched first.
app.use('/api/auth/webauthn', require('./routes/webauthn'));
app.use('/api/auth', require('./routes/auth'));
```

- [ ] **Step 3: Write the failing test harness + registration/management cases** (`server/routes/webauthn.test.js`)

```js
require('dotenv').config();
process.env.NODE_ENV = 'test';

// Webauthn route matrix (spec section 8 + section 11). The simplewebauthn
// verify calls are injected as stubs via createWebauthnRouter: the library's
// crypto is its own tested code; THIS suite pins OUR logic (challenge
// single-use + TTL + kind, counter regression, account gates, uniform
// failures, IDOR on revoke, the token_version bump, the 12h mint). Mirrors
// the hand-rolled node:http harness in auth.preferredName.test.js.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { createWebauthnRouter } = require('./webauthn');

let server;
let baseUrl;
let userA; let tokenA; // enrolling user
let userB; let tokenB; // second user, for IDOR checks

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// Injected verify stubs, reset per test.
let verifyRegistrationImpl;
let verifyAuthenticationImpl;

function b64url(objOrBuf) {
  const buf = Buffer.isBuffer(objOrBuf) ? objOrBuf : Buffer.from(JSON.stringify(objOrBuf));
  return buf.toString('base64url');
}
// A response body whose clientDataJSON carries the given challenge; the verify
// stub never inspects the rest.
function assertionBody(challenge, credentialId, userHandle) {
  return {
    response: {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: b64url({ type: 'webauthn.get', challenge, origin: 'http://localhost:3000' }),
        authenticatorData: b64url(Buffer.from('authdata')),
        signature: b64url(Buffer.from('sig')),
        ...(userHandle ? { userHandle: b64url(Buffer.from(userHandle)) } : {}),
      },
      clientExtensionResults: {},
    },
  };
}
function attestationBody(challenge) {
  return {
    response: {
      id: 'ignored-by-stub',
      rawId: 'ignored-by-stub',
      type: 'public-key',
      response: {
        clientDataJSON: b64url({ type: 'webauthn.create', challenge, origin: 'http://localhost:3000' }),
        attestationObject: b64url(Buffer.from('att')),
      },
      clientExtensionResults: {},
    },
    label: 'Test phone',
  };
}

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (_e) { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function makeUser(tag, extra = {}) {
  const email = `webauthn-test-${tag}-${NONCE}@example.com`;
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', $2, $3, 0) RETURNING id, token_version`,
    [email, extra.role || 'admin', extra.onboarding_status || 'approved']
  );
  const token = jwt.sign(
    { userId: r.rows[0].id, tokenVersion: r.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  return { id: r.rows[0].id, email, token };
}

before(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'webauthn-test-%'");
  const a = await makeUser('a');
  const b = await makeUser('b');
  userA = a; tokenA = a.token;
  userB = b; tokenB = b.token;

  const routerUnderTest = createWebauthnRouter({
    verifyRegistrationResponse: (...args) => verifyRegistrationImpl(...args),
    verifyAuthenticationResponse: (...args) => verifyAuthenticationImpl(...args),
  });
  const authRouter = require('./auth');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth/webauthn', routerUnderTest);
  app.use('/api/auth', authRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

beforeEach(async () => {
  // Happy-path stubs by default; individual tests override.
  verifyRegistrationImpl = async () => ({
    verified: true,
    registrationInfo: {
      credential: {
        id: `cred-${NONCE}`,
        publicKey: Buffer.from('public-key-bytes'),
        counter: 0,
        transports: ['internal'],
      },
    },
  });
  verifyAuthenticationImpl = async () => ({
    verified: true,
    authenticationInfo: { newCounter: 0 },
  });
  await pool.query('DELETE FROM webauthn_challenges');
  await pool.query('DELETE FROM webauthn_credentials WHERE user_id IN ($1, $2)', [userA.id, userB.id]);
  await pool.query('UPDATE users SET token_version = 0 WHERE id IN ($1, $2)', [userA.id, userB.id]);
});

after(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'webauthn-test-%'");
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// Enroll userA via the stubbed happy path; returns the credential_id.
async function enroll() {
  const opts = await request('POST', '/api/auth/webauthn/register-options', { token: tokenA });
  assert.equal(opts.status, 200);
  const verify = await request('POST', '/api/auth/webauthn/register-verify', {
    token: tokenA,
    body: attestationBody(opts.body.challenge),
  });
  assert.equal(verify.status, 201);
  return `cred-${NONCE}`;
}

test('register-options requires auth', async () => {
  const res = await request('POST', '/api/auth/webauthn/register-options');
  assert.equal(res.status, 401);
});

test('register-options stores a register challenge bound to the user', async () => {
  const res = await request('POST', '/api/auth/webauthn/register-options', { token: tokenA });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.challenge, 'string');
  const row = await pool.query(
    'SELECT kind, user_id FROM webauthn_challenges WHERE challenge = $1', [res.body.challenge]
  );
  assert.equal(row.rows[0].kind, 'register');
  assert.equal(row.rows[0].user_id, userA.id);
});

test('register-verify rejects an unknown challenge', async () => {
  const res = await request('POST', '/api/auth/webauthn/register-verify', {
    token: tokenA,
    body: attestationBody('never-issued'),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'WEBAUTHN_CHALLENGE_INVALID');
});

test('register-verify rejects an expired challenge', async () => {
  await pool.query(
    `INSERT INTO webauthn_challenges (challenge, user_id, kind, expires_at)
     VALUES ('expired-ch', $1, 'register', NOW() - INTERVAL '1 minute')`,
    [userA.id]
  );
  const res = await request('POST', '/api/auth/webauthn/register-verify', {
    token: tokenA,
    body: attestationBody('expired-ch'),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'WEBAUTHN_CHALLENGE_INVALID');
});

test('a register challenge cannot be spent by a different user', async () => {
  const opts = await request('POST', '/api/auth/webauthn/register-options', { token: tokenA });
  const res = await request('POST', '/api/auth/webauthn/register-verify', {
    token: tokenB,
    body: attestationBody(opts.body.challenge),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'WEBAUTHN_CHALLENGE_INVALID');
});

test('register happy path inserts the credential and burns the challenge', async () => {
  const opts = await request('POST', '/api/auth/webauthn/register-options', { token: tokenA });
  const first = await request('POST', '/api/auth/webauthn/register-verify', {
    token: tokenA,
    body: attestationBody(opts.body.challenge),
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.credential.label, 'Test phone');
  const row = await pool.query(
    'SELECT user_id, counter FROM webauthn_credentials WHERE credential_id = $1', [`cred-${NONCE}`]
  );
  assert.equal(row.rows[0].user_id, userA.id);
  // Single use: replaying the same body fails on the consumed challenge.
  const replay = await request('POST', '/api/auth/webauthn/register-verify', {
    token: tokenA,
    body: attestationBody(opts.body.challenge),
  });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.code, 'WEBAUTHN_CHALLENGE_INVALID');
});

test('credentials list is scoped to the caller', async () => {
  await enroll();
  const mine = await request('GET', '/api/auth/webauthn/credentials', { token: tokenA });
  assert.equal(mine.body.credentials.length, 1);
  const theirs = await request('GET', '/api/auth/webauthn/credentials', { token: tokenB });
  assert.equal(theirs.body.credentials.length, 0);
});

test('revoke: another user cannot delete my credential (404), owner can, and the bump kills live tokens', async () => {
  await enroll();
  const row = await pool.query('SELECT id FROM webauthn_credentials WHERE user_id = $1', [userA.id]);
  const credRowId = row.rows[0].id;

  const idor = await request('DELETE', `/api/auth/webauthn/credentials/${credRowId}`, { token: tokenB });
  assert.equal(idor.status, 404);

  const ok = await request('DELETE', `/api/auth/webauthn/credentials/${credRowId}`, { token: tokenA });
  assert.equal(ok.status, 200);

  // token_version bumped: the pre-revoke JWT is dead at the middleware.
  const me = await request('GET', '/api/auth/me', { token: tokenA });
  assert.equal(me.status, 401);
  assert.equal(me.body.code, 'TOKEN_VERSION_MISMATCH');
});
```

- [ ] **Step 4: Run to verify**

Run: `node --test server/routes/webauthn.test.js`
Expected: all Task 3 cases PASS (the file has no assert-verify cases yet). If a v13 API-shape mismatch surfaces (option names, registrationInfo shape), fix the ROUTE to match the installed library, not the test.

- [ ] **Step 5: Boot check**

Restart the dev server; hit `GET /api/auth/webauthn/credentials` with a dev JWT and confirm `{"credentials":[]}` (proves the mount order and the limiter wiring).

- [ ] **Step 6: Commit**

```bash
git add server/routes/webauthn.js server/routes/webauthn.test.js server/index.js
git commit -m "ma-d-auth: webauthn registration + credential management, mounted under /api/auth/webauthn"
```

---

### Task 4: assert-options / assert-verify: the unlock mint

**Files:**
- Modify: `server/routes/webauthn.js`
- Modify: `server/routes/webauthn.test.js`

**Interfaces:**
- Produces: `POST /assert-options` (unauthenticated, usernameless), `POST /assert-verify` (unauthenticated) returning `{ token, user }` with the SAME user payload shape as `POST /auth/login` (id, email, role, onboarding_status, can_hire, can_staff, pre_hired, preferred_name, has_application). The token is a 12h JWT `{ userId, tokenVersion, credentialId }`. Task 6's `unlockWithPasskey()` consumes this contract.

- [ ] **Step 1: Add the two routes inside `createWebauthnRouter`** (before `return router`)

```js
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
    // usable to enumerate credential ids or account states. Codes differ only
    // for Sentry; the message and status are identical.
    const fail = (code, extra) => {
      captureWebauthnEvent('webauthn_assert_failed', { code, ...extra });
      return new ConflictError('Unlock failed. Use your password.', code);
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
    // account this credential belongs to.
    const userHandle = response.response.userHandle
      ? Buffer.from(response.response.userHandle, 'base64').toString('utf8')
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

    // Cloned-credential signal (spec section 8): a stored counter > 0 that
    // fails to advance. Android authenticators that always report 0 never
    // trip this (0 stays 0).
    const { newCounter } = verification.authenticationInfo;
    if (Number(row.counter) > 0 && newCounter <= Number(row.counter)) {
      captureWebauthnEvent('webauthn_counter_regression',
        { user_id: row.user_id, credential_row: row.cred_row_id }, 'error');
      throw new ConflictError('Unlock failed. Use your password.', 'WEBAUTHN_COUNTER_REGRESSION');
    }

    // Same account-state gates as password login (routes/auth.js login).
    if (row.onboarding_status === 'deactivated') {
      throw new ConflictError('This account has been deactivated. Contact admin.', 'ACCOUNT_DEACTIVATED');
    }
    if (row.role === 'staff' && row.onboarding_status === 'rejected') {
      throw new ConflictError('Your application was not selected at this time. Questions? Contact contact@drbartender.com', 'APPLICATION_REJECTED');
    }

    await pool.query(
      'UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE id = $2',
      [newCounter, row.cred_row_id]
    );
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
```

- [ ] **Step 2: Append the assert cases to `webauthn.test.js`**

```js
async function assertOptions() {
  const res = await request('POST', '/api/auth/webauthn/assert-options');
  assert.equal(res.status, 200);
  return res.body.challenge;
}

test('assert-options stores an unbound assert challenge', async () => {
  const challenge = await assertOptions();
  const row = await pool.query(
    'SELECT kind, user_id FROM webauthn_challenges WHERE challenge = $1', [challenge]
  );
  assert.equal(row.rows[0].kind, 'assert');
  assert.equal(row.rows[0].user_id, null);
});

test('an assert challenge cannot be spent on register-verify (kind mismatch)', async () => {
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/register-verify', {
    token: tokenA,
    body: attestationBody(challenge),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'WEBAUTHN_CHALLENGE_INVALID');
});

test('assert-verify happy path: 12h mint, counter + last_used_at written, token passes middleware', async () => {
  const credId = await enroll();
  verifyAuthenticationImpl = async () => ({ verified: true, authenticationInfo: { newCounter: 7 } });
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, userA.id);
  assert.equal(typeof res.body.user.has_application, 'boolean');

  const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
  assert.equal(decoded.userId, userA.id);
  assert.equal(decoded.credentialId, credId);
  const lifetime = decoded.exp - decoded.iat;
  assert.ok(lifetime > 11.9 * 3600 && lifetime <= 12 * 3600, `12h mint, got ${lifetime}s`);

  const row = await pool.query('SELECT counter, last_used_at FROM webauthn_credentials WHERE credential_id = $1', [credId]);
  assert.equal(Number(row.rows[0].counter), 7);
  assert.ok(row.rows[0].last_used_at);

  const me = await request('GET', '/api/auth/me', { token: res.body.token });
  assert.equal(me.status, 200);
});

test('assert challenge is single-use', async () => {
  const credId = await enroll();
  const challenge = await assertOptions();
  const first = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(first.status, 200);
  const replay = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.code, 'WEBAUTHN_CHALLENGE_INVALID');
});

test('unknown credential fails with the uniform envelope', async () => {
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, 'no-such-credential'),
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'Unlock failed. Use your password.');
});

test('userHandle mismatch fails with the uniform envelope', async () => {
  const credId = await enroll();
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userB.id)),
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'Unlock failed. Use your password.');
});

test('failed signature verification fails uniformly and mints nothing', async () => {
  const credId = await enroll();
  verifyAuthenticationImpl = async () => { throw new Error('bad signature'); };
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.token, undefined);
});

test('counter regression is rejected and the stored counter is untouched', async () => {
  const credId = await enroll();
  await pool.query('UPDATE webauthn_credentials SET counter = 10 WHERE credential_id = $1', [credId]);
  verifyAuthenticationImpl = async () => ({ verified: true, authenticationInfo: { newCounter: 10 } });
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(res.status, 409);
  const row = await pool.query('SELECT counter FROM webauthn_credentials WHERE credential_id = $1', [credId]);
  assert.equal(Number(row.rows[0].counter), 10);
});

test('always-zero counters never trip the regression check', async () => {
  const credId = await enroll();
  verifyAuthenticationImpl = async () => ({ verified: true, authenticationInfo: { newCounter: 0 } });
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(res.status, 200);
});

test('deactivated account cannot unlock', async () => {
  const credId = await enroll();
  await pool.query("UPDATE users SET onboarding_status = 'deactivated' WHERE id = $1", [userA.id]);
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ACCOUNT_DEACTIVATED');
  await pool.query("UPDATE users SET onboarding_status = 'approved' WHERE id = $1", [userA.id]);
});

test('a version-bumped session artifact does not block a fresh unlock (new mint carries the new version)', async () => {
  const credId = await enroll();
  await pool.query('UPDATE users SET token_version = 3 WHERE id = $1', [userA.id]);
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(res.status, 200);
  const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
  assert.equal(decoded.tokenVersion, 3);
  const me = await request('GET', '/api/auth/me', { token: res.body.token });
  assert.equal(me.status, 200);
});
```

- [ ] **Step 3: Run to verify**

Run: `node --test server/routes/webauthn.test.js`
Expected: full suite PASS.

- [ ] **Step 4: Commit**

```bash
git add server/routes/webauthn.js server/routes/webauthn.test.js
git commit -m "ma-d-auth: assert endpoints, uniform failures, counter rule, the only 12h minting site"
```

---

### Task 5: The auth-route suite the spec says this lane owes

**Files:**
- Create: `server/routes/auth.core.test.js`
- Modify: `server/routes/auth.js` (ONE change: test-env skip on `authLimiter`)

**Interfaces:**
- Consumes: the existing auth router unchanged except the limiter skip.
- Produces: coverage for login, register, forgot/reset password, and /me (spec section 11: "the full server auth-route test suite does not exist today; the auth lane writes it").

- [ ] **Step 1: Add the test-env skip to `authLimiter`** (in `server/routes/auth.js`, matching the five existing limiters in `middleware/rateLimiters.js`)

```js
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  // The auth suite fires more than 10 requests from one address; the
  // per-account lockout below still runs in tests (it is account-keyed and
  // is itself under test). NODE_ENV=test is never set in prod (Render sets
  // production); same posture as calcomWebhookLimiter and friends.
  skip: () => process.env.NODE_ENV === 'test',
});
```

- [ ] **Step 2: Write the suite** (`server/routes/auth.core.test.js`; same harness pattern as `webauthn.test.js`, own nonce prefix `auth-core-test-`)

```js
require('dotenv').config();
process.env.NODE_ENV = 'test';

// The auth-route suite the mobile-admin spec (section 11) says this lane
// owes: login, register, forgot/reset password, /me. Same hand-rolled
// node:http harness as auth.preferredName.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const authRouter = require('./auth');

let server;
let baseUrl;
const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const email = (tag) => `auth-core-test-${tag}-${NONCE}@example.com`;
const PASSWORD = 'GoodPass1';

// request(...) helper: identical to the one in webauthn.test.js.
function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (_e) { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'auth-core-test-%'");
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', authRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'auth-core-test-%'");
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('register validates email format and password strength as field errors', async () => {
  const res = await request('POST', '/api/auth/register', {
    body: { email: 'not-an-email', password: 'weak' },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors.email);
  assert.ok(res.body.fieldErrors.password);
});

test('register happy path mints a working 7d token and an onboarding row', async () => {
  const res = await request('POST', '/api/auth/register', {
    body: { email: email('reg'), password: PASSWORD },
  });
  assert.equal(res.status, 201);
  const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
  assert.equal(decoded.userId, res.body.user.id);
  const lifetime = decoded.exp - decoded.iat;
  assert.ok(lifetime > 6.9 * 86400, 'password mints stay 7d');
  const prog = await pool.query('SELECT account_created FROM onboarding_progress WHERE user_id = $1', [res.body.user.id]);
  assert.equal(prog.rows[0].account_created, true);
});

test('register rejects a duplicate email', async () => {
  await request('POST', '/api/auth/register', { body: { email: email('dup'), password: PASSWORD } });
  const res = await request('POST', '/api/auth/register', { body: { email: email('dup'), password: PASSWORD } });
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors.email);
});

test('login: success returns user + token; wrong password is a generic 409', async () => {
  await request('POST', '/api/auth/register', { body: { email: email('login'), password: PASSWORD } });
  const ok = await request('POST', '/api/auth/login', { body: { email: email('login'), password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.body.user.has_application, 'boolean');

  const bad = await request('POST', '/api/auth/login', { body: { email: email('login'), password: 'WrongPass1' } });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, 'INVALID_CREDENTIALS');
});

test('login: 10 failed attempts trip the per-account lockout', async () => {
  await request('POST', '/api/auth/register', { body: { email: email('lock'), password: PASSWORD } });
  for (let i = 0; i < 10; i += 1) {
    await request('POST', '/api/auth/login', { body: { email: email('lock'), password: 'WrongPass1' } });
  }
  const res = await request('POST', '/api/auth/login', { body: { email: email('lock'), password: PASSWORD } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'RATE_LIMITED');
});

test('login: deactivated account is refused', async () => {
  const reg = await request('POST', '/api/auth/register', { body: { email: email('deact'), password: PASSWORD } });
  await pool.query("UPDATE users SET onboarding_status = 'deactivated' WHERE id = $1", [reg.body.user.id]);
  const res = await request('POST', '/api/auth/login', { body: { email: email('deact'), password: PASSWORD } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ACCOUNT_DEACTIVATED');
});

test('/me returns the authenticated user', async () => {
  const reg = await request('POST', '/api/auth/register', { body: { email: email('me'), password: PASSWORD } });
  const res = await request('GET', '/api/auth/me', { token: reg.body.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, reg.body.user.id);
});

test('forgot-password answers identically for unknown and known emails', async () => {
  const unknown = await request('POST', '/api/auth/forgot-password', { body: { email: email('ghost') } });
  await request('POST', '/api/auth/register', { body: { email: email('fp'), password: PASSWORD } });
  const known = await request('POST', '/api/auth/forgot-password', { body: { email: email('fp') } });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, known.body);
});

test('reset-password: hashed token flow works and the version bump kills old sessions', async () => {
  const reg = await request('POST', '/api/auth/register', { body: { email: email('reset'), password: PASSWORD } });
  const userId = reg.body.user.id;
  const oldToken = reg.body.token;

  // Seed the reset row exactly as forgot-password does: store the sha256 hash.
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await pool.query(
    "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')",
    [userId, tokenHash]
  );

  const weak = await request('POST', '/api/auth/reset-password', { body: { token: rawToken, password: 'weak' } });
  assert.equal(weak.status, 400);

  const ok = await request('POST', '/api/auth/reset-password', { body: { token: rawToken, password: 'NewGoodPass1' } });
  assert.equal(ok.status, 200);

  const oldMe = await request('GET', '/api/auth/me', { token: oldToken });
  assert.equal(oldMe.status, 401);
  assert.equal(oldMe.body.code, 'TOKEN_VERSION_MISMATCH');

  const relogin = await request('POST', '/api/auth/login', { body: { email: email('reset'), password: 'NewGoodPass1' } });
  assert.equal(relogin.status, 200);

  const reuse = await request('POST', '/api/auth/reset-password', { body: { token: rawToken, password: 'NewGoodPass1' } });
  assert.equal(reuse.status, 400);
});
```

- [ ] **Step 3: Run both auth suites, one at a time**

Run: `node --test server/routes/auth.core.test.js`, then `node --test server/routes/auth.preferredName.test.js` (regression: the limiter skip must not break it).
Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add server/routes/auth.core.test.js server/routes/auth.js
git commit -m "ma-d-auth: auth-route core suite (spec s11 debt) + test-env skip on authLimiter"
```

---

### Task 6: Client lock model + webauthn client + purge keys

**Files:**
- Modify: `client/src/hooks/useIsPhone.js` (export the query string)
- Create: `client/src/utils/mobileLock.js`
- Create: `client/src/utils/mobileLock.test.js`
- Create: `client/src/utils/webauthnClient.js`
- Modify: `client/src/utils/adminSw.js` (purge keys)

**Interfaces:**
- Produces from `useIsPhone.js`: `export const PHONE_MEDIA_QUERY` (the existing module-local QUERY string, now shared so the lock check can never drift from the fork).
- Produces from `mobileLock.js`: `LOCK_AFTER_MS`, `LAST_ACTIVE_KEY`, `ENROLLED_KEY`, `NUDGE_DISMISSED_KEY`, `touchLastActive(now?)`, `readLastActive()`, `passkeyEnrolledHere()`, `markPasskeyEnrolled()`, `nudgeDismissed()`, `dismissNudge()`, `tokenExpMs(token)`, `isPhoneViewport()`, `phoneUnlockArmed()`, `shouldLock({token, lastActiveAt, armed, now?})`, `setMobileLockHandler(fn)` (returns unregister), `requestMobileLock()` (true only when a registered handler accepted).
- Produces from `webauthnClient.js`: `isPasskeySupported()`, `registerPasskey(label)`, `unlockWithPasskey()` returning `{ token, user }` (Task 4 contract).

- [ ] **Step 1: Export the media query from `useIsPhone.js`**

Change line 7 from `const QUERY = ...` to:

```js
export const PHONE_MEDIA_QUERY = `(max-width: ${PHONE_BREAKPOINT_PX - 1}px)`;
const QUERY = PHONE_MEDIA_QUERY;
```

- [ ] **Step 2: Write the failing tests** (`client/src/utils/mobileLock.test.js`)

```js
import '@testing-library/jest-dom';
import {
  LOCK_AFTER_MS, requestMobileLock, setMobileLockHandler, shouldLock, tokenExpMs,
} from './mobileLock';

function fakeJwt(expSeconds) {
  const payload = Buffer.from(JSON.stringify({ userId: 1, exp: expSeconds }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${payload}.sig`;
}

describe('tokenExpMs', () => {
  it('decodes the exp claim to ms', () => {
    expect(tokenExpMs(fakeJwt(1000))).toBe(1000 * 1000);
  });
  it('returns null on garbage', () => {
    expect(tokenExpMs('not-a-jwt')).toBeNull();
    expect(tokenExpMs(null)).toBeNull();
  });
});

describe('shouldLock', () => {
  const now = 10_000_000_000;
  const liveToken = fakeJwt((now + 3600_000) / 1000);
  it('never locks when not armed or without a token', () => {
    expect(shouldLock({ token: liveToken, lastActiveAt: 0, armed: false, now })).toBe(false);
    expect(shouldLock({ token: null, lastActiveAt: 0, armed: true, now })).toBe(false);
  });
  it('locks when the token is expired', () => {
    expect(shouldLock({ token: fakeJwt((now - 1000) / 1000), lastActiveAt: now, armed: true, now })).toBe(true);
  });
  it('locks after 30 minutes backgrounded, not before', () => {
    expect(shouldLock({ token: liveToken, lastActiveAt: now - LOCK_AFTER_MS - 1, armed: true, now })).toBe(true);
    expect(shouldLock({ token: liveToken, lastActiveAt: now - LOCK_AFTER_MS + 1000, armed: true, now })).toBe(false);
  });
  it('does not lock on a fresh launch with no recorded timestamp and a live token', () => {
    expect(shouldLock({ token: liveToken, lastActiveAt: null, armed: true, now })).toBe(false);
  });
  it('does not lock on an unreadable token that is not expired-proven', () => {
    expect(shouldLock({ token: 'garbage', lastActiveAt: now, armed: true, now })).toBe(false);
  });
});

describe('lock handler registry', () => {
  it('claims only while a handler is registered and accepting', () => {
    expect(requestMobileLock()).toBe(false);
    const unregister = setMobileLockHandler(() => true);
    expect(requestMobileLock()).toBe(true);
    unregister();
    expect(requestMobileLock()).toBe(false);
  });
  it('a declining handler does not claim', () => {
    const unregister = setMobileLockHandler(() => false);
    expect(requestMobileLock()).toBe(false);
    unregister();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/mobileLock.test.js`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement `client/src/utils/mobileLock.js`**

```js
import { PHONE_MEDIA_QUERY } from '../hooks/useIsPhone';

// Phone lock model (mobile-admin spec 2026-08-13 section 8): backgrounded
// more than 30 minutes, or an expired JWT, locks the phone surface behind a
// biometric re-assert. Pure decisions + a tiny handler registry; the UI is
// MobileLockScreen. Every key below is phone-local state and is purged by
// purgeMobileAdminState on logout (utils/adminSw.js imports them).
export const LOCK_AFTER_MS = 30 * 60 * 1000;
export const LAST_ACTIVE_KEY = 'adminLockLastActiveAt';
export const ENROLLED_KEY = 'adminPasskeyEnrolled';
export const NUDGE_DISMISSED_KEY = 'adminPasskeyNudgeDismissed';

export function touchLastActive(now = Date.now()) {
  try { window.localStorage.setItem(LAST_ACTIVE_KEY, String(now)); } catch (e) { /* storage blocked */ }
}
export function readLastActive() {
  try {
    const v = parseInt(window.localStorage.getItem(LAST_ACTIVE_KEY), 10);
    return Number.isFinite(v) ? v : null;
  } catch (e) { return null; }
}
export function passkeyEnrolledHere() {
  try { return window.localStorage.getItem(ENROLLED_KEY) === '1'; } catch (e) { return false; }
}
export function markPasskeyEnrolled() {
  try { window.localStorage.setItem(ENROLLED_KEY, '1'); } catch (e) { /* storage blocked */ }
}
export function nudgeDismissed() {
  try { return window.localStorage.getItem(NUDGE_DISMISSED_KEY) === '1'; } catch (e) { return true; }
}
export function dismissNudge() {
  try { window.localStorage.setItem(NUDGE_DISMISSED_KEY, '1'); } catch (e) { /* storage blocked */ }
}

// exp claim of a JWT in ms, or null when unreadable. Informational only: the
// server still enforces expiry; this decides whether to SHOW the lock.
export function tokenExpMs(token) {
  try {
    const payload = token.split('.')[1];
    const json = JSON.parse(window.atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch (e) { return null; }
}

export function isPhoneViewport() {
  try { return window.matchMedia(PHONE_MEDIA_QUERY).matches; } catch (e) { return false; }
}

// Armed = this device enrolled a passkey AND is at phone width. Everything
// that diverges from today's desktop behavior gates on this.
export function phoneUnlockArmed() {
  return passkeyEnrolledHere() && isPhoneViewport();
}

export function shouldLock({ token, lastActiveAt, armed, now = Date.now() }) {
  if (!armed || !token) return false;
  const exp = tokenExpMs(token);
  if (exp !== null && exp <= now) return true;
  if (lastActiveAt !== null && now - lastActiveAt > LOCK_AFTER_MS) return true;
  return false;
}

// SessionExpiryHandler asks before logging out on a 401: a mounted phone
// chrome with an enrolled passkey claims the event into the lock instead.
// Desktop admin and the staff portal never register a handler and keep
// today's logout path.
let lockHandler = null;
export function setMobileLockHandler(fn) {
  lockHandler = fn;
  return () => { if (lockHandler === fn) lockHandler = null; };
}
export function requestMobileLock() {
  return lockHandler ? lockHandler() === true : false;
}
```

- [ ] **Step 5: Run to verify pass**

Same test command. Expected: PASS.

- [ ] **Step 6: Implement `client/src/utils/webauthnClient.js`**

```js
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import api from './api';

// Thin client for /api/auth/webauthn/ (spec section 8). Every URL here starts
// /auth/, inside api.js's 401-exclusion prefix, so a failed unlock can never
// fire the session-expired dispatch.

export function isPasskeySupported() {
  try { return browserSupportsWebAuthn(); } catch (e) { return false; }
}

export async function registerPasskey(label) {
  const { data: options } = await api.post('/auth/webauthn/register-options');
  const attestation = await startRegistration({ optionsJSON: options });
  const { data } = await api.post('/auth/webauthn/register-verify', { response: attestation, label });
  return data.credential;
}

export async function unlockWithPasskey() {
  const { data: options } = await api.post('/auth/webauthn/assert-options');
  const assertion = await startAuthentication({ optionsJSON: options });
  const { data } = await api.post('/auth/webauthn/assert-verify', { response: assertion });
  return data; // { token, user }, same user shape as login
}
```

- [ ] **Step 7: Extend the purge list in `client/src/utils/adminSw.js`**

```js
import { ENROLLED_KEY, LAST_ACTIVE_KEY, NUDGE_DISMISSED_KEY } from './mobileLock';
...
const PHONE_LOCAL_KEYS = [
  'adminDesktopViewOverrides',
  'adminLastRoute',
  LAST_ACTIVE_KEY,
  ENROLLED_KEY,
  NUDGE_DISMISSED_KEY,
];
```

- [ ] **Step 8: Client build gate + commit**

Run: `cd client && CI=true npx react-scripts build`
Expected: exit 0.

```bash
git add client/src/hooks/useIsPhone.js client/src/utils/mobileLock.js client/src/utils/mobileLock.test.js client/src/utils/webauthnClient.js client/src/utils/adminSw.js
git commit -m "ma-d-auth: phone lock model, webauthn client, purge keys"
```

---

### Task 7: AuthContext purge law + SW /auth/me hydration

**Files:**
- Modify: `client/src/context/AuthContext.js`
- Create: `client/src/context/AuthContext.test.js`
- Modify: `client/public/admin-sw.js` (allowlist + version)

**Interfaces:**
- Consumes: `phoneUnlockArmed` (Task 6).
- Produces: `login(token, user)` now also dispatches `window` event `'session-restored'` (Task 8's guard reset listens); the bootstrap and `refreshUser` follow the purge law; the SW serves cached `/api/auth/me` on transport failure so an offline cold launch hydrates the user.

- [ ] **Step 1: Write the failing tests** (`client/src/context/AuthContext.test.js`)

```jsx
import '@testing-library/jest-dom';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';

const mockGet = jest.fn();
jest.mock('../utils/api', () => ({
  __esModule: true,
  default: { get: (...a) => mockGet(...a), post: jest.fn() },
}));
const mockPurge = jest.fn();
const mockAnnounce = jest.fn();
jest.mock('../utils/adminSw', () => ({
  purgeMobileAdminState: (...a) => mockPurge(...a),
  announceAdminSwUser: (...a) => mockAnnounce(...a),
}));
const mockArmed = jest.fn(() => false);
jest.mock('../utils/mobileLock', () => {
  const real = jest.requireActual('../utils/mobileLock');
  return { ...real, phoneUnlockArmed: (...a) => mockArmed(...a) };
});

import { AuthProvider, useAuth } from './AuthContext';

function Probe() {
  const { user, loading, login } = useAuth();
  return (
    <div>
      <span data-testid="state">{loading ? 'loading' : user ? user.email : 'no-user'}</span>
      <button onClick={() => login('tok-2', { id: 2, email: 'b@x.com' })}>login</button>
    </div>
  );
}

function renderWithToken(rejection) {
  window.localStorage.setItem('token', 'tok-1');
  mockGet.mockRejectedValueOnce(rejection);
  return render(<AuthProvider><Probe /></AuthProvider>);
}

afterEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
});

test('transport failure keeps the token and never purges (offline cold launch)', async () => {
  renderWithToken({ status: 0, code: 'NETWORK_ERROR', message: 'Network error.' });
  await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('no-user'));
  expect(window.localStorage.getItem('token')).toBe('tok-1');
  expect(mockPurge).not.toHaveBeenCalled();
});

test('revocation (TOKEN_VERSION_MISMATCH) purges and clears even when armed', async () => {
  mockArmed.mockReturnValue(true);
  renderWithToken({ status: 401, code: 'TOKEN_VERSION_MISMATCH', message: 'Session expired' });
  await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('no-user'));
  expect(window.localStorage.getItem('token')).toBeNull();
  expect(mockPurge).toHaveBeenCalled();
});

test('plain 401 with unlock NOT armed purges and clears (desktop behavior)', async () => {
  mockArmed.mockReturnValue(false);
  renderWithToken({ status: 401, code: 'INVALID_TOKEN', message: 'Invalid token' });
  await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('no-user'));
  expect(window.localStorage.getItem('token')).toBeNull();
  expect(mockPurge).toHaveBeenCalled();
});

test('plain 401 with unlock armed keeps the token artifact and caches (lock owns re-entry)', async () => {
  mockArmed.mockReturnValue(true);
  renderWithToken({ status: 401, code: 'INVALID_TOKEN', message: 'Invalid token' });
  await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('no-user'));
  expect(window.localStorage.getItem('token')).toBe('tok-1');
  expect(mockPurge).not.toHaveBeenCalled();
});

test('login stores the token, announces, and dispatches session-restored', async () => {
  const restored = jest.fn();
  window.addEventListener('session-restored', restored);
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('no-user'));
  act(() => { screen.getByText('login').click(); });
  expect(window.localStorage.getItem('token')).toBe('tok-2');
  expect(mockAnnounce).toHaveBeenCalledWith(2);
  expect(restored).toHaveBeenCalled();
  window.removeEventListener('session-restored', restored);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/context/AuthContext.test.js`
Expected: FAIL on the armed-keeps-token and session-restored cases.

- [ ] **Step 3: Implement the AuthContext changes**

Add the import and the classifier:

```js
import { phoneUnlockArmed, touchLastActive } from '../utils/mobileLock';

// How a failed /auth/me maps to state (spec section 8 purge law):
//   'purge': revoked (version bump, deleted user), or any dead session on a
//            surface without phone unlock armed: cache + token die (M2).
//   'keep': transport failure (the offline cold launch: the SW serves the
//           cached /auth/me and this path never runs), any non-401 answer,
//           or a plain 401 on a phone with an enrolled passkey, where the
//           lock screen owns re-entry and the caches stay, occluded.
function authFailureAction(err) {
  if (err?.status !== 401) return 'keep';
  if (err.code === 'TOKEN_VERSION_MISMATCH' || err.code === 'USER_NOT_FOUND') return 'purge';
  return phoneUnlockArmed() ? 'keep' : 'purge';
}
```

Replace the bootstrap `.catch` body:

```js
.catch((err) => {
  if (authFailureAction(err) === 'purge') {
    purgeMobileAdminState();
    localStorage.removeItem('token');
  }
})
```

Replace the `refreshUser` catch's 401 branch:

```js
if (authFailureAction(err) === 'purge') {
  purgeMobileAdminState();
  localStorage.removeItem('token');
  setUser(null);
}
// 'keep' with a 401: the phone lock overlay claims the surface via the
// session-expired event; leaving user state mounted preserves the screen
// the unlock returns to.
```

Extend `login`:

```js
const login = (token, userData) => {
  localStorage.setItem('token', token);
  setUser(userData);
  announceAdminSwUser(userData.id);
  touchLastActive();
  // Re-auth in a long-lived PWA document: the expiry handler's once-only
  // guard resets so a LATER expiry can fire again (spec section 8).
  window.dispatchEvent(new Event('session-restored'));
};
```

- [ ] **Step 4: Run to verify pass**

Same test command. Expected: PASS.

- [ ] **Step 5: SW allowlist + version bump** (`client/public/admin-sw.js`)

Add to `API_EXACT` (with the comment) and bump the version constant to the lane's build date, v8:

```js
const SW_VERSION = 'admin-sw-2026-08-15-v8';
...
const API_EXACT = new Set([
  '/api/shifts',
  '/api/proposals',
  '/api/admin/badge-counts',
  '/api/admin/search',
  '/api/admin/active-staff',
  // Offline cold-launch hydration (spec section 8): AuthContext boots from
  // the cached /auth/me when the network is gone. Transport-failure-only
  // fallback still applies, and a server-answered 401 EVICTS the entry (late
  // 401 rule below), so a revoked session renders no data.
  '/api/auth/me',
]);
```

- [ ] **Step 6: Client build gate + commit**

Run: `cd client && CI=true npx react-scripts build`

```bash
git add client/src/context/AuthContext.js client/src/context/AuthContext.test.js client/public/admin-sw.js
git commit -m "ma-d-auth: AuthContext purge law, session-restored dispatch, SW /auth/me hydration (v8)"
```

---

### Task 8: SessionExpiryHandler: phone claim + guard reset

**Files:**
- Modify: `client/src/components/SessionExpiryHandler.js`
- Create: `client/src/components/SessionExpiryHandler.test.js`

**Interfaces:**
- Consumes: `requestMobileLock` (Task 6), `'session-restored'` (Task 7).
- Produces: desktop and staff-portal behavior byte-identical; phone-armed 401s route to the lock with the once-only guard untouched.

- [ ] **Step 1: Write the failing tests** (`client/src/components/SessionExpiryHandler.test.js`)

```jsx
import '@testing-library/jest-dom';
import React from 'react';
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockToastError = jest.fn();
jest.mock('../context/ToastContext', () => ({ useToast: () => ({ error: mockToastError }) }));
const mockLogout = jest.fn();
jest.mock('../context/AuthContext', () => ({ useAuth: () => ({ logout: mockLogout }) }));
const mockClientLogout = jest.fn();
jest.mock('../context/ClientAuthContext', () => ({ useClientAuth: () => ({ clientLogout: mockClientLogout }) }));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));
const mockRequestLock = jest.fn(() => false);
jest.mock('../utils/mobileLock', () => ({
  ...jest.requireActual('../utils/mobileLock'),
  requestMobileLock: (...a) => mockRequestLock(...a),
}));

import SessionExpiryHandler from './SessionExpiryHandler';

function fireExpired(url = '/admin/badge-counts') {
  act(() => {
    window.dispatchEvent(new CustomEvent('session-expired', { detail: { url } }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

test('unclaimed 401 keeps today: toast, logout, navigate to /login', () => {
  render(<MemoryRouter><SessionExpiryHandler /></MemoryRouter>);
  fireExpired();
  expect(mockToastError).toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1600));
  expect(mockLogout).toHaveBeenCalled();
  expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
});

test('phone-claimed 401 locks instead: no toast, no logout, guard stays open', () => {
  mockRequestLock.mockReturnValue(true);
  render(<MemoryRouter><SessionExpiryHandler /></MemoryRouter>);
  fireExpired();
  expect(mockToastError).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1600));
  expect(mockLogout).not.toHaveBeenCalled();
  // Guard untouched: when the claim stops (unlock failed, passkey revoked),
  // the next 401 still gets the full logout path.
  mockRequestLock.mockReturnValue(false);
  fireExpired();
  expect(mockToastError).toHaveBeenCalledTimes(1);
});

test('client-portal 401s never route to the phone lock', () => {
  mockRequestLock.mockReturnValue(true);
  render(<MemoryRouter><SessionExpiryHandler /></MemoryRouter>);
  fireExpired('/client-portal/summary');
  expect(mockRequestLock).not.toHaveBeenCalled();
  expect(mockToastError).toHaveBeenCalled();
});

test('session-restored resets the once-only guard', () => {
  render(<MemoryRouter><SessionExpiryHandler /></MemoryRouter>);
  fireExpired();
  act(() => jest.advanceTimersByTime(1600));
  expect(mockToastError).toHaveBeenCalledTimes(1);
  act(() => { window.dispatchEvent(new Event('session-restored')); });
  fireExpired();
  expect(mockToastError).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/SessionExpiryHandler.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** (full new effect body; the import list gains `requestMobileLock`)

```js
import { requestMobileLock } from '../utils/mobileLock';
...
  useEffect(() => {
    const onExpired = (e) => {
      if (firedRef.current) return; // First event wins
      const url = e.detail?.url || '';
      const isClientRequest = url.startsWith('/client-portal/') || url.startsWith('/client-auth/');

      // Phone surface (mobile-admin spec section 8): a 401 routes to the lock
      // screen, not a logout. Claimed only when a mounted phone chrome with an
      // enrolled passkey registered a handler; desktop and the staff portal
      // never register one and keep the path below. The once-only guard is NOT
      // set on a claim: repeated 401s just re-assert the (idempotent) lock,
      // and the unlock restores the session in place.
      if (!isClientRequest && requestMobileLock()) return;

      firedRef.current = true;
      const target = isClientRequest ? clientLoginPath() : '/login';
      toast.error('Your session expired. Please log in again.');
      timerRef.current = setTimeout(() => {
        if (isClientRequest) clientLogout();
        else logout();
        navigate(target, { replace: true });
      }, 1500);
    };
    // Re-auth (password login or biometric unlock) re-opens the guard so a
    // LATER expiry in this long-lived PWA document can fire again.
    const onRestored = () => { firedRef.current = false; };

    window.addEventListener('session-expired', onExpired);
    window.addEventListener('session-restored', onRestored);
    return () => {
      window.removeEventListener('session-expired', onExpired);
      window.removeEventListener('session-restored', onRestored);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [toast, navigate, logout, clientLogout]);
```

- [ ] **Step 4: Run to verify pass, build gate, commit**

Run the test, then `cd client && CI=true npx react-scripts build`.

```bash
git add client/src/components/SessionExpiryHandler.js client/src/components/SessionExpiryHandler.test.js
git commit -m "ma-d-auth: phone 401s claim the lock, guard resets on re-auth, desktop path unchanged"
```

---

### Task 9: MobileLockScreen (gate + overlay) + wiring + CSS

**Files:**
- Create: `client/src/components/mobile/MobileLockScreen.js`
- Create: `client/src/components/mobile/MobileLockScreen.test.js`
- Modify: `client/src/components/AdminLayout.js` (overlay mount)
- Modify: `client/src/App.js` (ProtectedRoute gate)
- Modify: `client/src/index.css` (`.m-lock` block)

**Interfaces:**
- Consumes: `unlockWithPasskey` (Task 6), `login`/`logout` (AuthContext), the lock model (Task 6).
- Produces: `MobileLockScreen({ gate })`. Gate mount: ProtectedRoute renders it INSTEAD of the `/login` redirect when `!user && phoneUnlockArmed() && localStorage token` (expired-JWT cold launch; unlock calls `login()` and the guarded children render with the URL untouched, which is what makes section 9's "unlock lands exactly where you were" true). Overlay mount: AdminLayout renders it once; it arms the 30-minute background timer, re-checks on foreground, and registers the 401 claim handler.

- [ ] **Step 1: Write the failing tests** (`client/src/components/MobileLockScreen.test.js` colocated as `client/src/components/mobile/MobileLockScreen.test.js`)

```jsx
import '@testing-library/jest-dom';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockLogin = jest.fn();
const mockLogout = jest.fn();
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ login: mockLogin, logout: mockLogout }),
}));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));
const mockUnlock = jest.fn();
jest.mock('../../utils/webauthnClient', () => ({
  unlockWithPasskey: (...a) => mockUnlock(...a),
}));

import MobileLockScreen from './MobileLockScreen';
import { ENROLLED_KEY, LAST_ACTIVE_KEY, LOCK_AFTER_MS } from '../../utils/mobileLock';

// jsdom has no matchMedia; a stub controls the "phone viewport" answer.
function stubViewport(matches) {
  window.matchMedia = jest.fn().mockReturnValue({
    matches, addEventListener: jest.fn(), removeEventListener: jest.fn(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  stubViewport(true);
});

function armAndAge() {
  window.localStorage.setItem('token', 'tok');
  window.localStorage.setItem(ENROLLED_KEY, '1');
  window.localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now() - LOCK_AFTER_MS - 60_000));
}

test('renders nothing when not armed', () => {
  window.localStorage.setItem('token', 'tok');
  const { container } = render(<MemoryRouter><MobileLockScreen /></MemoryRouter>);
  expect(container.firstChild).toBeNull();
});

test('overlay locks on mount after a 30-minute-old background stamp', () => {
  armAndAge();
  render(<MemoryRouter><MobileLockScreen /></MemoryRouter>);
  expect(screen.getByRole('dialog', { name: /locked/i })).toBeInTheDocument();
});

test('gate mode always renders locked', () => {
  render(<MemoryRouter><MobileLockScreen gate /></MemoryRouter>);
  expect(screen.getByRole('dialog', { name: /locked/i })).toBeInTheDocument();
});

test('unlock success logs in and dismisses', async () => {
  mockUnlock.mockResolvedValue({ token: 'fresh', user: { id: 12 } });
  armAndAge();
  render(<MemoryRouter><MobileLockScreen /></MemoryRouter>);
  act(() => { screen.getByRole('button', { name: 'Unlock' }).click(); });
  await waitFor(() => expect(mockLogin).toHaveBeenCalledWith('fresh', { id: 12 }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('offline unlock failure explains itself and keeps the lock', async () => {
  mockUnlock.mockRejectedValue({ status: 0, message: 'Network error.' });
  armAndAge();
  render(<MemoryRouter><MobileLockScreen /></MemoryRouter>);
  act(() => { screen.getByRole('button', { name: 'Unlock' }).click(); });
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/offline/i));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

test('use-password logs out (purging phone state) and navigates to /login', () => {
  armAndAge();
  render(<MemoryRouter><MobileLockScreen /></MemoryRouter>);
  act(() => { screen.getByRole('button', { name: /use password/i }).click(); });
  expect(mockLogout).toHaveBeenCalled();
  expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile/MobileLockScreen.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `client/src/components/mobile/MobileLockScreen.js`**

```jsx
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { unlockWithPasskey } from '../../utils/webauthnClient';
import {
  phoneUnlockArmed, readLastActive, setMobileLockHandler, shouldLock, touchLastActive,
} from '../../utils/mobileLock';

// Full-screen lock (mobile-admin spec 2026-08-13 section 8): fully occludes
// content, one tap asserts and re-enters. Two mounts:
//   gate mode (ProtectedRoute, no live user): always locked; a successful
//     unlock calls login() and the guarded children render, URL untouched,
//     which is what keeps section 9's "unlock lands exactly where you were".
//   overlay mode (AdminLayout, live session): arms the 30-minute background
//     timer, re-checks on foreground, and claims phone 401s from
//     SessionExpiryHandler via the mobileLock handler registry.
export default function MobileLockScreen({ gate = false }) {
  const { login, logout } = useAuth();
  const navigate = useNavigate();
  const [locked, setLocked] = useState(() => gate || shouldLock({
    token: window.localStorage.getItem('token'),
    lastActiveAt: readLastActive(),
    armed: phoneUnlockArmed(),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Overlay: claim phone-surface 401s while armed. Desktop and passkey-less
  // phones decline, so SessionExpiryHandler keeps its logout path there.
  useEffect(() => {
    if (gate) return undefined;
    return setMobileLockHandler(() => {
      if (!phoneUnlockArmed()) return false;
      setLocked(true);
      return true;
    });
  }, [gate]);

  // Overlay: stamp on background, re-evaluate on foreground.
  useEffect(() => {
    if (gate) return undefined;
    const stamp = () => touchLastActive();
    const evaluate = () => {
      if (shouldLock({
        token: window.localStorage.getItem('token'),
        lastActiveAt: readLastActive(),
        armed: phoneUnlockArmed(),
      })) setLocked(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stamp();
      else evaluate();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', stamp);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', stamp);
    };
  }, [gate]);

  // Gate mode renders OUTSIDE AdminLayout, so the admin token scope is not
  // set yet; claim it so the .m-lock tokens resolve. AdminLayout re-claims
  // it the moment the unlock succeeds and the children mount.
  useEffect(() => {
    if (!gate) return undefined;
    const root = document.documentElement;
    const prev = root.getAttribute('data-app');
    root.setAttribute('data-app', 'admin-os');
    return () => {
      if (prev) root.setAttribute('data-app', prev);
      else root.removeAttribute('data-app');
    };
  }, [gate]);

  // No scrolling the occluded content under the lock.
  useEffect(() => {
    if (!locked) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [locked]);

  const onUnlock = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const { token, user } = await unlockWithPasskey();
      login(token, user);
      touchLastActive();
      setLocked(false);
    } catch (err) {
      if (err?.status === 0) setError('You are offline. Unlocking needs a connection.');
      else if (typeof err?.status === 'number') setError(err.message || 'Unlock failed. Try again or use your password.');
      else setError('Unlock was cancelled or failed. Try again or use your password.');
    } finally {
      setBusy(false);
    }
  }, [login]);

  const onPassword = useCallback(() => {
    // Full re-auth: logout purges the phone caches by design (spec section 7).
    logout();
    navigate('/login', { replace: true });
  }, [logout, navigate]);

  if (!locked) return null;
  return (
    <div className="m-lock" role="dialog" aria-modal="true" aria-label="Locked">
      <div className="m-lock-brand" aria-hidden="true">&#8478;</div>
      <h1 className="m-lock-title">Locked</h1>
      <p className="m-lock-sub">Unlock to pick up where you left off.</p>
      <button type="button" className="m-lock-unlock" onClick={onUnlock} disabled={busy}>
        {busy ? 'Unlocking...' : 'Unlock'}
      </button>
      {error ? <p className="m-lock-error" role="alert">{error}</p> : null}
      <button type="button" className="m-lock-password" onClick={onPassword} disabled={busy}>
        Use password instead
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Overlay mount in `AdminLayout.js`** (the outer component, single mount covering both chrome branches)

```jsx
import MobileLockScreen from './mobile/MobileLockScreen';
...
export default function AdminLayout() {
  return (
    <MobileViewProvider>
      <AdminLayoutInner />
      <MobileLockScreen />
    </MobileViewProvider>
  );
}
```

- [ ] **Step 5: Gate mount in `App.js` ProtectedRoute**

```jsx
import MobileLockScreen from './components/mobile/MobileLockScreen';
import { phoneUnlockArmed } from './utils/mobileLock';
...
  if (!user) {
    // Expired-JWT cold launch on a phone with an enrolled passkey (spec
    // section 8): the lock screen owns re-entry; unlock re-mints and the
    // guarded children render with the URL untouched. Everyone else goes to
    // password login exactly as today. Direct import on purpose: an offline
    // cold launch cannot depend on an uncached lazy chunk.
    if (phoneUnlockArmed() && localStorage.getItem('token')) {
      return <MobileLockScreen gate />;
    }
    return <Navigate to="/login" replace />;
  }
```

- [ ] **Step 6: CSS** (append to `index.css` next to the existing `.m-*` block)

First verify the stacking inventory and the accent token the tab bar uses:
`grep -n "z-index" client/src/index.css | tail -20` and `grep -n "m-seg-btn.active\|m-tab" client/src/index.css | head`.
`.m-lock` must sit above EVERY admin overlay (drawer tier, palette, return pill at 39); pick the value above the highest found (the block below assumes 90 clears it, raise if the grep says otherwise) and reuse the exact accent variable the active tab / seg buttons use for `.m-lock-unlock` (the block below writes `var(--accent)` as a placeholder for whatever the grep names).

```css
/* ---- Mobile admin: lock screen + enrollment (spec 2026-08-13 section 8) ---- */
html[data-app="admin-os"] .m-lock {
  position: fixed;
  inset: 0;
  z-index: 90; /* above every admin overlay: verified against the z inventory */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  background: var(--bg-0); /* SOLID: the lock fully occludes content */
  padding: 2rem 1.5rem;
  text-align: center;
}
html[data-app="admin-os"] .m-lock-brand { font-size: 2.5rem; color: var(--ink-3); }
html[data-app="admin-os"] .m-lock-title { font-size: 1.25rem; color: var(--ink-1); margin: 0; }
html[data-app="admin-os"] .m-lock-sub { font-size: 0.9rem; color: var(--ink-3); margin: 0 0 0.75rem; }
html[data-app="admin-os"] .m-lock-unlock {
  min-height: 44px;
  padding: 0.75rem 2.25rem;
  border: none;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  font-size: 1rem;
  font-weight: 600;
}
html[data-app="admin-os"] .m-lock-unlock:disabled { opacity: 0.6; }
html[data-app="admin-os"] .m-lock-error { color: var(--danger, #c0392b); font-size: 0.85rem; margin: 0; max-width: 32ch; }
html[data-app="admin-os"] .m-lock-password {
  min-height: 44px;
  background: none;
  border: none;
  color: var(--ink-3);
  text-decoration: underline;
  font-size: 0.9rem;
}
html[data-app="admin-os"] .m-enroll-nudge {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background: var(--bg-1);
  border-bottom: 1px solid var(--line-1);
  font-size: 0.85rem;
}
html[data-app="admin-os"] .m-enroll-copy { flex: 1; color: var(--ink-2); text-align: left; }
html[data-app="admin-os"] .m-enroll-yes,
html[data-app="admin-os"] .m-enroll-no {
  min-height: 44px;
  padding: 0 0.9rem;
  border-radius: 8px;
  border: 1px solid var(--line-1);
  background: none;
  color: var(--ink-2);
  font-size: 0.85rem;
}
html[data-app="admin-os"] .m-enroll-yes { background: var(--accent); border-color: var(--accent); color: #fff; }
```

- [ ] **Step 7: Run tests, build gate, commit**

Run the MobileLockScreen suite, then `cd client && CI=true npx react-scripts build`.

```bash
git add client/src/components/mobile/MobileLockScreen.js client/src/components/mobile/MobileLockScreen.test.js client/src/components/AdminLayout.js client/src/App.js client/src/index.css
git commit -m "ma-d-auth: lock screen, gate + overlay mounts, occluding CSS"
```

---

### Task 10: Enrollment UI: post-login nudge + More row

**Files:**
- Create: `client/src/components/mobile/PasskeyEnrollNudge.js`
- Create: `client/src/components/mobile/PasskeyEnrollNudge.test.js`
- Modify: `client/src/components/AdminLayout.js` (render in the mobile chrome branch)
- Modify: `client/src/pages/mobile/MorePage.js` (Security section)

**Interfaces:**
- Consumes: `registerPasskey`/`isPasskeySupported` (Task 6), flags (Task 6), `useToast`.
- Produces: the spec's "password login once, then passkey registration" moment, plus a durable phone entry point. The nudge is dismissible forever; both flags are phone-local and purge on logout.

- [ ] **Step 1: Write the failing tests** (`client/src/components/mobile/PasskeyEnrollNudge.test.js`)

```jsx
import '@testing-library/jest-dom';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';

const mockToast = { success: jest.fn(), error: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));
const mockSupported = jest.fn(() => true);
const mockRegister = jest.fn();
jest.mock('../../utils/webauthnClient', () => ({
  isPasskeySupported: (...a) => mockSupported(...a),
  registerPasskey: (...a) => mockRegister(...a),
}));

import PasskeyEnrollNudge from './PasskeyEnrollNudge';
import { ENROLLED_KEY, NUDGE_DISMISSED_KEY, passkeyEnrolledHere } from '../../utils/mobileLock';

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
});

test('hidden when unsupported, enrolled, or dismissed', () => {
  mockSupported.mockReturnValueOnce(false);
  expect(render(<PasskeyEnrollNudge />).container.firstChild).toBeNull();

  window.localStorage.setItem(ENROLLED_KEY, '1');
  expect(render(<PasskeyEnrollNudge />).container.firstChild).toBeNull();
  window.localStorage.clear();

  window.localStorage.setItem(NUDGE_DISMISSED_KEY, '1');
  expect(render(<PasskeyEnrollNudge />).container.firstChild).toBeNull();
});

test('Turn on enrolls, sets the flag, and hides', async () => {
  mockRegister.mockResolvedValue({ id: 1 });
  render(<PasskeyEnrollNudge />);
  act(() => { screen.getByRole('button', { name: 'Turn on' }).click(); });
  await waitFor(() => expect(passkeyEnrolledHere()).toBe(true));
  expect(mockToast.success).toHaveBeenCalled();
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
});

test('Not now dismisses durably', () => {
  render(<PasskeyEnrollNudge />);
  act(() => { screen.getByRole('button', { name: 'Not now' }).click(); });
  expect(window.localStorage.getItem(NUDGE_DISMISSED_KEY)).toBe('1');
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
});

test('a failed enrollment keeps the nudge and reports', async () => {
  mockRegister.mockRejectedValue({ message: 'nope' });
  render(<PasskeyEnrollNudge />);
  act(() => { screen.getByRole('button', { name: 'Turn on' }).click(); });
  await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
  expect(screen.getByRole('region')).toBeInTheDocument();
  expect(passkeyEnrolledHere()).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement `PasskeyEnrollNudge.js`**

```jsx
import React, { useState } from 'react';
import { useToast } from '../../context/ToastContext';
import { isPasskeySupported, registerPasskey } from '../../utils/webauthnClient';
import {
  dismissNudge, markPasskeyEnrolled, nudgeDismissed, passkeyEnrolledHere, touchLastActive,
} from '../../utils/mobileLock';

// One-time post-login nudge (spec section 8: password login once, then
// passkey registration). Rendered only inside the phone chrome; gone forever
// on enroll or dismiss (both flags purge with the rest of the phone state on
// logout, so a fresh account sees it again, which is correct).
export default function PasskeyEnrollNudge() {
  const toast = useToast();
  const [visible, setVisible] = useState(
    () => isPasskeySupported() && !passkeyEnrolledHere() && !nudgeDismissed()
  );
  const [busy, setBusy] = useState(false);
  if (!visible) return null;

  const onEnroll = async () => {
    setBusy(true);
    try {
      await registerPasskey('This phone');
      markPasskeyEnrolled();
      touchLastActive();
      toast.success('Fingerprint unlock is on.');
      setVisible(false);
    } catch (err) {
      toast.error(err?.message || 'Could not set up fingerprint unlock.');
    } finally {
      setBusy(false);
    }
  };
  const onDismiss = () => { dismissNudge(); setVisible(false); };

  return (
    <div className="m-enroll-nudge" role="region" aria-label="Fingerprint unlock">
      <span className="m-enroll-copy">Unlock with your fingerprint next time</span>
      <button type="button" className="m-enroll-yes" onClick={onEnroll} disabled={busy}>
        {busy ? 'Setting up...' : 'Turn on'}
      </button>
      <button type="button" className="m-enroll-no" onClick={onDismiss} disabled={busy}>
        Not now
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Render it in the mobile chrome branch of `AdminLayoutInner`** (between `MobileHeader` and `main`)

```jsx
          <MobileHeader
            title={screenTitle(screenKey)}
            screenKey={screenKey}
            onBack={isDetail ? onBack : null}
          />
          <PasskeyEnrollNudge />
          <main className="m-main" id="main-content"><Outlet context={{ badges }} /></main>
```

- [ ] **Step 5: More page Security section** (in `MorePage.js`: add imports for `useToast`, `isPasskeySupported`, `registerPasskey`, `markPasskeyEnrolled`, `passkeyEnrolledHere`, `touchLastActive`; add the component and render `<SecurityRow />` after the NAV sections, before Lighting)

```jsx
function SecurityRow() {
  const toast = useToast();
  const [enrolled, setEnrolled] = React.useState(passkeyEnrolledHere());
  const [busy, setBusy] = React.useState(false);
  if (!isPasskeySupported()) return null;
  const onEnroll = async () => {
    setBusy(true);
    try {
      await registerPasskey('This phone');
      markPasskeyEnrolled();
      touchLastActive();
      setEnrolled(true);
      toast.success('Fingerprint unlock is on.');
    } catch (err) {
      toast.error(err?.message || 'Could not set up fingerprint unlock.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h2 className="m-more-heading">Security</h2>
      <ul className="m-more-list">
        <li>
          {enrolled ? (
            <div className="m-more-row"><span>Fingerprint unlock is on</span></div>
          ) : (
            <button type="button" className="m-more-row" onClick={onEnroll} disabled={busy}>
              <span>{busy ? 'Setting up...' : 'Set up fingerprint unlock'}</span>
            </button>
          )}
        </li>
      </ul>
      <div className="m-seg-note">manage or revoke passkeys in Settings on desktop</div>
    </section>
  );
}
```

Known accepted residual (state it in the code comment): the enrolled flag is device-local; a revoke from desktop leaves it stale, the next unlock fails into the password path, and re-enrolling resets it. No sync round-trip is worth that edge.

- [ ] **Step 6: Run tests, build gate, commit**

```bash
git add client/src/components/mobile/PasskeyEnrollNudge.js client/src/components/mobile/PasskeyEnrollNudge.test.js client/src/components/AdminLayout.js client/src/pages/mobile/MorePage.js
git commit -m "ma-d-auth: enrollment nudge + More security row"
```

---

### Task 11: Desktop Settings: passkey management

**Files:**
- Create: `client/src/pages/admin/SecuritySettings.js`
- Modify: `client/src/pages/admin/SettingsDashboard.js` (tab)

**Interfaces:**
- Consumes: `GET /auth/webauthn/credentials`, `DELETE /auth/webauthn/credentials/:id` (Tasks 3), `useToast`, `useAuth`, `ConfirmModal`.
- Produces: the spec's desktop escape hatch: list + revoke, with the honest global-logout consequence in the confirm copy.

- [ ] **Step 1: Implement `SecuritySettings.js`**

```jsx
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import ConfirmModal from '../../components/ConfirmModal';
import { useToast } from '../../context/ToastContext';
import { useAuth } from '../../context/AuthContext';

// Passkey management (mobile-admin spec 2026-08-13 section 8 escape hatch).
// Revoke is the lost-phone kill switch: it deletes the credential AND bumps
// token_version, a global logout by design, this desktop session included.
export default function SecuritySettings() {
  const toast = useToast();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [creds, setCreds] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState(null);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    api.get('/auth/webauthn/credentials')
      .then((r) => setCreds(r.data.credentials))
      .catch(() => setLoadError(true));
  }, []);

  const onRevoke = async () => {
    setRevoking(true);
    try {
      await api.delete(`/auth/webauthn/credentials/${pendingRevoke.id}`);
      toast.success('Passkey revoked. All sessions are signed out.');
      logout();
      navigate('/login', { replace: true });
    } catch (err) {
      toast.error(err?.message || 'Could not revoke the passkey.');
      setRevoking(false);
      setPendingRevoke(null);
    }
  };

  if (loadError) {
    return <div className="card" style={{ padding: '1.5rem' }}>Could not load passkeys. Try refreshing.</div>;
  }
  if (creds === null) {
    return <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  return (
    <div className="card" style={{ padding: '1.5rem', maxWidth: 560 }}>
      <h3 style={{ marginBottom: '0.75rem', fontSize: '1rem' }}>Passkeys</h3>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
        Fingerprint unlock credentials for the phone app. Revoking one signs out every
        session everywhere (this one included), so a lost phone is locked out immediately.
      </p>
      {creds.length === 0 ? (
        <p style={{ fontSize: '0.85rem' }}>
          No passkeys enrolled. On your phone, open More and choose Set up fingerprint unlock.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {creds.map((c) => (
            <li key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{c.label || 'Passkey'}</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  Added {new Date(c.created_at).toLocaleDateString()}
                  {c.last_used_at ? `, last used ${new Date(c.last_used_at).toLocaleDateString()}` : ', never used'}
                </div>
              </div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPendingRevoke(c)} disabled={revoking}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmModal
        isOpen={!!pendingRevoke}
        title="Revoke this passkey?"
        message="Revoking signs out every session, including this one. You will log back in with your password."
        onConfirm={onRevoke}
        onCancel={() => setPendingRevoke(null)}
      />
    </div>
  );
}
```

- [ ] **Step 2: Wire the tab in `SettingsDashboard.js`**

```jsx
import SecuritySettings from './SecuritySettings';
...
const TABS = [
  { key: 'calendar', label: 'Calendar Sync' },
  { key: 'auto-assign', label: 'Auto-Assign' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'security', label: 'Security' },
];
...
      {activeTab === 'security' && <SecuritySettings />}
```

- [ ] **Step 3: Build gate + manual check + commit**

Run `cd client && CI=true npx react-scripts build`; on the dev server, load /settings, open Security, confirm the empty state renders.

```bash
git add client/src/pages/admin/SecuritySettings.js client/src/pages/admin/SettingsDashboard.js
git commit -m "ma-d-auth: desktop passkey management with honest global-logout revoke"
```

---

### Task 12: Docs law + walkthroughs

**Files:**
- Modify: `README.md` (folder tree: webauthn.js, mobileLock.js, webauthnClient.js, MobileLockScreen.js, PasskeyEnrollNudge.js, SecuritySettings.js; Tech Stack: @simplewebauthn; env table: WEBAUTHN_RP_ID, WEBAUTHN_ORIGIN)
- Modify: `ARCHITECTURE.md` (route table: the six webauthn endpoints with auth/limiter notes; Database Schema: webauthn_credentials + webauthn_challenges; the PWA/auth section: 12h mint, purge law, lock model, /auth/me in the SW allowlist)
- Modify: `.claude/CLAUDE.md` (env-vars table: the two WEBAUTHN vars with one-line purposes)
- Modify: `docs/walkthroughs-owed.md`

- [ ] **Step 1: README + ARCHITECTURE + CLAUDE.md rows per the table above.** Keep each entry one line in the established format of its file.

- [ ] **Step 2: walkthroughs-owed.md.** Update the existing mobile-admin boundary entry (offline cold launch landing on Login) to its new truth: fixed by ma-d-auth, offline cold launch now hydrates from the cached /auth/me and lands on the restored route, behind the lock when more than 30 minutes backgrounded. Add the owed Pixel walk:

```markdown
## Mobile admin: passkey unlock (lane ma-d-auth) - Pixel walk owed
On the real Pixel, against dev data:
1. Password login on the phone, accept the enrollment nudge, confirm the
   fingerprint sheet appears and enrolls.
2. Background the app 30+ minutes (or set adminLockLastActiveAt back in
   devtools), reopen: lock screen, one tap unlocks, lands on the same screen.
3. Airplane mode, cold launch within 30 minutes of last use: restored route
   with staleness lines, no Login bounce.
4. Airplane mode, cold launch with the lock due: lock screen explains offline
   unlock needs a connection; password path visible.
5. From desktop Settings > Security: revoke the phone passkey, confirm the
   desktop logs out, the phone's next unlock fails to the password path, and
   re-enrollment works.
```

- [ ] **Step 3: Commit**

```bash
git add README.md ARCHITECTURE.md .claude/CLAUDE.md docs/walkthroughs-owed.md
git commit -m "ma-d-auth: docs law (routes, schema, env) + owed Pixel walk"
```

---

### Task 13: Lane gate: full verification, browser pass, fleet

**Files:** none new (fixes only, if the gate finds problems).

- [ ] **Step 1: Server suites, one at a time, from repo root**

`node --test server/routes/webauthn.test.js`, then `server/routes/auth.core.test.js`, then the regression neighbors this lane's diffs touch: `server/routes/auth.preferredName.test.js`, `server/middleware/rateLimiters.test.js`, `server/middleware/auth.envelope.test.js`.
Expected: every suite PASS.

- [ ] **Step 2: Full client test run + CI build**

`cd client && CI=true npx react-scripts test --watchAll=false` (all suites, including ma-a's 22), then `CI=true npx react-scripts build`.
Expected: green, exit 0.

- [ ] **Step 3: Browser pass** (phone viewport, dev JWTs, per the existing mobile-review recipe; playwright-core CDP)

Checks, each with an elementFromPoint tap-target proof on the primary action:
1. Enrollment end-to-end with a CDP virtual authenticator (`WebAuthn.enable`, `addVirtualAuthenticator` with `transport: 'internal'`, `hasResidentKey: true`, `hasUserVerification: true`, `isUserVerified: true`): More > Set up fingerprint unlock, confirm the credential row lands in the DB and the flag is set.
2. Lock on stale stamp: write `adminLockLastActiveAt = Date.now() - 31*60*1000`, reload, assert `.m-lock` present and that `document.elementFromPoint(center)` hits the lock (occlusion proof).
3. Unlock via the virtual authenticator: assert the lock dismisses, the route is unchanged, and a subsequent API call succeeds with the NEW token (12h claim visible in localStorage).
4. 401 claim: with the app open, bump the user's token_version in the dev DB, trigger a poll, assert the lock appears INSTEAD of the login redirect, then unlock (fresh mint carries the new version) and assert recovery.
5. Password fallback: from the lock, Use password lands on /login; log in; assert the nudge does not reappear mid-session after enrollment (flag purged by the logout, so it WILL reappear post-password-login: assert that too, it is the designed behavior).
6. Offline cold launch within 30 minutes: `context.setOffline(true)`, reload, assert restored route + staleness line, no Login bounce (the /auth/me cache hydration).
7. Desktop width regression: at 1280px, expired token still toasts and redirects to /login (desktop behavior byte-identical).
If the virtual-authenticator steps prove flaky in the harness, record the failure honestly, fall back to asserting the surrounding logic (lock render, claim, fallback), and the Pixel walk in walkthroughs-owed covers the real-authenticator path.

- [ ] **Step 4: File-size + palette checks**

`npm run check:filesize` (no new RED), `node scripts/check-css-palette-scope.js` if the palette checker applies to the new CSS block (its green tick has known blind spots; the ui-eyeball stays owed via walkthroughs).

- [ ] **Step 5: The 5-agent fleet, foreground, before merge**

Run the lane's declared fleet: code-review, consistency-check, security-review, database-review, second-opinion (external reviewers get the lane diff; export GEMINI_API_KEY first). Iron rule: a failed or DOA agent is never a pass; re-dispatch once, then chunk. Every finding routes to Dallas as fix-now / merge-anyway; no silent fix-and-rereview loops.

- [ ] **Step 6: Merge**

`scripts/merge-lane.sh` from the os checkout (squash, lock held). Before merge: `git log main..<lane>` review, dirty-tree rule, re-confirm review against main's new HEAD if main moved. After the clean merge: worktree removed, branch deleted under the three-check pre-approval.

**Push-time notes (for whoever pushes, recorded here so the plan is the single source):**
- Run the idempotent webauthn DDL against prod Neon BEFORE the push that deploys this code (spec section 8; Neon MCP can write to round-tooth-34649976).
- Set `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` in Render only if the defaults are wrong (they match prod as coded; the vars exist for emergencies).
- The SW bump to v8 rides the deploy; phones pick it up on their next update check. The stub deploy remains the only real SW kill.
- `npm run gate` before the push, per the receipt workflow.

## Self-review checklist (run after writing, before handing to /review-plan)

- Spec section 8 coverage: library (T1), credential-is-session (T1/T3/T4), endpoints under /api/auth/webauthn/ (T3), challenges single-use TTL (T3/T4), RP ID pinning (T3), counter + Sentry (T4), dedicated limiter (T2), 12h mint only site + 7d unchanged (T4/T5 tests), lock behavior + SessionExpiryHandler + AuthContext fixes (T7-T9), revocation via token_version with honest global logout (T3/T11), escape hatches (T9-T11), observability events (T3/T4), sensitive-paths (already listed, verified in Proven context), auth test debt (T5), docs law (T12).
- Spec section 7 tie-in: /auth/me allowlist + purge law keep the offline promises (T7); writes still never queued (untouched).
- Spec section 9 tie-in: gate unlock preserves the URL; /login still never persisted (untouched).
