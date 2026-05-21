# Manual Proposal Creation Overhaul — Design

**Date:** 2026-05-20
**Status:** Approved (section-by-section)
**Author:** Dallas + Claude

## Problem

Admin-created proposals don't surface the Sign & Pay panel for clients, and the manual create flow has diverged from the quote wizard in ways that produce invalid pricing snapshots and inconsistent client experience.

### Root causes

1. **Status default mismatch.** `proposals.status` defaults to `'draft'`. `POST /api/proposals` never sets a status. `ProposalView` (the public proposal page) only renders the Sign & Pay panel when status is `'sent' | 'viewed'` (`ProposalView.js:321`). Status `'accepted'` routes to a separate pay-only flow (`ProposalView.js:324`). Either way, status='draft' surfaces nothing. Admins have to remember to click "Send to client" as a second step on the proposal detail page, and many don't.

2. **Validation drift.** The quote wizard enforces:
   - Hosted package minimum 25 guests
   - BYOB bundle mutex + mixer mutex (selecting one bundle removes others)
   - Flavor Blaster requires real-glassware addon OR `client_provides_glassware` checkbox
   - Real Glassware + Champagne Coupe Upgrade hidden above 100 guests
   - Mocktail Bar (BYOB-only) requires Formula or Full Compound first
   - Garnish Package hidden for hosted packages (already included)
   - Top Shelf class flow (status='draft', no pricing snapshot, admin prices later)

   The cockpit (admin create page) enforces none of these. Admins can build proposals the wizard would never let a client build.

3. **Data shape drift.**
   - Wizard sends `addon_quantities`, `syrup_selections`, `class_options`, `client_provides_glassware`
   - Cockpit sends `addon_variants` (champagne-toast NA bubbles toggle)
   - Both ultimately call `calculateProposal()`, but the inputs differ, so identical client selections in each flow can produce different snapshots.

4. **Side-effect drift.** `PATCH /api/proposals/:id/status` (admin promotes draft → sent) sends the client email AND auto-creates the first invoice. `POST /api/proposals/public/submit` (wizard) sends the email but skips invoice creation. Every "sent" proposal should have its invoice row regardless of which flow created it.

## Goals

- Sign & Pay works the moment a proposal is created via the cockpit
- Manual create enforces the same business rules as the wizard
- Wizard and cockpit consume one shared rules module (no behavioral drift going forward)
- Server re-validates **every** client-side rule independently (defense-in-depth, server is authoritative — a stale tab or scripted POST must not be able to persist a combination the UI forbids)
- "Sent" side effects use one shared path across all three callers: invoice creation **inside the DB transaction** (atomic with the proposal write, retry-safe), client email **after commit** (best-effort, non-blocking)
- Cockpit UX stays one-screen / click-anywhere (NOT a step wizard)

## Non-goals

- Rebuilding the cockpit as a step wizard (explicitly rejected by user)
- Adding draft autosave to the cockpit (out of scope — current "Saved Xs ago" indicator is cosmetic, separate redesign)
- Custom-message-at-create-time (admin can still add custom message on proposal detail after creation)
- Scheduled sends
- Reworking the wizard's UX
- Consolidating `ProposalDetailEditForm.js` `toggleAddon` (admin edit-existing-proposal surface) — out of scope; admin edit is a separate surface and the user did not request it. Note as follow-up so it doesn't silently diverge.

## Architecture

Three pieces change:

### 1. Shared rules module (NEW: `client/src/utils/proposalRules.js` + `server/utils/proposalRules.js`)

Pure functions. No React, no state. Manually-kept client/server twin pattern (mirrors `eventTypes.js`). Both `QuoteWizard.js` and `ProposalCreate.js` import the client copy; both `POST /api/proposals` and `POST /api/proposals/public/submit` import the server copy and re-validate before pricing. Client rules are advisory UX; server rules are authoritative.

