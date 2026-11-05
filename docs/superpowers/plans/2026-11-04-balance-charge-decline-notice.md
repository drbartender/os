---
spec: none. The gap was raised on 2026-11-04 by the outcomes-providers lens of the detail-page-remount lane (receipt ded681b, deferred there as outside its footprint) and confirmed in the code; the owner asked on 2026-11-04 for the card decline notification to be fixed next. This plan body records the design.
format: lane map without code (spec 2026-10-19 D12)
revision: 1 (2026-11-04)
status: one lane, built in one pass by Claude in its own worktree, reviewed at the tier it computes (tier A: client/src/pages/admin/ProposalDetailPaymentPanel.js is on the sensitive list), merged through scripts/merge-lane.sh from os. The ship waits for the owner's word.
lanes:
  - id: balance-charge-decline-notice
    scope: >
      The payment panel's Charge balance button (ProposalDetailPaymentPanel.js, on the proposal page
      and the event page) reports its outcome only in a line of text inside the panel. A decline
      (POST /api/stripe/charge-balance/:id answers 402 with "Card declined: <Stripe's reason>") is
      therefore seen only by an admin still looking at that panel when the answer lands; one who has
      moved to another record or page sees nothing, and nothing on screen later says the charge
      failed, although the route sets proposals.autopay_status to 'failed' (as the balance scheduler
      does for an automatic charge that fails). This lane makes the outcome reach the admin wherever
      they are and stay visible: the charge's success and failure each raise a toast that names the
      record (the client name and the proposal number, since the toast can land on another page),
      the in-panel line stays, and the Charge balance block shows a short note while
      autopay_status is 'failed' saying the last balance charge was declined, so a decline the admin
      did not watch (their own after leaving, or the scheduler's) shows the next time anyone opens
      the record. The owner asked for the notification; the lasting note is Claude's addition for the
      same gap.
    footprint:
      - client/src/pages/admin/ProposalDetailPaymentPanel.js  (chargeBalance's two outcomes raise a toast naming the record; the Charge balance block shows the declined note while autopay_status is 'failed'; nothing else)
      - client/src/pages/admin/ProposalDetailPaymentPanel.charge.test.js  (new)
    blockedBy: []
    lenses: the tier A floor (money, lifecycle, concurrency, outcomes-providers, access-egress, seams) plus client and whatever the review skill computes; verify; the externals; the money smoke.
    laws: no server file changes; the charge request, its idempotency, the claim on autopay_status and the webhook that clears it are unchanged; a decline reason is a payment provider's rejection on an admin money route, the one surfacing the error rules allow; the toast names the record by client name and proposal number only; the note shows only where the Charge balance button shows (deposit paid, autopay enrolled, a saved card, a balance due) and only while autopay_status is 'failed'.
    seams: the two pages that mount the payment panel (ProposalDetail.js, EventDetailPage.js desktop); the two writers of autopay_status 'failed' (the charge-balance route, the balance scheduler) and its clearers (the payment_intent.succeeded webhook, the proposal status and switch paths, invoice extras), so the note clears when the balance is paid or the claim resets; the phone event view, which does not mount the panel.
    acceptance: >
      The client build passes, the full client suite passes, the money smoke passes, and the new
      test fails on main for its stated reason under the review skill's failing-test procedure: on
      main a declined charge raises no toast and a proposal with autopay_status 'failed' shows no
      declined note.
    test plan: >
      ProposalDetailPaymentPanel.charge.test.js (api and toast mocked): a declined charge raises an
      error toast naming the client and the proposal number and carrying the decline reason, and the
      in-panel line still shows; a successful charge raises a success toast naming the record; a
      proposal with autopay_status 'failed' and a balance due shows the declined note beside the
      button, and one with autopay_status null shows none; a toast raised after the panel unmounted
      (the answer landing once the admin moved away) still names the record it was for.
    revert: revert the one squash commit. No data is written by the change, so nothing needs repair.
---

# The balance charge's outcome reaches the admin

One lane. Charge balance reports a declined card only inside the payment panel, so an admin who moved on before the answer never sees it, and nothing later shows that the charge failed. The fix raises a toast naming the record for both outcomes, and keeps a short declined note on the Charge balance block while the proposal's autopay status says the last charge failed. The front matter above is the lane map.
