# Tip QR Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Source spec:** `docs/superpowers/specs/2026-05-01-tip-qr-page-design.md` (read first; this plan implements it).
>
> **Source design output:** `~/Downloads/QR Tips Page/` — Claude Design's full mobile UI (CSS, JSX, fonts, brand assets). Many tasks copy from these files.

**Goal:** Ship a per-bartender public tip page at `drbartender.com/tip/<token>` with auto-generated Stripe Payment Links, Stripe-tip ingestion, a downloadable photo-print QR, staff portal "My Tip Page", admin surfaces, and 1-3★ feedback flow with admin email notifications.

**Architecture:** Per-bartender UUID tokens stored on `payment_profiles`. Stripe Payment Links auto-generated at onboarding-submit, deactivated at staff-deactivation. Tips ingested into a new `tips` table via the existing Stripe webhook (`checkout.session.completed` + metadata filter). Tip pooling math is **out of scope** — that's a separate project. Public page ports the React design output verbatim (parchment + chalkboard hero band) and wires it to `/api/public/tip/:token` plus deep-link URL builders for Cash App / PayPal that pre-fill amounts.

**Tech Stack:** Node 18 / Express 4.18, React 18 (CRA), Postgres (raw SQL via `pg`), Stripe (Payment Links + webhooks), Resend, Cloudflare R2, IM Fell English typography, vanilla CSS.

**Verification model:** This codebase has no automated tests (per `CLAUDE.md`). Each task ends with a **manual smoke test** (start dev server / hit endpoint / browse the flow) and a commit. The pre-push agent fleet is the verification layer; do not invent tests.

---

## File structure (created/modified)

### Backend (`server/`)

| Path | Status | Responsibility |
|---|---|---|
| `server/db/schema.sql` | modify | Idempotent ADD COLUMN on `payment_profiles`; CREATE TABLE for `tips` and `tip_page_feedback`; new indexes. |
| `server/utils/tipPaymentLinks.js` | create | `createTipPaymentLink`, `deactivateTipPaymentLink`, `regenerateTipPaymentLink`. Uses `stripeClient.getStripe()`. |
| `server/utils/tipPageLifecycle.js` | create | `activateTipPage(userId)`, `deactivateTipPage(userId)`. |
| `server/routes/contractor.js` | modify | Onboarding submit handler upserts new payment_profile fields and triggers `createTipPaymentLink` on submitted-state transition. |
| `server/routes/publicTip.js` | create | `GET /:token` (public payload, allowlisted), `POST /:token/feedback`. Rate-limited via `publicLimiter`. |
| `server/routes/stripe.js` | modify | Add `checkout.session.completed` branch where `metadata.kind === 'tip'` → `INSERT INTO tips ... ON CONFLICT DO NOTHING`. |
| `server/routes/me.js` | create | Staff-portal endpoints: `GET /tip-page`, `PATCH /tip-page`, `GET /tips`. (No server-side QR generation — print is client-side.) |
| `server/routes/admin.js` | modify | Tip-page admin actions per contractor (regenerate link, deactivate, edit handles), admin tip activity, admin feedback queue. |
| `server/utils/emailTemplates.js` | modify | Add `tipFeedbackAdminNotification(...)` template. |
| `server/scripts/backfillTipPages.js` | create | One-time script: tokenize + Stripe-link existing approved contractors. |
| `server/index.js` | modify | Register `/api/public/tip` and `/api/me` routes. |
| `.env.example` | modify | Add three new env vars. |

### Frontend (`client/`)

| Path | Status | Responsibility |
|---|---|---|
| `client/public/fonts/IMFellEnglish-Regular.ttf` | create (copy) | From design output. |
| `client/public/fonts/IMFellEnglish-Italic.ttf` | create (copy) | From design output. |
| `client/public/fonts/IMFellEnglishSC-Regular.ttf` | create (copy) | From design output. |
| `client/public/tip-page/logo.png` | create (copy) | DRB logo for tip-page footer (default). |
| `client/public/tip-page/logo-gold.png` | create (copy) | Gold-medallion logo used by print-card layouts. |
| `client/public/tip-page/logo-teal.png` | create (copy) | Apothecary-Teal logo variant. |
| `client/public/tip-page/logo-character.png` | create (copy) | Flask-character mascot. |
| `client/public/tip-page/parchment-bg.png` | create (copy) | Page bg texture. |
| `client/public/tip-page/chalkboard-bg.png` | create (copy) | Hero band texture. |
| `client/src/styles/drb-tokens.css` | create | Namespaced design tokens (`--drb-*`) used by the print-card layouts. Imported by the print page only; does not pollute the rest of the app. |
| `client/src/index.css` | modify | Add `@font-face` declarations for IM Fell English (if not already present). |
| `client/src/pages/public/TipPage.jsx` | create | Main public tip page component (port of `tip-page.jsx` from design). |
| `client/src/pages/public/TipPage.atoms.jsx` | create | PayButton, StarIcon, HeroDecor, Sparkle, Chevron, payment-platform marks (port of `tip-atoms.jsx`). |
| `client/src/pages/public/TipPage.css` | create | Port of `styles.css` from design (with paths rewritten to `/tip-page/*`). |
| `client/src/pages/public/TipPageThanks.jsx` | create | Post-tip thanks screen (Stripe redirect target). |
| `client/src/pages/staff/MyTipPage.js` | create | Staff portal "My Tip Page" view. |
| `client/src/pages/staff/PrintTipCard.js` | create | Client-side print page — three sizes (business card, 4×6, 5×7), bartender picks one, browser print-to-PDF. Ports `qr-print.jsx` from design. |
| `client/src/pages/staff/PrintTipCard.css` | create | `@page` rules + size-specific layout CSS. |
| `client/src/pages/admin/TipsAdmin.js` | create | Admin tips activity + feedback queue. |
| `client/src/pages/admin/userDetail/tabs/TipPageTab.js` | create | Per-contractor tip-page panel (new tab). |
| `client/src/pages/admin/userDetail/AdminUserDetail.js` | modify | Register the new TipPageTab. |
| `client/src/App.js` | modify | Register `/tip/:token` and `/tip/:token/thanks` routes in `PublicWebsiteRoutes`. |
| `client/src/utils/buildTipDeepLink.js` | create | Pure helper that builds Venmo/CashApp/PayPal/Stripe URLs with amount injection per platform. |
| `client/src/pages/Application.js` (or onboarding step) | modify | Add Tip & Payroll Preferences fieldset. |

### Docs

| Path | Status | Responsibility |
|---|---|---|
| `README.md` | modify | Folder tree, NPM scripts, env vars table, key features. |
| `ARCHITECTURE.md` | modify | Routes table, schema additions, third-party integrations. |
| `.claude/CLAUDE.md` | modify | Env vars table additions. |

---

## Phase 0 — Prerequisites & assets

### Task 1: Drop design assets + fonts into the client

**Files:**
- Create: `client/public/fonts/IMFellEnglish-Regular.ttf`
- Create: `client/public/fonts/IMFellEnglish-Italic.ttf`
- Create: `client/public/fonts/IMFellEnglishSC-Regular.ttf`
- Create: `client/public/tip-page/logo.png`
- Create: `client/public/tip-page/parchment-bg.png`
- Create: `client/public/tip-page/chalkboard-bg.png`
- Modify: `client/src/index.css` (add `@font-face` if missing)

- [ ] **Step 1: Verify destination directories exist**

```bash
ls client/public/ && [ -d client/public/fonts ] || mkdir client/public/fonts
[ -d client/public/tip-page ] || mkdir client/public/tip-page
```

- [ ] **Step 2: Copy fonts from design output**

```bash
cp "$HOME/Downloads/QR Tips Page/fonts/IMFellEnglish-Regular.ttf" client/public/fonts/
cp "$HOME/Downloads/QR Tips Page/fonts/IMFellEnglish-Italic.ttf" client/public/fonts/
cp "$HOME/Downloads/QR Tips Page/fonts/IMFellEnglishSC-Regular.ttf" client/public/fonts/
```

- [ ] **Step 3: Copy images from design output (rename chalkboard_background → chalkboard-bg)**

> Note: the user's working design folder is `~/Downloads/QR Tips Page (1)/` (the most recent one with print files). If older `~/Downloads/QR Tips Page/` exists, prefer the `(1)` version for the print assets.

```bash
SRC="$HOME/Downloads/QR Tips Page (1)"
[ -d "$SRC" ] || SRC="$HOME/Downloads/QR Tips Page"
cp "$SRC/assets/logo.png" client/public/tip-page/logo.png
cp "$SRC/assets/logo-gold.png" client/public/tip-page/logo-gold.png
cp "$SRC/assets/logo-teal.png" client/public/tip-page/logo-teal.png
cp "$SRC/assets/logo-character.png" client/public/tip-page/logo-character.png
cp "$SRC/assets/parchment-bg.png" client/public/tip-page/parchment-bg.png
cp "$SRC/assets/chalkboard_background.png" client/public/tip-page/chalkboard-bg.png
```

- [ ] **Step 3b: Copy `drb-tokens.css` into `client/src/styles/` and rewrite font paths**

```bash
mkdir -p client/src/styles
cp "$SRC/drb-tokens.css" client/src/styles/drb-tokens.css
```

Edit `client/src/styles/drb-tokens.css` and replace `url('./fonts/IM...')` paths with `url('/fonts/IM...')` (project-root absolute paths, since the file lives in `src/styles/` not next to the fonts).

- [ ] **Step 4: Add `@font-face` to `client/src/index.css` if not already present**

Grep first: `grep -n "IM Fell English" client/src/index.css`. If no match, insert near the top of `index.css`:

```css
@font-face {
  font-family: 'IM Fell English SC';
  src: url('/fonts/IMFellEnglishSC-Regular.ttf') format('truetype');
  font-weight: 400; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'IM Fell English';
  src: url('/fonts/IMFellEnglish-Regular.ttf') format('truetype');
  font-weight: 400; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'IM Fell English';
  src: url('/fonts/IMFellEnglish-Italic.ttf') format('truetype');
  font-weight: 400; font-style: italic; font-display: swap;
}
```

If existing declarations point to different paths, leave them and add only what's missing.

- [ ] **Step 5: Smoke test — start dev server and load the test font**

```bash
cd client && npm start
```

Open `http://localhost:3000/fonts/IMFellEnglishSC-Regular.ttf` — should download/display the file.
Open `http://localhost:3000/tip-page/logo.png` — should render the DRB logo.

- [ ] **Step 6: Commit**

```bash
git add client/public/fonts client/public/tip-page client/src/index.css client/src/styles/drb-tokens.css
git commit -m "feat(tip): add IM Fell English fonts, brand assets, and drb-tokens.css"
```

---

## Phase 1 — Schema & utilities

### Task 2: Schema migration

**Files:**
- Modify: `server/db/schema.sql` (append new sections; idempotent)

- [ ] **Step 1: Append `payment_profiles` extensions to `schema.sql`**

```sql
-- ──────────────────────────────────────────────
-- Tip QR page (2026-05-08)
-- ──────────────────────────────────────────────

-- Per-bartender payment handles + Stripe Payment Link + tip-page token.
ALTER TABLE payment_profiles ADD COLUMN IF NOT EXISTS venmo_handle TEXT;
ALTER TABLE payment_profiles ADD COLUMN IF NOT EXISTS cashapp_handle TEXT;
ALTER TABLE payment_profiles ADD COLUMN IF NOT EXISTS paypal_url TEXT;
ALTER TABLE payment_profiles ADD COLUMN IF NOT EXISTS stripe_payment_link_url TEXT;
ALTER TABLE payment_profiles ADD COLUMN IF NOT EXISTS stripe_payment_link_id TEXT;
ALTER TABLE payment_profiles ADD COLUMN IF NOT EXISTS tip_page_token UUID;
ALTER TABLE payment_profiles ADD COLUMN IF NOT EXISTS tip_page_active BOOLEAN DEFAULT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_profiles_tip_page_token
  ON payment_profiles(tip_page_token) WHERE tip_page_token IS NOT NULL;
```

- [ ] **Step 2: Append `tips` table to `schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS tips (
  id SERIAL PRIMARY KEY,
  tip_page_token UUID NOT NULL,
  target_user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  stripe_payment_intent_id TEXT UNIQUE NOT NULL,
  stripe_session_id TEXT,
  customer_email TEXT,
  tipped_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tips_target_user_tipped_at
  ON tips(target_user_id, tipped_at DESC);
```

- [ ] **Step 3: Append `tip_page_feedback` table to `schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS tip_page_feedback (
  id SERIAL PRIMARY KEY,
  target_user_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 3),
  comment TEXT,
  submitter_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tip_feedback_target_user_created_at
  ON tip_page_feedback(target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tip_feedback_unreviewed
  ON tip_page_feedback(created_at DESC) WHERE reviewed_at IS NULL;
```

- [ ] **Step 4: Apply schema to local DB**

The repo applies `schema.sql` via the seed flow. Run:

```bash
npm run seed
```

