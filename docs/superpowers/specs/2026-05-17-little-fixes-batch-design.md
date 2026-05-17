# Little Fixes Batch — Design Spec

**Date:** 2026-05-17
**Status:** Approved — proceed to implementation plan
**Scope:** Four independent small fixes, batchable. No money/pricing/auth/Stripe surface touched.

## Summary

Four unrelated low-risk fixes collected into one plan, executable in one pass or as three
independent batches. Each fix has a locked root cause and a known minimal change. One
systemic issue surfaced during debugging is explicitly **parked** (see Out of Scope).

---

## Fix #1 — Tip QR sign shows headshot placeholder instead of the photo

**Symptom:** The bartender tipping QR sign renders the "Your Headshot / upload at sign-up"
placeholder instead of the bartender's uploaded headshot.

**Root cause (traced by direct code reading — no ambiguity):**
- `client/src/pages/staff/PrintTipCard.layouts.jsx` — `HeadshotFrame({ size, src })` shows the
  placeholder whenever `src` is falsy (lines ~157–192). It is called with **no `src`** in
  `FourBySixA` (~line 429) and `FiveBySevenA` (~line 554).
- `client/src/pages/staff/PrintTipCard.jsx` fetches `/me/tip-page` and never receives a
  headshot to pass down (passes only `name`, `tipUrl`).
- `server/routes/me.js` `/me/tip-page` handler does **not** `SELECT` or return
  `contractor_profiles.headshot_file_url`.

**Change:**
1. `server/routes/me.js` — add `headshot_file_url` to the `/me/tip-page` query and return a
   **usable URL**. The stored value is a path like `/files/{filename}`; a raw path will not
   render. Reuse the existing signed-R2-URL generation already used by
   `server/routes/publicTip.js` (`GET /api/public/tip/:token`) so the same code path produces
   the displayable URL. Do not duplicate the signing logic — reuse/extract the existing
   helper. Endpoint is already scoped to the authenticated bartender (`req.user`), so no IDOR
   surface; no new query param.
2. `client/src/pages/staff/PrintTipCard.jsx` — extract the headshot URL from the response and
   pass it as a prop to the layout components.
3. `client/src/pages/staff/PrintTipCard.layouts.jsx` — accept the prop and pass it as `src`
   to **every** `HeadshotFrame` usage: `FourBySixA`, `FiveBySevenA`, and the business-card
   front/back layouts if they render a headshot. Verify all layouts during implementation.

**Cross-cutting:** `/api/public/tip/:token` (public scan page) already does this correctly —
**do not change it**. The fix is to bring `/me/tip-page` to parity. Confirm no other consumer
of `/me/tip-page` breaks on the added response field (additive change — safe).

**Risk:** Low. Read-only, the bartender's own data, additive response field.

---

## Fix #2 — Quote wizard: "skip extras" control near top

**Symptom:** The extras step of the quote wizard is a long page with no fast way past it.
Keep it for upsell, but add a skip control at the top.

**Root cause:** Not a bug — missing affordance.

**Relevant code:**
- `client/src/pages/website/quoteWizard/QuoteWizard.js` — `tryAdvance()` (~lines 538–580)
  performs validation → draft save → `setStep(nextStep)`. The `addons` step has **zero**
  validation (`case 'addons': return [];` ~line 528).
- `client/src/pages/website/quoteWizard/steps/ExtrasStep.js` — top content is the intro card
  header (~lines 20–25); insert the skip control after the intro paragraph.

**Change:**
1. `QuoteWizard.js` — add a small `skipExtras` handler that mirrors `tryAdvance`'s
   draft-save + `setStep` path **minus validation** (and clears error/field-error state as
   `tryAdvance` does). Pass it to `ExtrasStep` as a prop.
2. `ExtrasStep.js` — render a skip button near the top (after the intro paragraph), styled
   to match existing wizard buttons (`btn btn-secondary` family). Label consistent with
   existing wizard "skip" language.

**Cross-cutting:** Skip is **lossless** — it must NOT clear `form.addon_ids`; the user can
return via the stepper/Back. No backend validation blocks empty addons at submit. Draft
persistence must run on skip (same as `tryAdvance`).

**File size:** `QuoteWizard.js` is ~867 lines (already over the 700 soft warning, under the
1000 hard limit). The added handler is ~6 lines — acceptable; do not expand further. No
opt-out marker needed.

**Risk:** Low. Frontend only.

---

## Fix #3 — Shopping list overlay punched through by a textarea (debugged)

**Symptom:** Opening the admin shopping list (from `DrinkPlanDetail`) shows the overlay in
front, but the page's "Admin notes" `<textarea>` renders **on top of** the overlay.

**Root cause (full systematic-debugging investigation — the prior explore-agent explanation
was wrong and is recorded here so it is not repeated):**

The agent claimed the modal was "trapped in the scrollable `.main` because it isn't portaled."
That is incorrect: `overflow: auto` does **not** create a stacking context and does **not**
trap `position: fixed`. If it did, the whole page would punch through, not one textarea.

Actual cause — `client/src/index.css:217`:

```css
.card > * { position: relative; z-index: 1; }
```

`ShoppingListButton` is rendered at `DrinkPlanDetail.js:185`, inside the `.card` opened at
`DrinkPlanDetail.js:158`. The `.card > *` rule makes that card's child a **z-index:1
stacking context**. The modal's inline `position: fixed; z-index: 1000`
(`ShoppingListModal.jsx` ~line 244) escapes scrolling but **cannot escape a stacking
context** — its `1000` is confined inside a z-index:1 box. The "Admin notes" card
(`DrinkPlanDetail.js:248`) is a **later sibling** whose `.card-body` is also a z-index:1
stacking context. Equal z-index → later DOM element paints on top → the textarea covers the
trapped modal. This is exactly why only that one card punches through while the rest of the
page correctly sits behind the backdrop.

