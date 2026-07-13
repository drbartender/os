# Fix-List Batch (fixfixfix7-13) — Design

**Date:** 2026-07-13
**Source:** Dallas's `fixfixfix7-13.txt` (9 items). Seven designed here; two (planner quiz + custom-drink capture) deferred into a future dedicated Potion Planner overhaul session with full diagnoses preserved in the session transcript and task metadata.
**Approvals:** every section below was approved item-by-item in the live brainstorm (2026-07-13). Section-by-section approvals are the approval.

---

## 1. Balance-pay dead end (fix list #9 — "Angel Davis forced back into planner")

### Problem (diagnosed, confirmed in prod)
- Portal Next-Up "Pay balance" CTA links to `/proposal/:token`; for a booked proposal, `ProposalView`'s paid-state card shows the balance due but has **no pay control** — its only action is "Open the Potion Planner →" (`ProposalView.js:615`). The actual pay surface is the balance invoice (`/invoice/:token`), reachable only via the Receipts tab or the invoice email. Clients following visible CTAs get funneled into the planner (Angelena Davis, proposal 522, paid balance 7/12 only after finding the invoice).
- Portal focus picker ignores status: `ORDER BY event_date, event_start_time, created_at DESC` lets a newer draft shadow a booked proposal for the same date/time (`clientPortal.js` focus queries). Live instance: Allyson Gietl's portal focuses proposal 626 (`viewed`) instead of her booked one.
- Duplicate Thumbtack lead created stray draft #528 + email-less duplicate client record 1461 for Angelena (data cleanup, not code).

