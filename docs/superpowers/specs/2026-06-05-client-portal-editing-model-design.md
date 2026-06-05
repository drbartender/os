# Client Portal Editing Model: Design Spec

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
   To make that record defensible we capture `request_ip` + `request_user_agent` on
   the row (parity with the original signature) and accept the legal posture
   explicitly in §13. A conscious business decision, not a default.
7. **Three pre-existing gaps are in scope** (this feature exercises them hard):
   (a) staffing sync of `positions_needed` on guest-count change; (b) extending the
   payment-status demotion to cover `confirmed`; (c) locking the apply path's
   proposal read with `FOR UPDATE` so (b) cannot demote off a stale, webhook-raced
   read. The central payment-status-helper extraction stays deferred (only strictly
   needed for the v2 one-click path). Detail in §6.

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
  requested_changes  JSONB NOT NULL DEFAULT '{}',   -- sparse diff (changed fields only), shaped like an admin PATCH body
  baseline           JSONB NOT NULL DEFAULT '{}',   -- from-values for each changed field + current_total + staffing, snapshot at request time
  note               TEXT,                          -- client free-text "anything else"
  price_preview      JSONB NOT NULL DEFAULT '{}',   -- { current_total, estimated_total, delta, staffing:{current,estimated} } DOLLARS
  acknowledged_total NUMERIC(10,2),                 -- server-computed estimate the client saw and accepted (dollars)
  request_ip         VARCHAR(45),                   -- captured server-side at create (parity with client_signature_ip)
  request_user_agent TEXT,                          -- captured server-side at create (parity with client_signature_user_agent)
  decided_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at         TIMESTAMPTZ,
  decision_note      TEXT,
  cancelled_by       VARCHAR(10) CHECK (cancelled_by IN ('client','admin','system')),
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

- `pending -> approved`: admin applied the change (see 5.2). `decided_by` set.
- `pending -> declined`: admin refused; reason in `decision_note`; `decided_by` set.
- `pending -> cancelled`: withdrawn before a decision. `cancelled_by` records who:
  `client` (withdrew in the portal), `admin` (admin dropped it), or `system` (the
  reaper auto-cancelled it; see 5.4).

The partial-unique index blocks only a second `pending` row, so a client may open
a fresh request once the prior one resolves. Every transition writes a
`proposal_activity_log` row so the audit trail lives where signing and viewing
already log: `change_requested` (`actor_type='client'`), `change_approved`,
`change_declined`, and `change_cancelled` (`actor_type` = client / the
admin/manager / `system`).

### 3.2 The payload (`requested_changes`)

A sparse diff holding only the fields the client changed, drawn from a strict
allowlist of 13 fields, all of which the admin PATCH body already accepts
(`crud.js:416-424`): `event_date`, `event_start_time`, `event_duration_hours`,
`venue_name`, `venue_street`, `venue_city`, `venue_state`, `venue_zip`,
`guest_count`, `package_id`, `num_bars`, `num_bartenders`, and the add-on triplet
(`addon_ids`, `addon_variants`, `addon_quantities`) treated as one unit.

The client submits a full proposed end-state (the wizard inputs). The server diffs
it against the current proposal, stores only the changed fields as
`requested_changes`, and that JSON is the apply-ready artifact:

- **v1:** admin reads it and applies by hand (pre-loaded into the editor).
- **v2:** the same JSON is fed to the extracted edit service for one-click apply.
- **v3:** an additive-only diff is what a self-serve client submits directly.

**The allowlist is server-enforced, not just form-omitted.** The create handler
rejects (`ValidationError`) any body key outside those 13. This is load-bearing: it
is what actually keeps `adjustments`, `total_price_override`, `setup_minutes_before`,
`class_options`, `client_provides_glassware`, `event_location` (the composed legacy
field), and the `notify_*` flags out of the payload, because `crud.js:416-424` also
destructures those and a naive overlay would otherwise pass them into
`calculateProposal`. **Sparse-diff semantics:** a field present with a new value is a
change; a field omitted means "no change"; for add-ons, `addon_ids: []` is an
explicit full strip (a removal), distinct from omitting the triplet entirely.

### 3.3 Consent and preview

The client's number is never trusted. On submit the server:

1. Loads the current proposal inputs, overlays the proposed end-state (allowlist
   filtered per 3.2), taking `SELECT ... FOR UPDATE` on the proposal row.
2. Re-runs `validateProposalRules` + `stripIncludedAddons` (server-authoritative,
   same as the admin PATCH and the public submit), rejecting a tampered or stale
   request. Venue is validated leniently (matching the admin PATCH's
   `requireCityState:false`, not the public submit's strict mode), so a client can
   correct one venue field without re-entering a full address; admin re-validates on
   apply.
3. Runs `calculateProposal` on the overlaid end-state.
4. Stores `price_preview` (current total, estimated total, delta, staffing
   before/after), `acknowledged_total`, the `baseline` snapshot, and `request_ip` /
   `request_user_agent` captured from the request (same source `publicToken.js` uses
   for signing).
5. Computes `edit_window`.

That stored, authenticated, timestamped row is the consent artifact that stands in
for signature re-acknowledgment (legal posture in §13).

**Create-time consent contract.** The client sends the `acknowledged_total` it saw.
If the server recompute at create differs from it (catalog moved, an add-on
deactivated, or rules tightened between preview and submit), the create returns
`409` with the fresh `price_preview` and stores nothing; the portal shows "the price
updated to $Y, confirm to send" and the client re-submits against the new number. So
the stored `acknowledged_total` is always a server number the client actually saw
and accepted, at both create and review time.

**Eligibility.** A request may be opened only against the client's non-archived,
non-completed proposals that have a priced baseline (`pricing_snapshot` non-empty).
Unpriced drafts (Top-Shelf class submissions persist `total_price = 0`,
`pricing_snapshot = {}` at `public.js:339-352`) have nothing to diff against, so the
portal shows a "contact us to finalize your quote" path instead of the edit form,
and admin prices it first.

`edit_window` is computed as: `pre_booking` when the proposal is not booked (status
not in the booked set `deposit_paid` / `balance_paid` / `confirmed` / `completed`,
per `clientPortal/summary.js:4`); otherwise `inside_t14` when `event_date` is 14
days or fewer from today, else `before_t14`.

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
(the portal's existing token + client_id IDOR guard). All write paths are
rate-limited by a client-portal-scoped limiter (see §14).

- `POST /api/client-portal/proposals/:token/calculate`: pricing preview for the
  in-progress edits. Wraps `calculateProposal`; authenticated and scoped, so we do
  not lean on the public `/api/proposals/public/calculate` endpoint. On failure it
  returns an error the form surfaces, and submit is hard-blocked while there is no
  fresh `acknowledged_total` (see §4.1 / §14), so a request can never be stored
  without a server-priced consent number.
- `POST /api/client-portal/proposals/:token/change-requests`: create. Body: the
  proposed end-state (allowlist-filtered per 3.2), `note`, and the client's
  `acknowledged_total`. The server diffs, validates, recomputes, applies the
  create-time consent contract (3.3), computes `edit_window`, stores the row, logs
  `change_requested`, and notifies admin (see 7). On a partial-unique violation
  (a request is already open) it returns `409` with the existing pending row rather
  than a raw 500, so a double-submit or retry is idempotent.
- `GET /api/client-portal/proposals/:token/change-requests`: the open request plus
  history, newest first, bounded by a `LIMIT` (read-only context, not a full ledger).
- `POST /api/client-portal/proposals/:token/change-requests/:id/cancel`: client
  withdraws a pending request (`cancelled_by = 'client'`).

The create path takes `SELECT ... FOR UPDATE` on the proposal. This is new code
modeled on the lock pattern the status endpoint uses (`lifecycle.js:65-67`), not a
reuse of an existing lock; the partial-unique index is the backstop against a
double-submit race.

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
  reminds admin to handle any refund through existing refund tooling and to record
  the refund-or-credit disposition in `decision_note`, so the audit row ties the
  approval to the settlement; nothing auto-refunds.
- **Decline** with a required reason (`decision_note`); notifies the client. Decline
  is a pre-edit action taken from the review screen. Once admin has applied (saved
  with the `change_request_id`), the request is `approved`; there is no "decline
  after apply."

**Approve linkage.** The existing `PATCH /api/proposals/:id` gains an optional
`change_request_id`. When present, the handler, inside the existing `dbClient`
transaction and BEFORE the COMMIT (atomic with the edit, not a post-commit step),
validates that the request exists, is `pending`, and has `proposal_id === :id`; if
so it stamps `approved` + `decided_by` + `decided_at`. If the param is supplied but
fails that check (terminal, missing, or cross-proposal), the handler skips the stamp
and logs a warning rather than failing the edit, since the edit is the priority.
This is the only change to the sensitive handler, fully gated on the param.

**Single client notification on apply.** When `change_request_id` is present the
apply suppresses the reschedule cascade's client-facing email (staff hooks still
fire); the §7 approval email is the single consolidated client touch and carries the
new date and total. This prevents the client receiving both a reschedule email and
an approval email for one change.

**Reconciliation of a non-linked edit.** If admin saves `PATCH /api/proposals/:id`
WITHOUT a `change_request_id` on a proposal that has a `pending` request, the editor
shows a warning banner ("this proposal has a pending change request"), and on save
the pending request is auto-cancelled (`cancelled_by = 'system'`,
`decision_note = 'superseded by direct admin edit'`) so the portal never shows a
stale pending row against an already-changed proposal.

In v2, "Apply in editor" becomes "Approve and apply" once the edit logic is
extracted to a callable service; the request shape and review screen are unchanged.

### 5.3 Admin API

All under `auth, requireAdminOrManager`.

- `GET /api/proposals/change-requests?status=pending`: the queue.
- `GET /api/proposals/:id/change-requests`: one proposal's requests (feeds the
  detail surface).
