# Client Portal v2 — Foundation (Read-Only Command Center)

Design spec for **sub-projects 2 + 3** in
[`client-portal-v2-project.md`](../../client-portal-v2-project.md). Covers the
authenticated portal shell, the single-event command center, the three read-only
tabs, the per-document share link, and the one new backend read. Every action
flow links out to its existing standalone token page; nothing money- or
interactive-related is rebuilt here.

**Date:** 2026-06-04 · **Stage:** design approved section by section; revised after
two `/review-spec` passes (all blockers folded in). Ready for plan.

---

## 1. Goal

Turn today's thin proposal-list portal into an **event command center**: a client
logs in and lands on their single event, sees everything about it in one themed
place (proposal, menu, receipts, history), and can hand any document to someone
else with a share link. Ship a real, usable read portal **without touching the
battle-tested sign-and-pay, invoice payment, or interactive drink-lab flows** —
those stay on their standalone pages and the portal links out to them.

---

## 2. Scope

**In scope (this spec):** the `GET /api/client-portal/home` read, the portal shell
replacing the dashboard at `/my-proposals`, the single-event command center with
Overview + three read-only tabs (Prescription, Potion Plan, Receipts), past-event
archive, the per-document share link, and the empty / brand-new / rare-multi states.

**Out of scope (tracked in the project doc):** sub-project 4 (day-of brief), 5
(in-tab booking/editing), 6 (messages), 7 (multi-event switcher), 8 (quote-resume),
9 (embed lab + in-tab payment).

---

## 3. Data model

### 3.1 Status buckets (verified against the live schema)

A proposal is the same row for its whole life; there is no events table.
Verified against the latest migration (`schema.sql:2196`), the status set is:
`draft, sent, viewed, modified, accepted, deposit_paid, balance_paid, confirmed,
completed, archived`. **`cancelled` no longer exists** — it was migrated to
`status='archived'` with `archive_reason IN ('no_hire','client_cancelled',
'we_cancelled','event_completed','other')` (`schema.sql:2155-2197`). `accepted`
is still valid.

Buckets the portal uses:

- **Booked:** `status IN ('deposit_paid','balance_paid','confirmed','completed')`.
- **Pre-booking:** `status IN ('draft','sent','viewed','modified','accepted')`.
- **Active:** `status <> 'archived'`.
- **Upcoming (focus candidates):** active AND `status <> 'completed'` AND
  `event_date >= CURRENT_DATE`. (A null-date early draft is a candidate only when
  the client has no dated upcoming; it renders without a countdown.)
- **Past events (the archive the client sees):** events that actually happened —
  `status = 'completed'`, OR (`status = 'archived'` AND `archive_reason =
  'event_completed'`), OR a booked proposal with `event_date < CURRENT_DATE`.
- **Hidden from the client:** archived rows whose `archive_reason` is a
  cancellation (`no_hire`, `client_cancelled`, `we_cancelled`, `other`), and
  pre-booking proposals with a past `event_date` (expired quotes that never
  converted). Hidden rows appear nowhere in the portal and do not affect the
  empty-state decision (§3.2): a client whose only rows are hidden sees the
  brand-new state.

The client side is **unified**: one "my event" per proposal regardless of booking
state. The admin keeps its own proposal/event split; this is a different surface.

### 3.2 Focus-event selection (server-side, in `/home`)

1. **Focus = the soonest upcoming candidate.** Order by `event_date ASC NULLS
   LAST, event_start_time ASC NULLS LAST, created_at DESC` (NULLS LAST keeps a
   null-date draft from sorting to the top). Booked or not. A null-date active
   draft is the focus only when there is no dated upcoming, and renders without a
   countdown.
2. No upcoming candidate but the client has a **visible** past event or a quote
   draft -> the "no event on the books" state plus the archive.
3. No focus, no visible archive, and no quote draft -> brand-new empty state
   (this is where a hidden-rows-only client lands).
