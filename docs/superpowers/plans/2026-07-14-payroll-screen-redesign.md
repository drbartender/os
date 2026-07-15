---
spec: docs/superpowers/specs/2026-07-14-payroll-screen-redesign-design.md
lanes:
  - id: pr-a-server-core
    scope: [schema, reopen route, process guard+finalize, mark-paid additions, PATCH lock, rollups, zelle, accrual sentry line]
    footprint:
      - server/db/schema.sql
      - server/routes/admin/payroll.js
      - server/routes/admin/payroll.redesign.test.js
      - server/routes/admin/contractorTipPage.js
      - server/utils/payrollAccrual.js
      - ARCHITECTURE.md
    deps: []
    review: full-fleet
    sensitive: true   # schema.sql + payroll*.js by path list; admin/payroll.js by spec mandate
  - id: pr-b-staff-guards
    scope: [staffShiftActions reopened guards, staff-portal status aliasing, PII test extension]
    footprint:
      - server/routes/staffShiftActions.js
      - server/routes/staffShiftActions*.test.js
      - server/routes/staffPortal.js
      - server/routes/staffPortal/payouts.js
      - server/routes/staffPortal/payouts.test.js
    deps: [pr-a-server-core]
    review: full-fleet
    sensitive: true   # staffShiftActions.js on the path list
  - id: pr-c-payrun-client
    scope: [tab remap, PayRunView, PayPanel, queue rows, deletions, css]
    footprint:
      - client/src/pages/admin/payroll/PayrollPage.js
      - client/src/pages/admin/payroll/PayRunView.js
      - client/src/pages/admin/payroll/PayPanel.js
      - client/src/pages/admin/payroll/PayoutRow.js
      - client/src/pages/admin/payroll/EventLineItem.js
      - client/src/pages/admin/payroll/PayQRModal.js
      - client/src/pages/admin/payroll/MarkPaidAction.js
      - client/src/pages/admin/payroll/PayrollHeader.js
      - client/src/index.css
      - README.md
    deps: [pr-a-server-core]
    review: [code-review, security-review, consistency-check]   # money-adjacent UI: amounts, mark-paid, no-logging rule
    sensitive: false
  - id: pr-d-history-links
    scope: [HistoryView paid-only + redirect, PayrollStatus due-detector + links, PayoutsTab routing, zelle client enum]
    footprint:
      - client/src/pages/admin/payroll/HistoryView.js
      - client/src/pages/admin/overview/PayrollStatus.js
      - client/src/pages/admin/userDetail/tabs/PayoutsTab.js
      - client/src/pages/admin/userDetail/helpers.js
    deps: [pr-a-server-core, pr-c-payrun-client]
    review: [code-review, consistency-check]
    sensitive: false
---

# Payroll Screen Redesign: Implementation Plan (2026-07-14)

> **For agentic workers:** builders MUST read the spec
> (`docs/superpowers/specs/2026-07-14-payroll-screen-redesign-design.md`,
> revision 3) before writing code. It carries exact file:line anchors, the
> verified `reopened` consumer map, and constraints that must not be violated.
> Two spec-fleet review rounds are already folded in; do not re-litigate the
> `reopened`-status design.

**Goal:** Rebuild the admin Payroll page as a pay-run queue (open periods,
mark-paid front and center) with a per-payout, generate-gated, method-aware
pay panel, plus the `reopened` lifecycle escape hatch.

**Architecture:** Server first (one lane: schema + routes + guards), then the
staff-side guard lane and the big client lane in parallel, then the
history/deep-link client lane. The `reopened` status is deliberately inert to
every money writer; no accrual/clawback/late-tip logic changes anywhere in
this plan (sole exception: one Sentry line, lane pr-a).

**Tech stack:** Express raw-SQL routes, React 18 CRA, vanilla CSS on
apothecary tokens, node:test server suites, qrcode.react (already a client
dependency).

## Global constraints (apply to every lane)

- Money is integer cents; dollar formatting at the display edge only.
- One pooled connection per request; post-COMMIT tail discipline
  (see the existing comments in payroll.js PATCH and mark-paid).
