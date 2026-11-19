# Claude connector for the OS: Duet can read the business and brief the owner

Date: 2026-11-19. Brainstormed with Dallas in one session. This spec covers release 1 (read only). Release 2 (writes) is sketched in section 11 and gets its own spec.

## 1. Why

Dallas, 2026-11-19: "I am considering creating an MCP for DrB OS so I can have it talk to Duet."

Claude Duet is Anthropic's proactive agent (research preview, launched 2026-10-21). It checks in on its own schedule and reaches out before it is asked, and it works through the connectors on the owner's Claude account. The OS holds everything the business knows (who is waiting on a reply, which events are short staffed, who owes money) and none of it is reachable from Claude today. A connector makes the OS one of the places Duet looks.

Asked how far it should go: "I would thing I would want it to be cabable of everything." Asked what it should raise unprompted (a morning rundown of what is waiting, a new-lead alert, a short-staffed event, an overdue balance): "new leads already have a good system, but the rest yeah."

## 2. What it does

1. The API server gains one endpoint that speaks the Model Context Protocol (MCP), the protocol Claude connectors use.
2. Dallas adds that endpoint to his Claude account once, as a custom connector, and approves it on a consent page inside the OS admin.
3. From then on Claude, and Duet through the same account, can call a small set of read-only tools: what is waiting on him, upcoming events and their staffing, money owed, a search, and detail lookups for a client, a proposal or event, and a person's message thread.
4. Every call is logged, and one button in admin settings cuts the connection off.

Nothing in release 1 changes any record in the OS.

## 3. Goals, non-goals, anti-goals

**Goals**
- Duet can answer "what needs me today", "is this weekend staffed" and "who owes us money" from live OS data, with the same answers the admin screens give.
- Follow-up questions work: find a client, read their proposal, read what they last said.
- The connection is its own credential: revoking it does not sign the admin out, and signing the admin out everywhere also kills it.
- The owner can see what Claude looked at.

**Non-goals**
- Any write. No notes, no drafts, no status changes, no sends. Section 11.
- New-lead alerts. Dallas: "new leads already have a good system."
- Scheduling Duet's check-ins. Duet decides when it looks; the OS only answers.
- A listing in Anthropic's public connector directory. This is a private connector on one account.
- Access for managers or staff. One admin, the owner.

**Anti-goals (a failure even if it technically works)**
- The legal-hold proposal, its client, its event, its shifts or its thread appearing in any tool result, or a lookup revealing that a held record exists.
- A bank account field, tax id, password hash, session token, or a proposal, invoice or drink-plan link token in any tool result. A link token is bearer access to sign and pay.
- A tool whose answer disagrees with the admin screen that shows the same thing (a second copy of a staffing or balance rule).
- A connector credential that can do anything the tools do not do (it must not work as an admin session against `/api`).
- A dev server, lane or test reachable by, or calling out to, Claude.

## 4. Decisions

Dallas's (2026-11-19):
- The destination is full capability: "I would thing I would want it to be cabable of everything."
- Client data goes to Claude in full detail, not redacted. Asked "full detail for Duet, yes or no?": "I think that is ok."
- The unprompted topics are what is waiting on him, short-staffed events and overdue balances; new leads are out: "new leads already have a good system, but the rest yeah."
- Release 1 as described in the brainstorm (read tools, own sign-in, call log): "release 1 looks right, write the spec."

Mine:
- Read only first, writes in a second release, so a week of use shows which writes are worth building.
- The OS is its own sign-in authority for the connector (section 7.2), with one pre-registered client and one fixed return address. No open self-registration endpoint.
- Tools call the functions the admin routes already call, never a copied query (section 6, law 3).
- Staff banking fields and the legal-hold proposal stay out of every result.
- Personal mail (mail the Inbox sync judged personal) stays out. The Gmail connector on the same Claude account already reaches that mailbox, so nothing is lost.
- Only the admin role can grant the connection; a manager cannot.
- Calls from outside Anthropic's published address range are refused in production (section 7.5).