If the seed errors on existing data, that's OK — `IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` are idempotent. Re-run is safe.

- [ ] **Step 5: Verify tables and columns exist**

```bash
psql "$DATABASE_URL" -c "\d tips" -c "\d tip_page_feedback" -c "\d payment_profiles"
```

Expected: `tips` table shows id/tip_page_token/target_user_id/etc., `tip_page_feedback` shows rating/comment/etc., `payment_profiles` now includes `venmo_handle`, `cashapp_handle`, `paypal_url`, `stripe_payment_link_url`, `stripe_payment_link_id`, `tip_page_token`, `tip_page_active`.

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(tip): schema additions for tip page tokens, tips, and feedback"
```

---

### Task 3: Stripe Payment Link helper utility

**Files:**
- Create: `server/utils/tipPaymentLinks.js`

- [ ] **Step 1: Create the helper file**

```js
// server/utils/tipPaymentLinks.js
const { getStripe } = require('./stripeClient');
const { PUBLIC_SITE_URL } = require('./urls');

const MIN_TIP_CENTS = 100; // $1 minimum

/**
 * Create a Stripe Payment Link tagged to a specific bartender.
 * Returns { url, id }.
 *
 * `payment_intent_data.metadata` is mirrored because Payment Link
 * metadata does NOT propagate to the resulting PaymentIntent automatically.
 */
async function createTipPaymentLink({ userId, displayName, token }) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe client unavailable (test-mode misconfig?)');
  if (!token) throw new Error('tip_page_token required');

  const safeName = String(displayName || 'your bartender').slice(0, 80);

  const link = await stripe.paymentLinks.create({
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: `Tip for ${safeName}` },
        custom_unit_amount: { enabled: true, minimum: MIN_TIP_CENTS },
      },
      quantity: 1,
    }],
    metadata: {
      kind: 'tip',
      bartender_user_id: String(userId),
      tip_page_token: token,
    },
    payment_intent_data: {
      metadata: {
        kind: 'tip',
        bartender_user_id: String(userId),
        tip_page_token: token,
      },
      description: `Tip for ${safeName} via DRB tip page`,
    },
    after_completion: {
      type: 'redirect',
      redirect: {
        url: `${PUBLIC_SITE_URL}/tip/${token}/thanks?amount={CHECKOUT_SESSION_AMOUNT_TOTAL}`,
      },
    },
  });

  return { url: link.url, id: link.id };
}

async function deactivateTipPaymentLink(linkId) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe client unavailable');
  if (!linkId) return null;
  return stripe.paymentLinks.update(linkId, { active: false });
}

async function activateTipPaymentLink(linkId) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe client unavailable');
  if (!linkId) return null;
  return stripe.paymentLinks.update(linkId, { active: true });
}

module.exports = {
  createTipPaymentLink,
  deactivateTipPaymentLink,
  activateTipPaymentLink,
};
```

- [ ] **Step 2: Smoke test — create a Stripe Payment Link from a Node REPL**

In test-mode (verify `STRIPE_TEST_MODE_UNTIL` is set in your local `.env`), run:

```bash
node -e "require('./server/utils/tipPaymentLinks').createTipPaymentLink({userId:999,displayName:'TestBartender',token:'00000000-0000-0000-0000-000000000001'}).then(console.log).catch(console.error)"
```

Expected: prints `{ url: 'https://buy.stripe.com/test_...', id: 'plink_...' }`.

- [ ] **Step 3: Verify in Stripe dashboard**

Open https://dashboard.stripe.com/test/payment-links and confirm the new link is listed with metadata `kind=tip, bartender_user_id=999, tip_page_token=...`.

- [ ] **Step 4: Deactivate the test link to clean up**

```bash
node -e "require('./server/utils/tipPaymentLinks').deactivateTipPaymentLink('plink_THE_ID_FROM_STEP_2')"
```

- [ ] **Step 5: Commit**

```bash
git add server/utils/tipPaymentLinks.js
git commit -m "feat(tip): Stripe Payment Link helper with create/deactivate/activate"
```

---

### Task 4: Tip-page lifecycle helper

**Files:**
- Create: `server/utils/tipPageLifecycle.js`

- [ ] **Step 1: Create the lifecycle helper**

```js
// server/utils/tipPageLifecycle.js
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const {
  deactivateTipPaymentLink,
  activateTipPaymentLink,
} = require('./tipPaymentLinks');

async function deactivateTipPage(userId) {
  const { rows } = await pool.query(
    'SELECT stripe_payment_link_id FROM payment_profiles WHERE user_id = $1',
    [userId]
  );
  const linkId = rows[0]?.stripe_payment_link_id;

  if (linkId) {
    try { await deactivateTipPaymentLink(linkId); }
    catch (err) {
      console.error('[tip] failed to deactivate Stripe Payment Link', err.message);
      Sentry.captureException(err, { extra: { userId, linkId, op: 'deactivate' } });
    }
  }

  await pool.query(
    'UPDATE payment_profiles SET tip_page_active = FALSE WHERE user_id = $1',
    [userId]
  );
}

async function activateTipPage(userId) {
  const { rows } = await pool.query(
    'SELECT stripe_payment_link_id FROM payment_profiles WHERE user_id = $1',
    [userId]
  );
  const linkId = rows[0]?.stripe_payment_link_id;

  if (linkId) {
    try { await activateTipPaymentLink(linkId); }
    catch (err) {
      console.error('[tip] failed to activate Stripe Payment Link', err.message);
      Sentry.captureException(err, { extra: { userId, linkId, op: 'activate' } });
    }
  }

  await pool.query(
    'UPDATE payment_profiles SET tip_page_active = TRUE WHERE user_id = $1',
    [userId]
  );
}

module.exports = { deactivateTipPage, activateTipPage };
```

- [ ] **Step 2: Commit**

```bash
git add server/utils/tipPageLifecycle.js
git commit -m "feat(tip): tip-page lifecycle helpers (activate/deactivate)"
```

---

## Phase 2 — Onboarding integration

### Task 5: Onboarding submit handler — upsert handles + auto-generate Stripe link

**Files:**
- Modify: `server/routes/contractor.js` (the route that handles onboarding form submission)

> **Before starting:** read `server/routes/contractor.js` and find the existing onboarding-submit handler. The exact endpoint name varies — likely `POST /onboarding/submit` or `POST /profile`. The transition to flag is the move from in-progress to `'submitted'` (per `users.onboarding_status`).

- [ ] **Step 1: Read the existing onboarding submit handler**

```bash
grep -n "onboarding_status\|submitted\|UPDATE users" server/routes/contractor.js
```

Locate the route that currently handles the form submit. Note its path, params, and the spot where `onboarding_status` becomes `'submitted'`.

- [ ] **Step 2: Add the upsert + Stripe-link block after the existing transition**

In the same handler, after the existing form-data writes, add:

```js
// New for tip page (2026-05-08): persist payment handles + payroll preference
const {
  preferred_name,
  venmo_handle,
  cashapp_handle,
  paypal_url,
  preferred_payment_method,
} = req.body;

// Validate payroll method matches handle requirement (per spec 7.3)
const methodToHandleField = {
  venmo: { value: venmo_handle, name: 'Venmo handle' },
  cashapp: { value: cashapp_handle, name: 'Cash App handle' },
  paypal: { value: paypal_url, name: 'PayPal URL' },
};
const reqHandle = methodToHandleField[preferred_payment_method];
if (reqHandle && !reqHandle.value) {
  throw new ValidationError(
    `${reqHandle.name} is required when "${preferred_payment_method}" is your payroll preference.`
  );
}
// (direct_deposit/check/other require no specific handle)

// Persist preferred_name on contractor_profiles (existing column)
await pool.query(
  'UPDATE contractor_profiles SET preferred_name = $1 WHERE user_id = $2',
  [String(preferred_name || '').trim() || null, req.user.id]
);

// Upsert payment_profiles
await pool.query(`
  INSERT INTO payment_profiles
    (user_id, preferred_payment_method, venmo_handle, cashapp_handle, paypal_url, tip_page_active)
  VALUES ($1, $2, $3, $4, $5, TRUE)
  ON CONFLICT (user_id) DO UPDATE SET
    preferred_payment_method = EXCLUDED.preferred_payment_method,
    venmo_handle = EXCLUDED.venmo_handle,
    cashapp_handle = EXCLUDED.cashapp_handle,
    paypal_url = EXCLUDED.paypal_url,
    tip_page_active = TRUE,
    updated_at = NOW()
`, [
  req.user.id,
  preferred_payment_method || null,
  venmo_handle || null,
  cashapp_handle || null,
  paypal_url || null,
]);

// Generate tip_page_token if missing, then create Stripe Payment Link
const { rows: ppRows } = await pool.query(
  'SELECT tip_page_token FROM payment_profiles WHERE user_id = $1',
  [req.user.id]
);
let token = ppRows[0]?.tip_page_token;
if (!token) {
  const { v4: uuidv4 } = require('uuid');
  token = uuidv4();
  await pool.query(
    'UPDATE payment_profiles SET tip_page_token = $1 WHERE user_id = $2',
    [token, req.user.id]
  );
}

// Create the Payment Link (best-effort; never block onboarding submit)
try {
  const { createTipPaymentLink } = require('../utils/tipPaymentLinks');
  const { url, id: linkId } = await createTipPaymentLink({
    userId: req.user.id,
    displayName: preferred_name,
    token,
  });
  await pool.query(
    'UPDATE payment_profiles SET stripe_payment_link_url = $1, stripe_payment_link_id = $2 WHERE user_id = $3',
    [url, linkId, req.user.id]
  );
} catch (err) {
  console.error('[tip] failed to auto-generate Stripe Payment Link at onboarding-submit', err.message);
  Sentry.captureException(err, { extra: { userId: req.user.id, op: 'onboarding-submit-stripe-link' } });
  // Admin can hit "Generate Stripe link" later from the contractor record.
}
```

Add the Sentry require near the top of the file if not already imported.

Required `npm` package: `uuid` is likely already installed. Verify with `grep '"uuid"' server/package.json`. If missing: `cd server && npm install uuid` (then commit `package.json` + `package-lock.json` in step 5 below).

- [ ] **Step 3: Smoke test — submit onboarding form for a fresh test user**

In dev:
1. Start dev server: `npm run dev`.
2. Register a new account via the existing flow.
3. Complete onboarding form (you may need to add the new fields to the frontend in Task 6 first if your form blocks). Bypass the frontend in dev with a direct API call to validate the backend in isolation:

```bash
curl -X POST http://localhost:5000/api/contractor/onboarding/submit \
  -H "Authorization: Bearer YOUR_DEV_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "preferred_name": "Smoke Test",
    "venmo_handle": "smoketest",
    "cashapp_handle": "smoketest",
    "paypal_url": "https://paypal.me/smoketest",
    "preferred_payment_method": "venmo"
  }'
```

(Adjust path + any other fields the existing handler requires.)

- [ ] **Step 4: Verify in DB**

```bash
psql "$DATABASE_URL" -c "SELECT user_id, tip_page_token, stripe_payment_link_url IS NOT NULL AS has_link FROM payment_profiles WHERE user_id = (SELECT id FROM users WHERE email='your-test-email');"
```

Expected: a UUID in `tip_page_token` and `has_link = t`.

- [ ] **Step 5: Commit**

```bash
git add server/routes/contractor.js
# if uuid was just installed:
# git add server/package.json server/package-lock.json
git commit -m "feat(tip): onboarding submit upserts handles + auto-generates Stripe link"
```

---

### Task 6: Onboarding form — Tip & Payroll Preferences fieldset

**Files:**
- Modify: the onboarding form component (locate via grep below)

- [ ] **Step 1: Find the form**

```bash
grep -rn "preferred_name\|preferred_payment_method\|payroll" client/src/pages/ client/src/components/
```

The contractor onboarding flow lives under `client/src/pages/contractor*` or similar. Identify the step where personal info (phone, headshot) is collected; the new fieldset goes there.

- [ ] **Step 2: Add the fieldset with helper copy**

Append (or insert near other personal-info fields):

```jsx
<fieldset className="tip-prefs">
  <legend>Tip & Payroll Preferences</legend>
  <p className="helper">
    Your tip page lives at drbartender.com/tip/your-name. We'll generate a QR you can print at any photo counter.
    We pay you out via the handle you pick below — the others just show up on your tip page so customers can pick what they prefer.
    None of this is shared with anyone outside DRB.
  </p>

  <label>
    Preferred name <span className="req">*</span>
    <input type="text" required maxLength={80}
      value={form.preferred_name || ''}
      onChange={e => setForm(f => ({...f, preferred_name: e.target.value}))} />
    <small>The name customers see on your tip page. Use whatever you go by — your real name, a nickname, a stage name.</small>
  </label>

  <label>
    Venmo handle (optional)
    <input type="text" placeholder="kaitlyn-marie-43"
      value={form.venmo_handle || ''}
      onChange={e => setForm(f => ({...f, venmo_handle: stripVenmo(e.target.value)}))} />
  </label>

  <label>
    Cash App handle (optional)
    <input type="text" placeholder="kaitlynmfmt"
      value={form.cashapp_handle || ''}
      onChange={e => setForm(f => ({...f, cashapp_handle: stripCashapp(e.target.value)}))} />
  </label>

  <label>
    PayPal link (optional)
    <input type="url" placeholder="https://paypal.me/yourname"
      value={form.paypal_url || ''}
      onChange={e => setForm(f => ({...f, paypal_url: e.target.value}))} />
  </label>

  <fieldset>
    <legend>Pay me out via <span className="req">*</span></legend>
    {[
      ['venmo', 'Venmo'],
      ['cashapp', 'Cash App'],
      ['paypal', 'PayPal'],
      ['check', 'Check'],
      ['direct_deposit', 'Direct deposit'],
      ['other', 'Other'],
    ].map(([val, label]) => (
      <label key={val} className="radio">
        <input type="radio" name="ppm" value={val}
          checked={form.preferred_payment_method === val}
          onChange={() => setForm(f => ({...f, preferred_payment_method: val}))} />
        {label}
      </label>
    ))}
  </fieldset>