- AppError subclasses for client-visible errors; parameterized SQL only.
- No em dashes in any user-facing copy.
- Server tests share the dev DB: run ONE suite at a time via
  `node -r dotenv/config --test <file>`. Chicago-keyed track-and-restore
  pay-period fixtures (UTC-keyed fixtures go red at night).
- Client lanes verify with `CI=true npx react-scripts build` from `client/`
  (the Vercel lint gate; warnings are CI-fatal).
- File-size sweet spot under 300 lines for the new files; split, never grow.
- Never log generated pay URLs or clipboard payloads (handle + amount).
- H1 floorless-line contract: no per-line `GREATEST(0, ...)` anywhere.
- Read `.claude/seam-sweep-2026-07-02.md` before touching payroll.js.

## Execution graph

```
pr-a-server-core ──┬── pr-b-staff-guards
                   └── pr-c-payrun-client ── pr-d-history-links
```

pr-b and pr-c run in parallel once pr-a merges. pr-d cuts after pr-c merges.
The open stale lane `kb-a-cancel-archive` is footprint-disjoint from all four
lanes; it does not block this plan.

---

## Lane pr-a-server-core

Everything server-side, one coherent money-seam lane. Spec sections: Lifecycle,
Server changes 1-6, 9, Testing.

### Task A1: schema

Modify `server/db/schema.sql`:

- Rewrite the existing `pay_periods_status_check` DO block (schema.sql:2776-2780)
  so the CHECK reads `status IN ('open', 'processing', 'reopened', 'paid')`.
- After the payouts CREATE TABLE, add:
  `ALTER TABLE payouts ADD COLUMN IF NOT EXISTS payment_reference TEXT;`
  (inside the existing idempotent-ALTER pattern used elsewhere in the file).

Apply to the dev DB (run the two statements via psql or the repo's usual
schema-apply path) before running tests. Verify the constraint actually
rewrote (the DO block's EXCEPTION clause swallows failures):
`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'pay_periods_status_check';`
must list `reopened`. The same check runs against prod after the deploy that
ships this lane (fail-closed if missed: every reopen 500s on CHECK violation).

### Task A2: payroll.js route changes

All in `server/routes/admin/payroll.js`. Write the failing tests (Task A4)
alongside each change; commit per logical chunk (lane checkpoints are fine).

1. **`loadPeriodWithPayouts` projection** (payroll.js:31-38): add
   `po.payment_reference` and `pp.zelle_handle` to the SELECT. No bank
   fields, ever (Bank PII invariant).
2. **`GET /payroll/periods` rollups**: keep `total_cents`, `paid_count`,
   `pending_count` byte-identical; add to the same aggregate query:
   ```sql
   COALESCE(SUM(po.total_cents) FILTER (WHERE po.status = 'paid'), 0)    AS paid_cents,
   COALESCE(SUM(po.total_cents) FILTER (WHERE po.status = 'pending'), 0) AS owed_cents
   ```
3. **PATCH `/payroll/payout-events/:id`**: the locked SELECT's
   `FOR UPDATE OF pe, po` (payroll.js:182) becomes `FOR UPDATE OF pe, po, pp`.
   Nothing else changes; the existing guard already passes `reopened`.
4. **`POST /payroll/periods/:id/process`**:
   - Pre-check and guarded UPDATE both accept `('open','reopened')`.
   - Early-process guard BEFORE the fee-recapture call: load `end_date`; if
     `ymd(end_date) >= chicagoTodayYmd()` and `req.body?.force !== true`,
     throw `ConflictError('period is still in progress; pass force to process anyway')`.
     (`chicagoTodayYmd` comes from the same util payrollLateTip.js imports.)
   - After the flip: `const finalized = await maybeFinalizePeriod(pool, id);`
     and respond
     `res.json({ period: rows[0], period_status: finalized ? 'paid' : 'processing', fee_recapture: feeRecapture })`.
5. **NEW `POST /payroll/periods/:id/reopen`** (adminOnly), modeled on the
   process route:
   ```js
   router.post('/payroll/periods/:id/reopen', auth, adminOnly, asyncHandler(async (req, res) => {
     const id = Number(req.params.id);
     if (!Number.isInteger(id)) throw new NotFoundError('Period not found');
     const { rows } = await pool.query(
       `UPDATE pay_periods SET status = 'reopened'
         WHERE id = $1 AND status = 'processing'
         RETURNING id, start_date, end_date, payday, status`,
       [id]
     );
     if (!rows[0]) {
       const existing = await pool.query('SELECT status FROM pay_periods WHERE id = $1', [id]);
       if (!existing.rows[0]) throw new NotFoundError('Period not found');
       throw new ConflictError(`Period is ${existing.rows[0].status}, not processing`);
     }
     const counts = await pool.query(
       `SELECT COUNT(*) FILTER (WHERE status = 'paid') AS paid,
               COUNT(*) FILTER (WHERE status = 'pending') AS pending
          FROM payouts WHERE pay_period_id = $1`, [id]
     );
     await logAdminAction(req.user.id, 'payroll_period_reopen', {
       period_id: id, paid_count: Number(counts.rows[0].paid), pending_count: Number(counts.rows[0].pending),
     });
     res.json({ period: rows[0] });
   }));
   ```
   Match `logAdminAction`'s actual signature at payroll.js:584 (adjust the
   call shape to the existing pattern, not the sketch above).
