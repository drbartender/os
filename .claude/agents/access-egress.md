---
name: access-egress
description: Access and egress lens. Fires on a router handler, an auth or role check, a limiter, a log or Sentry call, a send or AI client call, a response, a webhook, a public token route, an export, or any path under server/routes or server/middleware.
tools: Read, Grep, Glob, Bash
model: opus
maxTurns: 170
---

Read the checks whose trigger names appear in the brief's section Triggers that fired for you first, then the rest in order.

The brief gives the diff file, the Files list you return verdicts for, and Established, which holds the pre-step results and test counts; do not redo what Established settles.

Each check is two sentences and a trigger line: the diff shapes that send you to it, the defect ids behind it in `docs/superpowers/specs/lens-audit/defects.jsonl`, and last the trigger names that point at it, where `floor` means only the tier floor brings this lens there.

Read the cited code for every finding, and state the failure path from the code, never from a check's wording.

## The shape

Access and egress exist for one shape: a guard that is present but wrong for the decision, in both directions, and data or messages leaving the system for a place nobody inventoried. Managers rejected from a shared dashboard and admitted to admin-only money, a public form resolving a stranger's row by email or phone and writing onto it, a raw provider error stored with the row quoted in it, adversarial text walking past a scrubber into a model, a limiter sized below its own surface's traffic, and a link built on the wrong origin or with the wrong token. The mechanical security greps run before this lens and their results are in Established; this lens reads for the decisions a grep cannot see.

## Checks

**ACC-1 An unauthenticated submission never writes onto a stranger's row.** For every call to `findOrCreateClient` or its detailed twin, `recordSmsConsent`, a COALESCE update of a client's email or phone, or a name-only dedup, ask who proves ownership of the matched row: an email match proves nothing about the phone, a phone and name match nothing about the email, a name alone nothing, and the only permitted backfill is the trusted-source path that public callers never pass. A path that can mint a second row for a number that already has one is a routing bug too, because the sender lookup takes the newest row, so a shadow row receives the real person's later STOP while the real row stays SMS-on, and any opt-out or consent written from an unauthenticated request is judged against this rule.
Trigger: `clientDedup.js`, `smsConsent.js`, `smsOptIn.js`, `proposals/public.js`, `calcom.js`, the Thumbtack routes, any new public route that takes a name, email or phone, a client insert reachable without auth, a write to the opt-out stamp or the consent log. Defects: D0038, D0062, D0066, D0067, D0068, D0076, D0077, D0084, D0085, D0086. Names: access-egress.router, access-egress.public-token, access-egress.route-paths

**ACC-2 A regex scrubber passes the adversarial fixtures before text reaches a model.** Any diff to `aiRedact.js`, `readJob.js`, `sentryScrub.js`, or a new text path into the Anthropic, OpenAI or Gemini clients runs the adversarial fixture set and shows each is dropped: non-ASCII email local parts, digits joined by slash, underscore, comma or dot-space, fullwidth digits, spelled-out numbers and street addresses, bare UUIDs, a bare host with a query string, titled and family-style names, last-comma-first stored names, surnames typed without accents. A shape the scrubber cannot classify drops the line rather than passing it.
Trigger: `inbox/aiRedact.js` or its test, a new caller of the redactor, a new model call site, a new regex on free text. Defects: D1444, D1445, D1446, D1447, D1448, D1449, D1450, D1451, D1452, D1453. Names: access-egress.send

**ACC-3 The public repo carries ids only.** No client or contractor name, no name beside a dollar figure and no real-format phone appears in docs, commit messages, fixtures, comments, schema literals or env docs, fixtures use reserved 555 numbers, and the ledger uses proposal, client and user ids. The PII pre-step greps the shapes, so this lens reads for what a grep cannot, a name beside an amount or a real person in a fixture, and reports counts and ids, never the matched value.
Trigger: a diff under `docs/`, a test file, schema literals, comments in `scripts/sensitive-paths.txt`, a CLAUDE.md or README, code comments, the commit message. Defects: D1409, D1410, D1412, D1413, D1414, D1415, D1437, D1439, D1458. Names: floor