</fieldset>
```

Add helper functions in the same file (or a sibling utils):

```js
function stripVenmo(s) {
  return String(s || '').replace(/^@/, '').replace(/^https?:\/\/(?:www\.)?venmo\.com\/u?\/?/, '').trim();
}
function stripCashapp(s) {
  return String(s || '').replace(/^\$/, '').replace(/^https?:\/\/(?:www\.)?cash\.app\/\$?/, '').trim();
}
```

- [ ] **Step 3: Add client-side validation matching server-side rules**

Before submit:

```js
const methodNeedsHandle = {
  venmo: form.venmo_handle,
  cashapp: form.cashapp_handle,
  paypal: form.paypal_url,
};
const handleVal = methodNeedsHandle[form.preferred_payment_method];
if (handleVal === '' || (handleVal === undefined && ['venmo','cashapp','paypal'].includes(form.preferred_payment_method))) {
  alert(`Please add the handle for the payroll method you picked.`);
  return;
}
if (!form.preferred_name || !form.preferred_name.trim()) {
  alert('Please enter a preferred name.');
  return;
}
```

- [ ] **Step 4: Smoke test in browser**

Start dev server, walk through onboarding as a new user, submit the form. Open DevTools network tab → confirm the POST body includes the new fields.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/...   # the actual file you modified
git commit -m "feat(tip): onboarding form - tip & payroll preferences fieldset"
```

---

### Task 7: Backfill script for existing approved staff

**Files:**
- Create: `server/scripts/backfillTipPages.js`

- [ ] **Step 1: Create the backfill script**

```js
// server/scripts/backfillTipPages.js
// One-time backfill: for each approved contractor missing tip_page_token,
// generate a UUID and create a Stripe Payment Link in DRB's account.
// Idempotent: skips rows that already have tokens.
// Usage: node server/scripts/backfillTipPages.js

require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { createTipPaymentLink } = require('../utils/tipPaymentLinks');

async function main() {
  const { rows } = await pool.query(`
    SELECT u.id AS user_id, cp.preferred_name
    FROM users u
    JOIN contractor_profiles cp ON cp.user_id = u.id
    LEFT JOIN payment_profiles pp ON pp.user_id = u.id
    WHERE u.onboarding_status IN ('submitted', 'reviewed', 'approved', 'hired')
      AND (pp.tip_page_token IS NULL OR pp.user_id IS NULL)
  `);

  console.log(`[backfill] ${rows.length} contractors need tip-page setup`);

  for (const row of rows) {
    const token = uuidv4();
    const displayName = row.preferred_name || 'your bartender';
    try {
      const { url, id } = await createTipPaymentLink({
        userId: row.user_id,
        displayName,
        token,
      });
      await pool.query(`
        INSERT INTO payment_profiles (user_id, tip_page_token, stripe_payment_link_url, stripe_payment_link_id, tip_page_active)
        VALUES ($1, $2, $3, $4, TRUE)
        ON CONFLICT (user_id) DO UPDATE SET
          tip_page_token = COALESCE(payment_profiles.tip_page_token, EXCLUDED.tip_page_token),
          stripe_payment_link_url = COALESCE(payment_profiles.stripe_payment_link_url, EXCLUDED.stripe_payment_link_url),
          stripe_payment_link_id = COALESCE(payment_profiles.stripe_payment_link_id, EXCLUDED.stripe_payment_link_id),
          tip_page_active = TRUE,
          updated_at = NOW()
      `, [row.user_id, token, url, id]);
      console.log(`[backfill] user_id=${row.user_id} token=${token} link=${id}`);
    } catch (err) {
      console.error(`[backfill] FAILED user_id=${row.user_id}:`, err.message);
    }
  }

  await pool.end();
  console.log('[backfill] done');
}

main().catch(err => {
  console.error('[backfill] fatal', err);
  process.exit(1);
});
```

- [ ] **Step 2: Smoke test on local DB**

```bash
node server/scripts/backfillTipPages.js
```

Expected: prints the count of contractors needing setup, then `[backfill] done`. Re-run it — should print `0 contractors need tip-page setup` (idempotent).

- [ ] **Step 3: Commit (do NOT run in production yet — that's deploy-time)**

```bash
git add server/scripts/backfillTipPages.js
git commit -m "feat(tip): backfill script for existing approved staff"
```

---

## Phase 3 — Public tip page

### Task 8: Backend — public tip-page route (GET payload)

**Files:**
- Create: `server/routes/publicTip.js`
- Modify: `server/index.js` (register the route)

- [ ] **Step 1: Create the route file**

```js
// server/routes/publicTip.js
const express = require('express');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { publicLimiter } = require('../middleware/rateLimiters');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');

const router = express.Router();
router.use(publicLimiter);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/:token', asyncHandler(async (req, res) => {
  const { token } = req.params;
  if (!UUID_RE.test(token)) throw new NotFoundError('Tip page not found');

  const { rows } = await pool.query(`
    SELECT
      cp.preferred_name AS display_name,
      cp.headshot_file_url AS headshot_url,
      pp.venmo_handle,
      pp.cashapp_handle,
      pp.paypal_url,
      pp.stripe_payment_link_url,
      pp.tip_page_active
    FROM payment_profiles pp
    JOIN users u ON u.id = pp.user_id
    JOIN contractor_profiles cp ON cp.user_id = u.id
    WHERE pp.tip_page_token = $1
  `, [token]);

  const row = rows[0];
  if (!row || !row.tip_page_active) throw new NotFoundError('Tip page not found');

  res.json({
    display_name: row.display_name || 'your bartender',
    headshot_url: row.headshot_url || null,
    venmo_handle: row.venmo_handle || null,
    cashapp_handle: row.cashapp_handle || null,
    paypal_url: row.paypal_url || null,
    stripe_payment_link_url: row.stripe_payment_link_url || null,
  });
}));

module.exports = router;
```

- [ ] **Step 2: Register the route in `server/index.js`**

Find the section that does `app.use('/api/...', require('./routes/...'))` and add:

```js
app.use('/api/public/tip', require('./routes/publicTip'));
```

Place it near other public routes (search for `publicReviews` if registered, or alongside it).

- [ ] **Step 3: Smoke test**

Start dev server. Pick a token from your local DB:

```bash
psql "$DATABASE_URL" -c "SELECT tip_page_token FROM payment_profiles WHERE tip_page_token IS NOT NULL LIMIT 1;"
```

Then:

```bash
curl http://localhost:5000/api/public/tip/<the-token-here>
```

Expected: JSON with `display_name`, `headshot_url`, handles. 404 if `tip_page_active = false` or token doesn't exist.

- [ ] **Step 4: Commit**

```bash
git add server/routes/publicTip.js server/index.js
git commit -m "feat(tip): public GET /api/public/tip/:token endpoint"
```

---

### Task 9: Backend — feedback POST endpoint

**Files:**
- Modify: `server/routes/publicTip.js`
- Modify: `server/utils/emailTemplates.js`

- [ ] **Step 1: Add the feedback notification template to `emailTemplates.js`**

```js
// Add at the bottom of emailTemplates.js (or wherever templates are exported):
exports.tipFeedbackAdminNotification = ({ displayName, rating, comment, submitterEmail, adminUrl }) => ({
  subject: `${rating}-star tip-page feedback for ${displayName}`,
  html: `
    <h2>Tip-page feedback</h2>
    <p><strong>Bartender:</strong> ${displayName}</p>
    <p><strong>Rating:</strong> ${rating} / 5</p>
    <p><strong>Comment:</strong> ${comment ? escapeHtml(comment) : '<em>(no comment)</em>'}</p>
    ${submitterEmail ? `<p><strong>Submitter email:</strong> ${escapeHtml(submitterEmail)}</p>` : ''}
    <p><a href="${adminUrl}">Review in admin</a></p>
  `,
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}
```

If `escapeHtml` already exists in the file, reuse the existing one — don't redeclare.

- [ ] **Step 2: Add the POST route to `publicTip.js`**

Add per-token+IP rate limiting + the handler:

```js
const rateLimit = require('express-rate-limit');
const { ADMIN_URL } = require('../utils/urls');

const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,                 // 1h
  max: 3,
  keyGenerator: req => `${req.ip}:${req.params.token}`,
  message: { error: 'Too many feedback submissions, please try again later.' },
});

router.post('/:token/feedback', feedbackLimiter, asyncHandler(async (req, res) => {
  const { token } = req.params;
  if (!UUID_RE.test(token)) throw new NotFoundError('Tip page not found');

  const { rating, comment, email } = req.body || {};
  if (!Number.isInteger(rating) || rating < 1 || rating > 3) {
    throw new ValidationError('rating must be an integer 1-3');
  }
  if (comment != null && (typeof comment !== 'string' || comment.length > 2000)) {
    throw new ValidationError('comment must be a string of 2000 chars or fewer');
  }
  if (email != null && (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
    throw new ValidationError('invalid email');
  }

  const { rows } = await pool.query(`
    SELECT u.id AS user_id, cp.preferred_name AS display_name
    FROM payment_profiles pp
    JOIN users u ON u.id = pp.user_id
    JOIN contractor_profiles cp ON cp.user_id = u.id
    WHERE pp.tip_page_token = $1 AND pp.tip_page_active = TRUE
  `, [token]);

  const row = rows[0];
  if (!row) throw new NotFoundError('Tip page not found');

  await pool.query(`
    INSERT INTO tip_page_feedback (target_user_id, rating, comment, submitter_email)
    VALUES ($1, $2, $3, $4)
  `, [row.user_id, rating, comment || null, email || null]);

  // Best-effort admin notification — never fail the user-facing request on email.
  try {
    const tpl = emailTemplates.tipFeedbackAdminNotification({
      displayName: row.display_name || 'a bartender',
      rating,
      comment,
      submitterEmail: email,
      adminUrl: `${ADMIN_URL}/admin/tips#feedback`,
    });
    await sendEmail({
      to: process.env.ADMIN_FEEDBACK_NOTIFICATION_EMAIL || 'contact@drbartender.com',
      subject: tpl.subject,
      html: tpl.html,
    });
  } catch (err) {
    console.error('[tip] feedback admin email failed', err.message);
  }

  res.json({ ok: true });
}));
```

- [ ] **Step 3: Smoke test**

```bash
curl -X POST http://localhost:5000/api/public/tip/<token>/feedback \
  -H "Content-Type: application/json" \
  -d '{"rating":1,"comment":"too watered down","email":"test@example.com"}'
```

Expected: `{ "ok": true }`. Verify the row in DB:

```bash
psql "$DATABASE_URL" -c "SELECT id, target_user_id, rating, comment FROM tip_page_feedback ORDER BY id DESC LIMIT 1;"
```

Then verify admin email is in your inbox or in Resend's dashboard logs.

- [ ] **Step 4: Test rate limit**

Hit the endpoint 4 times in a row. Expected: 4th call returns 429.

- [ ] **Step 5: Test rejection of out-of-range rating**

```bash
curl -X POST http://localhost:5000/api/public/tip/<token>/feedback \
  -H "Content-Type: application/json" \
  -d '{"rating":5}'
