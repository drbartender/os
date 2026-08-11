# Open Threads Ledger

**Re-triaged 2026-08-11.** The original ledger was recovered from 438 threads across ~109
session transcripts (2026-05-08 to 2026-06-09) and listed ~165 OPEN items. Two months of
shipping later most of it was stale, which made the whole file unreadable: a list where
half the entries are already done is a list nobody opens.

Every item below was **verified against the current code, schema, or production database**
on 2026-08-11, not carried forward on faith. Items proven done are gone (summarized at the
bottom so the deletion is auditable, never silent). What remains is what is actually open.

Items that belong to an active project are pointed at their real home rather than
duplicated here. The fix list (`fix-list-remaining-2026-07-02.md`) owns anything with a
named file and line; this ledger owns decisions, unbuilt projects, and loose ends that have
no other home.

---

## Money-real, found during this re-triage (2026-08-11)

These are not from the original ledger. They surfaced while verifying its
"Shift #31 still open" entry against production, and both are live.

- ~~**A bartender worked an event on 2026-07-18 and has no payout line.**~~ **CLOSED
  2026-08-11 by Dallas: user 12 is Dallas himself, and the unpaid invoice on 557 was already
  known.** No money is owed to anyone. Kept as a record because the SHAPE is still live and
  the next instance may not be benign: proposal 557 (event 2026-07-18) has an approved shift
  request and zero `payout_events` lines because it is still `deposit_paid` even though its
  Deposit ($100) and Balance ($250) invoices are both `paid`. Accrual is completion-only and
  the status ladder is demote-only, so any past event stuck below `completed` silently never
  accrues and nothing alerts. For a contractor rather than the owner, that is an unpaid
  person with no signal. The standing mitigation is the sweep before every payroll run; a
  real fix would be an alert on "past event, not completed, has approved staff".
- **Proposal 600 — DO NOT TOUCH. Legal hold (Dallas, 2026-08-11).** Its unpaid balance,
  `confirmed` status, and still-`open` shift 348 are all to be **left exactly as they are**.
  Do not archive it, do not reap or close its shift, do not void or re-send its invoice, do
  not chase the balance, and do not include it in any cleanup, sweep, or reconciliation.
  Its current state may be evidence. It is listed here only so that nobody "fixes" it.
  No further detail is recorded in this file and none is needed.
- **50 more open shifts sit on `completed` proposals** (oldest 2026-04-25, newest
  2026-08-09). These are cosmetic rather than money: staff never see them, because the
  open-shifts feed filters `s.event_date >= CURRENT_DATE` (`server/routes/shifts.js:195`).
  They are the residue of the same "nothing closes a shift" gap. Worth one sweep.
  **That sweep must exclude proposal 600 / shift 348** per the legal hold above — scope it
  to `p.status = 'completed'`, which excludes 600 (`confirmed`) by construction, and confirm
  the row count before running anything.
- Shift #31 itself (the original entry) is **confirmed still open**, event date 2026-05-16,
  on a `completed` proposal. It is one of the 50 above.

---

## Blocked on Dallas (decisions, not builds)

- **Contractor agreement v3 re-sign.** Staff payment changed pay terms in the Field Guide
  and Payday Protocols, but the signed contractor-agreement-v2 lags. Materially changing
  pay terms means a v3, plus a decision on whether already-signed contractors must
  re-acknowledge. Open since 2026-05-22 and now further out of date after duty pay,
  out-of-area pay, and the owner no-draw work.
- **Wix W9 / resume / gallery backup before CheckCherry sunset.** CC sunset was 2026-07-21.
  This is now either done or permanently lost, and the ledger never recorded which. Needs a
  one-word answer; if lost, say so and close it rather than carrying it.
- **Two-step DROP COLUMN safety.** For `notifications_opt_in` and the old duplicate
  agreement columns: ship the code that stops using them, wait a day, then drop.
  Confirmation was never captured.
- **Settings page direction**: lean two-card (Auto-Assign + Calendar Feed) vs a read-only
  integrations status board. Not locked.
- **Deposit invoice gap.** First-post-cutover bookings skipped `createInvoiceOnSend`; that
  was Ketan's symptom. Whether other early bookings share the shape was never checked.
  Proposal 54 itself is now clean (`completed`, 450/450), so the original repair is
  reconciled; the open part is only "did others have this shape".

## Unbuilt projects with thinking already done