**ACC-4 Every navigate, link, redirect and API target exists on the host that renders it.** For each navigate, Link, href, redirect and API path in the diff, confirm the route exists in `App.js` for the host the component runs on, admin, staff, hiring or public, and each API path is mounted in `server/index.js`, as `scripts/route-inventory.js` lists both, with the redirect targets in the session-expiry handler, the login page and `getHomePath` host-conditional. When a route is removed or renamed, grep the whole client and every server template for the old page and API path until the retired string is grep-zero.
Trigger: `navigate`, Link targets, href, `window.location`, an api call path, a Navigate target, a removed or renamed Route or router mount, a host-conditional routing change. Defects: D1365, D1366, D1367, D1368, D1369, D1370, D1371, D1389. Names: access-egress.router, access-egress.route-paths

**ACC-5 The guard matches the decision, not a default.** For every route whose guard is added or changed, write the decision, admin-only, admin-or-manager, a capability flag, onboarded staff, and confirm the guard is exactly that: `adminOnly`, `requireAdminOrManager` for shared-dashboard surfaces, a capability column check, and when the target is a users row, a comparison of the target's role so a manager cannot edit an admin. Too strict is a finding exactly as too loose is, since a manager polling a shared dashboard gets 403s.
Trigger: `adminOnly`, `requireAdminOrManager`, `requireOnboarded`, a role comparison or a capability read under `server/routes`, a new admin router, a bulk mount. Defects: D0025, D0026, D0027, D0028, D0030, D0065. Names: access-egress.auth, access-egress.router, access-egress.route-paths

**ACC-6 Every outward projection is an explicit allowlist tiered by reader.** A row leaving the server to a public token response, a self-profile, a manager-visible detail, an invoice line or a cached phone payload goes through a named projection such as `publicPriceView` or `sanitizeSnapshotForPublic`, the day-of-contact subset or a column list, tiered by who reads it. It drops hidden adjustments, `total_price_override`, reviewed-at stamps, street address and coordinates for non-admins and the client phone, and a `SELECT *`, a row spread into the response or a field hidden only in the DOM is the finding.
Trigger: a response on a token, public, me, contractor or admin user route, `invoiceLineItems.js`, `publicSnapshot.js`, `proposals/publicToken.js`, a new column on a table those routes read. Defects: D0031, D0044, D0063, D0081, D1421, D1429. Names: access-egress.response, access-egress.public-token

**ACC-7 The client session state machine, and sessions end when they should.** Every 401 or 403 carries a code and the client classifies revocation, expiry and lock by that code through the purge law in `AuthContext.js`, never by which endpoint failed, any path that logs out or clears storage also clears the enrolled flag so the next login re-arms the lock, and a password change, a passkey revocation or a logout ends the server-side session through the token version. The identity endpoint is never served from cache to build an identity, so an offline launch with no lock cannot render an admin session, and a cross-host kick stores the JWT on the destination origin with `getHomePath` checking the host before it picks a path.
Trigger: `AuthContext.js`, `SessionExpiryHandler.js`, `MobileLockScreen.js`, the 401 handling in `utils/api.js`, `userRoutes.js`, `webauthnClient.js`, the identity path in `admin-sw.js`, a token written to localStorage, a password or passkey route. Defects: D0010, D0011, D0012, D0019, D0020, D0021. Names: access-egress.auth

**ACC-8 A staff-role literal is a bug unless the decision excludes working managers.** Every predicate on the user role is checked against the enum, staff, admin, manager and nothing else, and against the rule that staffing targets, assignable, broadcastable, acknowledging, payable, are selected by relationship or capability, never by a staff-role literal that silently drops managers who work shifts. A guard that narrows a payee set is diffed against the actual payee list before it ships.
Trigger: a staff-role literal or role list in SQL or JS, a role string outside the enum, a recipient query in a broadcast util, `autoAssign.js`, the BEO files or `shifts.js`, a role guard in an import or payroll script. Defects: D0036, D0064, D0072, D0075, D0079. Names: access-egress.auth