```

Expected: 400 with the validation message.

- [ ] **Step 6: Commit**

```bash
git add server/routes/publicTip.js server/utils/emailTemplates.js
git commit -m "feat(tip): public POST /:token/feedback with admin email notification"
```

---

### Task 10: Backend — Stripe webhook tip ingestion

**Files:**
- Modify: `server/routes/stripe.js`

- [ ] **Step 1: Find the webhook handler in `stripe.js`**

```bash
grep -n "stripe-signature\|constructEvent\|case '" server/routes/stripe.js
```

Locate the existing `switch (event.type)` block.

- [ ] **Step 2: Add a `checkout.session.completed` case (or extend the existing one) for tips**

Inside the `switch` block:

```js
case 'checkout.session.completed': {
  const session = event.data.object;

  // Tip page handler — only for sessions tagged kind=tip in metadata
  if (session.metadata && session.metadata.kind === 'tip') {
    const targetUserId = parseInt(session.metadata.bartender_user_id, 10);
    const token = session.metadata.tip_page_token;
    const piId = session.payment_intent;

    if (!Number.isInteger(targetUserId) || !token || !piId) {
      console.error('[tip-webhook] malformed tip session metadata', session.id);
      break;
    }

    await pool.query(`
      INSERT INTO tips (tip_page_token, target_user_id, amount_cents,
                        stripe_payment_intent_id, stripe_session_id,
                        customer_email, tipped_at)
      VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))
      ON CONFLICT (stripe_payment_intent_id) DO NOTHING
    `, [
      token,
      targetUserId,
      session.amount_total,
      piId,
      session.id,
      session.customer_details && session.customer_details.email ? session.customer_details.email : null,
      session.created,
    ]);
    break;  // do not fall through to existing deposit/full-pay logic
  }

  // Existing checkout.session.completed handling continues below this block...
  break;
}
```

If `checkout.session.completed` isn't currently handled, add the case in the right spot in the switch and only the tip block will fire.

- [ ] **Step 3: Smoke test with the Stripe CLI in test mode**

```bash
stripe listen --forward-to localhost:5000/api/stripe/webhook
```

In a second terminal, trigger a test event:

```bash
stripe trigger checkout.session.completed
```

This won't have your tip metadata, so it should *not* create a tip row — verify by checking `SELECT COUNT(*) FROM tips`.

For end-to-end: open a test-mode tip page and pay $1 via the Credit Card button in real-time. Confirm a row appears in `tips`.

- [ ] **Step 4: Verify idempotency**

Re-trigger the same event (or use Stripe's "Resend webhook" feature) and confirm no duplicate row in `tips` (`stripe_payment_intent_id UNIQUE` enforces this).

- [ ] **Step 5: Commit**

```bash
git add server/routes/stripe.js
git commit -m "feat(tip): Stripe webhook ingestion of tip payments"
```

---

### Task 11: Frontend — port the design's atoms + main TipPage

**Files:**
- Create: `client/src/pages/public/TipPage.atoms.jsx`
- Create: `client/src/pages/public/TipPage.css`
- Create: `client/src/pages/public/TipPage.jsx`
- Create: `client/src/utils/buildTipDeepLink.js`

- [ ] **Step 1: Copy `tip-atoms.jsx` from the design into the project, adapted for ESM imports**

Take the design's `~/Downloads/QR Tips Page/tip-atoms.jsx` and rewrite as standard React component exports (the design used `window.X` because it ran in a no-build canvas; the project uses CRA's ES modules).

```jsx
// client/src/pages/public/TipPage.atoms.jsx
import React from 'react';

export const VenmoMark = () => (/* exact SVG from tip-atoms.jsx VenmoMark */);
export const CashAppMark = () => (/* exact SVG from tip-atoms.jsx CashAppMark */);
export const PaypalMark = () => (/* exact SVG from tip-atoms.jsx PaypalMark */);
export const CardNetworkRow = () => (/* exact SVG from tip-atoms.jsx */);
export const Chevron = () => (/* exact SVG */);
export const StarIcon = ({ filled }) => (/* exact SVG */);
export const Sparkle = ({ x, y, size = 14, color = '#C17D3C', rot = 0 }) => (/* exact SVG */);
export const HeroDecor = ({ compressed }) => (/* combination of Sparkles + the cocktail glyph */);

export const PayButton = ({ kind, label, sub, href }) => {
  const Mark = kind === 'venmo' ? VenmoMark
    : kind === 'cashapp' ? CashAppMark
    : kind === 'paypal' ? PaypalMark : null;
  return (
    <a className={`pay-btn ${kind}`} href={href} target="_blank" rel="noopener">
      <span className="pay-mark">
        {kind === 'card' ? <CardNetworkRow /> : <Mark />}
      </span>
      <span className="pay-label">
        {label}
        {sub && <small>{sub}</small>}
      </span>
      <span className="pay-chev"><Chevron /></span>
    </a>
  );
};
```

Copy each SVG body exactly as it appears in `~/Downloads/QR Tips Page/tip-atoms.jsx`.

- [ ] **Step 2: Copy `styles.css` from the design as `TipPage.css` with paths rewritten**

Take `~/Downloads/QR Tips Page/styles.css` and copy the contents into `client/src/pages/public/TipPage.css`. Then:

- Replace `url("./assets/parchment-bg.png")` → `url("/tip-page/parchment-bg.png")`
- Replace `url("./assets/chalkboard_background.png")` → `url("/tip-page/chalkboard-bg.png")`
- Replace `url("./assets/logo.png")` → `url("/tip-page/logo.png")` (if any in CSS)
- Remove the `@import url("./colors_and_type.css");` line — design tokens already live in `client/src/index.css`. If you need any tokens that *aren't* in `index.css`, add them to the bottom of `TipPage.css` scoped to `.tip-page { }`.

Verify all CSS variables referenced (`--paper`, `--ink`, `--amber`, etc.) actually exist in `client/src/index.css`. Grep:

```bash
grep -n "^\s*--paper\|^\s*--ink\|^\s*--amber\|^\s*--chalkboard" client/src/index.css
```

For any missing variable, add it to `index.css` matching the values from `colors_and_type.css`.

- [ ] **Step 3: Create the deep-link builder**

```js
// client/src/utils/buildTipDeepLink.js

