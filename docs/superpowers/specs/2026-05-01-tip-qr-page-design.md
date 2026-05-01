# Tip QR page — design spec

**Date:** 2026-05-01
**Author:** Dallas (with Claude)
**Status:** Approved for implementation planning
**Replaces:** Wix-hosted tip page (`temp/tip qr wix.txt`) — a single hardcoded page for one bartender (Kaitlyn) with personal Venmo / Cash App / PayPal / Stripe Payment Link buttons and a 5-star rating that gates Google Reviews vs. internal feedback.

---

## 1. Summary

Replace the existing single-bartender Wix tip page with a per-bartender feature in DRB OS. Every approved staff contractor gets their own public tip page at `https://drbartender.com/tip/<token>`, surfaced via a downloadable photo-print QR code. The page shows the bartender's preferred name + headshot, their personal Venmo / Cash App / PayPal handles (links out to those apps), and a "Credit Card" button that points at a DRB-managed Stripe Payment Link auto-generated for that bartender. A 5-star rating routes 4-5 stars to a single company Google Review URL and 1-3 stars to an internal feedback form that emails the admin.

Stripe tips are ingested via `checkout.session.completed` webhook into a new `tips` table, attributed to the *target* bartender (whose QR was scanned). The bartender sees their tip total in the staff portal with copy that's honest about what's still landing in payroll.

Tip *pooling* across co-workers at the same event, automatic *payout integration*, and Tap-to-Pay integration are explicitly **out of scope** for this project — they are separate brainstorms.

---

## 2. Background & motivation

Currently DRB has one Wix-hosted tip page hardcoded to one bartender's payment handles. It works, but:

- Doesn't scale — every new staff hire would need a hand-built copy.
- DRB has no visibility into Stripe tip volume — tips arrive in DRB's Stripe account but aren't attributed to who earned them in DRB OS.
- Customers can't tell whose page they're on (no name or photo) — a problem at events with multiple bartenders working.
- The Wix page is outside DRB OS's domain (drbartender.com vs. wix-hosted), which fragments the brand surface.

This project lifts the page into DRB OS, makes it per-bartender, ties Stripe tips to the bartender's record, and sets the table for a future tip-pooling / payroll feature without committing to it now.

---

## 3. Goals & non-goals

