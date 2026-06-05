# Client Portal Editing Model — Design Spec

**Sub-project #5 of the Client Portal v2 effort** (see `docs/client-portal-v2-project.md`).
The money subsystem: lets a client adjust a booking within guardrails.

- **Date:** 2026-06-05
- **Stage:** design done, plan pending
- **Depends on:** #3 read-only foundation (merged to `main` `0ff6057`)
- **Money/legal grade:** touches pricing, payments, the signed agreement, and staffing. Max-effort review applies.

---

## 1. Goal

Give a logged-in client a way to ask for changes to their booking (guest count,
add-ons, package, bars, bartenders, duration, date, time, venue) without ever
letting client action directly move money or mutate the signed contract. Every
change is expressed as a structured, apply-ready request that an admin reviews
and applies through the existing, battle-tested proposal-edit path.

The design is deliberately minimal for v1 ("in, safe, and working") but is shaped
so two known future upgrades graft on without a rewrite:

- **v2:** one-click "approve and apply" (admin clicks once, the system applies the
  request through an extracted edit service).
- **v3:** self-serve additive edits (the client applies an additive-only change
  directly, no admin in the loop), the "model A" direction.

---

## 2. Decisions locked (during brainstorm)

1. **Model B, not A, for v1.** No new client-driven money-mutating write path.
   Every booked-event change routes through one request-to-admin flow. The client
   never directly mutates `total_price`, the pricing snapshot, invoices, or Stripe.
2. **Manual apply for v1 (option 1), not one-click (option 2).** An approved
   request is applied by admin through the existing `PATCH /api/proposals/:id`
   editor (the trusted path), with the requested values pre-loaded so there is no
   re-typing. No programmatic auto-apply engine is built in v1.
3. **One unified flow across all three windows.** Pre-booking, before-T-14, and
   inside-T-14 are the same "request to admin" mechanism. The window is a computed
   flag that flavors client copy and tells admin whether to verify staffing first.
   T-14 is not a gate.
4. **The boundary is a fixed 14-day date line**, computed from `event_date` versus
   today. It is NOT tied to actual bartender-assignment state, because the
   auto-assign seam is not reliably wired (the per-shift `auto_assign_days_before`
   defaults to 3 and is never populated on booked shifts, so booked events do not
   auto-assign today). We do not touch or rely on the assignment scheduler here.
5. **Three editability tiers.** Structured with a live price preview: guest count,
   add-ons (add or remove), package, number of bars, number of bartenders, event
   duration, event date, start time, venue. Admin-locked and never exposed: manual
   discounts, custom line items, total-price override. Plus a free-text note on
   every request. Reductions and downgrades are allowed as requests; admin makes
   the refund-or-credit call, and nothing auto-refunds.
6. **Signature re-acknowledgment dissolves under B.** The authenticated,
   timestamped, total-acknowledged change request is itself the consent record. We
   do NOT re-present the agreement or build a signature-history table. The signed
   master agreement already states that pricing adjusts when the booking changes.
7. **Two pre-existing gaps are in scope** (they are exercised hard by this
   feature): staffing sync of `positions_needed` on guest-count change, and
   extending the payment-status demotion to cover `confirmed`. The central
   payment-status-helper extraction is deferred (only strictly needed for the
   v2 one-click path).

---

## 3. Data model

One new table. Naming follows `proposal_addons` / `proposal_payments` /
`proposal_activity_log`.

```sql
CREATE TABLE IF NOT EXISTS proposal_change_requests (
  id                 SERIAL PRIMARY KEY,
  proposal_id        INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  client_id          INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','declined','cancelled')),
  edit_window        VARCHAR(20) NOT NULL
                       CHECK (edit_window IN ('pre_booking','before_t14','inside_t14')),
  requested_changes  JSONB NOT NULL DEFAULT '{}',   -- sparse diff, shaped like an admin PATCH body
  note               TEXT,                          -- client free-text "anything else"
  price_preview      JSONB NOT NULL DEFAULT '{}',   -- { current_total, estimated_total, delta, staffing:{current,estimated} } DOLLARS
  acknowledged_total NUMERIC(10,2),                 -- server-computed estimate the client saw and accepted (dollars)
  decided_by         INTEGER REFERENCES users(id),
  decided_at         TIMESTAMPTZ,
  decision_note      TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- one open request per proposal (mirrors quote_drafts' partial-unique-per-email)
CREATE UNIQUE INDEX IF NOT EXISTS idx_pcr_one_open
  ON proposal_change_requests(proposal_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pcr_status   ON proposal_change_requests(status);
CREATE INDEX IF NOT EXISTS idx_pcr_proposal ON proposal_change_requests(proposal_id);
```

