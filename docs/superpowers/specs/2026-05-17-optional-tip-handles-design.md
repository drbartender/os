# Optional tip handles + trustworthy edit-later — design spec

**Date:** 2026-05-17
**Author:** Dallas (with Claude)
**Status:** Approved for implementation planning
**Related:** Builds on `2026-05-01-tip-qr-page-design.md` (per-bartender tip page, QR sign, `payment_profiles` handle columns, `/me/tip-page`).

---

## 1. Summary

Make the customer-facing tip handles (Venmo / Cash App / PayPal) genuinely optional at
onboarding, fix the printed QR sign so it only advertises payment methods the bartender
actually has, and rebuild the staff "My Tip Page" screen to brand quality so bartenders
trust it with their money.

A bartender must still give Dr. Bartender **one** way to be paid (payroll). Everything
beyond that one method is tip-page decoration: optional, addable later, or never.

This is a frontend + print-rendering change plus one pure helper. **No payroll, Stripe,
encryption, schema, or server-route logic changes.**

---

## 2. Background & motivation

The tip-QR feature (2026-05-01) collects payment handles during onboarding in a single
"Tip & Payroll Preferences" block on `PaydayProtocols`. That block conflates two
different concerns:

1. **Payroll** — how DRB pays the bartender their wages + pooled Stripe tips.
2. **Tip-page handles** — the Venmo / Cash App / PayPal buttons customers see on the
   public tip page.

The server already does the right thing (only the handle matching the chosen payroll
method is required; all others are optional). But the UI doesn't make that distinction
clear, so bartenders without a Venmo/Cash App/PayPal feel blocked or enter the wrong
thing.

Two genuine problems remain:

- **The printed QR sign lies.** `PrintTipCard.layouts.jsx` hardcodes the payment-logo
  row (`marks={['apple','venmo','cashapp','paypal','visa']}`) on every card regardless
  of what the bartender set. A Venmo-only bartender prints a card advertising Cash App
  and PayPal that don't work.
- **"My Tip Page" is raw.** `MyTipPage.js` is unstyled inline-style scaffolding. It's
  the screen where a bartender manages their money — it needs to look trustworthy.

---

## 3. Goals & non-goals

### In scope

- Onboarding (`PaydayProtocols.js`): visually separate **required payroll** from
  **optional tip handles** so the optionality is unmistakable. UI/copy only.
- QR sign: drive the printed payment-logo row from the bartender's actual handles +
  Stripe-link presence. New pure, unit-tested helper.
- "My Tip Page" (`MyTipPage.js`): full rebuild on the Dr. Bartender design system —
  brand-quality, mobile-first, real loading/empty/error/saved states. Lets the
  bartender add/change/remove handles **and** change their payroll method (existing
  endpoints).
- Admin parity (`TipPageTab.js`): expose the payroll-method selector (the admin route
  already accepts it).

### Out of scope / non-goals

- **W-9 stays required at onboarding** — tax/legal, unchanged.
- **No separate payroll-vs-tip storage.** Venmo/Cash App/PayPal remain single shared
  columns; when one is the payroll target it doubles as the tip-page handle (same
  real-world account).
- **No server logic changes** — `POST /payment`, `PATCH /me/tip-page`,
  `PATCH /admin/contractors/:id/tip-page` are already correct and stay untouched.
- **No Stripe, token, payroll, encryption, or schema changes. No new endpoints.**
- No tip-pooling, payout-integration, or Tap-to-Pay work (separate brainstorms, per
  the 2026-05-01 spec).

---

## 4. Server guardrail (verified — unchanged)

Confirmed during design; recorded so implementation doesn't "fix" what isn't broken:

- **`server/routes/payment.js` (`POST /payment`, onboarding submit):** requires
  `preferred_payment_method`; requires the matching handle **only** when the method is
  `venmo`/`cashapp`/`paypal` (`methodToHandleField`); `check`/`direct_deposit`/`other`
  require no tip handle. Non-matching handles are already optional and `COALESCE`-merged
  so a blank re-submit can't null a previously set handle. **No change.**
- **`server/routes/me.js` (`PATCH /me/tip-page`):** allow-listed fields
  (`preferred_name`, `venmo_handle`, `cashapp_handle`, `paypal_url`,
  `preferred_payment_method`); normalizes/validates handle formats; empty radio = no-op,
  explicit `null` clears. No forced handle. **No change.**
- **`server/routes/admin/users.js` (`PATCH /admin/contractors/:userId/tip-page`):**
  already accepts `venmo_handle`, `cashapp_handle`, `paypal_url`,
  `preferred_payment_method` with the same normalization. **No change** — only the
  admin *UI* needs the payroll-method control added.

