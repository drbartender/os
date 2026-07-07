# Admin Cross-Navigation Design

**Date:** 2026-07-07
**Status:** Approved (section-by-section in brainstorm)
**Source inventory:** 14-agent workflow sweep of every admin surface (86 raw findings, 50 files; 71 in scope after cuts and the cc-demolition obsolescence). Appendix below is the authoritative list.

## Goal

Every entity referenced on an admin screen is clickable through to that entity's canonical page, and Back returns you exactly where you were: same tab, same filters, native scroll restoration. Example that started this: staff page, shifts tab, click an event the staffer worked, look at it, Back lands you on that staff page with the shifts tab still selected.

## Decisions (locked)

1. **Back fidelity is level 2.** Tabs and filters live in the URL and survive the round trip. Chosen over session/history caches because URL state matches the existing drawer precedent (useDrawerParam), makes views shareable and bookmarkable, and survives refresh and new-tab.
2. **Invoices get no admin page.** Invoice references open the existing InvoicesDrawer for the owning proposal (drawers are URL query params, so these are real links). Where an invoice token is in the payload, a secondary affordance opens the public /invoice/:token in a new tab.
3. **Pay periods get no page.** Staff-profile payout rows deep-link to /financials/payroll?tab=history&period=<id>; the payroll history view honors ?period= by expanding and scrolling to that period.
4. **Manual events (no proposal) keep the ShiftDrawer as canonical target.** Their rows become real links to the drawer URL (?drawer=shift&drawerId=<id>, matching useDrawerParam), so cmd-click works. No detail page is built for proposal-less events.
5. **LabRat is out of scope entirely** (feature is being removed; do not touch LabRatBugsPage).
6. **Edge cuts:** edges needing server changes for marginal value are skipped (see Skipped table). Core and nice all ship, including their server-side SELECT additions.

## Link conventions

- **Table/list rows:** ClickableRow + RowLink (existing components, existing pattern). New coverage follows it exactly: row navigates on clean click, RowLink in the identifying cell for native anchor behavior.
- **Inline references** (names in card headers, rosters, timeline items, drawer bodies): new `EntityLink` component in client/src/components/EntityLink.js: a real react-router <Link> that inherits text color and underlines on hover (class `entity-link`, styles in index.css). Admin pages must not sprout default-blue links; affordance is the hover underline plus cursor.
- **Pattern upgrades:** every raw `onClick={() => navigate(...)}` reference becomes a real Link/EntityLink with the same visual, so cmd/ctrl/middle-click open a new tab natively.
- **Drawer targets:** links to drawers are real URLs (query param form), built with the same helper the drawers already use.
- **Modals:** references inside modals become EntityLinks too; navigation naturally unmounts the modal. No special close handling unless a modal traps focus in a way that breaks (checked per instance).
- **Self-references stay dead.** The entity a page is about never links to itself.
- **Cross-links between proposal and event views are links, not view merges** (proposals and events remain separate views per standing convention).

## URL state contract (level 2)

New hook `useUrlListState` in client/src/hooks/useUrlListState.js, built on useSearchParams:

- A screen declares its keys and defaults once: `const [state, setState] = useUrlListState({ tab: 'upcoming', q: '', status: '' })`.
- Values equal to the default are OMITTED from the URL (clean URLs; /events not /events?tab=upcoming).
- All writes use `setSearchParams(..., { replace: true })`: typing and filter flips never create history entries. Back always crosses pages, never filter keystrokes.
- Unknown/invalid values fall back to the default (bad ?tab= never crashes a screen).
- Existing drawer params (useDrawerParam) are preserved untouched by the hook (it only manages its declared keys).

Screens and their keys:

| Screen | Keys |
|---|---|
| EventsDashboard | tab (upcoming/unstaffed/past/all), q, status |
| ProposalsDashboard | tab, q, source |
| ClientsDashboard | q, sort |
| StaffDashboard (/staffing) | tab (active/all), q |
| HiringDashboard | q |
| DrinkPlansDashboard | tab, q |
| EmailLeadsDashboard | q, status, source, page |
| PayrollPage | tab (current/history/unassigned), period (expanded period id; deep-link receiver) |
| FinancialsDashboard | tab only (basis/range/from/to/include_cc are ALREADY URL-backed via useMetricsFilter; do not double-manage them) |
| Messages | client (selected thread) |
| EmailConversations | thread (selected thread) |
| AdminUserDetail | tab (overview/shifts/payouts/...) |



## ScrollToTop POP guard

client/src/components/ScrollToTop.js currently scrolls to top on every pathname change, including browser Back. Add `useNavigationType()`; when the navigation is POP, do nothing, letting the browser's native scroll restoration work. Hash-anchor yield behavior is unchanged.

## Server additions (read-only SELECT columns, no schema changes)

| Route (file) | Addition | Consumer |
|---|---|---|
| /proposals/financials (server/routes/proposals/, financials handler) | client_id on the proposals table rows AND the payments-in-range rows | FinancialsDashboard client links |
| /admin/payroll/deferred-tips (server/routes/admin/payroll.js, ~528-533) | staff_ids as a second ARRAY() subquery MIRRORING the names subquery, with an explicit identical ORDER BY added to BOTH (today the names ARRAY() has no ORDER BY; without matching order the name-to-id index alignment is not guaranteed) | DeferredTipsPanel staff links |
| /stripe-payouts (server/routes/stripePayouts.js, LINE_SELECT ~14-24) | staff_user_id via a read-only LEFT JOIN tips ON tips.id = l.tip_id (no tips join exists today); proposal_id and invoice_token already emitted | StripePayoutsTab staff links |
| GET /drink-plans/:id (server/routes/drinkPlans.js, handler ~434) | p.client_id directly from the existing proposals join (no clients join needed) | DrinkPlanDetail client link |
| GET /shifts/detail/:id (server/routes/shifts.js, inline query at ~245; clients join c already at ~259) | c.id AS client_id | ShiftDrawer client link |
| /clients/:id (server/routes/clients.js) | only if the proposals array lacks status: a flag distinguishing rows with a live event | ClientDetail event-vs-proposal row links |
| /email conversations threads (server/routes/emailMarketing.js) | only if lead_id is genuinely absent from the thread list payload (verify first) | EmailConversations sidebar links |

Payroll EventLineItem needs NO server change: it links via /events/shift/:shift_id (existing redirect route resolves to the owning event).

## Explicitly out of scope

- Scroll-position bookkeeping beyond the ScrollToTop POP guard.
- Any new detail pages (invoices, pay periods, manual events all resolve to existing surfaces).
- Staff portal and client portal surfaces (admin site only).
- LabRat surfaces.
- Merging proposal/event views (cross-links only).

## Appendix: authoritative finding list (71 in scope, 8 skipped)

> 2026-07-07 post-review correction: 7 rows for CcImportReviewPage/CcImportWrapUpPage were obsoleted mid-design when the cc-demolition lane merged (f39de17) and deleted both pages; ProposalCreate.js:460 moved to skipped (file frozen over the ratchet hard cap).

Severity: core = obvious click-through an admin will use constantly; nice = secondary; edge = marginal but free. "id?" = whether the entity id is already in the data feeding the render.

### Lane A; primitives + shell

| File:line | Entity | Target | id? | Current | Sev |
|---|---|---|---|---|---|
| `client/src/components/adminos/CommandPalette.js:128` | client / proposal / event / staff (global search results) | `/clients/:id, /proposals/:id, /events/:id, /staffing/users/:id (PATH_BY_TYPE[it.type] + '/' + it.id)` | yes | pattern-upgrade | nice |
| `client/src/components/adminos/drawers/PresenceDrawer.js:47` | staff member (users / office team) | `/staffing/users/:id` | yes | plain-text | edge |
| `client/src/components/adminos/drawers/PresenceDrawer.js:70` | staff member (users / office team) | `/staffing/users/:user_id` | yes | plain-text | edge |
| `client/src/components/adminos/PresenceStrip.js:89` | staff member (users / office team) | `/staffing/users/:id` | yes | plain-text | edge |
| `client/src/components/adminos/PresenceStrip.js:126` | staff member (users / office team) | `/staffing/users/:id` | yes | plain-text | edge |

