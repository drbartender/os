# Needs Attention tabs: Overview Band 1 rework (design spec)

Date: 2026-07-14. Amends the Money Board spec
(`2026-07-09-money-board-design.md`) sections 2 and 8. Brainstormed live with
Dallas. Everything here is client-side presentation over existing endpoints:
**zero server changes.** The two LAW contracts are untouched.

## 1. Decision summary

- **The full-width Needs-you grid and the standalone Payroll card retire.**
  Band 1 becomes a single row: a tabbed "Needs attention" card (wide) beside
  the Pipeline card (narrow). The tab headers do the summarizing; the body
  shows one category at a time, so the card stays a few rows tall no matter
  how busy the week is.
- **Inclusion test (normative).** An item earns a slot only if (a) a specific
  action exists that Dallas can take right now, (b) inaction has a cost, and
  (c) the item disappears once acted on. Status that never resolves is not
  attention: it lives in a tab body (payroll status) or the Pipeline card,
  never as a queue item.
- **Tabs:** Staffing, Prep, Clients, Money, plus Sales rendered only when it
  has items. Each header carries its item count and a dot colored by the worst
  priority inside, so a fire in a background tab is visible without clicking.
- **Cut:** the un-aged proposal followups (today's first-2 sent/viewed/modified
  slice) are removed entirely. The email/SMS drip covers viewed-not-accepted;
  only sent-but-never-viewed after 3 days earns a Sales item.
- **Added ball-in-court sources** (both endpoints exist, both
  `auth + requireAdminOrManager`, no server work): pending change requests and
  unread inbound SMS.

## 2. Item inventory (normative)

**Staffing**
- Unstaffed upcoming events: existing predicate
  (`approvedCount(e) < parsePositionsCount(e)`, `event_date` today or later).
  Priority: danger under 7 days out, warn otherwise. Links: event/shift as
  today. The old global cap of 3 is dropped in favor of the per-tab cap (§3).
- New applications: count of `onboarding_status === 'applied'`, one rollup item
  linking to `/hiring`. Admin-only fetch exactly as today; the item is simply
  absent for managers. Priority: info.

**Prep**
- The two shopping-list stages exactly as `buildPrepItems` pins them
  ("finished the potion planner, waiting on shopping list" and "shopping list
  needs review"), priority by event proximity, links to `/drink-plans/:id`.
  `MAX_PREP_ITEMS` is superseded by the per-tab cap; the overflow row keeps its
  `/drink-plans?tab=submitted` target.
- Menu-design items are DEFERRED to the menu-design follow-up (§7): the
  planner captures the client's preferences (`menuStyle`, `menuTheme`,
  `drinkNaming`, `menuDesignNotes` in the submit payload) but no state tracks
  whether the menu graphic was made, and a hand-flipped "done" bit outside the
  real workflow would rot. The queue item lands when done means a real
  artifact.

