# Client Portal v2 — Project Tracker

**Event Command Center redesign.** Living status doc for the whole client-portal
v2 effort: what is done, what is in design, and what still needs building.

> **How to use this:** the status table is the source of truth for progress.
> Each sub-project gets its own spec in `docs/superpowers/specs/` and its own
> worktree/branch when it goes to build. Update the Status column here as pieces
> move. Decisions already locked live in the Decisions Log so we do not relitigate.
>
> **Last updated:** 2026-06-11 · **Stage:** read-only foundation (2 + 3) AND editing model (5) shipped to prod 2026-06-05 (merge `9dc044f`). Worktree/branch `client-portal-editing` cleaned up 2026-06-11. Next up: day-of brief (#4).

---

## Where things stand (TL;DR)

- **v1 is live:** a deliberately thin, read-only portal. Passwordless OTP login,
  a "My Proposals" grid, invoice dropdowns, and a link out to the standalone
  `/proposal/:token` page. Two screens. See
  [`client-portal-design-reference.md`](./client-portal-design-reference.md) for
  the full current-state snapshot.
- **The Apothecary Press design system is already in place** (tokens swapped on
  `main`), so v2 is mostly new structure and surfaces, not a reskin from scratch.
- **v2 reimagines the portal as an event command center:** you land on your
  soonest event, with tabs for the proposal, drink plan, day-of brief, and
  receipts, plus a share link for handing any document to someone without a login.
- The work is **decomposed into 6 sub-projects**, built surface by surface, each
  its own spec → plan → worktree. **The v2 portal is live in prod:** the read-only
  foundation (#2 + #3, shell + Overview + the three tabs + share link) and the
  editing model (#5, change requests, model B) shipped 2026-06-05. The next build
  is the day-of brief (#4); the money-flow reskin (#1) has two small verify
  checkboxes open.

---

## Sub-projects (status overview)

| # | Sub-project | Status | Depends on | Spec |
|---|---|---|---|---|
| 1 | Money-flow reskin (Login · ProposalView · Invoice) | Mostly done on `main`, verify + reconcile | none | money-flow handoff (design bundle) |
| 2 | Portal shell + Overview (event command center) | **Done — shipped to prod 2026-06-05** (`0ff6057`) | none (backbone) | [spec](superpowers/specs/2026-06-04-client-portal-v2-foundation-design.md) · [plan](superpowers/plans/2026-06-04-client-portal-v2-foundation.md) |
| 3 | Read-only tabs (Prescription · Potion Plan · Receipts) + Share link | **Done — shipped to prod 2026-06-05** (`0ff6057`) | 2 | [spec](superpowers/specs/2026-06-04-client-portal-v2-foundation-design.md) · [plan](superpowers/plans/2026-06-04-client-portal-v2-foundation.md) |
| 4 | Day-of brief / "Big Experiment" tab | Decisions captured, build pending | 2, 3 | TBD |
| 5 | Editing model (additive-only + change requests) | **Done — merged `9dc044f`, shipped to prod 2026-06-05** | 3 | [spec](superpowers/specs/2026-06-05-client-portal-editing-model-design.md) · [plan](superpowers/plans/2026-06-05-client-portal-editing-model.md) |
| 6 | Messages tab (client ↔ office) | Parked (out of v1) | 2 | none |
| 7 | Multi-event switcher | Deferred (clients are one-at-a-time) | 2 | none |
| 8 | Quote-resume card (finish a draft) | Deferred (rare in practice) | 2 | none |
| 9 | In-portal actions (embed potion lab · in-tab invoice payment) | Deferred follow-on | 3 | none |

**Status legend:** Not started · In design · Design done (spec written) · In build · Done · Parked.

**Chosen build order:** **2 + 3 first** (the read-only foundation with the share
link), because it ships clients a real portal and forces us to nail the unified
data read everything else needs. Then **5** (editing) as its own money-grade spec,
with **4** (day-of) slotting in alongside. **1** runs in parallel whenever, it
blocks nothing. **6** is parked.

---

## Sub-project detail

### 1 · Money-flow reskin (Login · ProposalView · Invoice)
The three existing token-gated cash-path pages, skinned to Apothecary Press.
This is a CSS-only reskin: no route, endpoint, state-machine, or data-model
changes. The design bundle ships a disciplined, repo-aware handoff for it
(`design_handoff_money_flow/`).

- [x] Design system / tokens in `index.css`
- [x] Login (`ClientLogin.js`) themed on `main`
- [x] ProposalView themed on `main` (per current-state ref)
- [ ] **Verify** invoice page skin + print sheet against the latest handoff
- [ ] Reconcile: is the bundle's money-flow handoff a further refinement, or already applied? Confirm before treating as open work.

### 2 · Portal shell + Overview (event command center)
The new authenticated frame. Lands on the soonest upcoming event; multi-event
switcher when there is more than one; handles the between-events, quote-in-progress,
and brand-new states; countdown, procedure timeline, archive.

- [ ] **Unified "my stuff" read** — one payload pulling events, proposals, drink
      plans, invoices, quote drafts, and the assigned bartender. This is the one
      genuinely new backend piece; everything else hangs off it.
- [ ] Shell + header + event switcher
- [ ] Overview body (countdown, next-up engine, procedure timeline, at-a-glance summary)
- [ ] v1 scenarios: single upcoming event (the case), no upcoming event →
      archive + gentle prompt, brand-new → empty state. Render 2+ upcoming
      gracefully but plainly (no switcher yet).
- [ ] Past-event history / archive (read-only case files). First-class in v1.
- **Resolved:** client side is unified, one "my event" per proposal (booked or
  not). Admin keeps its own proposal/event split. Pre-booking renders as "not
  booked yet" + review-and-book CTA; post-booking as the command center.
- **Deferred (tracked as #7 / #8):** multi-event switcher, quote-resume.

### 3 · Read-only tabs + Share link
Prescription (proposal), Potion Plan (drink plan), and Receipts (invoices)
rendered as read-only in-portal tabs. Every action links out to the existing
standalone token page where that flow already works. Plus the share affordance.

- [ ] Prescription tab: read-only proposal render. "Review & book" and "pay
      balance" link out to `/proposal/:token`.
- [ ] Potion Plan tab: read-only summary of the plan. "Open the planner" links
      out to the standalone lab at `/plan/:token`.
- [ ] Receipts tab: invoices + payment history, read-only. Pay / print link out
      to `/invoice/:token`.
- [ ] **Share link:** surface the per-document public token as a "send this to
      someone" copy-link. Standalone token pages stay alive as the shareable surface.
- **Decided:** the foundation links out for all actions (protects the Stripe and
  sign-and-pay paths, ships the read portal fast). Re-homing actions in-portal is
  later work: booking and editing (#5), embed lab and in-tab payment (#9).
- Note: standalone pages and portal tabs render through the same presentation
  components, not two copies.

### 4 · Day-of brief / "Big Experiment" tab
What the client sees about the day itself, gated to unlock near the event (T-14).

- [ ] Bartender reveal: **preferred name + headshot only** (from
      `contractor_profiles`, already client-facing on the tip page). "Staffing
      subject to change" disclaimer.
- [ ] **No** bartender phone / direct contact. **No** client ↔ bartender messaging.
- [ ] Arrival line shows the **client-facing service window** plus generic copy:
      "staff arrive 30 to 90 minutes before, depending on the complexity of the
      event." Generic boilerplate, never the event's real `setup_minutes_before`.
- [ ] T-14 reveal gate (fogged preview before, live after); reads the **live**
      assignment so a later swap reflects.

### 5 · Editing model (additive-only + change requests)
The money subsystem. Lets clients adjust their booking within guardrails. Its
own full spec because it touches pricing, payments, the signed agreement, and
staffing. **Spec + implementation plan written 2026-06-05** ([design](superpowers/specs/2026-06-05-client-portal-editing-model-design.md) · [plan](superpowers/plans/2026-06-05-client-portal-editing-model.md)); **merged `9dc044f` and shipped to prod 2026-06-05.** v1 is the request-to-admin model; see the spec §2 for the locked decisions. Post-launch fix: readable admin change-request diff (field from/to instead of raw JSON, `e878541`).

- Three windows:
  - **Pre-booking:** free edit (no signature, no money yet). Runs through the quote/pricing engine.
  - **Booked, before T-14:** free **additive** edit (add a bar, bump guests, add an add-on; balance rises, no refund).
  - **Booked, inside T-14:** change **request** → admin approves (verifies staff availability) → cascade runs.
- **Removals / downgrades always route to admin**, in every window, because they touch refunds. Self-serve never triggers a refund.
- [x] Define what is client-editable vs admin-locked (guest count / add-ons / package = yes; manual discounts / custom line items = no). Allowlist enforced server-side in `server/utils/changeRequests.js`.
- [x] Re-price through `pricingEngine`, honoring the hosted-bartender ratio. Re-snapshot pricing. (Price preview persisted on the `proposal_change_requests` row at create time; admin edit re-runs the same path.)
- [x] Re-evaluate payment status on every change (never leave a stale "paid in full"). `PATCH /api/proposals/:id` runs the existing money + status reconciliation; `FOR UPDATE` apply read guards the reconciliation. **Merge decision A:** a `confirmed` booking is NOT demoted on an over-paid edit — `balance_paid` demotes to `deposit_paid`, but `confirmed` stays `confirmed` and the price delta is billed via the post-commit "Additional Services" invoice (locked by `server/routes/proposals/crud.demotion.test.js`).
- [x] Signature re-acknowledgment on a material change (new total, re-confirm, store new signed version). v1 dissolves this into the authenticated change-request as the consent record (`acknowledged_total`, `request_ip`, `request_user_agent` persisted on the row); the standalone re-sign flow stays designed-for-but-not-built per the locked spec decision.
- [x] Propagate event-detail changes to linked shifts. `syncShiftsFromProposal` now also reconciles `positions_needed`.
- [x] New `change_request` entity (pending / approved / declined / cancelled) + admin review screen + notifications. Table `proposal_change_requests` with one-pending-per-proposal partial unique index; admin dashboard at `/change-requests` and a `ProposalChangeRequestCard` on Proposal Detail; admin-alert and client-decision email + SMS via `server/utils/changeRequestNotifications.js`. `PATCH /api/proposals/:id` accepts `change_request_id` to stamp the row `approved` atomically with the edit and suppress the duplicate edit email. The archive/complete reaper auto-cancels open requests.
- **Open decision (the one we need before speccing):** confirmed direction is
  additive-only self-serve with removals to admin. If we ever allow self-serve
  removals before T-14, we must pick refund vs account credit. Parked as
  additive-only for now.

### 6 · Messages tab (parked)
Client ↔ office thread surfaced in-portal. The login page already advertises it.
Out of v1 unless promoted.

---

## Decisions Log

- **Two token systems, kept distinct.** Per-document UUID tokens (proposal, drink
  plan, invoice) are no-login magic links. The portal login (OTP → client JWT) is
  a separate gate. **Login guards the collection** (which events are mine); the
  **per-document token guards and shares each document.** Nothing in the security
  model changes; the portal work is presentational.
- **Share model.** The portal is the client's private home. The public token link
  is the "anyone with the link" share handle. A share button adds no new exposure
  because forwarding the existing email already grants the same access. The public
  token payload is an already-curated, client-safe allowlist (no admin notes,
  Stripe IDs, signature IP/UA, or crew timing). **Revoke is parked** (one token
  does double duty today; revisit only if a real leak story appears).
- **Day-of brief.** Preferred name + headshot + "subject to change." No contact,
  no direct messaging. Service window + generic 30-to-90-minute arrival copy, never
  the real setup time.
- **Editing (v1 = model B).** Every booked-event change routes through one
  request-to-admin flow; admin applies via the existing proposal editor. No
  client-driven money mutation in v1. Additive-only self-serve (model A) and
  one-click apply are the planned v2/v3 trajectory, designed-for but not built. T-14
  becomes a computed flag (fixed 14-day line), not a gate. Signature
  re-acknowledgment dissolves (the authenticated request is the consent record). See
  the [editing-model spec](superpowers/specs/2026-06-05-client-portal-editing-model-design.md).
- **Merge decision A (2026-06-05, `9dc044f`).** A `confirmed` booking is NOT
  demoted when an edit pushes the total past `amount_paid`. `balance_paid` still
  demotes to `deposit_paid`, but `confirmed` means the event is locked in; the
  price delta is collected via the post-commit "Additional Services" invoice
  rather than by reverting the lifecycle. Locked by
  `server/routes/proposals/crud.demotion.test.js`.
- **T-14 boundary rationale.** It is the same seam as bartender assignment: before
  ~2 weeks out nobody is committed, so changes are cheap and self-serve is safe;
  inside 2 weeks a specific human is assigned, so admin must verify availability.
- **Build order.** Read-only foundation (2 + 3) first, editing (5) next, day-of
  (4) alongside, money-flow (1) in parallel, messages (6) parked.
- **One event at a time.** Clients almost always have a single event and do not
  plan the next until the previous one wraps; we have never had a client with two
  pending events. v1 lands on that single event, defers the multi-event switcher
  and quote-resume (built graceful-but-plain, tracked as #7 / #8), and treats
  past-event history as a first-class v1 feature.
- **Foundation links out for all actions.** The read-only tabs display only;
  sign-and-pay, invoice payment and print, and the interactive potion lab stay on
  their standalone token pages and the tabs link to them. Protects the working
  money paths and ships the portal fast. Re-homing actions in-portal is later work:
  booking and editing (#5), embed lab and in-tab payment (#9).
- **Spec reviewed via `/review-spec` (2026-06-04); 3 blockers folded in.**
  (1) Proposal money is **dollars**, not cents (invoices are cents); format with
  separate helpers, never cross. (2) `cancelled` status no longer exists, it is
  `archived` + `archive_reason`; `accepted` is still valid. (3) `drink_plan_submitted`
  is derived from `drink_plans.submitted_at` via a join, not a real column. Schema
  facts captured for future work; verify proposal money/status against the latest
  migration, not the first CREATE. Confirmation re-run cleared all three and caught
  a third money unit (`proposal_payments.amount` is also cents, per the units block
  `schema.sql:538-547`), now folded in. Spec is plan-ready.

---

## Backend anchors (so we do not re-derive each session)

- **Client auth:** OTP via `clients.auth_token` (bcrypt hash, 15-min expiry).
  `POST /api/client-auth/request` + `/verify` → 7-day JWT `{ id, email, role:'client' }`.
  Stored in `localStorage` as `db_client_token`. Middleware: `clientAuth` in
  `server/middleware/auth.js`.
- **Portal API:** `server/routes/clientPortal.js`. `GET /client-portal/proposals`
  (list) and `GET /client-portal/proposals/:token` (rich detail, already returns
  add-ons + full payments history; the UI does not use it yet, so the detail tab
  needs **no new backend**). All scoped by `client_id = req.user.id`.
- **No `events` table.** A proposal is the same row for its whole life. "Event" =
  a booked proposal (`status IN ('deposit_paid','balance_paid','confirmed','completed')`);
  the admin proposals-vs-events split is just a status bucket over `proposals`
  (`proposals/crud.js`), not a separate entity. Upcoming = booked + future
  `event_date`; past / archive = past date or `completed` / `archived`;
  pre-booking = `draft` / `sent` / `viewed` / `modified` / `accepted`;
  quote-in-progress = `quote_drafts` (status `draft`, keyed by email). So the
  portal's unified read is: the client's proposals bucketed by status + their
  quote drafts + per booked proposal its drink plan, invoices, and assigned
  shift / bartender. No new entity needed.
- **Public token routes:** `GET /api/proposals/t/:token` (`proposals/publicToken.js`),
  `GET /api/drink-plans/t/:token` (`drinkPlans.js`), invoice token pages.
- **Cross-link:** the proposal payload carries `drink_plan_token`; the drink-plan
  payload carries `proposal_token`. One token reaches the other.
- **Gotcha:** `drink_plans` has **no `client_id`**, only a nullable `proposal_id`.
  Scope a portal drink-plan read by joining through the proposal. Pre-booking /
  standalone plans (null `proposal_id`) have no owning client (`drinkPlanAccess.js`,
  `isDrinkPlanPreBooking`).
- **Headshot source:** `contractor_profiles.headshot_file_url` + `preferred_name`,
  served via short-lived signed R2 URLs. Existing client-facing pattern lives in
  `server/routes/publicTip.js` (reuse it). Assignment path: shift → user →
  `contractor_profiles`.
- **Frontend:** `client/src/pages/public/ClientLogin.js`,
  `client/src/pages/public/ClientDashboard.js`,
  `client/src/components/InvoiceDropdown.js`, `ClientAuthContext`. Routes: `/login`
  or `/client-login` → `/my-proposals`.
- **Known small bug to fix in the redesign:** `InvoiceDropdown` status colors use
  `hsl(var(--ok-h) …)` / `--danger-h`, which are scoped to the staff-v2 theme and
  may not resolve on the public dashboard. Re-tokenize.

---

## Invariants (load-bearing, do not violate)

- **Crew / setup timing is never client-facing.** `setup_minutes_before` and any
  derived display stay back-of-house (documented in `proposals/publicToken.js`).
  The day-of brief shows a generic arrival range, not the real value.
- **Money units split by table, never crossed.** `proposals.total_price` /
  `amount_paid` / `total_price_override` and `proposal_addons` are NUMERIC
  **dollars**; `invoices.*`, `proposal_payments.amount`, and `stripe_sessions.amount`
  are integer **cents** (authoritative map: `schema.sql:538-547`). Pricing math runs
  through `server/utils/pricingEngine.js`; respect the hosted-bartender ratio (1:100)
  on every re-price.
- **Additive-only protects the payment path.** Self-serve edits never trigger a
  refund; removals route to admin.
- **The public token is a bearer credential.** Possession equals access, no expiry,
  no revoke today. Sharing it is a deliberate, accepted property.

---

## Reference artifacts

- **Current-state snapshot:** [`docs/client-portal-design-reference.md`](./client-portal-design-reference.md)
- **Design bundle (external, design tool output):**
  `C:\Users\dalla\Downloads\Dr Bartender Marketing (8)\`
  - `client-portal-v3.html` + `apothecary/portal-v2/*.jsx` — the v2 event-command-center mock (Overview, Prescription, Potion Plan, Big Experiment, Receipts tabs)
  - `design_handoff_money_flow/` — the disciplined Login/Proposal/Invoice reskin handoff
- **Specs:** `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` (one per sub-project, linked in the table above as they are written)