**Consequence:** Raising the modal's z-index does **not** fix it (still trapped). The only
correct fix is to escape the stacking context via a portal — which is precisely why the
existing `KebabMenu` component (which `createPortal`s to `document.body`) does not have this
bug.

**Change:**
1. `client/src/components/ShoppingList/ShoppingListModal.jsx` — render the modal via
   `createPortal(<modal/>, document.body)`. No z-index changes.
2. `client/src/components/ShoppingList/ShoppingListButton.jsx` — the sibling guest-count
   prompt (~lines 114–144) is the **same flow, same file, same root cause** (inline
   `position: fixed; z-index: 1000`, not portaled). Portal it too. This is fixing the root
   cause of the reported feature, not gold-plating.

**Cross-cutting / pattern (recorded, NOT in this batch):** Any inline-`position:fixed`
overlay rendered as a descendant of a `.card` has this identical latent defect from
`index.css:217`. Known instances: `ConsultationForm`, `InterviewScheduleModal`,
`PackageIncludesModal`, `RejectModal`, `AssignToEventModal`, `AdminUserDetail` backdrop. See
Out of Scope.

**Risk:** Low. Frontend only. Portal-to-body matches the existing working `KebabMenu`
pattern.

---

## Fix #4a — Remove "Green Chartreuse" from offered extras

**Decision:** Option A (surgical). There is no standalone "Green Chartreuse" extra — it is
one word inside the bundled `specialty-niche-liqueurs` ("Specialty Liqueurs") add-on
description. Remove only the words "green Chartreuse, " from that description; keep the
add-on and its other liqueurs (Cointreau, maraschino, amaretto, orgeat, absinthe, rye
whiskey, coffee liqueur).

**Source of truth:** DB-backed. `service_addons` table; seed at `server/db/schema.sql:687`
(`INSERT ... ON CONFLICT (slug) DO NOTHING`). The wizard reads it via
`GET /addons` (`server/routes/proposals/metadata.js`, `WHERE is_active = true`).

**Change:** `server/db/schema.sql`
1. Edit the seed `INSERT` description text to drop "green Chartreuse, ".
2. Because the seed is `ON CONFLICT DO NOTHING`, editing it does **not** update the
   already-seeded production row. Add an **idempotent `UPDATE`** in `schema.sql` (in the
   migrations/idempotent section) that rewrites the description for
   `slug = 'specialty-niche-liqueurs'`. Idempotent and safe to run repeatedly.

**Cross-cutting:** Cocktail recipe descriptions that mention green Chartreuse (e.g. "Last
Word") are recipes, not add-on availability — unaffected here (but see #4b). Historical
proposals are unaffected: `proposal_addons` snapshots name/rate at creation; no FK break
because the add-on row is not deleted.

**Risk:** Low. Content/data only.

---

## Fix #4b — Remove the "Last Word" cocktail from the menu

**Decision:** Confirmed — "Last Word can go."

**Source of truth — RESOLVE FIRST (plan's first sub-step):** "Last Word" appears in both
`server/db/schema.sql` (~line 441 description; ~line 1836 `upgrade_addon_slugs`) and
`client/src/pages/plan/data/cocktailMenu.js:43`. The implementation plan's first step for
this fix is to determine which actually drives the client/admin cocktail picker (DB
`cocktails` table vs the static client data file) and remove/deactivate it there:
- If DB-backed with an `is_active`-style flag → soft-disable + idempotent `UPDATE`.
- If the static `cocktailMenu.js` file drives it → remove the entry.

**Cross-cutting (consistency rule — update everything that depends on it):**
- `client/src/pages/plan/data/drinkUpgrades.js:98` — smoke-bubble pitch for "Last Word".
  Remove it; an upgrade pitch for a removed cocktail is dead/incorrect.
- The Last Word row's `upgrade_addon_slugs = '{specialty-niche-liqueurs}'` becomes moot once
  the cocktail is gone — no separate action needed if the row is removed/deactivated.
- Historical proposals/plans that already selected "Last Word" must not be corrupted —
  verify the same denormalization safety as #4a (display from snapshot, not by live join).

**Risk:** Low. Content/data only.

---

## Batching Strategy

All four are independent (no shared files, no ordering constraints). Recommended split for
safe incremental shipping; may also run as a single pass.

- **Batch A — pure frontend, zero backend:** #2 + #3. Lowest risk, ship-fast.
- **Batch B — full-stack, isolated:** #1. Requires the API server healthy (see Preconditions).
- **Batch C — content/data:** #4a + #4b. DB-content edits + cross-cutting cleanup.

Each batch is independently shippable, reviewable, and revertible.

## Preconditions / Notes

- The background API server on `:5000` failed to start (exit 1) during this session.
  Not blocking for planning or for Batch A. **Must be healthy before executing/verifying
  Batch B (#1)** since it touches `server/routes/me.js`. Diagnose separately if it persists.

## Out of Scope (explicitly parked)

- **Systemic modal-portal sweep.** The `index.css:217` `.card > * { z-index: 1 }` rule
  traps every non-portaled inline-`position:fixed` overlay rendered inside a `.card`.
  Latent instances: `ConsultationForm`, `InterviewScheduleModal`, `PackageIncludesModal`,
  `RejectModal`, `AssignToEventModal`, `AdminUserDetail` backdrop. Remediation (portal them
  to body, or introduce a shared portal/`<Modal>` helper) is a deliberate separate task —
  it touches battle-tested modals and must not be bundled with these quick fixes.
- **`:5000` server startup failure** — separate diagnostic, not part of this batch.