### Lane B; events + home dashboard

| File:line | Entity | Target | id? | Current | Sev |
|---|---|---|---|---|---|
| `client/src/components/adminos/drawers/ShiftDrawer.js:400` | client | `/clients/:id` | no | plain-text | nice |
| `client/src/components/adminos/drawers/ShiftDrawer.js:445` | staff member (users) | `/staffing/users/:user_id` | yes | plain-text | core |
| `client/src/components/adminos/drawers/ShiftDrawer.js:481` | staff member (users) | `/staffing/users/:user_id` | yes | plain-text | nice |
| `client/src/components/adminos/drawers/ShiftDrawer.js:533` | staff member (users) | `/staffing/users/:user_id` | yes | plain-text | nice |
| `client/src/pages/admin/Dashboard.js:306` | event | `/events/:proposal_id (or /events/shift/:id when no proposal_id)` | yes | pattern-upgrade | core |
| `client/src/pages/admin/Dashboard.js:308` | proposal | `/proposals/:id` | yes | pattern-upgrade | core |
| `client/src/pages/admin/EventDetailPage.js:194` | proposal | `/proposals/:id` | yes | plain-text | nice |
| `client/src/pages/admin/EventDetailPage.js:201` | client | `/clients/:id` | yes | pattern-upgrade | core |
| `client/src/pages/admin/EventDetailPage.js:339` | shift | `/events/shift/:id` | yes | modal-only | edge |
| `client/src/pages/admin/EventDetailPage.js:382` | staff member (users) | `/staffing/users/:id` | yes | plain-text | core |
| `client/src/pages/admin/EventsDashboard.js:512` | event (manual, no proposal) | `/events/:id` | no | wrong-target | edge |

### Lane C; proposals + clients

| File:line | Entity | Target | id? | Current | Sev |
|---|---|---|---|---|---|
| `client/src/pages/admin/AlternativesPanel.js:137` | proposal | `/proposals/:id` | yes | pattern-upgrade | core |
| `client/src/pages/admin/ChangeRequestsDashboard.js:17` | client | `/clients/:id` | yes | plain-text | nice |
| `client/src/pages/admin/ClientDetail.js:250` | event | `/events/:id` | no | links-to-proposal-not-event | nice |
| `client/src/pages/admin/ProposalDetail.js:367` | client | `/clients/:id` | yes | pattern-upgrade | core |
| `client/src/pages/admin/ProposalDetail.js:486` | client | `/clients/:id` | yes | pattern-upgrade | core |
| `client/src/pages/admin/ProposalDetail.js:712` | event | `/events/:id` | yes | pattern-upgrade | core |
| `client/src/pages/admin/ProposalDetail.js:741` | proposal | `/proposals/:id` | yes | modal-only | edge |
| `client/src/pages/admin/ProposalDetailEditForm.js:340` | client | `/clients/:id` | yes | plain-text | edge |
| `client/src/pages/admin/ProposalsDashboard.js:222` | client | `/clients/:id` | yes | wrong-target | edge |
| `client/src/pages/admin/ProposalsDashboard.js:251` | event | `/events/:id` | yes | pattern-upgrade | core |

### Lane D; money surfaces

