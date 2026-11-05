---
spec: none. The client page defect was found on 2026-11-03 by the seams lens of the staff-page fix (receipt 33a3f9d, prose on the other admin detail pages); the late-failure path on the proposal page was raised by five reviewers of the detail-page-remount lane (receipt ded681b, deferred there as pre-existing). The owner asked on 2026-11-04 for the client page bug to be fixed next. This plan body records the design.
format: lane map without code (spec 2026-10-19 D12)
revision: 1 (2026-11-04)
status: one lane, built in one pass by Claude in its own worktree, reviewed at the tier it computes (tier A: client/src/pages/admin/ProposalDetail.js is on the sensitive list), merged through scripts/merge-lane.sh from os. The ship waits for the owner's word.
lanes:
  - id: client-page-remount
    scope: >
      The route /clients/:id keeps its element when only :id changes (global search, the command
      palette, a link on the page), so the client page's state survives a move from one client to the
      next: an open edit form shows the first client's values until the second client's read lands,
      and Save in that window sends PUT /clients/<second id> with the first client's name, email,
      phone, source and notes; the email-harvest draft carries over too. The page's load has no
      cancel guard, so a late answer for the first client replaces the second client's record and
      form (a later save then writes the first client's contact onto the second), and a late failure
      for the first client toasts and navigates the admin to the client list. This lane gives each
      client a fresh mount (the default export becomes a thin wrapper rendering the body keyed by
      :id, as the staff and proposal pages now do) and guards the load so an answer that lands after
      its body unmounted, success or failure, does nothing. The proposal page's load gets the same
      guard: its keyed remount (5e54466) stops a late success, but a late failure for the previous
      proposal still toasts over the next one and, on a 404, navigates to the proposal list.
    footprint:
      - client/src/pages/admin/ClientDetail.js  (the default export becomes a keyed wrapper over the body; the load guarded; the header says what the page does; nothing else)
      - client/src/pages/admin/ClientDetail.remount.test.js  (new)
      - client/src/pages/admin/ProposalDetail.js  (the record load's answers ignored once the body unmounted; nothing else)
      - client/src/pages/admin/ProposalDetail.remount.test.js  (one late-failure case beside the late-success case)
      - README.md  (generated sections, npm run docs, when a header changes)
    blockedBy: []
    lenses: the tier A floor (money, lifecycle, concurrency, outcomes-providers, access-egress, seams) plus client and whatever the review skill computes; verify; the externals; the money smoke.
    laws: no server file changes; the proposal editor, its PATCH body and its stale-edit token are unchanged; the guard skips only the answers of a body that has unmounted, so a reload on the same mount (onSaved, onReload after a stale save, the full-refund follow-up) still lands; the guard survives React StrictMode's mount, unmount, mount in development; the client page's harvest and re-arm actions keep their targets; every request still targets the id in the URL.
    seams: every entrance to the client page (App.js route, global search and the palette, the client links on the proposal and event pages, the client list); the proposal page's reload callers (onSaved, onReload, the payment panel's onUpdate and onFullyRefunded, the notes and status writes) on the same mount; the client page's ClientConversation child mounts per client with the body.
    acceptance: >
      The client build passes, the full client suite passes, the money smoke passes, and the new
      tests fail on main for their stated reason under the review skill's failing-test procedure: on
      main an edit form opened on the first client is still open after the move, the first client's
      late answer replaces the second's, and the first proposal's late 404 moves the admin off the
      second proposal.
    test plan: >
      ClientDetail.remount.test.js (api mocked per URL; the record GET a promise the test settles,
      so it can answer out of order): an edit form opened on client 1 is not open once the page moves
      to client 2; the first client's record answering after the second's never replaces it; the
      first client's read failing after the move neither navigates nor toasts. ProposalDetail.remount
      .test.js: the first proposal's read failing with a 404 after the move leaves the admin on the
      second proposal with no toast.
    revert: revert the one squash commit. No data is written by the change, so nothing needs repair.
---

# Client page mounts fresh per client; late load failures stay quiet

One lane. The client page keeps its state when the address moves from one client to another, so an edit form opened on the first client can save onto the second, and its load lets a late answer for the first client replace the second or bounce the admin to the list. The proposal page's load, keyed yesterday, still lets a late failure toast and bounce. The fix keys the client page by its id, as the staff and proposal pages are, and has both loads ignore an answer once their page has unmounted. The front matter above is the lane map.