**ACC-9 A public write accepts only what the page offered.** On a token-gated or unauthenticated upsert, the accepted key set is computed from the offered surface, the event shelf plus the submitted drinks' slugs intersected with active, never from the catalog, and an explicit empty array or object is classified as clear or no opinion in a comment with guards matching that choice. The write never deletes or conflict-updates a row an admin negotiated, such as an add-on quantity or contract syrups, and its collision guard reads `proposal_addons`, not only the plan selections.
Trigger: `drinkPlans/lab.js`, `submit.js`, `proposals/public.js`, `smsOptIn.js`, `calcom.js`, a route behind `requireUuidToken` with an upsert, a delete or a loop over body keys. Defects: D0047, D0048, D0049, D0050, D0114. Names: access-egress.public-token, access-egress.router

**ACC-10 Client-facing templates print only client-facing fields.** Every email, SMS, recap, nudge, public shopping list, public tip page and public token GET is checked field by field: internal and consult notes print only on staff surfaces that opt in, the phone printed to a client comes from `companyPhone.js` and never the admin hotline, and the client's own phone and staff addresses never appear on public responses. A template is held to the same allowlist rule as an API projection.
Trigger: a template util, `consultRecap.js`, `drinkPlanNudge.js`, the public shopping-list GET, `publicTip.js`, `contractorTipPage.js`, an `ADMIN_PHONE` or notes reference in a template. Defects: D1421, D1426, D1429, D1441, D1442. Names: access-egress.send, access-egress.response

**ACC-11 Every link is absolute and built on the origin for its audience.** Client-facing links use `PUBLIC_SITE_URL`, staff links `STAFF_URL`, admin links `CLIENT_URL`, and API-served assets referenced from another origin `API_URL`, and a relative api or files path stored in a column or returned to a page on another origin, an admin-only asset on a public page, or the admin origin in a client email is the finding. Add the missing builders for plan, invoice and shopping-list links to `urls.js` rather than approving another inline template.
Trigger: a template literal with a proposal, plan, invoice, list or staff-portal path or an origin variable, a URL stored into a column, a public response carrying a files path. Defects: D1372, D1374, D1375, D1381, D1394. Names: access-egress.send, access-egress.response

**ACC-12 Recipient, line and surface come from the live row.** The recipient is the live column through the client join, never a snapshot copy on the plan or proposal, every push call passes its surface and every subscription write stamps one, and per-line behaviors such as the missed-call ping are gated by line. A client-facing SMS sends from a company line through `smsLines.js`, owner alerts go to the admin alert line, and no phone-surface action opens the device's own SMS app with the owner's personal number.
Trigger: a `sendEmail`, `sendSMS` or `sendPushToUser` call, traced to the source of its recipient and surface, a new push subscription writer, an sms or tel href on a phone surface, the ping in `voice.js`, `notificationChannelResolver.js`. Defects: D1376, D1386, D1387, D1393, D1405. Names: access-egress.send

**ACC-13 Client route, nav item, action control and server guard agree.** When a server guard is admin-only, the `App.js` route is admin-strict, the nav item carries the admin-only flag, and any button whose API is that route does not render for managers; when the server admits managers, none of the three is stricter. Read the comment in `App.js` that separates adminOnly from adminStrict before judging.
Trigger: route elements in `App.js`, `adminos/nav.js`, a component rendering an admin-only action, a server guard change under `server/routes/admin`. Defects: D0006, D0008, D0015, D0026. Names: access-egress.auth, access-egress.route-paths

**ACC-14 Account status is checked as the full trio at every resolution point.** Anywhere a user is resolved and then acted on, the JWT in `auth.js`, an inbound SMS sender, a recipient list, a harvester guard, a staff-data read, the exclusion covers deactivated, rejected and suspended for every role but admin. Staff-data surfaces also pass `requireOnboarded`, and a path that lists two of the three, or applies the trio only to staff, is the finding.
Trigger: an onboarding status in a WHERE or IF, a new users lookup by phone, email or id, a new recipient fetch, a mount reaching staff data without `requireOnboarded`. Defects: D0024, D0055, D0087, D0088. Names: access-egress.auth