## 5. Verified context

Code, read 2026-11-19:
- `server/utils/inbox/engine.js` exports `getInbox({ viewerId })` and `getItem({ personKey, viewerId })`; `server/routes/admin/inbox.js` serves them behind `auth` and `requireAdminOrManager`. The engine marks legal-hold subjects (`legalHold`) and filters personal mail by viewer.
- `server/routes/shifts.js` `GET /unstaffed-upcoming` lists open shifts with open slots through the shared fragments `shiftNotFinishedSql` and `openSlotsSql` (`shifts.queries.js`); the admin badge count uses the same fragments.
- `server/routes/proposals/list.js` has the open-balance filter (`balance === 'open'`, with the shared not-dead predicate) and returns `balance_due_date`.
- `server/utils/globalSearch.js` `runGlobalSearch(q)` searches clients, proposals, events and staff.
- `server/utils/legalHold.js` exports `isLegalHold(id)` and `heldProposalIds()`; both fail closed.
- `server/middleware/auth.js` checks `users.token_version` on every request, so a bump is a global logout.
- `server/index.js` sets `trust proxy` to 1 and mounts `express.json` with a 1mb limit; `schema.sql` has `admin_audit_log`.
- Proposal money columns are dollars as stored (`docs/money-laws.md`); the tools report them as stored and do no arithmetic in JavaScript.

Anthropic's connector documentation, read 2026-11-19 (claude.com/docs/connectors):
- Transport: Streamable HTTP. The older SSE transport is being retired.
- Sign-in: OAuth with PKCE (S256) on every request. The server answers an unauthenticated call with 401 and a `WWW-Authenticate: Bearer resource_metadata="..."` header, publishes protected-resource metadata whose `resource` equals the exact URL entered in Claude, and publishes authorization-server metadata. The custom connector dialog accepts a pre-registered client id ("Use your own OAuth client").
- Claude's return address is `https://claude.ai/api/mcp/auth_callback`.
- Claude's calls come from `160.79.104.0/21`.
- Every tool needs a `title` and `readOnlyHint: true` (reads) or `destructiveHint: true` (writes). Read-only tools run without a per-call prompt.
- Limits: a tool result of about 150,000 characters, a call timeout of 240 seconds. Discovery and token calls must answer within 10 seconds.
- The token endpoint takes form-encoded bodies, rotates refresh tokens and answers `invalid_grant` for a dead one.

Not verified:
- No official Anthropic page says Duet uses custom connectors. News coverage says it carries over the account's connected apps. Section 10 tests this before anything depends on it.
- How Duet's approval step treats read-only tools is undocumented. Release 1 does not depend on it.

## 6. Laws

1. **Legal hold.** Every tool excludes the held proposal ids. A list query binds `heldProposalIds()` as one parameter where it picks rows; a lookup by id calls `isLegalHold` first and answers with the same not-found a missing id gets. The held client and their thread are excluded through the Inbox engine's own `legalHold` mark and by client id on client lookups and search. A missing or unreadable hold list fails the call; it never answers "not held".
2. **Field allowlist.** Every tool builds its result from named fields. No row is passed through whole. Never in a result: banking fields, tax ids, password hashes, `token_version`, any link token (proposal, invoice, drink plan, calendar feed, tip page), Stripe secrets, staff home addresses.
3. **One rule, one copy.** A tool calls the function or SQL fragment the admin route calls. Where the logic lives inline in a route today (the unstaffed list, the open-balance filter), the lane moves it to a shared function both call; it does not copy it.
4. **The credential is narrow.** A connector token is accepted only by the MCP endpoint, and an admin session JWT is not accepted there. The two are different kinds of token checked by different code.
5. **Read only.** No tool, and no function a tool calls, writes to a business table. `getItem` is called, never `markSeen`. The only writes are the connector's own tables (grants, tokens, the call log).
6. **Thread text is data.** Message bodies come from strangers. Tool results carry them in clearly named fields, and each tool's description says the content is client-written data, not instructions.
7. **Errors and logs.** Tool errors follow the route rule: a plain message, no stack, SQL or path. Sentry gets the tool name and an error descriptor, never arguments or results.
8. **Existing invariants hold as written:** parameterized SQL, one pooled connection per call, secrets from `process.env`, schema changes idempotent in `schema.sql`.

