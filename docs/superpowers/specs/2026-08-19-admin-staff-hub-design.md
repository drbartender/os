# Admin Staff Hub

**Date:** 2026-08-19
**Status:** Approved (section-by-section 2026-08-19; IA settled in chat, visual system settled in the claude.ai/design session, the open-pay-period subtitle rule settled last)
**Audience:** Dallas (admin) and the manager role. Desktop Admin OS. The phone admin app's Staff surfaces are a later mobile phase and this spec does not touch them beyond the one link in §8.

## 1. Problem

The Admin OS sidebar carries four entries that are all "the people who work for me": Staff, Hiring, Tips & Feedback, Reviews. Payroll is a fifth people-surface with no sidebar entry at all, reachable only from the Overview card and a staffer's Payouts tab. Tips & Feedback and Reviews sit under a "Revenue" group with Marketing, where nobody looks for them. The nav also advertises Hiring, Tips and Reviews to managers whose API calls those surfaces reject.

Checked against prod 2026-08-19 before deciding anything: one tip ever ($6.00, 2026-08-16), zero feedback rows ever, one review ever (pending, 2026-08-17), zero bounties paid. These are eight-day-old surfaces with one event day of data, not dead ones. But giving them top-level billing beside Roster and Payroll would be a hub that lies about where the work is.

## 2. Settled information architecture

One sidebar entry, **Staff**. Four children. Roster lands.

| Child | Route | Inside it |
|---|---|---|
| **Roster** (lands) | `/staffing` | Active / Deactivated / All switch over a table |
| **Hiring** | `/staffing/hiring` | Three-column kanban: Applied, Interview, Onboarding |
| **Payroll** | `/staffing/payroll` | Pay run, History, Tips, 1099 / tax |
| **Reviews** | `/staffing/reviews` | Pending cards, resolved table, contest rail (no internal tabs) |

Decisions, with the reason each was made:

- **Roster lands.** Clicking Staff shows the staff list, never a hub overview.
- **Tips fold into Payroll.** Tips are per-bartender (each contractor has their own tip page and token) and the money accrues into that person's payout; a global cross-staff ledger was the odd one out. Payroll's existing Tips tab (the unassigned and deferred repair queues) gains the activity ledger. One tips surface, not two a click apart.
- **Feedback leaves the hub.** `tip_page_feedback` is a rating and a comment about one bartender, submitted from that bartender's thank-you page, and `publicTip.js` already emails the operator on every submission. It is per-person, so it moves to the staffer's profile (§9). Zero rows have ever existed.
- **Reviews keeps a child.** It is the one genuinely cross-staff surface (read a review, decide who it names, credit them, run a quarterly contest across the team) and it is a real payroll input, not a log: confirming writes a `payout_duty_lines` row of `REVIEW_BOUNTY_CENTS` (`kind='review_bounty'`) and the award writes `review_contest`, both landing in the open pay run.
- **Existing detail routes stay put:** `/staffing/users/:id`, `/staffing/applications/:id`, `/staffing/legacy` (the Send SMS page) are untouched.

## 3. Visual contract

Per CLAUDE.md "Design artifacts are contracts":