- **Comms Phase 5/6 — about 20 LOCKED design decisions, zero code.** Reschedule flow,
  per-event time zones, notification priority ladder with a 1/channel/client/day cap,
  delivery-failure fallback rules, 5-touch drip cadence, sentiment-routed post-event
  review, retention nudges restricted to repeat-likely event types, stale-lead
  auto-archive, cancellation notice as an admin-discretion toggle, voice conventions,
  setup-time language. Partially overtaken: STOP-keyword TCPA compliance SHIPPED, and
  `proposals.event_timezone` now EXISTS in schema (`schema.sql:2554`) so the time-zone
  decision is half-built. The rest reads like a ready-to-execute plan stub.
- **Staff payment Phase 4 — 1099 generation.** The ledger keeps YTD totals exportable;
  the 1099 output itself has no plan and no code. (Phase 3, the staff pay surface, has
  since shipped: `server/routes/staffPortal/payouts.js` plus the payroll screen redesign.)
- **Client portal v2 remainder.** The day-of brief slot (#4, decisions captured: preferred
  name + headshot + "subject to change", no phone/messaging, 30-90 min generic arrival),
  and deferred sub-projects #7/#8/#9 (multi-event switcher, quote-resume, in-portal
  sign/pay/lab). Case Files still has 4 tab stubs with no design pass: Prescription, Potion
  Plan, Big Experiment, Receipts, Account.
- **Vite migration.** Decision locked (Vite, not Next). Confirmed still on
  `react-scripts 5.0.1` with zero vite references. 15-16 CRA-tied HIGH advisories are
  accept-and-document until this happens.
- **Mobile remediation C1 and Batches 5-8.** C1 is confirmed untouched: no hamburger, no
  mobile nav, no `isMobile` anywhere in `client/src/components/adminos/Sidebar.js`. Fixed
  220px columns still crush every admin page on a phone. **This has been the single
  largest untouched item since 2026-05-19** and it is the only Critical-rated mobile
  finding never started. Batches 5-8 (tablet band 768-1024, 4 standalone Highs, post-C1
  residual, Med/Low cleanup) follow it.
- **Cocktail Menu page redesign.** `CocktailMenuDashboard.js` at 931 lines, double-mounted,
  ~90% duplicate code between Cocktails and Mocktails. Pull it out of Settings entirely.

## Real loose ends, verified still true

**Money / payments**
- `amount_paid` vs captured-amount: the webhook sets `amount_paid` on settle without
  asserting `session.amount_total` matches. The TIP branch does guard
  (`checkoutSessionCompleted.js:80`); the proposal settle branch still does not.
- Status demotion covers `balance_paid` but not `confirmed` on a price increase.
- One-time prod audit of pre-existing `paypal_url` rows never run. Narrowed 2026-08-11:
  `tipMethods.readSideNormalize` now drops an unnormalizable value on read and Sentry-warns,
  so bad rows can no longer reach a client-facing sign. The audit is now cleanup, not risk.
- Payouts endpoint has no LIMIT and no `/ytd`; rated clean at today's volume.
- `findOpenPeriodForDate` is non-locking (low race window). Multi-admin mark-paid race:
  the Phase 2 plan said lock the parent period row; nobody confirmed it landed.
- Late-tip roll-forward into a frozen period is CLOSED (fixed in `dc313d3`). The sibling
  case, a refunded or disputed tip after payout, still has no admin-alert design.

**Perimeter / correctness**
- Auto-claim on `/onboarding` is silent: no confirmation UI, no `activity_log` row. Narrowed
  2026-08-11: the self-promotion hole itself was closed 2026-08-01 by `requireOnboarded` in
  `middleware/auth.js`, so what remains is only the missing confirmation and audit trail.
- `proposals_status_check` still has **4 non-transactional CONSTRAINT definitions** in
  schema.sql, source of a rare 1-in-16 dispatcher-test flake.
- Pre-hire who already has an account hits the application gate; workaround is the admin
  Hire button. Documented as accepted.
- Stripe Dashboard refunds reconcile but never email the client. Spec-scope call.
- The "accepted before charge" sequencing bug (sign/accept fires before Stripe
  `confirmPayment`, so a declined card still yields an "accepted" toast and a signed
  proposal) could NOT be re-located on 2026-08-11 — the cited code has moved. Re-verify
  before trusting either way.

**File-size ratchet** (`npm run check:filesize`: RED 0, YELLOW 32)
- `crud.js` is 995 lines and has gone the WRONG way (946 when logged). Closest to the hard
  cap of anything in the tree.
- `CocktailMenuDashboard.js` 931, `emailTemplates.js` 853, `QuoteWizard.js` 837 (now at
  `client/src/pages/website/quoteWizard/`), `ProposalCreate.js` 750, `admin/users.js` 713.
- `safeAddonQty` is triplicated across `crud.js` / `public.js` / `metadata.js`.