4. Two or more upcoming (rare) -> focus is the soonest; `upcoming_count` drives a
   plain one-line "you also have another event" note. No switcher.

### 3.3 `GET /api/client-portal/home`

Requires the client JWT (`clientAuth`); everything scoped to `req.user.id`.
Returns the landing essentials only; tab detail is fetched lazily.

```jsonc
{
  "focus": {                          // null when no upcoming candidate
    "token": "<uuid>",
    "status": "deposit_paid",
    "booked": true,
    "event_type": "wedding",
    "event_type_custom": null,
    "event_date": "2026-10-03",       // may be null on an early draft
    "event_start_time": "17:00",
    "guest_count": 120,
    "venue_label": "Lake Forest, IL", // derived; see below
    "total_price": 4800.00,           // DOLLARS (effective total); see Money units
    "amount_paid": 1000.00,           // DOLLARS
    "balance_due": 3800.00,           // DOLLARS
    "balance_due_date": "2026-09-26",
    "drink_plan_token": "<uuid|null>",
    "drink_plan_submitted": false     // submitted_at IS NOT NULL, see 3.4
  },
  "upcoming_count": 1,                 // total upcoming candidates, excludes archive
  "archive": [                         // visible past events, newest first
    { "token": "<uuid>", "event_type": "birthday", "event_type_custom": null,
      "event_date": "2025-08-12", "total_price": 2500.00, "status": "completed" }
  ],
  "has_quote_draft": false
}
```

**Money units (load-bearing).** The authoritative units convention lives at
`schema.sql:538-547`. **Dollars (`NUMERIC(10,2)`):** `proposals.total_price` /
`amount_paid` / `total_price_override`, `proposal_addons`, `service_packages`,
`service_addons`. **Integer cents:** `invoices.*`, `proposal_payments.amount`, and
`stripe_sessions.amount` (Stripe-native). The portal keeps every value in its
native unit and formats with two explicit helpers, never crossed: `formatDollars()`
for proposal totals and line items (mirrors today's `ClientDashboard.formatCurrency`,
no divide), and `formatCents()` for invoices, the Prescription tab's `payments[]`
history, and any Stripe amount (divide by 100, like `InvoiceDropdown`). Three
sources, one formatter per unit. `/home` and the detail endpoint return proposal
money in dollars, as the table and the standalone proposal page already do, so there
is no boundary conversion and no `/home`-vs-detail drift. (A cents-everywhere
migration is planned per the convention block; until then, respect the split.)

**Totals.** `balance_due = effective_total - amount_paid`, where `effective_total`
is `total_price_override` when set (`schema.sql:1162`), else `total_price`. Refunds
adjust `total_price` / `amount_paid` in place, so the subtraction stays correct.

**`venue_label`.** A short, public-safe label derived server-side: `venue_name`
when present, otherwise `"<venue_city>, <venue_state>"`, else "Location TBD".
**Never the street address** (`event_location` is composed free-text that includes
the street; do not pass it through).

**`next_up`** is derived client-side from the focus fields (booked, balance_due,
drink_plan_submitted, days-until `event_date`): not booked -> review & book;
`balance_due > 0` -> pay; drink plan exists and `drink_plan_submitted` is false ->
plan your potions; otherwise "you are set." When `balance_due <= 0`, the Pay step
and the balance-due date string are suppressed even if `balance_due_date` is past
(honors the CLAUDE.md re-evaluate-on-price-change rule).

### 3.4 Reused endpoints for tab detail

No new endpoint beyond `/home`; one edit to an existing one.

- **Prescription tab:** `GET /api/client-portal/proposals/:token` (exists; scoped
  by `client_id`; returns add-ons + full payment history). **Edit:** select the
  shared summary columns (§3.5) and join `drink_plans` (via the §10 subquery) to
  expose `drink_plan_token` and `drink_plan_submitted` (`submitted_at IS NOT NULL`).
  `drink_plans.status` and the admin-side `finalized_at` / BEO lock are **not** the
  client signal; `submitted_at` is.