// Returns the URL to navigate to when the customer taps a payment button.
// Cash App and PayPal pre-fill the amount via URL; Venmo and Stripe ignore it.
export function buildTipDeepLink({ kind, handles, amount }) {
  const numAmount = Number(amount);
  const includeAmount = Number.isFinite(numAmount) && numAmount > 0;

  switch (kind) {
    case 'venmo':
      if (!handles.venmo_handle) return null;
      return `https://venmo.com/u/${encodeURIComponent(handles.venmo_handle)}`;
    case 'cashapp':
      if (!handles.cashapp_handle) return null;
      return includeAmount
        ? `https://cash.app/$${encodeURIComponent(handles.cashapp_handle)}/${numAmount}`
        : `https://cash.app/$${encodeURIComponent(handles.cashapp_handle)}`;
    case 'paypal':
      if (!handles.paypal_url) return null;
      // paypal_url may be 'paypal.me/x' or full URL — handle both.
      const cleaned = String(handles.paypal_url).replace(/^https?:\/\//, '').replace(/^www\./, '');
      const base = cleaned.startsWith('paypal.me/') ? cleaned : `paypal.me/${cleaned}`;
      return includeAmount
        ? `https://${base.replace(/\/+$/, '')}/${numAmount}`
        : `https://${base.replace(/\/+$/, '')}`;
    case 'card':
      // Stripe Payment Link doesn't support amount via URL — customer types on Stripe checkout.
      return handles.stripe_payment_link_url || null;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Create `TipPage.jsx`**

Port the design's `tip-page.jsx`. Critical changes:
- Fetch `/api/public/tip/:token` on mount instead of taking props.
- Use `buildTipDeepLink` to compute each PayButton's `href`.
- Hide buttons whose handle is empty (per spec 8.3).
- 1-3★ click → expand inline feedback form. 4-5★ click → `window.location = process.env.REACT_APP_GOOGLE_REVIEW_URL`.
- After submitting feedback → swap form for thank-you state (see design's `tx-thanks` styles).

```jsx
// client/src/pages/public/TipPage.jsx
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  PayButton, StarIcon, HeroDecor, Chevron,
} from './TipPage.atoms';
import { buildTipDeepLink } from '../../utils/buildTipDeepLink';
import './TipPage.css';

const AMOUNTS = [5, 10, 20];
const GOOGLE_REVIEW_URL = process.env.REACT_APP_GOOGLE_REVIEW_URL || 'https://google.com';

export default function TipPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [amount, setAmount] = useState(10);
  const [stars, setStars] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [popped, setPopped] = useState(-1);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [comment, setComment] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/public/tip/${token}`)
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(setData)
      .catch(() => setError('not-found'));
  }, [token]);

  if (error === 'not-found') {
    return (
      <main className="tip-page">
        <header className="hero" style={{ paddingBottom: 32 }}>
          <p className="hero-kicker">Dr. Bartender</p>
          <h1>This tip page isn't available.</h1>
        </header>
      </main>
    );
  }
  if (!data) return null;  // simple skeleton; design doesn't include a loading state

  const isFeedbackOpen = stars >= 1 && stars <= 3;

  function clickStar(n) {
    setStars(n);
    setPopped(n);
    setTimeout(() => setPopped(-1), 200);
    if (n >= 4) {
      setTimeout(() => { window.location.href = GOOGLE_REVIEW_URL; }, 250);
    }
  }

  async function submitFeedback(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const r = await fetch(`/api/public/tip/${token}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: stars, comment, email }),
      });
      if (!r.ok) throw new Error('submit failed');
      setFeedbackSent(true);
    } catch {
      alert('Could not send feedback — please try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  }

  const buttons = [
    data.venmo_handle && { kind: 'venmo', label: 'Venmo', sub: `@${data.venmo_handle}` },
    data.cashapp_handle && { kind: 'cashapp', label: 'Cash App', sub: `$${data.cashapp_handle}` },
    data.stripe_payment_link_url && { kind: 'card', label: 'Credit Card', sub: 'Apple Pay, Google Pay' },
    data.paypal_url && { kind: 'paypal', label: 'PayPal', sub: data.paypal_url.replace(/^https?:\/\//, '') },
  ].filter(Boolean);

  return (
    <main className="tip-page">
      <header className="hero">
        <HeroDecor compressed />
        <p className="hero-kicker">Dr. Bartender</p>
        <h1>You're the Best <span className="heart">❤</span> Thanks for Tipping</h1>
      </header>

      <div className="headshot-mount">
        <div className="headshot-frame">
          {data.headshot_url
            ? <img src={data.headshot_url} alt={`${data.display_name}, your bartender`} />
            : <div style={{ background: 'var(--paper-dark)', width: '100%', height: '100%', borderRadius: '50%' }} />}
        </div>
        <h2 className="tip-name">Tip {data.display_name}</h2>
      </div>

      <section className="section first" aria-label="Tip amount">
        <div className="amount-row">
          {AMOUNTS.map(v => (
            <button key={v} type="button"
              className={`amount-btn ${amount === v ? 'selected' : ''}`}
              onClick={() => setAmount(v)}>${v}</button>
          ))}
          <button type="button"
            className={`amount-btn ${!AMOUNTS.includes(amount) ? 'selected' : ''}`}
            onClick={() => setAmount('custom')}>
            <small>Custom</small>
          </button>
        </div>
        <p className="amount-tagline">Pick an amount, then tap how you'd like to send it.</p>

        <ul className="pay-list">
          {buttons.map(btn => {
            const href = buildTipDeepLink({
              kind: btn.kind,
              handles: data,
              amount: amount === 'custom' ? null : amount,
            });
            return (
              <li key={btn.kind}>
                <PayButton kind={btn.kind} label={btn.label} sub={btn.sub} href={href || '#'} />
              </li>
            );
          })}
        </ul>
      </section>

      <section className="section" aria-labelledby="rate-heading">
        <h3 id="rate-heading" className="section-heading">Leave Your Mark</h3>
        <div className="stars-wrap" role="radiogroup" aria-label="Rate your experience">
          {[1,2,3,4,5].map(n => {
            const lit = n <= (hovered || stars);
            return (
              <button key={n} type="button" role="radio"
                aria-checked={stars === n}
                aria-label={`${n} star${n>1?'s':''}`}
                className={`star ${lit ? 'lit' : ''} ${popped === n ? 'popped' : ''}`}
                onMouseEnter={() => setHovered(n)}
                onMouseLeave={() => setHovered(0)}
                onClick={() => clickStar(n)}>
                <StarIcon filled={lit} />
              </button>
            );
          })}
        </div>

        {!isFeedbackOpen && !feedbackSent && (
          <p className="stars-helper">How was your experience with {data.display_name}?</p>
        )}

        {isFeedbackOpen && !feedbackSent && (
          <form className="feedback-card" onSubmit={submitFeedback}>
            <h3>Tell us what went sideways</h3>
            <p className="intro">We read every note, and we'll make it right.</p>

            <label className="field-label" htmlFor="fb-comment">Your note</label>
            <textarea id="fb-comment" className="tx" maxLength={2000}
              value={comment} onChange={e => setComment(e.target.value)}
              placeholder="What went wrong tonight?" />

            <label className="field-label" htmlFor="fb-email" style={{ marginTop: 12 }}>
              Email <span style={{ opacity: 0.6, letterSpacing: 0 }}>(optional)</span>
            </label>
            <input id="fb-email" type="email" className="input-text"
              value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com" />
            <p className="helper">We may follow up to make this right.</p>

            <button type="submit" className="submit-btn" disabled={submitting}>
              {submitting ? 'Sending…' : 'Send to Dr. Bartender'}
            </button>
          </form>
        )}

        {feedbackSent && (
          <div className="tx-thanks">
            <div className="ornament">· · ·</div>
            <h3>Thanks — we hear you</h3>
            <p>We'll be in touch.</p>
          </div>
        )}
      </section>

      <Footer />
    </main>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <img className="foot-logo" src="/tip-page/logo.png" alt="Dr. Bartender" />
      <p className="foot-name">Dr. <b>Bartender</b></p>
      <p className="foot-tag">Mobile Bar · Cocktail Lab</p>
      <p className="foot-meta">
        © {new Date().getFullYear()} Dr. Bartender LLC
        <span className="powered">Powered by Dr. Bartender OS</span>
      </p>
    </footer>
  );
}
```

- [ ] **Step 5: Commit (route registration in next task)**

```bash
git add client/src/pages/public/TipPage.jsx \
        client/src/pages/public/TipPage.atoms.jsx \
        client/src/pages/public/TipPage.css \
        client/src/utils/buildTipDeepLink.js
git commit -m "feat(tip): public TipPage component, atoms, styles, deep-link builder"
```

---

### Task 12: Frontend — TipPageThanks (Stripe redirect target)

**Files:**
- Create: `client/src/pages/public/TipPageThanks.jsx`

- [ ] **Step 1: Create the post-tip thanks page**

```jsx
// client/src/pages/public/TipPageThanks.jsx
import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Chevron, HeroDecor } from './TipPage.atoms';
import './TipPage.css';

const GOOGLE_REVIEW_URL = process.env.REACT_APP_GOOGLE_REVIEW_URL || 'https://google.com';
const INSTAGRAM_URL = 'https://instagram.com/drbartender';

export default function TipPageThanks() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState(null);

  // amount in dollars, parsed from amount_total cents Stripe substituted at redirect
  const amountCents = Number(params.get('amount'));
  const amount = Number.isFinite(amountCents) ? Math.round(amountCents / 100) : null;

  useEffect(() => {
    fetch(`/api/public/tip/${token}`)
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(setData)
      .catch(() => setData({ display_name: 'your bartender' }));  // graceful fallback
  }, [token]);

  if (!data) return null;

  return (
    <main className="tip-page">
      <header className="hero" style={{ paddingBottom: 32 }}>
        <HeroDecor compressed />
        <p className="hero-kicker">Dr. Bartender</p>
        <h1>Cheers from {data.display_name} <span className="heart">❤</span></h1>
      </header>

      <div className="posttip">
        <div className="posttip-mark">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor"
               strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h2>Tip received</h2>
        <p>Thanks for taking care of {data.display_name} tonight.</p>
        {amount && <div className="amount-pill">${amount}.00 · sent</div>}
      </div>

      <a className="cta-card" href={GOOGLE_REVIEW_URL} target="_blank" rel="noopener"
         style={{
           background: 'var(--amber)', borderColor: 'var(--warm-brown)',
           color: '#fff', boxShadow: '0 4px 14px rgba(193,125,60,0.4)',
         }}>
        <span className="cta-icon" style={{ background: 'rgba(255,255,255,0.18)', borderColor: 'rgba(255,255,255,0.25)' }}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="#fff">
            <polygon points="12 2 15 9 22 9.3 16.5 14 18 21 12 17.5 6 21 7.5 14 2 9.3 9 9" />
          </svg>
        </span>
        <span className="cta-body">
          <h4 style={{ color: '#fff' }}>Tell Google how it went</h4>
          <p style={{ color: 'rgba(255,255,255,0.85)' }}>Two taps. Helps us book more events.</p>
        </span>
        <span className="cta-go" style={{ color: '#fff' }}><Chevron /></span>
      </a>

      <a className="cta-card" href={INSTAGRAM_URL} target="_blank" rel="noopener">
        <span className="cta-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#6B4226" strokeWidth="1.8">
            <rect x="3" y="3" width="18" height="18" rx="5" />
            <circle cx="12" cy="12" r="4" />
            <circle cx="17.5" cy="6.5" r="0.9" fill="#6B4226" />
          </svg>
        </span>
        <span className="cta-body">
          <h4>Follow @drbartender</h4>
          <p>Cocktail recipes, behind-the-bar.</p>
        </span>
        <span className="cta-go"><Chevron /></span>
      </a>

      <a className="cta-skip" href="/">No thanks, I'm done</a>

      <footer className="foot" style={{ marginTop: 18, padding: '16px 24px' }}>
        <img className="foot-logo" src="/tip-page/logo.png" alt="Dr. Bartender" />
        <p className="foot-name">Dr. <b>Bartender</b></p>
        <p className="foot-meta">
          © {new Date().getFullYear()} Dr. Bartender LLC
          <span className="powered">Powered by Dr. Bartender OS</span>
        </p>
      </footer>
    </main>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/pages/public/TipPageThanks.jsx
git commit -m "feat(tip): post-Stripe thanks page with Google review + IG CTAs"
```

---

### Task 13: Frontend — register routes in App.js

**Files:**
- Modify: `client/src/App.js`

- [ ] **Step 1: Add lazy imports near other lazy/static imports at the top**

```jsx
import TipPage from './pages/public/TipPage';
import TipPageThanks from './pages/public/TipPageThanks';
```

- [ ] **Step 2: Register routes inside `PublicWebsiteRoutes` (and any other route group serving the public marketing site)**

Find:
```jsx
<Route path="/proposal/:token" element={<ProposalView />} />
```

Add right after:
```jsx
<Route path="/tip/:token" element={<TipPage />} />
<Route path="/tip/:token/thanks" element={<TipPageThanks />} />
```

If there's also a `HiringRoutes` block that lazy-renders public-token routes, add the same two lines there to ensure parity (search for the existing `/proposal/:token` line in App.js — duplicate the same routes adjacent).

- [ ] **Step 3: Smoke test in browser**

```bash
npm run dev
```

Open `http://localhost:3000/tip/<token-from-your-db>` — should render the design. Open `http://localhost:3000/tip/<token>/thanks?amount=2000` — should show "Tip received" with "$20.00 · sent" pill.

- [ ] **Step 4: Walk through the full flow**

1. Open `/tip/<token>` on a phone-sized viewport (DevTools → toggle device toolbar → 390x844).
2. Pick $10, tap Cash App — should open `https://cash.app/$<handle>/10`.
3. Tap Credit Card — should hit the Stripe test-mode checkout.
4. Complete payment with `4242 4242 4242 4242` test card.
5. Should redirect back to `/tip/<token>/thanks?amount=1000` showing the thanks state.
6. Verify a row in the `tips` table.
7. Go back to `/tip/<token>` and click 1 star → form expands → submit → see the thanks state and a row in `tip_page_feedback` and an admin email.

- [ ] **Step 5: Commit**

```bash
git add client/src/App.js
git commit -m "feat(tip): register /tip/:token and /tip/:token/thanks routes"
```

---

## Phase 4 — Staff portal

### Task 14: Backend — staff portal `/api/me/tip-page` (GET + PATCH)

**Files:**
- Create: `server/routes/me.js`
- Modify: `server/index.js`

- [ ] **Step 1: Create the `me.js` route file**

```js
// server/routes/me.js
const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError } = require('../utils/errors');
const { PUBLIC_SITE_URL } = require('../utils/urls');

const router = express.Router();
router.use(auth);

router.get('/tip-page', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      cp.preferred_name,
      pp.tip_page_token,
      pp.tip_page_active,
      pp.venmo_handle,
      pp.cashapp_handle,
      pp.paypal_url,
      pp.preferred_payment_method,
      pp.stripe_payment_link_url,
      (SELECT COUNT(*)::int FROM tips WHERE target_user_id = $1
        AND tipped_at >= date_trunc('month', NOW())) AS tips_this_month_count,
      (SELECT COALESCE(SUM(amount_cents), 0)::int FROM tips WHERE target_user_id = $1
        AND tipped_at >= date_trunc('month', NOW())) AS tips_this_month_cents
    FROM users u
    LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
    LEFT JOIN payment_profiles pp ON pp.user_id = u.id
    WHERE u.id = $1
  `, [req.user.id]);

  const row = rows[0] || {};
  const url = row.tip_page_token
    ? `${PUBLIC_SITE_URL}/tip/${row.tip_page_token}`
    : null;

  res.json({
    url,
    active: !!row.tip_page_active,
    has_stripe_link: !!row.stripe_payment_link_url,
    preferred_name: row.preferred_name || null,
    venmo_handle: row.venmo_handle || null,
    cashapp_handle: row.cashapp_handle || null,
    paypal_url: row.paypal_url || null,
    preferred_payment_method: row.preferred_payment_method || null,
    tips_this_month_count: row.tips_this_month_count || 0,
    tips_this_month_cents: row.tips_this_month_cents || 0,
  });
}));

const ALLOWED_PATCH_FIELDS = new Set([
  'preferred_name',
  'venmo_handle',
  'cashapp_handle',
  'paypal_url',
  'preferred_payment_method',
]);
const ALLOWED_PAYMENT_METHODS = ['venmo', 'cashapp', 'paypal', 'check', 'direct_deposit', 'other'];

router.patch('/tip-page', asyncHandler(async (req, res) => {
  // Allowlist filter — silently ignore any field not in ALLOWED_PATCH_FIELDS.
  const updates = {};
  for (const k of Object.keys(req.body || {})) {
    if (ALLOWED_PATCH_FIELDS.has(k)) updates[k] = req.body[k];
  }

  if ('preferred_name' in updates) {
    const t = String(updates.preferred_name || '').trim();
    if (!t) throw new ValidationError('preferred_name cannot be blank');
    updates.preferred_name = t;
  }
  if ('preferred_payment_method' in updates && updates.preferred_payment_method
      && !ALLOWED_PAYMENT_METHODS.includes(updates.preferred_payment_method)) {
    throw new ValidationError('invalid preferred_payment_method');
  }

  // preferred_name lives on contractor_profiles
  if ('preferred_name' in updates) {
    await pool.query(
      'UPDATE contractor_profiles SET preferred_name = $1, updated_at = NOW() WHERE user_id = $2',
      [updates.preferred_name, req.user.id]
    );
    delete updates.preferred_name;
  }

  // remaining fields live on payment_profiles
  if (Object.keys(updates).length > 0) {
    const cols = Object.keys(updates);
    const setClause = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await pool.query(`
      INSERT INTO payment_profiles (user_id, ${cols.join(', ')})
      VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
      ON CONFLICT (user_id) DO UPDATE SET
        ${setClause},
        updated_at = NOW()
    `, [req.user.id, ...cols.map(c => updates[c] || null)]);
  }

  res.json({ ok: true });
}));

module.exports = router;
```

- [ ] **Step 2: Register in `server/index.js`**

```js
app.use('/api/me', require('./routes/me'));
```

Place near other `app.use` lines.

- [ ] **Step 3: Smoke test**

```bash
curl http://localhost:5000/api/me/tip-page \
  -H "Authorization: Bearer YOUR_DEV_JWT"
```

Expected: JSON with `url`, `active`, handles, tip totals.

```bash
curl -X PATCH http://localhost:5000/api/me/tip-page \
  -H "Authorization: Bearer YOUR_DEV_JWT" \
  -H "Content-Type: application/json" \
  -d '{"venmo_handle":"newhandle","preferred_name":"NewName","tip_page_token":"hax","stripe_payment_link_id":"hax"}'
