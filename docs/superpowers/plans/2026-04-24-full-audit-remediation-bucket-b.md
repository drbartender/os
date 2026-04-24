# Full-Audit Bucket-B Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every fail-closed gap, data-integrity gap, admin-facing perf gap, and observability gap flagged by the 2026-04-24 /full-audit (bucket B scope: 15 BLOCKERs + ~20 high-value WARNINGs).

**Architecture:** Five sequential phases, ~18 commits total. One commit per logical cluster (CLAUDE.md Rule 3). No auto-push (Rule 4) — user controls push timing. Phase 1 is fail-closed security; Phase 2 is input/auth hardening (includes one schema change); Phase 3 is error/observability; Phase 4 is performance; Phase 5 is docs and backlog.

**Tech Stack:** Node.js/Express, React 18 (CRA), Neon PostgreSQL (raw SQL), Stripe, Resend, Twilio, Sentry, JWT, DOMPurify.

**Source spec:** `docs/superpowers/specs/2026-04-24-full-audit-remediation-bucket-b-design.md`
**Audit log:** `.claude/full-audit-2026-04-24.log` (gitignored local artifact)

**Conventions for every task:**
- Verify via Read before editing (line numbers in this plan are from audit — confirm before editing).
- After the edit: start `npm run dev` if not already running, hit the affected endpoint via browser or curl, confirm expected behavior.
- Commit message: lowercase type prefix (`fix:`, `perf:`, `chore:`, `docs:`), single line, no heredoc, no co-author.
- After commit, append `→ FIXED in <short-sha>` to the corresponding finding in `.claude/full-audit-2026-04-24.log`. (Combine all annotations in the Phase 5 log-annotate step; no per-commit log edits.)
- Do NOT push. User controls push cadence.

---

## PHASE 1 — Security fail-closed (5 commits)

### Task 1: Resend webhook fail-closed on missing secret

**Files:**
- Modify: `server/routes/emailMarketingWebhook.js:10-50`

Audit finding #1 (top-21). Currently the webhook returns 200 and captures one Sentry event when `RESEND_WEBHOOK_SECRET` is unset in production. An attacker can POST forged events and flip leads to bounced/complained or fabricate delivered signals.

- [ ] **Step 1: Read current implementation**

Read `server/routes/emailMarketingWebhook.js` lines 1-60.

- [ ] **Step 2: Replace the missing-secret and invalid-signature branches**

Replace the existing `if (!secret) { ... }` / `try { wh.verify(...) } catch { ... }` block with:

```javascript
const secret = process.env.RESEND_WEBHOOK_SECRET;
if (!secret) {
  if (process.env.NODE_ENV === 'production') {
    Sentry.captureMessage('RESEND_WEBHOOK_SECRET not set in production', 'error');
    return res.status(401).json({ error: 'Webhook signature verification unavailable' });
  }
  // Dev only: allow through but flag
  console.warn('[resend-webhook] RESEND_WEBHOOK_SECRET missing — dev mode passthrough');
}

let event;
if (secret) {
  try {
    const wh = new Webhook(secret);
    event = wh.verify(req.body, {
      'svix-id': req.headers['svix-id'],
      'svix-timestamp': req.headers['svix-timestamp'],
      'svix-signature': req.headers['svix-signature'],
    });
  } catch (err) {
    Sentry.captureMessage('Resend webhook signature failure', {
      level: 'warning',
      tags: { webhook: 'resend', reason: 'invalid_signature' },
    });
    return res.status(401).json({ error: 'Invalid signature' });
  }
} else {
  // Dev passthrough
  event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
}
```

- [ ] **Step 3: Smoke test — dev passthrough still works**

Start `npm run dev`. POST a sample Resend event body to `http://localhost:5000/api/email-marketing/webhook/resend`. Confirm 200 response and DB row written.

- [ ] **Step 4: Smoke test — prod-mode rejects missing secret**

In a second terminal: `NODE_ENV=production RESEND_WEBHOOK_SECRET= node -e "require('./server/routes/emailMarketingWebhook')"` — verify the module loads without crash. No full prod test available locally; confirm logic by code review.

- [ ] **Step 5: Commit**

```
git add server/routes/emailMarketingWebhook.js
git commit -m "fix(security): resend webhook fails closed on missing secret in prod"
```

---

### Task 2: encryption.js throws in prod when key missing

**Files:**
- Modify: `server/utils/encryption.js:7-30`

Audit finding #2 (top-21). Currently `encrypt()` silently returns plaintext if `ENCRYPTION_KEY` missing — bank routing/account numbers land in Postgres unencrypted.

- [ ] **Step 1: Read current implementation**

Read `server/utils/encryption.js` entirely.

- [ ] **Step 2: Replace key loader and encrypt/decrypt guards**

At the top of the file, replace the `getKey()` helper and the early-return fallbacks inside `encrypt()` and `decrypt()` with:

```javascript
function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY must be set to a 32+ char value in production');
    }
    return null; // dev fallback
  }
  return Buffer.from(key.slice(0, 32), 'utf8');
}
```

Inside both `encrypt(value)` and `decrypt(value)`, replace the current `if (!key) return value;` with:

```javascript
const key = getKey();
if (!key) {
  if (process.env.NODE_ENV === 'production') {
    // Unreachable (getKey throws first), but belt-and-suspenders.
    throw new Error('ENCRYPTION_KEY required in production');
  }
  console.warn('[encryption] ENCRYPTION_KEY missing — returning plaintext (dev only)');
  return value;
}
```

- [ ] **Step 3: Smoke test**

In dev, hit any route that reads encrypted data (e.g. admin payment-profile view). Confirm no regressions. Run `grep -rn "require.*encryption" server/` to list consumers — verify they handle thrown errors gracefully in prod.

- [ ] **Step 4: Commit**

```
git add server/utils/encryption.js
git commit -m "fix(security): encryption.js throws in prod when ENCRYPTION_KEY missing"
```

---

### Task 3: Stripe payment-link redirect reads token from DB

**Files:**
- Modify: `server/routes/stripe.js:320-375`

Audit finding #3 (top-21). Currently builds redirect URL with unverified `req.query.token`. Attacker who guesses proposal ID constructs a redirect carrying any UUID-shaped string.

- [ ] **Step 1: Read current implementation**

Read `server/routes/stripe.js:320-380`.

- [ ] **Step 2: Replace the token handling**

Find the section that constructs `successUrl`. Where it reads `req.query.token || ''`, replace with an explicit DB lookup:

```javascript
const { rows: tokenRows } = await pool.query(
  'SELECT token FROM proposals WHERE id = $1',
  [proposalId]
);
if (!tokenRows.length) {
  throw new NotFoundError('Proposal not found');
}
const proposalToken = tokenRows[0].token;

// ... later, when building successUrl:
const successUrl = `${process.env.PUBLIC_SITE_URL}/proposal/${encodeURIComponent(proposalToken)}?payment=success`;
```

Remove any reference to `req.query.token` in this function.

- [ ] **Step 3: Smoke test**

Create a test proposal in dev, request a Stripe payment link, confirm the returned redirect URL points to the proposal's actual token (not a query-passed value).

- [ ] **Step 4: Commit**

```
git add server/routes/stripe.js
git commit -m "fix(security): stripe payment-link redirect reads token server-side"
```

---

### Task 4: /unsubscribe wrapped in asyncHandler + statusClause parameterize

**Files:**
- Modify: `server/routes/emailMarketing.js:805-835`
- Modify: `server/routes/admin.js:350-380`

Grouped because both are single-file error-handling/SQL-interpolation fixes on related concerns.

Audit findings #4 and #5 (top-21).