- **Benchmark artifact:** `docs/design-artifacts/2026-08-19-staff-hub.dc.html`, the repo snapshot of `Staff Hub.dc.html` from design project **96291c7a-3510-4910-9c67-c41d81504920**. Eleven artboards: 1a Roster (After Hours), 1b Roster deactivated view (House Lights), 1c Roster empty, 1d Hiring with the stale-record fold, 1e/1f Payroll pay run in both skins, 1g Payroll tips, 1g2 tips-repair specimen, 1h Reviews at one row, 1i Reviews at volume, 1j the hub pattern spec. The snapshot in the repo is the build benchmark; the fidelity lane pulls the live file via DesignSync (`list_files` → `get_file`) and folds its CSS in.
- **Token and component law:** the **Dr. Bartender OS Design System** project `72035042-c993-47e2-9dc8-c452b7bf5fa4`, admin family (`components-admin.css`, `tokens/*`), vendored at `docs/design-artifacts/_ds/`. Token names are identical to `index.css`; new rules land in `index.css` and consume the product's `[data-app="admin-os"][data-skin]` custom properties directly. Fidelity review compares structure and token usage, never resolved hue values.
- **The two-vocabulary rule (the design's core answer, now law for every hub):** hub sections are **underline tabs fused to the page header** (`.hub-tabs`, one per page, ever; each tab is a URL). Views inside a child stay **`.seg` pills in the toolbar** (the existing `Toolbar` component, `?tab=` URL state as today). The eye reads "part of the title" versus "a control in the content," so two levels never render as the same strip twice. Never two `.seg`s stacked; never a third level. A child that needs a third level restructures instead (Reviews did, §7).
- **New classes (vanilla CSS in `index.css`):** `.hub-head` (wraps `.page-header` + `.hub-tabs`, owns the single bottom hairline), `.hub-tab` / `.hub-tab.active` (34px, 2px accent underline when active, squared on House Lights), `.hub-tab-count` (ambient mono gray count), `.hub-tab-badge` (accent pill, means a decision is waiting), `.hub-empty` (deliberate empty state: title, one sentence, one action), `.hire-fold` / `.hire-stub` (the collapsed stale-record group in the kanban and its dimmed rows), `.roster-sect` (in-table group header row). `.hub-tabs` scrolls horizontally under 720px, no wrapping.
- **Existing vocabulary composes, never replaced:** `.page`, `.page-header`, `.page-title`, `.page-subtitle`, `.page-actions`, `.card`, `.card-head`, `.card-body`, `.tbl`, `.tbl-wrap`, `.stat-row`, `.stat`, `.chip`, `.chip-dot`, `.seg`, `.btn` family, `.avatar`, `.hstack`, `.vstack`, `.muted`, `.tiny`, `.mono`, `.k`, `.kebab-menu`, `.nav-item`, `.nav-badge`, `.badge-legacy-cc-stub`, `.imported-chip`.
- **Retirements:** the hand-rolled inline-styled `TabButton`s in `TipsAdmin.js` and `StaffReviews.js` are deleted with those files. Legacy `.tab-nav` / `.tab-btn` stay in `index.css` for their one remaining consumer, `pages/AdminDashboard.js` (`/staffing/legacy`), which is out of scope; no new consumer may use them. New surfaces choose `.hub-tabs` or `.seg`, nothing else.
- **Where this spec overrides the benchmark (design copy that asserts mechanics the product does not have):** the hiring fold's "Retry from Settings re-runs the import matcher" and "Link each record to a staffer from its page" (no matcher or link flow exists; §6 states what the fold offers); the fold's "29 CheckCherry records" label (the predicate is generic, §6); the contest floor "5 events worked" (the server's `MIN_EVENTS_WORKED` is 4 and the page renders the payload, never a literal); the roster's "18 active" (the roster endpoint excludes admins; the count is whatever `GET /admin/active-staff` returns, 16 today); the tips tab's "Signs live since" and "Shifts since launch" stats (launch narrative that goes stale; §7 keeps one stat). Both skins, both breakpoints; wide tables scroll in `.tbl-wrap`, never the page. No em dashes in copy.

## 4. Architecture

Follows `MarketingLayout.js` exactly: a layout component with nested routes behind one sidebar entry.

- **`client/src/pages/admin/staffHub/StaffHubLayout.js`** (new). Renders `.hub-head` (title "Staff", the live subtitle, `.hub-tabs`) and an `<Outlet />`. Owns ONE fetch, `GET /api/admin/staff-hub/summary` (§5), shared to children through Outlet context `{ summary, refresh }` so a child that changes a count (confirming a review, approving an application) calls `refresh()` and the chrome never goes stale. Rendering is never gated on the fetch: children mount immediately and the subtitle appears when the data arrives.
- **Routes in `App.js`:** `/staffing` element `StaffHubLayout`, index → Roster, `hiring` → Hiring, `payroll` → Payroll, `reviews` → Reviews. The three existing `/staffing/*` detail routes stay as siblings outside the layout (they have their own page headers and back links, and the hub chrome on a profile page is wrong).
- **Children drop their own `.page-header`.** The hub owns the title. Each child renders its toolbar and content directly under the tabs. Page actions that belong to a child (Send SMS on Roster, Log a Google review on Reviews) render in the hub's `.page-actions` slot via Outlet context, keyed by the active child, so the header never carries another child's button.
- **Hub tab chrome per child:** Roster shows `.hub-tab-count` = `active_count`. Hiring shows `.hub-tab-badge` = `new_applications` when > 0. Payroll shows nothing (no badge in v1; a processing or unpaid-payout badge is a later decision). Reviews shows `.hub-tab-badge` = `pending_reviews` when > 0. Counts are ambient; badges mean a decision is waiting.
- **The live subtitle:** `{active_count} active · pay run {Mon D} to {D} open, payday {Dow Mon D} · {pending_reviews} review(s) to confirm`, with `nothing to confirm` at zero and `No active staff yet` at zero active. The pay-run clause derives its window from today's date (§5), so a quiet week still names the period; the "nothing accrued yet" state lives on the Payroll pay-run card, not in the subtitle.
- **Managers.** Hiring, Payroll, Reviews and Tips APIs are all `adminOnly` (`applications.js`, `hiring.js`, `payroll*.js`, `staffReviews*.js`, `contractorTipPage.js`). A manager sees the hub with the Roster child only: the `.hub-tabs` strip is hidden when a single child is visible, the subtitle is `{active_count} active` alone, and the summary endpoint returns the admin-only fields as null for managers (the sidebar never offers what the API bounces, per the `nav.js` rule). `GET /admin/active-staff` keeps its own manager gate (`can_staff`) unchanged.

## 5. Server

All reads. One new route file, two projection extensions, one parameter extension. The payroll and tips files are sensitive paths: the server lane runs the full review fleet.

- **`GET /api/admin/staff-hub/summary`** (new, `server/routes/admin/staffHub.js`, `auth` + `requireAdminOrManager`). Returns:
  ```
  { active_count, deactivated_count, former_staff_count, imported_count,
    new_applications, pending_reviews,
    open_period: { start_date, end_date, payday, exists, status, payouts_accrued } }
  ```
  `active_count` uses the same predicate as `GET /admin/active-staff` without stubs (role staff or manager, status approved/reviewed/submitted, and the `can_staff` gate is not applied to a count). `deactivated_count` = role staff or manager, status deactivated; `imported_count` = those with `cc_id LIKE 'legacy_cc:%' OR import_source = 'payment_history_import'`; `former_staff_count` = the rest. `new_applications` = the badge-counts predicate verbatim. `pending_reviews` = `staff_reviews WHERE status = 'pending'`. **`open_period` is derived, not read:** `payPeriodForDate(todayChicago)` + `computePayday` from `server/utils/payrollPeriods.js` give the window; a LEFT JOIN to `pay_periods ON start_date` fills `exists`, `status` and `payouts_accrued` (count of `payouts` in that period), all null/0 when the row is not there yet. Rows are created lazily by `ensurePayPeriod` when the first shift accrues (usually Saturday), so on a Wednesday the row does not exist and the subtitle must not go blank or fall back to last week. For managers, `new_applications`, `pending_reviews` and `open_period` are null (same role rule badge-counts already applies to `new_applications`).
- **`GET /api/admin/badge-counts`** adds `pending_reviews` (same predicate), zeroed for managers exactly as `new_applications` is.
- **`GET /api/admin/tips`** adds a "lands in" projection per row: `pay_period_start`, `pay_period_end`, `pay_period_status`, via the tip's `shift_id → shifts.event_date → pay_periods` (event_date between start and end), null for an unassigned tip. Existing filters (`bartender_id`, `from`, `to`, cursor) unchanged.
- **`GET /api/admin/tip-feedback`** accepts an optional `target_user_id` filter (integer, validated) alongside the existing `status` filter.

No schema changes. No writes.

## 6. Children: Roster and Hiring

**Roster** (`StaffDashboard.js`, modified in place).
- The switch becomes **Active / Deactivated / All** with counts, `.seg` in the existing `Toolbar`, URL-backed `?tab=` via `useUrlListState` (`active` default; `all` keeps working for old links). "All" stops doing two jobs.
- Deactivated and All views render **group header rows** (`.roster-sect`): "Former staff · N" then "Imported records · N". Imported = `isLegacyCcStub(s) || s.import_source === 'payment_history_import'` (today 0 legacy-CC stubs and 9 payment-history placeholders, the `@imported.invalid` accounts from the July import). The existing "Legacy CC stub" badge, "imported" chip and the server-side email redaction for managers are unchanged; a redacted row says "email redacted for managers" in the sub line instead of a blank.
- The "Open hiring" header button goes (Hiring is a tab). "Send SMS" stays and moves to the hub's `.page-actions` slot (→ `/staffing/legacy`).
- Footer count line becomes `{n} active` / `{n} deactivated · {a} former staff, {b} imported records` / `{n} team members`.
- Empty state: `.hub-empty` "No active staff yet" + "Approved hires land here on their own once onboarding completes." + an "Open Hiring" action, with the one-application line when `new_applications > 0`.

**Hiring** (`HiringDashboard.js`, modified in place).
- Page header goes; the summary stat row (New apps 7d / Need to schedule / Stalled) and the kanban stay; `?schedule=` and `?q=` deep-link behavior stays.
- **The stale-record fold.** Today the Onboarding column renders 40 cards and every one is at 0% (no onboarding step completed). 29 are `hired` rows created 2026-05-27, the CheckCherry cutover day, when the existing roster was bulk-registered through the pre-hire flow and never finished; 3 are `in_progress` signups older than 60 days; 8 are recent signups. The board cannot tell these apart. **Fold predicate (generic, not a date):** an Onboarding-column card whose `onboarding_progress` is 0 AND whose account is older than 60 days. Today that folds 32 and leaves 8 live; the column count shows the live number. The fold renders beneath the live cards as `.hire-fold`, collapsed by default: header "Not started · {n} · oldest {Mon D, YYYY} · not pipeline", sub-line "Accounts older than 60 days that never began onboarding. Open one to deactivate it from its page; nothing here counts toward the board." Expanded, `.hire-stub` rows show name, created date, and a status word (`hired` → "pre-hired", `in_progress` → "signed up"), each linking to `/staffing/applications/:id` exactly as live cards do. No new action, no matcher, no Settings retry. The `stalled` summary stat keeps its own definition (updated_at age) and may count some folded rows; the two measure different things and neither is changed.
- `'hired'` stays a live status for a new pre-hired recruit (day-one rows are under 60 days and render live); the fold never keys on status.

## 7. Children: Payroll and Reviews

**Payroll** (`payroll/PayrollPage.js` and siblings, modified in place).
- Page header and the "← Overview" button go; the four-tab `.seg` (Pay run / History / Tips / 1099 / tax) stays, with the legacy tab remap and the `?period=` handling untouched. Underline above, pills below: Q2 of the design answered in place.
- **Pay run** keeps `PayRunView` as is, including the Still owed / Unpaid payouts / Oldest open / Paid this month stats and "Process period." The open-week-with-nothing-accrued card reads "Nothing accrued yet. Shift pay, tips and review bounties land here on their own as events close out." and, when `pending_reviews > 0`, adds the one-line pointer "{n} pending five-star review(s) would add ${bounty} to this run. Confirm under Reviews." (bounty from the server's `bounty_cents`, never a literal). Whether the period row exists or not is already handled by the view's derived-window behavior; the card copy is the only addition.
- **Tips** restructures in one order: repair, then ledger, then context. When both queues are empty they collapse to one line, "Repair queues are clear: no unassigned tips, nothing deferred," with the existing hint copy; when hot, `UnassignedTipsPanel` (an action) then `DeferredTipsPanel` (a wait) render as today. Below them the ledger moved from `TipsAdmin.js`: one stat ("Total in view" with the tip count), the from/to date filters, and the Activity table with columns Bartender / Amount / Date / Customer / Lands in (the §5 projection: "{Mon D} to {D} · {status}", linking to `?tab=history&period=` when paid, or "unassigned" pointing up at the repair queue). Footer sentence: "Every tip accrues to the bartender's own payout; this ledger is the cross-staff view." Old `/tips` links redirect here with params intact.

**Reviews** (`staffHub/ReviewsPage.js`, new; `StaffReviews.js` deleted). A full tab with no internal tabs.
- **Header line** (in the hub content, not the page header): "Thumbtack reviews arrive on their own · log Google reviews by hand" and the "Log a Google review" action in the hub `.page-actions` slot, opening the existing manual-row form (POST `/admin/staff-reviews`).
- **Pending = workbench cards**, one per `status='pending'` row, newest first: stars, source, date, excerpt, a "Named staff" chip row with a "+ Add a name" picker over the active roster (multi-credit, PATCH `/admin/staff-reviews/:id`), "Confirm and pay ${bounty × names}" (POST `/confirm`) and "Dismiss" (POST `/dismiss`). Confirm with fewer than five stars or no name stays allowed and the button says "Confirm, no bounty" (today's semantics). **Suggested names:** client-side only, an active staffer whose preferred or display first name appears as a whole word in the excerpt (case-insensitive) is pre-filled as a removable chip with the caption "Suggested from the excerpt"; nothing is ever auto-confirmed and the server does no matching.
- **Resolved = table** (Date / Review / Credited / Status / Bounty) for confirmed and dismissed rows; empty copy "Nothing resolved yet. Confirmed and dismissed reviews collect here as rows." Footer: "All time: {n} logged · ${x} in bounties paid · bounty is ${b} flat, five stars with a name required." All figures from the payload.
- **Contest rail** (right column on desktop, stacked below on narrow): quarter label, `pot_cents`, window, the floor sentence built from `min_events_worked` and `min_named_five_stars`, standings rows (name, "{named} of {events}", qualifies / below the floor), the "if it ended today" sentence, "Award the quarter" (POST `/contest-award`, idempotent, confirmed by the existing dialog). Empty: "No qualifiers yet." plus, when a pending review names someone, "Confirming the pending review puts {name} {k} of {min} toward the floor." A three-step "How review money works" explainer closes the rail.
- Confirming, dismissing and awarding call the layout's `refresh()` so the tab badge and subtitle update.

## 8. Sidebar, routes, redirects, links

- **`nav.js`:** Staff item gains `badgeKeys: ['new_applications', 'pending_reviews']` (the `Sidebar` sums an array; single `badgeKey` items keep working). `hiring`, `tips`, `reviews` items removed. The "Revenue" section keeps Marketing and Email leads and its label (not this project's problem).
- **Redirects in `App.js`, param-preserving** (`<Navigate replace>` with `search` carried): `/hiring` → `/staffing/hiring`; `/tips` → `/staffing/payroll?tab=tips`; `/reviews` → `/staffing/reviews`; `/financials/payroll` → `/staffing/payroll` (carrying `?tab&period`, so the Overview card's `?tab=payrun&period=<id>` keeps working). The `/financials` → `/dashboard` redirect stays.
- **In-app links retargeted, every one found by grep before the lane closes:** `overview/PayrollStatus.js` (`PAYROLL_HREF` and the period deep link), `userDetail/tabs/PayoutsTab.js` (two payroll links), `applicationDetail/*` ("Schedule interview" → `/staffing/hiring?schedule=`), `pages/mobile/MorePage.js` (Payroll row → `/staffing/payroll`), `StaffDashboard.js` ("Open hiring" removed), any server email template or admin alert that links `/tips`, `/reviews` or `/hiring` (grep `CLIENT_URL` consumers). `utils/screenKey.js` drops its `financials: 'Payroll'` special case and the test line with it.
- `README.md` folder tree (new `staffHub/` page dir, deleted `TipsAdmin.js` and `StaffReviews.js`) and `ARCHITECTURE.md` route table (new `staffHub.js` route, tips projection, tip-feedback param) update in the same change.

## 9. Feedback on the staffer profile

- `GET /admin/tip-feedback?target_user_id=:id&status=all` feeds a new **Feedback** card at the bottom of the profile's existing Tip Page tab (`userDetail/tabs/TipPageTab.js`): rating, comment, submitter email, date, reviewed state, and the existing "Mark reviewed" action (POST `/admin/tip-feedback/:id/review`). Empty copy: "No feedback yet. Guests can leave a rating and a note from this bartender's thank-you page; each one also emails the inbox." `FeedbackTab` in `TipsAdmin.js` is the donor; `TipsAdmin.js` is deleted once the ledger (§7) and this card are home.

## 10. Error handling

- The summary fetch failing leaves the hub usable: title and tabs render without counts or subtitle, one quiet inline retry in the `.hub-head`, children unaffected (they own their own fetches and error states, unchanged).
- The derived pay-run window never throws on a missing row (`exists:false` is a normal state), and the server never creates a `pay_periods` row from a read.
- Suggested names are advisory: a wrong suggestion is removed by the admin before confirm, and the server validates credits against real user ids as it does today.

## 11. Testing

- **Server:** `staffHub.test.js` (role gating; derived window on a week with no row, `exists:false`; a week with a row, counts match; manager nulls); `badge-counts` gains a `pending_reviews` assertion; `contractorTipPage` tests for the `target_user_id` filter and the tips "lands in" projection (assigned, unassigned). Run the payroll and tips suites the projections reach, one at a time from repo root.
- **Client:** `screenKey.test.js` updated; a `Sidebar` render test for `badgeKeys` summing and the three removed items; redirect smoke via the existing router test pattern if one exists, else a manual walk of all four old URLs with params. CRA CI build (`CI=true react-scripts build`) green before merge.
- **Fidelity:** `ui-ux-review` pointed at the benchmark artifact on the shell lane and on each child lane; usability-clean but off-design is a finding.
- **Manual:** both skins, desktop and the 720px scroll of `.hub-tabs`; manager login sees Roster only; the Overview payroll card deep link lands on the right period; the one real pending review confirms into the open run and the subtitle badge drops to zero.

## 12. Decisions log

- 2026-08-19 Tips & Feedback and Reviews: not dropped (eight days old, not dead), not merged into one tab either; tips to Payroll, feedback to the profile, Reviews keeps a child.
- 2026-08-19 Payroll joins the hub (Dallas had already decided this in another window).
- 2026-08-19 Design session answered the three open questions: subtitle only, no KPI band; Payroll's tabs stay nested as `.seg`; Reviews keeps its tab and drops internal tabs for card + table + rail.
- 2026-08-19 Open pay run in the subtitle derives from the date, not from a `pay_periods` row; quiet weeks name the window and the pay-run card says nothing accrued yet.
- 2026-08-19 The hiring fold keys on zero progress plus 60 days of age, never on status or a cutover date, so a day-one pre-hired recruit renders live and the 3 stale signups fold beside the 29 cutover rows.