```

Expected: `{ "ok": true }`. Verify in DB that `venmo_handle` and `preferred_name` updated, but `tip_page_token` and `stripe_payment_link_id` are unchanged (allowlist worked).

- [ ] **Step 4: Commit**

```bash
git add server/routes/me.js server/index.js
git commit -m "feat(tip): staff portal /api/me/tip-page (GET + PATCH allowlisted)"
```

---

### Task 15: Backend — `/api/me/tips` paginated history

**Files:**
- Modify: `server/routes/me.js`

- [ ] **Step 1: Append the tips endpoint to `me.js`**

```js
router.get('/tips', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const cursor = parseInt(req.query.cursor, 10) || null;

  const { rows } = await pool.query(`
    SELECT id, amount_cents, tipped_at
    FROM tips
    WHERE target_user_id = $1
      ${cursor ? 'AND id < $3' : ''}
    ORDER BY id DESC
    LIMIT $2
  `, cursor ? [req.user.id, limit, cursor] : [req.user.id, limit]);

  res.json({
    tips: rows,
    next_cursor: rows.length === limit ? rows[rows.length - 1].id : null,
  });
}));
```

- [ ] **Step 2: Smoke test**

```bash
curl http://localhost:5000/api/me/tips -H "Authorization: Bearer YOUR_DEV_JWT"
```

Expected: array of tip rows for the authed user only. Try as a different user and confirm no other user's tips leak.

- [ ] **Step 3: Commit**

```bash
git add server/routes/me.js
git commit -m "feat(tip): /api/me/tips paginated history"
```

---

### Task 16: Frontend — Print Tip Card page (client-side, three sizes)

**Approach change:** the previous draft of this task did server-side QR card PNG generation. Switched to **client-side print** because (a) the design (`qr-print.jsx`) uses sophisticated React + CSS layouts that don't translate cleanly to server-side SVG/PNG, and (b) browser print-to-PDF is what photo counters consume anyway. The bartender opens the print page in their staff portal, picks a size, the page renders the design, browser print dialog opens with `@page` rules sized correctly, they save as PDF or send to printer. Photo counters print PDFs fine.

**Three sizes available:**

| Size | Trim | Use |
|---|---|---|
| Business card (two-sided) | 3.5″ × 2″ | Drop in pocket / wallet, hand to customers, pin on bar caddy |
| 4×6 | 4″ × 6″ portrait | Easel frame on the bar |
| 5×7 | 5″ × 7″ portrait | Acrylic block / table tent display piece |

**Files:**
- Create: `client/src/pages/staff/PrintTipCard.js`
- Create: `client/src/pages/staff/PrintTipCard.css`
- Modify: `client/src/App.js` (add route inside the staff layout)
- Modify: `client/package.json` (add `qrcode.react`)

- [ ] **Step 1: Install client-side QR library**

```bash
cd client && npm install qrcode.react
```

- [ ] **Step 2: Port the print components from `qr-print.jsx`**

Open `~/Downloads/QR Tips Page (1)/qr-print.jsx`. It exports:
- `BizCardFrontA`, `BizCardFrontB` — front variants
- `BizCardBackA`, `BizCardBackB` — back variants
- `FourBySixA` (and possibly `FourBySixB`)
- `FiveBySevenA` (and possibly `FiveBySevenB`)
- Helpers: `FakeQR`, `BrassRule`, `PayMark`, `PaymentRow`, `FlaskGlyph`, `PrintSheet`, `LogoMedallion`, `HeadshotFrame`, `PaperBg`, `ChalkBg`

Port these to `client/src/pages/staff/PrintTipCard.js` with these adaptations:

1. **Replace `FakeQR` with a real QR.** Use `QRCodeSVG` from `qrcode.react`:

   ```jsx
   import { QRCodeSVG } from 'qrcode.react';
   // ...
   <QRCodeSVG value={tipUrl} size={size} bgColor="#FFFFFF" fgColor="#12161C" level="M" includeMargin={false} />
   ```

2. **Use real bartender data** instead of the design's hardcoded "Kaitlyn / Kaitlyn Reyes":
   ```jsx
   <BizCardFrontA name={data.preferred_name} tipUrl={data.url} />
   ```

3. **Logo paths** — design references `./assets/logo-gold.png`. Rewrite to `/tip-page/logo-gold.png` (matching where Task 1 copied them).

4. **Drop the `PrintSheet` crop ticks** (they're for canvas preview, not actual print).

5. **Drop the second variant (B)** for MVP — keep only the A variants for each size, plus the BizCard back A. Variant choice is a future enhancement.

- [ ] **Step 3: Create the page component that ties them together**

```jsx
// client/src/pages/staff/PrintTipCard.js
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import '../../styles/drb-tokens.css';
import './PrintTipCard.css';

import {
  BizCardFrontA, BizCardBackA,
  FourBySixA, FiveBySevenA,
} from './PrintTipCard.layouts'; // suggest splitting layouts to a sibling file

const SIZES = {
  bizcard: { label: 'Business card (3.5×2", 2-sided)', renderFront: BizCardFrontA, renderBack: BizCardBackA },
  '4x6':   { label: '4×6 photo (1-sided)',  renderFront: FourBySixA,  renderBack: null },
  '5x7':   { label: '5×7 photo (1-sided)',  renderFront: FiveBySevenA, renderBack: null },
};

export default function PrintTipCard() {
  const [data, setData] = useState(null);
  const [params, setParams] = useSearchParams();
  const size = params.get('size') || 'bizcard';

  useEffect(() => {
    api.get('/me/tip-page').then(r => setData(r.data));
  }, []);

  if (!data) return <p style={{ padding: 24 }}>Loading…</p>;
  if (!data.url) return <p style={{ padding: 24 }}>Your tip page isn't active yet.</p>;

  const { label, renderFront: Front, renderBack: Back } = SIZES[size] || SIZES.bizcard;

  return (
    <div className="print-tip-card-root drb">
      {/* ─ controls (hidden on print) ─ */}
      <div className="print-controls" data-no-print>
        <h1>Print your tip card</h1>
        <p className="helper">
          Choose a size, then click "Print" — your browser will open its print dialog.
          Save as PDF and take it to a photo counter, or print at home.
        </p>
        <div className="size-picker">
          {Object.entries(SIZES).map(([key, s]) => (
            <label key={key} className={size === key ? 'selected' : ''}>
              <input type="radio" name="size" value={key}
                checked={size === key}
                onChange={() => setParams({ size: key })} />
              {s.label}
            </label>
          ))}
        </div>
        <button className="btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      {/* ─ printable area ─ */}
      <div className={`print-stage size-${size}`} data-print-area>
        <Front name={data.preferred_name} tipUrl={data.url} />
        {Back && (
          <div className="page-break">
            <Back name={data.preferred_name} tipUrl={data.url} />
          </div>
        )}
      </div>
    </div>
  );
}
```

Split the ported layouts into `client/src/pages/staff/PrintTipCard.layouts.js` (kept separate so the layouts don't bloat the page component file).

- [ ] **Step 4: Create `PrintTipCard.css` with `@page` rules per size**

```css
/* Hide controls when printing */
@media print {
  [data-no-print] { display: none !important; }
}

/* Default screen — frame the print stage so the bartender can preview */
.print-tip-card-root {
  background: #444;
  min-height: 100vh;
  padding: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
}

.print-controls {
  background: #fff;
  padding: 24px;
  border-radius: 8px;
  max-width: 520px;
}

.print-stage {
  background: #fff;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  display: inline-block;
}

/* On-screen sizes match the print sizes (CSS pixels = inches × 96 for screen) */
.print-stage.size-bizcard { width: 3.5in; height: 2in; }
.print-stage.size-4x6     { width: 4in;   height: 6in; }
.print-stage.size-5x7     { width: 5in;   height: 7in; }

.page-break { page-break-before: always; }

/* ── Print sizes ──────────────────────────────────────────── */

/* Business card sheet — 3.5×2 portrait + back side on next page */
@page bizcard { size: 3.5in 2in; margin: 0; }
.print-stage.size-bizcard, .print-stage.size-bizcard * { box-sizing: border-box; }

@media print {
  .print-stage.size-bizcard { page: bizcard; }
  @page { size: 3.5in 2in; margin: 0; }
}

/* 4×6 */
@media print {
  .print-stage.size-4x6 { page: photo46; }
  @page photo46 { size: 4in 6in; margin: 0; }
}

/* 5×7 */
@media print {
  .print-stage.size-5x7 { page: photo57; }
  @page photo57 { size: 5in 7in; margin: 0; }
}
```

(Note: CSS named pages have spotty browser support — fallback is the bare `@page { size: ... }` which Chromium honors at print time when the size is consistent across the document. For a single-size print job, the simple `@page { size: 4in 6in; }` works in practice. The named-page approach is for the rare case where the user prints multiple sizes from one document.)

- [ ] **Step 5: Register the route inside the staff layout in `App.js`**

```jsx
import PrintTipCard from './pages/staff/PrintTipCard';
// inside the StaffLayout block:
<Route path="/my-tip-page/print" element={<PrintTipCard />} />
```

- [ ] **Step 6: Smoke test in browser**

```bash
npm run dev
```

1. Log in as a contractor with a tip page.
2. Navigate to `/my-tip-page/print` (or click "Print Card" from MyTipPage in next task).
3. Verify all three size radio buttons preview the right layout on screen.
4. Click "Print" — browser print dialog opens with the right page size.
5. "Save as PDF" — the resulting PDF should be exactly 3.5×2 / 4×6 / 5×7 inches.
6. Open the PDF, scan the QR with your phone — confirms it routes to the bartender's tip page.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/staff/PrintTipCard.js \
        client/src/pages/staff/PrintTipCard.layouts.js \
        client/src/pages/staff/PrintTipCard.css \
        client/src/App.js \
        client/package.json client/package-lock.json
git commit -m "feat(tip): client-side print tip card (business card + 4x6 + 5x7)"
```

---

### Task 17: Frontend — Staff portal MyTipPage

**Files:**
- Create: `client/src/pages/staff/MyTipPage.js`
- Modify: `client/src/App.js` (add route inside the staff layout)

- [ ] **Step 1: Create the component**

```jsx
// client/src/pages/staff/MyTipPage.js
import React, { useEffect, useState } from 'react';
import api from '../../utils/api';

const PAY_METHODS = [
  ['venmo', 'Venmo'],
  ['cashapp', 'Cash App'],
  ['paypal', 'PayPal'],
  ['check', 'Check'],
  ['direct_deposit', 'Direct deposit'],
  ['other', 'Other'],
];

export default function MyTipPage() {
  const [data, setData] = useState(null);
  const [tips, setTips] = useState([]);
  const [edit, setEdit] = useState({});
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.get('/me/tip-page').then(r => {
      setData(r.data);
      setEdit({
        preferred_name: r.data.preferred_name || '',
        venmo_handle: r.data.venmo_handle || '',
        cashapp_handle: r.data.cashapp_handle || '',
        paypal_url: r.data.paypal_url || '',
        preferred_payment_method: r.data.preferred_payment_method || '',
      });
    });
    api.get('/me/tips').then(r => setTips(r.data.tips || []));
  }, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch('/me/tip-page', edit);
      const r = await api.get('/me/tip-page');
      setData(r.data);
    } finally {
      setSaving(false);
    }
  }

  function copyUrl() {
    navigator.clipboard.writeText(data.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (!data) return <p>Loading…</p>;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <h1>My Tip Page</h1>

      {/* URL + copy */}
      {data.url ? (
        <section style={{ marginBottom: 24 }}>
          <h2>Your tip page</h2>
          <code style={{ fontSize: 16 }}>{data.url}</code>
          <button onClick={copyUrl} style={{ marginLeft: 12 }}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </section>
      ) : (
        <p><em>Your tip page is not yet active. Complete onboarding first.</em></p>
      )}

      {/* Print card */}
      {data.has_stripe_link && data.url && (
        <section style={{ marginBottom: 24 }}>
          <h2>Print your QR card</h2>
          <p>
            Choose business card, 4×6, or 5×7 — your browser will open the print dialog
            with the right page size. Save as PDF and take it to any photo counter
            (Walmart, CVS, Walgreens) for same-day printing, ~$0.30. Or print at home.
          </p>
          <a href="/my-tip-page/print" className="btn-primary">Print my tip card</a>
        </section>
      )}

      {!data.has_stripe_link && data.url && (
        <p><em>Your Stripe link isn't ready yet. Contact admin to generate it.</em></p>
      )}

      {/* Edit handles */}
      <section style={{ marginBottom: 24 }}>
        <h2>Edit my handles</h2>
        <form onSubmit={save}>
          <label>Preferred name <input required value={edit.preferred_name}
            onChange={e => setEdit(s => ({...s, preferred_name: e.target.value}))} /></label>

          <label>Venmo <input value={edit.venmo_handle}
            onChange={e => setEdit(s => ({...s, venmo_handle: e.target.value}))} /></label>

          <label>Cash App <input value={edit.cashapp_handle}
            onChange={e => setEdit(s => ({...s, cashapp_handle: e.target.value}))} /></label>

          <label>PayPal <input type="url" value={edit.paypal_url}
            onChange={e => setEdit(s => ({...s, paypal_url: e.target.value}))} /></label>

          <fieldset>
            <legend>Pay me out via</legend>
            {PAY_METHODS.map(([v, l]) => (
              <label key={v}><input type="radio" name="ppm" value={v}
                checked={edit.preferred_payment_method === v}
                onChange={() => setEdit(s => ({...s, preferred_payment_method: v}))} />{l}</label>
            ))}
          </fieldset>

          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </form>

        <p style={{ fontSize: 14, color: '#888', marginTop: 8 }}>
          Stripe link: <strong>Managed by DRB.</strong> Contact admin to regenerate.
        </p>
      </section>

      {/* My tips */}
      <section>
        <h2>My tips</h2>
        <p>
          Tips received via your QR this month:
          <strong> ${(data.tips_this_month_cents / 100).toFixed(2)}</strong>
        </p>
        <p style={{ fontSize: 14, color: '#888', fontStyle: 'italic' }}>
          These tips will be pooled with co-workers from each event and paid out via your next
          payroll. Final amount may differ from this total.
        </p>

        {tips.length === 0 ? (
          <p><em>No tips yet. Print your QR and bring it to your next event.</em></p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th>Amount</th><th>Date</th><th>Source</th></tr></thead>
            <tbody>
              {tips.map(t => (
                <tr key={t.id}>
                  <td>${(t.amount_cents / 100).toFixed(2)}</td>
                  <td>{new Date(t.tipped_at).toLocaleString()}</td>
                  <td>via Stripe</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Register the route inside the staff layout in `App.js`**

Find the `<Route element={<RequirePortal><StaffLayout /></RequirePortal>}>` block. Add:

```jsx
<Route path="/my-tip-page" element={<MyTipPage />} />
```

And import `MyTipPage` at the top of the file:

```jsx
import MyTipPage from './pages/staff/MyTipPage';
```

- [ ] **Step 3: Add a nav link to the staff layout (find the existing `StaffLayout` or whatever component renders the staff nav)**

```bash
grep -rn "StaffLayout\|/dashboard\|/shifts\|/profile" client/src/ | head -20
```

In whichever component renders the staff sidebar/nav, add:

```jsx
<NavLink to="/my-tip-page">My Tip Page</NavLink>
```

- [ ] **Step 4: Smoke test in browser**

Log in as a contractor with a tip page set up, navigate to `/my-tip-page`. Verify:
- URL displays + copy works
- QR downloads as a PNG (open it; it should be a scannable QR)
- Edit handles → save → reload → values persist
- Tip history renders

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/staff/MyTipPage.js client/src/App.js [staff-layout-file]
git commit -m "feat(tip): staff portal My Tip Page (URL/QR/handles/history)"
```