- [ ] **Step 1: Read both sections**

Read `server/routes/emailMarketing.js:800-840` and `server/routes/admin.js:340-390`.

- [ ] **Step 2: Wrap /unsubscribe**

Replace:
```javascript
router.get('/unsubscribe', async (req, res) => {
  try {
    // ... JWT decode + DB update ...
  } catch (err) {
    return res.status(400).send('Invalid or expired link');
  }
});
```

With:
```javascript
router.get('/unsubscribe', asyncHandler(async (req, res) => {
  const { token } = req.query;
  let payload;
  try {
    payload = jwt.verify(token, process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET);
  } catch (err) {
    return res.status(400).send('Invalid or expired unsubscribe link');
  }
  // DB update runs outside the try/catch — errors propagate to asyncHandler → global error middleware
  await pool.query(
    `UPDATE email_leads SET status = 'unsubscribed', unsubscribed_at = NOW() WHERE id = $1`,
    [payload.leadId]
  );
  res.send('<!DOCTYPE html><html><body><h1>Unsubscribed</h1><p>You have been removed from future emails.</p></body></html>');
}));
```

Note the use of `UNSUBSCRIBE_SECRET || JWT_SECRET` — the fallback for the new env var is added here; Task 8 adds signing with the new secret.

- [ ] **Step 3: Parameterize statusClause in admin.js**

Find the block around line 358-373. Replace:
```javascript
const statusClause = archived === 'true'
  ? "u.onboarding_status = 'archived'"
  : "u.onboarding_status != 'archived'";
const result = await pool.query(
  `SELECT ... FROM users u WHERE u.role IN ('staff', 'manager') AND ${statusClause} ORDER BY ...`,
  [...]
);
```

With:
```javascript
const isArchived = archived === 'true';
const result = await pool.query(
  `SELECT ... FROM users u
   WHERE u.role IN ('staff', 'manager')
     AND CASE WHEN $1 THEN u.onboarding_status = 'archived' ELSE u.onboarding_status != 'archived' END
   ORDER BY ...`,
  [isArchived, /* other params */]
);
```

(Adjust parameter numbering for existing placeholders.)

- [ ] **Step 4: Smoke test**

- `/api/email-marketing/unsubscribe?token=<valid>` → 200 "Unsubscribed".
- `/api/email-marketing/unsubscribe?token=garbage` → 400.
- `/api/admin/users?archived=true` → archived list. `?archived=false` → active list.

- [ ] **Step 5: Commit**

```
git add server/routes/emailMarketing.js server/routes/admin.js
git commit -m "fix(security): wrap /unsubscribe in asyncHandler, parameterize admin statusClause"
```

---

### Task 5: Schedulers env guard

**Files:**
- Modify: `server/index.js:210-225`
- Modify: `.env.example`

Audit finding #6 (top-21) / Codex server architecture [P1]. Schedulers currently run on every web instance. If the service is ever scaled to N instances, every job runs N times per cycle — duplicate Stripe charges, duplicate emails.

- [ ] **Step 1: Read**

Read `server/index.js:200-230` and `.env.example`.

- [ ] **Step 2: Wrap scheduler kickoffs**

Find the block where `startBalanceScheduler()`, `startAutoAssignScheduler()`, `startEmailSequenceScheduler()`, and event-completion are started. Wrap with:

```javascript
if (process.env.RUN_SCHEDULERS !== 'false') {
  startBalanceScheduler();
  startAutoAssignScheduler();
  startEmailSequenceScheduler();
  // ... any other timer kickoffs ...
  console.log('[schedulers] started (RUN_SCHEDULERS=', process.env.RUN_SCHEDULERS ?? 'unset (default on)', ')');
} else {
  console.log('[schedulers] disabled via RUN_SCHEDULERS=false');
}
```

- [ ] **Step 3: Document in .env.example**

Add to `.env.example`:

```
# Set to 'false' on additional web instances to prevent duplicate scheduler runs.
# Default (unset) runs schedulers — keep default for single-instance deploys (Render free/starter).
RUN_SCHEDULERS=
```

- [ ] **Step 4: Smoke test**

Start dev server, confirm "schedulers started" log. Then `RUN_SCHEDULERS=false npm run dev` — confirm "schedulers disabled" log and no scheduler activity after 1 min.

- [ ] **Step 5: Commit**

```
git add server/index.js .env.example
git commit -m "fix(deploy): env guard RUN_SCHEDULERS to prevent duplicate work on multi-instance"
```

---

## PHASE 2 — Auth & input hardening (6 commits)

### Task 6: CORS tighten !origin to /api/health only

**Files:**
- Modify: `server/index.js:80-105`

Audit top-21 #7.

- [ ] **Step 1: Read**

Read `server/index.js:80-120`.

- [ ] **Step 2: Replace the CORS !origin branch**

Find `if (!origin) return callback(null, true);` (around line 96). Replace with:

```javascript
if (!origin) {
  // Only allow origin-less requests to health probe.
  // All mutating routes require an Origin header.
  if (req?.path === '/api/health' || /^\/api\/health/.test(req?.path || '')) {
    return callback(null, true);
  }
  return callback(new Error('Origin required'), false);
}
```

Note: Express's `cors` middleware doesn't pass `req` to the origin function. Refactor to inline the allow-list — apply `cors()` with a static config for `/api/health` and a stricter config for everything else:

```javascript
// Health probe: permissive
app.get('/api/health', cors({ origin: true }), (req, res) => res.json({ status: 'ok' }));

// All other API routes: strict origin list
app.use('/api', cors({
  origin: (origin, callback) => {
    if (!origin) return callback(new Error('Origin required'), false);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'), false);
  },
  credentials: true,
}));
```

Keep `ALLOWED_ORIGINS` as defined today (prod domains + `CLIENT_URL`).

- [ ] **Step 3: Smoke test**

- `curl http://localhost:5000/api/health` → 200.
- `curl http://localhost:5000/api/proposals` (no Origin) → 403 or CORS error.
- `curl -H "Origin: http://localhost:3000" http://localhost:5000/api/auth/login -X POST` → passes CORS (401 for missing body is OK).

- [ ] **Step 4: Commit**

```
git add server/index.js
git commit -m "fix(security): tighten CORS !origin to /api/health only"
```

---

### Task 7: JWT token_version — schema + auth integration

**Files:**
- Modify: `server/db/schema.sql` (add column)
- Modify: `server/routes/auth.js` (login, register, password reset)
- Modify: `server/middleware/auth.js` (verify)

Audit top-21 #8 (partial — token_version half).

- [ ] **Step 1: Read all three files' relevant sections**

Read `server/db/schema.sql` around the `users` table definition, `server/routes/auth.js` entirely, and `server/middleware/auth.js` entirely.

- [ ] **Step 2: Add schema column (idempotent)**

