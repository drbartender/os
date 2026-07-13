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
    review: [code-review, consistency-check, second-opinion]
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
      - server/routes/proposals/cancel.js
      - server/routes/proposals/cancel.test.js
      - server/routes/proposals/index.js
      - server/utils/lifecycleEmailTemplates.js
      - client/src/pages/admin/CancelEventDialog.js
      - client/src/pages/admin/ProposalDetail.js
      - client/src/pages/admin/EventDetailPage.js
      - README.md
      - ARCHITECTURE.md
    deps: []
    review: [code-review, consistency-check, database-review, second-opinion]
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
    deps: []          # soft preference: run after P4 so displayed floors are final
    review: [code-review, consistency-check]
ops:
  - id: OPS1
    title: Prod data cleanup (requires Dallas explicit confirm at execution)
    detail: archive proposal 528 (duplicate TT lead), remove/merge empty client 1461; then verify Allyson Gietl portal focus post-P1 deploy.
  - id: OPS2
    title: Post-P4 floor values
    detail: verify prod service_packages rows show min_billed_guests=25 + min_total=550 on the ten hosted party tiers after deploy (idempotent schema.sql UPDATE runs at boot).
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
  FROM invoices WHERE proposal_id = p.id AND status = 'sent'
  ORDER BY created_at ASC LIMIT 1
) oi ON true
```

Pass both fields through `shapeFocus` in `summary.js` (`open_invoice_token: r.open_invoice_token || null`, same for label). Mirror the field in `mapDetailToFocus` (`client/src/pages/public/portal/constants.js`).
- [ ] **P1.4 Public proposal payload.** In `server/routes/proposals/publicToken.js`, add the same LATERAL and expose `open_invoice_token` in the allowlisted projection (it is a client-owned token for their own invoice; no PII widening).
- [ ] **P1.5 Client: nextUp.** `client/src/pages/public/portal/nextUp.js` line 4 becomes:

```js
if (focus.balance_due > 0) return { key: 'pay', label: 'Pay your balance', cta: 'Pay balance',
  href: focus.open_invoice_token ? `/invoice/${focus.open_invoice_token}` : `/proposal/${focus.token}` };
```

- [ ] **P1.6 Client: ProposalView paid card.** In the `isPaid && !isFullyPaid` branch (`ProposalView.js` ~589-620): primary button `Pay balance` → `/invoice/${proposal.open_invoice_token}` (render only when the token exists), planner link moves below it styled as the secondary `proposal-paid-link`. Fully-paid branch unchanged.
- [ ] **P1.7 Run the two test suites (one at a time), then `CI=true` client build. Commit.**

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
- [ ] **P2.3 Failing test for sweep preservation** — `server/utils/payrollAccrual.sweepPreserve.test.js`: seed a payout line for an off-roster worker with `adjustment_cents = 500`, wage > 0; run the sweep path; assert the line SURVIVES with `line_total_cents = 500`, wage/gratuity components zeroed, and a marker note; assert a negative-adjustment line still survives unchanged and a zero-adjustment line is still deleted.
- [ ] **P2.4 Sweep preserve.** In both sweep sites (`payrollAccrual.js` ~140-146 and ~353-389) change the delete predicate: lines with `adjustment_cents > 0` are NOT deleted; instead:

```sql
UPDATE payout_events
   SET wage_cents = 0, gratuity_share_cents = 0, card_tip_net_cents = 0,
       line_total_cents = adjustment_cents,
       adjustment_note = COALESCE(adjustment_note,'') || ' [kept: worker off roster — zero if not owed]'
 WHERE id = $1
```

then `recomputePayoutTotal` as the sweep already does. Keep the existing Sentry breadcrumb, adding `preserved: true`.
- [ ] **P2.5 Payroll UI flag.** `EventLineItem.js`: when `event.wage_cents === 0 && Number(event.adjustment_cents) > 0 && /kept: worker off roster/.test(event.adjustment_note || '')`, show an amber chip `reimbursement kept — worker off roster`.
- [ ] **P2.6 Run suite, run existing `payroll.test.js`, `CI=true` client build. Commit.**

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
UPDATE service_packages SET min_billed_guests = 25, min_total = 550.00
 WHERE pricing_type = 'per_guest' AND bar_type <> 'class'
   AND (min_billed_guests IS DISTINCT FROM 25 OR min_total IS DISTINCT FROM 550.00);
```

(BYOB `flat` and classes untouched; UPDATE is idempotent via the DISTINCT FROM guard.)
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
- [ ] **P4.6** Run engine suite; run `server/routes/proposals` crud/public suites for regressions; `CI=true` client build; update ARCHITECTURE.md schema section. Commit.