**Housekeeping**
- `handoff.md` and `handoff.beo.md` still sit in the os root; delete-or-keep never closed.
- Local Postgres password from the pre-rebase leak (commit `885b074`, scrubbed from
  history) was never confirmed rotated. Cheap insurance.
- Neon branch `br-morning-union-ad26nq4r` (prelaunch-scrub-rehearsal) still exists,
  now `archived` (cold storage) since 2026-07-14. Awaiting an explicit delete cue.
- Stale Vercel preview branch `preview/claude/change-admin-password-IQlVD` (archived) plus
  its matching git branch `remotes/origin/claude/change-admin-password-IQlVD`, both from
  2026-05-20. Safe to delete.
- `--amber` is still `#1D8C89`, a teal. Rename it or comment it so a design session does
  not go orange.
- No admin UI exists to edit `service_addons` descriptions; live client-facing copy is
  still changed only by ungated `schema.sql` UPDATEs.
- `qLostValue` will start counting `archive_reason='event_completed'` as lost revenue the
  moment auto-archival ships. Needs the filter at that time, not before.
- `crud.test.js` is not parallel-safe (global COUNT); needs `--test-concurrency=1`.
- A dev `pay_period` stuck in `processing` makes 5 payrollAccrual tests skip. Refactor the
  test to manage its own period rather than depend on shared dev DB state.
- Hardcoded 60-minute orientation setup time, flagged as a V1 simplification.
- `BundlePicker` hardcodes "popular" to `the-foundation`.
- Client-side gratuity floor still duplicates the literal 50; the server has
  `GRATUITY_FLOOR_RATE` (`pricingEngine.js:236`). Lift the client to a shared constant.

## Ideas, unscoped

Referral program. Admin permissions / manager-toggle framework. Contractor onboarding flow
audit. AI responder for staff SMS. Google Reviews monitoring + staff review-forward.
Newsletter and seasonal campaigns (now partly absorbed by the marketing redesign).
Thumbtack auto-draft becoming auto-send. Auto-assign weights as one slider instead of two
"should sum to 1.0" inputs. Editable env-shaped settings (deposit amount, admin SMS phone,
notification email) behind a real settings table. A `/capture` command to distill a wrapped
thread into this ledger in one keystroke.

## Pointers, not duplicates

- **Owed walkthroughs** now live in `docs/walkthroughs-owed.md`. Everything in the old
  ledger of the form "shipped but never eyeballed" moved there.
- **Anything with a file and line number** lives in `fix-list-remaining-2026-07-02.md`.
- **Multi-bartender tipping** is absorbed by the staff payment system project. Note the
  standing rule: tip signs are per-bartender and settled; do not re-raise shared-bar or
  pooled-QR sign designs.
- **Lane and project status** is `build-board.md`.

---

## Closed in the 2026-08-11 re-triage

Removed because they were verified done, moot, or superseded. Recorded so the deletion can
be audited.

**Shipped since the ledger was written:** the last-minute staffing parity gap in the
full-payment webhook (now covered by a dedicated suite asserting the flag and the blast);
the `stripe.js` split (1,720 lines to 650, with a real `stripeWebhookHandlers/` folder);
`unsubscribePush` (now wired into `NotificationsSection.js`); the whole BEO project (33-task
plan to shipped `server/routes/beo.js` + `BeoSections.js`); the sent-messages log
(`message_log` table exists); staff payment Phase 3; `event_timezone`; the STOP-keyword TCPA
work; all three cc-import phases; the Thumbtack email harvester and box agent; the
`drinkPlans.js` split (1,179 to 622 lines); the dispatcher split (998 to 729).

**Moot or resolved:** `mergeClients` (the function no longer exists anywhere in the tree);
the `instagram` source-map drift (now in the server enum AND the schema CHECK at
`schema.sql:830`); the stray Neon project `round-tooth-34649976` (that IS production);
local axios sync (client is on 1.17.0); `GOOGLE_PLACES_API_KEY` (set locally); the
`backup/os-stale-merge` branch and every stale worktree (all gone; only `mkt-a-tags`
remains); the uncommitted cc-import spec/plan and the audit-findings batch plan (all
committed to main); the Ketan repair scripts (proposal 54 ties at 450/450, `completed`).

**Windows-era, retired with the machine:** nodemon needing a manual respawn, the PowerShell
deny-rule subagent gap, and the worktree junction notes.

**Superseded:** the Twilio/Resend quota forensics (the quota question was answered by the
Resend free-tier cap, tracked in its own memory entry); the office-box trio (the Linux box
is now the primary dev machine and the harvester host); the thread-mining harvest (this
ledger was its deliverable).

**Not re-raised by standing decision:** pooled / shared-bar / multi-bartender tip sign
designs.