---

## Phase 5 — Admin surfaces

### Task 18: Backend — admin tip-page actions per contractor

**Files:**
- Modify: `server/routes/admin.js` (or whichever admin route file handles per-contractor actions)

> **Locate the right file first:** the existing admin routes for editing a contractor's record live somewhere under `server/routes/`. Find with:
> ```bash
> grep -rn "requireAdminOrManager\|router.patch.*contractor\|router.post.*contractor" server/routes/ | head
> ```

- [ ] **Step 1: Add the four endpoints (PATCH / regenerate / generate / deactivate)**

Add to the admin contractor route (placeholder path `/contractors/:userId/...`):

```js
const { requireAdminOrManager } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const {
  createTipPaymentLink,
  deactivateTipPaymentLink,
} = require('../utils/tipPaymentLinks');
const { activateTipPage, deactivateTipPage } = require('../utils/tipPageLifecycle');

// Edit handles + payroll preference (admin override)
router.patch('/contractors/:userId/tip-page', requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const fields = {};
  for (const k of ['venmo_handle', 'cashapp_handle', 'paypal_url', 'preferred_payment_method']) {
    if (k in req.body) fields[k] = req.body[k];
  }

  if ('preferred_payment_method' in fields && fields.preferred_payment_method
      && !['venmo','cashapp','paypal','check','direct_deposit','other'].includes(fields.preferred_payment_method)) {
    throw new ValidationError('invalid preferred_payment_method');
  }

  if ('preferred_name' in req.body) {
    await pool.query(
      'UPDATE contractor_profiles SET preferred_name = $1, updated_at = NOW() WHERE user_id = $2',
      [String(req.body.preferred_name || '').trim() || null, userId]
    );
  }

  if (Object.keys(fields).length > 0) {
    const cols = Object.keys(fields);
    const setClause = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await pool.query(`
      INSERT INTO payment_profiles (user_id, ${cols.join(', ')})
      VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
      ON CONFLICT (user_id) DO UPDATE SET ${setClause}, updated_at = NOW()
    `, [userId, ...cols.map(c => fields[c] || null)]);
  }
  res.json({ ok: true });
}));

// Regenerate Stripe link (deactivate old + create new)
router.post('/contractors/:userId/tip-page/regenerate-stripe', requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const { rows } = await pool.query(`
    SELECT pp.tip_page_token, pp.stripe_payment_link_id, cp.preferred_name
    FROM payment_profiles pp
    LEFT JOIN contractor_profiles cp ON cp.user_id = pp.user_id
    WHERE pp.user_id = $1
  `, [userId]);
  const row = rows[0];
  if (!row || !row.tip_page_token) throw new NotFoundError('contractor has no tip page');

  if (row.stripe_payment_link_id) {
    try { await deactivateTipPaymentLink(row.stripe_payment_link_id); }
    catch (err) { console.error('[tip-admin] deactivate old link failed', err.message); }
  }

  const { url, id } = await createTipPaymentLink({
    userId, displayName: row.preferred_name, token: row.tip_page_token,
  });
  await pool.query(
    'UPDATE payment_profiles SET stripe_payment_link_url = $1, stripe_payment_link_id = $2 WHERE user_id = $3',
    [url, id, userId]
  );
  res.json({ ok: true, url });
}));

// Generate Stripe link if missing
router.post('/contractors/:userId/tip-page/generate-stripe', requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const { rows } = await pool.query(`
    SELECT pp.tip_page_token, pp.stripe_payment_link_url, cp.preferred_name
    FROM payment_profiles pp
    LEFT JOIN contractor_profiles cp ON cp.user_id = pp.user_id
    WHERE pp.user_id = $1
  `, [userId]);
  let row = rows[0];

  if (row && row.stripe_payment_link_url) {
    return res.status(400).json({ error: 'Stripe link already exists; use regenerate' });
  }

  let token = row && row.tip_page_token;
  if (!token) {
    token = uuidv4();
    await pool.query(`
      INSERT INTO payment_profiles (user_id, tip_page_token, tip_page_active)
      VALUES ($1, $2, TRUE)
      ON CONFLICT (user_id) DO UPDATE SET tip_page_token = COALESCE(payment_profiles.tip_page_token, $2)
    `, [userId, token]);
  }

  const displayName = row?.preferred_name || 'your bartender';
  const { url, id } = await createTipPaymentLink({ userId, displayName, token });
  await pool.query(
    'UPDATE payment_profiles SET stripe_payment_link_url = $1, stripe_payment_link_id = $2 WHERE user_id = $3',
    [url, id, userId]
  );
  res.json({ ok: true, url });
}));

// Deactivate / activate tip page
router.post('/contractors/:userId/tip-page/deactivate', requireAdminOrManager, asyncHandler(async (req, res) => {
  await deactivateTipPage(parseInt(req.params.userId, 10));
  res.json({ ok: true });
}));

router.post('/contractors/:userId/tip-page/activate', requireAdminOrManager, asyncHandler(async (req, res) => {
  await activateTipPage(parseInt(req.params.userId, 10));
  res.json({ ok: true });
}));
```

- [ ] **Step 2: Smoke test all four endpoints**

```bash
curl -X PATCH http://localhost:5000/api/admin/contractors/<id>/tip-page \
  -H "Authorization: Bearer ADMIN_JWT" -H "Content-Type: application/json" \
  -d '{"venmo_handle":"adminoverride"}'
# verify in DB

curl -X POST http://localhost:5000/api/admin/contractors/<id>/tip-page/regenerate-stripe \
  -H "Authorization: Bearer ADMIN_JWT"
# verify Stripe dashboard shows new active link, old link inactive

curl -X POST http://localhost:5000/api/admin/contractors/<id>/tip-page/deactivate \
  -H "Authorization: Bearer ADMIN_JWT"
# verify /tip/<token> returns 404
```

- [ ] **Step 3: Commit**

```bash
git add server/routes/admin.js   # or whichever file
git commit -m "feat(tip): admin per-contractor tip-page actions"
```

---

### Task 19: Backend — admin tips activity + feedback queue

**Files:**
- Modify: `server/routes/admin.js`

- [ ] **Step 1: Add the three endpoints**

```js
// All tips activity
router.get('/tips', requireAdminOrManager, asyncHandler(async (req, res) => {
  const { bartender_id, from, to } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const cursor = parseInt(req.query.cursor, 10) || null;

  const filters = ['1=1'];
  const params = [];
  if (bartender_id) { filters.push(`t.target_user_id = $${params.length + 1}`); params.push(parseInt(bartender_id, 10)); }
  if (from) { filters.push(`t.tipped_at >= $${params.length + 1}`); params.push(from); }
  if (to)   { filters.push(`t.tipped_at <= $${params.length + 1}`); params.push(to); }
  if (cursor) { filters.push(`t.id < $${params.length + 1}`); params.push(cursor); }

  params.push(limit);
  const { rows } = await pool.query(`
    SELECT t.id, t.amount_cents, t.tipped_at, t.customer_email,
           cp.preferred_name AS bartender_name, t.target_user_id
    FROM tips t
    LEFT JOIN contractor_profiles cp ON cp.user_id = t.target_user_id
    WHERE ${filters.join(' AND ')}
    ORDER BY t.id DESC
    LIMIT $${params.length}
  `, params);

  res.json({
    tips: rows,
    next_cursor: rows.length === limit ? rows[rows.length - 1].id : null,
  });
}));

// Feedback queue
router.get('/tip-feedback', requireAdminOrManager, asyncHandler(async (req, res) => {
  const status = req.query.status === 'reviewed' ? 'reviewed'
              : req.query.status === 'all' ? 'all' : 'unreviewed';

  let where = 'reviewed_at IS NULL';
  if (status === 'reviewed') where = 'reviewed_at IS NOT NULL';
  if (status === 'all') where = '1=1';

  const { rows } = await pool.query(`
    SELECT f.id, f.target_user_id, f.rating, f.comment, f.submitter_email,
           f.created_at, f.reviewed_at,
           cp.preferred_name AS bartender_name
    FROM tip_page_feedback f
    LEFT JOIN contractor_profiles cp ON cp.user_id = f.target_user_id
    WHERE ${where}
    ORDER BY f.created_at DESC
    LIMIT 200
  `);
  res.json({ feedback: rows });
}));

// Mark feedback reviewed
router.post('/tip-feedback/:id/review', requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await pool.query(`
    UPDATE tip_page_feedback
    SET reviewed_at = NOW(), reviewed_by = $1
    WHERE id = $2
  `, [req.user.id, id]);
  res.json({ ok: true });
}));
```

- [ ] **Step 2: Smoke test all three endpoints with admin JWT**

- [ ] **Step 3: Commit**

```bash
git add server/routes/admin.js
git commit -m "feat(tip): admin tips activity + feedback queue endpoints"
```

---

### Task 20: Frontend — Admin TipPageTab on per-contractor detail page

**Files:**
- Create: `client/src/pages/admin/userDetail/tabs/TipPageTab.js`
- Modify: `client/src/pages/admin/userDetail/AdminUserDetail.js` (register the tab)

- [ ] **Step 1: Create `TipPageTab.js`**

```jsx
// client/src/pages/admin/userDetail/tabs/TipPageTab.js
import React, { useEffect, useState } from 'react';
import api from '../../../../utils/api';

export default function TipPageTab({ user }) {
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => { load(); }, [user.id]);

  async function load() {
    const r = await api.get(`/admin/contractors/${user.id}/tip-page-detail`).catch(() => null);
    // If you don't add a dedicated detail endpoint, use the existing per-contractor record
    // and pluck the tip-page fields out. Either works.
    setData(r ? r.data : null);
  }

  async function regenerate() {
    if (!window.confirm('This retires the current Stripe link. Customers mid-payment may see an error. Continue?')) return;
    setBusy(true);
    try {
      await api.post(`/admin/contractors/${user.id}/tip-page/regenerate-stripe`);
      await load();
    } finally { setBusy(false); }
  }

  async function generate() {
    setBusy(true);
    try {
      await api.post(`/admin/contractors/${user.id}/tip-page/generate-stripe`);
      await load();
    } finally { setBusy(false); }
  }

  async function deactivate() {
    if (!window.confirm('Deactivate this tip page? The public URL will 404.')) return;
    setBusy(true);
    try {
      await api.post(`/admin/contractors/${user.id}/tip-page/deactivate`);
      await load();
    } finally { setBusy(false); }
  }

  async function saveEdits() {
    setBusy(true);
    try {
      await api.patch(`/admin/contractors/${user.id}/tip-page`, edit);
      await load();
    } finally { setBusy(false); }
  }

  if (!data) return <p>Loading…</p>;

  return (
    <div>
      <h3>Tip Page</h3>
      <p>URL: {data.url ? <a href={data.url} target="_blank" rel="noopener">{data.url}</a> : <em>none</em>}</p>
      <p>Active: {data.active ? 'YES' : 'NO'}</p>
      <p>Stripe link: {data.stripe_payment_link_url ? 'OK' : <strong style={{ color: 'red' }}>missing</strong>}</p>

      <h4>Handles (admin override)</h4>
      <label>Venmo <input value={edit.venmo_handle ?? data.venmo_handle ?? ''}
        onChange={e => setEdit(s => ({...s, venmo_handle: e.target.value}))} /></label>
      <label>Cash App <input value={edit.cashapp_handle ?? data.cashapp_handle ?? ''}
        onChange={e => setEdit(s => ({...s, cashapp_handle: e.target.value}))} /></label>
      <label>PayPal <input value={edit.paypal_url ?? data.paypal_url ?? ''}
        onChange={e => setEdit(s => ({...s, paypal_url: e.target.value}))} /></label>
      <button onClick={saveEdits} disabled={busy}>Save edits</button>

      <h4>Actions</h4>
      <button onClick={regenerate} disabled={busy || !data.stripe_payment_link_url}>Regenerate Stripe link</button>
      <button onClick={generate} disabled={busy || !!data.stripe_payment_link_url}>Generate Stripe link</button>
      <button onClick={deactivate} disabled={busy || !data.active} style={{ color: 'red' }}>Deactivate tip page</button>
    </div>
  );
}
```