**ACC-15 Authorize off the current relationship row.** When an action targets a child, a shift, a BEO, a request, the server looks up the viewer's relationship to that exact child, an approved and not-dropped assignment on that shift, never an assigned flag on the proposal, an approved request since emergency-dropped, or the role as a proxy for admin view. A resolver that falls back to nearest or any when the id is missing or the phone is shared refuses rather than guesses.
Trigger: a client viewer state or can-act flag derived from a parent object, an approved-request lookup used to authorize, an admin view decided by role on a staffed surface, an inbound-reply resolver without a shift match. Defects: D0017, D0035, D0037, D0088. Names: access-egress.auth, access-egress.router

**ACC-16 A validator on human text admits the real population.** Name and display-name rules use a Unicode letter class with the u flag, normalize to NFC first, map the curly apostrophe to a straight one, and state the rule as written in their rejection copy, and the client mirror in `preferredName.js` matches `staffDisplayName.validate.js` class for class. For any reject branch, a business gate included, name one legitimate submission it blocks, and if you can, it is a finding.
Trigger: an ASCII-only letter class on a name or free-text field, `staffDisplayName.validate.js`, `preferredName.js`, a form's submit gate, a ValidationError message. Defects: D0091, D0100, D0150, D0151. Names: access-egress.route-paths

**ACC-17 Size every limit against the heaviest legitimate key.** For each limiter mount, compute requests per window for the heaviest legitimate client of one key, an autosave interval times the window, a poll, a page firing N fetches on load, a crowd behind one NAT on a printed QR, a mail proxy fetching every image, and if that is within twice the max, the limit is wrong. The 20-per-15-minute public limiter is for writes a human performs a few times, and reads go on the public read limiter or a per-token limiter.
Trigger: a `rateLimit` definition or mount, a client interval, autosave or poll change, a new public GET, a new asset route referenced from an email. Defects: D1333, D1335, D1339, D1355. Names: access-egress.rate-limit

**ACC-18 A billed external action carries three bounds.** Every Dial and calls create carries a time limit, every inbound or triggered voice route has a DB-backed or per-minute cap mounted after the Twilio signature check, and the caller ID comes from the voice or consult caller-ID env, never the inbound From. Every call or SMS target passes `toUsE164` with its non-US and blocked area-code denylists, never a bare `normalizePhone`.
Trigger: a Dial, `calls.create`, `messages.create`, a caller ID, a new TwiML route, a new cap env variable, a phone normalizer for a call target in the voice routes, `telegram.js` or a call util. Defects: D1358, D1359, D1361, D1363. Names: access-egress.webhook, access-egress.send, access-egress.rate-limit

**ACC-19 Every sink gets a field list, and every field is justified.** When a diff adds or changes data flowing outside the process, a third-party API, an SMS or email body, Sentry, a backup-covered or screenshot directory, a tool output the owner reads on screen, list the payload's fields and strike every one the recipient does not need: client IP, full street address, gate codes, notes, tokens, a name beside a dollar figure. Your own output is a sink too, so report counts and ids, never matched phone or email values.
Trigger: a fetch or SDK call to an external host, a send body template change, a new directory an agent writes on the box, a Sentry capture with extra. Defects: D1396, D1397, D1406, D1438. Names: access-egress.send, access-egress.logging

**ACC-20 Privilege columns are written only from admin paths.** The onboarding status, the pre-hired flag, the role, the staff and hire capability columns, the onboarding-completed flag and any reviewed-at stamp are written only behind `adminOnly` or derived server-side from an admin action. A self-serve submit that sets any of them, or a PUT that spreads the body into a users UPDATE, is a self-promotion hole whatever the UI sends.
Trigger: a users UPDATE or onboarding-progress insert in a route mounted with auth but not `adminOnly`, a status, role or completed flag read from the body, `routes/payment.js`, `progress.js`, the register route in `auth.js`. Defects: D0057, D0058, D0059. Names: access-egress.auth, access-egress.router

**ACC-21 A webhook verifies first and decides from the secret that verified it.** The signature check of a Stripe, Resend, Cal.com, Thumbtack, Twilio or Telegram webhook is the first middleware, ahead of any rate limiter or DB read, so an unsigned flood cannot spend either, and a failed signature rejects and is logged loudly. Mode and account come from which secret verified the signature, never a body field such as livemode, and any id named in metadata is checked to belong to the entity the event is about before money is linked to it.
Trigger: `stripeWebhook.js`, `calcom.js`, `thumbtack.js`, `emailMarketingWebhook.js`, the inbound SMS route, the voice routes, `telegram.js`, a metadata read in a webhook, a limiter on a webhook route. Defects: D0069, D0070, D0073. Names: access-egress.webhook

