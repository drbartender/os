---
spec: none. The defect was found on 2026-11-03 by the seams lens of the staff-page fix (receipt 33a3f9d, prose section on the other admin detail pages) and confirmed in the code; the owner asked on 2026-11-04 for it to be fixed next. This plan body records the design.
format: lane map without code (spec 2026-10-19 D12)
revision: 1 (2026-11-04)
status: one lane, built in one pass by Claude in its own worktree, reviewed at the tier it computes (tier A: client/src/pages/admin/ProposalDetail.js is on the sensitive list), merged through scripts/merge-lane.sh from os. The ship waits for the owner's word.
lanes:
  - id: detail-page-remount
    scope: >
      The routes /proposals/:id and /events/:id keep their element when only :id changes (global
      search, the command palette, a link on the page), so the page's state survives a move from
      one record to the next. On the proposal page an open editor stays mounted with its form
      seeded from the first proposal, and Save then sends PUT /clients/<second proposal's client>
      with the first proposal's client name, email, phone and source, then PATCH
      /proposals/<second id> with the first proposal's form; the stale-edit token refuses only the
      PATCH, and only when the lines changed. The proposal load has no cancel guard, so a late answer
      for the first proposal replaces the second's record and admin notes, and a notes save then
      writes the first proposal's notes onto the second. The archive, send and cancel-line dialog
      states and the captured change-request id survive too. On the event page's desktop view the
      load is guarded and the editor reloads from the new record, but the editing flag and the send,
      cancel-event and cancel-line dialog states survive, so a cancel-line dialog can hold the first
      event's line under the second event's id. This lane gives each record a fresh mount: the
      proposal page's default export becomes a thin wrapper that renders the body keyed by :id, and
      the event page's desktop branch is keyed by :id as its phone branch already is. The staff
      record page got the same fix on 2026-11-03 (e41547b).
    footprint:
      - client/src/pages/admin/ProposalDetail.js  (the default export becomes a keyed wrapper over the body; nothing else)
      - client/src/pages/admin/ProposalDetail.remount.test.js  (new)
      - client/src/pages/admin/EventDetailPage.js  (the desktop branch keyed by :id; nothing else)
      - client/src/pages/admin/EventDetailPage.fork.test.js  (one desktop case beside the phone case)
      - README.md  (generated sections, npm run docs, when a header changes)
    blockedBy: []
    lenses: the tier A floor (money, lifecycle, concurrency, outcomes-providers, access-egress, seams) plus client and whatever the review skill computes; verify; the externals; the money smoke.
    laws: no server file changes; the proposal editor (proposalEditor/ProposalEditorForm.js), its PATCH body and its stale-edit token are unchanged; a same-id change (a query-string tab, ?edit=1 being stripped, the change_request_id clean-up, a reload after a stale save) does not remount; every money action on the page still targets the id in the URL.
    seams: every entrance to the two pages (App.js routes, the EventsDashboard Edit Event deep link ?edit=1, the change-request Apply in editor deep link ?edit=1&change_request_id=, the Alternatives panel's links between proposals in a group, the post-create navigate from ProposalCreate, global search and the command palette); the event page's phone branch, already keyed, is unchanged; the ?edit=1 strip and the change-request id captured at mount now run once per record, which is the intent their comments state.
    acceptance: >
      The client build passes, the reached suites pass, the money smoke passes, and the new tests
      fail on main for their stated reason under the review skill's failing-test procedure: on main
      an editor opened on the first record is still open after the move, and the first proposal's
      late answer replaces the second's.
    test plan: >
      ProposalDetail.remount.test.js (api mocked per URL; the record GET a promise the test settles,
      so it can answer out of order; the editor stubbed to a component that records the proposal it
      was seeded with): an editor opened on proposal 1 is not open once the page moves to proposal
      2; the first proposal's record answering after the second's never replaces it (the second's
      client name and notes stay on screen). EventDetailPage.fork.test.js: at desktop width an editor
      opened on event 13 is not open once the page moves to event 14.
    revert: revert the one squash commit. No data is written by the change, so nothing needs repair.
---

# Detail pages mount fresh per record

One lane. The proposal page and the event page's desktop view keep their state when the address moves from one record to another, so an editor or a dialog opened on the first record acts on the second. The fix is the key the staff record page and the event page's phone view already carry: a new record is a new mount. The front matter above is the lane map.

Left for later, each its own fix: the client page (client/src/pages/admin/ClientDetail.js) has the same flaw, reachable through global search, and the pages the seams lens found unreachable today (EmailLeadDetail, DrinkPlanDetail, AdminApplicationDetail, EmailCampaignDetail) carry the pattern without a way to change the id while mounted.
