---
spec: none. The findings come from the read-only hygiene audit of 2026-11-16 (rule drift, dead endpoints, contracts and swallowed errors, env parity), each re-checked in the code; the owner asked on 2026-11-19 for them to be done ("would like to get these things done"). The lane split and every design choice below are Claude's.
format: lane map without code (spec 2026-10-19 D12)
revision: >
  5 (2026-11-22). payroll-accrual-surface waits on nothing: the audit-payments branch it named is the
  record of the full payments lane that failed review on 2026-11-13 and never merges (its work was
  re-planned and shipped as audit-payments-core 563bc811), and of this lane's files it touches only a
  7-line netting change in balanceScheduler.js that the netting re-plan carries. The lane's scope now
  names the root (the accrual helper, every caller) and the design. Revision 4 (2026-11-22). Every lane
  of this map has merged and shipped (b75709a) bar payroll-accrual-surface. Revision 3 (2026-11-22). What merged, what is left and what waits on the owner; see status below. The
  cover-swap-approve branch was scrapped on the owner's yes ("if its superseded then, yes"). Two lanes
  join the map, audit-dead-routes-rest and audit-stale-comments, and the two machinery lanes built from
  this window are recorded (stale-rule-imports, gate-smoke-reuse). Revision 2 (2026-11-19) said, in
  short, that the cover-swap-approve lane is superseded because its review found the root in the
  assign upsert, which the cover-claim-cascade lane now owns.
status: >
  Shipped in b75709a (2026-11-22): stale-rule-imports 2a725572, audit-small-fixes c6ac13fe,
  audit-env-guards 11b90ca8, audit-dead-routes 8df7ea03, cover-claim-cascade dc2230a3,
  audit-dead-routes-rest and audit-stale-comments together as audit-cleanup 2fefe67c, gate-smoke-reuse
  5553cf27, the rule-file wording 07e496d0, two test fixture fixes 567dbe9a and 77ce0d10. Not built,
  payroll-accrual-surface.
afterShip: >
  The server booted on b75709a in Render, so the boot guard of audit-env-guards passed there
  (NODE_ENV is production and the required variables are set). The six boot secrets only log and
  report to Sentry when missing; nothing reported one in the post-ship watch.