- `POST /api/proposals/change-requests/:id/decline`: decline with reason, notifies
  client.
- Approve happens via the `change_request_id` param on `PATCH /api/proposals/:id`
  (5.2), not a standalone approve endpoint, so apply and approve cannot drift.

### 5.4 Reaping stale pending requests

A `pending` row whose proposal is no longer changeable would block the client from
opening a new request forever (the partial-unique index does not self-clear). Two
mechanisms keep it clean, no new scheduler required:

- **Status hook.** When a proposal transitions to `archived` or `completed`
  (`lifecycle.js`), any `pending` request for it is auto-cancelled
  (`cancelled_by = 'system'`). Past events are swept to `completed` by the existing
  autocomplete scheduler (`RUN_AUTOCOMPLETE_SCHEDULER`), so a passed event date is
  covered transitively through this hook, not a bespoke date sweep.
- **Direct-edit reconciliation** (5.2): a non-linked admin PATCH on a proposal with
  a pending request auto-cancels that request.

Both paths log `change_cancelled` with `actor_type = 'system'`.

---

## 6. In-scope fixes

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
  that approved count and flag for admin by writing a `proposal_activity_log` row
  (`action = 'staffing_shrink_capped'`), because removing an assigned person is a
  human decision.

Stays inside the existing PATCH transaction. Multi-shift events (the `n !== 1`
guard) remain admin-managed, unchanged.

### 6.2 Demotion gap

The price-increase demotion at `crud.js:603-621` only fires for
`status = 'balance_paid'`, demoting to `deposit_paid` and clearing autopay. A
`confirmed` proposal whose new total exceeds `amount_paid` is not auto-corrected.

Fix: extend the condition so it also fires for `confirmed`, demoting to
`deposit_paid` and clearing `autopay_enrolled` / `autopay_status` exactly as today,
so an admin-applied increase cannot trigger an autopay re-charge off the saved card.
The existing demotion's `status_changed` activity-log row hardcodes
`from: 'balance_paid'` (`crud.js:613-620`); parameterize it so the
`confirmed -> deposit_paid` case logs the correct prior status. `completed` is
intentionally left untouched: a past event is settled, and demoting it to "awaiting
deposit" would be wrong; that edge stays admin-manual. A negative delta is also left
as-is (not demoted): the row stays paid-in-full because `amount_paid` still covers
the lower total, and any refund or credit is admin's manual call. Do not widen the
demotion to "any total change" or this invariant breaks.

### 6.3 Lock the apply-path read

