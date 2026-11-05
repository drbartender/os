---
spec: none. The owner asked on 2026-11-04 for the manager Edit buttons on the admin staff record page to be fixed; the quick fix for it was escalated by its seams lens (a manager can write a staffer's pay handles and payroll method through the tip-page routes) and became this lane. This plan body records the design.
format: lane map without code (spec 2026-10-19 D12)
revision: 1 (2026-11-05)
status: one lane, built in one pass by Claude in its own worktree, reviewed at tier A (server/routes/admin/contractorTipPage.js moves money destinations and the escalation set the tier), merged through scripts/merge-lane.sh from os. The ship waits for the owner's word.
lanes:
  - id: staff-page-manager-view
    scope: >
      A manager can open the admin staff record page (/staffing/users/:id; the client's adminOnly
      route guard admits managers and GET /api/admin/users/:id is requireAdminOrManager), but the
      server treats a manager as outside the pay tier: the read sends a manager payment {} and drops
      the pay rate, and every write on the page except the tip-page ones is adminOnly (status,
      profile, permissions, seniority in server/routes/admin/users.js; messages in
      server/routes/messages.js; the payouts and payment-history reads). So a manager sees controls
      that only fail, pay figures the page invents (a $20/hr default, a YTD estimate built on it, a
      W-9 shown missing, "No payouts yet"), and a Tip Page tab drawn from the empty payment object
      whose saves the server accepts: the six routes in server/routes/admin/contractorTipPage.js are
      requireAdminOrManager, and their PATCH writes the Venmo, Cash App and PayPal handles and the
      payroll method the pay run pays to, so a manager can change where a staffer is paid without
      seeing what was there. This lane closes both halves. Server: the six tip-page routes become
      adminOnly, matching the read that withholds the same row. Client: the page shows a manager
      only what the server lets a manager read and do: no profile Edit, no Deactivate or Reactivate,
      no Message button or Messages tab, no Payouts or Tip Page tab, no YTD earnings estimate, no W-9
      row on Documents, no link to the full application (its page is adminOnly); Assign to event only
      for an admin or a manager with can_staff (the shifts routes' requireStaffing); the role and
      permission controls shown read-only with a line saying only an admin can change them. An
      admin viewing an admin's record does not get controls the server refuses for an admin row
      (Deactivate, the role and permission controls).
    footprint:
      - server/routes/admin/contractorTipPage.js  (the six /contractors/:userId/tip-page routes take adminOnly; nothing else)
      - server/routes/admin/contractorTipPage.test.js  (a manager is denied each of the six)
      - client/src/pages/admin/userDetail/AdminUserDetail.js  (the viewer's role gates the header actions, the tab set, the YTD stat and the props below; nothing else)
      - client/src/pages/admin/userDetail/tabs/OverviewTab.js  (Edit and the role and permission controls follow canEdit; the read-only line)
      - client/src/pages/admin/userDetail/tabs/PayoutsTab.js  (Edit and Save seniority follow canEdit, kept for an admin path)
      - client/src/pages/admin/userDetail/tabs/DocumentsTab.js  (the W-9 row only where the viewer can read it)
      - client/src/pages/admin/userDetail/tabs/ApplicationTab.js  (the full-application link only for an admin)
      - client/src/pages/admin/userDetail/AdminUserDetail.roleGate.test.js  (new)
      - README.md  (generated sections, npm run docs, when a header changes)
    blockedBy: []
    lenses: the tier A floor (money, lifecycle, concurrency, outcomes-providers, access-egress, seams) plus client and whatever the review skill computes; verify; the externals; the money smoke.
    laws: a manager can neither read nor write payment_profiles through the admin staff routes; the tip-page routes' behavior for an admin is unchanged; no data is written by the change; the client gates match the server guards exactly (role 'admin' for adminOnly, admin or manager with can_staff for requireStaffing) and are never the only guard.
    seams: every caller of the six tip-page routes (TipPageTab.js is the only client caller; the staff portal's own tip routes are separate and unchanged); the tab clamp in AdminUserDetail.js so a ?tab= deep link to a hidden tab falls to Overview; the staff hub and mobile admin, which only link to the page; the remount test, which renders as an admin.
    acceptance: >
      The reached server suites pass (contractorTipPage.test.js among them), the money smoke and the
      client build pass, the full client suite passes, and the new tests fail on main for their
      stated reason under the review skill's failing-test procedure: on main a manager's PATCH to a
      staffer's tip page succeeds, and a manager sees the Edit button and the Payouts tab.
    test plan: >
      contractorTipPage.test.js: a manager gets 403 from each of the six tip-page routes and the
      stored handles are unchanged; an admin's PATCH still succeeds. AdminUserDetail.roleGate.test.js
      (the manager fixture shaped as the server sends it: payment {}, no hourly_rate): a manager sees
      no Edit, Deactivate, Message, Payouts, Tip Page or Messages tab, no YTD estimate, no W-9 row and
      no full-application link, sees the role and permission controls disabled with the read-only
      line, and sees Assign to event only with can_staff; an admin sees every control; an admin on
      an admin's record sees no Deactivate and disabled role and permission controls.
    revert: revert the one squash commit. No data is written by the change, so nothing needs repair.
---

# The staff record page, as a manager sees it

One lane. A manager can open a staffer's admin page, but the server keeps managers out of pay data and out of every write on it, except the tip-page routes, which let a manager change where a staffer is paid. The lane makes those routes admin-only and has the page show a manager only what the server lets a manager read and do. The front matter above is the lane map.