```js
// client/src/utils/proposalRules.js (and a CJS twin at server/utils/proposalRules.js)

// Re-exports from existing bundleConfig — stays in quoteWizard/ folder to avoid
// shaking unrelated imports. proposalRules.js becomes the single entry point.
// Server twin re-implements the same constants in CJS (sync manually like
// eventTypes.js — small enough that drift is easy to spot in review).
export {
  BYOB_BUNDLE_SLUGS,
  MIXER_SLUGS,
  BUNDLE_INCLUDED,
  BUNDLE_UNAVAILABLE,
  BUNDLE_COVERED,
} from '../pages/website/quoteWizard/bundleConfig';

// Returns slug of the active BYOB bundle in the selection (or null).
export function getSelectedBundleSlug(addonIds, addons) { ... }

// Drops addon ids that the active bundle covers (used for pricing preview + submit).
export function stripIncludedAddons(addonIds, addons) { ... }

// UI gating helpers — used to grey out addon rows + dropdown items.
export function isIncludedByBundle(slug, addonIds, addons) { ... }
export function isUnavailableByBundle(slug, addonIds, addons) { ... }

// Encapsulates BYOB mutex, mixer mutex, dependent-addon cleanup, and
// syrup_selections clear when handcrafted-syrups is removed.
// Returns next-state slice: { addon_ids, syrup_selections? }
export function toggleAddonWithRules(
  { addonIds, syrupSelections },
  id,
  addons,
) { ... }

// Single visible-addons calculation + bundle-status maps for UI.
// Takes decoupled args instead of the raw pkg row so the module isn't coupled
// to service_packages schema shape.
//
// IMPORTANT — class detection: class packages are seeded `category='hosted'`
// with `bar_type='class'` (they ride the hosted pricing path). So "is this a
// class package" MUST key off `bar_type === 'class'`, never `category`. The
// `isClass` arg below carries that; `packageCategory` is only for addon
// applies_to matching and never carries the value 'class'.
export function filterAddons({
  addons,
  isHosted,            // boolean — pkg.pricing_type === 'per_guest'
  isClass,             // boolean — pkg.bar_type === 'class' (NOT pkg.category)
  packageCategory,     // string — pkg.category ('byob' | 'hosted' | 'mocktail')
  addonIds,
  guestCount,
  clientProvidesGlassware,
}) {
  return { visibleAddons, isIncludedMap, isUnavailableMap };
}

// Bumps guest_count to 25 if hosted. Cockpit infers isHosted from pkg.pricing_type;
// wizard has explicit alcohol_provider. Both pass isHosted bool to keep this pure.
export function enforceHostedMinimum(guestCount, isHosted) { ... }

// Auto-deselect Flavor Blaster if glassware requirement no longer met.
export function reconcileFlavorBlaster(addonIds, addons, clientProvidesGlassware) { ... }

// SERVER-ONLY (in server/utils/proposalRules.js): validateProposalRules({...})
// throws ValidationError for any rule violation — called by POST /api/proposals
// and POST /api/proposals/public/submit before calculateProposal(). This is the
// AUTHORITATIVE gate: it must re-check EVERY rule the wizard UI enforces, because
// a stale tab or scripted POST bypasses the client entirely. Re-checks:
//   - hosted package + guestCount < 25 → reject
//   - Flavor Blaster selected + no real-glassware + !client_provides_glassware → reject
//   - real-glassware/coupe-upgrade + guestCount > 100 → reject
//   - mocktail-bar on BYOB without Formula/Compound → reject
//   - garnish-package on hosted → reject
//   - more than one BYOB bundle in the selection at once (bundle mutex) → reject
//   - more than one mixer package in the selection at once (mixer mutex) → reject
//   - any addon carrying requires_addon_slug whose parent slug is absent → reject
//     (e.g. champagne-coupe-upgrade selected without champagne-toast)
// The mutex + requires_addon_slug checks are the ones the wizard enforces only
// in toggleAddonWithRules (UI-side) — without them here the server is NOT
// actually authoritative, which the Goals section requires.
```