In `server/db/schema.sql`, locate the `users` table (or the `ALTER TABLE users ADD COLUMN IF NOT EXISTS ...` block that's already at the bottom of the file) and add:

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 3: Embed version in JWTs on login + register**

In `server/routes/auth.js`, in both the login and register handlers, change the JWT `sign` call from:

```javascript
jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
```

to:

```javascript
jwt.sign(
  { id: user.id, email: user.email, role: user.role, tokenVersion: user.token_version ?? 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);
```

Ensure the `SELECT` before the sign returns `token_version` (add to the column list if missing).

- [ ] **Step 4: Increment on password reset**

In `server/routes/auth.js`, find the password-reset handler. In the same transaction that updates `password_hash`, add:

```javascript
await client.query(
  'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2',
  [newHash, userId]
);
```

Merge into the existing UPDATE if there is one.

- [ ] **Step 5: Verify on middleware**

In `server/middleware/auth.js`, after `jwt.verify` succeeds, add a DB check:

```javascript
const { rows } = await pool.query('SELECT token_version FROM users WHERE id = $1', [decoded.id]);
if (!rows.length) {
  return res.status(401).json({ error: 'User not found' });
}
if ((rows[0].token_version ?? 0) !== (decoded.tokenVersion ?? 0)) {
  return res.status(401).json({ error: 'Session expired — please log in again' });
}
req.user = { id: decoded.id, email: decoded.email, role: decoded.role };
```

This adds one DB round-trip per authenticated request. Acceptable for safety; cache later if profiling shows impact.

- [ ] **Step 6: Restart server — verify schema migration applied**

Restart `npm run dev`. On startup, schema.sql runs idempotently. Check the Postgres log or:

```bash
psql $DATABASE_URL -c "\d users" | grep token_version
```

Expected: `token_version | integer | not null default 0`.

- [ ] **Step 7: Smoke test**

- Log in, confirm token works for /api/admin/users.
- Reset password for a test user; confirm old JWT rejected with 401.

- [ ] **Step 8: Commit**

```
git add server/db/schema.sql server/routes/auth.js server/middleware/auth.js
git commit -m "feat(auth): token_version invalidates JWTs on password reset"
```

---

### Task 8: UNSUBSCRIBE_SECRET env var + sign path

**Files:**
- Modify: `server/routes/emailMarketing.js` (find unsubscribe JWT sign + verify paths — already touched in Task 4)
- Modify: `.env.example`

Audit top-21 #8 (second half). Task 4 already added the `UNSUBSCRIBE_SECRET || JWT_SECRET` fallback on the verify side. This task handles the sign side and documents.

- [ ] **Step 1: Grep for `jwt.sign` in emailMarketing.js**

```
grep -n "jwt.sign" server/routes/emailMarketing.js server/utils/emailTemplates.js
```

- [ ] **Step 2: Update every unsubscribe-link sign call**

Wherever an unsubscribe JWT is signed (likely `emailMarketing.js:64` / `:457` and possibly `emailTemplates.js`), change:

```javascript
jwt.sign({ leadId, purpose: 'unsubscribe' }, process.env.JWT_SECRET, { expiresIn: '365d' });
```

to:

```javascript
jwt.sign({ leadId, purpose: 'unsubscribe' }, process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET, { expiresIn: '365d' });
```

- [ ] **Step 3: Document in .env.example**

Add to `.env.example`:

```
# Optional: separate signing key for unsubscribe / marketing-link JWTs.
# If unset, falls back to JWT_SECRET (graceful migration).
# Set in prod to isolate marketing-token compromise from auth-token compromise.
UNSUBSCRIBE_SECRET=
```

- [ ] **Step 4: Smoke test**

With `UNSUBSCRIBE_SECRET` unset: send yourself a test campaign email, click unsubscribe link — 200. Set `UNSUBSCRIBE_SECRET=testsecret` in `.env`, restart, send another email, click — 200 (new links signed with new secret). Old link from first email still works (fallback to JWT_SECRET on verify).

- [ ] **Step 5: Commit**

```
git add server/routes/emailMarketing.js server/utils/emailTemplates.js .env.example
git commit -m "feat(security): separate UNSUBSCRIBE_SECRET env var for marketing-link JWTs"
```

---

### Task 9: Proposal validation — override bounds + status state machine

**Files:**
- Modify: `server/routes/proposals.js` (PATCH handler + status handler, approximately lines 880-990)

Audit top-21 #9 and #10. Grouped because they're adjacent in the same file.

- [ ] **Step 1: Read**

Read `server/routes/proposals.js:860-1000`.

- [ ] **Step 2: Add bounds check to total_price_override**

In the PATCH /:id handler, before the UPDATE, add:

```javascript
if (req.body.total_price_override !== undefined && req.body.total_price_override !== null) {
  const override = Number(req.body.total_price_override);
  if (!Number.isFinite(override) || override < 0 || override >= 1_000_000) {
    throw new ValidationError({ total_price_override: 'Must be between 0 and 999,999' });
  }
}
```

- [ ] **Step 3: Add state-machine map**

Near the top of the file (after the requires), add:

```javascript
const STATUS_TRANSITIONS = {
  draft: ['sent', 'archived'],
  sent: ['viewed', 'accepted', 'draft'],
  viewed: ['accepted', 'sent', 'archived'],
  accepted: ['deposit_paid', 'sent'],
  deposit_paid: ['balance_paid', 'completed'],
  balance_paid: ['completed'],
  completed: [],
  archived: ['draft'],
};
```

- [ ] **Step 4: Enforce in PATCH /:id/status**

Replace the current validation in the status handler with:

```javascript
const { status: newStatus } = req.body;
const force = req.query.force === 'true' && req.user.role === 'admin';
if (!validStatuses.includes(newStatus)) {
  throw new ValidationError({ status: 'Invalid status' });
}

// Fetch current status
const { rows: currentRows } = await pool.query('SELECT status FROM proposals WHERE id = $1', [req.params.id]);
if (!currentRows.length) throw new NotFoundError('Proposal not found');
const currentStatus = currentRows[0].status;

if (!force) {
  const allowed = STATUS_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(newStatus)) {
    throw new ValidationError({
      status: `Cannot transition from ${currentStatus} to ${newStatus} without ?force=true (admin only)`,
    });
  }
}

// Existing UPDATE + activity log
if (force) {
  await pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, actor_id, action, details) VALUES ($1, $2, 'status_force_changed', $3)`,
    [req.params.id, req.user.id, JSON.stringify({ from: currentStatus, to: newStatus })]
  );
}
// ... rest of existing handler unchanged
```

- [ ] **Step 5: Smoke test**

- PATCH a proposal to an invalid total_price_override (-1 or 2_000_000) → 400.
- Try to force a 'draft' → 'balance_paid' transition without `?force=true` → 400.
- Same transition with `?force=true` as admin → 200, activity log entry created.

- [ ] **Step 6: Commit**

```
git add server/routes/proposals.js
git commit -m "fix(data): proposal total_price_override bounds + status state machine"
```

---

### Task 10: Blog image size + content-type check

**Files:**
- Modify: `server/routes/blog.js:20-55`

Audit top-21 #20.

- [ ] **Step 1: Read**

Read `server/routes/blog.js:1-80`.

- [ ] **Step 2: Add size + content-type check in the image proxy**

Find the handler at `/images/:filename`. Replace the proxy logic:

```javascript
const response = await fetch(signedUrl);
if (!response.ok) throw new NotFoundError('Image not found');

const contentType = response.headers.get('content-type') || '';
const contentLength = parseInt(response.headers.get('content-length') || '0', 10);

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
if (!ALLOWED_TYPES.some(t => contentType.startsWith(t))) {
  throw new ValidationError({ image: 'Unsupported image type' });
}
if (contentLength > 10 * 1024 * 1024) {
  return res.status(413).send('Image too large');
}

res.set('Content-Type', contentType);
res.set('Cache-Control', 'public, max-age=86400');
response.body.pipe(res);
```

- [ ] **Step 3: Smoke test**

Upload a blog post with an image. Confirm it displays. `curl -I http://localhost:5000/api/blog/images/<known-filename>` → sees Content-Type and Cache-Control headers.

- [ ] **Step 4: Commit**

```
git add server/routes/blog.js
git commit -m "fix(security): blog image proxy enforces size + content-type allowlist"
```

---

### Task 11: Admin HTML server-side sanitization + express.json limit + gitignore + dep pinning