6. **`POST /payroll/payouts/:id/mark-paid` additions**:
   - `ALLOWED_PAY_METHODS` (payroll.js:115) gains `'zelle'`.
   - Body: `payment_reference` optional string, trim, ≤200 else
     ValidationError; store in the UPDATE
     (`payment_reference = $x`) and add the column to the response SELECT
     (payroll.js:419-424).
   - Body: `expected_total_cents` with strict validation:
     ```js
     const etc = req.body?.expected_total_cents;
     if (etc !== undefined && (!Number.isInteger(etc) || etc < 0)) {
       throw new ValidationError(null, 'expected_total_cents must be a non-negative integer');
     }
     ```
     Add `po.total_cents` to the locked SELECT (payroll.js:385-392). Inside
     the transaction, after the status checks:
     ```js
     if (etc !== undefined && Number(rows[0].total_cents) !== etc) {
       await client.query('ROLLBACK');
       Sentry.addBreadcrumb({ category: 'payroll', message: 'mark_paid_drift_409', data: { payout_id: id } });
       throw new ConflictError('payout total changed since the code was generated; regenerate');
     }
     if (etc === undefined) {
       Sentry.addBreadcrumb({ category: 'payroll', message: 'mark_paid_without_expected_total', data: { payout_id: id } });
     }
     ```
     (No amounts or handles in breadcrumb data.)
7. **Contractor payouts endpoint** (`GET /payroll/contractors/:userId/payouts`):
   add `po.payment_reference` to BOTH the SELECT (payroll.js:593-594) AND the
   explicit response map (payroll.js:609-617,
   `payment_reference: r.payment_reference`). The map does not spread rows;
   the SELECT alone does not surface it.

### Task A3: satellites

- `server/routes/admin/contractorTipPage.js:23`: add `'zelle'` to
  `ALLOWED_PAYMENT_METHODS`.
- `server/utils/payrollAccrual.js`: in the existing `pay_period_not_open`
  skip branch (around :186-189), add ONE line:
  ```js
  Sentry.captureMessage('accrual skipped: pay period not open', {
    level: 'warning',
    tags: { route: 'payroll_accrual', step: 'pay_period_not_open_skip' },
    extra: { proposalId, period_status: payPeriod.status },
  });
  ```
  Verify Sentry is already imported in that file (it is used by siblings; if
  not, import the shared instrument module the other payroll utils use).
  ZERO other accrual changes; this is the fence exception named in the spec.
- `ARCHITECTURE.md`: route table (+reopen, mark-paid/process body additions),
  Database Schema section (status set + payment_reference).

### Task A4: tests (`server/routes/admin/payroll.redesign.test.js`)

One new suite, Chicago-keyed track-and-restore fixtures. Cases, each a real
assertion against the dev DB (see spec Testing for the full matrix):

- reopen: processing→reopened; open 409; paid 409; unknown id 404.
- PATCH in reopened period: pending payout accepts edit, paid payout 409s.
- mark-paid while reopened 409s; after re-process succeeds.
- **writers vs reopened**: seed a reopened period with one paid + one pending
  payout; call `accruePayoutsForProposal` for a proposal in it, then the
  late-tip roll-forward and clawback paths; assert paid payout's
  `total_cents` + lines byte-identical and deferral markers persisted.