All statements idempotent (`IF NOT EXISTS`) per the schema convention. `edit_window`
avoids the SQL reserved word `window`.

### 3.1 States

`pending` is the only open state. Terminal transitions:

- `pending -> approved`: admin applied the change (see 5.2).
- `pending -> declined`: admin refused; reason in `decision_note`.
- `pending -> cancelled`: client withdrew before a decision.

The partial-unique index blocks only a second `pending` row, so a client may open
a fresh request once the prior one resolves. Every transition writes a
`proposal_activity_log` row so the audit trail lives where signing and viewing
already log: `change_requested` (`actor_type='client'`), `change_approved` and
`change_declined` (`actor_type` = the admin/manager).

### 3.2 The payload (`requested_changes`)

A sparse diff holding only the fields the client changed, in exactly the shape the
admin PATCH body already accepts (`crud.js:416-424`): any of `event_date`,
`event_start_time`, `event_duration_hours`, `venue_name`, `venue_street`,
`venue_city`, `venue_state`, `venue_zip`, `guest_count`, `package_id`, `num_bars`,
`num_bartenders`, `addon_ids`, `addon_variants`, `addon_quantities`.

The client submits a full proposed end-state (the wizard inputs). The server diffs
it against the current proposal, stores only the changed fields as
`requested_changes`, and that JSON is the apply-ready artifact:

- **v1:** admin reads it and applies by hand (pre-loaded into the editor).
- **v2:** the same JSON is fed to the extracted edit service for one-click apply.
- **v3:** an additive-only diff is what a self-serve client submits directly.

Discounts, custom line items, and `total_price_override` never appear in the
payload.

### 3.3 Consent and preview

The client's number is never trusted. On submit the server:

1. Loads the current proposal inputs, overlays the proposed end-state.
2. Re-runs `validateProposalRules` + `stripIncludedAddons` (server-authoritative,
   same as the admin PATCH and the public submit), rejecting a tampered or
   stale request.
3. Runs `calculateProposal` on the overlaid end-state.
4. Stores the server-computed estimate as both `price_preview` (current total,
   estimated total, delta, staffing before/after) and `acknowledged_total`.
5. Computes `edit_window`.

That stored, authenticated, timestamped row is the consent artifact that stands in
for signature re-acknowledgment.

`edit_window` is computed as: `pre_booking` when the proposal is not booked (status
not in the booked set `deposit_paid` / `balance_paid` / `confirmed` / `completed`,
per `clientPortal/summary.js:4`); otherwise `inside_t14` when `event_date` is 14
days or fewer from today, else `before_t14`. A request may be opened only against
the client's non-archived, non-completed proposals.

---

## 4. Client flow and API

### 4.1 Surface

A "Request a change" action on the event's Overview / Prescription tab in the
portal. It opens the existing quote-wizard inputs, pre-filled with the current
booking. The client adjusts any structured field; a live panel shows
`current total -> estimated new total` with the delta. Optional note, then submit.

Portal states:

- **No open request:** the button is live.
- **Submitted:** confirmation, "Request sent. We'll confirm shortly."
- **Pending:** the event shows a "Change requested, pending review" banner that
  summarizes what was asked and the estimated total; the button becomes "View or
  withdraw request." Backed by the partial-unique index.
- **Decided:** approved shows "Your changes are in" with the updated balance;
  declined shows the admin's reason and a contact prompt.

Copy guardrails (no em dashes, neutral tone): reductions and downgrades are
allowed as requests with "reductions are reviewed by our team; any refund is
handled individually"; date changes carry a "subject to availability" line.
Discounts, custom lines, and override are never shown. Crew/setup timing is never
shown (it is not among the wizard inputs).

### 4.2 Client API

