---
spec: none. The findings come from the read-only hygiene audit of 2026-11-16 (rule drift, dead endpoints, contracts and swallowed errors, env parity), each re-checked in the code; the owner asked on 2026-11-19 for them to be done ("would like to get these things done"). The lane split and every design choice below are Claude's.
format: lane map without code (spec 2026-10-19 D12)
revision: 2 (2026-11-19): the cover-swap-approve lane is superseded. Its review found that the one-click page reached /api/admin/cover-swaps, which skips the staffing permission and the claimer's confirmation, and that the approve paths most admins use (the event page, the phone sheet, auto-assign) approve a cover claim through the assign upsert without the cover cascade, so the covered staffer stays approved and payroll pays both. The email link fix moves into the new cover-claim-cascade lane, which fixes that root; the unused cover-swaps router moves into audit-dead-routes. The cover-swap-approve branch stays unmerged until its scrap is approved.
dropped: the client deposit literal (already fixed on the open audit-payments lane, commit 489cc1ea); the review skill's two-way proportion text (machinery change, left for its own decision).
lanes:
  - id: audit-small-fixes
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
  - id: cover-swap-approve  (superseded by cover-claim-cascade, revision 2)
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
    blockedBy: [audit-payouts-followup merged, since it rewrites shifts.approval.js and coverApprovalCascade.js]
    lenses: tier A.
    acceptance: a test approves a cover claim through the assign route and through auto-assign and finds the original denied and dropped, one payout line after accrual, and the original's reminder rows suppressed; each fails on main.
  - id: payroll-accrual-surface
    scope: >
      A failed payroll accrual is reported as success: proposals/lifecycle.js (mark completed), the tip
      assign route, balanceScheduler auto-complete. Each failure is recorded where payroll can see it and
      the period-process check refuses a completed event with no payout lines.
    blockedBy: [audit-payouts-followup and audit-payments merged, since both rewrite these files]
    lenses: tier A.
---

The rule-drift items (the money lens's dead trigger names, stale review-skill and dev-doc text, the codex
status, the size-ratchet wording, the eventTypes path in the project rules) are a docs quick fix on main.
