# Pre-Live-Test Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every critical/high finding from the 6-agent pre-deploy review so Dr. Bartender is safe for third-party live testing.

**Architecture:** Three tiers executed in order — (1) Critical correctness/security blockers that can cause data loss, payment double-charge, or data leaks; (2) High-severity hardening (OTP, limits, schema hygiene); (3) Performance + docs polish. Each task is scoped to a single concern and leaves the app in a working state. Codebase has no automated test suite, so verification is manual (`npm run dev`, curl, browser) — verification steps are explicit per task.

**Tech Stack:** Node.js 18 / Express 4, React 18 (CRA), Postgres (pg driver, raw SQL), Stripe, Resend, Cloudflare R2.

**Branch:** Create `fix/pre-live-test-hardening` off current `fix/homepage-faq-login-batch` (or merge that first, then branch off `main`).

---

## Tier 1 — Critical blockers (must ship before any third-party tester logs in)

### Task 1: Fix broken transactions in onboarding routes

**Files:**
- Modify: `server/routes/payment.js:65-110`
- Modify: `server/routes/application.js:116-189`
- Modify: `server/routes/agreement.js:36-71`
- Modify: `server/routes/contractor.js:111-end-of-handler`

**Problem:** `pool.query('BEGIN')` followed by more `pool.query(...)` does NOT guarantee a single connection. Partial writes are possible — e.g., W-9 file saved but `onboarding_completed` never flipped.

**Pattern to apply to each handler that currently does `pool.query('BEGIN')`:**

```js
const client = await pool.connect();
try {
  await client.query('BEGIN');
  // Replace every `pool.query(...)` in this handler with `client.query(...)`
  await client.query('UPDATE ...', [...]);
  await client.query('INSERT ...', [...]);
  await client.query('COMMIT');
  res.json({ success: true });
} catch (err) {
  try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
  console.error('<route-name> error:', err);
  res.status(500).json({ error: 'Server error' });
} finally {
  client.release();
}
```

- [ ] **Step 1:** Open `server/routes/payment.js`, locate the handler at line 65. Refactor to the `pool.connect()` + dedicated client pattern above. Every `pool.query(...)` inside the try block becomes `client.query(...)`. Keep queries outside the transaction (reads before BEGIN, if any) on `pool`.
- [ ] **Step 2:** Repeat for `server/routes/application.js` handler around line 116. Confirm all four downstream `pool.query` calls (166, 168, 186, 189) are converted.
- [ ] **Step 3:** Repeat for `server/routes/agreement.js` handler around line 36. Convert lines 41, 51, 61, 66, 68, 71.
- [ ] **Step 4:** Repeat for `server/routes/contractor.js` handler around line 111 (convert through the COMMIT).
- [ ] **Step 5:** Manual verify: run `npm run dev`, complete a staff application end-to-end locally. Check DB: `SELECT onboarding_status, onboarding_completed FROM users WHERE email='testapplicant@...'` — should be consistent.
- [ ] **Step 6:** Force-fail test: temporarily throw inside one handler after the first `client.query` but before COMMIT. Hit the endpoint. Verify nothing was persisted (`SELECT` the target row). Revert the throw.
- [ ] **Step 7:** Commit — `fix(db): wrap onboarding transactions in dedicated pool client to prevent partial writes`

---

### Task 2: Stripe webhook — accept either mode secret during transition

**Files:**
- Modify: `server/routes/stripe.js:23-45` (module top, `isTestMode`, `getStripe`, `getWebhookSecret`)
- Modify: `server/routes/stripe.js:428-440` (webhook handler signature verification)

**Problem:** `getWebhookSecret()` returns only the current-mode secret. If a webhook retry crosses the `STRIPE_TEST_MODE_UNTIL` cutoff, verification fails and the event is lost. Also need to dispatch to the correct Stripe client for subsequent API calls.

- [ ] **Step 1:** At the top of `stripe.js` (around line 10, after requires), export two pre-initialized clients:

```js
const stripeLive = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const stripeTest = process.env.STRIPE_SECRET_KEY_TEST ? require('stripe')(process.env.STRIPE_SECRET_KEY_TEST) : null;
```

Remove the existing per-request `getStripe()` caching if it creates new instances; keep `isTestMode()` for mode-based routing of *non-webhook* calls.

- [ ] **Step 2:** Replace the webhook signature verification block (around `stripe.js:428-440`):

```js
const sig = req.headers['stripe-signature'];
const secrets = [
  { secret: process.env.STRIPE_WEBHOOK_SECRET, client: stripeLive },
  { secret: process.env.STRIPE_WEBHOOK_SECRET_TEST, client: stripeTest },
].filter(s => s.secret && s.client);

let event = null;
let stripeForEvent = null;
for (const { secret, client } of secrets) {
  try {
    event = client.webhooks.constructEvent(req.body, sig, secret);
    stripeForEvent = client;
    break;
  } catch (_) { /* try next */ }
}
if (!event) {
  console.error('Webhook signature verification failed');
  return res.status(400).send('Webhook signature verification failed');
}
```

- [ ] **Step 3:** Anywhere in the webhook handler that calls `stripe.xxx` on the module-level client, replace with `stripeForEvent.xxx`. Grep for `stripe\.` within the webhook handler body.
- [ ] **Step 4:** Manual verify with Stripe CLI: `stripe listen --forward-to localhost:5000/api/stripe/webhook`, trigger `stripe trigger payment_intent.succeeded` — confirm 200 OK and DB update. Then swap `STRIPE_TEST_MODE_UNTIL` to the past in `.env`, restart, re-trigger — still 200 OK.
- [ ] **Step 5:** Commit — `fix(stripe): verify webhooks against either live or test secret to survive mode transitions`

---

### Task 3: Webhook idempotency — prevent amount_paid double-increment

**Files:**
- Modify: `server/db/schema.sql` (add unique constraint)
- Modify: `server/routes/stripe.js:495-513` (drink-plan extras handler) and any other `UPDATE proposals SET amount_paid = amount_paid + ...` sites

**Problem:** Stripe retries `payment_intent.succeeded` on transient failures. Current code unconditionally increments `amount_paid`. No idempotency guard.