All under `clientAuth`, every query scoped `WHERE proposals.client_id = req.user.id`
(the portal's existing token + client_id IDOR guard).

- `POST /api/client-portal/proposals/:token/calculate` — pricing preview for the
  in-progress edits. Wraps `calculateProposal`; authenticated and scoped, so we do
  not lean on the public `/api/proposals/public/calculate` endpoint.
- `POST /api/client-portal/proposals/:token/change-requests` — create. Body: the
  proposed end-state plus `note`. The server diffs, validates, recomputes the
  estimate, computes `edit_window`, enforces one-open-per-proposal, stores
  `price_preview` + `acknowledged_total`, logs `change_requested`, and notifies
  admin (see 7).
- `GET /api/client-portal/proposals/:token/change-requests` — the open request plus
  history for this proposal.
- `POST /api/client-portal/proposals/:token/change-requests/:id/cancel` — client
  withdraws a pending request.

The create path takes `SELECT ... FOR UPDATE` on the proposal (matching the status
endpoint's concurrency pattern at `lifecycle.js:65-67`); the partial-unique index
is the backstop against a double-submit race.

---

## 5. Admin flow and API

### 5.1 Surface

A pending-requests queue (rows with `edit_window = 'inside_t14'` flagged urgent
with a "verify staffing first" reminder), and the same open request surfaced on
the existing Proposal Detail page (`client/src/pages/admin/ProposalDetail.js`)
where admin already works.

The review surface shows:

- Client, event, and `edit_window`.
- The field-by-field diff (current vs requested).
- A freshly recomputed price-and-staffing preview (recomputed at review time
  because base data may have shifted since the request), with the client's
  `acknowledged_total` shown alongside and flagged when they diverge.
- The client's note.

### 5.2 Apply and decline

- **Apply in editor** deep-links to the proposal edit screen pre-filled with
  `requested_changes`. Admin reviews and saves through the existing
  `PATCH /api/proposals/:id`, which already re-prices, re-snapshots
  (`pricing_snapshot` + `total_price`), full-replaces `proposal_addons`, demotes
  payment status, cuts the "Additional Services" invoice for a positive delta, runs
  the reschedule cascade, and syncs the linked shift. No auto-apply engine: admin
  drives the real editor, just without re-typing. For a negative delta the screen
  reminds admin to handle any refund through existing refund tooling; nothing
  auto-refunds.
- **Decline** with a required reason (`decision_note`); notifies the client.

**Approve linkage.** The existing `PATCH /api/proposals/:id` gains an optional
`change_request_id`. When present, after the edit commits the handler stamps that
request `approved` + `decided_by` + `decided_at` in the same transaction. This
keeps apply-and-approve atomic (no "edited but forgot to mark approved" drift) and
is the only change to the sensitive handler, fully gated on the param. In v2,
"Apply in editor" becomes "Approve and apply" once the edit logic is extracted to a
callable service; the request shape and review screen are unchanged.

### 5.3 Admin API

All under `auth, requireAdminOrManager`.

- `GET /api/proposals/change-requests?status=pending` — the queue.
- `GET /api/proposals/:id/change-requests` — one proposal's requests (feeds the
  detail surface).
- `POST /api/proposals/change-requests/:id/decline` — decline with reason, notifies
  client.
- Approve happens via the `change_request_id` param on `PATCH /api/proposals/:id`
  (5.2), not a standalone approve endpoint, so apply and approve cannot drift.

---

## 6. The two in-scope fixes

### 6.1 Staffing sync (`positions_needed`)

Today `syncShiftsFromProposal` (`server/utils/eventCreation.js:181-237`, called
from `crud.js:648` inside the PATCH transaction) updates the linked shift's date,
time, location, and setup minutes, but never `positions_needed`. A guest increase
that should add a bartender updates `proposals.num_bartenders` (PATCH persists
`snapshot.staffing.actual` at `crud.js:583`) yet leaves the shift stuck at its old
slot count. This is the CLAUDE.md "event detail change -> update shifts"
cross-cutting rule, half-implemented.

Fix: in the single-shift case `syncShiftsFromProposal` already handles, reconcile
`positions_needed` to `num_bartenders` (building `Array(n).fill('Bartender')`, the
same shape `createEventShifts` uses at `eventCreation.js:127-128`):

- **Growth:** add `Bartender` slots up to `num_bartenders`.
- **Shrink:** never silently drop an already-approved assignment. If the new count
  falls below the number of `approved` `shift_requests`, cap `positions_needed` at
  that approved count and flag for admin, because removing an assigned person is a
  human decision.

Stays inside the existing PATCH transaction. Multi-shift events (the `n !== 1`
guard) remain admin-managed, unchanged.

### 6.2 Demotion gap

The price-increase demotion at `crud.js:603-621` only fires for
`status = 'balance_paid'`, demoting to `deposit_paid` and clearing autopay. A
`confirmed` proposal whose new total exceeds `amount_paid` is not auto-corrected.

Fix: extend the condition so it also fires for `confirmed`, demoting to
`deposit_paid` and clearing `autopay_enrolled` / `autopay_status` exactly as today,
so an admin-applied increase cannot trigger an autopay re-charge off the saved
card. `completed` is intentionally left untouched: a past event is settled, and
demoting it to "awaiting deposit" would be wrong; that edge stays admin-manual.

Both fixes get a focused test, run in isolation given the shared dev/test DB.

---

## 7. Notifications

Email-first (SMS costs money; default to email).

- **Request created -> admin:** email to `ADMIN_EMAIL` always (the diff, estimated
  total, and window). For `edit_window = 'inside_t14'` only, also an SMS to
  `ADMIN_PHONE` when set, reusing the last-minute-alert pattern (unset -> SMS
  skipped, email still fires). Those are the time-critical, staffing-at-stake
  requests.
- **Decision -> client:** email only. Approved: "Your changes are confirmed," the
  updated total and new balance, a portal link. Declined: the reason plus a contact
  invite. The existing `sendEmail` default `Reply-To` (`ADMIN_EMAIL`) means client
  replies land in a monitored inbox.

Templates live in the `lifecycleEmailTemplates` module (the per-domain sibling-file
pattern alongside `emailTemplates.js`). All sends respect the existing
`SEND_NOTIFICATIONS` / `NODE_ENV` gating. Staff web-push on new requests is a
deferred nicety, not v1.

---

## 8. Invariants (load-bearing, do not violate)

- **Money units.** The entire change-request layer (`acknowledged_total`,
  `price_preview`, the proposal re-price) is in **dollars**, matching
  `proposals.total_price` / `amount_paid` / `proposal_addons` (NUMERIC dollars,
  authoritative map at `schema.sql:538-547`). Cents appear only when admin's PATCH
  settles through the invoice layer, which already converts via `toCents`. Never
  cross the two.
- **Hosted-bartender 1:100 ratio** is honored automatically, since both the preview
  and the apply run `calculateProposal` (`isHostedPackage` + `staffing.required`).
- **Additive-only protects the payment path.** Nothing self-serve ever auto-refunds.
  Removals are admin-applied; refund vs credit is admin judgment. (In v1 everything
  is admin-applied, so this holds trivially.)
- **Crew/setup timing is never client-facing.** `setup_minutes_before` and any
  derived display never appear in the form or preview (and are not among the wizard
  inputs).
- **Two token systems stay distinct.** The change-request flow is authenticated
  (portal OTP -> client JWT). It is separate from the public per-document share
  token, and adds no new exposure.
- **Event identity.** Client name and event type stay separate; no title
  concatenation; display via `getEventTypeLabel`. (Event type is not in the common
  edit set; if ever exposed, follow the rule.)
- **IDOR.** Every client route scoped by `client_id`; admin routes role-guarded.
- **Concurrency.** The create and apply paths take `SELECT ... FOR UPDATE` on the
  proposal; the partial-unique index kills double-submit.

---

## 9. Out of scope (explicit, v1)

- Programmatic one-click "approve and apply" (option 2). Deferred; the design is
  forward-compatible.
- Self-serve direct mutation (model A / v3). Deferred.
- The central payment-status-helper extraction (gap #3). Deferred; only strictly
  needed when the v2 one-click path lands.
- A signature re-acknowledgment history table. Dissolved: the authenticated request
  is the consent record.
- Staff web-push on new requests.
- Any refund automation. Refund vs credit on a removal is always admin-manual.
- Wiring the real auto-assign seam or making T-14 an assignment-state boundary. We
  use a fixed 14-day date line.
- Multi-event switching and quote-resume (tracked separately as #7 / #8).

---

## 10. Build batches (head start for the plan)

1. Schema: the `proposal_change_requests` table (idempotent). The new
   `proposal_activity_log` actions (`change_requested`, `change_approved`,
   `change_declined`) are plain strings logged from code, no schema change. Docs:
   ARCHITECTURE schema section.
2. Shared `server/utils/changeRequests.js`: `edit_window` computation, the
   overlay-and-validate-and-price helper (reused by client create and admin
   review), and the `price_preview` builder. Plus the authenticated portal
   calculate endpoint.
3. Client API (create / list / cancel) + the portal `ChangeRequestForm` (reusing
   wizard inputs) + the status banners.
4. Admin API (queue / decline + the `change_request_id` approve-linkage on PATCH) +
   the review screen + the Proposal Detail surface.
5. Notifications: admin email + inside-T-14 SMS; client decision emails; templates
   in `lifecycleEmailTemplates`.
6. The two fixes (6.1 `positions_needed` sync, 6.2 demotion extension) + focused
   tests run in isolation.
7. Docs sweep: README folder tree (new route files), ARCHITECTURE route table and
   schema, and flip the tracker's #5 status.

Each batch is independently reviewable and revertable. The project runs in its own
worktree/branch off `main`.

---

## 11. Backend anchors (so the plan does not re-derive)

- **Admin edit path (the apply target):** `PATCH /api/proposals/:id`,
  `server/routes/proposals/crud.js:415-763`. Editable fields destructured at
  `crud.js:416-424`. Re-price + re-snapshot at `crud.js:554-566`; add-on full
  replace at `crud.js:624-637`; payment demotion at `crud.js:603-621`; shift sync
  call at `crud.js:648`; invoice cascade (post-commit) at `crud.js:669-684`.
- **Pricing engine:** `server/utils/pricingEngine.js`, entry `calculateProposal`
  (`:180-387`), staffing `calculateStaffing` (`:91-125`). Pure, no DB.
- **Validation:** `validateProposalRules` + `stripIncludedAddons` in
  `server/utils/proposalRules.js` (server-authoritative; the public submit uses
  them at `public.js:310-324`).
- **Shift sync:** `syncShiftsFromProposal` (`server/utils/eventCreation.js:181-237`);
  shift creation `createEventShifts` (`:97-163`). Shift staffing lives in
  `shifts.positions_needed` (JSON array of role strings); assignment is N
  `shift_requests` rows with `status='approved'`.
- **Status state machine:** `server/routes/proposals/lifecycle.js:29-40`;
  `FOR UPDATE` pattern at `:65-67`. `modified` is a designed-but-unused enum slot
  (no writer today); we do NOT reuse it for change requests.
- **Money map:** `schema.sql:538-547` (dollars vs cents by table);
  `proposals.total_price` / `amount_paid` / `proposal_addons` are NUMERIC dollars;
  `invoices.*` / `proposal_payments.amount` / `stripe_sessions.amount` are cents.
- **Signature (consent context):** single-row, overwrite-only on `proposals`
  (`client_signed_*`, `client_signature_*` at `schema.sql:869-875`), hard-gated
  against re-signing at `publicToken.js:206-207`. Admin edits never touch it.
  Agreement text: `client/src/data/eventServicesAgreement.js`; version allowlist
  `server/utils/agreementVersions.js`. We add no signature storage.
- **Client auth + portal:** `clientAuth` (`server/middleware/auth.js:79-93`), JWT
  `{ id, email, role:'client' }`, `req.user.id === clients.id`,
  `proposals.client_id -> clients.id`. Read-only portal today:
  `server/routes/clientPortal.js` (+ `clientPortal/summary.js`).
- **Activity log:** `proposal_activity_log` (`schema.sql:857-865`), free-form
  `details` JSONB; signing/viewing already log here.
- **Notifications:** `sendEmail` / `sendSMS` gated by `SEND_NOTIFICATIONS` /
  `NODE_ENV`; last-minute admin SMS precedent uses `ADMIN_PHONE`.

---

## 12. Risks and things to verify during build

- **Stale preview at review.** Base data (package rates, addon catalog) can change
  between request and review. Mitigated by recomputing the preview at review time
  and flagging divergence from `acknowledged_total`. Admin always sees the fresh
  number before applying.
- **Date change crossing the last-minute window.** A requested date change can pull
  the event inside the full-payment-required window. The existing reschedule and
  `bookingWindow` logic already handles `last_minute_hold` on the admin apply; the
  request layer only records intent.
- **Drift between request and applied edit (v1 manual apply).** Mitigated by
  pre-loading `requested_changes` into the editor and the atomic
  `change_request_id` approve-linkage. Residual risk if admin hand-edits the
  pre-loaded values; acceptable for v1 and removed entirely by v2 one-click.
- **Package change is the heaviest structured edit** (different per-guest rate,
  inclusions, staffing). It is previewable through `calculateProposal` like any
  other input, but warrants extra admin attention; the review screen shows the full
  recomputed staffing so the impact is visible.
- **Drink plan linkage.** `drink_plans.proposal_id` is nullable and there is no
  `client_id`; an add-on or guest change does not touch the drink plan menu here.
  Out of scope for editing; noted so it is a conscious omission.