### Design (approved: "route them to the right spot")
1. **Home payload carries the open balance invoice.** `/api/client-portal/home` (and the detail endpoint's focus shape) adds `open_invoice_token` + `open_invoice_label` for the focus proposal: the oldest unpaid (`status = 'sent'`) invoice, else null. `shapeFocus` passes it through.
2. **Next-Up "Pay balance" links to the invoice** (`/invoice/:token`) when `open_invoice_token` is present; falls back to the proposal page otherwise (unchanged behavior when no payable invoice exists).
3. **ProposalView paid-state card gets a primary "Pay balance" button** linking to the same open invoice (public proposal payload must expose the open invoice token via its existing allowlisted projection); the planner link is demoted to a secondary link below it. Fully-paid state unchanged.
4. **Focus ordering prefers bookings.** Both focus queries order by booked-status first: `ORDER BY (p.status IN ('deposit_paid','balance_paid','confirmed')) DESC, p.event_date ASC, p.event_start_time ASC NULLS LAST, p.created_at DESC`. A draft can never shadow a booked event again (fixes Allyson today, prevents recurrence).
5. **One-time prod cleanup (ops step, explicit Dallas confirm before execution):** archive stray draft proposal 528 (reason: duplicate TT lead) and remove/merge empty duplicate client 1461. Not a code lane.

Non-goals: no embedded Stripe pay flow on ProposalView (protect working money paths); no TT-lead dedupe automation (revisit only if it recurs).

---

## 2. Payroll adjustment ("extras") doesn't work (fix list #4)

### Problem (diagnosed, confirmed)
Aggregation is correct everywhere (line totals, payout totals, mark-paid, paystub PDF, staff portal — all include `adjustment_cents`). The failures are at entry:
- **Client/server freeze mismatch:** server rejects payout-event edits when the period is `processing` or `paid` (`admin/payroll.js:192-199`, 409); client only disables fields when `paid` (`PayrollPage.js:151`, `PayoutRow.js:46`). Editing during `processing` looks live but errors. (Residual half of seam-sweep L3: server hardened, client gate never matched.)
- **Note-field race:** amount + note share one commit; blurring the amount fires the save, `saving` disables both inputs mid-typing (`EventLineItem.js:126,135`), dropping the note.
- **Adjacent (seam-sweep residual, folded in):** the accrual orphan sweep deletes payout lines for off-roster workers, preserving only negative clawback lines (`payrollAccrual.js:353-389`, `:140-146`); a positive reimbursement silently vanishes if accrual re-runs.

### Design (approved: preserve)
1. Client `editable` gate mirrors the server exactly: fields disabled when period status is `processing` or `paid` (or payout not `pending`), with a visible "period is processing — edits are frozen" hint.
2. Amount + note commit together without disabling inputs mid-entry: keep inputs enabled during save; queue/replace in-flight saves so the latest draft wins; commit fires when focus leaves the adjustment pair (or on explicit blur of either with latest values of both).
3. **Orphan sweep preserves positive adjustments:** when sweeping an off-roster worker's line that carries `adjustment_cents > 0`, keep the line with wage/gratuity components zeroed and only the adjustment remaining; recompute `line_total_cents`; flag it in the payroll UI (e.g. "reimbursement kept for off-roster worker — zero if not owed") so Dallas can zero it deliberately. Negative-clawback preservation unchanged.

---

## 3. Shopping-list re-approve button dead after edit (fix list #11 line / item #5)

### Problem (diagnosed, confirmed)
Server correctly reverts an approved list to `pending_review` on any edit (`drinkPlans.js:503-516`), hiding it from the client (by design). But `ShoppingListModal.jsx` keeps `approveStatus === 'approved'` from the first approval (only approve-failure resets it), and the button is `disabled={approveStatus !== 'idle'}` — permanently dead within that modal session.

### Design (approved: keep the hide, fix the button)
On a successful auto-save PUT of a previously-approved list, reset `approveStatus` to `'idle'` and relabel the button **"Re-approve & Send"** so the admin knows the client currently sees the pending state. No schema change, no snapshot of the last-approved version. Client-page pending copy unchanged.

---

## 4. Hosted minimum — 25-guest billing + $550 backstop (fix list #17 / item #8)

### Current state (verified)
`min_total` dollar floors exist per hosted package and ARE enforced (`pricingEngine.js:82-86`, since 2026-04-07) with small-party rates under `min_guests` (50). Floors are 10-20% below Dallas's manual "bill as 25 guests" practice, and the floor only displays in the quote wizard (`PrescriptionCard.js:26`).

### Design (approved)
Formula for hosted, non-class packages: **base = max( billedGuests × small-tier rate (incl. extra-hour scaling on billedGuests), $550 )** where `billedGuests = max(actualGuests, 25)`.

1. **Schema:** `service_packages.min_billed_guests INTEGER` (idempotent add). Set 25 for all ten hosted party tiers; NULL for classes and BYOB. Update `min_total` to **550.00** for all ten hosted party tiers; classes/BYOB stay NULL. (25×small-rate ≥ every legacy floor, so nothing gets cheaper; the $550 backstop binds only where 25-guest billing lands under it — mocktail/Primary/Refined/Carbon up to ~28-30 actual guests.)
2. **Engine (`calculateBaseCost`):** for per-guest packages, `billedGuests = Math.max(guestCount, Number(pkg.min_billed_guests || 0))`; use billedGuests for the per-guest AND extra-hour terms; keep the small-rate selection on actual guest count (identical outcome under 50; do not change rate-tier semantics); keep `Math.max(..., min_total)` backstop. Classes: `min_billed_guests` NULL → unchanged math. **Staffing, 1:100 bartender ratio, and gratuity surcharges keep using ACTUAL guests** (isHostedPackage rule untouched).
3. **Snapshot/display:** snapshot records `billed_guests` and `floor_applied` (existing flag) with a reason (`guest_min` | `dollar_min`). Display line "Small-event minimum applied (billed as 25 guests)" / "Hosted minimum $550 applied" on: quote wizard (exists — update copy), admin proposal breakdown, client ProposalView breakdown.
4. **Marketing copy:** one-line mention on Services + FAQ ("hosted events are billed at a 25-guest minimum; $550 event minimum"). No other repricing.
5. **Forward-only:** existing proposals keep stored snapshots/prices. Change-request repricing of an existing booking uses the new engine (correct: a guest-count drop can't deflate below the floor).

Context locked during design: the gin/scotch menu-substitution leak is a planner policy matter → deferred planner overhaul. BYOB+add-on reconstruction priced above hosted floors already; no product-boundary change.

---

## 5. Calendar feed formatting (fix list #13 / item #6)

### Problem (diagnosed, confirmed)
`buildAdminDescription` / `formatTeamList` / `buildStaffDescription` join lines with a literal `'\\n'`; `escapeICalText` escapes backslashes first (`calendar.js:138-141`), so separators emit as `\\n` and Google renders literal `\n` on one long line. Real newlines would have worked.

### Design (approved format)
1. Join description parts with real `\n` characters; let `escapeICalText` do the escaping (fixes admin AND staff feeds).
2. Admin description becomes (all fields already SELECTed; omit empty lines):
```
Guests: 50 · Total: $400 · Balance: paid|$X
Client: Name · (phone) · email
Venue: location
Setup h:mm AM · Service h:mm–h:mm
(blank)
Team:
• Name — Position   (unfilled slots as "(unfilled — Role)")
(blank)
Notes: <shift notes if present>
(blank)
Open in OS: {CLIENT_URL}/events/{shiftId}
```
3. Title unchanged (`Client — Event type`). Staff feed content unchanged apart from the newline fix. Balance line uses proposal totals (paid when `amount_paid ≥ total`). Add route-level tests pinning a rendered DESCRIPTION (none exist today — nothing to fight).

---

## 6. Cancel booked events (fix list #15 / item #7)

### Design (approved)
Admin-only, lives in the event/proposal action menu (not a top-level button). Three-step flow:

1. **Who cancels:** client (Agreement §3.1) or Dr. Bartender (§3.3). (Reschedule/postponement §3.2 and force majeure §11 are out of scope v1 — handled manually.)
2. **Consequence preview (server-computed):** days to event; agreement outcome; exact refund; staff whose shifts get cancelled; scheduled comms/autopay that will halt; client email preview.
   - Client cancel, **>14 days**: retainer forfeited; refund = max(0, amount_paid − retainer − gratuityPaid) × 0.95 + gratuityPaid. **Gratuity always refunds in full (the portion actually paid); the 5% processing fee applies only to the non-gratuity excess.** Every component clamps ≥ 0 (deposit-only payers get $0 non-gratuity refund, never a negative). Unpaid balance never collected.
   - Client cancel, **≤14 days**: no refund EXCEPT gratuity, which refunds in full (Dallas 2026-07-13; the "every dollar to staff" line stays true — staff didn't work, client gets it back). Unpaid balance remains due (collection manual).
   - **DRB cancels:** full refund of everything paid, including retainer.
3. **Guardrail + toggles:** type the client's last name to arm; per-cancellation toggles to suppress the client email and/or staff notifications (default ON).

**Execution (transactional where multi-table):**
- Proposal → `status = 'archived'`, `archive_reason = 'client_cancelled' | 'drb_cancelled'`, cancellation note + `cancelled_at` + who-cancelled recorded.
- Linked shifts → `cancelled` via the existing staff-shift machinery (`staffShiftHandlers` kind `'cancelled'`, respecting the suppress toggle).
- Scheduled comms: delete/void pending `scheduled_messages` for the proposal (processing-delete pattern); autopay must not fire (archived status excluded from scheduler selection — verify + test); event-eve SMS and nudges covered by the same status filters (verify + test each scheduler's WHERE).
- Unpaid invoices → void via existing invoice-void path.
- Gratuity already accrued → existing clawback machinery (staff never worked; deferral-marker rules apply for frozen periods).
- Refund execution is a **separate explicit click** ("Issue $X refund") running through the existing partial-refund machinery with attribution marking the gratuity portion; admin may skip and handle in Stripe. Cancel-without-refund is valid and leaves a visible "refund owed per agreement: $X" note on the proposal.
- Client email: new lifecycle template (cancellation confirmation, states what was/will be refunded per agreement). Calendar feeds: cancelled shifts already render as cancelled.
- Log the full computed math + choices (admin notes or audit row).

---

## 7. Packages page + compare rework (fix list #5-7 / item #3)

Dallas delegated the call; recommendation approved: **both surfaces, one engine, two phases.** Existing plumbing reused: `GET /api/proposals/public/packages` (live active packages), `POST /api/proposals/public/calculate` (prices any package for any guests/hours, returns `floor_applied`), `client/src/data/packages.js` (slug-keyed descriptive sections), change-request server allowlist already supports `package_id`.

### Phase A — public packages/pricing page (marketing site)
- New public page (linked from Services nav) rendering every active non-class package from the live endpoint: name, tagline/sections (from `data/packages.js` by slug), "from $X" (4-hr base; per-guest tiers show per-guest rate), and the hosted minimum stated plainly ("hosted events bill a 25-guest / $550 minimum").
- Services + FAQ hardcoded price copy reduced to pointers at the page (or corrected to match live values) — kills the drift (Services "from $18" vs FAQ "$12-40" inconsistency class).
- Apothecary styling consistent with the marketing site; mobile-first.

### Phase B — in-proposal compare matrix
- Rework `/compare/:token` into an aligned matrix: rows = shared attributes (price for THIS event, deposit, spirits, beer, wine, extras...), columns = packages. Prices computed live per package via `public/calculate` with the event's guest count/hours (one call per package, parallel).
- Works in two modes: (a) **option-group mode** (today's flow, admin-curated options) — unchanged contract, restyled + aligned; (b) **explore mode** for any single proposal: client can open "compare packages for my event" from ProposalView and see all eligible packages priced for their event.
- Pre-booking: "Choose this one" keeps today's behavior. Explore-mode choice on an unsent/unbooked proposal routes through admin visibility (no silent package swap of a sent proposal). Post-booking: "request this package" submits a change request with `package_id` (server already prices it; client form gains the package field in this surface only).
- Included-items detail still `data/packages.js` (moving copy to DB is out of scope; no admin package editor exists).
- Apothecary components (shared classes, not the current one-off inline styles). Absorbs the backlog "compare-page reskin".

Ordering note: build after the hosted-minimum lane so displayed floors are final; not a hard dependency (matrix reads live `calculate`).

---

## Cross-cutting

- Money paths (#2 payroll, #4 pricing, #6 cancel/refund): max reasoning effort, full review fleet + `/second-opinion` at push (sensitive paths).
- Proposals money is DOLLARS; invoices/tips/Stripe are CENTS.
- No em dashes in client-facing copy.
- Email over SMS for new client notifications (cancellation confirmation = email; staff shift-cancel notices use the existing shift-notification channels).
- Docs: README/ARCHITECTURE updates per the mandatory-docs table (new route files, schema column, new public page).