| File:line | Entity | Target | id? | Current | Sev |
|---|---|---|---|---|---|
| `client/src/components/adminos/drawers/InvoicesDrawer.js:65` | invoice | `NO-TARGET` | yes | wrong-target | nice |
| `client/src/components/InvoiceDropdown.js:67` | invoice | `NO-TARGET` | yes | wrong-target | nice |
| `client/src/pages/admin/FinancialsDashboard.js:143` | client | `/clients/:id` | no | plain-text | nice |
| `client/src/pages/admin/FinancialsDashboard.js:183` | event | `/proposals/:proposal_id (admin); invoice itself is NO-TARGET (public /invoice/:token only)` | yes | wrong-target | nice |
| `client/src/pages/admin/FinancialsDashboard.js:185` | client | `/clients/:id` | no | plain-text | nice |
| `client/src/pages/admin/payroll/DeferredTipsPanel.js:79` | staff | `/staffing/users/:id (per named staffer)` | no | plain-text | nice |
| `client/src/pages/admin/payroll/DeferredTipsPanel.js:80` | event | `/events/shift/:shift_id (redirects to owning event)` | yes | plain-text | nice |
| `client/src/pages/admin/payroll/EventLineItem.js:73` | event | `/events/shift/:shift_id (redirects to owning event); direct /events/:id needs proposal_id added server-side` | yes | plain-text | core |
| `client/src/pages/admin/payroll/PayoutRow.js:20` | staff | `/staffing/users/:contractor_id` | yes | plain-text | core |
| `client/src/pages/admin/payroll/PayQRModal.js:22` | staff | `/staffing/users/:contractor_id` | yes | modal-only | edge |
| `client/src/pages/admin/payroll/UnassignedTipsPanel.js:60` | staff | `/staffing/users/:target_user_id` | yes | plain-text | core |
| `client/src/pages/admin/StripePayoutsTab.js:12` | staff | `/staffing/users/:id` | no | plain-text | nice |
| `client/src/pages/admin/StripePayoutsTab.js:14` | proposal | `/proposals/:proposal_id (invoice_number = NO-TARGET; client_id not available)` | yes | plain-text | nice |
| `client/src/pages/admin/StripePayoutsTab.js:15` | invoice | `NO-TARGET (no admin invoice page; public /invoice/:token exists via inv.token)` | unknown | plain-text | edge |
| `client/src/pages/admin/TipsAdmin.js:160` | staff | `/staffing/users/:target_user_id` | yes | plain-text | core |
| `client/src/pages/admin/TipsAdmin.js:237` | staff | `/staffing/users/:target_user_id` | yes | plain-text | nice |

### Lane E; staffing + hiring + detail pages

| File:line | Entity | Target | id? | Current | Sev |
|---|---|---|---|---|---|
| `client/src/components/adminos/InterviewScheduleModal.js:78` | application / applicant | `/staffing/applications/:id` | yes | modal-only | edge |
| `client/src/pages/admin/applicationDetail/AdminApplicationDetail.js:128` | staff member (users table) | `/staffing/users/:id` | yes | plain-text | nice |
| `client/src/pages/admin/HiringDashboard.js:169` | application | `/staffing/applications/:id` | yes | pattern-upgrade | core |
| `client/src/pages/admin/HiringDashboard.js:318` | application | `/staffing/applications/:id` | yes | pattern-upgrade | core |
| `client/src/pages/admin/userDetail/AdminUserDetail.js:433` | proposal | `/proposals/:id` | yes | plain-text | edge |
| `client/src/pages/admin/userDetail/components/AssignToEventModal.js:142` | event | `/events/:proposal_id (or /events/shift/:id)` | yes | modal-only | nice |
| `client/src/pages/admin/userDetail/tabs/ApplicationTab.js:11` | application | `/staffing/applications/:id` | yes | plain-text | edge |
| `client/src/pages/admin/userDetail/tabs/MessagesTab.js:27` | event | `/events/shift/:shift_id (redirects to owning event)` | yes | plain-text | edge |
| `client/src/pages/admin/userDetail/tabs/MessagesTab.js:41` | staff member | `/staffing/users/:sender_id` | yes | plain-text | edge |
| `client/src/pages/admin/userDetail/tabs/OverviewTab.js:118` | event | `/events/:proposal_id (fallback /events/shift/:id)` | yes | plain-text | core |
| `client/src/pages/admin/userDetail/tabs/PayoutsTab.js:44` | pay period | `NO-TARGET (currently jumps to /financials/payroll list)` | yes | pattern-upgrade | nice |
| `client/src/pages/admin/userDetail/tabs/ShiftsTab.js:76` | event | `/events/:proposal_id (fallback /events/shift/:id)` | yes | plain-text | core |
| `client/src/pages/AdminDashboard.js:410` | event | `/events/:proposal_id (or /events/shift/:id)` | yes | plain-text | core |
| `client/src/pages/AdminDashboard.js:477` | staff member | `/staffing/users/:user_id` | yes | plain-text | nice |
| `client/src/pages/AdminDashboard.js:616` | staff member | `/staffing/users/:user_id` | yes | plain-text | edge |
| `client/src/pages/AdminDashboard.js:684` | event | `/events/shift/:shift_id` | yes | plain-text | edge |
| `client/src/pages/AdminDashboard.js:725` | staff member | `/staffing/users/:recipient_id` | yes | plain-text | edge |