- drift guard: stale expected_total_cents 409s and payout stays pending;
  `expected_total_cents: 0` vs $0 payout passes; `1.5` and `-1` 400;
  omitted field marks paid exactly as today.
- zelle: mark-paid accepts `payment_method: 'zelle'`; period payload carries
  `zelle_handle`.
- process: in-progress period (end_date >= Chicago today) 409s without
  `force: true`, passes with it; zero-pending period finalizes and response
  carries `period_status: 'paid'`; reopened period re-processes.
- reference: stored trimmed, 201-char 400s, returned by loadPeriodWithPayouts
  and the mark-paid response.
- rollups: paid_cents/owed_cents match seeded SUMs; total_cents/paid_count/
  pending_count unchanged.

Run: `node -r dotenv/config --test server/routes/admin/payroll.redesign.test.js`
(serially, alone). Also re-run the existing payroll suites touched by
adjacent behavior: any `server/routes/admin/payroll*.test.js` and
`server/utils/payrollAccrual*.test.js`, one at a time.

---

## Lane pr-b-staff-guards

Spec sections: Lifecycle consumer map (staffShiftActions + staff portal),
Server changes 7-8, Testing.

### Task B1: staffShiftActions guards

`server/routes/staffShiftActions.js` lines 239, 375, 535: each
`ctx.pay_period_status === 'processing'` (or `orig.` variant) becomes
`['processing', 'reopened'].includes(<same expr>)`. The user-facing message
stays exactly as-is. Extend the existing staffShiftActions test file (or add
`staffShiftActions.reopened.test.js` if none covers these guards) with one
case per action: shift in a `reopened` period → drop / request-cover /
claim-cover all rejected with the same error code as processing
(`pay_period_processing`).

### Task B2: staff-portal status aliasing

- `server/routes/staffPortal.js` (current_period tile, ~:122-134) and
  `server/routes/staffPortal/payouts.js` (:50, :76, :225): wherever
  `pp.status` is projected to staff, alias:
  `CASE WHEN pp.status = 'reopened' THEN 'processing' ELSE pp.status END AS status`
  (keep the output column name identical).
- Extend `server/routes/staffPortal/payouts.test.js`: (1) the existing PII
  exclusion assertions gain `payment_reference`; (2) with a reopened period
  seeded, no staff payout/list/detail response contains the raw string
  `'reopened'`.

Run each touched suite serially as in pr-a.

---

## Lane pr-c-payrun-client

Spec sections: The pay panel (all states + fallbacks + client data flow),
Client changes (PayrollPage, PayRunView, PayoutRow, PayPanel, EventLineItem,
deletions, index.css). Design reference: win-share "Payroll screen upgrade
v2" Turn 3 (3a layout, 3b panel states).

### Task C1: tab remap

`PayrollPage.js`: tab ids become `payrun / history / tips / tax`; landing tab
`payrun`; legacy URL params remap on read (`current → payrun`,
`unassigned → tips`) inside the useUrlListState read path. Tips tab renders
UnassignedTipsPanel then DeferredTipsPanel stacked.

### Task C2: PayRunView

New `client/src/pages/admin/payroll/PayRunView.js` (<300 lines; extract a
`PeriodCard` child inside the file or as a sibling if it grows). Behavior,
all from spec Client changes:

- Fetches `GET /admin/payroll/periods`; keeps periods with status != 'paid'.
- Sort: period whose `start_date..end_date` covers Chicago-today first (any
  non-paid status), then rest oldest-payday-first.
- Stat strip: still owed (SUM owed_cents), unpaid payouts (SUM
  pending_count), oldest open (weeks since oldest payday), paid this month.
- Card header per status: open/reopened → Process button (label
  "Re-process" on reopened, both send `{force}` only after the in-progress
  hard-confirm); processing → Reopen button behind a confirm dialog
  ("Reopen this period to edit lines? Paid payouts stay locked.").
- Process response `period_status: 'paid'` removes the card; 409 on
  process/reopen refetches the queue and re-renders (no stale buttons).
- fee_recapture toast (exact copy in spec, no ids).
- Loading skeleton, error + retry, empty state "Nothing owed. Every period
  is paid."