### In scope
- Per-bartender public tip page at `drbartender.com/tip/<token>`.
- Onboarding step that collects payment handles + payroll preference + preferred display name.
- Auto-generated Stripe Payment Link per bartender (created in DRB's Stripe account, tagged with metadata).
- Self-service downloadable photo-print QR code (4x6 + 5x7 PNG) in the staff portal.
- Stripe webhook ingestion of tip payments → new `tips` table (per-bartender, no pooling math).
- Staff portal "My Tip Page" view: URL, QR, editable handles, recent tips list.
- Admin surfaces: per-contractor tip-page panel, tip activity dashboard, feedback queue.
- 5-star rating: 4-5★ → company Google Review URL; 1-3★ → internal `tip_page_feedback` table + email to admin.
- Lifecycle: deactivate the public page + Stripe Payment Link when staff is rejected or deactivated; reversible.

### Out of scope (separate projects)
- **Tip pooling math** — splitting tips across co-workers at the same event. This spec records the *target* bartender only. A follow-up spec will add `tip_distributions` and the pooling rules.
- **Auto payroll integration** — `tips` rows are not yet linked to `payouts`. Reconciliation is manual for now.
- **Tap-to-Pay** — different in-person Stripe surface; out of scope here.
- **Admin-printed photo cards (mail-out)** — bartenders self-print at the photo counter for MVP.
- **Per-event shared QR** — every QR is per-bartender. No team-up flow.
- **Per-bartender Google review URLs** — single company URL for all bartenders.

---

## 4. Design overview & data flow

```
[Staff completes onboarding]
        │
        ▼
[onboarding_status → 'submitted']  ──── triggers ───▶  [Stripe Payment Link API]
        │                                                       │
        │                                                       ▼
        │                                            link.id, link.url returned
        ▼                                                       │
[payment_profiles row populated]   ◀──────────────────────────────┘
   - tip_page_token (UUID)
   - stripe_payment_link_url
   - stripe_payment_link_id
   - venmo_handle, cashapp_handle, paypal_url
   - preferred_payment_method (payroll preference)
   - tip_page_active = TRUE

[Staff portal: My Tip Page]
   - shows URL, QR (4x6/5x7 download)
   - edit personal handles + preferred name
   - tip history with caveat copy

[Customer scans QR]
        │
        ▼
[GET /tip/<token>]  ──fetches──▶  [GET /api/public/tip/:token]
                                          │
                                          ▼
                                    {display_name, headshot_url,
                                     venmo, cashapp, paypal, stripe_link}

[Customer taps "Credit Card"]
        │
        ▼
[Stripe Payment Link]  ──pays──▶  [Stripe checkout]
                                          │
                                          ▼
                              [checkout.session.completed webhook]
                                          │
                                          ▼
                              [INSERT into tips table]
                                          │
                                          ▼
                              [Bartender sees in staff portal]

[Customer rates 1-3★]
        │
        ▼
[POST /api/public/tip/:token/feedback]
        │
        ├──▶  [INSERT into tip_page_feedback]
        │
        └──▶  [Resend email to admin]

[Customer rates 4-5★]
        │
        ▼
[client redirects to PUBLIC_GOOGLE_REVIEW_URL]
```

---

## 5. Schema changes

Three slices: extend `payment_profiles`, create `tips`, create `tip_page_feedback`.

### 5.1. Extend `payment_profiles`

`payment_profiles` is the right home — it already holds `preferred_payment_method`, `payment_username`, `routing_number`, `account_number`, `w9_file_url` per user. The new handle columns sit alongside the existing payment fields for cohesion. (The repo's `encryption.js` helper for bank PII applies to `routing_number` / `account_number` per CLAUDE.md; the new payment-handle columns added by this spec are not bank-PII grade — handles like `kaitlynmfmt` are public information by their nature.)

Idempotent `ADD COLUMN IF NOT EXISTS`:

| Column | Type | Notes |
|---|---|---|
| `venmo_handle` | TEXT | e.g. `kaitlyn-marie-43`. Stored without leading `@` or URL prefix. |
| `cashapp_handle` | TEXT | e.g. `kaitlynmfmt`. Stored without leading `$`. |
| `paypal_url` | TEXT | full `paypal.me/...` URL (matches Wix shape; PayPal handle alone isn't enough — PayPal.me is a URL). |
| `stripe_payment_link_url` | TEXT | full `buy.stripe.com/...` URL. |
| `stripe_payment_link_id` | TEXT | Stripe's `plink_xxx` ID — needed for deactivation API call. |
| `tip_page_token` | UUID | UNIQUE. Generated server-side at onboarding completion. Public URL key. |
| `tip_page_active` | BOOLEAN | DEFAULT TRUE. Lifecycle toggle. |

`preferred_payment_method` already exists. It becomes the canonical payroll preference. Values normalize to: `'venmo' | 'cashapp' | 'paypal' | 'check' | 'direct_deposit' | 'other'`. If the existing values are not in this set, the implementation plan must include a one-time normalization step.

`payment_username` already exists as a single generic-handle field. Leave it in place for now — it is superseded by the four specific columns above. Backfill / migration is a follow-up.

Index:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_profiles_tip_page_token
  ON payment_profiles(tip_page_token) WHERE tip_page_token IS NOT NULL;
```

### 5.2. New `tips` table

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
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tips_target_user_tipped_at
  ON tips(target_user_id, tipped_at DESC);
```

`stripe_payment_intent_id UNIQUE` makes the webhook idempotent — Stripe's at-least-once delivery means we may see the same event twice; the second insert no-ops.

`tip_page_token` is denormalized from `payment_profiles` for query convenience and audit (in case a bartender's token is regenerated, the tip row records the token that was scanned at the moment of payment).

`customer_email` is PII (matches CLAUDE.md money/PII rules) — admin-only access, never exposed in any public API response.

### 5.3. New `tip_page_feedback` table

```sql
CREATE TABLE IF NOT EXISTS tip_page_feedback (
  id SERIAL PRIMARY KEY,
  target_user_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 3),
  comment TEXT,
  submitter_email TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tip_feedback_target_user_created_at
  ON tip_page_feedback(target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tip_feedback_unreviewed
  ON tip_page_feedback(created_at DESC) WHERE reviewed_at IS NULL;
```

`submitter_email` is PII — admin-only access.

---

## 6. Stripe Payment Link integration

### 6.1. Creation

New helper: `server/utils/tipPaymentLinks.js`. Single exported function `createTipPaymentLink({ userId, firstName, token })` that calls Stripe and returns `{ url, id }`.

```js
const link = await stripe.paymentLinks.create({
  line_items: [{
    price_data: {
      currency: 'usd',
      product_data: { name: `Tip for ${firstName}` },
      custom_unit_amount: { enabled: true, minimum: 100 }, // $1+
    },
    quantity: 1,
  }],
  metadata: {
    kind: 'tip',
    bartender_user_id: String(userId),
    tip_page_token: token,
  },
  payment_intent_data: {
    metadata: {                      // mirror — required for webhook to see metadata
      kind: 'tip',
      bartender_user_id: String(userId),
      tip_page_token: token,
    },
    description: `Tip for ${firstName} via DRB tip page`,
  },
  after_completion: {
    type: 'redirect',
    redirect: { url: `${PUBLIC_SITE_URL}/tip/${token}/thanks` },
  },
});
```

Notes:
- `custom_unit_amount` makes the link pay-what-you-want.
- `payment_intent_data.metadata` MUST be set; Payment Link metadata does not propagate to the resulting PaymentIntent automatically.
- Uses `stripeClient.js` (per CLAUDE.md), which honors `STRIPE_TEST_MODE_UNTIL` and fails closed if creds missing.
- Currency hardcoded `usd`. Internationalization is out of scope.

### 6.2. Webhook ingestion

Extend the existing handler in `server/routes/stripe.js`. Add a case for `checkout.session.completed`:

```js
case 'checkout.session.completed': {
  const session = event.data.object;
  if (session.metadata?.kind !== 'tip') break;

  const targetUserId = parseInt(session.metadata.bartender_user_id, 10);
  const token = session.metadata.tip_page_token;
  const piId = session.payment_intent;

  await pool.query(`
    INSERT INTO tips (tip_page_token, target_user_id, amount_cents,
                      stripe_payment_intent_id, stripe_session_id,
                      customer_email, tipped_at)
    VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))
    ON CONFLICT (stripe_payment_intent_id) DO NOTHING
  `, [token, targetUserId, session.amount_total, piId, session.id,
      session.customer_details?.email ?? null, session.created]);
  break;
}
```

We listen on `checkout.session.completed` rather than `payment_intent.succeeded` because the session object cleanly carries `customer_details.email` and our metadata.

Idempotent on `stripe_payment_intent_id` — at-least-once delivery is safe.

### 6.3. Lifecycle

- **Deactivation** (when `onboarding_status` → `'rejected'` or `'deactivated'`):
  ```js
  await stripe.paymentLinks.update(linkId, { active: false });
  ```
  Old QR cards in the wild that someone scans will see Stripe's "no longer accepting payments" page rather than completing a payment to a deactivated staffer.

- **Reactivation** (e.g., returning seasonal staffer):
  - If the Payment Link still exists in Stripe: `paymentLinks.update(linkId, { active: true })`.
  - If it's been deleted: regenerate a new one.

- **Regeneration** (preferred name change, manual admin action):
  - Deactivate old link.
  - Create new link with current `firstName` in `product_data.name`.
  - Update `stripe_payment_link_url` + `stripe_payment_link_id` on the row.
  - **Preserve `tip_page_token`** so existing QR cards keep routing to the same DRB-OS page.
  - Admin-only action, gated behind a confirmation dialog: *"This will retire the current Stripe link. Customers mid-payment may see an error. Continue?"*

---

## 7. Onboarding integration

Add a "Tip & Payroll Preferences" fieldset to the existing contractor onboarding form (the step that collects personal info — `phone`, `headshot`, etc.). Same form, new fieldset; not a separate step.

### 7.1. Helper copy (above the fields)

> *Your tip page lives at drbartender.com/tip/your-name. We'll generate a QR you can print at any photo counter. We pay you out via the handle you pick below — the others just show up on your tip page so customers can pick what they prefer.*
>
> *None of this is shared with anyone outside DRB.*

### 7.2. Form fields

| Field | Required | Notes |
|---|---|---|
| `preferred_name` | required | The display name on the tip page. Free-form text. Can be a nickname, pseudonym, stage name. Editable post-onboarding. |
| `venmo_handle` | optional | Strip leading `@`, `venmo.com/u/`. |
| `cashapp_handle` | optional | Strip leading `$`. |
| `paypal_url` | optional | Accept `paypal.me/x` or full URL. |
| `preferred_payment_method` | required | Radio: Venmo / Cash App / PayPal / Check / Direct deposit / Other. Drives DRB's payroll pipeline. |

### 7.3. Validation

**Method-specific handle requirements** (so we always have a way to pay them via the method they picked):

- `preferred_payment_method = 'venmo'` → `venmo_handle` required
- `preferred_payment_method = 'cashapp'` → `cashapp_handle` required
- `preferred_payment_method = 'paypal'` → `paypal_url` required
- `preferred_payment_method = 'direct_deposit'` → `routing_number` + `account_number` on `payment_profiles` required (existing payroll flow)
- `preferred_payment_method = 'check'` or `'other'` → no specific handle required (mailing/checks/etc. handled out-of-band)

**Tip-page handles are otherwise optional.** A bartender can leave all three of Venmo / Cash App / PayPal blank if they want — their tip page will show only the Credit Card (Stripe) button, which is fine. The tip page is always at least "tip via Stripe" because the Stripe Payment Link is auto-generated.

**Other rules:**
- `preferred_name` cannot be blank or all-whitespace; trimmed before save.
- The Stripe Payment Link is NOT a form field — it is auto-generated. It does not appear in the onboarding UI at all.

### 7.4. Stripe Payment Link auto-generation

Trigger fires when the staffer **completes the onboarding form** — i.e., the transition `onboarding_status` → `'submitted'`. Server-side helper called from the onboarding submit route:

1. **Upsert** the `payment_profiles` row for the user (the row may not exist yet — create with `INSERT ... ON CONFLICT (user_id) DO UPDATE`). Persist all form fields the staffer just submitted.
2. Generate `tip_page_token` (UUID v4) if the row doesn't already have one.
3. Call `createTipPaymentLink({ userId, firstName: preferred_name, token })`.
4. `UPDATE payment_profiles SET tip_page_token, stripe_payment_link_url, stripe_payment_link_id, tip_page_active = TRUE WHERE user_id = $1`.
5. On Stripe API failure: log + Sentry, leave token-less; admin sees a "Generate Stripe link" button on the contractor's record to retry. **Do not block the onboarding submission.**

Rationale for `'submitted'` rather than `'approved'`: the staffer's tip page goes live the moment they finish their onboarding form, so they can start earning tips immediately. If they later get `'rejected'`, the deactivation flow (Section 6.3) retires the link and 404s the page.

### 7.5. Backfill for current staff

Standalone script: `server/scripts/backfillTipPages.js`. For each `payment_profiles` row where `tip_page_token IS NULL` and the user's `onboarding_status IN ('submitted', 'reviewed', 'approved', 'hired')`, run the same helper. Idempotent (skips rows that already have a token). Run once after deploy.

The user has indicated some current staff already have payment handles collected. The script does NOT overwrite existing handle data — only fills in `tip_page_token` + Stripe link for rows that don't have them.

---

## 8. Public tip page

### 8.1. Route

Public:
- `GET /tip/:token` → `client/src/pages/public/TipPage.jsx`. Token is a UUID (existing public-token pattern matches `/proposal/:token` and `/plan/:token`).
- `GET /tip/:token/thanks` → simple thank-you page (Stripe redirect target after successful payment).

Server:
- `GET /api/public/tip/:token` → `server/routes/publicTip.js` (new). Returns display data only.
- `POST /api/public/tip/:token/feedback` → submit 1-3★ rating.

Token validated with the existing `UUID_RE` regex. Rate-limited via existing `publicLimiter`. If `tip_page_active = false` OR token doesn't exist → 404.

### 8.2. Server response (allowlist)

```json
{
  "display_name": "Kaitlyn",
  "headshot_url": "https://r2.../...png",
  "venmo_handle": "kaitlyn-marie-43",
  "cashapp_handle": "kaitlynmfmt",
  "paypal_url": "https://www.paypal.me/kaitlynmfmt",
  "stripe_payment_link_url": "https://buy.stripe.com/..."
}
```

Never return `payment_username`, `routing_number`, `account_number`, `preferred_payment_method`, internal IDs, or any other column. Allowlist explicitly in the route.

### 8.3. Page sections (top to bottom)

1. **Hero** — illustration + "You're the Best ❤ Thanks for Tipping!" — same brand voice as Wix. (Visual treatment to be done by Claude Design.)
2. **"Tip [Display Name]"** — the bartender's preferred name + headshot, so the customer knows who they're tipping.
3. **"Choose a Payment Method"** — four buttons:
   - **Venmo** — `<a href="https://venmo.com/u/{venmo_handle}" target="_blank" rel="noopener">`
   - **Cash App** — `<a href="https://cash.app/${cashapp_handle}" target="_blank" rel="noopener">`
   - **Credit Card** — `<a href="{stripe_payment_link_url}" target="_blank" rel="noopener">` — labeled "Credit Card" (or "Card / Apple Pay / Google Pay") with Visa / Mastercard / Amex / Discover icons. **Never the word "Stripe."**
   - **PayPal** — `<a href="{paypal_url}" target="_blank" rel="noopener">`
   - **Hide buttons whose handle is empty.** If a bartender hasn't set up Cash App, the Cash App button doesn't render.
4. **"Leave Your Mark"** — 5-star rating section.
5. **Brand footer** — DRB logo, copyright, social links (Facebook / Instagram). Static; not bartender-specific.

### 8.4. Star rating behavior

- Stars 1-5, paint-on-hover, click selects.
- 4-5★ → `window.location = process.env.REACT_APP_GOOGLE_REVIEW_URL` (single company URL).
- 1-3★ → expand the inline feedback form (no nav away). Form has:
  - Comment textarea (optional, max 2000 chars)
  - Email input (optional, "We may follow up to make this right.")
  - Submit button.
- After submit: replace form with a thank-you confirmation. No edit-after-submit.

### 8.5. Feedback POST validation

- `rating` integer 1-3 (server-enforced; if client sends 4-5 → 400).
- `comment` ≤ 2000 chars; sanitized at render-time only (no HTML stored as-is).
- `email` if present, valid format.
- Rate-limit per token + IP: max 3 submissions / hour. Sentry alert if a single token exceeds 20 submissions / hour.
- Feedback row inserts even if admin email send fails — never lose the feedback.

### 8.6. Admin notification email

Sent via existing `server/utils/email.js`. Recipient: `ADMIN_FEEDBACK_NOTIFICATION_EMAIL` env var (defaults to `contact@drbartender.com`).

Subject: `1-star tip-page feedback for [Display Name]`

Body:
```
Rating: 1 / 5
Comment: "Drinks were too watered down."
Email: customer@example.com (if provided)

[Mark reviewed in admin →]
```

The "[Mark reviewed →]" link points at the admin feedback queue with the row pre-selected.

### 8.7. Button click behavior

The Wix script used `setTimeout(showThankYou, 800)` after redirecting to the payment app, which is janky. We do better: each button is `<a target="_blank" rel="noopener">` so the payment app opens in a new tab and the tip page stays put with a thank-you state ready on next interaction. No timeout hacks.

---

## 9. Staff portal: My Tip Page

Page: `client/src/pages/staff/MyTipPage.jsx`. Accessible from the staff portal nav. Five subsections, top to bottom:

### 9.1. URL + copy button

> Your tip page: `drbartender.com/tip/<token>` [Copy]

### 9.2. QR preview + download buttons

Server renders a print-ready PNG from a pre-designed SVG template (one for 4x6, one for 5x7) with the bartender's preferred name baked in + the QR composited at the right size.

- Endpoint: `GET /api/me/tip-page/qr.png?size=4x6` (or `5x7`). Returns `image/png` with `Cache-Control: private, max-age=3600`.
- Two download buttons — "Download 4x6 print" and "Download 5x7 print" — each hits the endpoint, browser saves the file.
- Filename: `drb-tip-card-<displayname-kebab>-4x6.png`.
- Inline preview shows the smaller (4x6) version.

Helper copy:
> *Take this PNG to any photo counter (Walmart, CVS, Walgreens) — same-day printing, ~$0.30. Stick it in a 4x6 frame at events.*

### 9.3. Edit my preferred name + handles

Form fields: `preferred_name`, Venmo, Cash App, PayPal, payroll preference. Same shape as the onboarding step (so a fresh hire can change their mind later). All five fields are user-owned.

**Read-only fields:**
- Stripe link — shows "Managed by DRB" with no edit. Admin can regenerate (Section 10).
- Tip page URL — copy-only.

**Save** → `PATCH /api/me/tip-page` → server allowlists fields the user can update. Any attempt to send `tip_page_token`, `tip_page_active`, `stripe_payment_link_url`, `stripe_payment_link_id` is silently ignored.

### 9.4. My tips

- List of recent tips received via the bartender's QR, paginated, newest first. Columns: amount, date, "via Stripe."
- Sum at top: *"Tips received via your QR this month: $X."*
- **Caveat copy directly under the sum** (truthful, doesn't promise pooling math we haven't built):
  > *These tips will be pooled with co-workers from each event and paid out via your next payroll. Final amount may differ from this total.*
- Endpoint: `GET /api/me/tips?cursor=...` returns rows from `tips WHERE target_user_id = req.user.id` only — IDOR-prevented.

### 9.5. Empty / partial states

- If `stripe_payment_link_url IS NULL` (Stripe API failed at onboarding): show *"Your Stripe link isn't ready yet. Contact admin to generate it."* Don't show the QR section — without the Stripe link, the QR is incomplete. Personal handles still editable.
- If no tips yet: show *"No tips yet. Print your QR and bring it to your next event."*

### 9.6. QR generation implementation

- npm: add `qrcode` (server-side QR generation, returns PNG buffer).
- For SVG → PNG compositing: use `sharp` if already in the project, otherwise `@napi-rs/canvas`. **Verify during planning** which is available; the repo has R2 image uploads but I haven't confirmed `sharp`.
- Two SVG templates live in `server/assets/tip-card-4x6.svg` and `server/assets/tip-card-5x7.svg`. **Designed by Claude Design** with placeholder rects for `{{qr}}` and `{{display_name}}` that the server fills.
- Cache the rendered PNG per (user_id, size) for 1 hour (in-memory or R2) — saves regeneration on every download click. Cache-bust when the user updates their preferred name or the Stripe link is regenerated.

---

## 10. Admin surfaces

### 10.1. Per-contractor tip-page panel

Extend the existing per-contractor admin page with a new "Tip Page" panel showing:

- Tip page URL (clickable).
- `tip_page_active` toggle.
- All four handles + payroll preference (editable).
- Stripe link URL (read-only).
- Stripe link ID (read-only).
- TEST MODE badge if `STRIPE_TEST_MODE_UNTIL` is in the future and the link was created during test mode.

Buttons:
- **Edit handles + preferred name** — admin can override any user-owned field. Useful when a bartender forgets, gives wrong info, or asks for a change via text.
- **Regenerate Stripe link** — deactivates the current Payment Link, creates a new one with current preferred name, updates the row. Preserves `tip_page_token`. Confirmation dialog: *"This will retire the current Stripe link. Customers mid-payment may see an error. Continue?"*
- **Generate Stripe link** (only when `stripe_payment_link_url IS NULL`) — for backfill and Stripe-API-failure recovery.
- **Deactivate tip page** — sets `tip_page_active = FALSE` + deactivates Stripe Payment Link. Public page returns 404. Reversible.

### 10.2. Tip activity dashboard

Page: `client/src/pages/admin/TipsAdmin.jsx`.

Tabs:
- **Tips** — table of all tips: bartender name, amount, date, source (Stripe), customer email if present.
  - Filters: bartender, date range. Default view: last 30 days.
  - Total at top: tips collected this month / last month.
  - Endpoint: `GET /api/admin/tips?bartender_id=&from=&to=&cursor=` — admin role required.
  - Read-only — no edits to tip rows from the UI. Stripe disputes / refunds happen in Stripe dashboard.
- **Feedback** — see 10.3.

### 10.3. Feedback queue

Same admin page, separate tab.

- Default view: unreviewed feedback (`reviewed_at IS NULL`), newest first.
- Each row: bartender, rating, comment preview, customer email, `[Mark reviewed]` button.
- "Mark reviewed" → `POST /api/admin/tip-feedback/:id/review` → sets `reviewed_at` + `reviewed_by`. Doesn't delete; visible in "All" tab if you want to look back.
- Endpoint: `GET /api/admin/tip-feedback?status=unreviewed`.

---

## 11. Lifecycle & deactivation

### 11.1. Status transitions

The existing transition that flips `onboarding_status` to `'rejected'` or `'deactivated'` calls a single helper:

```js
async function deactivateTipPage(userId) {
  const row = await pool.query('SELECT stripe_payment_link_id FROM payment_profiles WHERE user_id = $1', [userId]);
  if (row.rows[0]?.stripe_payment_link_id) {
    await stripe.paymentLinks.update(row.rows[0].stripe_payment_link_id, { active: false });
  }
  await pool.query('UPDATE payment_profiles SET tip_page_active = FALSE WHERE user_id = $1', [userId]);
}
```

Symmetrical helper `activateTipPage(userId)` flips `tip_page_active = TRUE` and reactivates (or regenerates) the Stripe link.

### 11.2. What persists

Historical `tips` rows and `tip_page_feedback` rows persist regardless of staff status — needed for tax records, payroll reconciliation, and historical audit. No cascade-delete on user deactivation.

### 11.3. Outstanding tips on departure

If a staff member is deactivated with tips in the `tips` table not yet reconciled to a payout, those tips are settled manually in the existing payroll process (out of scope for this project, per Section 3). The `tips` table makes them visible — no automation here yet.

---

## 12. Risks & open questions

### Risks
- **Test-mode badge.** While `STRIPE_TEST_MODE_UNTIL` is in the future, every newly created Payment Link is a *test* link. Admin UI must show a clear "TEST MODE" badge on the contractor record so 50 photo cards don't get printed pointing at a test link during cutover.
- **Payment Link regeneration kills mid-payment customers.** Don't regenerate without the warning dialog (Section 10.1).
- **Customer email PII.** `tips.customer_email` and `tip_page_feedback.submitter_email` are PII. Admin-only access. Never exported casually. Match CLAUDE.md money/PII patterns.
- **Feedback spam.** Rate-limited at Section 8.5 + Sentry alert if a single token sees > 20 submissions / hour.
- **Stripe metadata size.** Payment Link metadata is limited to 50 keys × 500 chars per value. We use 3 keys, well under the limit.
- **Honest tip-history copy is load-bearing.** The bartender dashboard copy (Section 9.4) makes it explicit that the displayed total is *not* their take-home — it's the gross before pooling. If we don't make this clear, bartenders will be surprised when payroll arrives with a different number.

### Open questions / things to confirm during planning
- **`sharp` availability.** Verify whether the repo already imports `sharp`. If not, decide between adding `sharp` (heavy native dep) or `@napi-rs/canvas` (Node-only, lighter).
- **Logos.** Dallas to gather Venmo / Cash App / PayPal / card-network (Visa, MC, Amex, Discover) / Apple Pay / Google Pay assets, drops in `client/public/tip-logos/`. Each platform has brand guidelines that must be followed.
- **SVG print-card templates.** Claude Design produces `server/assets/tip-card-4x6.svg` and `server/assets/tip-card-5x7.svg` with `{{qr}}` and `{{display_name}}` placeholders.
- **`preferred_payment_method` value normalization.** The existing `payment_profiles.preferred_payment_method` field has been in use; check what values are stored and write a one-time normalization pass to the canonical `'venmo' | 'cashapp' | 'paypal' | 'check' | 'direct_deposit' | 'other'` set.
- **`payment_username` deprecation path.** The existing single-handle field is superseded by the new specific columns. Decide during planning whether to migrate existing values into the right specific column or leave alone.

---

## 13. Env vars

| Var | Where | Purpose |
|---|---|---|
| `PUBLIC_GOOGLE_REVIEW_URL` | server (Render) | Single company Google Review URL the 4-5★ flow redirects to. Documented in `.env.example`. |
| `REACT_APP_GOOGLE_REVIEW_URL` | client (Vercel) | Same value, exposed to the client. |
| `ADMIN_FEEDBACK_NOTIFICATION_EMAIL` | server (Render) | Where `tip_page_feedback` notifications go. Defaults to `contact@drbartender.com` if unset. |

All three need to be added to:
- `.env.example` (committed)
- Local `.env` (Dallas)
- Render dashboard (server)
- Vercel dashboard (client, for the `REACT_APP_*` one)

---

## 14. Implementation prerequisites

Before the implementation plan can run end-to-end, these need to be in place:

1. **Logos** in `client/public/tip-logos/` — Dallas to source.
2. **SVG print-card templates** in `server/assets/tip-card-{4x6,5x7}.svg` — Claude Design to produce.
3. **Env vars** set in Render + Vercel.
4. **`sharp` or `@napi-rs/canvas` decision** confirmed (during planning).
5. **`preferred_payment_method` normalization plan** confirmed (during planning).

The legal-name capture (`applications.full_name`) is already in place — confirmed during the spec drafting.

---

## 15. Operational checklist on deploy

1. Set the three new env vars in Render + Vercel.
2. Run `node server/scripts/backfillTipPages.js` once for existing approved contractors.
3. Confirm Stripe webhook (existing `STRIPE_WEBHOOK_SECRET`) is firing for the new tip handler — send one $1 test tip end-to-end on a real bartender's link.
4. Drop logos into `client/public/tip-logos/` (already done as a prerequisite, verify deployed).
5. Drop `tip-card-{4x6,5x7}.svg` templates into `server/assets/` (already done as a prerequisite, verify deployed).
6. Smoke-test:
   - Existing approved staffer: their tip page renders, QR downloads, Stripe link works.
   - New onboarding flow: complete onboarding → tip page goes live → Stripe Payment Link present in DRB Stripe dashboard.
   - Tip → webhook fires → row appears in `tips` table → bartender sees it in staff portal.
   - 1★ feedback → admin gets email → row appears in admin queue.

---

## Appendix A — Mapping from Wix script to DRB OS

| Wix concept | DRB OS equivalent |
|---|---|
| `#venmoButton.onClick → wixLocation.to('https://venmo.com/u/kaitlyn-marie-43')` | `<a href="https://venmo.com/u/{venmo_handle}" target="_blank">` on TipPage.jsx, handle from `payment_profiles.venmo_handle` |
| `#cashAppButton.onClick → wixLocation.to('https://cash.app/$kaitlynmfmt')` | Same pattern, `cashapp_handle`. |
| `#paypalButton.onClick → wixLocation.to('https://www.paypal.me/kaitlynmfmt')` | Same pattern, `paypal_url` (full URL stored, not just handle). |
| `#stripeButton.onClick → wixLocation.to('https://buy.stripe.com/...')` | Same pattern, `stripe_payment_link_url`. Button **labeled "Credit Card"**, never "Stripe". |
| `#thankYouStrip` shown via setTimeout 800ms | Removed. Buttons open in new tab; thank-you state shown on next interaction. |
| `GOOGLE_REVIEW_URL = 'https://g.page/r/Cd65jyuqerfZEAI/review'` | `REACT_APP_GOOGLE_REVIEW_URL` env var, single company URL. |
| `FEEDBACK_PAGE_URL = '/feedback'` | Inline-expand feedback form on TipPage.jsx, posts to `POST /api/public/tip/:token/feedback`. Routed by `target_user_id` from token. |
| `paint(n) → fills star sprites from URLs` | React state + CSS / inline SVG. Same UX. |
| `popStar(star)` micro-animation | CSS transition on click. |