dropped: the client deposit literal (already fixed on the open audit-payments lane, commit 489cc1ea); the review skill's two-way proportion text (machinery change, left for its own decision).
lanes:
  - id: audit-small-fixes
    status: merged c6ac13fe
    scope: >
      Client calls made through the api instance still read err.response.data, which client/src/utils/api.js
      stopped providing (it rejects with { message, code, fieldErrors, status }). In CancelEventDialog.js the
      LAST_NAME_MISMATCH branch can never fire and a refund decline reason never reaches the operator; in
      PackageDetail.js fieldErrors are never shown; InterviewScheduleModal.js and AdminApplicationDetail.js lose
      the server message. Every api-instance caller reads err.code, err.message and err.fieldErrors instead.
      Raw-axios files that carry the opt-out comment keep err.response. Files an open lane owns
      (AdminUserDetail.js, PayPanel.js, TipPageTab.js) are left alone. Also: the client portal Withdraw button
      (PrescriptionTab.js) shows an error toast when the cancel call fails instead of swallowing it; block-party
      and dinner-party join PERSONAL_EVENT_TYPES in server/utils/marketingAudience.js, and its coverage test
      checks the canonical EVENT_TYPES list instead of rows in the dev database.
    footprint:
      - client/src/pages/admin/CancelEventDialog.js
      - client/src/pages/admin/potions/PackageDetail.js
      - client/src/pages/admin/InterviewScheduleModal.js (or wherever it lives)
      - client/src/pages/admin/AdminApplicationDetail.js (or wherever it lives)
      - the other api-instance files with an err.response read (ProposalDetail.js, AlternativesPanel.js, the payroll panels not owned by an open lane)
      - client/src/pages/public/portal/tabs/PrescriptionTab.js (the withdraw catch only)
      - server/utils/marketingAudience.js, server/utils/marketingAudience.test.js
    blockedBy: []
    lenses: whatever the review skill computes (client, seams, outcomes-providers expected); CancelEventDialog sits beside a refund route, so money reads it.
    laws: the refund decline reason may surface on this admin money route (the error-response invariant's one exception); no server route changes.
    acceptance: a test or a hand check shows the mismatch message and a server refund error reaching the toast; grep finds no err.response read in a file that imports the api instance; the marketing coverage test fails on main for the two types and passes on the lane.
  - id: audit-env-guards
    status: merged 11b90ca8; see beforeShip
    scope: >
      Most security gates open on any NODE_ENV other than exactly production, and nothing checks it at boot.
      The server refuses to start when it runs on Render (RENDER or RENDER_EXTERNAL_URL set) with NODE_ENV not
      production. In production the boot logs and reports to Sentry each webhook or crypto secret that is
      missing (STRIPE_WEBHOOK_SECRET, RESEND_WEBHOOK_SECRET, THUMBTACK_WEBHOOK_SECRET, CAL_WEBHOOK_SECRET,
      ENCRYPTION_KEY, STRIPE_SECRET_KEY) without exiting, since each already fails closed on its own path.
      CLIENT_URL stops falling back to localhost in production: the password-reset link and the CORS list take
      the admin URL from server/utils/urls.js. The unsubscribe token signs with UNSUBSCRIBE_SECRET when set and
      verifies against either it or JWT_SECRET, so links already sent keep working. calendar.js takes the API
      base from urls.js like every other caller. .env.example gains REACT_APP_PUBLIC_SITE_URL,
      REACT_APP_STAFF_URL and NEON_API_KEY, a must-stay-unset note for OPENAI_CUSTOM_HEADERS,
      GOOGLE_GENAI_DEBUG and GOOGLE_GENAI_USER_PROJECT, and drops UPLOAD_DIR.
    footprint:
      - server/index.js (the boot block and the CORS list only)
      - server/routes/auth.js (the reset URL only)
      - server/utils/urls.js
      - server/routes/calendar.js (the API base only)
      - the four UNSUBSCRIBE_SECRET sites and their shared helper if one is extracted
      - .env.example, README.md (generated sections)
      - tests beside each
    blockedBy: []
    lenses: tier A floor (auth and webhook paths); verify.
    laws: the boot refusal ships only after the owner confirms NODE_ENV=production in Render, since a wrong value there would turn this into an outage; no secret gains a fallback.
    acceptance: a test boots the guard with RENDER set and NODE_ENV unset and sees it refuse; a reset URL in a production-env test never contains localhost; an unsubscribe token signed with JWT_SECRET still verifies when UNSUBSCRIBE_SECRET is set.
  - id: cover-swap-approve
    status: superseded by cover-claim-cascade (revision 2); the branch is scrapped
    scope: >
      The cover-swap email links to ADMIN_URL/admin/shifts/cover-swaps/<token>; client/vercel.json strips
      /admin and the admin app has no such route, so the link lands on the home page. The server routes exist
      (server/routes/adminCoverSwaps.js GET /:token, POST /:token/approve, admin or manager only). The admin
      app gains a page at /shifts/cover-swaps/:token that reads the swap, shows the shift and both staffers,
      and approves it with one button, and the email link drops the /admin prefix.
    footprint:
      - client/src/App.js (one admin Route)
      - client/src/pages/admin/CoverSwapApprove.js (new) and its test
      - server/routes/staffShiftActions.js (the link line only)
      - README.md (generated sections)
    blockedBy: []
    lenses: whatever the review skill computes (client, access-egress expected).
    acceptance: the page renders a swap from a minted token on the dev server and the approve button calls the POST; an expired or bad token shows a clear message.
  - id: audit-dead-routes
    status: >
      merged 8df7ea03. It also removed the unused cover-swaps router. Held back and moved to
      audit-dead-routes-rest, six removals a review could not clear in the pass. Kept on purpose,
      the marketing contact email-status PUT and cancel-or-unassign.
    scope: >
      Routes with no caller anywhere: the managers router (its PUT changes a user's email without
      verification), the seven routes marked deprecated that still send client email or SMS, the
      marketing contact email-status PUT, the uncalled shift, proposal, drink-plan, application-note, blog
      import and test-email writes, and the uncalled reads (admin users list, BEO by proposal, recent
      invoices, agreement download, my-requests, the per-shift ics, menu-draft reference, campaign
      enrollments, conversation read, payroll healthcheck); dead utils abandonedQuote, resolveCocktailIds,
      server/utils/clientSources.js and client/src/utils/emailValidation.js.
    blockedBy: [the owner's yes to deleting whole tracked files]
    lenses: whatever the review skill computes.
    acceptance: grep finds no caller for any removed path before removal; the reached suites pass.
  - id: cover-claim-cascade
    scope: >
      Approving a pending cover claim (a shift_request whose replaced_by_request_id points at an approved
      original with cover_requested_at set) through the assign upsert (server/routes/shifts.approval.js
      ~line 283, used by the event page's shift drawer and the phone sheet) or auto-assign
      (server/utils/autoAssign.js ~line 344) sets the claimer approved but never runs the cover cascade, so
      the original stays approved and undropped, the cover stays claimable, and payroll accrues both. Each
      of those paths runs the shared cascade (deny and drop the original, move the out-of-area lock,
      re-accrue on a completed event) when the row it approves is such a claim. The cascade also suppresses
      the covered staffer's pending shift_reminder and staff_thank_you rows, as the drop and emergency-drop
      routes do. The claim email (server/routes/staffShiftActions.js) links to the event page, as the
      claim's push already does, and says to approve the claim there.
    status: >
      merged dc2230a3, shipped. The assign route runs the cascade on a pending cover claim; auto-assign
      skips a live claim only (a finished claim row is seatable again, found in its review).
    blockedBy: []
    lenses: tier A.
    acceptance: a test approves a cover claim through the assign route and through auto-assign and finds the original denied and dropped, one payout line after accrual, and the original's reminder rows suppressed; each fails on main.
  - id: payroll-accrual-surface
    scope: >
      A failed payroll accrual is reported as success: proposals/lifecycle.js (mark completed), the tip
      assign route, balanceScheduler auto-complete. Each failure is recorded where payroll can see it and
      the period-process check refuses a completed event with no payout lines. The root is the helper:
      every caller of accruePayoutsForProposal (fifteen sites) catches a throw into Sentry only, and the
      pay_period_not_open skip returns to all of them as plain success, so a completed event's wages can
      go nowhere with nothing on the payroll screen. Design (Claude's): the exported helper records a
      failure in a new payroll_accrual_failures table, one row per proposal (reason error or
      period_closed, attempts, first and last failure time, a reason code and never an error message),
      when the accrual throws, or when it skips on a pay period that is not open for a completed event
      holding no payout line; it deletes the row when an accrual completes or the proposal is no longer
      completed. Nothing is written on proposals. The mark-completed and tip assign routes carry the
      outcome in their response (payroll_accrual) and the admin screens show a warning toast instead of
      a plain success. The payroll page lists the recorded failures, with a Retry on an error row and a
      manual-fix note on a period_closed row. Processing an open period refuses while a completed event
      dated in it, with an approved roster and no legacy CC participant, holds no payout line or carries
      a recorded failure; a reopened period is not gated, since accrual refuses it and the gate could
      never clear.
    status: not built
    blockedBy: []
    footprint:
      - server/utils/payrollAccrual.js (the wrapper; or a sibling payrollAccrualFailures.js)
      - server/db/schema.sql
      - server/routes/proposals/lifecycle.js
      - server/routes/admin/payrollTips.js
      - server/utils/balanceScheduler.js
      - server/routes/admin/payroll.js (the process gate, the list and the retry routes)
      - client/src/pages/admin/ProposalDetail.js
      - client/src/pages/admin/payroll/UnassignedTipsPanel.js
      - client/src/pages/admin/payroll/ (a failures panel beside the unassigned tips)
    lenses: money, concurrency, lifecycle, seams, client, verify; Gemini on the masked diff.
    acceptance: >
      Tests that fail on main: an accrual that throws leaves a failure row and a later good accrual
      removes it; a completed event whose period is not open and that holds no line leaves a
      period_closed row, and one that already holds lines leaves none; mark-completed and tip assign
      answer with the failure in the response; Process on an open period 409s on a completed, staffed
      event with no lines and on a recorded failure, and passes once a retry writes the lines.
  - id: audit-dead-routes-rest
    status: merged with audit-stale-comments as audit-cleanup 2fefe67c, shipped
    scope: >
      The removals audit-dead-routes held back, each with no caller found. The admin users list GET
      (server/routes/admin/users.js ~line 32), the recent invoices GET (server/routes/invoices.js ~line
      256), the payroll healthcheck (server/routes/admin/payroll.js ~line 22), resolveCocktailIds in
      server/utils/shoppingListGen.js, and send-reminder and create-shift in
      server/routes/proposals/actions.js.
    blockedBy: []
    lenses: whatever the review skill computes.
    acceptance: grep finds no caller for any removed path before removal; the reached suites pass.
  - id: audit-stale-comments
    status: >
      merged as audit-cleanup 2fefe67c, shipped. The two rule-file wordings went to main in the
      revision 4 commit.
    scope: >
      Comments the merged lanes left naming things that moved. No behavior changes, so the review is
      the comment-only proof. server/routes/staffPortal/accountReads.js ~137 and accountReads.test.js
      ~310 (the feed URL comes from API_URL in urls.js); the header of scripts/lib/mergeCheck.js ~101
      (the hook and package.json arms of the stale rule); the header of server/utils/bootEnvCheck.js
      (its first line and the "never fatal" sentence, since the required-env list now lives there and
      is fatal); server/utils/inbox/constants.js ~66 (names the removed resend route);
      server/routes/admin/users.js ~171 (names the removed admin/managers.js);
      server/routes/shifts.bonus.test.js ~413; the tonightNull comment (~161) in
      server/routes/shifts.visibility.endInstant.test.js, whose ended fixture can also fail on a
      daylight-saving night; the leadSources comments that omit server/routes/proposals/public.js ~32.
      Two rule files ride along and make the lane tier hinge (seams and access-egress read them),
      .claude/agents/outcomes-providers.md ~49 (the required-env list is in
      server/utils/bootEnvCheck.js, not server/index.js) and .claude/skills/review/SKILL.md ~140 (the
      hook and package.json arms of the stale rule, as docs/dev.md now lists them).
    blockedBy: []
    lenses: seams and access-egress for the two rule files; the comment-only proof covers the rest.
    acceptance: comment-only-proof passes on the source files; the two rule files match the code.
  - id: stale-rule-imports
    status: merged 2a725572
    scope: >
      Machinery. A sensitive path landing on main restales a lane's review only when it is related to
      the lane (scripts/lib/staleRelated.js); lane:status uses the same rule. Before it, any sensitive
      landing restaled every open review, which is what made parallel windows re-run reviews in a loop.
  - id: gate-smoke-reuse
    status: >
      merged 5553cf27, shipped. Its review found that a range changing the installed packages could
      reuse a smoke run on the old packages; reuse is now refused on such a range. The review's
      environment standing in for the gate's scrubbed one was judged no gap, since the scrubbed env
      exists to keep live keys out of the gate.
    scope: >
      Machinery. The ship gate skips the money smoke only when a passing stamped smoke under 24 hours
      old covers the tree being shipped; --fresh-smoke forces a run.
---

The rule-drift items (the money lens's dead trigger names, stale review-skill and dev-doc text, the codex
status, the size-ratchet wording, the eventTypes path in the project rules) are a docs quick fix on main.

Left over from this work and not in a lane (2026-11-22):

- The two machinery causes of slow reviews noted here (finalize restaling earlier reports, the tier
  script forcing tier A) stopped binding on 2026-11-22, when review became Claude's judgment and the
  receipt tools optional (b75709a).
- Branches stale-rule-imports and audit-env-guards are still present. Each equals its squash, but main
  has moved on their files since, so the merged-lane check does not pass and the delete waits for a yes.
- The name scrub (43f36431, 91a35022, 28fbad84) covered the names known from the repo. A complete sweep
  needs the production client list, which Claude cannot read. 44 tracked docs still hold UUID-shaped
  strings that may be proposal link tokens.
- For the owner's list, found while reviewing and not fixed: the email Conversations unread badge never
  clears; server/utils/ccWrapUpEmailTemplate.js ~16 builds a link from PUBLIC_SITE_URL with no fallback;
  missingRequiredEnv does not trim a whitespace-only value.