- Reopened chip: violet variant.

### Task C3: PayPanel

New `client/src/pages/admin/payroll/PayPanel.js` (<300 lines): the six-state
machine from the spec. Key mechanics:

- Absorbs `buildPayUrl` from MarkPaidAction.js; Venmo note becomes
  `DRB payroll <Mon D – D>` (period range passed in as a prop).
- Locked amount = payout.total_cents snapshot at generate; invalidate when
  props total changes (line edit via onLineSaved lift, method switch,
  refetch disagreement) → back to state 2 with new total.
- mark-paid POST body: `{ payment_method, payment_handle, payment_reference,
  expected_total_cents }`; on 409 → refetch period, invalidate, toast
  "Total changed to $Y. Regenerate before paying."
- zelle: Open chase.com link (`https://secure.chase.com`), copy-handle
  (zelle_handle) + copy-amount; direct_deposit/check/other: copy-amount only,
  NO handle affordance (bank PII rule).
- No-handle fallback, clipboard rejection fallback (toast + selectable
  field), reference input maxLength=200 + trim, in-flight disabling: all per
  spec Fallbacks list.
- QR: `QRCodeSVG` on a white tile, both skins.
- NEVER console.log / breadcrumb the pay URL or clipboard payloads.

### Task C4: queue row, line editor, deletions, css

- `PayoutRow.js`: queue-row shape (name, method+handle tag, events/hours,
  amount, status chip, Pay toggle).
- `EventLineItem.js`: unchanged mechanics; the expansion's left column gains
  the "Payout total" row with the "Matches the QR" chip (design 3a).
- DELETE `PayQRModal.js`, `MarkPaidAction.js`, `PayrollHeader.js` (grep for
  importers first; spec says PayrollPage + HistoryView are the only two for
  PayrollHeader, and HistoryView keeps compiling because pr-d rewrites it;
  if HistoryView still imports PayrollHeader at this lane's cut, replace that
  usage with a plain heading inline in this lane to keep the build green).
- `index.css`: pay-panel styles on existing tokens, both skins.
- `README.md`: folder tree diff (adds/deletes above).

Verify: `CI=true npx react-scripts build` from `client/` passes; then drive
the flow against the local dev server (restart it first, it is a
Claude-managed background process): process a seeded period, generate, mark
paid with reference, reopen, edit, re-process, mark paid.

---

## Lane pr-d-history-links

Spec sections: Client changes (HistoryView, deep-link producers), Server
changes 5 mirrors (client enum).

### Task D1: HistoryView

`HistoryView.js`: keep fetching the full periods list; display paid only;
drill-in read-only with `payment_reference` shown (NULL renders blank).
Deep-link: `period` param resolving to a non-paid period → navigate to
`?tab=payrun&period=<id>`; missing/unknown → plain list.

### Task D2: producers + enum

- `overview/PayrollStatus.js`: due-detector becomes
  `['processing','reopened'].includes(p.status) && Number(p.pending_count || 0) > 0`;
  "Due" tile href → `?tab=payrun&period=<id>`. Rollup field reads unchanged.
- `userDetail/tabs/PayoutsTab.js`: per-payout link routes on the PERIOD's
  status (non-paid → payrun, paid → history), never the payout's status.
- `userDetail/helpers.js`: `PAYMENT_METHODS` gains zelle; delete/correct the
  stale "Zelle was retired" comment.

Verify: `CI=true npx react-scripts build`; click through overview tile →
payrun, PayoutsTab links for a paid payout inside a non-paid period, a
legacy `?tab=history&period=<open id>` bookmark redirecting.

---

## Merge and push notes

- Standard lane lifecycle: squash-merge via `scripts/merge-lane.sh`, per-lane
  review before merge at the fleet declared in front-matter, lane branch
  deleted after the three-check verification.
- pr-a and pr-b both touch sensitive paths: full fleet per lane AND they
  re-trigger the sensitive-path fleet + `/second-opinion` at push time.
- Push is Dallas's explicit call, as always. Money-smoke gate will run on the
  server changes at push.
- After pr-a merges and its schema change applies, the dev DB accepts
  `reopened`; pr-b/pr-c tests depend on that (hence deps).
