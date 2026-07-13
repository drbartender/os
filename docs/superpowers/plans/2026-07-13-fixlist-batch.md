# Fix-List Batch (fixfixfix7-13) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each lane is executed by an Opus 4.8 agent in its own worktree lane.

**Goal:** Ship the seven designed fixes from `fixfixfix7-13.txt`: balance-pay routing, payroll adjustment entry, shopping-list re-approve, hosted 25-guest/$550 minimum, calendar feed formatting, event cancellation flow, and the packages page + compare matrix.

**Architecture:** Eight independent lanes over mostly disjoint files. P4 (pricing) and P6 (cancel) are money lanes mirroring existing proven patterns (engine floor already exists; refunds/clawback/invoice-void/shift-cancel machinery all exist and are reused, never reimplemented). P8 is the only lane with a soft ordering preference (after P4).

**Tech Stack:** Node/Express 4, Postgres (raw parameterized SQL via `pg`), React 18 (CRA), Stripe via `stripeClient.js`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-13-fixlist-batch-design.md`

## Global Constraints

- **os never leaves main.** Each lane is a throwaway worktree (`npm run worktree:new`), squash-merged back through the os lock.
- **Money units:** `proposals.total_price`/`amount_paid` are DOLLARS; `invoices`/`tips`/Stripe amounts are CENTS.
- **Schema changes** in `schema.sql`, idempotent (`ADD COLUMN IF NOT EXISTS`, guarded UPDATEs).
- **Hosted-package bartender rule:** staffing/gratuity math stays on ACTUAL guests. Grep `isHostedPackage` before touching bartender cost paths.
- **Gratuity:** grep `gratuityLineAmount` / `GRATUITY_LABEL` before touching gratuity; labels via `gratuityLabels.js`.
- **Tests:** `node:test`, one suite at a time (`node -r dotenv/config --test <file>`); Stripe stubbed via DI; suites refuse `NODE_ENV=production`.
- **No em dashes in client-facing copy.** Client notifications default to email.
- **Docs:** README/ARCHITECTURE updates ride in the lane that changes shape (new route file, schema column, new page).
- **Review:** P2, P4, P6 are sensitive paths → full fleet + `/second-opinion` at push. In-lane commits are checkpoints; squash merge is the unit.
- **Commit trailer (executing agents):** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Lane map (front-matter)

```yaml
lanes:
  - id: P1
    title: Balance-pay routing + portal focus ordering (fix #9)
    footprint:
      - server/routes/clientPortal.js
      - server/routes/clientPortal/summary.js
      - server/routes/proposals/publicToken.js
      - client/src/pages/public/portal/nextUp.js
      - client/src/pages/public/portal/constants.js
      - client/src/pages/proposal/proposalView/ProposalView.js
      - server/routes/clientPortal.home.test.js
      - server/routes/clientPortal.focusOrder.test.js
    deps: []
    review: [code-review, consistency-check]
  - id: P2
    title: Payroll adjustment entry + sweep preservation (fix #4)
    footprint:
      - client/src/pages/admin/payroll/EventLineItem.js
      - client/src/pages/admin/payroll/PayrollPage.js
      - client/src/pages/admin/payroll/PayoutRow.js
      - server/utils/payrollAccrual.js
      - server/utils/payrollAccrual.sweepPreserve.test.js
    deps: []
    review: [code-review, consistency-check, database-review, second-opinion]
  - id: P3
    title: Shopping-list re-approve button (fix #5)
    footprint:
      - client/src/components/ShoppingList/ShoppingListModal.jsx
    deps: []
    review: [code-review]
  - id: P4
    title: Hosted minimum — 25-guest billing + $550 backstop (fix #8)
    footprint:
      - server/db/schema.sql
      - server/utils/pricingEngine.js
      - server/utils/pricingEngine.test.js
      - server/routes/proposals/public.js
      - client/src/pages/website/quoteWizard/PrescriptionCard.js
      - client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js
      - client/src/pages/admin/ProposalDetailPaymentPanel.js
      - client/src/pages/website/ServicesPage.js
      - client/src/pages/website/FaqPage.js
      - ARCHITECTURE.md
    deps: []
    review: [code-review, consistency-check, database-review, second-opinion]
  - id: P5
    title: Calendar feed formatting (fix #6)
    footprint:
      - server/routes/calendar.js
      - server/routes/calendar.description.test.js
    deps: []
    review: [code-review]
  - id: P6
    title: Cancel booked events (fix #7)
    footprint:
      - server/db/schema.sql
      - server/utils/cancellationMath.js
      - server/utils/cancellationMath.test.js
      - server/utils/refundExecute.js
      - server/utils/refundExecute.test.js
      - server/utils/refundHelpers.js
      - server/routes/stripe.js
      - server/routes/proposals/cancel.js
      - server/routes/proposals/cancel.test.js
      - server/routes/proposals/index.js
      - server/utils/payrollClawback.js
      - server/utils/balanceScheduler.js
      - server/utils/eventEveSms.js
      - server/utils/balanceReminderScheduling.js
      - server/utils/balanceScheduler.archivedGuard.test.js
      - server/utils/eventEveSms.archivedGuard.test.js
      - server/utils/balanceReminderScheduling.archivedGuard.test.js
      - server/routes/stripeWebhookHandlers/chargeRefunded.js
      - server/utils/lifecycleEmailTemplates.js
      - client/src/pages/admin/CancelEventDialog.js
      - client/src/pages/admin/ProposalDetail.js
      - client/src/pages/admin/EventDetailPage.js
      - README.md
      - ARCHITECTURE.md
    deps: []
    review: [code-review, consistency-check, database-review, security-review, second-opinion]
  - id: P7
    title: Public packages/pricing page (fix #3 Phase A)
    footprint:
      - client/src/pages/website/PackagesPage.js
      - client/src/App.js
      - client/src/components/Layout.js
      - client/src/pages/website/ServicesPage.js
      - client/src/pages/website/FaqPage.js
      - README.md
    deps: []
    review: [code-review]
  - id: P8
    title: Compare matrix rework (fix #3 Phase B)
    footprint:
      - client/src/pages/proposal/compare/ProposalCompare.js
      - client/src/pages/proposal/compare/PackageMatrix.js
      - client/src/pages/proposal/proposalView/ProposalView.js
      - client/src/pages/public/portal/ChangeRequestForm.js
      - server/routes/proposals/compareGroup.js
      - server/routes/proposals/compareGroup.test.js
      - README.md
      - ARCHITECTURE.md
    deps: []          # soft preference: run after P4 so displayed floors are final; matrix falls back to floor_applied when floor_reason absent
    review: [code-review, consistency-check]
seams:                 # shared files across lanes — push-time sweep watchlist
  - schema.sql: [P4, P6]
  - ServicesPage/FaqPage copy: [P4, P7]   # run P4 first; P7 owns the consolidation
  - ProposalView.js: [P1, P8]
  - README/ARCHITECTURE: [P6, P7, P8]
ops:
  - id: OPS1
    title: Prod data cleanup (requires Dallas explicit confirm at execution)
    detail: archive proposal 528 (duplicate TT lead), remove/merge empty client 1461; then verify Allyson Gietl portal focus post-P1 deploy.
  - id: OPS2
    title: Post-P4 floor values
    detail: verify prod service_packages rows show min_billed_guests=25 + min_total=550 on exactly the non-class per_guest tiers after deploy (idempotent schema.sql UPDATE runs at boot); confirm classes/BYOB stayed NULL.
  - id: OPS3
    title: Post-P6 schema verification
    detail: verify cancelled_at/cancelled_by/cancellation_note columns + refund-row gratuity_cents exist in prod (Neon read-only).
```

---

### Lane P1: Balance-pay routing + focus ordering

**Interfaces produced:** focus payload gains `open_invoice_token` (uuid|null) + `open_invoice_label` (string|null); public proposal payload gains `open_invoice_token`.

- [ ] **P1.1 Failing tests first** — extend `server/routes/clientPortal.home.test.js`: (a) focus for a client with a booked proposal + unpaid `sent` Balance invoice includes `open_invoice_token`; (b) paid-up client gets `open_invoice_token: null`. New `clientPortal.focusOrder.test.js`: client with a booked proposal AND a newer draft on the same `event_date`/`event_start_time` → focus is the BOOKED one. Run; all fail.
- [ ] **P1.2 Server: focus ordering.** In both focus queries in `server/routes/clientPortal.js` (the `dated` and `nullDraft` variants) change the ORDER BY to:

```sql
ORDER BY (p.status IN ('deposit_paid','balance_paid','confirmed')) DESC,
         p.event_date ASC, p.event_start_time ASC NULLS LAST, p.created_at DESC
```

- [ ] **P1.3 Server: open invoice in the focus/detail payloads.** Add a LATERAL join in the same queries (and the `/proposals/:token` detail query):

```sql
LEFT JOIN LATERAL (
  SELECT token AS open_invoice_token, label AS open_invoice_label
  FROM invoices WHERE proposal_id = p.id AND status IN ('sent','partially_paid')
  ORDER BY created_at ASC LIMIT 1
) oi ON true
```

(`partially_paid` is load-bearing — `sent`-only re-dead-ends a client who part-paid the balance. P1.1's tests must include a partially_paid-invoice case.)

Pass both fields through `shapeFocus` in `summary.js` (`open_invoice_token: r.open_invoice_token || null`, same for label). Mirror the field in `mapDetailToFocus` (`client/src/pages/public/portal/constants.js`).
- [ ] **P1.4 Public proposal payload.** In `server/routes/proposals/publicToken.js`, add the same LATERAL and expose `open_invoice_token` in the allowlisted projection (it is a client-owned token for their own invoice; no PII widening).
- [ ] **P1.5 Client: nextUp.** `client/src/pages/public/portal/nextUp.js` line 4 becomes:

```js
if (focus.balance_due > 0) return { key: 'pay', label: 'Pay your balance', cta: 'Pay balance',
  href: focus.open_invoice_token ? `/invoice/${focus.open_invoice_token}` : `/proposal/${focus.token}` };
```

- [ ] **P1.6 Client: ProposalView paid card.** In the `isPaid && !isFullyPaid` branch (`ProposalView.js` ~589-620): primary button `Pay balance` → `/invoice/${proposal.open_invoice_token}` (render only when the token exists), planner link moves below it styled as the secondary `proposal-paid-link`. Fully-paid branch unchanged.
- [ ] **P1.7 Run the two test suites (one at a time), then `CI=true` client build. Manual verification on the dev server: log in as a client with a booked proposal + open balance invoice → Next-Up "Pay balance" lands on the invoice page; ProposalView paid card shows the Pay balance button above the planner link. Commit.**

### Lane P2: Payroll adjustment entry + sweep preservation

- [ ] **P2.1 Client freeze gate.** `PayrollPage.js:151` → `editable={data.period && data.period.status !== 'paid' && data.period.status !== 'processing'}`. Where `editable` is false because status is `processing`, render a muted line in the period header: `Period is processing. Line edits are frozen.` `PayoutRow.js` gate unchanged (`payout.status === 'pending'` still required).
- [ ] **P2.2 Note/amount race.** In `EventLineItem.js`: remove `saving` from the two adjustment inputs' `disabled` props (keep `!editable`); make `commitAdjustment` always send BOTH fields from the current draft (it already does) and add a latest-wins guard:

```js
const saveSeq = useRef(0);
const commitAdjustment = async () => {
  const seq = ++saveSeq.current;
  const cents = Math.round(Number(draft.adjustment_dollars) * 100);
  if (!Number.isInteger(cents)) return;
  if (cents === Number(event.adjustment_cents) && draft.adjustment_note === (event.adjustment_note || '')) return;
  const data = await save({ adjustment_cents: cents, adjustment_note: draft.adjustment_note || null });
  if (seq !== saveSeq.current) return; // a newer commit superseded this one
};
```

(`save` keeps its toast-on-error behavior; a failed save leaves the draft intact for retry.)
- [ ] **P2.3 Failing test for sweep preservation (HOLD semantics)** — `server/utils/payrollAccrual.sweepPreserve.test.js`: seed a payout line for an off-roster worker with `adjustment_cents = 500`, wage > 0; run the sweep path; assert the line SURVIVES with `adjustment_cents = 500` (tracked) but `line_total_cents = 0` (held, not payable) and a marker note; assert a subsequent PATCH through the payout-events endpoint recomputes `line_total_cents = 500` (re-armed); assert a negative-adjustment line still survives unchanged and a zero-adjustment line is still deleted.
- [ ] **P2.4 Sweep preserve (held).** In both sweep sites (`payrollAccrual.js` ~140-146 and ~353-389) change the delete predicate: lines with `adjustment_cents > 0` are NOT deleted; instead:

```sql
UPDATE payout_events
   SET wage_cents = 0, gratuity_share_cents = 0, card_tip_net_cents = 0,
       line_total_cents = 0,
       adjustment_note = COALESCE(adjustment_note,'') || ' [held: worker off roster — confirm at payroll]'
 WHERE id = $1
```

then `recomputePayoutTotal` as the sweep already does. `adjustment_cents` is deliberately preserved as the tracked number while `line_total_cents = 0` keeps it non-payable (Dallas: reimbursements confirmed by hand at payroll time; a missed flag must never auto-pay). The existing PATCH endpoint's `line_total = wage + gratuity + card_tip + adjustment` recompute is the re-arm path — no new endpoint. Keep the existing Sentry breadcrumb, adding `preserved: true`.
- [ ] **P2.5 Payroll UI flag.** `EventLineItem.js`: when `Number(event.adjustment_cents) > 0 && Number(event.line_total_cents) === 0 && /held: worker off roster/.test(event.adjustment_note || '')`, show an amber chip `reimbursement held — confirm or zero at payroll`.
- [ ] **P2.6 Run the new suite + `server/routes/admin/payroll.test.js` (correct path — there is no routes/payroll.test.js), `CI=true` client build. Manual verification: on a processing period the adjustment fields render disabled with the frozen hint; on an open period type amount → tab → note → both persist. Commit.**

### Lane P3: Shopping-list re-approve button

- [ ] **P3.1** In `ShoppingListModal.jsx`, in the debounced auto-save success path (the `await api.put(...)` at ~line 70), add:

```js
if (approveStatusRef.current === 'approved') setApproveStatus('idle');
```

(mirror `approveStatus` into a ref so the timer closure reads fresh state). Button label at ~489: when the list was previously approved this session (`wasApproved` boolean set when leaving 'approved'), render `'Re-approve & Send'` instead of `'Approve & Send to Client'`. Title text for the idle state mentions the client currently sees the pending screen.
- [ ] **P3.2** Manual verify (dev server): approve → edit an item → button re-arms with new label → re-approve succeeds. `CI=true` client build. Commit.

### Lane P4: Hosted minimum — 25-guest billing + $550 backstop

**Interfaces produced:** `calculateProposal` snapshot gains `billed_guests` (int) and `floor_reason` (`'guest_min' | 'dollar_min' | null`); `floor_applied` keeps its meaning (true when either floor binds).

- [ ] **P4.1 Schema.** In `schema.sql` next to the existing `min_total` ALTER:

```sql
ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS min_billed_guests INTEGER;
-- Legacy min_total floors before this UPDATE (rollback reference):
-- primary-culture/refined-reaction/clear-reaction 400, carbon-suspension 425,
-- cultivated-complex 450, base-compound 500, midrange-reaction 600,
-- enhanced-solution 700, formula-no-5 850, grand-experiment 1000; classes/BYOB NULL.
UPDATE service_packages SET min_billed_guests = 25, min_total = 550.00
 WHERE pricing_type = 'per_guest' AND bar_type <> 'class'
   AND (min_billed_guests IS DISTINCT FROM 25 OR min_total IS DISTINCT FROM 550.00);
```

(BYOB `flat` and classes untouched — the `bar_type <> 'class'` filter is load-bearing, classes are `category='hosted'` too; UPDATE is idempotent via the DISTINCT FROM guard.)
- [ ] **P4.2 Failing engine tests** — add to `pricingEngine.test.js` (table-driven):
  - 10 guests, Base Compound-like pkg (small $23, extra $5, min_billed 25, min_total 550), 4hr → base 575, `billed_guests` 25, `floor_reason 'guest_min'`.
  - 20 guests, 6hr same pkg → 25×23 + 25×2×5 = 825, `floor_reason 'guest_min'`.
  - 27 guests, mocktail-like pkg (small $18, min_total 550), 4hr → 486 → base 550, `floor_reason 'dollar_min'`.
  - 40 guests same pkg → 720, no floor, `billed_guests` 40, `floor_reason null`.
  - 60 guests (≥ min_guests 50) → standard rate on 60, no floor.
  - class pkg (min_billed_guests null, min_total null), 8 guests → unchanged math, no floor.
  - staffing: 10-guest hosted still computes `required` from ACTUAL guests (1 bartender), gratuity surcharge tiers still keyed on actual guests.
- [ ] **P4.3 Engine.** In `calculateBaseCost` (per-guest branch):

```js
const billedGuests = Math.max(guestCount, Number(pkg.min_billed_guests || 0));
const isSmall = pkg.min_guests && guestCount < pkg.min_guests;   // rate tier stays on ACTUAL guests
...
const floor = Number(pkg.min_total || 0);
if (rate3hr && durationHours <= 3) return Math.max(billedGuests * Number(rate3hr), floor);
if (durationHours <= 4) return Math.max(billedGuests * rate4hr, floor);
return Math.max(billedGuests * rate4hr + billedGuests * (durationHours - 4) * extraRate, floor);
```

In `calculateProposal`: compute `billedGuests` the same way (or return it from a small helper shared with `calculateBaseCost`); set `floor_reason`: `'guest_min'` when `billedGuests > guestCount` (and that base ≥ floor), `'dollar_min'` when the `min_total` clamp raised the result, else null; keep `floor_applied = floor_reason !== null` for backward compatibility; add both to the returned snapshot. `calculateStaffing`/gratuity call sites keep receiving `guestCount` — verify by grep that no call site is switched to billedGuests.
- [ ] **P4.4 Displays.** Quote wizard `PrescriptionCard.js:26`: copy becomes `Small event minimum applied (billed as {billed_guests} guests)` for `guest_min`, `Hosted minimum $550 applied` for `dollar_min`. Same conditional line added to `ProposalPricingBreakdown.js` (client) and `ProposalDetailPaymentPanel.js` (admin), reading the snapshot fields; legacy snapshots without the fields render nothing.
- [ ] **P4.5 Marketing copy.** ServicesPage hosted card + FAQ pricing answer get one plain sentence: `Hosted packages are billed at a 25-guest minimum, with a $550 event minimum.` No other numbers changed (P7 owns the bigger copy consolidation; coordinate at merge if both land).
- [ ] **P4.6 Calculate-response exposure test.** The public preview response IS the `calculateProposal` snapshot, so `billed_guests`/`floor_reason` flow through automatically — pin that with a route-level test on `POST /api/proposals/public/calculate` (10-guest hosted package → response contains `billed_guests: 25`, `floor_reason: 'guest_min'`, `floor_applied: true`). P8's matrix consumes these fields.
- [ ] **P4.7** Run engine suite; run `server/routes/proposals` crud/public suites for regressions; `CI=true` client build; update ARCHITECTURE.md schema section. Manual verification: quote wizard at 10 guests on a hosted package shows the billed-as-25 line and a $575-style floored price. Commit.

### Lane P5: Calendar feed formatting

- [ ] **P5.1 Failing test** — `server/routes/calendar.description.test.js`: build a feed for a seeded admin token + shift with client/proposal joins and assert the emitted `DESCRIPTION` property contains `Guests: 50 \\u00b7 Total: $400` and iCal-escaped real newlines (`\\n` escape sequences produced by escapeICalText from actual `\n` chars), and NOT the double-escaped `\\\\n`. Assert an `Open in OS:` URL suffix `/events/shift/<shiftId>`.
- [ ] **P5.2 Fix + format.** In `server/routes/calendar.js`:
  - `formatTeamList` and both description builders join with real `'\n'` (single backslash in source) instead of `'\\n'`.
  - Rewrite `buildAdminDescription(shift, teamList)` to emit, skipping empty fields:

```js
const money = shift.proposal_total ? `Total: $${Number(shift.proposal_total).toLocaleString()}` : null;
const balance = shift.proposal_total == null ? null
  : (Number(shift.amount_paid || 0) >= Number(shift.proposal_total) ? 'Balance: paid'
     : `Balance: $${(Number(shift.proposal_total) - Number(shift.amount_paid || 0)).toLocaleString()}`);
const lines = [
  joinDot([shift.guest_count && `Guests: ${shift.guest_count}`, money, balance]),
  joinDot([shift.client_name && `Client: ${shift.client_name}`, shift.client_phone, shift.client_email]),
  shift.location && `Venue: ${shift.location}`,
  serviceWindow(shift),                     // "Setup 1:00 PM · Service 2:00–6:00 PM" from setup_minutes_before/start/end
  teamList && `\nTeam:\n${teamList}`,
  trimNotes(shift.notes) && `\nNotes: ${trimNotes(shift.notes)}`,
  `\nOpen in OS: ${(process.env.CLIENT_URL || 'https://admin.drbartender.com')}/events/shift/${shift.id}`,
].filter(Boolean);
return lines.join('\n');
```

  (`joinDot` = filter-Boolean + `' · '` join; `serviceWindow` reuses `parseTime12`. `p.amount_paid` must be added at BOTH admin SELECT sites — the feed query ~calendar.js:305-315 AND the single-shift route ~:449-459; missing the second renders a NaN balance there. The OS link route is `/events/shift/{shift.id}` — the `/events/:id` route resolves an EVENT id, not a shift id.) `buildStaffDescription` gets only the newline fix.
- [ ] **P5.3** Run the new suite + `staffCalendarFeedExt.test.js`. Manual verification: curl the dev admin feed and eyeball one VEVENT — real escaped newlines, ordered lines, `/events/shift/` link. Commit.

### Lane P6: Cancel booked events

**Interfaces produced:** `POST /api/proposals/:id/cancel/preview` → `{ days_out, mode, refund_cents, refund_breakdown: {gratuity_cents, excess_cents, fee_cents}, staff: [{name, position}], comms_halted: [labels], email_preview }`; `POST /api/proposals/:id/cancel` executes; `POST /api/proposals/:id/cancel/refund` issues the refund.

- [ ] **P6.1 Schema.** `proposals`: `ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`, `cancelled_by TEXT` with `CHECK (cancelled_by IN ('client','admin'))` (nullable; matches the `proposal_change_requests.cancelled_by` naming convention), `cancellation_note TEXT`. **Archive reasons: use the EXISTING constraint values** — `proposals_archive_reason_check` (schema.sql ~3548-3551) already allows `'client_cancelled'` and `'we_cancelled'`; write those, do NOT invent `'drb_cancelled'` (CHECK violation). No constraint change needed.
- [ ] **P6.2 Pure math first (TDD).** `server/utils/cancellationMath.js`:

```js
/** All inputs CENTS. mode: 'client' | 'drb'. daysOut: whole days, notice date → event date. */
function computeCancellationRefund({ mode, daysOut, amountPaidCents, retainerCents, gratuityPaidCents }) {
  const gr = Math.max(0, Math.min(gratuityPaidCents, amountPaidCents));
  if (mode === 'drb') return { refundCents: amountPaidCents, gratuityCents: gr,
    excessCents: Math.max(0, amountPaidCents - gr), feeCents: 0 };
  if (daysOut > 14) {
    const excess = Math.max(0, amountPaidCents - retainerCents - gr);
    const fee = Math.round(excess * 0.05);
    return { refundCents: excess - fee + gr, gratuityCents: gr, excessCents: excess - fee, feeCents: fee };
  }
  return { refundCents: gr, gratuityCents: gr, excessCents: 0, feeCents: 0 };
}
```

`cancellationMath.test.js` covers: >14d with full payment, >14d deposit-only (refund = gratuity only if gratuity paid, else 0), ≤14d fully paid (gratuity only), ≤14d nothing but deposit and no gratuity (0), drb full refund, gratuity > amountPaid clamp, boundary daysOut = 14 (≤14 branch) and 15 (>14 branch).

**Money sources (pinned; all CENTS, no proposals-dollars anywhere in this math):** `amountPaidCents` = SUM of succeeded `proposal_payments` amounts; `retainerCents` = the Deposit-label invoice's `amount_paid` (cents by nature — NOT `proposals.deposit_amount` dollars, NOT the `STRIPE_DEPOSIT_AMOUNT` env; mixing units here is a 100× error); `gratuityPaidCents` = `extractGratuityCents(pricing_snapshot)` gated on the SAME funded determination payroll accrual uses (deposit-only payers get 0 by construction). The route assembles these three cents values and calls the pure function; no other conversion points exist.
- [ ] **P6.3 Route `server/routes/proposals/cancel.js`** (mounted from `proposals/index.js` BEFORE the catch-all `getOne`): `auth` + admin/manager. `preview` assembles the interface payload (staff from approved shift roles on non-cancelled linked shifts; comms from pending `scheduled_messages` rows + `autopay_enrolled`). `cancel` body `{ mode, note, suppress_client_email, suppress_staff_notifications, confirm_last_name }`; **server-side validation** of `confirm_last_name` (case-insensitive match against the client record — the UI gate alone is bypassable); requires a BOOKED status (`deposit_paid|balance_paid|confirmed`), 409 on already-archived/completed (idempotent against double-submit, mirroring the archive-path rejections in `proposals/actions.js`); **409 when `autopay_status = 'in_progress'`** (a mid-flight balance charge can settle after archiving; preview surfaces this as a blocking warning first). Transaction: proposal → archived + reason + cancelled_* fields; linked shifts → cancelled via the existing `staffShiftHandlers` cancelled path (toggle-aware); delete pending `scheduled_messages` for the proposal; void unpaid (`sent`/`draft`) invoices via the existing invoice-void util; **gratuity clawback runs HERE, idempotently** (marker on the tip/accrual row via `payrollClawback`; the `chargeRefunded.js` webhook clawback checks the same marker and no-ops, so a later refund can't double-claw and a cancel-without-refund still claws). After COMMIT (client released first): client cancellation email (new `lifecycleEmailTemplates` entry, states the agreement outcome and any refund owed; suppressed by toggle) + admin audit note appended to `admin_notes` with the computed math AND the original contract total (refunds are not income — Financials nets them via the existing refund recording; the note preserves contract history).
- [ ] **P6.4 Refund execution.** The live Stripe refund orchestration is INLINE in `server/routes/stripe.js` (~459-520), not a callable util, and `planRefund` is single-charge (`EXCEEDS_LARGEST_CHARGE`) — a booked event has deposit + balance charges, so a cancellation refund usually spans charges. Extract the orchestration into `server/utils/refundExecute.js`, used by BOTH the existing stripe.js route (behavior unchanged — pin with the existing refund tests) and the new endpoint. `cancel/refund` re-computes via `computeCancellationRefund`, caps at the refundable remainder, and loops `refundExecute` per refundable charge (largest-first) until the target is met. Refund recording gains an explicit `gratuity_cents` attribution on the refund row (idempotent schema.sql add — label-based attribution has no gratuity concept today) so the gratuity portion is auditable and excluded from contract-revenue adjustments. Never a raw `stripe.refunds.create`. Records refund references on the proposal. Skippable: cancel without refund leaves `admin_notes` line `Refund owed per agreement: $X`.
- [ ] **P6.5 Scheduler guards.** Verify by test that `balanceScheduler` (autopay), `eventEveSms`, and balance reminders all exclude `status = 'archived'` proposals; add the status predicate anywhere it is missing. One test per scheduler with an archived-cancelled proposal seeded.
- [ ] **P6.6 UI.** `CancelEventDialog.js` (new, rendered from `ProposalDetail.js` and `EventDetailPage.js` action menus): 3 steps per spec — mode radio; preview (renders the `preview` payload verbatim incl. refund breakdown and affected staff); typed-last-name arm + the two suppress toggles + `Cancel event` button; afterwards a distinct `Issue $X refund` button calling `cancel/refund`. Copy uses no em dashes.
- [ ] **P6.7** `cancel.test.js`: happy-path client cancel >14d (archived + shifts cancelled + messages deleted + invoice voided + refund math in response), ≤14d gratuity-only refund, drb mode, wrong last name 422, already-archived 409, `autopay_status='in_progress'` 409, suppress toggles skip sends, clawback idempotency (cancel-time clawback then simulated `charge.refunded` webhook → no double-claw), **frozen-period deferral-marker clawback case** (the edge the spec explicitly calls out), multi-charge refund spanning deposit + balance. Run all touched suites one at a time; `CI=true` client build; README/ARCHITECTURE route-table + schema updates. Manual verification: walk the 3-step dialog on a dev booked proposal — preview numbers match the agreement math, typed wrong last name blocks, cancel archives + cancels shifts, refund button issues and records. OPS3 post-deploy: verify `cancelled_at`/`cancelled_by`/`cancellation_note` columns exist in prod (Neon). Commit.

### Lane P7: Public packages/pricing page

- [ ] **P7.1** New `client/src/pages/website/PackagesPage.js` at route `/packages` (public site section of `App.js`; nav link in `Layout.js` beside Services): fetches `GET /api/proposals/public/packages`, groups by `category`/`bar_type` (BYOB, hosted beer & wine, hosted full bar, mocktail; classes excluded), renders per package: name, description, included sections from `getPackageBySlug(slug)` (`client/src/data/packages.js`), and pricing line — flat: `From $350 (4 hours)`; per-guest: `From $X/guest (4 hours)` using `base_rate_4hr`, with small-event rate noted (`$Y/guest under 50 guests`). One page-level note: `Hosted packages are billed at a 25-guest minimum, with a $550 event minimum.` A DB package with no catalog slug entry renders name + description only (no crash). Apothecary classes (`.card`, kicker/press patterns from ServicesPage), loading/error/empty states, mobile-first.
- [ ] **P7.2** ServicesPage `FORMULAS`/`ADDONS` price strings verified against live values and each card gains a `See all packages & pricing` link to `/packages`; FAQ pricing answers keep one accurate sentence + the link (kills the $18-vs-$12-40 drift class). CTA to `/quote` on the page.
- [ ] **P7.3** `CI=true` client build; README key-features + folder tree. Manual verification: /packages renders all active non-class packages with prices on desktop + a phone-width viewport; nav link works; a package missing from the client catalog renders name + description without crashing. Commit.

### Lane P8: Compare matrix rework

- [ ] **P8.1** New `client/src/pages/proposal/compare/PackageMatrix.js`: props `{ eventHeader: {guest_count, duration_hours, event_date}, columns: [{package_id, slug, name, category, chosen?, token?}], onChoose }`. On mount it prices every column via `POST /api/proposals/public/calculate` (parallel, `Promise.allSettled`; per-column error state renders `Price unavailable`) and renders an aligned CSS-grid matrix: rows = Price for your event, Deposit, Minimum note (from `floor_applied`/`floor_reason`), then one row per catalog section (Spirits, Beer, Wine, Extras) sourced from `getPackageBySlug` with `—` for absent sections. Apothecary shared classes; columns collapse to stacked cards under 640px.
- [ ] **P8.2** `ProposalCompare.js` (option-group mode) becomes a thin wrapper: fetch `GET /api/proposals/group/:token` (contract unchanged — verify `compareGroup.test.js` still passes), map options → `PackageMatrix` columns (choose → existing `/proposal/:optionToken?choose=1` navigation, decided-group redirect preserved).
- [ ] **P8.3 Explore mode.** `ProposalView` (pre-booking states `sent|viewed|accepted`, not in an option group): link `Compare packages for your event` → renders `PackageMatrix` (modal or inline section) with columns = **all active non-class packages** (Dallas 2026-07-13), priced with THIS proposal's guests/hours; "I want this one" does NOT self-swap — it opens the existing contact/message affordance prefilled with `Interested in switching to {package}` (no silent package change of a sent proposal). Consider extracting the explore section as its own component file (ProposalView.js is 632 lines; P1 also adds to it).
- [ ] **P8.4 Post-booking package change.** `ChangeRequestForm.js` gains an optional package selector (options from the public packages endpoint, current package preselected) submitting `package_id` through the EXISTING change-request pipeline (server allowlist already supports it; preview endpoint already prices it). Renders the existing delta preview.
- [ ] **P8.5** `CI=true` client build; run `compareGroup.test.js`; README/ARCHITECTURE notes. Manual verification: an option-group compare link renders the aligned matrix with live prices and Choose still navigates; explore mode from a dev proposal prices all non-class packages at its guests/hours; phone-width stacks to cards. Commit.

---

## Self-review notes

- Spec coverage: §1→P1(+OPS1), §2→P2, §3→P3, §4→P4(+OPS2), §5→P5, §6→P6(+OPS3), §7→P7/P8. Deferred planner items intentionally absent.
- Design-fleet findings (2026-07-13, 6 agents) folded in: archive_reason uses existing CHECK values; class exclusion keyed on bar_type; open-invoice includes partially_paid; refund execution extracted + multi-charge + gratuity_cents attribution; cancel-time idempotent clawback; autopay in-flight 409; cents-only money sources pinned; both calendar query sites; /events/shift links; hold-not-payable sweep semantics; scheduler files declared in P6 footprint; review arrays widened (P2 +database, P6 +security); manual-verification steps on every UI lane; legacy floors recorded for rollback.
- Money-unit boundary: cancel math is cents-only from invoice/payment rows; proposals dollars never enter it (P6.2).
- Seams declared in front-matter (`seams:` block); P4 runs before P7 by convention (P7 owns the copy consolidation).