The demotion in 6.2 reads `old.status` / `old.amount_paid` from
`SELECT * FROM proposals WHERE id = $1` at `crud.js:430`, which today takes no row
lock. A Stripe webhook promoting the proposal to `balance_paid`
(`stripe.js:1083-1098`) can land between that read and the handler's UPDATE, so the
demotion decides off a stale status and the webhook's write is overwritten. Add
`FOR UPDATE` to that read (and re-evaluate payment status off the locked row) so the
apply is atomic against the webhook. This is what makes 6.2 correct; it is a
low-risk row lock on a read already inside the transaction, and it hardens every
admin edit, not only change-request applies. (Distinct from the deferred
payment-status-helper extraction.)

These fixes get focused tests, run in isolation given the shared dev/test DB. 6.3 is
a prerequisite for 6.2 being race-safe, so land them together.

---

## 7. Notifications

Email-first (SMS costs money; default to email).

- **Request created -> admin:** email to `ADMIN_EMAIL`, fired once, post-insert,
  only on a successfully committed new row (the partial-unique violation path
  returns the existing row and sends nothing), so a double-submit or retry cannot
  fan out duplicate alerts. For `edit_window = 'inside_t14'` only, also an SMS to
  `ADMIN_PHONE` when set, reusing the last-minute-alert pattern (unset -> SMS
  skipped, email still fires). Those are the time-critical, staffing-at-stake
  requests.
- **Decision -> client:** email only, on `approved` / `declined`. Approved: "Your
  changes are confirmed," the updated total, and an unambiguous new-balance call to
  action (the apply may have demoted `balance_paid -> deposit_paid`, so the client
  must not read "confirmed" as "nothing left to pay"). Declined: the reason plus a
  contact invite. The decision email respects the same suppression checks as other
  client lifecycle email; the existing `sendEmail` default `Reply-To` (`ADMIN_EMAIL`)
  means client replies land in a monitored inbox.

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
- **Concurrency.** The create path and the apply path both take
  `SELECT ... FOR UPDATE` on the proposal. The create-path lock is new code; the
  apply-path lock is added by Fix 6.3 (the existing `crud.js:430` read is unlocked
  today). The partial-unique index kills double-submit.
- **Payload allowlist is server-enforced.** The create handler rejects any body key
  outside the 13 allowlisted fields (3.2). Discounts, custom lines, and override
  cannot reach `calculateProposal` from the client, by rejection, not omission.
- **Consent artifact is server-recorded.** What we would produce if an amended total
  is ever disputed is the `proposal_change_requests` row: `requested_changes` +
  `baseline` + server-computed `acknowledged_total` + `client_id` (JWT-authenticated)
  + `created_at` + `request_ip` + `request_user_agent`. Legal posture in §13.

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
   `change_declined`, `change_cancelled`, `staffing_shrink_capped`) are plain strings
   logged from their respective batches, no schema change (the action column is
   `VARCHAR(50)` with no CHECK). Docs: ARCHITECTURE schema section.
2. Shared `server/utils/changeRequests.js`: `edit_window` computation, the
   overlay-and-validate-and-price helper (reused by client create and admin
   review), and the `price_preview` builder. Plus the authenticated portal
   calculate endpoint.
3. Client API (create / list / cancel) + the portal `ChangeRequestForm` (reusing
   wizard inputs) + the status banners.
4. Admin API (queue / decline + the `change_request_id` approve-linkage with its
   binding guard and single-notification suppression on PATCH) + the review screen +
   the Proposal Detail surface (including the pending-request warning banner) + the
   reaper status hook (5.4).
5. Notifications: admin email + inside-T-14 SMS; client decision emails; templates
   in `lifecycleEmailTemplates`.
6. The fixes (6.1 `positions_needed` sync, 6.2 demotion extension, 6.3 apply-path
   `FOR UPDATE` lock) + focused tests run in isolation. 6.3 is a prerequisite for
   6.2 being race-safe, so land them together.
7. Docs sweep: README folder tree (new route files) and Key Features, ARCHITECTURE
   route table and schema, and flip the tracker's #5 status.