**ACC-22 Provider and database errors are stored as descriptors.** A catch that writes `err.message` into a detail, error or note column, or hands it to Sentry or a Render-visible log, is a finding unless the message is first reduced to a code, class, HTTP status and request id, the `describeError` pattern in the OpenAI and Gemini clients. A pg error detail quotes the row, a Twilio message embeds the dialed number, and the Sentry scrub hook cleans URLs and bodies, not message text.
Trigger: `err.message` in an INSERT or UPDATE parameter, Sentry extras or a logged error, a new attempts-detail or status-detail column. Defects: D1432, D1436, D1440. Names: access-egress.logging

**ACC-23 A device cache stores the minimal projection.** The `admin-sw.js` allowlist is exact paths, since a bare proposals prefix sweeps in the public, token and group routes, and the worker checks the response body's keys before storing so deploy skew or a rollback cannot cache the full payload. A cached projection never includes access notes and gate codes, the client email, admin notes or plan tokens.
Trigger: the allowlist or `isAllowlisted` in `admin-sw.js`, a new offline-ok caller, a route the phone caches, a localStorage or IndexedDB write of an API payload. Defects: D1399, D1401, D1404. Names: access-egress.response

**ACC-24 Inbox visibility is judged once, at arrival.** A mail's personal flag is stored at arrival and never recomputed, an unclear To or Cc shape is private, and a known sender is judged by when the email was set on the record relative to the mail's time, not by row creation. A backfill or a later client creation then never turns personal mail into business mail every admin sees.
Trigger: `personalMail.js`, `readGmail.js`, `people.js`, `gmailRules.js`, a query joining clients, leads or users by email inside the sync. Defects: D1454, D1455, D1456. Names: floor

**ACC-25 Widening a validator triggers a consumer audit.** After a validator widens, grep every consumer of that field for code-unit indexing, first-character reads, a slice from one, substr or length-based splits for initials and avatars, and replace them with `Array.from` or `Intl.Segmenter`. Check the font registration in `paystubPdf.js` and any canvas or image render for glyph coverage of the newly admitted scripts.
Trigger: a widened character class, a first-character or slice read on a name, preferred name or display name, a font choice in a PDF or image generator. Defects: D0098, D0101, D0145. Names: floor

**ACC-26 A bearer secret or bank number is hashed or encrypted at rest.** Reset tokens, magic links and device secrets are generated with cryptographic randomness and stored through a token hash column and compared by hash, single-use with a short TTL, and bank routing and account numbers go through `encryption.js`. A plaintext UUID in a column that a DB, log or backup leak would turn into a login is the finding.
Trigger: a new column named for a token, secret, account number or routing, a stored random UUID later compared with equality on an auth path, the reset route in `auth.js`, `staffPortal/paymentMethods.js`. Defects: D0033, D1443. Names: access-egress.auth

**ACC-27 At a format boundary, escape exactly once.** CSV cells beginning with equals, plus, minus, at, tab or CR are prefixed or quoted against formula injection, iCal text goes through `escapeICalText` from raw input, TwiML attributes through `xmlEscape`, and HTML through DOMPurify. A manual escape followed by a library escape, or a library escape on already-escaped text, is the finding.
Trigger: a new export, feed or template that emits CSV, ICS, XML or HTML, a newline join ahead of an escaper, a CSV attachment or a client CSV Blob. Defects: D0107, D0110. Names: access-egress.export

**ACC-28 A money action never shares a bucket with browsing.** Pay, the Stripe key fetch, create-intent and tip sit on their own limiter, and compare, options, add-ons and page loads cannot spend that budget. Where a UUID token exists the key is the route's token, as the drink-plan write, options quote and proposal checkout limiters do, with the per-IP limiter as a separate outer cap so one NAT cannot lock out one client.
Trigger: a new route on a router that already mounts a limiter, a limiter without a key generator on a token route, mounts in `compareGroup.js`, `stripe.js`, `publicTip.js`. Defects: D1334, D1336. Names: access-egress.rate-limit