**Clients** (new; visible to admins AND managers)
- Pending change requests: `GET /api/proposals/change-requests?status=pending`
  (shape: `{requests: [...]}` with `proposal_id`, `client_name`, `event_date`,
  `edit_window`). One item per request: "«client» requested changes", sub =
  event type + date. Priority: danger when `edit_window = 'inside_t14'`
  (matches the server's own urgency sort), warn otherwise. Links to
  `/proposals/:proposal_id`, where the approve/decline card already lives.
- Unread SMS: `GET /api/sms/conversations` (rows: `client_id`, `name`,
  `unread_count`, relay traffic already excluded server-side). One item per
  conversation with `unread_count > 0`: "«name» · N unread". Priority: warn (a
  human is waiting). Links to `/messages?client=<client_id>`, which opens the
  exact thread today. When the client-detail messaging follow-up (§7) lands,
  this target flips to the client page: a one-line change.
- Within the tab, change requests list before SMS items.

**Money**
- Payroll status block (admin-only): the absorbed PayrollCard body, all four
  states preserved (due with total/staff/overdue chip, accruing with payday,
  no-open-period, error degrading to a link). Deferred-tips line stays. The
  whole block links to `/financials/payroll` (`?tab=history&period=<id>` when
  showing a closed due period). This is tab-body content, not a queue item,
  and does not count toward the tab's item count.
- The separate "payroll overdue" queue item DIES: the status block already
  shows the overdue state. Overdue instead feeds the tab's dot as a virtual
  danger (and makes Money the default tab when it is the worst thing on the
  board).
- Unmatched payouts: one-liner item from the existing `/stripe-payouts`
  summary fetch, both roles, priority warn, links to the Payouts tab with
  `show=unmatched` as today.
- Manager view: zero payroll fetches, no status block; the tab shows payouts
  only (or its empty state). Same §1 role-gating law as the Money Board spec.

**Sales** (conditional: the tab renders only when non-empty)
- Sent but never viewed after 3 days: `status === 'sent'` AND `sent_at` older
  than 72 hours, from the proposals fetch the page already makes (a viewed
  proposal flips to `viewed`/`modified`, so still-`sent` means never seen).
  Item: "«client» proposal unviewed · sent Nd ago", priority info, links to
  `/proposals/:id`.

## 3. Card mechanics

- **Tab state is component state, not URL.** It resets each mount; the default
  tab is computed, and a URL param would fight it. (The page-level
  Overview/Payouts seg keeps its URL state unchanged.)
- **Default tab** = the tab holding the worst-priority item (danger > warn >
  info; payroll-overdue counts as danger), ties broken by fixed order
  Staffing, Prep, Clients, Money, Sales. No items anywhere: admins default to
  Money (the status block is still worth a glance); managers get the collapsed
  state below.
- **Tab row**: the four core tabs always render once any tab has content, with
  zero-count tabs greyed (stable positions, no layout shuffle). Sales appears
  only when non-empty. Dot renders only when the tab has items (or payroll
  overdue); color = worst priority within.
- **Per-tab cap**: 6 visible rows, then one overflow row ("N more") linking to
  the tab's home surface: Staffing `/events`, Prep `/drink-plans?tab=submitted`,
  Clients `/messages`, Money `/dashboard?tab=payouts`, Sales
  `/proposals?tab=active`.
- **Empty states**: an empty visible tab body says "Nothing pressing." When
  NOTHING has content (manager with zero items), the card collapses to one
  slim "Nothing pressing right now" line, no tab row.
- **All tab panels stay mounted**, inactive ones hidden with CSS. This keeps
  each fetch and the payroll block living where they belong (mounted once) and
  lets background tabs feed their dots. The existing `onOverdue` callback
  pattern is repurposed to feed the Money dot instead of injecting an item.
- Row shape, `queue-item` markup, and `EntityLink` real-link behavior are
  unchanged; `QUEUE_ICON` gains entries for the new types (change-request,
  sms) from the existing glyph set.

## 4. Data flow

- Two NEW fetches on the overview page, both isolated with their own catch,
  degrading silently to absent items like every Band 1 fetch (spec 2026-07-09
  §2 isolation rule): `GET /proposals/change-requests?status=pending` and
  `GET /sms/conversations`. Both admin+manager; neither is gated.
- Existing fetches unchanged: shifts, proposals, drink-plans, stripe-payouts
  summary, applications (admin-only), payroll pair + deferred-tips
  (admin-only, moving with the PayrollCard logic into the Money tab body).
- Item-building helpers (change requests, unread SMS, sales-aged, plus the
  existing actionQueue builders) consolidate in a sibling module next to
  `PrepQueue.js` so `OverviewPage.js` stays in the file-size sweet spot.

## 5. Layout, files, skins

- Band 1 row: tabbed card roughly 2fr, Pipeline card 1fr; the old `grid-2`
  payroll/pipeline row dies. Page header and subtitle unchanged.
- Files (pinned): `NeedsYouStrip.js` is reworked in place into the tabbed
  card; `PayrollCard.js` is reworked into `PayrollStatus.js` (the Money tab's
  status block, same fetches and view states, card chrome dropped); item
  builders (change requests, unread SMS, sales-aged, existing actionQueue
  logic) land in a new `queueItems.js` beside `PrepQueue.js`. README tree and
  ARCHITECTURE updated for removed/added files per the docs table.
- CSS: tokens only, vanilla CSS in `index.css`, both skins (apothecary +
  After Hours), both density modes. Mobile 390px: tab chips scroll
  horizontally in their own container, card stacks above Pipeline, no
  page-level horizontal scroll (LAW).

## 6. Role gating recap

- Payroll fetches + status block: admin-only, identical gating to today
  (manager fires zero `/admin/payroll/*` requests).
- Applications fetch/item: admin-only, unchanged.
- Change requests, SMS conversations, payouts: admin+manager, ungated.

## 7. Out of scope, committed follow-ups

1. **Client-detail messaging.** Full SMS history + reply on the client details
   page; the Messages nav entry demotes to an "All messages" link somewhere
   sensible; unread queue items retarget to the client page. Dallas's driver:
   finding a thread in the Messages tab is too tedious.
2. **Menu design page.** A real workflow over the planner-captured menu
   preferences, producing a real artifact; introduces the done-state that then
   powers "menu to design" Prep items. Dallas has page ideas beyond this
   spec's scope.

Both recorded in `docs/fix-list-remaining-2026-07-02.md`.

## 8. Definition of done

- Tab counts, dots, and default-tab selection verified against mixed-priority
  fixtures (danger in a background tab shows its dot without clicking).
- The noise is gone: no un-aged proposal items anywhere; a proposal sent
  yesterday appears nowhere.
- Every new item links where it claims: change request lands on the proposal
  detail with the decide card visible; unread SMS opens the exact thread via
  `/messages?client=<id>`.
- Payroll absorption: admin sees all four status-block states in the Money
  tab; the standalone card is gone; manager smoke shows zero admin-only
  requests and a payouts-only Money tab.
- All-empty collapse verified (manager with clean board gets the slim line).
- Both skins, both density modes, 390px smoked; no page-level horizontal
  scroll.
- `cd client && CI=true npx react-scripts build` passes (Vercel gate).
- README/ARCHITECTURE updated for the file changes (§5).