The "at least one payroll method, rest optional" rule the user asked for is therefore
already enforced server-side. This project makes the **UI honest about it** and fixes
the **printed sign**.

---

## 5. Design — Onboarding (`PaydayProtocols.js`, frontend only)

Split the single "Tip & Payroll Preferences" fieldset into two visually distinct,
clearly-labeled cards. No change to validation rules, submit payload, or server.

### Card A — "How we pay you" (required)

- The existing "Pay me out via" radio (Venmo / Cash App / PayPal / Check / Direct
  deposit / Other).
- The detail field for the **chosen** method appears inline and required:
  - Venmo / Cash App / PayPal → that single handle (existing strip/normalize UX).
  - Direct deposit → routing + account (existing).
  - Check → static note: "Checks are mailed to the address on your Contractor Profile."
  - Other → static note: "We'll coordinate your payout with you directly."
- Trust copy: this is your wages + pooled tips; encrypted; never shared outside DRB.
- This card is the unchanged "at least one method" gate.

### Card B — "Your tip jar, online" (optional)

- Heading explicitly marks it optional: *"Optional — add now or anytime later from My
  Tip Page."* No asterisks, no field-level required styling.
- Preferred name lives here, framed as "the name customers see on your tip page"
  (still required — it's the public display name; keep its existing validation rule).
- Venmo / Cash App / PayPal handle inputs for the public tip page.
- If the Card A payroll method is a P2P handle, that handle is shown here pre-filled
  and read-only with a note "Already on your tip page" — it's the same account/column,
  so no duplicate entry and no contradiction.
- The entire card (except preferred name) is skippable; skipping it blocks nothing.

Submit still blocks only on: payroll method + its detail + preferred name + W-9 — all
unchanged from today.

---

## 6. Design — Data-driven QR sign

### New helper — `client/src/utils/tipCardMarks.js` (pure, unit-tested)

```
buildTipCardMarks({ venmo_handle, cashapp_handle, paypal_url, has_stripe_link })
  → ordered array of mark keys
```

Rules:

- Card group (`apple`, `google`, `visa`, `mc`, `amex`) is included **iff**
  `has_stripe_link` is true (the Stripe Payment Link is what makes card/Apple/Google
  Pay work).
- `venmo` included iff `venmo_handle` is non-empty.
- `cashapp` included iff `cashapp_handle` is non-empty.
- `paypal` included iff `paypal_url` is non-empty.
- Returns marks in the canonical order the layouts expect; each layout selects the
  subset/grouping it renders (business card uses a curated single row; 4×6 / 5×7 use a
  primary row + a card-network row). Helper returns the full ordered set; layouts
  intersect with their own display list so an absent method simply drops out.

Pure function, no React, mirrors `tipHandleValidation.js` / `bookingWindow.js`
testable-util pattern.

### `client/src/pages/staff/PrintTipCard.jsx`

Already fetches `/me/tip-page`, which returns `venmo_handle`, `cashapp_handle`,
`paypal_url`, and `has_stripe_link`. Compute marks once via `buildTipCardMarks(data)`
and pass `marks` into the layout components.

### `client/src/pages/staff/PrintTipCard.layouts.jsx`

- `BizCardFrontA`, `FourBySixA`, `FiveBySevenA` accept a `marks` prop instead of
  hardcoding. Default prop = the current full list so any other caller/storybook
  use is unaffected.
- `PaymentRow` already maps over `marks`; it just receives the computed list.
- **Empty marks** (no handles, no Stripe link): omit the entire payment-row block
  **and** its label ("Pay any way you like" / the "Scan to Tip" logo strip). The QR
  code, name, and headshot still render — the card is never broken, just QR-only.
- `BizCardBackA` is contact-info only (no PaymentRow) — untouched.

Result: the printed sign advertises exactly the methods that work for that bartender.

---

## 7. Design — "My Tip Page" rebuild (`MyTipPage.js` + new `MyTipPage.css`)

The bartender's money screen. Rebuild on the existing Dr. Bartender design system —
the brand tokens already used by the public tip page and print card (chalkboard
`#12161C`, paper `#EDE6D6`, teal `#1D8C89`, brass `#B8924A`, display/body fonts via
`drb-tokens.css`). Render inside `StaffLayout`. Mobile-first (bartenders are on
phones). **Same endpoints** — `GET /me/tip-page`, `PATCH /me/tip-page`,
`GET /me/tips`. No new API.

Sections:

1. **Your tip page** — public URL, large copy button (existing copy behavior), a small
   "what customers see" preview (name + the live handle buttons), and the "Print my QR
   card" CTA. Gated states preserved: not-active-yet, Stripe-link-not-ready.
2. **How you get paid** — payroll method shown at a glance with a clear "Change"
   affordance that edits `preferred_payment_method` via the existing PATCH. Reassurance
   copy: encrypted, never shared, this is wages + pooled tips. (This is the
   "add or change preferred payroll method later" the user asked for.)
3. **Tip handles** — add / edit / remove Venmo, Cash App, PayPal, using the same
   strip/normalize input UX as onboarding. Explicit "Optional — this only affects your
   public tip page" copy. Instant per-save feedback (success / error toast already
   wired).