## 7. How it works

### 7.1 The endpoint

`POST /mcp` on the API server, Streamable HTTP in stateless mode: each call is one request and one JSON response, with no server-held session and no open stream. `GET /mcp` answers 405. The route is mounted before the `/api` routes with its own JSON body limit and its own rate limiter (per grant), and it takes no CORS headers because no browser calls it.

### 7.2 Sign-in

The OS acts as the sign-in authority for its own connector. Pieces:

- **Metadata.** `/.well-known/oauth-protected-resource/mcp` names the resource (the exact public URL of `/mcp`) and the issuer; `/.well-known/oauth-authorization-server` names the authorize and token endpoints, `S256` only, and `none` as the token endpoint auth method (Claude is a public client).
- **Client.** One client id, a constant, with the one return address from section 5. Any other client id or return address is refused before anything else happens. There is no registration endpoint.
- **Authorize.** `GET /oauth/authorize` validates the client, the return address, the PKCE challenge and the `state`, then sends the browser to a consent page in the admin app. The page is behind the admin guard, says in plain words what Claude will be able to read, and has Allow and Cancel. Allow calls an admin-only API route (through `api.js`, so the session JWT rides along) that creates the grant and a single-use code good for 60 seconds, and the page then returns the browser to Claude with the code.
- **Token.** `POST /oauth/token` exchanges the code (with the PKCE verifier) for an access token good for one hour and a refresh token. Each refresh rotates the refresh token. A refresh token presented twice revokes the whole grant.
- **Storage.** Tokens are random and opaque; only their SHA-256 hashes are stored. A grant row holds the admin's user id and the `token_version` it was granted under.
- **Each call.** The endpoint looks the access token up by hash, checks it is unexpired and its grant is live, loads the user, and requires `role = 'admin'` and a `token_version` equal to the grant's. So "sign out everywhere" kills the connector too.
- **Revoking.** A "Claude connection" block in admin settings shows whether a grant exists, when it was last used, and a Disconnect button that deletes the grant and its tokens. Approving again while a grant exists replaces it.

### 7.3 The tools

All carry `readOnlyHint: true` and a `title`. Dates are Chicago dates. Lists are capped and say when more exists, so no result approaches the size limit.

| Tool | What it answers | Built on |
|---|---|---|
| Waiting on you | The Inbox list for the owner: each person, why they are waiting, how long, the last message summary | `engine.getInbox`, minus held and personal items |
| Upcoming events | Events in the next N days (default 14, max 60): date, time, place, client, event type, guest count, bartenders and barbacks needed and confirmed, and a short-staffed flag | the shift queries and `openSlotsSql` |
| Money owed | Accepted bookings with an open balance: client, event date, amount owed, due date, days overdue or days until due, autopay or not | the open-balance filter in the proposals list |
| Search | Clients, proposals, events and staff by partial name, email or phone | `runGlobalSearch` |
| Client | One client: contact details, their proposals and events, notes | the client detail read |
| Proposal or event | One booking: package, add-ons, price lines, payment state, event details, staffing, drink-plan status | the proposal detail read, the event's drink plan (the event side is canonical) |
| Thread | One person's recent messages, texts and email, both directions, newest first | `engine.getItem` |

Event type is reported through `getEventTypeLabel`, separate from the client name. Staff appear only as search results and as names on a shift; there is no staff detail tool in release 1.

### 7.4 The call log

A table records each tool call: time, grant, tool name, the record ids asked for, result count, duration, outcome. It does not store search text or results. Admin settings shows the last calls under the connection block. Rows older than 90 days are deleted by the existing nightly housekeeping.

