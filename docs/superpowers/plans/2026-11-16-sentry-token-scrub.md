---
spec: none. The gap was raised on 2026-11-16 by the access-egress lens during the overlap pass of the smaller payments audit lane (receipt 4a4840c, reported there as outside both diffs) and confirmed in the code and in Sentry; the owner asked on 2026-11-16 for it to be fixed ("lets fix that seperate issue"). This plan body records the design, which is Claude's.
format: lane map without code (spec 2026-10-19 D12)
revision: 1 (2026-11-16)
status: one lane, built in one pass by Claude in its own worktree, reviewed at the tier it computes (tier A: both scrub files are on the sensitive list), merged through scripts/merge-lane.sh from os. The ship waits for the owner's word.
lanes:
  - id: sentry-token-scrub
    scope: >
      Both Sentry scrubs redact a public token only where a hand-written rule names its path, and each
      new token route had to be added to two files with nothing to check it. The server's scrubUrl
      misses /api/calendar/feed/:token, the three payment-intent routes (/api/stripe/create-intent/,
      create-intent-for-invoice/, create-drink-plan-intent/), /api/proposals/group/:token,
      /api/client-portal/proposals/:token, /api/invoices/client/:proposalToken,
      /api/public/feedback/:token, /api/proposals/public/quote-draft/:token and the cover-swap JWT
      path; the browser's scrubText covers only the Inbox phone key and the menu proof, so every other
      token page (proposal, invoice, drink plan, compare, shopping list, tip, feedback, verify-email,
      reset-password) and every token API call it makes reach Sentry raw. Sentry holds the proof:
      over its 90-day retention, sampled server spans carry the raw token of one calendar feed
      (a feed that serves client contact and balance data) and of four proposals (create-intent).
      This lane makes both scrubs redact by value, and adds a guard so a new token route cannot land
      without a decision about how it is scrubbed. In both scrubs: every UUID (8-4-4-4-12 hex, either
      case, not glued to further word characters) is redacted wherever the scrub already runs, which
      covers every token the system mints as a UUID (proposal, drink plan, invoice, compare group,
      calendar feed, quote draft, tip page, menu proof, voicemail listen) in any position; a JWT by
      value (three base64url segments opening eyJ) is redacted too, which covers the cover-swap link;
      the remaining non-UUID tokens get path rules (the server adds /verify-email/ and
      /cover-swaps/; the browser mirrors the server's /reset-password/, /unsubscribe/, /tip/ and
      ?token= rules and adds /verify-email/ and /cover-swaps/). The existing path rules stay, so the
      markers already in Sentry keep their shape.
    footprint:
      - server/utils/sentryScrub.js  (scrubUrl gains the UUID and JWT value rules and the /verify-email/ and /cover-swaps/ path rules; nothing else; the header records why the defense is by value now)
      - server/utils/sentryScrub.test.js  (the new rules, and the existing cases still hold)
      - server/utils/sentryScrub.tokenRoutes.test.js  (new: the guard)
      - client/src/utils/sentryScrub.js  (scrubText gains the same value rules and the path rules above)
      - client/src/utils/sentryScrub.test.js  (the new rules, and the existing cases still hold)
      - client/src/utils/sentryScrub.tokenRoutes.test.js  (new: the guard)
      - README.md  (generated tree lines only)
    blockedBy: []
    lenses: the tier A floor (money, lifecycle, concurrency, outcomes-providers, access-egress, seams) plus client and whatever the review skill computes; verify; the externals; the money smoke.
    laws: no route, schema or data changes; the scrubs keep failing closed (a throw drops the event on the browser and marks the span on the server); no field-name allowlist is added (the module's own lesson); the server's release (a git sha), Sentry's own ids (32 hex with no dashes) and integer row ids are not UUID-shaped and stay readable; the auth middleware's logged path (server/middleware/auth.js, the one other scrubUrl caller) is redacted the same way, which is intended.
    seams: the two Sentry inits that wire the hooks (server/index.js, client/src/index.js) are unchanged; server/middleware/auth.js calls scrubUrl for its auth-failure log; every route file under server/routes with a path parameter named like a token, and every Route in client/src/App.js with one, is listed in the guard's manifest with its token format.
    acceptance: >
      The reached suites, the money smoke and the client build pass; the client sentryScrub tests pass
      under react-scripts test; the server guard fails on main for its stated reason under the review
      skill's failing-test procedure (on main scrubUrl leaves the calendar feed and create-intent
      tokens in place), and the browser guard fails on main (scrubText leaves a proposal page token).
    test plan: >
      server/utils/sentryScrub.tokenRoutes.test.js reads every route file under server/routes (tests
      excluded), collects each route path with a parameter whose name contains token (any case), and
      fails on one missing from its manifest, naming the file and the path and what to add; for each
      listed route it builds a sample URL holding a token of the listed format (a UUID, a JWT, or the
      hex or base64url shape of a non-UUID token) and asserts scrubUrl leaves no part of the token, and
      it asserts the same through scrubTransactionEvent's span data (url, http.url, url.full) and
      scrubErrorEvent's request.url. client/src/utils/sentryScrub.tokenRoutes.test.js reads
      client/src/App.js the same way for every Route path with a token parameter and asserts
      scrubText and beforeBreadcrumb leave no part of the token, in the page URL, a Referer and a
      navigation breadcrumb. sentryScrub.test.js on each side adds: a UUID in either case is
      redacted mid-string and inside a query string; a 32-hex Sentry id, a 40-hex git sha and an
      integer id are left alone; a JWT is redacted; the existing menu-proof, Inbox, voicemail and
      Twilio cases hold unchanged.
    revert: revert the one squash commit. No data is written by the change, so nothing needs repair.
---

# Public tokens never reach Sentry

One lane. Both Sentry scrubs named the token paths they knew, so every token route added since slipped past them: the calendar feed, the payment-intent routes, the compare page, the client portal and, in the browser, every token page but the menu proof. Sentry holds sampled spans with one calendar feed token and four proposal tokens. The fix redacts any UUID and any JWT by value in both scrubs, adds path rules for the few tokens that are neither, and adds a guard test that fails when a token route lands without an entry saying how it is scrubbed. The front matter above is the lane map.