- **Receipts tab:** `GET /api/invoices/client/:proposalToken` (exists). Note it
  returns only `status IN ('sent','paid','partially_paid')` (drafts and voids are
  filtered out), so the tab shows issued invoices, not "every invoice."
- **Potion Plan tab:** reads the plan via the existing public
  `GET /api/drink-plans/t/:token` using the token from `/home` or the detail
  endpoint. The token is the key, consistent with the share model.

### 3.5 Rendering a specific event + field parity

`/home` decides the landing (focus token, archive, empty-state flags) and carries
the focus summary for a fast first paint. Opening a **specific** event (the focus by
deep link, or an archived one) renders from
`GET /api/client-portal/proposals/:token`. To prevent drift (the bug that bit the
proposal/public-token split), both queries select one shared list,
`PROPOSAL_SUMMARY_COLUMNS` (token, status, archive_reason, event_type,
event_type_custom, event_date, event_start_time, guest_count, venue_name,
venue_city, venue_state, total_price, total_price_override, amount_paid,
balance_due_date, plus the joined `drink_plans.token` and `submitted_at`), and one
row-shaper derives `venue_label`, `booked`, effective total, `balance_due`, and
`drink_plan_submitted`.

**Focus carries all of the above.** Detail-only fields are `addons[]`, `payments[]`,
`pricing_snapshot`, `package_includes`, and `client_signed_*`. The Overview renders
entirely from focus: its procedure timeline derives the signed / deposit / balance /
completed steps from `status` and the dates (both in focus), **not** from the
detail-only `client_signed_at`, so it paints on `/home` alone. Only the Prescription
tab's line items and payment history require the detail fetch.

---

## 4. Routing and navigation

