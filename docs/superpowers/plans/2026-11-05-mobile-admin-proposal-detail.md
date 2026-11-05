---
spec: docs/superpowers/specs/2026-08-13-mobile-admin-design.md, section 5 (Detail) and section 3's Visual contract, with its "Plan decisions of 2026-11-05" block (written with this plan; it records where the build departs from the benchmark and why). The owner asked on 2026-11-05 to start the plan for the phone proposal detail, the last unbuilt phase 1 screen, designed in the design tool on 2026-09-15.
format: lane map without code (spec 2026-10-19 D12)
revision: 3 (2026-11-05; the plan fleet's findings folded, fidelity and decomposition; Send reminder left off by the owner)
status: >
  Four lanes, each cut from current main, built by Claude in its own worktree, reviewed at the tier it
  computes, merged through scripts/merge-lane.sh from os, and each shipping on its own. The list trim
  stands alone. The other three run in order (detail, then the two action sheets, then the edit sheet),
  because each later lane edits the page the first one creates. Send reminder is left off
  (the owner, 2026-11-05: "leave it off").
visual contract: >
  Benchmark: docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html, the snapshot of
  "Phone Admin Shell.dc.html" in the design project the spec's Visual contract names, byte-identical
  to the project's file on 2026-11-05 (DesignSync get_file, cmp). The screens: the Proposal detail
  header (lines 53-70), its main (433-512), the edit sheet in the proposal variant (829-905; the layout
  pass of docs/design-artifacts/2026-10-06-edit-sheet-layout governs its frame, as it does the event
  variant's) and the archive sheet (911-922). The resend sheet has no benchmark screen of its own; it
  takes the edit sheet's notify step idiom (.m-notify). Token and component law: the OS design system
  vendored under docs/design-artifacts/_ds/ and the .m-* family already in client/src/index.css.
  Each lane owns the fidelity of the screens it builds: proposal-detail-phone the detail,
  proposal-actions-phone the resend and archive sheets, proposal-edit-sheet the proposal variant of the
  edit sheet. At its cut each of those lanes re-pulls the file with DesignSync (list_files, then
  get_file) and byte-compares it with the snapshot. A moved file refreshes the snapshot and the spec's
  Visual contract line before any code. Where the plan decisions differ from the benchmark they are the
  contract.
commands: >
  Client tests, from the lane's worktree: cd client && CI=true npx react-scripts test --watchAll=false
  <test paths>. Client build: cd client && CI=true npx react-scripts build. Server suites run only
  through the review skill (node scripts/run-suites.js --changed <base>..<tip>), never by hand, because
  every window shares the dev database. The money smoke runs as node scripts/testdb-smoke.js under the
  review skill. Headless captures at 320 and 390 wide come from the main session (scripts/mobile-capture.js),
  signed in to the dev app, in both skins.
lanes:
  - id: proposals-list-at-rest
    scope: >
      GET /proposals?envelope=1, the phone Proposals list's answer, leaves out token, client_email and
      client_phone from every row, so a phone's stored list holds no public token and no client contact
      (the 2026-10-15 fix-list item; spec section 3, Plan decisions of 2026-11-05, At rest). The bare-array
      answer, the desktop's, is unchanged byte for byte. Nothing the phone list draws reads the three
      fields (ProposalsListPhone.js and proposalCards.js read none of them).
    footprint:
      - server/routes/proposals/list.js  (envelope mode only)
      - server/routes/proposals/list.phone.test.js
    blockedBy: []
    lenses: whatever the review skill computes for a server route (the tier B floor with seams and access-egress expected).
    laws: no new endpoint; the bare array keeps every column it has today; the envelope keeps every other field, its totals and its paging.
    seams: every reader of the envelope rows (ProposalsListPhone.js, proposalCards.js); the worker stores the envelope by URL, so an older stored copy keeps the fields until its next fetch replaces it.
    acceptance: >
      The reached server suites pass under the review skill, list.phone.test.js among them. The new
      assertions fail on main because the three fields are present. ProposalsListPhone.test.js and
      proposalCards.test.js pass unedited.
    test plan: list.phone.test.js gains two cases. Envelope rows carry none of token, client_email and client_phone. The bare array still carries all three.
    revert: revert the one squash commit; the next fetch of each phone's list stores the fields again, and nothing in the database changes.

  - id: proposal-detail-phone
    scope: >
      At phone width /proposals/:id renders a phone proposal detail in place of the desktop page inside
      the phone chrome. ProposalDetail.js's default export forks as EventDetailPage.js does, on the
      'proposal-detail' screen key, keyed by id. The page is the benchmark's Proposal detail.
      The header (client, kind on its own line, guests, venue map link) comes through setHeaderDetail,
      as the event detail's does. Under it, in order:
      - the when line with the status chip;
      - the status line from stored times;
      - a collapsible Contacts (client phone and email as tap targets);
      - a collapsible Package & extras (the stored snapshot's lines, client-hidden ones tagged, and the
        total);
      - an Edit details row (sub-line "date · guests · add-ons");
      - a Client link row showing the host, /proposal/ and the token's first six characters;
      - the action card: the send row, then Archive when it applies; no Send reminder row.
      The send row reads "Resend proposal" for sent, viewed and accepted, and "Send proposal · desktop
      view" for draft and modified. Archive shows for draft, sent, viewed, modified and accepted with
      amount_paid zero. In this lane Edit details, Resend and Archive open desktop view, the interim the
      event detail used before its sheets landed; the next two lanes replace them.
      An options-group proposal keeps every send row and Edit details on desktop view for good.
      The page reads GET /proposals/:id through offlineGet. A stored copy shows the stale line with
      Refresh, and Edit details and the action rows then read "needs connection". The Client link keeps
      working on a stored copy: it builds the desktop's URL and hands it to navigator.share, or copies it
      with "Link copied." where the phone has no share sheet. A draft's link reads "not sent yet" and
      does nothing.
      A booked status (deposit_paid, balance_paid, confirmed, completed) navigates with replace to
      /events/:id. An archived proposal shows its chip and its reason in the desktop's words, and no
      action, no Edit details and no Client link. A legal-hold proposal shows its note and no action or
      Edit details. A malformed id, a 404 or a 403 shows "This proposal isn't available" with "Back to
      Proposals" and dispatches mobile-route-dead once.
      One seam rides along: the Proposals card's modified line stops saying "by client". The status line
      and the card share one meta builder.
    footprint:
      - client/src/pages/admin/ProposalDetail.js  (the default export forks to the phone page, as EventDetailPage.js does; the desktop body is unchanged)
      - client/src/pages/mobile/ProposalDetailPhone.js  (new)
      - client/src/pages/mobile/ProposalDetailPhone.test.js  (new)
      - client/src/utils/proposalDetailView.js  (new; pure, no React or fetch; the status line, package lines, link, action and edit gates, the booked and read-only rules)
      - client/src/utils/proposalDetailView.test.js  (new)
      - client/src/utils/proposalCards.js and client/src/utils/proposalCards.test.js  (the modified meta line; the age-or-date helper the status line shares)
      - client/src/pages/mobile/EventDetailSections.js  (EditRow takes its sub-line as a prop; the event row's output is unchanged)
      - client/src/index.css  (the .m-* rules the screen adds, inside the event detail block's markers)
      - client/src/utils/mobileClassContract.test.js  (SOURCES lists the new page)
      - scripts/sensitive-paths.txt  (ProposalDetailPhone.js joins the offlineGet block beside ProposalsListPhone.js)
      - README.md, ARCHITECTURE.md  (generated sections, npm run docs)
    blockedBy: []
    lenses: the tier A floor (money, lifecycle, concurrency, outcomes-providers, access-egress, seams) plus client on the 320 and 390 captures against the benchmark's Proposal detail, and whatever the review skill computes; verify; the externals; the money smoke.
    laws: >
      Nothing on the phone computes a price: the lines are the stored pricing snapshot, total and paid
      are the proposal row (law 8 untouched). Law 15: a legal-hold proposal offers nothing that writes
      or sends. No new endpoint. Only the detail read opts into the worker's store (offlineGet), one
      proposal and its token at a time, the accepted limit of spec section 7. The link is built exactly
      as ProposalDetail.js copyPublicLink builds it (PUBLIC_SITE_URL plus /proposal/ plus the token). The
      desktop ProposalDetailBody is unchanged, including its 404 handling and its reload callers. Client
      name and event type stay separate (getEventTypeLabel). No em dash in any copy.
    seams: >
      Every entrance to /proposals/:id at phone width: the Proposals list card, the search Proposals
      rows, the Inbox's proposal links, the booking_signed push (server/utils/adminPush.js), the resume
      (routeRestore). The 'proposal-detail' screen key also covers /proposals/new in the chrome. Today the
      header's desktop button on either route sets the same override; that coupling is unchanged, and the
      fork lives only in ProposalDetail.js, so /proposals/new still renders ProposalCreate. Every reader
      of proposalMeta (the list card, the new status line). EditRow's event caller.
    acceptance: >
      The client build passes; the reached suites pass; the money smoke passes; the new tests fail on main
      for their stated reasons under the review skill's failing-test procedure (on main a phone-width
      render of /proposals/:id renders the desktop body, and the card's modified line says "by client").
      EventDetailPhone.test.js, its EditRow cases included, passes unedited. Headless captures at 320 and
      390 wide, in both skins, match the benchmark's Proposal detail (header, when line and chip, status
      line, sections, rows, card) for a sent, a viewed, a modified, an accepted, a draft, an archived and
      a legal-hold proposal, plus the stored-copy state and the unavailable state. A capture of
      /proposals/new at 390 is the same before and after the lane.
    test plan: >
      proposalDetailView.test.js:
      - the status line for every status: draft never sent; sent not opened; sent with views after a
        resend that kept last_viewed_at; viewed; modified with no "by client"; accepted awaiting deposit,
        accepted with money paid, and accepted falling back to client_signed_at;
      - ages under 7 days and dates beyond;
      - the package lines from a snapshot with a hidden line, and from a snapshot with no breakdown;
      - the link text (host, path, six characters) for a token, and "not sent yet" for a draft;
      - the gates: booked statuses route to the event; archived is read-only, with its reason label and
        no link; legal hold; a stored copy; draft and modified get "Send proposal · desktop view"; an
        options group keeps desktop view; Archive is absent with money on the row.
      ProposalDetailPhone.test.js (api mocked per URL):
      - the fork renders the phone page at phone width, and the desktop body under the desktop-view
        override;
      - a booked proposal replaces the URL with /events/:id;
      - a 404, a 403 and a malformed id each render the unavailable state with Back to Proposals and
        dispatch mobile-route-dead once;
      - a stored copy shows the stale line, sets Edit details and the actions to "needs connection", and
        keeps the Client link working; Refresh reads again;
      - share calls navigator.share with the desktop's URL, and falls back to the clipboard with "Link
        copied.";
      - a legal-hold read shows the note and no action;
      - the card holds no Send reminder row.
      proposalCards.test.js: the modified line.
    revert: >
      Revert the one squash commit, after proposal-edit-sheet's and proposal-actions-phone's squashes are
      reverted, in that order, if they landed: both edit this lane's page. Nothing is written to the
      database by the change.

  - id: proposal-actions-phone
    scope: >
      Resend proposal and Archive stop opening desktop view.
      Resend proposal opens ResendSheet. It posts /comms/preview with action proposal_resend and shows the
      recipient, the two channel choices with their unavailable reasons, the warnings, and the drafted
      email subject and text message, read-only. Send posts /comms/send with the chosen channels and the
      drafted words, and the result is said per channel with describeSendResult. Retry sends again only
      the channels the server answered as failed (retry true, as the desktop SendModal does). A send that
      got no answer offers no Retry and reads "No answer. It may have gone. Check the message log in
      desktop view before sending again.". A preview that fails offers Retry.
      Archive opens ArchiveSheet. It offers the four reasons; a pick, then "Archive proposal", posts
      /proposals/:id/archive with scope one and the reason. On success it toasts "Proposal archived." and
      replaces the URL with /proposals. On a failure the sheet keeps the pick. Retry re-reads first and
      counts an already archived row as done. A 409 reads in the server's words.
      Both sheets re-read the proposal fresh before they write. They refuse when its status left the set
      that offered the row, or money landed on it, or it went on legal hold. One write at a time. Sheets
      push history (useDrawerParam push), so Android Back closes them.
      On the server, the archive route and the proposal resend (the comms action proposal_resend and its
      deprecated wrapper POST /proposals/:id/resend) refuse a legal-hold proposal with 409 LEGAL_HOLD
      before any write or send, through isLegalHold, because the phone newly drives both and neither
      checks the hold today.
      The archive reasons and their labels live in one client module. The desktop's archive select and
      ProposalsDashboard's reason labels read it.
    footprint:
      - client/src/pages/mobile/ProposalDetailPhone.js and its test  (the rows open the sheets; the drawer kinds)
      - client/src/components/mobile/ResendSheet.js and ResendSheet.test.js  (new)
      - client/src/components/mobile/ArchiveSheet.js and ArchiveSheet.test.js  (new)
      - client/src/utils/archiveReasons.js and archiveReasons.test.js  (new; the four archivable values with the desktop's labels, and the label for every stored reason)
      - client/src/pages/admin/ProposalDetail.js  (the archive modal's select maps over archiveReasons.js; nothing else)
      - client/src/pages/admin/ProposalDetail.archive.test.js  (new; pins the desktop modal's options, order, labels and both defaults)
      - client/src/pages/admin/ProposalsDashboard.js  (its reason labels come from archiveReasons.js; nothing else)
      - client/src/utils/proposalDetailView.js and its test  (the action gates gain the sheet modes)
      - client/src/index.css, client/src/utils/mobileClassContract.test.js  (the sheets' rules and SOURCES)
      - server/routes/proposals/actions.js  (the archive handler's legal-hold refusal only)
      - server/utils/comms/actions/proposalResend.js  (the legal-hold refusal before dispatch, which also covers the deprecated wrapper)
      - server/routes/proposals/archive.test.js and server/utils/comms/actions/proposalActions.test.js  (the legal-hold cases; the existing cases pass unedited)
      - scripts/sensitive-paths.txt  (ResendSheet.js and ArchiveSheet.js join client-money-surfaces, since one reaches a client and one voids an invoice)
      - README.md  (generated sections)
    blockedBy: [proposal-detail-phone]
    lenses: the tier A floor plus client on the 320 and 390 captures of both sheets, and whatever the review skill computes; verify; the externals; the money smoke.
    laws: >
      No new endpoint: comms preview and send with proposal_resend, and the existing archive route with
      scope one. The server's RESENDABLE is sent, viewed, modified and accepted; the phone offers the
      desktop's narrower set. The archive values are the server's ARCHIVE_REASONS exactly (actions.js),
      and a test reads that file and fails when the two lists part. Never archive a row with money on it.
      Law 15: no sheet opens for a legal-hold proposal, and the two server paths refuse it. The 2026-11-05
      legal-hold coverage plan's legal-hold-admin lane also edits actions.js and comms.js; whichever lands
      second rebases and keeps one guard per path. One message per tap: a ref holds the send, as
      useSheetWrites does. Sends reach a real client, so the browser runs use the dev client fixture,
      never a real client's record.
    seams: >
      The desktop archive modal and ProposalsDashboard read the shared labels in the same order with the
      same words, and the desktop's defaults stay (no_hire on open, client_cancelled after a full refund).
      closedWord (eventDetailView.js) still reads client_cancelled and we_cancelled as Cancelled. The
      Proposals list drops the archived row on its next read. describeSendResult's copy is the desktop
      SendModal's. The legal-hold refusal's 409 body matches the proposal PATCH's.
    acceptance: >
      The client build passes; the reached suites pass; the money smoke passes; the new tests fail on main
      for their stated reasons. Headless captures at 320 and 390, in both skins, of both sheets loaded and
      failed, and of the archive sheet with a reason picked. The archive sheet matches the benchmark's
      (head, "pick a reason · required", the reason rows, Cancel) plus the plan's Archive proposal button.
      The resend sheet matches the edit sheet's notify step idiom.
      A browser run against the dev server first resends a dev fixture proposal to the dev client
      fixture, and its message log rows land. It then archives a dev fixture proposal that carries an
      unpaid invoice and a scheduled follow-up. Afterward the invoice's status is void, the pending
      scheduled_messages rows for the proposal are gone or suppressed, any shift is cancelled, and the
      activity row archived names the reason.
    test plan: >
      ResendSheet.test.js:
      - the preview's channels render with their reasons;
      - Send posts the chosen channels and the drafted words once under a double tap;
      - a partial result reads per channel, and Retry sends only the failed channel with retry true;
      - a send with no answer shows the may-have-gone line and no Retry;
      - a failed preview offers Retry;
      - a fresh read that finds the status moved refuses without sending.
      ArchiveSheet.test.js:
      - no request goes out before a reason is picked;
      - a pick then Archive proposal posts scope one and the value; success toasts and replaces the URL;
      - a 409 NOT_ARCHIVABLE reads in the sheet and keeps it open with the pick;
      - after a failure, Retry with a fresh read showing archived counts as done and posts nothing;
      - a fresh read with money on the row refuses.
      archiveReasons.test.js: the values equal ARCHIVE_REASONS as read out of
      server/routes/proposals/actions.js.
      ProposalDetail.archive.test.js: the desktop modal's four options in order with their labels,
      no_hire on open, client_cancelled after the full-refund path.
      ProposalDetailPhone.test.js:
      - the rows open the sheets by status;
      - a draft and a modified proposal keep "Send proposal · desktop view";
      - an options-group proposal keeps desktop view;
      - Back closes an open sheet.
      archive.test.js and proposalActions.test.js: the held id gets 409 LEGAL_HOLD with nothing written or
      sent, and an unheld twin still archives or resends.
    revert: revert the one squash commit, after proposal-edit-sheet's if it landed; archives and sends made through it stay, as the desktop's would.

  - id: proposal-edit-sheet
    scope: >
      Edit details opens the ONE edit sheet in its proposal variant, for a proposal the detail's gate
      allows: an active status, a fresh read, not legal hold, not in an options group, and an event date
      today or later.
      The event variant's rows stay: Date, Start with the setup line, Duration, Guests. The variant adds
      Bartenders and the count-taking add-ons already on the proposal (barback, banquet server,
      pre-batched mocktail), 1 to 10 each, with the desktop's rate words, and a note that adding or
      removing an add-on is desktop view.
      Bartenders shows the package's bartenders for the guest count (or the standing override) plus the
      Additional Bartender add-on's count. Its stepper changes only that add-on's count, from 0 to 10: it
      adds the active catalog row when the proposal lacks it, and drops it at 0. Its minus stops at the
      package's count. It hides when the active catalog has no Additional Bartender or the proposal's
      package is retired.
      The set of rows is fixed when the sheet opens. The extra rows sit under Guests inside the pinned
      block and scroll inside it only when the sheet outgrows its max height; the readout keeps its 58px
      floor and the footer stays pinned (spec, Plan decisions of 2026-11-05).
      Everything else is the event variant's machinery, unchanged: fresh reads, the desktop's full
      hydration, the server's own preview at each move, the reprice readout without a balance line,
      notify-preflight, the re-read before each save against sheetBasis, STALE_EDIT, the curfew confirm.
      The copy names a proposal: "Couldn't load this proposal. Editing needs a connection.", "This
      proposal changed since you opened it.", "This proposal can no longer be edited here. Use desktop
      view." and "Proposal updated.". The sheet's note line is the benchmark's "proposal edit · pickers &
      steppers". The detail re-reads fresh after a save.
    footprint:
      - client/src/components/mobile/useEditSheet.js  (a variant argument; the proposal values join the form, the preview and the change test)
      - client/src/components/mobile/EditSheet.js  (the Bartenders and add-on rows, the rows block, the variant copy)
      - client/src/components/mobile/EditSheet.test.js  (proposal-variant cases; every event case passes unedited)
      - client/src/utils/editSheetView.js and its test  (the variant's values, change test, was lines, copy constants)
      - client/src/pages/admin/proposalEditor/editorCore.js and its test  (the package's bartender count for a form, sharing detectNumBartendersOverride's formula; the existing detectNumBartendersOverride cases pass unedited)
      - client/src/utils/addonRateLabel.js and its test  (the add-on rate words, one copy)
      - client/src/pages/admin/proposalEditor/PackageSection.js and PackageSection.test.js  (its rate words come from addonRateLabel.js; one case pins them; every existing case passes unedited)
      - client/src/utils/proposalDetailView.js and its test  (Edit details' gate opens the sheet)
      - client/src/pages/mobile/ProposalDetailPhone.js and its test  (Edit details opens the sheet; the read after a save)
      - client/src/index.css  (the rows block and any row rule the variant adds)
      - README.md  (generated sections)
    blockedBy: [proposal-actions-phone]
    lenses: the tier A floor plus client on the 320 and 390 captures of the proposal variant, and whatever the review skill computes; verify; the externals; the money smoke.
    laws: >
      Full hydration, unchanged (spec section 5): initialFormFromProposal, recoverAddonQuantities at
      pricedDurationHours, detectNumBartendersOverride, the carried total_price_override, adjustments
      and their token, syrup_selections and setup_minutes_before; buildProposalPatchBody builds the save.
      Law 10: the stepper writes only the additional-bartender add-on, which the engine charges at the
      add-on's rate on hosted and BYOB packages and at $0 on classes. The phone prices nothing (the
      readout is the server's /calculate), and no client-side bartender cost path is added. Law 6:
      addon_quantities carries raw counts, never the persisted transform. Law 4: counts recover from the
      persisted rows. Law 14: no gratuity write; the preview carries the stored rate and jar; the mandate
      is never sent. Law 15: the sheet does not open on legal hold. sheetBasis keeps covering the add-on
      rows. The event variant behaves byte for byte as before.
    seams: >
      Every reader of sheetValuesOf, fieldsChanged and wasLine (the event variant). The desktop editor's
      add-on rate words (PackageSection) and the phone's read one helper. detectNumBartendersOverride and
      the new count share one formula. The detail's Package & extras after a save (the fresh re-read).
    acceptance: >
      The client build passes; the reached suites pass; the money smoke passes; the new tests fail on main
      for their stated reasons. EditSheet.test.js's event cases, editorCore.test.js's existing cases and
      PackageSection.test.js's existing cases pass unedited.
      A browser run on the dev server, on a dev fixture proposal: adding a bartender saves a PATCH whose
      add-on list carries additional-bartender with the count and every other add-on unchanged, and the
      server's stored total equals the readout's new total to the cent. The same run on a hosted and a
      BYOB fixture, and on one with a standing bartender override.
      Headless captures at 320 and 390, in both skins, of the proposal variant untouched, repriced and
      with three add-on rows. They match the benchmark's proposal sheet rows and the 2026-10-06 export's
      frame (head, readout, pinned rows, footer, the numbers of the Design pass of 2026-10-06), with the
      rows block's scroll as the plan decision states. The variant's stepper positions are measured there
      and recorded in the lane's close record as its contract.
    test plan: >
      editorCore.test.js: the package's count for guest counts on both sides of a ratio step, with an
      override, and with a retired package.
      editSheetView.test.js:
      - the variant's change test sees a bartender or add-on move and ignores an untouched sheet;
      - the was lines;
      - Bartenders' minus is disabled at the package's count.
      EditSheet.test.js:
      - the steppers' PATCH bodies: adding the add-on when absent, dropping it at 0, an add-on count
        change;
      - every other add-on and its variant carried;
      - the preview asked again after each step, with the add-on state in its body;
      - the proposal copy;
      - the Bartenders row hidden with no catalog row, and with a retired package;
      - the row count unchanged after dropping the extra bartenders to none.
      addonRateLabel.test.js and PackageSection.test.js: the same words on both surfaces.
      proposalDetailView.test.js: Edit details opens the sheet for an active, fresh, unheld, ungrouped,
      upcoming proposal, and desktop view otherwise.
      ProposalDetailPhone.test.js: Edit details opens the sheet only from a fresh read, and the detail
      re-reads after a save.
    revert: revert the one squash commit; proposals saved through it keep their saved values, as a desktop save's would.
---

# The phone proposal detail

The last unbuilt phase 1 screen. Tapping a proposal on the phone, from the list, search, the Inbox or the client-signed push, opens the desktop proposal page inside the phone chrome today. This plan builds the benchmark's Proposal detail in four lanes. The front matter above is the lane map, and the spec's "Plan decisions of 2026-11-05" are the decisions.

- **The list trim.** The phone's stored Proposals list stops carrying each row's public token and the client's contact. It is independent of the screen, so it ships and reverts alone.
- **The read view.** The page, its states and the card line it shares. Edit details and the actions open desktop view until the next two lanes land, so it ships on its own.
- **The two sheets that act.** Resend proposal and Archive, with the two server legal-hold refusals they need. They reach a client and void an invoice, so they get their own review and revert.
- **The money sheet.** The proposal variant of the edit sheet, the Bartenders and add-on steppers on the desktop's own money path.

**Why this split.** Each piece ships and reverts alone, and the two that write get a review that reads only them. The last three run in order because each edits the page the read view creates. A merge in another order would hit an ordinary conflict on that page and a stale-base overlap pass.

**What the plan leaves out.**
- **Send reminder.** Left off by the owner on 2026-11-05 ("leave it off"); nothing exists to send it (spec decisions).
- **Desktop-view cases.** The whole-set archive, editing a resend's words, the first send of a draft or a modified proposal (it runs the remote staffing fee check), adding or removing an add-on, and anything in an options group stay on the desktop.

**Found while planning, for the owner's list.**
- **Legal-hold gaps on the server.** The archive route and the proposal resend do not call isLegalHold. This plan's actions lane adds both refusals, because the phone newly drives those paths. The 2026-11-05 legal-hold coverage plan names neither path, though its legal-hold-admin lane edits actions.js and comms.js.
- **Route restore on a cold launch.** A push alert tapped while the app was closed landed on the last screen, not the alert's page. It was fixed on main on 2026-11-05 as its own quick fix (routeRestore.js: only the icon's launch restores).