- [ ] **Step 1:** Add to `schema.sql` (idempotent):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_payments_intent_unique
  ON proposal_payments(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
```

- [ ] **Step 2:** In the webhook handler, change the `INSERT INTO proposal_payments` to `INSERT ... ON CONFLICT (stripe_payment_intent_id) DO NOTHING RETURNING id`. Only perform the `UPDATE proposals SET amount_paid = amount_paid + $1` when `inserted.rowCount === 1`.

Example:

```js
const inserted = await dbClient.query(
  `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, amount, status, payment_type, created_at)
   VALUES ($1, $2, $3, 'succeeded', $4, NOW())
   ON CONFLICT (stripe_payment_intent_id) DO NOTHING
   RETURNING id`,
  [proposalId, intent.id, paidCents, paymentType]
);
if (inserted.rowCount === 1) {
  await dbClient.query('UPDATE proposals SET amount_paid = amount_paid + $1 WHERE id = $2', [paidDollars, proposalId]);
}
```

- [ ] **Step 3:** Grep `stripe.js` for every other `amount_paid = amount_paid` occurrence. Apply the same guard at each site.
- [ ] **Step 4:** Manual verify: `stripe trigger payment_intent.succeeded` twice with the same intent id (use `stripe events resend`). Confirm `amount_paid` incremented exactly once.
- [ ] **Step 5:** Commit — `fix(stripe): make webhook idempotent via unique intent_id constraint and ON CONFLICT guard`

---

### Task 4: Lock down public proposal endpoint column list

**Files:**
- Modify: `server/routes/proposals.js:20-27` (GET `/t/:token`)
- Modify: `server/routes/clientPortal.js:30-37` (proposal detail for client portal)
- Modify: `client/src/pages/proposal/ProposalView.js` (only if it references a field that's being dropped)
- Modify: `client/src/pages/public/ClientDashboard.js` (same)

**Problem:** `SELECT p.*` exposes `admin_notes`, `stripe_customer_id`, `stripe_payment_method_id`, `client_signature_ip`, `client_signature_user_agent`, `client_signature_data` (base64 PNG), `created_by`, and `form_state` to anyone with the token.

- [ ] **Step 1:** Determine the public-safe column set. Open `client/src/pages/proposal/ProposalView.js` and grep for every `proposal.XXX` property access. That's your allowlist. Typically:

```
id, token, client_name, client_email, event_date, event_start_time, event_end_time,
event_location, guest_count, package_id, package_name, total_price, amount_paid,
deposit_amount, status, payment_status, payment_type, balance_due_date,
client_signature_name, client_signature_signed_at, client_signature_data /* only if shown */,
notes_for_client /* if exists — NOT admin notes */, created_at, updated_at,
pricing_snapshot /* only if the client UI reads from it */, view_count, last_viewed_at
```

- [ ] **Step 2:** Replace `SELECT p.*` in `proposals.js:20-27` with the explicit list. Excluded (critical): `admin_notes`, `stripe_customer_id`, `stripe_payment_method_id`, `client_signature_ip`, `client_signature_user_agent`, `form_state`, `created_by`.
- [ ] **Step 3:** Same replacement in `clientPortal.js:30-37`.
- [ ] **Step 4:** Manual verify: hit `GET /api/proposals/t/<token>` — response JSON must not contain any excluded keys. Open `/proposal/<token>` in browser — UI renders identically to before.
- [ ] **Step 5:** Commit — `fix(proposals): stop leaking admin and stripe fields from public token endpoint`

---

### Task 5: Fix ClientDashboard currency bug + raw fetch + unguarded shape

**Files:**
- Modify: `client/src/pages/public/ClientDashboard.js:32-35, 50-63, 113, 117`

**Problem:** `formatCurrency` divides by 100, but `total_price`/`amount_paid` are stored as dollars. Raw `fetch` bypasses `utils/api.js`. `data.proposals` assumed without guard.

- [ ] **Step 1:** Open `client/src/pages/public/ClientDashboard.js`. Replace `formatCurrency`:

```js
const formatCurrency = (amount) => {
  const num = Number(amount ?? 0);
  return num.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
};
```

- [ ] **Step 2:** Replace the raw `fetch` block (around lines 50-63) with the shared api client:

```js
import api from '../../utils/api';

// inside effect:
useEffect(() => {
  if (clientLoading) return;
  if (!isClientAuthenticated) { setLoading(false); return; }
  let cancelled = false;
  (async () => {
    try {
      const { data } = await api.get('/client-portal/proposals');
      if (cancelled) return;
      const list = Array.isArray(data) ? data : (data?.proposals ?? []);
      setProposals(list);
    } catch (err) {
      if (cancelled) return;
      setError('Could not load your proposals. Please try again.');
    } finally {
      if (!cancelled) setLoading(false);
    }
  })();
  return () => { cancelled = true; };
}, [clientLoading, isClientAuthenticated]);
```

- [ ] **Step 3:** Verify `server/routes/clientPortal.js` response shape. If it returns the array directly, the `Array.isArray(data) ? data : data.proposals` branch handles both. If it wraps, the `.proposals` branch handles it.
- [ ] **Step 4:** Manual verify: log in as a client with a proposal where `total_price = 1500.00`. Dashboard should display `$1,500.00`, not `$15.00`.
- [ ] **Step 5:** Commit — `fix(client-dashboard): format currency as dollars, use shared api client, guard response shape`

---

### Task 6: OTP request — don't 500 on Resend failure

**Files:**
- Modify: `server/routes/clientAuth.js:34-58` (the `/request` handler)

**Problem:** If Resend fails, the handler returns 500 after writing the OTP hash. This leaks an enumeration signal (known emails return 500, unknown return 200).

- [ ] **Step 1:** Wrap `sendEmail` in its own try/catch inside the request handler. On failure, log and clear `auth_token` / `auth_token_expires` for that client, then still return the neutral success response.

```js
try {
  await sendEmail({ to: client.email, subject: 'Your Dr. Bartender sign-in code', html: emailBody });
} catch (mailErr) {
  console.error('OTP email send failed:', mailErr);
  await pool.query(
    'UPDATE clients SET auth_token = NULL, auth_token_expires = NULL WHERE id = $1',
    [client.id]
  );
}
return res.json({ success: true, message: 'If that email exists, a sign-in code has been sent.' });
```

- [ ] **Step 2:** Manual verify: temporarily set `RESEND_API_KEY=invalid` in `.env`, restart, hit `/api/client-auth/request`. Should return 200 neutral message, server logs the send failure, and the `clients` row has `auth_token = NULL`.
- [ ] **Step 3:** Restore `RESEND_API_KEY`. Commit — `fix(client-auth): swallow OTP email send failures to avoid user enumeration and 500s`

---

## Tier 2 — High severity hardening

### Task 7: Per-account OTP attempt counter

**Files:**
- Modify: `server/db/schema.sql` (add column)
- Modify: `server/routes/clientAuth.js` (verify handler)

- [ ] **Step 1:** Add to `schema.sql`:

```sql
ALTER TABLE clients ADD COLUMN IF NOT EXISTS auth_token_attempts INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2:** In the `/verify` handler, after fetching the client but before bcrypt comparison:

```js
if (client.auth_token_attempts >= 5) {
  await pool.query(
    'UPDATE clients SET auth_token = NULL, auth_token_expires = NULL, auth_token_attempts = 0 WHERE id = $1',
    [client.id]
  );
  return res.status(429).json({ error: 'Too many attempts. Please request a new code.' });
}
```

On a **failed** bcrypt comparison, increment: `UPDATE clients SET auth_token_attempts = auth_token_attempts + 1 WHERE id = $1`.

On a **successful** comparison, reset to 0 along with the existing token clear: `UPDATE clients SET auth_token = NULL, auth_token_expires = NULL, auth_token_attempts = 0 WHERE id = $1`.

- [ ] **Step 3:** Manual verify: request an OTP, attempt 5 wrong codes. 6th attempt returns 429 and the stored token is invalidated.
- [ ] **Step 4:** Commit — `feat(client-auth): invalidate OTP after 5 failed verification attempts`

---

### Task 8: Add LIMIT/pagination to unbounded list queries

**Files:**
- Modify: `server/routes/admin.js:737` (admin blog list)
- Modify: `server/routes/blog.js:10-19` (public blog list)
- Modify: `server/routes/proposals.js:580-590` (financials proposals list)
- Modify: `server/routes/proposals.js:770-774` (activity log)
- Modify: `server/routes/emailMarketing.js:203, 810` (conversations)

Each query accepts `?page=1&limit=50` (default limit 50, max 100). Pattern:

```js
const page = Math.max(1, parseInt(req.query.page, 10) || 1);
const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
const offset = (page - 1) * limit;
// ... query with LIMIT $N OFFSET $M
```

- [ ] **Step 1:** Apply pattern to `admin.js` blog list. Also replace `SELECT * FROM blog_posts` with the specific column list (exclude `body`):
  `id, slug, title, excerpt, cover_image_url, published, published_at, created_at, updated_at`
- [ ] **Step 2:** Apply to public `blog.js` list (default limit 20 for public). Keep `ORDER BY published_at DESC`.
- [ ] **Step 3:** Apply to financials proposals list and activity log.
- [ ] **Step 4:** Apply to email conversations queries.
- [ ] **Step 5:** Manual verify each endpoint responds with `?limit=5` and returns 5 rows.
- [ ] **Step 6:** Commit — `perf(db): add pagination and drop SELECT * on list endpoints`

---

### Task 9: Stop overwriting admin package edits on every schema boot

**Files:**
- Modify: `server/db/schema.sql:496-537` (service_packages UPSERT)
- Modify: `server/db/schema.sql:611-627` (service_addons UPDATE)

**Problem:** `ON CONFLICT (slug) DO UPDATE SET description = EXCLUDED.description, ...` runs on every Render boot, wiping admin edits.

- [ ] **Step 1:** Change the `service_packages` UPSERT to `ON CONFLICT (slug) DO NOTHING`. Keep the INSERT so new packages still seed on a fresh DB.
- [ ] **Step 2:** Remove the unconditional `UPDATE service_addons SET description = CASE ...` block (lines 611-627) OR gate behind a `WHERE description IS NULL` so only unset rows get filled.
- [ ] **Step 3:** Manual verify: edit a package description in the admin dashboard. Restart the server. Confirm the edit persists.
- [ ] **Step 4:** Commit — `fix(schema): stop overwriting admin-edited package and addon descriptions on boot`

---

### Task 10: Strip debug logging from auth/email paths

**Files:**
- Modify: `server/routes/clientAuth.js:34, 49`
- Modify: `server/utils/email.js:10, 32, 47, 78`

- [ ] **Step 1:** Remove the recent debug `console.log` lines added in commits 46f820f and 7abe2d8, OR wrap each in `if (process.env.NODE_ENV !== 'production')`. Preferred: remove entirely now that the Resend issue is understood.
- [ ] **Step 2:** Also defensive-check `email.js:78` — `Batch sent: ${data?.data?.length ?? 0}`.
- [ ] **Step 3:** Commit — `chore(logging): remove OTP/email debug logs now that Resend is verified`

---

## Tier 3 — Performance + polish

### Task 11: Add gzip compression

**Files:**
- Modify: `package.json`
- Modify: `server/index.js` (middleware stack)

- [ ] **Step 1:** `npm install compression`
- [ ] **Step 2:** In `server/index.js`, after helmet and before routes:

```js
const compression = require('compression');
app.use(compression());
```

- [ ] **Step 3:** Manual verify: `curl -H 'Accept-Encoding: gzip' -I http://localhost:5000/api/blog` — response should include `Content-Encoding: gzip`.
- [ ] **Step 4:** Commit — `perf(server): enable gzip compression on all responses`

---

### Task 12: Parallelize public proposal token endpoint

**Files:**
- Modify: `server/routes/proposals.js:20-68` (GET `/t/:token`)

- [ ] **Step 1:** After the initial proposal fetch, batch the non-dependent queries:

```js
const [, addonsRes, drinkPlanRes] = await Promise.all([
  pool.query(
    'UPDATE proposals SET view_count = view_count + 1, last_viewed_at = NOW(), status = CASE WHEN status = $1 THEN $2 ELSE status END WHERE id = $3',
    ['sent', 'viewed', proposal.id]
  ),
  pool.query(
    'SELECT id, addon_id, name, quantity, rate, line_total FROM proposal_addons WHERE proposal_id = $1 ORDER BY id',
    [proposal.id]
  ),
  pool.query('SELECT token FROM drink_plans WHERE proposal_id = $1 LIMIT 1', [proposal.id]),
]);

// Fire-and-forget activity log so it doesn't block the response
pool.query(
  'INSERT INTO proposal_activity_log (proposal_id, event_type, metadata, created_at) VALUES ($1, $2, $3, NOW())',
  [proposal.id, 'viewed', JSON.stringify({ ip: req.ip })]
).catch(err => console.error('activity log insert failed:', err));
```

- [ ] **Step 2:** Manual verify: load a proposal token URL, watch server log — should see parallel query timestamps and no activity-log failures in normal operation.
- [ ] **Step 3:** Commit — `perf(proposals): parallelize public token endpoint queries`

---

### Task 13: Lazy-load admin bundle from public site

**Files:**
- Modify: `client/src/App.js:29-65` (imports) and the `<Routes>` block

- [ ] **Step 1:** Convert every admin/staff page import to `React.lazy`:

```js
import React, { Suspense, lazy } from 'react';

const AdminLayout = lazy(() => import('./components/AdminLayout'));
const AdminDashboard = lazy(() => import('./pages/admin/Dashboard'));
const ProposalsDashboard = lazy(() => import('./pages/admin/ProposalsDashboard'));
const ProposalCreate = lazy(() => import('./pages/admin/ProposalCreate'));
const ProposalDetail = lazy(() => import('./pages/admin/ProposalDetail'));
const ClientsDashboard = lazy(() => import('./pages/admin/ClientsDashboard'));
const ClientDetail = lazy(() => import('./pages/admin/ClientDetail'));
const EventsDashboard = lazy(() => import('./pages/admin/EventsDashboard'));
const FinancialsDashboard = lazy(() => import('./pages/admin/FinancialsDashboard'));
const HiringDashboard = lazy(() => import('./pages/admin/HiringDashboard'));
const SettingsDashboard = lazy(() => import('./pages/admin/SettingsDashboard'));
const BlogDashboard = lazy(() => import('./pages/admin/BlogDashboard'));
const CocktailMenuDashboard = lazy(() => import('./pages/admin/CocktailMenuDashboard'));
const DrinkPlansDashboard = lazy(() => import('./pages/admin/DrinkPlansDashboard'));
const DrinkPlanDetail = lazy(() => import('./pages/admin/DrinkPlanDetail'));
const EmailMarketingDashboard = lazy(() => import('./pages/admin/EmailMarketingDashboard'));
const EmailLeadsDashboard = lazy(() => import('./pages/admin/EmailLeadsDashboard'));
const EmailLeadDetail = lazy(() => import('./pages/admin/EmailLeadDetail'));
const EmailCampaignsDashboard = lazy(() => import('./pages/admin/EmailCampaignsDashboard'));
const EmailCampaignCreate = lazy(() => import('./pages/admin/EmailCampaignCreate'));
const EmailCampaignDetail = lazy(() => import('./pages/admin/EmailCampaignDetail'));
const EmailAnalyticsDashboard = lazy(() => import('./pages/admin/EmailAnalyticsDashboard'));
const EmailConversations = lazy(() => import('./pages/admin/EmailConversations'));
// Staff onboarding pages:
const Welcome = lazy(() => import('./pages/Welcome'));
const FieldGuide = lazy(() => import('./pages/FieldGuide'));
const Agreement = lazy(() => import('./pages/Agreement'));
const ContractorProfile = lazy(() => import('./pages/ContractorProfile'));
const PaydayProtocols = lazy(() => import('./pages/PaydayProtocols'));
const Completion = lazy(() => import('./pages/Completion'));
const StaffPortal = lazy(() => import('./pages/StaffPortal'));
const AdminUserDetail = lazy(() => import('./pages/AdminUserDetail'));
const AdminApplicationDetail = lazy(() => import('./pages/AdminApplicationDetail'));
const PotionPlanningLab = lazy(() => import('./pages/plan/PotionPlanningLab'));
const QuoteWizard = lazy(() => import('./pages/website/QuoteWizard'));
const ClassWizard = lazy(() => import('./pages/website/ClassWizard'));
```

Keep `HomePage`, `FaqPage`, `Blog`, `BlogPost`, `ClientLogin`, `ClientDashboard`, `ProposalView`, `Login`, and top-level `PublicLayout` as eager imports — they are the public entry points.

- [ ] **Step 2:** Wrap `<Routes>` in `<Suspense fallback={<div className="loading"><div className="spinner" /></div>}>`.
- [ ] **Step 3:** Manual verify: `npm run build` in `client/`, inspect `build/static/js/` — should now contain many smaller chunks instead of one monolithic `main.*.js`. Load homepage, open DevTools Network — the admin chunks should NOT be requested.
- [ ] **Step 4:** Commit — `perf(client): lazy-load admin and staff routes to shrink public bundle`

---

### Task 14: Gate Stripe.js loading on unpaid proposals only

**Files:**
- Modify: `client/src/pages/proposal/ProposalView.js:132-183` (Stripe publishable-key fetch and intent effects)

- [ ] **Step 1:** Wrap the `axios.get('/stripe/publishable-key')` call in a guard:

```js
useEffect(() => {
  if (!proposal) return;
  if (paid) return;
  if (!['sent', 'viewed', 'accepted'].includes(proposal.status)) return;
  axios.get(`${BASE_URL}/stripe/publishable-key`).then(/* existing */);
}, [proposal, paid]);
```

- [ ] **Step 2:** Consolidate the three cascading intent-creation `useEffect`s into a single effect keyed on `(proposal?.id, paymentOption, autopayChecked)`. Remove the `eslint-disable-next-line exhaustive-deps` comments.
- [ ] **Step 3:** Manual verify: open a proposal with `status='paid'` — Network tab should NOT show a request to `/publishable-key` nor a download of `js.stripe.com/v3`.
- [ ] **Step 4:** Commit — `perf(proposal-view): skip Stripe.js load and intent creation for already-paid proposals`

---

### Task 15: Doc desyncs

**Files:**
- Modify: `.claude/CLAUDE.md` (folder structure around line 171)
- Modify: `README.md` (folder structure around line 134, NPM Scripts table around line 187)

- [ ] **Step 1:** Add top-level `scripts/` entry to both folder trees:

```
├── scripts/
│   ├── build-testing-guide.js   # Build client/public/testing-guide.html from TESTING.md
│   └── testing-guide-template.html
```

- [ ] **Step 2:** Add NPM script row to README:

```
| npm run build:testing-guide | Build client/public/testing-guide.html from TESTING.md |
```

- [ ] **Step 3:** Decide on `TESTING.md` — if it's the source of truth, reference it from README under a new "Testing" section. If the `client/public/TESTING.md` is a stale duplicate, delete it and let the build script produce only the HTML output.
- [ ] **Step 4:** Commit — `docs: sync folder trees and npm scripts for testing guide build`

---

### Task 16: Optional — integer-cents migration note

**Files:**
- Modify: `server/db/schema.sql` (add comments only)

This is a documentation-only task for now; a full migration is out of scope before live testing. But explicitly note the convention:

- [ ] **Step 1:** Add a header comment above the pricing section of `schema.sql`:

```sql
-- NOTE: Money columns below are stored as NUMERIC(10,2) (dollars, not cents).
-- stripe_sessions.amount and proposal_payments.amount are INTEGER cents (Stripe native).
-- Any code that bridges these two worlds must multiply/divide by 100 explicitly.
-- See server/routes/stripe.js for the conversion sites. A future migration to
-- integer-cents everywhere is planned; do not write new pricing code that assumes otherwise.
```

- [ ] **Step 2:** Commit — `docs(schema): document dollar-vs-cent convention for pricing columns`

---

## Post-plan checklist (before PR / deploy)

- [ ] `npm run lint` passes
- [ ] `npm audit --omit=dev` — no critical/high
- [ ] Manual E2E smoke test: quote wizard → proposal → sign → pay deposit → webhook updates balance → client portal shows correct amount
- [ ] Staff onboarding E2E: apply → agreement → contractor profile → payday protocols → W-9 → completion — all transactions land atomically
- [ ] Stripe test-mode off + on toggle still works end-to-end
- [ ] One forged webhook attempt (wrong signature) returns 400
- [ ] Rerun `@security-review`, `@code-review`, `@database-review`, `@consistency-check`, `@performance-review` agents after all tasks land
- [ ] Install Playwright MCP and rerun `@ui-ux-review`

---

## Deferred (not blocking live test; track as follow-up)

- Split `ProposalView.js` (1041 lines) and `ConfirmationStep.js` (598 lines) into subcomponents
- Extract shared `<StripePaymentForm>` from the two duplicate payment forms
- Move JWT from localStorage to httpOnly cookie for staff/admin app
- Full integer-cents migration across pricing columns
- DB-backed login lockout (currently in-memory Map)
- Separate JWT secret for unsubscribe links
- CAPTCHA on `/public/capture-lead`
- `token_version` claim for server-side JWT revocation
- Hash both sides in Thumbtack basic-auth compare
- Convert `shifts.positions_needed` and `shifts.equipment_required` from `TEXT` to `JSONB`
- Snake_case the `/create-drink-plan-intent` response
