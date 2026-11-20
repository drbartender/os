---
spec: docs/superpowers/specs/2026-11-19-duet-connector-design.md   # revision 3
format: lane map without code (spec 2026-10-19 D12)
revision: "3 (2026-11-19), the first wave built and merged, the text guards follow-up lane added; the body's last sections are the record"
lanes:
  - id: connector-shared-reads
    scope: >
      The reads the connector will call exist as shared functions that honor the legal hold, and the
      admin screens keep the answers they give today. Four reads that are inline in routes move to
      shared functions the route now calls: the client detail (server/routes/clients.js), the
      proposal detail (server/routes/proposals/getOne.js), the open-balance list with the amount
      owed and the day counts computed in SQL (server/routes/proposals/list.js, reusing
      qOutstanding's expression; the admin list's response is unchanged, and the new columns are
      returned only when the caller asks for them), and the upcoming-events query with a date window
      (adminScopedShiftsSql and NEEDS_STAFF_SQL in server/routes/shifts.queries.js). legalHold.js
      gains the held-client-ids function, failing closed like its siblings. runGlobalSearch takes an
      optional exclusion of held proposal ids and held client ids, applied in its SQL; the admin
      search passes none. The Inbox engine gains one predicate, shared with getReadSubjects, that
      drops held subjects and held keys, removes held mail lines from other threads, and can drop
      personal rows; getReadSubjects is rewritten onto it with no change in what it returns. No
      connector code is in this lane and nothing a user sees changes.
    footprint:
      - server/utils/legalHold.js
      - server/utils/legalHold.test.js
      - server/utils/globalSearch.js
      - server/utils/globalSearch*.test.js
      - server/utils/inbox/engine.js
      - server/utils/inbox/engine*.test.js
      - server/utils/reads/*.js   # new: the four shared reads
      - server/utils/reads/*.test.js
      - server/routes/clients.js
      - server/routes/proposals/getOne.js
      - server/routes/proposals/list.js
      - server/routes/shifts.queries.js
      - README.md   # generated tree lines only
      - ARCHITECTURE.md   # generated sections only
    blockedBy: []
    lenses: >
      the tier A floor (money, lifecycle, concurrency, outcomes-providers, access-egress, seams) and whatever the review skill computes; verify; the externals; the money smoke.
    laws: >
      Spec laws 1, 4 and 10. Money law 15 (the hold; every new exclusion fails closed and binds the
      held ids as parameters). Money law 8 is untouched: no price or paid flag is written. The amount
      owed is qOutstanding's SQL expression and nothing is computed in JavaScript. Staffing counts
      come from the shift rows and openSlotsSql, never recomputed from guest count (money law 10).
    seams: >
      Every caller of the four moved reads (the admin clients page, the proposal detail page and its
      phone twin, the proposals list and its cohort drill-outs, the phone Events list and the admin
      badge pinned by shifts.adminScoped.test.js); /api/admin/search and the command palette;
      getReadSubjects and the Inbox AI read that calls it; every existing isLegalHold caller is
      unchanged.
    acceptance: >
      The reached suites and the money smoke pass with their existing assertions untouched, which is
      the proof the admin answers did not move. New tests fail on main for their stated reason: the
      held client comes back from runGlobalSearch without the exclusion and is absent with it, and a
      group still returns its full six when a held row would have been among them; the Inbox
      predicate drops a held subject, a held key and a held mail line inside another person's
      thread, and drops personal rows when asked; the held-client-ids function throws on a missing
      list. getReadSubjects returns the same subjects before and after on the existing suite.
    test plan: >
      Before any read moves, each of the four has a test that pins the route's response on a seeded
      row and passes on main; where no suite pins it today (the client detail has none), the lane
      writes that test first and commits it as its first checkpoint. After the move the same tests
      pass untouched. One test file per shared read then asserts that the function, called with the
      hold exclusion, omits a synthetic held proposal and its client's other booking (ids added
      through __setLegalHoldIdsForTest, never a real held row). Open-balance: a row with no due date
      reports none and sorts last; days overdue is computed on the Chicago date. Upcoming events: a
      hand-made shift with no proposal carries the shift's client name; a cancelled shift is absent;
      a filled one is present with the flag off.
    revert: >
      revert the one squash commit. No data is written and no schema changes.
  - id: connector-text-guards
    scope: >
      The two text guards of spec 7.6 as pure functions with no database and no network: the
      screening check that says whether a piece of client-written text reads as orders to an AI, and
      the destination strip that removes links, email addresses and spelled-out web addresses,
      leaving markers. The link half reuses the replacer in server/utils/inbox/aiRedact.js through
      an export, without changing what the Inbox AI read sends. Nothing calls the new functions yet.
    footprint:
      - server/utils/connector/textGuards.js   # new
      - server/utils/connector/textGuards.test.js
      - server/utils/connector/screenPatterns.js   # new: the one pattern list
      - server/utils/inbox/aiRedact.js   # export the link replacer only
      - README.md   # generated tree lines only
    blockedBy: []
    lenses: >
      the tier A floor (money, lifecycle, concurrency, outcomes-providers, access-egress, seams) and whatever the review skill computes; verify. Reviewed at this tier by declaration, whether or not the sensitive list names its files yet, because these functions are the defense of spec 7.6.
    laws: >
      Spec law 3 and section 7.6 guards 1 and 2. No AI call in the screening (the spec's reason, it cannot be talked around). The Inbox redaction invariant holds as written: aiRedact's own output is unchanged.
    seams: >
      aiRedact.js's existing callers and its suite (aiRedact.test.js must pass untouched).
    acceptance: >
      The new suite passes and aiRedact.test.js passes unchanged. The suite holds a table of real
      shapes: at least ten attack wordings that must be withheld (orders about instructions, role
      and system-prompt claims, send, forward, export and fetch requests, text dressed as a system
      or tool message) and at least twenty ordinary client messages that must pass, the ordinary set
      including ones that use the trigger words innocently ("can you send me the invoice", "please
      forward this to my fiance", "ignore my last text").
    test plan: >
      Table-driven cases for both functions. Destination strip: http and bare-domain links, a link
      inside punctuation, an email address, "name dot com" and "name at domain dot com" spellings,
      and text with none of these returned unchanged. Screening: the two tables above, plus mixed
      case, extra whitespace and a command split across lines.
    revert: >
      revert the one squash commit.
  - id: connector-signin-server
    scope: >
      The connector exists, dark and with no tools. Behind an environment flag that is off by
      default: the MCP endpoint (POST /mcp, stateless, registered ahead of the global body parsers
      with its own small JSON limit, answering tool listing with an empty list; GET /mcp answers 405), the two metadata routes, the authorize route that
      stores a pending request, the admin-only routes the consent page calls (read a pending
      request, approve it with a passkey assertion, cancel it), the token route (code exchange,
      refresh rotation with the 30-second grace, replay revocation), the per-call check (token hash,
      live grant, admin role, token_version), the status, call-list and disconnect routes for the
      settings block, the call log (refusals included), the address check, the two limiters (per grant on authenticated calls; per address on
      unauthenticated /mcp calls, /oauth/authorize and /oauth/token; a limited call gets 429), the daily
      cleanup scheduler, the owner email on a new grant and on a replay revocation, the audit
      entries, and the Sentry scrub rule for the token prefix. Schema for pending requests, grants,
      codes, tokens and the call log. The project rules gain the connector invariant and the
      sensitive list gains the connector paths, so every later lane is reviewed at the right tier.
      .env.example gains four entries: the connector flag, the address-range variable, the cleanup
      job's RUN flag, and a comment block for API_URL, which the code reads and the file does not
      describe. The lane report names the MCP SDK line chosen (1.x or 2.x) and that it accepts zod 4.
      If the review cap would split this lane, the line is: the sign-in and per-call path (metadata,
      authorize, approve, token, the per-call check, schema for requests, grants, codes and tokens)
      stays; the call log, the cleanup scheduler and the status, call-list and disconnect routes
      become a second lane blocked on the first.
    footprint:
      - package.json   # the MCP SDK, exact version
      - package-lock.json
      - server/index.js   # mount, flag, scheduler start
      - server/db/schema.sql
      - server/db/schema.connector.test.js   # new
      - server/db/constraintContract.test.js
      - server/db/criticalIndexes.test.js
      - server/routes/connectorMcp.js   # new
      - server/routes/connectorOauth.js   # new
      - server/routes/admin/connector.js   # new
      - server/routes/admin/index.js
      - server/routes/connector*.test.js
      - server/routes/admin/connector*.test.js
      - server/routes/webauthn.js   # only if the assertion check must be exported for reuse; no session is minted
      - server/utils/connector/grants.js   # new, as are the six below
      - server/utils/connector/tokens.js
      - server/utils/connector/auth.js
      - server/utils/connector/callLog.js
      - server/utils/connector/addressCheck.js
      - server/utils/connector/cleanupScheduler.js
      - server/utils/connector/mail.js
      - server/utils/connector/{grants,tokens,auth,callLog,addressCheck,cleanupScheduler,mail}.test.js
      - server/middleware/rateLimiters.js
      - server/middleware/rateLimiters.test.js
      - server/utils/sentryScrub.js
      - server/utils/sentryScrub.test.js
      - server/utils/sentryScrub.tokenRoutes.test.js
      - .env.example
      - .claude/CLAUDE.md
      - scripts/claudemd-invariants.txt
      - scripts/sensitive-paths.txt
      - docs/ops-runbook.md
      - docs/reviewer-map.md
      - README.md
      - ARCHITECTURE.md   # the concept section and the generated route table
    blockedBy: []
    lenses: >
      the tier A floor (money, lifecycle, concurrency, outcomes-providers, access-egress, seams) plus schema-data and whatever the review skill computes; verify; the externals; the money smoke.
    laws: >
      Spec laws 5, 8, 9 and 10 and sections 7.1, 7.2, 7.4 and 7.5. The auth invariants: the passkey
      check reuses the existing verification and mints no device session (webauthn.js stays the only
      site that mints the 12h device JWT); the approve, status and disconnect routes are auth plus
      adminOnly; an admin session JWT is refused at /mcp and a connector token is refused by auth().
      Multi-table writes in BEGIN/COMMIT; schema idempotent; secrets from process.env. Resend never
      throws (check .error) on the two owner emails.
    seams: >
      server/index.js mount order (the raw-body webhooks, cors, the global parsers); auth.js is
      unchanged; the webauthn assertion path; the existing scheduler flags and health rows; the
      Sentry scrub guard's manifest; rateLimiters' existing exports; the CLAUDE.md invariant check.
    acceptance: >
      The reached suites and the money smoke pass. With the flag unset every connector path answers
      404 (asserted). With it on, in process: an unauthenticated /mcp call gets 401 with the
      resource_metadata header; the metadata's resource equals the configured public URL; the full
      flow (authorize, approve with a stubbed passkey assertion, code exchange with PKCE, a tool
      list call, a refresh) succeeds through the SDK's own client; and each refusal in the test plan
      holds. The Sentry scrub guard fails on main for the new routes and passes in the lane. After the
      merge applies schema.sql, the five tables, their constraints and their indexes are read back
      from the dev database.
    test plan: >
      Endpoint: GET /mcp is 405; a body over the limit is refused; the per-grant limiter and each
      per-address limiter answer 429 past their limit. Authorize: wrong client id or return address gives an error page with no redirect; a missing
      challenge or state redirects with an error. Approve: a manager is refused; a missing or failed
      passkey assertion is refused; a used or expired pending row is refused; two approvals of one
      row yield one grant; approving with a grant present replaces it and revokes its tokens.
      Token: a wrong verifier, a wrong return address and an expired code are refused; a code used
      twice is refused and its tokens die; two parallel refreshes leave one winner and a live grant;
      a rotated-out token inside 30 seconds is refused with the grant alive, after 30 seconds it
      revokes the grant and both alerts fire (stubs). Per call: an expired token, a revoked grant, a
      demoted user and a bumped token_version each get 401; an admin JWT gets 401; a connector token
      on /api/admin/inbox gets 401. The call log holds the caller's address as req.ip reads it, which
      is what the owner step after switch-on checks. Lifetimes: a grant idle 30 days and a grant 180 days old are
      dead (clock injected). Address check: outside the range is refused and logged with no grant,
      and is not enforced outside production. Call log: a failed insert does not fail the call.
      Cleanup: old log rows, expired requests, used codes and dead tokens go; live ones stay.
      Disconnect leaves the log rows. Emails and audit entries are asserted through injected stubs.
    revert: >
      revert the one squash commit; the tables stay (idempotent, unused with the flag off).
  - id: connector-text-guards-2
    scope: >
      The text guards' findings left open by the first lane's review cap (its receipt names each one
      split here), fixed at the root. The withhold tier holds only text a real client never writes: a
      named AI must be addressed (a greeting or vocative), never merely mentioned (a first-dance duet,
      a husband named Claude); no withhold pattern without an AI, instruction or role word ("can you
      respond to me by Friday", "I forget everything"); the client's own uses of instructions, rules,
      system message and the above (payment errors, "per your original instructions", "disregard the
      above, I found the invoice") and ordinary Spanish ("olvidé sus instrucciones") pass or flag. The
      published benchmark strings (the AgentDojo templates, PromptInject's attack texts) are withheld or
      flagged whatever their payload. The flag tier is quiet on everyday client mail (the first lane's
      verify measured 52 of 53 flagged). The strip cuts a host written in Title Case, with a numeric
      or abbreviation first label, and keeps a time, date, amount or invoice number typed with no space
      after the period. Tag-sequence flag emoji are not hidden text.
    footprint:
      - server/utils/connector/textGuards.js
      - server/utils/connector/screenPatterns.js
      - server/utils/connector/textGuards.test.js
    blockedBy: []
    lenses: >
      the tier A floor (money, lifecycle, concurrency, outcomes-providers, access-egress, seams) and whatever the review skill computes; verify; the externals. Reviewed at tier A as the defense of spec 7.6.
    laws: >
      Spec law 3 and section 7.6 as amended (two tiers). No AI call in the screening. aiRedact's own
      output is unchanged.
    seams: >
      The tools lane is the first caller; the result shape { withheld, flagged, tier, pattern } and
      FLAG_NOTICE stay as the first lane left them.
    acceptance: >
      Every input of the split findings in the first lane's receipt is in a table with its expected
      tier or strip result and passes; every earlier table row still passes; verify's ordinary sets
      (the scratch probe scripts) withhold nothing and flag a small share; linear time holds at 49,000
      characters for every recorded shape.
    test plan: >
      Table-driven, as the first lane's suite: the split inputs, an ordinary English and Spanish set
      written for the flag tier's patterns, the benchmark strings with payloads that name no client
      data, Title Case and numeric hosts, facts with no space after the period.
    revert: >
      revert the one squash commit; the first lane's guards remain.
  - id: connector-signin-ui
    scope: >
      The owner can approve and manage the connection. A consent page in the admin app behind
      adminStrict that loads the pending request, shows what Claude will read, when and from where
      the request started and whether it replaces a connection, asks for the passkey on Allow, and
      returns the browser to Claude on Allow or Cancel; a way back to this one page after login for
      a signed-out owner; and a "Claude connection" block in admin settings showing the connection,
      when it was approved and last used, the recent calls, the withheld messages, and Disconnect.
    footprint:
      - client/src/App.js
      - client/src/pages/Login.js   # the return path for the consent page only
      - client/src/pages/admin/ConnectClaude.js   # new
      - client/src/pages/admin/ConnectClaude.css
      - client/src/pages/admin/ConnectClaude.test.js
      - client/src/components/ClaudeConnection.js   # new: the settings block
      - client/src/components/ClaudeConnection.test.js
      - client/src/pages/admin/SecuritySettings.js
      - client/src/utils/connectReturn.js   # new: the allowlisted return path
      - client/src/utils/connectReturn.test.js
      - README.md   # generated tree lines only
    blockedBy: [connector-signin-server]
    lenses: >
      the tier A floor (money, lifecycle, concurrency, outcomes-providers, access-egress, seams) plus client, and whatever the review skill computes; verify; captures at 320 and 390 wide of the consent page in each state and of the settings block.
    laws: >
      Spec 7.2 (consent page, Allow, Cancel). API calls through client/src/utils/api.js. The return
      path accepts only the consent route with a well-formed request id, never an arbitrary URL (an
      open redirect on the login page is the failure to avoid). The page sends the server nothing
      but the request id and the passkey assertion. Vanilla CSS with the existing tokens.
    seams: >
      Every other Navigate to /login in App.js keeps its behavior; SessionExpiryHandler; the
      existing passkey prompt helper the admin lock uses; SecuritySettings' existing blocks.
    acceptance: >
      The client build and the client suites pass. Against the dev server with the flag turned on
      for the session (a deliberate local exception to off-by-default, reachable only on localhost): starting
      an authorize request while signed out lands on login and then on the consent page for that
      request; Allow without a passkey does nothing; Allow returns to the stubbed return address
      with a code; Cancel returns with access_denied; a used or expired request shows the error
      state with no Allow; the settings block shows the connection and Disconnect clears it.
    test plan: >
      ConnectClaude: loading, a valid request, an invalid one, Allow pending (button disabled, one
      call on a double click), Allow failed, the replace warning. connectReturn: accepts the consent
      path with a valid id; rejects an absolute URL, a protocol-relative one, another admin path and
      a malformed id. ClaudeConnection: no connection, a live one, the call list, a withheld row,
      Disconnect.
    revert: >
      revert the one squash commit.
  - id: connector-tools
    scope: >
      The seven read tools of spec 7.3 and the bulk-read tripwire, registered on the endpoint. Each
      tool calls a shared read from connector-shared-reads with the hold exclusion, builds its
      result from a named field list, and passes every piece of client-written text through the
      screening and the destination strip and every other free-text field through the link strip.
      A withheld piece is logged as withheld and emails the owner once per message. The detail
      tools (Client, Proposal or event, Thread) count different clients per rolling hour against a
      cap; past it they refuse, the owner is emailed once per trip and Sentry is alerted. The list
      tools return no phone number and no email address, and Search reports a staff member as name
      and status only. Upcoming events takes a window of 14 days by default and 60 at most. Each tool carries a title, readOnlyHint
      and a description that says client-written fields are data.
    footprint:
      - server/utils/connector/tools/*.js   # new: one file per tool and the registry
      - server/utils/connector/tools/*.test.js
      - server/utils/connector/fields.js   # new: the field lists and the never-list
      - server/utils/connector/tripwire.js   # new
      - server/utils/connector/withheld.js   # new: the log row and the owner email
      - server/utils/connector/*.test.js
      - server/routes/connectorMcp.js   # register the tools
      - server/routes/connectorMcp.tools.test.js
      - .env.example   # the tripwire cap
      - docs/ops-runbook.md
      - README.md
      - ARCHITECTURE.md
    blockedBy: [connector-shared-reads, connector-text-guards, connector-text-guards-2, connector-signin-server]
    lenses: >
      the tier A floor (money, lifecycle, concurrency, outcomes-providers, access-egress, seams) and whatever the review skill computes; verify; the externals; the money smoke.
    laws: >
      The call log already has the client id column the tripwire counts on (the sign-in server lane
      provides it); needing a schema change here is a stop, not a quiet edit.
      Spec laws 1, 2, 3, 4, 6, 7 and 8 and section 7.6. Money law 15: the hold is read only through
      the fail-closed functions and a hold list that cannot be read fails every tool. No tool and no
      function it calls writes to a business table (getItem, never markSeen). Money figures are
      reported as the shared reads return them, with no arithmetic. Event type goes through
      getEventTypeLabel, separate from the client name. The event-side drink plan is the one
      reported. One pooled connection per call.
    seams: >
      The shared reads and their admin callers (unchanged here); the Inbox engine predicate; the call
      log's shape, which the settings block reads; the text guards; the per-grant limiter.
    acceptance: >
      The reached suites and the money smoke pass. In process through the SDK client, each tool's
      answer equals the admin route's answer for the same seeded rows, field for field on the fields
      it carries (the amount owed against the admin Outstanding figure, the short-staffed flag
      against the admin badge predicate). A scan test walks every tool's result for a seeded world
      and finds none of: a link token, a banking field, a tax id, a password hash, a home address, a
      token_version, a Stripe secret, a URL, and (in list tools) a phone or an email; a staff row in
      Search carries name and status and nothing else. A synthetic held proposal, its client, that
      client's second booking, its shift and its thread are absent from every tool and a lookup of
      each gives the not-found a missing id gives. The owner's personal mail is absent.
    test plan: >
      Per tool: the happy path against seeded rows; the cap and the "more exists" marker; not-found;
      a failing query sends Sentry the tool name and an error descriptor and neither the arguments
      nor the result (stubbed). Upcoming events: the default window is 14 days and a request over 60
      is cut to 60.
      Thread: by person key and by client id; a merged person is followed; a staff key, a personal
      thread and a held key give the same not-found; a business-sent message has its proposal link
      replaced by a marker; an inbound attack wording comes back withheld with its Inbox summary,
      writes one withheld log row and sends one email however many times it is read. Money owed: no
      due date. Proposal or event: no drink plan yet. Tripwire: the cap-th different client is
      served, the next is refused, a repeat of an already-counted client is served, one email per
      trip, the window rolls (clock injected), list tools are not counted. Hold list unreadable:
      every tool errors and returns nothing. A database snapshot of the business tables before and
      after the whole suite's tool calls is identical (the read-only proof).
    revert: >
      revert the one squash commit; with the tools gone the endpoint lists none.
mergeOrder: >
  connector-signin-server first (it carries the sensitive-list lines and the project-rules invariant, so everything after it is tiered correctly and the smaller lanes, not the largest, pay for the overlap pass); then connector-shared-reads; then connector-text-guards; then connector-text-guards-2 and connector-signin-ui in either order; then connector-tools.
revertOrder: >
  the reverse of the merge order. connector-tools and connector-signin-ui are reverted before connector-signin-server, and connector-tools before connector-shared-reads and connector-text-guards.
pushGate: >
  Every lane ships alone and dark: the first two change nothing a user sees and the rest sit behind
  the connector flag, which is unset in Render. The flag is turned on by the owner in Render after all
  five lanes have shipped, followed by the spec's rollout steps 3 to 7.
---

# Claude connector for the OS, release 1: implementation plan

Five lanes. The front matter above is the lane map; this body records why it is cut this way and what each lane hands the next.

## How the cut was made

The spec's largest risk is a leak, and the review found the leaks in code the connector would call, not in the connector. So the hold-safe reads are their own lane, built and reviewed against the admin screens before any connector code exists, with the existing route tests as the oracle that nothing moved.

Sign-in is split from the tools because it is the part an attacker meets first and it deserves a review that reads nothing else. Its server half lands with no tools at all, so a mistake in it exposes an empty tool list. The consent page and settings block follow as a client lane with its own captures.

The text guards are pure functions with a table of real wordings, so they are a small lane that can be built in parallel and judged on the table alone.

The tools come last and are thin by construction: a shared read, a field list, the guards.

## Build method and price

My call on method: one pass per lane, no parallel subagents inside a lane, since each lane is one coherent piece. Lanes 1, 2 and 3 have no dependencies and can be built in three windows at once; lanes 4 and 5 follow.

Review price, by the review skill's bar (one full pass and at most two fix re-passes per lane): all five lanes at the full set, the consent-page lane with captures as well. The text guards lane is small, so its full pass is short. The sign-in server lane is the heaviest single review in the plan. Because the first three lanes are built at once and merge in a fixed order, the second and third each pay one overlap pass when the lane ahead of them lands; that is the cost of building them in parallel and it is cheaper than building them one after another.

Every lane's footprint names README.md, and three name ARCHITECTURE.md. Those are the generated sections, which the merge script regenerates on the merged index, so parallel lanes do not conflict there. The one hand-written ARCHITECTURE concept section belongs to the sign-in server lane alone.

## What each lane hands on

- Shared reads to tools: the four read functions, the search exclusion, the Inbox predicate and the held-client-ids function, each with the hold exclusion as a parameter.
- Text guards to tools: the screening function and the destination strip.
- Sign-in server to sign-in UI: the pending-request read, approve, cancel, status, call-list and disconnect routes and their response shapes, written into the lane report so the UI lane builds against them.
- Sign-in server to tools: the endpoint with its per-call check, the call log (with a withheld outcome and the client id column the tripwire counts on) and the per-grant limiter.

## Decisions left open by the spec and settled here

- The CLAUDE.md invariant and the sensitive-path lines land with the sign-in server lane, which merges first, so every later lane is tiered by the list. The text guards lane is reviewed at the full tier by declaration in any case.
- The settings block shows withheld messages from the call log, so the tools lane needs no client code.
- The connector's files live under `server/utils/connector/` and three route files; the shared reads live under `server/utils/reads/`. A builder who finds a better home says so in the lane report.

## Owner steps, after the fifth ship

From the spec's rollout: set the connector flag in Render (and the address-range variable, or leave its default), add the connector in Claude's settings, approve it with the passkey, run the three headline questions in a Claude chat against the admin screens, look up the held client and confirm nothing returns, run the guard checks against a test client, add the one line to Duet's instructions, then confirm the connector shows in Duet.

One check sits between switching on and trusting the address check (spec 7.5). After the first calls from Claude, I read the call log and confirm the address it recorded falls inside Anthropic's range. If every call is refused instead, Render's proxy is reporting the wrong address: the range variable is emptied in Render to switch the check off, and the fix ships before it is switched back on.

## Review record (2026-11-19)

The plan fleet (fidelity, decomposition) read revision 1: no blockers, twelve warnings, eight suggestions, all folded in as revision 2.
- Spec details no lane carried: the 405 and the JSON limit on the endpoint, tests for both limiters, the four `.env.example` entries, Search's staff fields, the events window, the Sentry rule on tool errors, the two never-list items the scan missed, and the Render address confirmation (now an owner-step check above).
- Review tier: the text guards and consent-page lanes were forecast lighter than spec rollout step 1 allows; both are now at the full set.
- The open-balance read: the admin list's response does not change; the new columns are opt-in.
- Reads with no pinning test today get one that passes on main before the move.
- Merge and revert order are named, the overlap passes are priced, and the sign-in server lane's split line is named in its scope.
- Footprints: the sign-in server lane names its files, and the tools lane makes no schema edit.


## First wave, as built (2026-11-19)

The sign-in server, the shared reads and the text guards are merged (cc028a5b, b7b3005d, 334485a0), each with its tier A receipt. The text guards' open findings went to the new lane connector-text-guards-2 under the review cap. What the remaining lanes must build on, as the code now stands:

To connector-signin-ui (all routes under /api/admin/connector, auth plus adminOnly; the consent page is `${ADMIN_URL}/connect-claude?request=<uuid>`):
- GET /requests/:id: `{ request: { id, status, client_name, redirect_host, requested_at, expires_at, caller_address, user_agent, reads }, existing_connection }`, `existing_connection` only when a live connection exists; 404 CONNECTOR_REQUEST_NOT_FOUND, 410 CONNECTOR_REQUEST_USED, _CANCELLED or _EXPIRED.
- POST /assert-options: passkey request options listing only the admin's own passkeys; 409 CONNECTOR_PASSKEY_NONE.
- POST /requests/:id/approve `{ assertion }`: `{ redirect_url, replaced }`, `replaced` meaning a live connection the exchange will replace; 400 CONNECTOR_PASSKEY_REQUIRED or _EXPIRED, 409 CONNECTOR_PASSKEY_NONE, 403 CONNECTOR_PASSKEY_WRONG_ACCOUNT or _FAILED, the 404 and 410 codes above. The owner holds an admin and a staff account; the wrong-account message must say which to use.
- POST /requests/:id/cancel: `{ redirect_url }`.
- GET /status: `{ connection: { id, state, approved_at, connected_at, last_used_at, expires_at, lapses_at } | null, client_id, mcp_url, address_check }`, state one of live, lapsed, expired, signed_out, no_longer_admin; address_check on, off or unreadable.
- GET /calls?refusals=0|1&outcome=&all=1&limit=: `{ calls: [...], has_more }`, refusals shown by default.
- POST /disconnect: `{ ok, revoked }`.
- The client's Sentry scrubber has no rule for the `drbc_` prefix and the page holds a sign-in code in `redirect_url`; add the rule (client/src/utils/sentryScrub.js joins the footprint).

To connector-tools:
- Every call into a shared read passes `legalHold.holdExclusion()`; only listUpcomingEvents refuses a missing exclusion, the others answer as the admin screen does without one. A test fails if any tool call site omits it.
- The shared client and proposal reads return whole rows, link tokens included; each tool builds its result from its named field list.
- Search's staff rows carry `cc_id` and a `name` that can fall through to an email; report name and status only.
- Thread: a staff key, and a key that moves to a staff key, gets the not-found (the staff card's next-shift read takes no hold list); drop tap rows when the hold filter leaves no kept message.
- Upcoming events: the default start must keep a shift that began the evening before and runs past midnight (yesterday's Chicago day, or no lower bound beyond shiftNotFinishedSql); a hand-made shift typed with the held client's name is not caught by the exclusion, so match it out by the held client's name or drop hand-made shifts whose client name matches.
- Screening: a withheld piece emails the owner once (callLog.recordWithheldOnce); a flagged piece carries FLAG_NOTICE in front and a log row, and emails no one.
- The per-address ceiling (300 per 15 minutes, shared by /mcp and /oauth/token) counts authenticated calls; keep authenticated tool calls out of it or size it above the per-grant limit, so a busy session never blocks its own refresh.
- Call-log rows for errors are written after the response; the tripwire's count must not depend on a row that is not yet written.
- Pre-existing and reported, not this plan's: the admin Outstanding figure (qOutstanding) counts paid off-contract invoices against the contract total, so a booking with a paid extras invoice shows less owed than its contract remainder; the tool reports the admin's figure as law 4 requires.