**What moves out of `QuoteWizard.js`:** the inline `getSelectedBundleSlug`, `stripIncludedAddons`, `toggleAddon` rule body, the `filteredAddons` block, `isIncludedByBundle` / `isUnavailableByBundle` derivations, the Flavor Blaster auto-deselect `useEffect` body, and the `handleAlcoholChange` hosted-minimum bump.

**What stays cockpit-local in `ProposalCreate.js`:**

- Client search / pick-existing-or-new (`ClientSection`)
- Source attribution dropdown (`SOURCES`)
- Manual bartender override (`StaffingSection`)
- Addon power-search typeahead dropdown
- `addon_variants` (champagne-toast NA bubbles checkbox)
- Pricing dock layout, field-status dots, top-bar chips
- "Saved Xs ago" cosmetic

### 2. Cockpit UI changes

Same one-screen layout. Click-anywhere preserved. Visible changes:

**Event section**
- Guest count enforces 25 minimum when a hosted package is selected (bump on blur, inline note "Hosted minimum: 25 guests")

**Package section** — Top Shelf class flow added
- When `bar_type === 'class'` package is selected, two controls appear: spirit category dropdown (Whiskey/Bourbon · Tequila/Mezcal) and "Top Shelf requested (custom pricing)" checkbox
- When Top Shelf is checked: pricing dock shows "Custom pricing — admin will follow up", snapshot/total skip, proposal forces status='draft' regardless of send_now

**Add-ons section**
- New checkbox above the addon list: **"Client provides their own glassware"** — required for Flavor Blaster if Real Glassware isn't selected
- Selected-addon rows and search dropdown both flag bundle conflicts:
  - "Included with \[Bundle Name\]" badge — greyed, not removable while bundle active
  - "Unavailable with \[Bundle Name\]" badge — greyed in search, click does nothing
- Real Glassware + Champagne Coupe Upgrade hidden when `guest_count > 100`
- Mocktail Bar hidden for BYOB packages until Formula or Full Compound is selected
- Garnish Package hidden for hosted packages
- Parking Fee and 3-pack syrup variant hidden (handled elsewhere)
- Flavor Blaster auto-removes via toast when glassware requirement is no longer met: *"Flavor Blaster removed, requires real glassware."*
- **Quantity stepper on addon rows** — for quantity-capable add-ons (extra bartenders, barback, banquet server, pre-batched mocktail, handcrafted syrups), the selected-addon row gets a 1–10 stepper, mirroring the wizard's `ExtrasStep` (`form.addon_quantities[addon.id]`, clamped 1–10). Without this the cockpit cannot reproduce a wizard quote that used multiples — the parity goal fails. The implementation should derive the quantity-capable set from the same logic `ExtrasStep` uses, not a hardcoded list, so the two stay in sync.
- New syrup picker — when Handcrafted Syrups is selected, chip-style multi-select for flavors appears inline (matches wizard `ExtrasStep`). Syrups carry both a quantity (bottle count, via the stepper above) and `syrup_selections` (which flavors).

**Send section** — repurposed from placeholder to real controls
- Two-line summary of next-step behavior: *"Create & send → client gets email at \[email\] with proposal link. Sign & Pay live immediately. Auto-creates first invoice."*
- Toggle: "Save as draft instead" — switches the primary button label, suppresses email + invoice

**Top bar / submit buttons**
- Primary: **"Create & send"** — disabled until `client.done && event.done && package.done`. Tooltip on hover: *"Add client, event date, and package to send."*
- Secondary: **"Save as draft"** — visible always, no gating. Posts with `send_now: false`. Admin lands on proposal detail in 'draft' state, ready for later send via existing button.
- "Cancel" — unchanged

**Pricing dock**
- Footer button label tracks top bar (Create & send / Save as draft)
- New "Stripe · sign & pay electronically · $100 deposit locks the date" trust block (Apothecary Press style, matches wizard `wz-price-trust`)

### 3. Server endpoint + helper extraction