4. **Tips earned** — the existing Stripe tips total + history, restyled, keeping the
   honest copy that direct Venmo/Cash App/PayPal taps don't appear here (only the
   pooled Stripe path does).

Every async surface gets real loading, empty, error, and saved states. No raw inline
styling — all visual rules move to `MyTipPage.css`.

---

## 8. Design — Admin parity (`TipPageTab.js`, frontend only)

`PATCH /admin/contractors/:userId/tip-page` already accepts
`preferred_payment_method`; the admin UI just doesn't expose it. Add a payroll-method
selector to the existing "Handles (admin override)" card (same `edit` buffer + save
flow already in the component). Lets ops correct a bartender's payout method from the
contractor record. Pure frontend; route unchanged.

---

## 9. Storage / data model

**No schema change.** `payment_profiles.venmo_handle`, `.cashapp_handle`,
`.paypal_url` stay single shared columns. When one is the payroll target it
simultaneously serves as the tip-page handle (same real-world account — separating
them would be storage/migration cost for a need essentially no bartender has). The
design only makes the UI state this honestly (the "Already on your tip page" note in
onboarding Card B).

---

## 10. Testing

### Automated

- `client/src/utils/tipCardMarks.test.js` — every combination:
  - none (no handles, no Stripe) → `[]`
  - Stripe only → card group only
  - each single handle, with and without Stripe
  - all handles + Stripe → full ordered set
  - order/grouping stable.

### Manual checklist

- Onboard with payroll = **Check** and no handles → not blocked → finishes; tip page
  shows card-only (Stripe link auto-generated); printed card shows card-only or
  QR-only.
- Onboard with payroll = **Venmo** and no Venmo handle → still blocked (the one
  required detail) — confirms the payroll gate is intact.
- Onboard with payroll = **Direct deposit**, optionally add a Venmo tip handle in
  Card B → finishes; Venmo appears on public page + printed card.
- After onboarding, in My Tip Page: add a Cash App handle → appears on public page;
  re-print card → Cash App now shown. Remove it → drops from both.
- My Tip Page: change payroll method → persists; reflected in admin contractor record.
- Admin `TipPageTab`: change a bartender's payroll method → persists.
- Bartender with **zero** handles and no Stripe link → My Tip Page renders cleanly
  (empty states, no crash); printed card is QR-only with no logo row.

---

## 11. Resolved design decisions

All clarifying questions are answered — no open items:

- **Payroll vs. tip handles:** at least one payroll method (and its single detail) is
  required so DRB can pay the bartender; every other handle is tip-page-only and
  optional, addable later or never. *(User: "they have to give us at least one method
  for us to pay them. The rest is for tips and can be dealt with later or never.")*
- **Edit-later scope:** full brand-quality rebuild of My Tip Page, not just verified
  functional — it's the bartender's money and must feel trustworthy. *(User: "it's the
  bartender's money. it needs to be sexy so they trust it.")*
- **Approach:** minimal-footprint (Approach 1) — UI/print/helper only, server money
  paths untouched.
- **W-9, separate storage, server changes:** explicitly out of scope (Section 3).

---

## 12. Risks & mitigations

- **Risk: a "UI-only" change accidentally alters the submit payload and breaks the
  payroll gate.** Mitigation: onboarding restructure keeps the exact same field names,
  `FormData` keys, and validation rules; the split is purely presentational. Manual
  checklist explicitly re-verifies the Venmo-payroll-still-blocks case.
- **Risk: printed cards already in the wild.** No token/URL change — existing QR codes
  keep working; only the *logo row* on newly printed cards changes. No mitigation
  needed.
- **Risk: empty-marks card looks broken.** Mitigation: explicit QR-only fallback
  (drop the logo row + its label, keep QR/name/headshot) covered by the manual
  checklist.
- **Risk: My Tip Page rebuild regresses an existing behavior (copy button, gated
  states, tips honesty copy).** Mitigation: same endpoints; enumerate and preserve
  each existing state (not-active, Stripe-not-ready, tips-honesty note) in the
  rebuild; checklist covers them.