**Files:**
- Modify: `server/routes/emailMarketing.js` (INSERT + UPDATE campaign handlers, ~279 and ~348)
- Modify: `server/index.js:109`
- Modify: `.gitignore`
- Modify: `package.json`

Grouped: all are small, adjacent-concern hardening edits.

Audit top-21 #14, #17, #19, #21.

- [ ] **Step 1: Read the 4 files**

Read `server/routes/emailMarketing.js:260-360`, `server/index.js:105-115`, `.gitignore` entirely, `package.json` entirely.

- [ ] **Step 2: Sanitize html_body server-side**

At the top of `server/routes/emailMarketing.js`, if not already imported:

```javascript
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');
const DOMPurify = createDOMPurify(new JSDOM('').window);

const EMAIL_SANITIZE_OPTIONS = {
  ALLOWED_TAGS: ['a', 'b', 'br', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'u', 'ul', 'table', 'tbody', 'td', 'th', 'thead', 'tr'],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'style', 'width', 'height', 'target', 'rel'],
  ALLOW_DATA_ATTR: false,
};
```

In both the campaign INSERT handler (around line 279) and UPDATE handler (around line 348), before the SQL executes, replace any occurrence of `html_body` param usage with the sanitized form:

```javascript
const html_body = req.body.html_body ? DOMPurify.sanitize(req.body.html_body, EMAIL_SANITIZE_OPTIONS) : req.body.html_body;
const html_draft = req.body.html_draft ? DOMPurify.sanitize(req.body.html_draft, EMAIL_SANITIZE_OPTIONS) : req.body.html_draft;
```

Do the same in any step INSERT/UPDATE handlers (around the campaign steps endpoints).

- [ ] **Step 3: Tighten express.json limit**

In `server/index.js:109`, change:

```javascript
app.use(express.json({ limit: '10mb' }));
```

to:

```javascript
app.use(express.json({ limit: '1mb' }));
```

If blog post save breaks after this (TipTap inline images can push close to 1MB), add a per-route override just for `/api/blog`:

```javascript
// before app.use('/api/blog', ...)
app.use('/api/blog', express.json({ limit: '10mb' }));
```

Test first, revisit if needed.

- [ ] **Step 4: Extend .gitignore**

Append to `.gitignore` (if not already present):

```
.env.*
!.env.example
*.key
*.pem
```

- [ ] **Step 5: Pin security-critical deps in package.json (root)**

First, get the actually-installed versions:

```bash
node -p "const l = require('./package-lock.json').packages; ['bcryptjs','stripe','jsonwebtoken','pg','dompurify','jsdom','helmet','express'].map(n => n+'@'+(l['node_modules/'+n]?.version||'?')).join('\n')"
```

Then edit `package.json` `"dependencies"` — remove the `^` prefix from each of the 8 entries above, keeping the exact version reported by the command. Do NOT run `npm install` after — the lockfile already has these versions, the edit just stops future fresh installs from pulling a wider range.

- [ ] **Step 6: Smoke test**

- Admin → Email Marketing → create a campaign with `<script>alert(1)</script>` in html_body → verify DB row has script stripped.
- `curl -X POST http://localhost:5000/api/auth/login -H "Content-Type: application/json" -d @large-body.json` (>1MB) → 413.
- `git status` shows no ignored files staged.

- [ ] **Step 7: Commit**

```
git add server/routes/emailMarketing.js server/index.js .gitignore package.json
git commit -m "fix(security): admin html sanitize, express.json 1mb, gitignore+pin deps"
```

---

## PHASE 3 — Error handling & observability (3 commits)

### Task 12: Scheduler hygiene

**Files:**
- Modify: `server/utils/balanceScheduler.js:9-92`
- Modify: `server/utils/emailSequenceScheduler.js:130-140`
- Modify: `server/routes/drinkPlans.js:345-355`

Audit top-21 #11, #12, #13 + follow-up item D.

- [ ] **Step 1: Read all three files**

- [ ] **Step 2: balanceScheduler Sentry on no-stripe + admin email on autopay failure + per-iteration try/catch**

Top of `balanceScheduler.js` near the stripe client check:

```javascript
let stripeUnavailableLastLog = 0;
async function runAutopay() {
  const stripe = getStripe();
  if (!stripe) {
    const now = Date.now();
    if (now - stripeUnavailableLastLog > 60 * 60 * 1000) { // once per hour
      Sentry.captureMessage('Autopay disabled — no Stripe client', 'warning');
      stripeUnavailableLastLog = now;
    }
    return;
  }
  // ...existing logic
}
```

In the per-proposal autopay loop (~line 50-56), inside the existing try/catch for `stripe.paymentIntents.create`, add the admin email send after the activity-log insert:

```javascript
await sendEmail({
  to: process.env.ADMIN_EMAIL || 'contact@drbartender.com',
  subject: `Autopay failed: ${proposal.client_name} ($${proposal.amount_due / 100})`,
  html: `<p>Autopay attempt failed for proposal <a href="${process.env.CLIENT_URL}/admin/proposals/${proposal.id}">${proposal.id}</a>.</p><p>Error: ${err.message}</p>`,
});
```

In the auto-complete batch around line 68-92, wrap the inner `pool.query(...)` writes in their own try/catch so one failure doesn't abort the loop:

```javascript
for (const proposal of toComplete) {
  try {
    await pool.query(`UPDATE proposals SET status = 'completed' WHERE id = $1`, [proposal.id]);
    await pool.query(`INSERT INTO proposal_activity_log ...`, [...]);
  } catch (err) {
    Sentry.captureException(err, { tags: { scheduler: 'auto-complete', proposalId: proposal.id } });
  }
}
```

- [ ] **Step 3: emailSequenceScheduler swallowed catch**

In `emailSequenceScheduler.js:136`, replace:

```javascript
}).catch(() => {});
```

with:

```javascript
}).catch(err => Sentry.captureException(err, { tags: { scheduler: 'emailSequence' } }));
```

- [ ] **Step 4: drinkPlans ROLLBACK try/catch**

In `server/routes/drinkPlans.js:345-355`, find the `catch` block around line 349 that calls `await client.query('ROLLBACK')`. Wrap it:

```javascript
try {
  await client.query('ROLLBACK');
} catch (rbErr) {
  console.error('ROLLBACK failed:', rbErr);
  Sentry.captureException(rbErr, { tags: { route: 'drinkPlans', op: 'rollback' } });
}
```

- [ ] **Step 5: Smoke test**

Trigger an intentional autopay failure in dev (use a test Stripe card that fails). Confirm Sentry event captured and admin email queued. Scheduler logs don't show loop-abort.

- [ ] **Step 6: Commit**

```
git add server/utils/balanceScheduler.js server/utils/emailSequenceScheduler.js server/routes/drinkPlans.js
git commit -m "fix(observability): scheduler sentry captures + per-iteration try/catch + rollback guard"
```

---

### Task 13: Webhook signature-failure Sentry captures

**Files:**
- Modify: `server/routes/emailMarketingWebhook.js:40-55` (already touched in Task 1 — confirm present)
- Modify: `server/routes/thumbtack.js:50-60`
- Modify: `server/routes/stripe.js:520-530`

Audit top-21 A09 bucket. Task 1 already added the Sentry capture for Resend; this task covers Thumbtack and Stripe.

- [ ] **Step 1: Read**

Read `server/routes/thumbtack.js:30-70` and `server/routes/stripe.js:500-540`.

- [ ] **Step 2: Thumbtack — add Sentry on signature mismatch**

Where the thumbtack webhook checks `crypto.timingSafeEqual` and returns 401 on mismatch, add before the return:

```javascript
Sentry.captureMessage('Thumbtack webhook signature failure', {
  level: 'warning',
  tags: { webhook: 'thumbtack', reason: 'invalid_signature' },
});
```

- [ ] **Step 3: Stripe — add Sentry on constructEvent failure**

In the Stripe webhook handler's catch for `constructEvent`, before the 400 return:

```javascript
Sentry.captureMessage('Stripe webhook signature failure', {
  level: 'warning',
  tags: { webhook: 'stripe', reason: 'invalid_signature' },
});
```

- [ ] **Step 4: Smoke test**

`curl` each webhook with an invalid signature; confirm 401/400 response and (in staging with Sentry DSN) the warning event appears.

- [ ] **Step 5: Commit**

```
git add server/routes/thumbtack.js server/routes/stripe.js
git commit -m "fix(observability): sentry capture on thumbtack + stripe webhook sig failures"
```

---

### Task 14: RETURNING on 4 mutations + stripe_payment_link_id idempotency

**Files:**
- Modify: `server/routes/proposals.js:127-133, 896-924`
- Modify: `server/routes/shifts.js:377-393`
- Modify: `server/routes/drinkPlans.js:105-122`
- Modify: `server/db/schema.sql` (index addition)
- Modify: `server/routes/stripe.js:95-115, 360-370`

Audit follow-up items J + O.

- [ ] **Step 1: Read all sections**

- [ ] **Step 2: Add RETURNING to each UPDATE**

For each of the 4 mutation sites, change the UPDATE statement to include `RETURNING *` (or an allowlist for proposals — exclude `admin_notes`, `stripe_customer_id`, `stripe_payment_method_id`, `client_signature_data`, `pricing_snapshot` on the client-signature path, which is client-facing). Respond with the returned row:

Example for `proposals.js:896-924`:

```javascript
const updated = await pool.query(
  `UPDATE proposals SET ... WHERE id = $N RETURNING *`,
  [...params, id]
);
res.json(updated.rows[0]);
```

- [ ] **Step 3: Add stripe_sessions unique index**

In `server/db/schema.sql`, add (idempotent):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_sessions_payment_link ON stripe_sessions(stripe_payment_link_id) WHERE stripe_payment_link_id IS NOT NULL;
```

- [ ] **Step 4: Add idempotency check in stripe.js payment-link creation**

In `server/routes/stripe.js` near line 330-370, before creating a new payment link, check:

```javascript
const { rows: existingLinkRows } = await pool.query(
  `SELECT stripe_payment_link_id, amount FROM stripe_sessions
   WHERE proposal_id = $1 AND stripe_payment_link_id IS NOT NULL AND amount = $2
   ORDER BY created_at DESC LIMIT 1`,
  [proposalId, amount]
);
if (existingLinkRows.length) {
  // Reuse existing link
  return res.json({ url: `https://buy.stripe.com/...${existingLinkRows[0].stripe_payment_link_id}` });
  // or fetch the link URL via Stripe SDK if needed
}
```

- [ ] **Step 5: Restart, verify schema migration applied**

```bash
psql $DATABASE_URL -c "\di idx_stripe_sessions_payment_link"
```

- [ ] **Step 6: Smoke test**

- Admin PATCH a proposal → response body contains updated row.
- Client signs proposal → response contains updated row.
- Shift UPDATE → returns row.
- Drink-plan PUT → returns row.
- Request payment link twice for same proposal + amount → second request reuses link id.

- [ ] **Step 7: Commit**

```
git add server/routes/proposals.js server/routes/shifts.js server/routes/drinkPlans.js server/db/schema.sql server/routes/stripe.js
git commit -m "fix(data): RETURNING on 4 mutations + stripe_payment_link idempotency"
```

---

## PHASE 4 — Performance (5 commits)

### Task 15: Column allowlists on list endpoints

**Files:**
- Modify: `server/routes/proposals.js:685-716`
- Modify: `server/routes/drinkPlans.js:365-387, 444-453, 518-527`
- Modify: `server/routes/emailMarketing.js:241-263, 292, 306-312, 517-523, 677-685, 742-750`
- Modify: `server/routes/clients.js:49-62`
- Modify: `server/routes/shifts.js:36-74` (paginate)

Audit follow-up A, B, C + shifts/clients entries.

- [ ] **Step 1: Read all sites**

- [ ] **Step 2: proposals list — explicit columns**

In `proposals.js:685-716`, replace `SELECT p.*, c.name AS client_name ...` with:

```javascript
SELECT p.id, p.token, p.client_id, p.event_type, p.event_type_custom,
       p.event_date, p.event_start_time, p.event_end_time, p.event_duration_hours,
       p.guest_count, p.venue_name, p.venue_address, p.num_bars, p.num_bartenders,
       p.package_id, p.status, p.total_price, p.amount_paid, p.deposit_amount,
       p.payment_type, p.created_at, p.updated_at, p.last_viewed_at, p.sent_at,
       p.accepted_at, p.client_email, p.client_phone,
       c.name AS client_name, c.email AS client_email_joined
FROM proposals p
LEFT JOIN clients c ON p.client_id = c.id
```

- [ ] **Step 3: drink-plans list + detail + by-proposal — exclude selections/shopping_list from list**

In `drinkPlans.js:365-387` (list), replace `SELECT dp.*` with:

```javascript
SELECT dp.id, dp.token, dp.proposal_id, dp.status,
       dp.exploration_submitted_at, dp.refinement_submitted_at, dp.completed_at,
       dp.created_at, dp.updated_at,
       p.client_id, p.event_date, p.event_type, p.event_type_custom