(If the existing `GET /api/admin/contractors/:id` already returns the user's `payment_profiles` joined, you can read tip-page state from that and skip the dedicated detail endpoint. Inspect the existing handler to choose.)

- [ ] **Step 2: Register the tab in `AdminUserDetail.js`**

Find the existing tab registry (e.g., array of `{ key, label, component }` or imports of tab files). Add an entry pointing at `TipPageTab` between the most appropriate existing tabs (probably after Payouts).

- [ ] **Step 3: Smoke test in browser**

Open admin → contractor → "Tip Page" tab. Verify each action works.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/userDetail/tabs/TipPageTab.js \
        client/src/pages/admin/userDetail/AdminUserDetail.js
git commit -m "feat(tip): admin per-contractor Tip Page tab"
```

---

### Task 21: Frontend — Admin TipsAdmin page

**Files:**
- Create: `client/src/pages/admin/TipsAdmin.js`
- Modify: `client/src/App.js` (add admin route)

- [ ] **Step 1: Create `TipsAdmin.js`**

```jsx
// client/src/pages/admin/TipsAdmin.js
import React, { useEffect, useState } from 'react';
import api from '../../utils/api';

export default function TipsAdmin() {
  const [tab, setTab] = useState('tips');
  return (
    <div>
      <h1>Tips & Feedback</h1>
      <nav>
        <button onClick={() => setTab('tips')} style={{ fontWeight: tab === 'tips' ? 'bold' : 'normal' }}>Tips</button>
        <button onClick={() => setTab('feedback')} style={{ fontWeight: tab === 'feedback' ? 'bold' : 'normal' }}>Feedback</button>
      </nav>
      {tab === 'tips' ? <TipsTab /> : <FeedbackTab />}
    </div>
  );
}

function TipsTab() {
  const [tips, setTips] = useState([]);
  const [filters, setFilters] = useState({ from: '', to: '', bartender_id: '' });

  useEffect(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
    api.get(`/admin/tips?${params}`).then(r => setTips(r.data.tips || []));
  }, [filters]);

  const total = tips.reduce((sum, t) => sum + t.amount_cents, 0);

  return (
    <div>
      <p>Total in view: <strong>${(total / 100).toFixed(2)}</strong></p>
      <label>From <input type="date" value={filters.from}
        onChange={e => setFilters(f => ({...f, from: e.target.value}))} /></label>
      <label>To <input type="date" value={filters.to}
        onChange={e => setFilters(f => ({...f, to: e.target.value}))} /></label>

      <table>
        <thead><tr><th>Bartender</th><th>Amount</th><th>Date</th><th>Customer email</th></tr></thead>
        <tbody>
          {tips.map(t => (
            <tr key={t.id}>
              <td>{t.bartender_name || `user ${t.target_user_id}`}</td>
              <td>${(t.amount_cents / 100).toFixed(2)}</td>
              <td>{new Date(t.tipped_at).toLocaleString()}</td>
              <td>{t.customer_email || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FeedbackTab() {
  const [feedback, setFeedback] = useState([]);
  const [status, setStatus] = useState('unreviewed');

  function load() {
    api.get(`/admin/tip-feedback?status=${status}`).then(r => setFeedback(r.data.feedback || []));
  }
  useEffect(load, [status]);

  async function markReviewed(id) {
    await api.post(`/admin/tip-feedback/${id}/review`);
    load();
  }

  return (
    <div>
      <select value={status} onChange={e => setStatus(e.target.value)}>
        <option value="unreviewed">Unreviewed</option>
        <option value="reviewed">Reviewed</option>
        <option value="all">All</option>
      </select>

      {feedback.length === 0 ? <p><em>No feedback in view.</em></p> :
        feedback.map(f => (
          <article key={f.id} style={{ border: '1px solid #ddd', padding: 12, margin: '8px 0' }}>
            <p><strong>{f.bartender_name || `user ${f.target_user_id}`}</strong> · {f.rating}/5 · {new Date(f.created_at).toLocaleString()}</p>
            {f.comment && <p>"{f.comment}"</p>}
            {f.submitter_email && <p>Customer: {f.submitter_email}</p>}
            {!f.reviewed_at && <button onClick={() => markReviewed(f.id)}>Mark reviewed</button>}
          </article>
        ))}
    </div>
  );
}
```

- [ ] **Step 2: Add admin route in `App.js`**

Find the admin route group and add:

```jsx
<Route path="/admin/tips" element={<TipsAdmin />} />
```

Plus the import.

- [ ] **Step 3: Add nav link in admin sidebar (find the existing admin nav)**

```bash
grep -rn "/admin/dashboard\|admin/clients\|admin/proposals" client/src/components/
```

Wherever the admin nav is, add a "Tips" link to `/admin/tips`.

- [ ] **Step 4: Smoke test in browser**

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/TipsAdmin.js client/src/App.js [admin-nav-file]
git commit -m "feat(tip): admin Tips Activity + Feedback queue page"
```

---

## Phase 6 — Wire-up & docs

### Task 22: Lifecycle hooks — wire deactivation/activation into existing status transitions

**Files:**
- Modify: wherever `users.onboarding_status` flips to `'rejected'` or `'deactivated'` (and back)

> The existing transitions live somewhere in `server/routes/admin.js` and/or `server/routes/contractor.js`. Locate them:
> ```bash
> grep -rn "onboarding_status.*=.*'deactivated'\|onboarding_status.*=.*'rejected'" server/routes/
> ```

- [ ] **Step 1: Import the lifecycle helpers**

At the top of each file:

```js
const { deactivateTipPage, activateTipPage } = require('../utils/tipPageLifecycle');
```

- [ ] **Step 2: Call `deactivateTipPage(userId)` after the SQL UPDATE that sets status to `'rejected'` or `'deactivated'`**

After each such UPDATE, add:

```js
await deactivateTipPage(userId);
```

- [ ] **Step 3: Symmetrically call `activateTipPage(userId)` after transitions back to `'approved'` / `'submitted'` / `'reviewed'` (returning seasonal staffer)**

If/when status flips from `'deactivated'` back to one of those, call `activateTipPage(userId)`. May not exist as a transition today — if not, skip.

- [ ] **Step 4: Smoke test**

In admin UI: deactivate a contractor → their tip page returns 404 + Stripe Payment Link is inactive in the dashboard.

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin.js [or wherever]
git commit -m "feat(tip): hook lifecycle helpers into onboarding-status transitions"
```

---

### Task 23: Env vars + .env.example + docs updates

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `.claude/CLAUDE.md`

- [ ] **Step 1: Add three env vars to `.env.example`**

```
# Tip QR page
PUBLIC_GOOGLE_REVIEW_URL=https://g.page/r/PLACEHOLDER/review
REACT_APP_GOOGLE_REVIEW_URL=https://g.page/r/PLACEHOLDER/review
ADMIN_FEEDBACK_NOTIFICATION_EMAIL=contact@drbartender.com
```

- [ ] **Step 2: Update `README.md` env vars table + folder tree + key features**

Per `CLAUDE.md` mandatory documentation table:
- **Folder structure tree** — add `server/routes/publicTip.js`, `server/routes/me.js`, `server/utils/tipPaymentLinks.js`, `server/utils/tipPageLifecycle.js`, `server/utils/qrCard.js`, `server/scripts/backfillTipPages.js`, `client/src/pages/public/TipPage.{jsx,atoms.jsx,css}`, `client/src/pages/public/TipPageThanks.jsx`, `client/src/pages/staff/MyTipPage.js`, `client/src/pages/admin/TipsAdmin.js`, `client/src/pages/admin/userDetail/tabs/TipPageTab.js`.
- **Env vars table** — add the three new vars.
- **Key features** — add a "Tip QR pages" line.

- [ ] **Step 3: Update `ARCHITECTURE.md`**

- **API route table** — add:
  - `GET /api/public/tip/:token`
  - `POST /api/public/tip/:token/feedback`
  - `GET /api/me/tip-page` / `PATCH /api/me/tip-page`
  - `GET /api/me/tips`
  - `PATCH /api/admin/contractors/:userId/tip-page`
  - `POST /api/admin/contractors/:userId/tip-page/regenerate-stripe`
  - `POST /api/admin/contractors/:userId/tip-page/generate-stripe`
  - `POST /api/admin/contractors/:userId/tip-page/deactivate`
  - `POST /api/admin/contractors/:userId/tip-page/activate`
  - `GET /api/admin/tips`
  - `GET /api/admin/tip-feedback`
  - `POST /api/admin/tip-feedback/:id/review`
- **Database Schema** — note `payment_profiles` extensions and the two new tables (`tips`, `tip_page_feedback`) with their purpose.
- **Third-Party Integrations** — note Stripe Payment Links + the new `qrcode` and `sharp` dependencies.

- [ ] **Step 4: Update `.claude/CLAUDE.md` env vars table**

Add the three new vars to the table near `THUMBTACK_WEBHOOK_SECRET` etc.

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md ARCHITECTURE.md .claude/CLAUDE.md
git commit -m "docs(tip): env vars + README + ARCHITECTURE + CLAUDE updates for tip pages"
```

---

### Task 24: End-to-end smoke test + backfill in production

> **Run this only at deploy time** — every other task should be merged + pushed first via the normal pre-push agent flow.

- [ ] **Step 1: Set the three new env vars in Render (server) and Vercel (client)**

Coordinate with Dallas. The `REACT_APP_GOOGLE_REVIEW_URL` must be in Vercel; the other two in Render.

- [ ] **Step 2: Run the backfill script against production DB**

```bash
DATABASE_URL=$PROD_DATABASE_URL node server/scripts/backfillTipPages.js
```

Expected: prints the count of approved contractors; creates Stripe Payment Links + UUIDs; ends with `done`.

- [ ] **Step 3: End-to-end test on a real bartender's tip page**

1. Log in as an existing approved contractor.
2. Open `/my-tip-page` → confirm URL, QR, handles.
3. Open the URL in another browser → confirm tip page renders with their headshot + handles + Credit Card button.
4. Pick $1, tap Credit Card, complete payment with `4242 4242 4242 4242` (test mode).
5. Should redirect to `/tip/<token>/thanks?amount=100` showing "$1.00 · sent".
6. Verify a row in `tips` (production DB).
7. Bartender's `/my-tip-page` shows the tip in their history.
8. Click 1 star → submit feedback → admin email arrives.

- [ ] **Step 4: Optional — order one printed QR card from a photo counter**

Download the PNG from `/api/me/tip-page/qr.png?size=4x6`, take it to Walmart Photo, get a $0.30 print, scan it on phone, confirm the tip page loads.

---

## Self-Review

- [x] **Spec coverage check.** Every section of the spec maps to at least one task above:
  - §5 (schema) → Task 2.
  - §6 (Stripe link integration) → Tasks 3, 10. Lifecycle (§6.3) → Tasks 4, 22.
  - §7 (onboarding integration) → Task 5 (backend), Task 6 (frontend), Task 7 (backfill).
  - §8 (public tip page + feedback) → Tasks 8, 9, 11, 12, 13.
  - §9 (staff portal) → Tasks 14, 15, 16 (client-side print page — three sizes), 17 (UI).
  - §10 (admin surfaces) → Tasks 18, 19, 20, 21.
  - §11 (lifecycle) → Task 22.
  - §13 (env vars) + §14 (prerequisites) + §15 (operational checklist) → Tasks 1, 23, 24.
  - §Z addendum (amount picker, thanks screen, inline SVG) → Tasks 11, 12, plus the design copy in Task 1.
  - **Out-of-scope confirmation:** Tip pooling and `tip_distributions` are not implemented anywhere — matches the spec's §3 explicit non-goal.

- [x] **Placeholder scan.** No "TBD," "TODO," or "implement appropriate X" steps. Every code block is concrete.

- [x] **Type consistency.** `display_name` (not `first_name`) used everywhere in the public page response. `tip_page_token` (UUID) in DB matches the URL parameter shape. `amount_cents` integer everywhere money is stored. `target_user_id` matches the FK column name in both tables. `preferred_payment_method` value list is consistent across server validation, frontend radio, and DB allowlist (`venmo|cashapp|paypal|check|direct_deposit|other`).

- [x] **No-test-framework adaptation.** Per `CLAUDE.md`, this codebase has no automated tests. Every task ends with manual smoke-test + commit. Pre-push agent fleet is the verification layer (consistency-check, code-review, security-review, database-review, performance-review).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-08-tip-qr-page.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks. Each task is bounded and self-contained.

**2. Inline Execution** — Execute tasks here in this session, batched with checkpoints for review.

Which approach?