- Real React Router 6 (the v3 mock's hash routing is mock-only).
- **Keep `/my-proposals`** so existing links survive; it now renders the command
  center. `/login` and `/client-login` still land here. `/login` is mapped in both
  the public/client and the staff/admin route blocks in `App.js`; nest the new tab
  sub-routes under the **public/client** block only, and verify the existing route
  precedence still resolves a public visitor to client login (a logged-in client is
  never pulled into the staff login).
- Tabs are deep-linkable sub-views: `/my-proposals/:token/overview | prescription |
  potion | receipts`. A bare `/my-proposals` resolves the state from `/home`
  **before** painting, then renders the focus Overview, the no-event state, or the
  brand-new state, so a brand-new account does not flash a focus shell on login
  (`ClientLogin.js` navigates here on success).
- Archive: `/my-proposals/archive` lists past events; opening one loads the command
  center in read-only "filed" mode.
- **Deep-link to an unowned or nonexistent token:** `GET
  /client-portal/proposals/:token` already returns `NotFoundError` for both (same
  response for "not yours" and "does not exist", correct for IDOR). The shell renders
  a "we could not find that event" card with a link back to the portal, never a
  blank tab.

---

## 5. Frontend components

New directory `client/src/pages/public/portal/`, each file focused and well under
the size caps:

- `PortalHome.js` — resolves the route + `/home`, picks the state, renders shell chrome.
- `EventCommandCenter.js` — hero, tab bar, tab routing for one event.
- `tabs/OverviewTab.js`, `tabs/PrescriptionTab.js`, `tabs/PotionTab.js`, `tabs/ReceiptsTab.js`.
- `OverviewWidgets.js` — countdown, summary aside, next-up card, procedure timeline.
- `ArchiveList.js`, `EmptyStates.js`, `ShareButton.js`, `money.js` (the two formatters).

**Shared presentation reuse:** of the standalone `client/src/pages/proposal/
proposalView/` files, `ProposalHeader` is purely presentational and shared as-is.
`ProposalPricingBreakdown` is mostly presentational but carries local `termsExpanded`
state and a button that scrolls to `#sign-pay-section` (absent in the tab); when the
Prescription tab reuses it, that button is hidden or rewired to link out to
`/proposal/:token`. `SignAndPaySection` and `PaymentForm` are interactive and **stay
on the standalone page** (the money path is not rebuilt). The "review & book" / "pay"
buttons link out.

`ClientDashboard.js` is replaced by `PortalHome.js`. `ClientAuthContext`,
`PublicLayout`, and `clientLoginPath()` are reused unchanged.

---

## 6. The read-only tabs

Every tab displays only; actions link out.

- **Prescription:** event details, package + inclusions, add-ons, line items and
  totals (dollars), payment terms, signature status, payment history (cents, via
  `formatCents`). "Review & book" (not booked) and "pay balance" link to
  `/proposal/:token`.
- **Receipts:** issued invoices (number, label, amount in cents, status) + payment
  history. Pay / print open `/invoice/:token`.
- **Potion Plan:** read-only summary of the current plan (serving type, chosen
  drinks/syrups, submitted state). "Open the planner" links to `/plan/:token`. When
  no drink plan exists (`drink_plan_token` null), show a gentle "your menu opens
  after booking" line and no share button.

---

## 7. Share link

Per-document (tokens are per-document; portal tab URLs require login). Each tab
surfaces a share action that copies that document's existing public URL:

- Prescription -> `/proposal/:token`, Potion -> `/plan/:token`, Receipts -> per
  invoice `/invoice/:token`. With multiple invoices, share is **per-invoice row**
  (no single tab-level share), so it is unambiguous which document is shared.
- Mechanic: copy-to-clipboard with a "link copied" toast; `navigator.share` when
  available, as progressive enhancement.
- One-line hint under the button: "Anyone with this link can view it."
- Share appears only when the document exists, and shares **document tokens only**,
  never `venue_label` / event details directly. Tokens come from payloads already in
  hand. No new backend.

---

## 8. Overview content

- **Countdown card:** days until the event ("took place" when past; omitted on a
  null-date draft).
- **At-a-glance summary (aside):** package, total, paid, balance (all dollars via
  `formatDollars`), a paid-progress bar, quick links into the other tabs.
- **Next-up card:** the prioritized step from the 3.3 cascade; the Pay step is
  suppressed when `balance_due <= 0`; the action links out.
- **Procedure timeline:** quote, deposit, menu, balance, event, wrap-up, current
  step marked. Read-only, derived from `status` and dates (in focus; not the
  detail-only `client_signed_at`); steps with a null date render without the date
  rather than breaking.
- **Day-of brief slot (reserved):** sub-project 4. Until then, a quiet "day-of
  details unlock closer to the date" line.
- **Past-event "filed" mode:** countdown reads "took place," no next-up, a "book us
  again" CTA. Same component, `isPast` branch.

---

## 9. Loading, empty, and error states

- **Home load:** spinner with `role="status"`; pick the state from `/home` before painting.
- **No focus + has visible history:** the "nothing on the books" state with the archive and a quote CTA.
- **Brand-new (no focus, no visible archive, no draft):** empty state with a "get a quote" CTA.
- **Tab fetch in flight:** per-tab inline spinner; tabs load independently.
- **Tab fetch error:** inline error card with retry, never a blank tab.
- **Home error:** full-width error with retry.
- **Unowned / missing token deep link:** "we could not find that event" card (§4).
- **Archived deep link whose detail fetch fails:** fall back to a minimal Overview
  rendered from the `archive[]` row with a "details unavailable" banner.
- **Empty branches:** Receipts with zero issued invoices ("no invoices yet"); Potion
  with null `drink_plan_token` ("menu opens after booking"); archive-list fetch error.
- **Observability:** `/home`, tab-fetch failures, and the unowned-token /
  archived-fallback branches log to Sentry (non-blocking), mirroring the tag pattern
  in `proposals/publicToken.js`, tagged with `client_id` and the token (not the full
  row), so a "blank portal" report later has something to grep.

---

## 10. Security and auth

- `/home` and the reused portal endpoints require `clientAuth` and scope every
  query by `client_id = req.user.id`. `GET /client-portal/proposals/:token` already
  filters `token = $1 AND client_id = $2`, so a deep link to another client's
  proposal returns NotFound (no IDOR).
- The drink plan has no `client_id`; both `/home` and the detail endpoint reach it
  through the owning proposal. **Defense in depth:** both write the join as
  `drink_plans.proposal_id IN (SELECT id FROM proposals WHERE client_id = $user)`, so
  a future focus- or detail-query bug cannot hand the wrong client's
  `drink_plan_token` to the UI (the planner itself is bearer-protected; this guards
  against accidental token disclosure, not access to the plan). The Potion tab reads
  by that token (the public bearer model already in use).
- No new data exposure. `/home` and the detail payload return only client-safe
  fields; crew/setup timing is not in this payload (and day-of is sub-project 4).
  `venue_label` is a short label, never the street address.

---

## 11. Backend changes (summary)

1. **New:** `GET /api/client-portal/home` in `server/routes/clientPortal.js` (add
   the handler there; split to `clientPortal/home.js` only if the file nears the
   size cap). Focus selection, archive, quote-draft presence, all scoped by
   `client_id`. Uses the shared `PROPOSAL_SUMMARY_COLUMNS` (§3.5).
2. **Edit:** `GET /client-portal/proposals/:token` selects the shared
   `PROPOSAL_SUMMARY_COLUMNS` (it currently has `event_location` but not the
   `venue_name/city/state` trio that `venue_label` needs) and joins `drink_plans`
   (via the §10 subquery) for `drink_plan_token` and `drink_plan_submitted`.
3. No other backend changes; no writes (this foundation is read-only).

---

## 12. Migration

- Replace `ClientDashboard.js` with `PortalHome.js`; keep `/my-proposals` and add
  the tab sub-routes. No data migration (same tables).
- Update the "My Proposals" label in all three `PublicLayout` spots (header link,
  mobile drawer, footer) to event-centric copy, and confirm `ClientLogin.js`'s
  post-login `navigate('/my-proposals')` resolves to a state without a flash.
- Fix the `InvoiceDropdown` color bug while in the area: its status colors use
  `hsl(var(--ok-h) ...)` / `--danger-h`, scoped to the staff-v2 theme and not
  resolving on the public dashboard. Re-tokenize to portal tokens.
- Docs: update `README.md` folder tree (new `portal/` dir) and `ARCHITECTURE.md`
  route table (`/api/client-portal/home`).

---

## 13. Testing

- **Server (`clientPortal.home.test.js`, colocated next to the route; the
  `node --test "server/**/*.test.js"` script picks it up):** focus selection across
  scenarios (single upcoming, none upcoming + archive, brand-new, hidden-rows-only,
  two-plus upcoming, same-date tie-break, null-date draft, expired-unbooked-past);
  archive bucket includes completed / event_completed and excludes cancellations;
  `client_id` scoping with no cross-client leakage; unowned-token 404; **money units**
  (`focus.total_price` / `amount_paid` are dollars; invoice and `payments[].amount`
  are cents); effective total honors `total_price_override`. Run in isolation per the
  shared-test-DB caveat.
- **Frontend:** state rendering for loading / error / empty / brand-new / single /
  two-plus / archived-detail-fail; tab deep-link + back-button; `formatDollars` vs
  `formatCents` applied to the right amounts; share copies the right URL; link-outs
  point at the correct standalone token URLs.

---

## 14. Invariants respected

Actions link out (money paths untouched). **Money keeps its native unit: proposal
totals in dollars; invoices, `proposal_payments`, and Stripe amounts in cents; never
crossed** (units convention at `schema.sql:538-547`; CLAUDE.md's "integer cents"
holds for the newer tables but not the older `proposals` columns). Crew/setup timing
is never client-facing and is absent from this payload. The public token is a bearer
credential by design. The foundation is read-only: one new GET, one SELECT edit, no
writes or side effects.