FROM drink_plans dp
JOIN proposals p ON dp.proposal_id = p.id
```

In `:444-453` and `:518-527` (single fetch endpoints), keep `dp.selections` (detail needs it) but drop `dp.shopping_list` (has its own endpoint).

- [ ] **Step 4: emailMarketing 5 sites**

- `:241-263` campaigns list — replace `c.*` with `c.id, c.name, c.type, c.status, c.subject, c.target_sources, c.target_event_types, c.created_at, c.updated_at, c.sent_at, c.sends_count`.
- `:292` campaign detail — keep `*` on campaign, but for the attached sends array:
- `:306-312` sends — add `ORDER BY created_at DESC LIMIT 500`.
- `:517-523` campaign steps — replace `*` with `id, step_order, subject, delay_hours, created_at`. Load body on step edit only.
- `:677-685` enrollments — add `ORDER BY created_at DESC LIMIT 500`.
- `:742-750` conversations — exclude `body_html`; add a separate detail fetch for bodies on expand.

- [ ] **Step 5: clients detail + shifts list pagination**

- `clients.js:49-62` — allowlist client and joined proposals columns; exclude `pricing_snapshot`, `admin_notes`.
- `shifts.js:36-74` — add `?page` query param; `LIMIT 100 OFFSET (page-1)*100`; return `{ shifts, total, page }` response shape. Update frontend `AdminDashboard.js` / `EventsDashboard.js` if they rely on the flat-array shape — add a fallback `shifts: Array.isArray(data) ? data : data.shifts`.

- [ ] **Step 6: Smoke test**

- Admin proposals list — confirm loads faster, no pricing_snapshot blob in response.
- Admin drink-plans list — confirm no selections/shopping_list in response.
- Admin campaigns list — confirm no html_body.
- Admin shifts — pagination works.

- [ ] **Step 7: Commit**

```
git add server/routes/proposals.js server/routes/drinkPlans.js server/routes/emailMarketing.js server/routes/clients.js server/routes/shifts.js
git commit -m "perf: explicit column allowlists on list endpoints (drop large JSONB blobs)"
```

---

### Task 16: Bulk INSERT / batch mutations

**Files:**
- Modify: `server/routes/admin.js:696-720` (geocode backfill)
- Modify: `server/routes/admin.js:800-849` (blog import)
- Modify: `server/routes/emailMarketing.js:649-670` (campaign enroll)
- Modify: `server/routes/messages.js:81-126` (SMS blast)
- Modify: `server/routes/proposals.js:487-492, 799-803, 928-933` (addon INSERT loops)
- Modify: `server/routes/drinkPlans.js:208-227` (addon UPSERT loop)
- Modify: `server/utils/autoAssign.js:297-323` (candidate UPDATE batch)

Audit follow-up items D, E, F, G + addon loops.

- [ ] **Step 1: Geocode backfill bulk UPDATE**

In `admin.js:696-720` (contractor_profiles) and `:713-720` (shifts), replace the per-row `UPDATE` inside the Nominatim loop. Keep the 1.1s throttle for Nominatim. Structure:

```javascript
const successes = []; // { id, lat, lng }
for (const row of rows) {
  await sleep(1100); // respect Nominatim rate limit
  try {
    const coords = await geocode(row.address);
    if (coords) successes.push({ id: row.id, lat: coords.lat, lng: coords.lng });
  } catch (err) { /* ... */ }
}
if (successes.length) {
  await pool.query(
    `UPDATE contractor_profiles AS cp
     SET latitude = u.lat, longitude = u.lng
     FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::numeric[]) AS lat, UNNEST($3::numeric[]) AS lng) u
     WHERE cp.id = u.id`,
    [
      successes.map(s => s.id),
      successes.map(s => s.lat),
      successes.map(s => s.lng),
    ]
  );
}
```

Same pattern for shifts.

- [ ] **Step 2: Blog import — Promise.all images + bulk INSERT**

In `admin.js:800-849`, replace sequential image upload + single-row INSERT loop with:

```javascript
const postsWithImages = await Promise.all(posts.map(async (post) => {
  if (post.cover_image_url && post.cover_image_url.startsWith('data:')) {
    const url = await uploadFile(bufferFromDataUrl(post.cover_image_url), `blog_${uuidv4()}.jpg`);
    return { ...post, cover_image_url: url };
  }
  return post;
}));

const values = [];
const placeholders = postsWithImages.map((p, i) => {
  values.push(p.title, p.slug, p.excerpt, p.body, p.cover_image_url, !!p.published, p.published_at || null);
  const base = i * 7;
  return `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7})`;
}).join(',');

await pool.query(
  `INSERT INTO blog_posts (title, slug, excerpt, body, cover_image_url, published, published_at)
   VALUES ${placeholders}
   ON CONFLICT (slug) DO NOTHING`,
  values
);
```

- [ ] **Step 3: Campaign enroll bulk INSERT**

In `emailMarketing.js:649-670`, replace the `for (const leadId of lead_ids)` loop with:

```javascript
await pool.query(
  `INSERT INTO email_sequence_enrollments (campaign_id, lead_id, status, next_step_due_at)
   SELECT $1, id, 'active', NOW() FROM email_leads WHERE id = ANY($2)
   ON CONFLICT (campaign_id, lead_id) DO NOTHING`,
  [campaignId, lead_ids]
);
```

- [ ] **Step 4: SMS blast — batch sms_messages INSERT**

In `messages.js:81-126`, keep sequential Twilio sends, but collect rows and bulk INSERT once after:

```javascript
const rows = [];
for (const recipient of recipients) {
  try {
    const sent = await twilioClient.messages.create({ to: recipient.phone, from: TWILIO_PHONE, body });
    rows.push([recipient.user_id, body, recipient.phone, 'sent', sent.sid, null]);
  } catch (err) {
    rows.push([recipient.user_id, body, recipient.phone, 'failed', null, err.message]);
  }
}
if (rows.length) {
  const placeholders = rows.map((_, i) => {
    const b = i * 6;
    return `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6})`;
  }).join(',');
  await pool.query(
    `INSERT INTO sms_messages (user_id, body, phone, status, twilio_sid, error_message) VALUES ${placeholders}`,
    rows.flat()
  );
}
```

- [ ] **Step 5: Addon INSERT loops (3 sites)**

In each of `proposals.js:487-492 / 799-803 / 928-933` and `drinkPlans.js:208-227`, replace per-addon INSERT loops with multi-row VALUES:

```javascript
if (addons.length) {
  const placeholders = addons.map((_, i) => {
    const b = i * 7;
    return `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7})`;
  }).join(',');
  const values = addons.flatMap(a => [proposalId, a.addon_id, a.addon_name, a.billing_type, a.rate, a.quantity, a.line_total]);
  await client.query(
    `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
     VALUES ${placeholders}
     ON CONFLICT (proposal_id, addon_id) DO UPDATE SET
       addon_name = EXCLUDED.addon_name,
       billing_type = EXCLUDED.billing_type,
       rate = EXCLUDED.rate,
       quantity = EXCLUDED.quantity,
       line_total = EXCLUDED.line_total`,
    values
  );
}
```

(Use `ON CONFLICT DO UPDATE` only where drinkPlans.js had UPSERT semantics; on the proposals.js create paths it can be `ON CONFLICT DO NOTHING` or remove the conflict clause since DELETE-first is already there.)

- [ ] **Step 6: autoAssign candidate UPDATE batch**

In `server/utils/autoAssign.js:297-323`, replace per-candidate `UPDATE shift_requests` with:

```javascript
if (selected.length) {
  const selectedIds = selected.map(c => c.id);
  await pool.query(
    `UPDATE shift_requests SET status = 'approved', approved_at = NOW() WHERE id = ANY($1)`,
    [selectedIds]
  );
}
```

SMS notifications remain sequential (Twilio throttle).

- [ ] **Step 7: Smoke test**

- Trigger a small blog import (2-3 posts) — confirm posts land, images uploaded.
- Enroll 5 leads in a campaign — confirm 5 rows in enrollments (or fewer if conflicts).
- Send SMS to 3 staff — confirm 3 rows in sms_messages.
- Create a proposal with multiple addons — confirm proposal_addons rows.

- [ ] **Step 8: Commit**

```
git add server/routes/admin.js server/routes/emailMarketing.js server/routes/messages.js server/routes/proposals.js server/routes/drinkPlans.js server/utils/autoAssign.js
git commit -m "perf: bulk INSERT/UPDATE replaces N+1 loops across 7 routes"
```

---

### Task 17: Promise.all sweep on sequential-independent awaits

**Files:**
- Modify: `server/routes/emailMarketing.js:291-330, 191-207`
- Modify: `server/routes/shifts.js:184-214`
- Modify: `server/routes/clients.js:49-62`
- Modify: `server/routes/stripe.js:803-833`
- Modify: `server/utils/balanceScheduler.js:27-57` (bounded concurrency)

Audit follow-up item H + I + balanceScheduler.

- [ ] **Step 1: Parallelize each site**

For each of the detail endpoints, replace the sequential awaits with `Promise.all`. Example for `clients.js:49-62`:

```javascript
// Before:
const client = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
const proposals = await pool.query('SELECT ... FROM proposals WHERE client_id = $1 ORDER BY ...', [id]);