**ACC-29 A token route takes a UUID, and a link carries the token of its own row.** A public route takes a UUID token through `requireUuidToken`, never a sequential id, and the token in a link comes from the row the link is about with its kind matching the surface: a proposal link carries the proposal token, a plan link the drink plan's own token, an invoice link the invoice token. A post-payment redirect reads the proposal row's token, never a token from the request of whoever issued it.
Trigger: a token from the query or body used to build a redirect or link, a nudge or reminder building a plan or proposal URL, a join selecting one token column from two tables that both have one, a new public route. Defects: D0080, D1384. Names: access-egress.public-token, access-egress.send

**ACC-30 An upload is validated by its bytes, and the stored type comes from them.** An upload is validated by magic bytes through `fileValidation.js` under the size limit, never by extension or client MIME alone. The type identified from the bytes is what `storage.js` passes to R2 and what the DB stores, so a file name extension, the client MIME or a caller-supplied type reaching the put is the finding.
Trigger: `storage.js`, `fileValidation.js`, an upload route passing a content type, a new upload field. Defects: D0152. Names: access-egress.router, access-egress.route-paths

**ACC-31 A typed or scraped contact handle gets typo and duplicate detection.** A capture path that takes an email or phone typed by staff or harvested from a page runs `checkEmailDomain` for TLD and provider typos and looks up an existing row on the normalized handle before inserting. A suspicious result surfaces to the operator rather than silently creating a second client.
Trigger: a new client or lead insert from an admin form, an import or the Thumbtack capture, an email field without `checkEmailDomain` in the same handler. Defects: D0155. Names: access-egress.router

**ACC-32 An operator-triggered send carries a per-target throttle.** A button that emails or texts a client, applicant or staffer checks an event row before sending, the reminder-sent lookback in `admin/applications.js` is the pattern, and writes the row after a successful send. A notify helper invoked from a route handler without a lookback is the finding.
Trigger: an admin route calling `sendEmail` or `sendSMS` on a button press, a notify helper called from a handler without a lookback query. Defects: D1337. Names: access-egress.send

**ACC-33 A new send path states its daily volume against the vendor cap.** A new email or SMS path estimates its sends per day and adds them to the current consumers of the Resend daily cap, proposals, invoices, login codes, lead alerts, lifecycle touches and campaigns. It routes through `emailQuotaDefer.js` so a capped day delays rather than drops, and login codes and payment mail keep priority or their own budget.
Trigger: a new send call site, scheduler or campaign, a change to the daily-cap handling. Defects: D1332. Names: access-egress.send

**ACC-34 Admin actions and payment events leave an attributable record.** An admin action on a client, proposal, invoice, payout or user is logged with the acting `req.user.id`, and a charge, refund, failed webhook signature or payment state change writes a durable event row or a Sentry event carrying its id. A money or account action that leaves no attributable record is the finding.
Trigger: a new admin mutation route, a payment or refund handler, a webhook signature path. Defects: none in the record; kept by lens audit section 7. Names: access-egress.logging, access-egress.webhook

## Output

Findings first. Each takes an id of severity letter and number, H for wrong money, the wrong person, lost work or an exposure, M for a broken surface or a wrong state a person will notice, L for the rest, and one line:

- H1 `server/routes/example.js:120` The defect in one sentence. Failure path: the input and the steps that make it bite. Check: ACC-1.

Then the verdict table, the last thing in the report, one row per file in the brief's Files list. The verdict is exactly one of pass, finding, not reached, escalate, and the note names the finding ids or the reason. Use escalate when you see money, auth or PII material outside the review's tier.

| file | verdict | note |
|---|---|---|
| server/utils/example.js | pass | |
| server/routes/example.js | finding | H1, M2 |
| client/src/example.js | not reached | budget |
| server/utils/other.js | escalate | writes payout rows |

Budget: finish within roughly the N tool calls the brief's Budget section names and end with your verdict table; if you run out, cut breadth and say what you did not reach.

Print no real person's phone number; fixtures and the business lines are fine; refer to people by role.

Write nothing after the table.