Plan-stage detail (loading / empty / error states, the client rate limiter, exact
foundation-file touch points, template-size watch, observability) is enumerated in
§14 for the implementation plan to absorb.

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
- **Status state machine:** `server/routes/proposals/lifecycle.js:29-40`. The
  `FOR UPDATE` lock at `:65-67` is on `PATCH /:id/status`, a DIFFERENT endpoint; the
  create-path lock copies this pattern as new code, and the apply target
  `PATCH /api/proposals/:id` reads UNLOCKED at `crud.js:430` until Fix 6.3 adds the
  lock. `modified` is a designed-but-unused enum slot (no writer today); we do NOT
  reuse it for change requests.
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
  `proposals.client_id -> clients.id`. Portal routing is the file
  `server/routes/clientPortal.js` plus a sibling `server/routes/clientPortal/`
  folder of concerns (`summary.js`), read-only today; the new change-request logic
  lands as a `clientPortal/changeRequests.js` concern, with admin routes as a
  `changeRequests.js` concern under `server/routes/proposals/`.
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
  pre-loading `requested_changes` into the editor, the atomic in-transaction
  `change_request_id` stamp with its binding guard (5.2), and the non-linked-edit
  reconciliation that auto-cancels a superseded request (5.4). Residual risk if
  admin hand-edits the pre-loaded values before saving; the request is still stamped
  `approved` against what was actually saved, and the `baseline` + `requested_changes`
  on the row preserve what the client originally asked. Removed entirely by v2
  one-click.
- **Package change is the heaviest structured edit** (different per-guest rate,
  inclusions, staffing). It is previewable through `calculateProposal` like any
  other input, but warrants extra admin attention; the review screen shows the full
  recomputed staffing so the impact is visible.
- **Drink plan linkage.** `drink_plans.proposal_id` is nullable and there is no
  `client_id`; an add-on or guest change does not touch the drink plan menu here.
  Out of scope for editing; noted so it is a conscious omission.

---

## 13. Consent and legal posture (explicitly accepted)

Under model B the client never re-signs the Event Services Agreement on a change. We
accept that the recorded change request is the contract-amendment artifact, relying
on the agreement's amendment and incorporation language
(`client/src/data/eventServicesAgreement.js` §1.3 incorporates the event-specific
terms; §21 covers amendment). The signed master agreement stands; the per-change
consent is the `proposal_change_requests` row.

If an amended total is ever disputed, the artifact we produce is: the
`requested_changes` and `baseline` (what changed, from and to), the server-computed
`acknowledged_total` the client confirmed (create-time contract, 3.3), the
authenticated `client_id` (portal JWT), `created_at`, and `request_ip` /
`request_user_agent`. That is the same class of evidence the original signature
captures (`client_signature_ip` / `_user_agent` at `schema.sql:873-874`), minus a
re-drawn signature.

This is a deliberate business decision to avoid re-introducing the
signature-history table and re-sign flow we cut. If the heavier posture is ever
wanted (a true re-sign on material change), it is a clean future addition: a
`proposal_signatures` history table plus a re-acknowledge step, grafted onto this
same request flow.

---

## 14. Plan-stage notes (for the implementation plan to absorb)

Design is settled; these are execution details the plan must specify, not open
design questions:

- **Client UI states.** The `ChangeRequestForm` needs explicit loading (calculate in
  flight), error (calculate failed, submit hard-blocked, no stale `acknowledged_total`
  submittable), and the `409` re-confirm flow (3.3). The admin queue needs empty,
  loading, and error/retry states.
- **Rate limiting.** A client-portal-scoped limiter on `calculate` and
  `change-requests` create (a logged-in client hammers `calculate` per keystroke);
  model it on the existing public/read limiters.
- **Foundation touch points.** The request surface lands in the shipped read-only
  portal (`client/src/pages/public/portal/`): `PortalHome.js` (the `home.focus`
  banner state), `EventCommandCenter.js` (button placement), and the
  Overview/Prescription tab component. Name the exact files in the plan, and commit
  to one tab, not both.
- **Router layout.** Client change-request endpoints attach to
  `server/routes/clientPortal.js` with logic factored into
  `server/routes/clientPortal/changeRequests.js` (alongside `summary.js`); admin
  routes as a `changeRequests.js` concern in the `server/routes/proposals/`
  composition router.
- **File-size watch.** Verify `lifecycleEmailTemplates` stays under the 700-line soft
  cap after the four new templates (request-to-admin email + SMS body,
  client-approved, client-declined); split per the template sibling pattern if not.
- **Observability.** Sentry breadcrumbs/tags on create, decline, and reaper
  auto-cancel, so the new money-adjacent flow is debuggable in production.
- **Tests.** The three fixes (§6) and the create-time consent contract each get a
  focused `node:test`, run in isolation against the shared dev DB.