// After:
const [clientResult, proposalsResult] = await Promise.all([
  pool.query('SELECT ...FROM clients WHERE id = $1', [id]),
  pool.query('SELECT ... FROM proposals WHERE client_id = $1 ORDER BY ...', [id]),
]);
```

Apply the same pattern to the other sites. For `stripe.js:803-833` (payment_intent.payment_failed), parallelize the 3 independent writes:

```javascript
await Promise.all([
  pool.query('UPDATE stripe_sessions SET status = $1 WHERE stripe_payment_intent_id = $2', ['failed', pi.id]),
  pool.query('INSERT INTO proposal_payments ...', [...]),
  pool.query('INSERT INTO proposal_activity_log ...', [...]),
]);
```

- [ ] **Step 2: balanceScheduler bounded concurrency**

In `server/utils/balanceScheduler.js:27-57`, replace the sequential `for` loop with bounded parallelism. Install `p-limit` if not present, or use a manual chunker:

```javascript
const CONCURRENCY = 5;
const chunks = [];
for (let i = 0; i < proposals.length; i += CONCURRENCY) {
  chunks.push(proposals.slice(i, i + CONCURRENCY));
}
for (const chunk of chunks) {
  await Promise.all(chunk.map(async (proposal) => {
    try {
      // existing per-proposal autopay logic, including Sentry capture + admin email from Task 12
    } catch (err) {
      Sentry.captureException(err, { tags: { scheduler: 'autopay', proposalId: proposal.id } });
    }
  }));
}
```

- [ ] **Step 3: Smoke test**

- Load admin client detail page — visually confirm still loads, with faster initial render.
- Load a campaign detail page with steps — confirm loads.
- Use Stripe test-mode card that fails to charge — confirm webhook handler writes all 3 records.

- [ ] **Step 4: Commit**

```
git add server/routes/emailMarketing.js server/routes/shifts.js server/routes/clients.js server/routes/stripe.js server/utils/balanceScheduler.js
git commit -m "perf: Promise.all sweep on 5 endpoints + bounded autopay concurrency"
```

---

### Task 18: PotionPlanningLab React.lazy + blog cache header + unpaginated LIMITs

**Files:**
- Modify: `client/src/pages/plan/PotionPlanningLab.js:9-27`
- Modify: `server/routes/blog.js:56-70`
- Modify: `server/routes/shifts.js:117-127, 505-516, 87-101`
- Modify: `server/routes/admin.js:414-424`

Audit top-21 #15 + follow-up unpaginated items.

- [ ] **Step 1: PotionPlanningLab lazy loading**

In `client/src/pages/plan/PotionPlanningLab.js`, replace the eager step imports (lines 9-27 except WelcomeStep) with lazy:

```javascript
import { Suspense, lazy } from 'react';
import WelcomeStep from './steps/WelcomeStep'; // keep eager (first-rendered)

const QuickPickStep = lazy(() => import('./steps/QuickPickStep'));
const CustomSetupStep = lazy(() => import('./steps/CustomSetupStep'));
const SignaturePickerStep = lazy(() => import('./steps/SignaturePickerStep'));
const BeerWineStep = lazy(() => import('./steps/BeerWineStep'));
const FullBarSpiritsStep = lazy(() => import('./steps/FullBarSpiritsStep'));
const FullBarBeerWineStep = lazy(() => import('./steps/FullBarBeerWineStep'));
const MocktailStep = lazy(() => import('./steps/MocktailStep'));
const MenuDesignStep = lazy(() => import('./steps/MenuDesignStep'));
const LogisticsStep = lazy(() => import('./steps/LogisticsStep'));
const ConfirmationStep = lazy(() => import('./steps/ConfirmationStep'));
const VibeStep = lazy(() => import('./steps/VibeStep'));
const FlavorDirectionStep = lazy(() => import('./steps/FlavorDirectionStep'));
const ExplorationBrowseStep = lazy(() => import('./steps/ExplorationBrowseStep'));
const MocktailInterestStep = lazy(() => import('./steps/MocktailInterestStep'));
const ExplorationSaveStep = lazy(() => import('./steps/ExplorationSaveStep'));
const RefinementWelcomeStep = lazy(() => import('./steps/RefinementWelcomeStep'));
const HostedGuestPrefsStep = lazy(() => import('./steps/HostedGuestPrefsStep'));
```

Wrap the switch/render of the current step in Suspense:

```jsx
<Suspense fallback={<div className="loading-spinner">Loading...</div>}>
  {renderStep()}
</Suspense>
```

- [ ] **Step 2: Blog public cache header**

In `server/routes/blog.js:56-70`, in the `GET /:slug` handler, before `res.json`, add:

```javascript
res.set('Cache-Control', 'public, max-age=300, s-maxage=600');
```

- [ ] **Step 3: Unpaginated LIMITs**

- `shifts.js:117-127` (my-requests) — add `LIMIT 500`.
- `shifts.js:505-516` (/shifts/:id/requests) — add `LIMIT 500`.
- `shifts.js:87-101` (/user/:userId/events) — add `LIMIT 500`.
- `admin.js:414-424` (/applications/:userId interview notes) — add `LIMIT 100`.

- [ ] **Step 4: Smoke test**

- Load `/plan/<token>` — confirm first-paint is faster, network tab shows step chunks loading on advance.
- Load `/blog/<slug>` — confirm `Cache-Control` in response headers.
- Hit `/api/shifts/user/1/events` — confirm LIMIT in SQL.

- [ ] **Step 5: Commit**

```
git add client/src/pages/plan/PotionPlanningLab.js server/routes/blog.js server/routes/shifts.js server/routes/admin.js
git commit -m "perf: lazy-load potion-planning steps, blog cache header, unpaginated LIMITs"
```

---

## PHASE 5 — Docs & backlog (2 commits)

### Task 19: Folder-tree refresh across docs

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

Audit top-21 #16.

- [ ] **Step 1: Run actual filesystem listing**

```bash
find client/src/pages client/src/components server/routes server/utils -type f \( -name "*.js" -o -name "*.jsx" \) | sort > /tmp/actual-files.txt
```

- [ ] **Step 2: Update CLAUDE.md folder tree**

In `.claude/CLAUDE.md` folder structure section, add the missing entries:

- `client/src/pages/staff/` section with `StaffDashboard.js`, `StaffShifts.js`, `StaffSchedule.js`, `StaffEvents.js`, `StaffResources.js`, `StaffProfile.js`.
- `client/src/pages/HiringLanding.js`
- `client/src/pages/admin/ShiftDetail.js`
- `client/src/pages/public/ClientShoppingList.js`
- `client/src/components/AdminBreadcrumbs.js`
- `client/src/components/StaffLayout.js`

Any other divergences found by `diff` between the tree and the actual filesystem.

- [ ] **Step 3: Update README.md folder tree**

Same entries as CLAUDE.md.

- [ ] **Step 4: Update ARCHITECTURE.md**

Add any new route files or utils to the architecture section if present.

- [ ] **Step 5: Commit**

```
git add .claude/CLAUDE.md README.md ARCHITECTURE.md
git commit -m "docs: refresh folder-tree entries across claude/readme/architecture"
```

---

### Task 20: Audit log annotate + tech-debt.md + schedule follow-up

**Files:**
- Modify: `.claude/full-audit-2026-04-24.log` (gitignored but edit anyway)
- Create: `docs/tech-debt.md`

- [ ] **Step 1: Get commit shas**

```bash
git log --oneline origin/main..HEAD
```

List the ~18 commits this remediation produced with short-shas.

- [ ] **Step 2: Annotate audit log**

Open `.claude/full-audit-2026-04-24.log`. For each finding that was fixed, append `→ FIXED in <short-sha>` to the end of the finding line. Use the commit mapping from Step 1.

Items NOT fixed remain unannotated. These are the source for tech-debt.md.

- [ ] **Step 3: Write docs/tech-debt.md**

Create `docs/tech-debt.md` with this structure:

```markdown
# Tech Debt Backlog