### Lane F; comms (email, SMS, drink plans)

| File:line | Entity | Target | id? | Current | Sev |
|---|---|---|---|---|---|
| `client/src/components/AudienceSelector.js:119` | email lead | `/email-marketing/leads/:id` | yes | modal-only | edge |
| `client/src/components/DrinkPlanCard.js:183` | drink plan | `/drink-plans/:id` | yes | pattern-upgrade | nice |
| `client/src/pages/admin/DrinkPlanDetail.js:185` | client | `/clients/:id` | no | plain-text | nice |
| `client/src/pages/admin/DrinkPlanDetail.js:189` | proposal | `/proposals/{proposal_id}` | yes | not-rendered | core |
| `client/src/pages/admin/DrinkPlanDetail.js:247` | staff | `/staffing/users/:id` | yes | plain-text | edge |
| `client/src/pages/admin/EmailCampaignDetail.js:255` | email lead | `/email-marketing/leads/:id` | yes | plain-text | core |
| `client/src/pages/admin/EmailCampaignDetail.js:288` | email lead | `/email-marketing/leads/:id` | yes | plain-text | core |
| `client/src/pages/admin/EmailConversations.js:89` | email lead (conversation thread) | `/email-marketing/leads/:id` | unknown | plain-text | edge |
| `client/src/pages/admin/EmailConversations.js:109` | email lead | `/email-marketing/leads/:id` | yes | plain-text | nice |
| `client/src/pages/admin/EmailLeadDetail.js:162` | email campaign | `/email-marketing/campaigns/:id` | yes | plain-text | nice |
| `client/src/pages/admin/Messages.js:111` | client | `/clients/:id` | yes | plain-text | nice |
| `client/src/pages/admin/Messages.js:130` | client | `/clients/:id` | yes | plain-text | core |

### Skipped (approved cuts)

| File:line | Entity | Why skipped |
|---|---|---|
| `client/src/pages/admin/ProposalCreate.js:460` | client | file frozen over the 1000-line ratchet cap; edge not worth an extraction |
| `client/src/pages/admin/ProposalDetailPaymentPanel.js:246` | email lead | TT lead cost line; edge, no target |
| `client/src/components/admin/LegacyCcPaymentsPanel.js:55` | payment | legacy charge id; edge, file not otherwise touched |
| `client/src/pages/admin/userDetail/tabs/ShiftsTab.js:84` | client | edge needing server change (approved cut) |
| `client/src/pages/admin/applicationDetail/components/TimelineCard.js:128` | staff member (admin/actor who authored the note) | note-author name; edge, no id |
| `client/src/pages/admin/DrinkPlansDashboard.js:178` | client | edge needing server change (approved cut) |
| `client/src/pages/admin/LabRatBugsPage.js:167` | tester | LabRat feature being removed |
| `client/src/components/adminos/StaffPills.js:21` | staff member (shift position) | tooltip name; edge, no id |