### Lane P5: Calendar feed formatting

- [ ] **P5.1 Failing test** — `server/routes/calendar.description.test.js`: build a feed for a seeded admin token + shift with client/proposal joins and assert the emitted `DESCRIPTION` property contains `Guests: 50 \\u00b7 Total: $400` and iCal-escaped real newlines (`\\n` escape sequences produced by escapeICalText from actual `\n` chars), and NOT the double-escaped `\\\\n`. Assert an `Open in OS:` URL suffix `/events/<shiftId>`.
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
  `\nOpen in OS: ${(process.env.CLIENT_URL || 'https://admin.drbartender.com')}/events/${shift.id}`,
].filter(Boolean);
return lines.join('\n');
```

  (`joinDot` = filter-Boolean + `' · '` join; `serviceWindow` reuses `parseTime12`. Admin feed query must also SELECT `p.amount_paid` — add it beside `proposal_total`.) `buildStaffDescription` gets only the newline fix.
- [ ] **P5.3** Run the new suite + `staffCalendarFeedExt.test.js`. Commit.

### Lane P6: Cancel booked events

**Interfaces produced:** `POST /api/proposals/:id/cancel/preview` → `{ days_out, mode, refund_cents, refund_breakdown: {gratuity_cents, excess_cents, fee_cents}, staff: [{name, position}], comms_halted: [labels], email_preview }`; `POST /api/proposals/:id/cancel` executes; `POST /api/proposals/:id/cancel/refund` issues the refund.

- [ ] **P6.1 Schema.** `proposals`: `ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`, `cancelled_by TEXT CHECK (cancelled_by IN ('client','drb'))` (nullable), `cancellation_note TEXT`. Extend the `archive_reason` value set convention with `'client_cancelled' | 'drb_cancelled'` (no CHECK exists on archive_reason today — verify, don't add one).
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

`cancellationMath.test.js` covers: >14d with full payment, >14d deposit-only (refund = gratuity only if gratuity paid, else 0), ≤14d fully paid (gratuity only), ≤14d nothing but deposit and no gratuity (0), drb full refund, gratuity > amountPaid clamp, boundary daysOut = 14 (≤14 branch) and 15 (>14 branch). Note: `amount_paid` is DOLLARS on proposals — the route converts to cents once at the boundary; gratuity paid comes from the pricing snapshot's gratuity line gated on funded (reuse the accrual's `extractGratuityCents` + funded check).
- [ ] **P6.3 Route `server/routes/proposals/cancel.js`** (mounted from `proposals/index.js` BEFORE the catch-all `getOne`): `auth` + admin/manager. `preview` assembles the interface payload (staff from approved shift roles on non-cancelled linked shifts; comms from pending `scheduled_messages` rows + `autopay_enrolled`). `cancel` body `{ mode, note, suppress_client_email, suppress_staff_notifications, confirm_last_name }`; validates `confirm_last_name` case-insensitively equals the client's last name; requires a BOOKED status (`deposit_paid|balance_paid|confirmed`); transaction: proposal → archived + reason + cancelled_* fields; linked shifts → cancelled via the existing `staffShiftHandlers` cancelled path (toggle-aware); delete pending `scheduled_messages` for the proposal; void unpaid (`sent`/`draft`) invoices via the existing invoice-void util; gratuity clawback via the existing clawback util when accrual exists. After COMMIT (client released first): client cancellation email (new `lifecycleEmailTemplates` entry, states the agreement outcome and any refund owed; suppressed by toggle) + admin audit note appended to `admin_notes` with the computed math. Idempotent: cancelling an already-archived proposal 409s.
- [ ] **P6.4 Refund endpoint.** `cancel/refund` re-computes via `computeCancellationRefund`, caps at refundable remainder, executes through the EXISTING partial-refund path (grep the proposal-options partial-refund attribution util and call it, attributing the gratuity portion) — never a raw `stripe.refunds.create`. Records refund reference on the proposal. Skippable: cancel without refund leaves `admin_notes` line `Refund owed per agreement: $X`.
- [ ] **P6.5 Scheduler guards.** Verify by test that `balanceScheduler` (autopay), `eventEveSms`, and balance reminders all exclude `status = 'archived'` proposals; add the status predicate anywhere it is missing. One test per scheduler with an archived-cancelled proposal seeded.
- [ ] **P6.6 UI.** `CancelEventDialog.js` (new, rendered from `ProposalDetail.js` and `EventDetailPage.js` action menus): 3 steps per spec — mode radio; preview (renders the `preview` payload verbatim incl. refund breakdown and affected staff); typed-last-name arm + the two suppress toggles + `Cancel event` button; afterwards a distinct `Issue $X refund` button calling `cancel/refund`. Copy uses no em dashes.
- [ ] **P6.7** `cancel.test.js`: happy-path client cancel >14d (archived + shifts cancelled + messages deleted + invoice voided + refund math in response), ≤14d gratuity-only refund, drb mode, wrong last name 422, already-archived 409, suppress toggles skip sends. Run all touched suites one at a time; `CI=true` client build; README/ARCHITECTURE route-table updates. Commit.

### Lane P7: Public packages/pricing page

- [ ] **P7.1** New `client/src/pages/website/PackagesPage.js` at route `/packages` (public site section of `App.js`; nav link in `Layout.js` beside Services): fetches `GET /api/proposals/public/packages`, groups by `category`/`bar_type` (BYOB, hosted beer & wine, hosted full bar, mocktail; classes excluded), renders per package: name, description, included sections from `getPackageBySlug(slug)` (`client/src/data/packages.js`), and pricing line — flat: `From $350 (4 hours)`; per-guest: `From $X/guest (4 hours)` using `base_rate_4hr`, with small-event rate noted (`$Y/guest under 50 guests`). One page-level note: `Hosted packages are billed at a 25-guest minimum, with a $550 event minimum.` A DB package with no catalog slug entry renders name + description only (no crash). Apothecary classes (`.card`, kicker/press patterns from ServicesPage), loading/error/empty states, mobile-first.
- [ ] **P7.2** ServicesPage `FORMULAS`/`ADDONS` price strings verified against live values and each card gains a `See all packages & pricing` link to `/packages`; FAQ pricing answers keep one accurate sentence + the link (kills the $18-vs-$12-40 drift class). CTA to `/quote` on the page.
- [ ] **P7.3** `CI=true` client build; README key-features + folder tree. Commit.

### Lane P8: Compare matrix rework

- [ ] **P8.1** New `client/src/pages/proposal/compare/PackageMatrix.js`: props `{ eventHeader: {guest_count, duration_hours, event_date}, columns: [{package_id, slug, name, category, chosen?, token?}], onChoose }`. On mount it prices every column via `POST /api/proposals/public/calculate` (parallel, `Promise.allSettled`; per-column error state renders `Price unavailable`) and renders an aligned CSS-grid matrix: rows = Price for your event, Deposit, Minimum note (from `floor_applied`/`floor_reason`), then one row per catalog section (Spirits, Beer, Wine, Extras) sourced from `getPackageBySlug` with `—` for absent sections. Apothecary shared classes; columns collapse to stacked cards under 640px.
- [ ] **P8.2** `ProposalCompare.js` (option-group mode) becomes a thin wrapper: fetch `GET /api/proposals/group/:token` (contract unchanged — verify `compareGroup.test.js` still passes), map options → `PackageMatrix` columns (choose → existing `/proposal/:optionToken?choose=1` navigation, decided-group redirect preserved).
- [ ] **P8.3 Explore mode.** `ProposalView` (pre-booking states `sent|viewed|accepted`, not in an option group): link `Compare packages for your event` → renders `PackageMatrix` (modal or inline section) with columns = all active non-class packages of the same and adjacent categories, priced with THIS proposal's guests/hours; "I want this one" does NOT self-swap — it opens the existing contact/message affordance prefilled with `Interested in switching to {package}` (no silent package change of a sent proposal).
- [ ] **P8.4 Post-booking package change.** `ChangeRequestForm.js` gains an optional package selector (options from the public packages endpoint, current package preselected) submitting `package_id` through the EXISTING change-request pipeline (server allowlist already supports it; preview endpoint already prices it). Renders the existing delta preview.
- [ ] **P8.5** `CI=true` client build; run `compareGroup.test.js`; README/ARCHITECTURE notes. Commit.

---

## Self-review notes

- Spec coverage: §1→P1(+OPS1), §2→P2, §3→P3, §4→P4(+OPS2), §5→P5, §6→P6, §7→P7/P8. Deferred planner items intentionally absent.
- Money-unit boundary called out where proposals (dollars) meet refunds (cents): single conversion at the cancel route boundary (P6.2 note).
- P4/P7 both touch ServicesPage/FaqPage copy lines — flagged in both lanes; merge-order conflict is a one-line copy resolution.
- P1/P8 both touch `ProposalView.js` (different regions: paid card vs pre-booking explore link) — seam noted for the push-time sweep.