### 7.5 Address check

In production the MCP endpoint and the token endpoint refuse callers outside Anthropic's published range. The range is an environment variable with the published value as its default, so a change on Anthropic's side is a config edit, and a refused call is logged with its address so a silent range change shows up as a pattern, not a mystery. The authorize endpoint and the consent page are reached by the owner's own browser and are not range-checked.

## 8. Failure modes

- **The hold list cannot be read:** every tool fails with a plain "unavailable" error. Nothing is returned.
- **A tool's query fails:** that call returns an error result; other tools keep working. Sentry gets the tool name.
- **Anthropic's address range changes:** calls are refused and logged; Duet reports the connector as failing. Fix is the environment variable.
- **A refresh token is replayed (stolen or a client bug):** the grant is revoked, the connection block shows disconnected, and the owner approves again.
- **The admin's sessions are revoked:** the connector stops with 401 and Claude asks to reconnect.
- **A prompt planted in a client message:** release 1 has no OS write to trigger. The remaining exposure is Duet's other connectors (for example sending mail), which sit behind Duet's own approval step. Law 6 lowers the odds; it is not a guarantee, and it is the main reason writes get their own spec.
- **Render is cold or slow:** discovery and token calls have a 10 second budget. The metadata routes are static and the token route is one indexed lookup.

## 9. Left to the builder

- The MCP library: the official TypeScript SDK, pinned to an exact version. The 1.x line is `latest` on npm (1.32.2 on 2026-11-19); a 2.x line with a separate Express package exists. Pick the one whose bearer-auth and metadata helpers fit, and say which.
- Table and column names, the exact tool names and their input schemas (zod is already a dependency).
- Where the shared staffing and open-balance functions land when they move out of their routes.
- Result caps per tool and the paging shape.
- The consent page's layout, within the existing admin settings vocabulary.
- Whether the consent step also asks for the passkey; a plain admin session is the floor.

## 10. Rollout

1. Build in a lane; it touches sign-in and client data, so it gets the full review set.
2. Tests drive the endpoint in process with the SDK's own client and never reach Claude. The dev server serves `/mcp`, but nothing outside the box can reach it.
3. After the ship, Dallas confirms the address-range variable in Render (or leaves the default), adds the connector in Claude's settings with the public `/mcp` URL and the client id, and approves on the consent page.
4. First check is in an ordinary Claude chat: ask each of the three headline questions and compare with the admin screens.
5. Second check is Duet: confirm the connector shows up there. If Duet does not carry custom connectors during its preview, the connector still serves Claude chat on web and phone, and the Duet half waits on Anthropic.
6. Off switch: Disconnect in settings.

## 11. Release 2, sketched only

Writes, in three tiers, each tool calling the same code the admin screen calls so every money and hold guard applies:
- Reads: as release 1.
- Ordinary writes (a note, an Inbox claim or done, a staffing change): run directly, logged as done through the connector.
- Money, anything sent to a client, and anything irreversible: the tool creates a pending action that the owner confirms inside the OS. Nothing said in a conversation can confirm it, which is the defense against a planted prompt.

This needs its own brainstorm on which writes matter after release 1 has been used.

## 12. Docs and lists

- `.claude/CLAUDE.md` gains one invariant (and its line in `scripts/claudemd-invariants.txt`): the Claude connector is read only, is the one place client data leaves the OS unredacted, and obeys the hold and the field allowlist.
- `scripts/sensitive-paths.txt`: the connector's route, sign-in and tool files join the auth-and-pii section.
- `.env.example`: the address-range variable and the connector's public URL if it cannot be derived from `API_URL`.
- `ARCHITECTURE.md`: a short concept section; the route table regenerates.
- `docs/ops-runbook.md`: connect, disconnect, and what to do when the address range changes.
- `docs/reviewer-map.md`: one line for the new surface.