**Source:** `.claude/full-audit-2026-04-24.log` — items deferred from the 2026-04-24 full-audit remediation (bucket B).

Each item is eligible to be re-opened as its own spec when priorities align. Sorted by severity, then by estimated effort.

## Schema migrations (need backup + verification plan)

### shifts.positions_needed + equipment_required TEXT → JSONB

**Source:** audit log, "Follow-up pass" item L.
**What:** Currently stored as TEXT holding JSON text, requiring `JSON.stringify`/`JSON.parse` at every callsite and `::json` casts at query time. Schema plan doc from 2026-04-15 flagged for migration; never done.
**Why deferred:** Requires a production data migration (TEXT → JSONB with content coercion) and a sweep of every callsite removing stringify/parse. Belongs in its own spec.
**Next step:** Brainstorm migration script with rollback plan; coordinate with a deploy window.

### Dead column drops

**Source:** audit log, schema-drift scan section 2.
**What:** Columns that are in schema but unused: `service_addons.is_default`, `users.calendar_token_created_at`, `shifts.client_email`, `shifts.client_phone`, `applications.favorite_color`.
**Why deferred:** Each drop needs user confirmation (is it truly dead? was it intentional scaffold?). Batchable into a single cleanup spec.
**Next step:** Confirm each column with user, write a single DROP COLUMN migration.

## Shape validators (cross-cutting refactor)

### pricing_snapshot shape validator

**Source:** audit log, item K.
**What:** `proposals.pricing_snapshot` JSONB is read by 6+ files. No shape validator. Any key rename in `pricingEngine.js` silently breaks consumers.
**Why deferred:** Requires a version constant, validator extraction, and updates to all 6 consumers. Architecture-adjacent.
**Next step:** Extract `PRICING_SNAPSHOT_VERSION` and validator; assert on read in consumers; bump version on engine changes.

### adjustments + class_options shape validators

**Source:** audit log, items N and Phase 2 scope.
**What:** `proposals.adjustments` (JSONB array of `{label, amount, type?}`) has no server-side shape validation before INSERT. `proposals.class_options` whitelist exists in ONE insert path only — other writers bypass.
**Why deferred:** Need central normalizers in `server/utils/`; calling sites have to be updated.
**Next step:** Write `normalizeAdjustments()` and `normalizeClassOptions()` helpers; route every writer through them.

## Architecture refactors (each needs its own design session)

### True schedulers-to-worker-process split

**Source:** Codex server [P1], audit top-21 #6. Phase 1 of this remediation landed the env-guard stopgap.
**What:** Current: `RUN_SCHEDULERS=false` opts extra instances out. Ideal: dedicated worker entrypoint, deployment topology explicit.
**Why deferred:** Changes deployment config on Render; needs a second service or process-group setup.
**Next step:** Design doc for worker-process split, coordinate with Render config.

### Drink-plan extras pricing service

**Source:** Codex server [P2].
**What:** Add-on + bar-rental + syrup charges are recomputed inline in `stripe.js`, `drinkPlans.js`, and `invoiceHelpers.js`. One concept, three owners.
**Why deferred:** Cross-cutting extraction; needs tests around pricing.
**Next step:** Extract to `server/utils/drinkPlanPricing.js`; route all three consumers through it.

### Proposal-creation workflow consolidation

**Source:** Codex server [P2].
**What:** Public and admin proposal-creation paths in `proposals.js` already diverge in validation and side effects. Every pricing/proposal-field change risks diverging further.
**Why deferred:** Real refactor with behavioral tests needed.
**Next step:** Design doc; extract `createProposal(ctx, input)` service; both routes consume.

### PotionPlanningLab state-controller split

**Source:** Codex client [P2].
**What:** The page is an orchestration layer for API loading, migration, autosave, browser-history interception, payment redirect handling, queue derivation, AND step rendering. Steps are thin leaves over shared mutable state.
**Why deferred:** Large restructure.
**Next step:** Extract controller hooks or flow context; steps become presentation-only.

### ClientAuthContext via utils/api.js

**Source:** Codex client [P2].
**What:** `ClientAuthContext` uses raw `fetch` instead of the shared `utils/api.js` axios instance. Two auth domains, two error handling paths.
**Why deferred:** Small enough to do standalone but needs verification it doesn't break the client portal.
**Next step:** Route client auth through `api.js`; verify token handling; preserve separate token storage.

### App.js route manifest dedup

**Source:** Codex client [P2].
**What:** `HiringRoutes`, `StaffSiteRoutes`, and the admin branch in `AppRoutes` re-declare the same onboarding, portal, and token-based routes.
**Why deferred:** Routing refactor; risk of breaking site-context switching.
**Next step:** Extract shared route groups and compose.

### QuoteWizard ↔ ProposalCreate policy dedup

**Source:** Codex client [P2].
**What:** Package/add-on eligibility, draft persistence, pricing preview, event-type lookup, and submission rules are duplicated and have already drifted.
**Why deferred:** Large refactor.
**Next step:** Centralize policy + preview/draft adapters in shared modules.

## Low-value / nice-to-have

### Failed-login DB audit trail

**Source:** audit log A09.
**What:** Currently only logged to console; Render retention is short.
**Why deferred:** Low immediate risk; in-memory Map + Sentry covers basic alerts.
**Next step:** Optional — add `failed_logins` table if audit needs grow.

### Dead-letter readers for forensic blobs

**Source:** audit log items (email_webhook_events.processed, etc.).
**What:** Forensic/audit columns are write-only; no reader.
**Why deferred:** Intentional per design.
**Next step:** Revisit only if a debugging incident needs it.
```

- [ ] **Step 4: Schedule follow-up audit**

Use the `/schedule` skill to create a routine:

```
/schedule run /full-audit in 60 days
```

(Exact invocation depends on the schedule skill's CLI; have the user confirm the scheduled routine exists in their routines list afterward.)

- [ ] **Step 5: Commit**

```
git add docs/tech-debt.md
git commit -m "docs: tech-debt backlog from 2026-04-24 full-audit deferred items"
```

(Audit log is gitignored; annotations stay local.)

---

## Self-review checklist (execute during plan)

- [ ] **After Phase 1:** Confirm all 5 BLOCKER fail-closed fixes landed. Dev server restarts cleanly. Test pings hit endpoints.
- [ ] **After Phase 2:** `psql` shows `token_version` column. Schema applied idempotently on restart. Login + password reset flow works end-to-end.
- [ ] **After Phase 3:** Intentional autopay failure produces Sentry event + admin email. ROLLBACK failures logged.
- [ ] **After Phase 4:** Browser DevTools: `/api/proposals` response is smaller, `/api/drink-plans` response drops selections/shopping_list, PotionPlanningLab advances lazy-load chunks.
- [ ] **After Phase 5:** `docs/tech-debt.md` exists and is committed. Scheduled routine exists. Audit log annotated locally.

---

## Rollback plan

Each phase is ~3-5 commits; each commit is isolated. To roll back:
- Single commit: `git revert <sha>` (creates undo commit, push normally).
- Whole phase: revert each commit in reverse order.
- Schema change (Task 7 `token_version`): the column is nullable-with-default; a revert of the code plus keeping the column is safe. If you must remove the column, `ALTER TABLE users DROP COLUMN IF EXISTS token_version;`.
- `stripe_sessions` unique index (Task 14): `DROP INDEX IF EXISTS idx_stripe_sessions_payment_link;`.
- `express.json` limit drop to 1mb: if blog save breaks, either revert or add the per-route 10mb override suggested in Task 11 Step 3.