**`POST /api/proposals`** widens its input. Both `addon_variants` AND `addon_quantities` are accepted — they represent different concepts (variant = champagne-toast NA bubbles toggle; quantity = syrup-picker count). Both map to distinct columns on `proposal_addons` (`variant` and `quantity` respectively):

```
Existing fields kept: client_id, client_name, client_email, client_phone,
  client_source, event_*, venue_*, guest_count, package_id, num_bars,
  num_bartenders, addon_ids, addon_variants, event_type*

New fields accepted:
  addon_quantities           // { [addon_id_str]: number } — per-addon counts for
                             //   quantity-capable add-ons: extra bartenders, barback,
                             //   banquet server, pre-batched mocktail, handcrafted
                             //   syrups. NOT syrup-only (the wizard's ExtrasStep uses
                             //   it generally). Clamped 1-10 server-side.
  syrup_selections           // string[] — flavor slugs (which syrups, separate from
                             //   the bottle-count quantity above)
  class_options              // { spirit_category, top_shelf_requested }
  client_provides_glassware  // boolean — Flavor Blaster gate
  send_now                   // boolean, default true
```

`addon_variants` and `addon_quantities` are both passed to `calculateProposal({ addons })` — server merges them onto the addon row before persisting (`variant` and `quantity` columns respectively).

**Submit branching** — three mutually exclusive paths:

1. `send_now === true && !isTopShelfClass` → status='sent', side-effects helper runs
2. `send_now === false` → status='draft', no side effects
3. Top Shelf class → status='draft' regardless, helper never invoked (matches wizard's Top Shelf branch)

**Rate limiting** — admin POST + PATCH/status get a new `adminWriteLimiter` (e.g. 30 requests/min keyed by `req.user.id`, not IP — admin NAT would share a bucket). Without it, a compromised admin token with the new `send_now=true` default can blast emails. Lives in `server/middleware/rateLimiters.js`.

**Sent side effects — two pieces, split by transactional need.** An earlier draft of this spec bundled invoice + email into one post-commit helper. That was wrong on two counts (caught by Codex): a post-commit invoice failure strands the proposal (retrying the POST makes a *duplicate* proposal), and a `sent_at`-based email-skip silently drops legitimate re-sends. The corrected design:

**Piece 1 — invoice creation, INSIDE the transaction.** `createInvoiceOnSend(proposalId, dbClient)` already exists and already accepts an optional transaction client (`invoiceHelpers.js:345`) and is already idempotent on `proposal_id` (`invoiceHelpers.js:349-353`). No new code — we just *call it inside the open `BEGIN/COMMIT`*, passing `dbClient`, in all three callers:

```
BEGIN
  ... INSERT/UPDATE proposal + addons + activity log ...
  await createInvoiceOnSend(proposal.id, dbClient)   ← participates in the txn
COMMIT
```

If invoice creation throws, the whole transaction rolls back — no orphan proposal, no invoice, nothing persisted. The admin retries the POST and gets a clean first-time create, not a duplicate. This is the core fix for the stranding bug.

**Piece 2 — client email, AFTER commit.** `sendEmail` hits Resend (external API) — it cannot live inside a DB transaction. NEW thin helper `server/utils/sendProposalSentEmail.js`:

```js
// Called by all three sites AFTER their transaction commits:
//   POST  /api/proposals               (when send_now=true)
//   POST  /api/proposals/public/submit (always, except Top Shelf)
//   PATCH /api/proposals/:id/status    (when transitioning → 'sent')
//
// Takes the full proposal row (already in hand from RETURNING * / SELECT) +
// actor context. Best-effort: NEVER throws — the proposal + invoice are
// already committed, so an email failure is recoverable (admin resends from
// the proposal detail page). NO sent_at gate — see note below.
async function sendProposalSentEmail(proposal, { actorType = 'admin' } = {}) {
  try {
    const tpl = emailTemplates.proposalSent({ ...buildTemplateArgs(proposal) });
    await sendEmail({ to: proposal.client_email, ...tpl });
  } catch (emailErr) {
    // Sentry: ONLY { proposalId, actorType } in extra — never client_email
    // or other PII. Mirrors the existing pattern at crud.js:529.
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(emailErr, {
        tags: { route: 'proposals/sent', issue: 'email' },
        extra: { proposalId: proposal.id, actorType },
      });
    }
    console.error('Proposal sent email failed (non-blocking):', emailErr.message);
    // Do NOT re-throw.
  }
}
```

**No `sent_at` email-skip.** An earlier revision gated the email on `proposal.sent_at IS NULL` for idempotency. That is removed: `PATCH /:id/status` stamps `sent_at` on the *first* `→sent` transition, and "Send to client" is reachable again from both `draft` and `modified` (`ProposalDetail.js:213`). A `sent → modified → sent` re-send, or a draft promoted later, would find `sent_at` already set and silently skip the email the client is supposed to receive. So the email fires every time a caller transitions a proposal into `sent` — which matches today's `PATCH /:id/status` behavior exactly (no regression). The "double-email on POST retry" concern that motivated the gate is now moot: Piece 1 makes the create transaction atomic, so a retry either fully succeeded (client got 201, won't retry) or fully rolled back (clean retry). `sent_at` is still *stamped* (it's a real column other code reads) — it's just not used to suppress email.

PATCH `/:id/status` is wrapped in an explicit `BEGIN/COMMIT` (it currently is not) so its invoice call can join the transaction. It loses its inline email block in favor of `sendProposalSentEmail`. Public submit gains the in-transaction `createInvoiceOnSend` call it currently lacks (parity #2) plus the email helper.

**Schema migration** — `proposals` gets one new column for `client_provides_glassware`:

```sql
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS client_provides_glassware BOOLEAN DEFAULT false;
```

Dedicated column rather than reusing `admin_notes` (which today is being clobber-prone: public.js:334 appends a "Client will provide glassware" suffix to admin_notes, and admin POST writing to the same field would overwrite admin-typed text on edit). Easy to query, no parsing free-text. Backfill: existing rows default false (existing behavior — they didn't set this flag, so they didn't have the glassware override).

### Wizard public submit parity (#2 from brainstorm)

When the wizard's `POST /api/proposals/public/submit` creates a `status='sent'` proposal, it adopts the same two-piece pattern: `createInvoiceOnSend(proposal.id, dbClient)` inside its existing `BEGIN/COMMIT`, then `sendProposalSentEmail` after commit. Behavior change: wizard-created proposals now auto-create their first invoice on submit (today they don't — a quiet inconsistency). The Top Shelf branch of `/public/submit` is unchanged (still `draft`, still no invoice/email).

## Data flow

### Manual cockpit create (happy path)

```
Admin fills cockpit → toggleAddon dispatches toggleAddonWithRules → form state
  updates → debounced 400ms → POST /proposals/calculate (admin endpoint) →
  pricing dock updates
↓ admin clicks "Create & send"
POST /api/proposals with full payload including send_now: true
↓
crud.js:
  - validate fields (existing validateVenue + new class_options shape)
  - validateProposalRules({...}) — authoritative server-side rule gate
    (hosted≥25, glassware gates, real-glassware≤100, mocktail-bar dep,
    bundle/mixer mutex, requires_addon_slug deps). Throws ValidationError
    on violation — runs BEFORE the transaction opens, so no rollback needed.
  - calculateProposal(...) — same call shape as public submit
  - BEGIN
      INSERT proposal with status='sent', sent_at=NOW()
      INSERT proposal_addons (bulk)
      INSERT proposal_activity_log (action='created', actor_type='admin')
      createInvoiceOnSend(proposal.id, dbClient)  ← invoice INSIDE the txn
    COMMIT          ← if createInvoiceOnSend threw, the whole txn rolled
                       back: no orphan proposal, retry is a clean create
↓
res.status(201).json(proposal)   ← returned even if the email below fails
↓
sendProposalSentEmail(proposal, { actorType: 'admin' })  ← AFTER commit,
  best-effort, never throws (admin can resend from detail page on failure)
↓
client navigates to /proposals/:id (admin detail page)
↓
client (in inbox) clicks email link → /proposal/:token → ProposalView renders
  Sign & Pay panel because status === 'sent'
```

### Save-as-draft path

Same as above but `send_now: false`: status='draft', no `createInvoiceOnSend` call, no `sendProposalSentEmail` call. The proposal still inserts inside a `BEGIN/COMMIT` (addons + activity log), just without the invoice step. Admin can later click "Send to client" on the detail page — that `PATCH /:id/status` path is wrapped in its own `BEGIN/COMMIT`, runs `createInvoiceOnSend` in-transaction, and calls `sendProposalSentEmail` after commit.

### Top Shelf class path

`class_options.top_shelf_requested === true` forces `status='draft'`, skips `calculateProposal`, stores `class_options` JSON. Because the proposal is `draft`, neither side effect runs — no in-transaction `createInvoiceOnSend`, no `sendProposalSentEmail` — regardless of `send_now`. Class packages are identified by `bar_type === 'class'` (they carry `category='hosted'`); the Top Shelf controls and this branch both key off `bar_type`, never `category`.

The existing `topShelfClassRequestAdmin` admin-notification email in `POST /public/submit` stays where it is — it's a public-submit concern (someone-not-the-admin requested Top Shelf, admin needs to know). The admin POST path does NOT send it; if the admin is creating a Top Shelf proposal manually, they already know.

## Files touched

| File | Change |
|---|---|
| `client/src/utils/proposalRules.js` | **NEW** — shared bundle/addon/guardrail logic (ESM client copy) |
| `server/utils/proposalRules.js` | **NEW** — server twin (CJS) with `validateProposalRules` for authoritative re-validation |
| `client/src/pages/website/quoteWizard/QuoteWizard.js` | Use shared rules (remove inline copies) |
| `client/src/pages/admin/ProposalCreate.js` | Use shared rules, add UI controls per Section 3, wire submit branching |
| `server/utils/sendProposalSentEmail.js` | **NEW** — post-commit, best-effort, never-throws email helper (email only — invoice is handled in-transaction by the existing `createInvoiceOnSend`) |
| `server/routes/proposals/crud.js` | Widen POST input, call `validateProposalRules`, branch `send_now`, call `createInvoiceOnSend(id, dbClient)` inside the create txn + `sendProposalSentEmail` after commit. Wrap PATCH `/:id/status` in `BEGIN/COMMIT`, move its invoice call inside the txn, swap its inline email block for `sendProposalSentEmail`. |
| `server/routes/proposals/public.js` | Call `validateProposalRules`, add in-transaction `createInvoiceOnSend` (parity #2), call `sendProposalSentEmail` after commit |
| `server/middleware/rateLimiters.js` | **NEW limiter:** `adminWriteLimiter` (30/min keyed by `req.user.id`) applied to POST `/proposals` + PATCH `/:id/status` |
| `server/db/schema.sql` | **Migration:** `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS client_provides_glassware BOOLEAN DEFAULT false` |
| `client/src/utils/proposalRules.test.js` | **NEW** — pure-function unit tests (node:test) |
| `server/utils/proposalRules.test.js` | **NEW** — server twin tests + `validateProposalRules` rejection cases |
| `server/utils/sendProposalSentEmail.test.js` | **NEW** — email helper test (never-throws, no PII in Sentry) |

## Schema

One additive migration:

```sql
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS client_provides_glassware BOOLEAN DEFAULT false;
```

Existing rows default to `false` (matches their pre-migration behavior — they didn't set the flag). No backfill needed. Other columns the spec touches (`class_options`, `pricing_snapshot`, `venue_*`, `proposal_addons.quantity`/`variant`) already exist.

## Test plan

### Manual (golden path → edges)

1. Cockpit → fill all required fields → "Create & send" → admin lands on proposal detail in 'sent' state → open public link in incognito → Sign & Pay panel visible → run Stripe test deposit through to completion
2. Cockpit → "Save as draft" → land on detail in 'draft' state → click existing "Send to client" → email + invoice still fire (helper used by all paths)
3. Cockpit + hosted package + guest_count typed as 10 → bumps to 25 on blur with inline note
4. Cockpit + BYOB + The Formula + try to add Garnish Package via search → search row greyed with "Included with The Formula"
5. Cockpit + Flavor Blaster + no glassware → toast fires, FB removed automatically
6. Cockpit + class package + Top Shelf checked → pricing dock shows custom-pricing message → submit with send_now=true → status='draft' regardless (Top Shelf override)
7. Pricing equivalence — pick a known selection (Full Compound, 75 guests, 4 hours, Champagne Toast + Garnish Package + Syrups) in both wizard and cockpit → totals match to the cent
8. Wizard public submit → verify new invoice row created (parity #2)
9. Cockpit + quantity-capable add-on (e.g. 2 extra bartenders, 3 syrup bottles) → stepper adjusts count, pricing dock reflects the multiple, created proposal's snapshot persists the quantity
10. Re-send: take a `sent` proposal → edit it (status → `modified`) → click "Send to client" again → client receives the proposal email a second time (confirms the removed `sent_at` gate doesn't suppress legitimate re-sends)
11. Invoice-rollback: simulate `createInvoiceOnSend` failure (temporary throw) on cockpit "Create & send" → POST returns an error, NO proposal row persisted, NO invoice row → retry succeeds cleanly with exactly one proposal (no duplicate)

### Automated

- `client/src/utils/proposalRules.test.js` — unit tests for pure functions:
  - `getSelectedBundleSlug` returns correct slug for selections with/without bundles
  - `stripIncludedAddons` removes covered slugs only
  - `toggleAddonWithRules` honors BYOB mutex, mixer mutex, removes dependents, clears syrup_selections
  - `filterAddons` respects guest-count caps, package category, bundle gating
  - `enforceHostedMinimum` bumps below-25 to 25 for hosted only
  - `reconcileFlavorBlaster` removes FB when glassware not met

- `server/utils/sendProposalSentEmail.test.js` — node:test:
  - Sends `emailTemplates.proposalSent` to `proposal.client_email`
  - Never throws when `sendEmail` rejects — returns normally
  - On failure, Sentry `extra` contains ONLY `{ proposalId, actorType }` — asserts no `client_email` / PII leaks
  - Fires the email even when `proposal.sent_at` is already set (re-send works — no idempotency skip)

- `server/utils/proposalRules.test.js` — node:test:
  - `validateProposalRules` throws ValidationError when hosted + guestCount < 25
  - throws when Flavor Blaster + no glassware + !client_provides_glassware
  - throws when real-glassware/coupe-upgrade + guestCount > 100
  - throws when mocktail-bar on BYOB without Formula/Compound
  - throws when two BYOB bundles selected at once (bundle mutex)
  - throws when two mixer packages selected at once (mixer mutex)
  - throws when a `requires_addon_slug` addon's parent is absent (coupe-upgrade sans champagne-toast)
  - class detection: a package seeded `category='hosted', bar_type='class'` is treated as class (Top Shelf branch reachable), NOT as hosted
  - returns clean for a valid selection

- `server/routes/proposals/crud.test.js` — extend if exists, create if not:
  - POST `/proposals` with `send_now: true` → status='sent', `validateProposalRules` invoked, `createInvoiceOnSend` invoked in-txn, `sendProposalSentEmail` invoked after commit
  - POST `/proposals` with `send_now: false` → status='draft', no invoice, no email
  - POST `/proposals` with Top Shelf class_options → status='draft' even when send_now=true, no invoice, no email
  - POST `/proposals` violating a rule (e.g. hosted + 10 guests, or two bundles) → 400 ValidationError, no DB write
  - POST `/proposals` over rate limit → 429 (limit=30/min keyed by user.id)
  - **Invoice-rollback:** POST `/proposals` with `createInvoiceOnSend` stubbed to throw → transaction rolls back, zero proposal rows persisted, retry creates exactly one (no duplicate)
  - PATCH `/:id/status` to 'sent' → `createInvoiceOnSend` in-txn + `sendProposalSentEmail` invoked (refactor regression check)
  - PATCH `/:id/status` `modified`→`sent` on a proposal that already has `sent_at` set → email STILL fires (re-send regression check)

### Pre-push

Standard 5 review agents (consistency, code, security, database, performance) per CLAUDE.md Rule 6. This touches money math + email side effects so review is substantive.

## Risk + mitigation

| Risk | Mitigation |
|---|---|
| Cockpit pricing snapshots stop matching what was working before | Pricing equivalence test (#7) — same inputs, same totals across wizard + cockpit |
| Refactoring PATCH `/:id/status` breaks existing send-flow | Regression test asserts helper invocation; manual test #2 covers it |
| Wizard public submit now creates an invoice that didn't exist before — could surprise downstream queries | Audit existing query at `crud.js:699` (`SELECT FROM invoices WHERE proposal_id = $1 AND status IN ('sent','partially_paid')`) — verify behavior change is acceptable (wizard-submitted proposals now have an invoice row immediately, vs. only after admin click). Document in PR description. |
| Wrapping PATCH `/:id/status` in a new `BEGIN/COMMIT` changes its failure behavior | Today PATCH does the status UPDATE + activity-log INSERT without an explicit transaction. Wrapping them (so the invoice call can join) means a mid-sequence failure now rolls back the status change too — strictly safer. Regression covered by the PATCH tests in crud.test.js. |
| In-transaction `createInvoiceOnSend` failure rolls back the whole proposal create | Intended — that is the fix for the stranding bug. A failed invoice means no proposal persists, so the admin retry is a clean first create, not a duplicate. `createInvoiceOnSend` already accepts a txn client + is idempotent (`invoiceHelpers.js:345,349`). Covered by the invoice-rollback test. |
| Removing the `sent_at` email-skip re-emails on every `→sent` transition | Intended — `modified→sent` re-sends and later draft-promotions MUST email the client. This matches today's `PATCH /:id/status` behavior (no regression). The double-email-on-retry case the skip guarded against is now moot: the atomic create transaction means a retry either fully succeeded or fully rolled back. Covered by re-send tests (manual #10, crud.test.js modified→sent case). |
| Server twin of `proposalRules.js` drifts from client copy | Mirror the `eventTypes.js` discipline — short module, single source of constants imported by client AND server (via re-export pattern if feasible). Lint/test asserts shape parity. |
| Client-side rule bypass via direct POST | `validateProposalRules` on the server is authoritative. Tests cover the bypass attempt (POST direct hosted+10guests → 400). |
| Flavor Blaster auto-removal feels surprising in admin context | Toast notification is explicit; admin can re-add after fixing glassware |
| "Create & send" disabled-until-complete is a behavior change — admins used to creating partial drafts | "Save as draft" path covers this; tooltip explains why button is disabled |
| Shared rules module becomes a god-module | Functions are pure + small + well-named; if it grows past ~300 lines, split by concern (bundles, guardrails, filtering) |
| `ProposalDetailEditForm.js` still has inline `toggleAddon` and could drift from shared rules | Out of scope for this overhaul (see Non-goals). Follow-up issue tracks consolidation. |
| Admin POST rate-limit breaks bulk legitimate use (e.g. data import) | Limit is 30/min keyed by user.id — high enough for typical admin workflow. If a real bulk import need emerges, route around the limit (no UI submit) or raise the cap. |

## Future work (out of scope)

- Cockpit draft autosave (separate redesign)
- Admin "Send via SMS instead of email" toggle
- Scheduled sends ("send at 9am tomorrow")
- Custom message at create-time
- Migrate `bundleConfig.js` out of `pages/website/quoteWizard/` into `utils/` (small follow-up)
