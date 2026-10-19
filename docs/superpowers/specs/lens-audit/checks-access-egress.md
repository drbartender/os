# Lens audit synthesis: auth-scope, pii-leak, input-security, abuse-limits, comms-routing

Input: 136 defects (auth-scope 54, pii-leak 40, input-security 12, abuse-limits 12, comms-routing 18). Every id below is placed in exactly one primary check, a cross-class check, or the class's "Not anticipable" line.

Lens names used: `security-review`, `consistency-check`, `code-review` (existing, in `/home/drbartender/projects/os/.claude/agents/`), and three NEW lenses: `data-egress`, `abuse-limits`, `comms-routing`. Why three new ones: the current `security-review` is organized by OWASP category and is server-centric; 70 of these 136 defects are about data leaving the system (to a sink, a third party, an AI, a backup, the public repo), about limits sized wrong, or about a message or link landing in the wrong place. None of those has a home in the six lenses, and the record itself says so repeatedly ("no taxonomy key covers rate limiting", "no key covers wrong link targets").

## How these checks relate to the current security-review lens

The parent asked which checks are additions and which replace a vaguer existing line. The table is the authority; each check also carries the verdict inline.

| Existing security-review line | Verdict | Replaced or extended by |
|---|---|---|
| A01 "Verify admin routes check `req.user.role === 'admin'` or `'manager'`" | REPLACE (it produces over-strict guards as often as loose ones) | A1, A3 |
| A01 "Check for IDOR: endpoints accepting IDs must verify ownership via `req.user.id`" | REPLACE | A9 (relationship row, not owner id), A7 (public forms have no `req.user`) |
| A01 "Public token routes must use UUID tokens" | KEEP, EXTEND | A8 (what the token route returns) |
| A04 "Sensitive fields (`password_hash`, reset tokens, webhook secrets, keys) never returned in API responses, inspect SELECT columns" | REPLACE (list is secrets-only; the record is business-hidden fields and role-tiered PII) | A8, P6 |
| A06 "Payment amounts validated server-side; client-sent totals are ignored" | EXTEND | A6 |
| A06 "Rate limiting on auth endpoints" | MOVE | abuse-limits L1, L2 |
| A06 / A08 "File upload type validated via magic bytes (`fileValidation.js`)" | EXTEND | I4 |
| A07 "Password reset tokens: single-use, short TTL, cryptographically random" | REPLACE (says nothing about at-rest form) | A12 |
| A07 "Session invalidation on password change / logout where applicable" | EXTEND (client side had zero coverage) | A10 |
| A08 "Stripe / Resend / Thumbtack webhook signature verification present" | REPLACE (presence is not placement or trust derivation) | A11 |
| A08 "Server-side validation for ALL form inputs (type, length, format)" | REPLACE (every validation defect in the record is over-strictness, not absence) | I1 |
| A05 "User-generated content escaped at render time" | EXTEND | I3 |
| A09 "PII not logged in plaintext (emails OK; passwords, tokens, full card numbers never)" | REPLACE (the "emails OK" clause is contradicted by 13 defects) | data-egress P1, P2 |
| A09 "Errors logged with enough context (request path, user, stack)" | QUALIFY (it pushes toward storing raw `err.message`) | P2 |
| Quick-scan "Endpoints accepting `:id` params without a `req.user.id` filter" | REPLACE | A9 |

Additions with no existing counterpart: A2, A4, A5, A7, A10, P3, P4, P5, P7, I2, I5, L3, L4, L5, C1 to C5.

---

## auth-scope (54 defects)

**Shape.** The guard that is present is the wrong guard for the decision, in both directions: five endpoints rejected managers who share the admin dashboard (a Sentry SERVER-R regression driver), five admitted managers to admin-only money and PII surfaces, and the client route, the nav item, and the action control each drifted from the server guard independently. A second family is the `role = 'staff'` literal, which silently excludes managers who work shifts (decision W1) and once named a role that does not exist. The largest single mechanism is not an IDOR at all: ten defects are unauthenticated public forms (quote wizard, /sms opt-in, Cal.com) resolving a stranger's client row by email, phone, or name and then writing onto it (phone, email, consent, opt-out) or creating a shadow row that later wins "newest row" resolution. The existing IDOR check, keyed on `req.user.id`, cannot see any of them because there is no `req.user`. Three self-promotion holes (onboarding status written from self-serve submits) were live for months. The client-side session state machine (purge law, lock enrollment, offline identity, JWT origin, host-aware home path) had six defects and no lens looking at it.

1. **Guard matches the decision, not a default.** For every route whose guard is added or changed, write down the decision (admin-only, admin-or-manager, capability flag `can_staff` / `can_hire`, onboarded staff) and confirm the guard is exactly that: `adminOnly` for admin-only, `requireAdminOrManager` for shared-dashboard surfaces, a `can_*` column check where the decision is a capability, and when the target is a `users` row compare the target's role too (a manager must not edit an admin's row). Too strict is a finding (a manager polling a shared dashboard gets 403s) exactly as too loose is.
   Trigger: any diff adding or changing `adminOnly`, `requireAdminOrManager`, `requireOnboarded`, `req.user.role` comparisons, or a `can_*` read in `server/routes/**`; any new router file under `server/routes/admin/`; any bulk mount (`router.use(auth, adminOnly)`).
   Lens: security-review. REPLACES A01 "Verify admin routes check role === admin or manager".
   Defects caught: D0025, D0026, D0027, D0028, D0030, D0065 (6).
   Row-truth: no.

2. **Client route, nav item, action control, and server guard agree four ways.** When a server guard is admin-only, the `App.js` route must be `<ProtectedRoute adminStrict>`, the `nav.js` item must carry `adminOnly: true`, and any button whose API is that route must not render for managers; when the server admits managers, none of the three may be stricter. Read the comment at `client/src/App.js:312` (adminOnly admits managers, adminStrict rejects them) before judging.
   Trigger: any diff touching `client/src/App.js` route elements, `client/src/components/adminos/nav.js`, a component that renders an admin-only action (refund form, tip page edit), or a server guard change under `server/routes/admin/**` (check the client side of the same endpoint).
   Lens: consistency-check. ADDITION (cross-layer; security-review owns the guard choice in A1).
   Defects caught: D0006, D0008, D0015, D0026 (4).

3. **Role literals: a `role = 'staff'` filter is a bug unless the decision excludes working managers.** Every SQL or JS predicate on `users.role` must be checked against the enum (`staff`, `admin`, `manager`, nothing else) and against decision W1: staffing targets (assignable, broadcastable, acknowledging, payable) are selected by relationship or capability (`can_staff`, an approved shift, a payee row), never by `role = 'staff'`. A guard that narrows a payee set must be diffed against the actual payee list before it ships.
   Trigger: any diff containing `role = 'staff'`, `role IN (`, `role === 'staff'`, `role !== 'staff'`, or a role string not in the enum; any recipient query in `server/utils/*Broadcast*.js`, `autoAssign.js`, `beo*.js`, `shifts.js`; any import or payroll script with a role guard.
   Lens: security-review. ADDITION.
   Defects caught: D0036, D0064, D0072, D0075, D0079 (5).
   Row-truth: D0075 blocked a $13k payee; read the payroll rate-seeding rule before touching an import guard.

4. **Account status is checked per account, as the full trio, at every resolution point.** Anywhere a user is resolved and then acted on (JWT in `auth.js`, an inbound SMS sender in `smsInbound.js`, a recipient list in `messages.js`, a harvester guard, a staff-data read) the exclusion must cover all three of `deactivated`, `rejected`, `suspended` for every role but admin, and staff-data surfaces must also pass `requireOnboarded` (allowed: `submitted`, `reviewed`, `approved`). A path that lists two of the three, or applies the trio only when `role = 'staff'`, is the finding.
   Trigger: any diff with `onboarding_status` in a WHERE or IF, any new `SELECT ... FROM users WHERE phone|email|id`, any new recipient fetch, any new mount that reaches staff data without `requireOnboarded`.
   Lens: security-review. ADDITION.
   Defects caught: D0024, D0055, D0087, D0088 (4; D0088's status half).

5. **Privilege columns are written only from admin paths.** `users.onboarding_status`, `pre_hired`, `role`, `can_staff`, `can_hire`, `onboarding_progress.onboarding_completed`, and any `*_reviewed_at` stamp may be written only behind `adminOnly` or derived server-side from an admin action. A self-serve submit (paperwork, payment, progress step) that sets any of them, or a `PUT` that spreads `req.body` into an `UPDATE users`, is a self-promotion hole regardless of what the UI sends.
   Trigger: any `UPDATE users SET` or `INSERT INTO onboarding_progress` in a route mounted with `auth` but not `adminOnly`; any `req.body.onboarding_completed`, `req.body.status`, `req.body.role`; `server/routes/payment.js`, `progress.js`, `auth.js` register.
   Lens: security-review. ADDITION.
   Defects caught: D0057, D0058, D0059 (3).

6. **A public write accepts only what the page offered, treats absent and empty differently on purpose, and never reaches a contract row.** On any token-gated or unauthenticated upsert: (a) the accepted key set is computed from the offered surface (event shelf plus the submitted drinks' dossier slugs, intersected with active), never from the catalog (`SELECT slug FROM service_addons WHERE is_active`); (b) an explicit `[]` or `{}` must be classified as "clear" or "no opinion" in a comment, with `!== undefined` guards matching that choice; (c) the write must not `DELETE` or `ON CONFLICT DO UPDATE` a row an admin negotiated (`proposal_addons` quantity, contract syrups), and the collision guard must read `proposal_addons`, not only `drink_plans` selections.
   Trigger: any diff in `server/routes/drinkPlans/lab.js`, `submit.js`, `proposals/public.js`, `smsOptIn.js`, `calcom.js`, or any route whose first middleware is `requireUuidToken` and which contains `INSERT ... ON CONFLICT`, `DELETE FROM`, or a loop over `req.body` keys.
   Lens: security-review. EXTENDS A06 "client-sent totals are ignored" from totals to every client-sent key.
   Defects caught: D0047, D0048, D0049, D0050, D0114 (5).
   Row-truth: yes. `proposal_addons` is the contract row; `total_price` is derived from it; read the addon-quantity trap (`storedToInputCount`) and the hosted-ratio rule before judging an add-on write.

7. **An unauthenticated submission never resolves a stranger's row and writes onto it, never creates a second row for a handle, and never establishes consent or opt-out for a handle it has not proven.** For every call to `findOrCreateClient` / `findOrCreateClientDetailed`, `recordSmsConsent`, any `COALESCE(email|phone, $n)` UPDATE on `clients`, and any name-only dedup: ask who proves ownership of the matched row. An email match proves nothing about the submitter's phone; a phone+name match proves nothing about the email; a name alone proves nothing. The only permitted backfill is the trusted-source path (`trustedPhoneMatch`, Thumbtack); public callers pass neither. A path that can mint a row for a number that already has a row (a shadow row) is a routing bug too, because `lookupSender` takes the newest row (see C5).
   Trigger: any diff in `server/utils/clientDedup.js`, `smsConsent.js`, `smsOptIn.js`, `proposals/public.js`, `calcom.js`, `thumbtack*.js`; any new public route that takes name, email, or phone.
   Lens: security-review. ADDITION (the IDOR line cannot see a request with no `req.user`).
   Defects caught: D0038, D0062, D0066, D0067, D0068, D0076, D0077, D0084, D0085, D0086 (10).

8. **Every outward projection is an explicit allowlist, and the allowlist is tiered by who is reading.** A row leaving the server to a public token response, a self-profile, a manager-visible detail, an invoice line, or a cached phone payload goes through a named projection (`publicPriceView` / `sanitizeSnapshotForPublic` in `server/utils/publicSnapshot.js`, the `day_of_contact` subset, a column list) that drops `visible: false` adjustments, `total_price_override`, `*_reviewed_at` stamps, street address and coordinates for non-admins, and the client phone. A `SELECT *`, a `...row` spread into `res.json`, or "hidden in the DOM" is the finding.
   Trigger: any `res.json` on a route under `/t/:token`, `/public`, `/api/me`, `/api/contractor`, `/api/admin/users/:id`; any diff in `server/utils/invoiceLineItems.js`, `publicSnapshot.js`, `proposals/publicToken.js`; any new column added to a table those routes read.
   Lens: security-review. REPLACES A04 "Sensitive fields never returned, inspect SELECT columns".
   Defects caught: D0031, D0044, D0063, D0081, D1421, D1429 (6).
   Row-truth: yes. Hidden adjustments and labels: an adjustment's `visible` flag and the off-ledger label set (`OFF_LEDGER_INVOICE_LABELS`) decide what a client may see; read that rule before judging an invoice or snapshot projection.

9. **Authorize off the current relationship row, never a parent-wide flag, a historical request, or a guess.** When an action targets a child (a shift, a BEO, a request), the server must look up the viewer's relationship to that exact child (an approved, not-dropped assignment on that `shift_id`), not `is_assigned` on the proposal, not an `approved` request that was since emergency-dropped, not `role` as a proxy for "admin view". A resolver that falls back to "nearest" or "any" when the id is missing or the phone is shared must refuse, not guess.
   Trigger: any client `viewerState` / `canAct` derived from a parent object; any server lookup of `shift_requests.status = 'approved'` used to authorize; any `is_admin` decided by `role` on a staffed surface; any inbound-reply resolver (`smsInbound.js`) without a `shift_id` match.
   Lens: security-review. REPLACES A01 IDOR "verify ownership via req.user.id" and the matching quick-scan line.
   Defects caught: D0017, D0035, D0037, D0088 (4; D0088's shift-match half).

10. **The client session state machine: every 401/403 carries a code, every purge is deliberate, no cached identity outlives the token, and the JWT lives on the origin that will consume it.** Check four things in any auth-state diff: (a) the server error envelope carries a code and the client classifies revocation vs expiry vs lock by that code, never by which endpoint failed (`api.js` dispatches `session-expired` with `data.code`; `authFailureAction` in `AuthContext.js` is the four-way purge law); (b) any path that calls logout or clears storage also clears `ENROLLED_KEY`, and if so the next login re-arms the lock or the change is rejected; (c) `/auth/me` is never served from cache to build an identity (`IDENTITY_PATH` in `admin-sw.js`), so an offline launch with no lock armed cannot render an admin session; (d) a cross-host kick stores the JWT on the destination origin, and `getHomePath` in `client/src/utils/userRoutes.js` checks the host before choosing a path (see C3 for generic route targets).
    Trigger: any diff in `client/src/context/AuthContext.js`, `components/SessionExpiryHandler.js`, `components/mobile/MobileLockScreen.js`, `utils/api.js` 401 handling, `utils/userRoutes.js`, `utils/webauthnClient.js`, `client/public/admin-sw.js` identity path, or any `localStorage.setItem` of a token.
    Lens: security-review. ADDITION (a client-side section; the lens today is server-only). If the fleet wants fewer agents this is the one check that could instead be its own small lens.
    Defects caught: D0010, D0011, D0012, D0019, D0020, D0021 (6).

11. **A webhook decides from the secret that verified it, checks cross-entity ownership, and validates the signature before anything else runs.** (a) Mode and account decisions (test vs live) come from which secret verified the signature (`verifiedByTestSecret`), never from a body field like `event.livemode`; (b) any id named in metadata (invoice id, proposal id, lead id) is checked to belong to the entity the event is about before money is linked to it; (c) `isValidTwilioRequest` / `constructEvent` / the HMAC check is the first middleware, ahead of any rate limiter or DB read, so an unsigned flood cannot spend the limiter or the DB.
    Trigger: any diff in `server/routes/stripeWebhook.js`, `calcom.js`, `thumbtack.js`, `emailMarketingWebhook.js`, `sms.js` inbound, `voice*.js`, `telegram.js`; any `metadata.` read in a webhook; any limiter mounted on a webhook route.
    Lens: security-review. REPLACES A08 "webhook signature verification present".
    Defects caught: D0069, D0070, D0073 (3).
    Row-truth: yes. A credited payment writes the payment record and `acknowledged_total`; read the acknowledged-total row-truth rule and the ACH-in-flight note before judging a webhook branch.

12. **A bearer secret or bank number the database holds is hashed or encrypted at rest, and compared by hash.** Reset tokens, magic links, device secrets go through a `token_hash` column (the pattern exists at `schema.sql` line ~3900) and are compared by hash; bank routing and account numbers go through `server/utils/encryption.js`. A plaintext UUID in a column that a DB, log, or backup leak would turn into a login is the finding.
    Trigger: any new column named `*token*`, `*secret*`, `*account_number*`, `routing*`; any `gen_random_uuid()` stored and later compared with `=` on an auth path; any diff in `server/routes/auth.js` reset or `staffPortal/paymentMethods.js`.
    Lens: security-review. REPLACES A07 "reset tokens single-use, short TTL, random" (adds the at-rest form).
    Defects caught: D0033, D1443 (2). Earns its place: both are account-takeover or bank-PII class, both audit-found, and the hashed-token pattern already exists so the check is a grep.

Caught by another class's check: D0080 (nudge linked with the proposal token instead of the drink-plan token) is C2.

Not anticipable: D0090 (a fired staffer left `hired` with `pre_hired` set; an operations data state with no diff behind it, fixed by a manual offboarding).

---

## pii-leak (40 defects)

**Shape.** Nothing here is a classic log-the-password leak. The record is data crossing a boundary nobody inventoried: a third-party IP lookup, a venue address in an SMS body that Twilio keeps, a diag directory inside the nightly backup, a raw provider `err.message` stored in a detail column or handed to Sentry (pg quotes the row, Twilio embeds the To number), ten adversarial shapes that walk past a regex scrubber before text goes to Anthropic, nine commits or fixtures that put names, pay figures, or a real-format phone into the public repo (history is not rewritten by policy, so each one is permanent), a service-worker allowlist that would have cached gate codes on the phone, and client-facing templates printing internal notes or the admin hotline. The current lens says "emails OK" in logs; this record says the opposite.

1. **Every sink gets a field list, and every field on it is justified.** When a diff adds or changes data flowing to anything outside the process (a third-party API, an SMS or email body, a Twilio or Resend log by implication, Sentry, a backup-covered directory, a screenshot directory, a tool output the owner reads on screen), list the fields in the payload and strike every one the recipient does not need: client IP, full street address, gate codes, notes, tokens, names beside dollar figures. A reviewer's own output is a sink: report counts and ids, never matched phone or email values.
   Trigger: any new `fetch`/SDK call to an external host; any `sendSMS`/`sendEmail` body template change; any new directory written by an agent on the box (check `~/.config/restic/excludes.txt` covers it); any Sentry `captureException` with `extra`.
   Lens: NEW `data-egress`. REPLACES security-review A09 "PII not logged in plaintext (emails OK ...)".
   Defects caught: D1396, D1397, D1406, D1438 (4).

2. **Provider and database errors are stored and reported as descriptors, never as `err.message`.** A catch that writes `err.message` into a `detail`, `error`, or `note` column, or passes it to Sentry, is a finding unless the message is first reduced to a code, class, HTTP status, and request id (`describeError` in `server/utils/openaiClient.js` and `geminiClient.js` is the pattern). pg error `detail` quotes the row; Twilio messages embed the dialed number; the `scrubErrorEvent` hook in `sentryScrub.js` scrubs URLs and request bodies, not message text.
   Trigger: any `err.message` on the right-hand side of an INSERT/UPDATE parameter, in `Sentry.capture*` extras, or in a `console.error` that reaches Render logs; any new `*_attempts.detail` or `status_detail` column.
   Lens: NEW `data-egress`. QUALIFIES security-review A09 "errors logged with enough context".
   Defects caught: D1432, D1436, D1440 (3).

3. **A regex scrubber is tested against the adversarial fixture set before text reaches a model, and fails closed on an unrecognized shape.** Any diff to `server/utils/inbox/aiRedact.js`, `readJob.js`, `sentryScrub.js`, or any new text path into `anthropicClient.js` / `openaiClient.js` / `geminiClient.js` must run the fixture set and show each is dropped: non-ASCII email local parts; digits joined by `/`, `_`, `,`, or `". "`; fullwidth digits; spelled-out numbers and street addresses; bare UUIDs (proposal and plan tokens); a bare host with a query string; titled and family-style names; "Last, First" stored names; surnames typed without accents. A shape the scrubber cannot classify drops the line rather than passing it.
   Trigger: any diff in `server/utils/inbox/aiRedact.js` or its test, any new caller of `redact(`, any new model call site, any new regex with `[A-Za-z]` or `\d` on free text.
   Lens: NEW `data-egress`. ADDITION (no lens mentions an AI read).
   Defects caught: D1444, D1445, D1446, D1447, D1448, D1449, D1450, D1451, D1452, D1453 (10).

4. **The public repo carries ids only: no client or contractor name, no real-format phone, no name beside a dollar figure, in docs, commit messages, fixtures, comments, schema literals, or env docs.** Grep the staged diff and the commit message for E.164 and 10-digit runs, email addresses, and capitalized name pairs adjacent to `$`; fixtures use reserved 555 numbers; the ledger uses proposal, client, and user ids. Run this before the commit, because history is not rewritten by policy and two of these were caught only at the push sweep after the commit existed.
   Trigger: any diff under `docs/`, `*.test.js`, `server/db/schema.sql` literals, `scripts/sensitive-paths.txt` comments, `CLAUDE.md`, `README.md`, code comments; every commit message.
   Lens: NEW `data-egress`, plus a mechanical grep in `scripts/push-gate.js` (the push-time sweep already exists; this moves it to commit time).
   Defects caught: D1409, D1410, D1412, D1413, D1414, D1415, D1437, D1439, D1458 (9).

5. **A device or offline cache stores the minimal projection, matched by exact path and verified by body shape.** The `admin-sw.js` allowlist is exact paths (a bare `/api/proposals` prefix sweeps in `/api/proposals/public|t|group`); the SW checks the response body's keys before storing so deploy skew or a rollback cannot cache the full payload; the cached projection never includes `accessNotes` (gate codes), client email, admin notes, or plan tokens.
   Trigger: any diff in `client/public/admin-sw.js` allowlist or `isAllowlisted`, any new `X-Offline-Ok` caller (`offlineGet`), any route whose response the phone caches, any `localStorage`/IndexedDB write of an API payload.
   Lens: NEW `data-egress`. ADDITION.
   Defects caught: D1399, D1401, D1404 (3). Earns its place: Checkpoint A was a blocking design finding and D1401 is open.

6. **Client-facing templates and public GETs print only client-facing fields: no internal notes, no admin hotline, no staff PII.** Every email, SMS, recap, nudge, public shopping list, public tip page, and public token GET is checked field by field: `notes` / `admin_notes` / consult notes print only on staff surfaces that opt in; the phone number printed to a client is `COMPANY_PHONE` / `COMPANY_TEXT_PHONE` from `server/utils/companyPhone.js`, never `ADMIN_PHONE`; the client's own phone and staff addresses do not appear on public responses. This is check A8 applied to templates instead of API projections; the rewritten agent can hold them as one rule with two triggers.
   Trigger: any diff in `server/utils/*Templates.js`, `consultRecap.js`, `drinkPlanNudge.js`, `drinkPlans/shoppingList.js` public GET, `publicTip.js`, `contractorTipPage.js`; any `ADMIN_PHONE` or `notes` reference in a template.
   Lens: NEW `data-egress`. REPLACES (with A8) security-review A04 "sensitive fields never returned".
   Defects caught: D1421, D1426, D1429, D1441, D1442 (5).

7. **Inbox visibility is judged once, at arrival, from the state at that time, and defaults to private.** In `server/utils/inbox/personalMail.js`, `readGmail.js`, `people.js`: a mail's personal flag is stored at arrival and never recomputed; an unclear To/Cc shape is private; "known sender" is judged by when the email was set on the record (not `created_at`) relative to the mail's time, so a backfill or a later client creation cannot turn personal mail into business mail every admin sees.
   Trigger: any diff in `server/utils/inbox/personalMail.js`, `readGmail.js`, `people.js`, `gmailRules.js`; any query that joins `clients`/`leads`/`users` by email inside the sync.
   Lens: NEW `data-egress`. ADDITION.
   Defects caught: D1454, D1455, D1456 (3).

Caught by another class's check: D1405 (the phone's Text action sends from the owner's personal device) is C4; D1443 (bank numbers plaintext) is A12.

Not anticipable: D1464 (a chat export on the share root; box hygiene with no diff behind it).

---

## input-security (12 defects)

**Shape.** Not one of these is a missing validator. Four are validators that reject real people (ASCII-only name classes, NFD accents, the iOS curly apostrophe, a mocktail-only consult), two are the consequence of widening a validator without auditing its consumers (`charAt(0)` on an astral-plane letter, a PDF font without CJK glyphs), two are escaping done twice or not at all at a format boundary (iCal `\n`, CSV formulas in a 1099 export), one is a content type taken from the filename after the bytes were validated, and one is a hand-typed email with no typo check that sent two weeks of mail to a dead domain. The lens's "validate ALL inputs" line points the wrong way for this record.

1. **A validator on human text admits the real population, normalizes before testing, and its error copy states the actual rule; the client mirror is byte-identical.** Name and display-name rules use `\p{L}` with the `u` flag, call `.normalize('NFC')` first, map U+2019 to `'`, and the rejection message names the rule as written. `client/src/utils/preferredName.js` must match `server/utils/staffDisplayName.validate.js` character class for character class. For any reject branch (including business gates like a flag coupling), name one legitimate submission it blocks; if you can, it is a finding.
   Trigger: any regex containing `[A-Za-z` applied to a name, note, or free-text field; any diff in `staffDisplayName.validate.js`, `preferredName.js`, a form's `canSubmit` gate; any `ValidationError` message.
   Lens: security-review. REPLACES A08 "server-side validation for ALL form inputs (type, length, format)".
   Defects caught: D0091, D0100, D0150, D0151 (4).

2. **Widening a validator triggers a consumer audit: no code-unit indexing on the string, and every renderer covers the admitted repertoire.** After any widening, grep every consumer of that field for `charAt(0)`, `[0]`, `.slice(1)`, `.substr`, `.length`-based splits (small-caps, initials, avatars) and replace with `Array.from` or `Intl.Segmenter`; check PDF font registration (`paystubPdf.js`) and any canvas or image render for glyph coverage of the newly admitted scripts.
   Trigger: a diff that widens a character class; any `charAt(0)` / `[0]` / `slice(1)` on a `name`, `preferred_name`, `display_name`; any `registerFont` / font choice in a PDF or image generator.
   Lens: consistency-check. ADDITION ("if you change X, update every consumer", applied to character repertoire).
   Defects caught: D0098, D0101, D0145 (3).

3. **At a format boundary, escape exactly once, with the format's escaper, on raw text.** CSV cells beginning with `=`, `+`, `-`, `@`, tab, or CR are prefixed or quoted (formula injection); iCal text goes through `escapeICalText` from raw input, never pre-joined with a literal `\n`; TwiML attributes go through `xmlEscape`; HTML through DOMPurify. A manual escape followed by a library escape, or a library escape applied to already-escaped text, is the finding.
   Trigger: any new export, feed, or template that emits CSV, ICS, XML/TwiML, or HTML; any `join('\\n')` or `replace(/\n/` ahead of an escaper; any `res.attachment(*.csv)` or client `Blob([...], { type: 'text/csv' })`.
   Lens: security-review. EXTENDS A05 "user-generated content escaped at render time" (adds the CSV and double-escape cases, which it does not list).
   Defects caught: D0107, D0110 (2). Earns its place: D0107 is a money export the owner opens in a spreadsheet (1099 and payout CSV), D0110 was prod-visible in both calendar feeds.
   Row-truth: D0107 exports payout rows; no rule to read, the check is on the cell encoding.

4. **The stored content type comes from the validated bytes, not the filename or the client MIME.** `fileValidation.js` identifies the type by magic bytes; that identified type is what `storage.js` passes as `ContentType` and what the DB stores. `path.extname`, `file.mimetype`, or a caller-supplied type reaching `putObject` is the finding.
   Trigger: any diff in `server/utils/storage.js`, `fileValidation.js`, or any upload route passing `ContentType:`.
   Lens: security-review. EXTENDS A06/A08 "magic-byte validation" (validated is not the same as stored).
   Defects caught: D0152 (1). Earns its place: a mismatched type on a public bucket is a sniffing/stored-script vector, and the fix is one line in a sensitive helper.

5. **A hand-typed or scraped contact handle gets typo and duplicate detection before a row is created.** Any capture path that takes an email or phone typed by staff or harvested from a page runs `checkEmailDomain` from `server/utils/emailValidation.js` (TLD and provider typos, with a suggestion) and looks up an existing row on the normalized handle before inserting; a suspicious result surfaces to the operator rather than silently creating a second client.
   Trigger: any new `INSERT INTO clients` or `leads` from an admin form, an import, or the Thumbtack capture; any email field without `checkEmailDomain` in the same handler.
   Lens: code-review. ADDITION.
   Defects caught: D0155 (1). Earns its place: a prod incident where mail was logged as sent to a dead domain for two weeks, and the helper already exists so the check is a grep.

Caught by another class's check: D0114 (public lab allowlist from the catalog) is A6.

Not anticipable: none.

---

## abuse-limits (12 defects)

**Shape.** Every limiter defect is a limiter that exists and is wrong: sized below the surface's own traffic (a 30-second autosave under 20 per 15 minutes, a printed QR that a venue crowd behind one NAT exhausts after seven guests, mail proxies fetching email images), or scoped so a money action (pay, Stripe key fetch, tip) shares an IP bucket with browsing (compare, options, addons). The toll side had no bounds at all: an unbounded `<Dial>`, no inbound flood cap, caller ID taken from the inbound From (wangiri), and a NANP validator that let Caribbean premium-rate codes through (IRSF). Two capacity defects (Resend's daily cap, an un-throttled reminder button) round it out. The record says four times that no taxonomy key covers this; a lens should.

1. **Size every limit against the heaviest legitimate single key, with margin.** For each limiter mount, compute requests per window for the heaviest legitimate client of one key: an autosave interval times the window, a poll, a page that fires N fetches on load, a crowd behind one NAT on a printed QR, a mail proxy fetching every image in a blast. If that number is within 2x of `max`, the limit is wrong. The 20 per 15 minute `publicLimiter` is for writes that a human performs a few times; reads go on `publicReadLimiter` (100) or a per-token limiter.
   Trigger: any `rateLimit(` definition or mount in `server/middleware/rateLimiters.js` or a route; any client interval change (`setInterval`, autosave, poll); any new public GET; any new asset route referenced from an email.
   Lens: NEW `abuse-limits`. MOVES security-review A06 "rate limiting on auth endpoints" and makes it quantitative.
   Defects caught: D1333, D1335, D1339, D1355 (4).
   Row-truth: D1355 is the public tip page; no money rule to read, the finding is on the key and the budget.

2. **A money action never shares a bucket with browsing, and a token-bearing route is keyed by token.** Pay, Stripe key fetch, create-intent, and tip must sit on their own limiter; compare, options, addons, and page loads must not be able to spend that budget. Where a UUID token exists the key is `req.params.token` (the `keyGenerator` pattern on `drinkPlanWriteLimiter`, `optionsQuoteLimiter`, `proposalCheckoutLimiter`), with the per-IP limiter as a separate outer cap (`publicTokenIpLimiter`), so one NAT cannot lock out one client.
   Trigger: a new route added to a router that already mounts a limiter; any limiter without `keyGenerator` on a `/:token` route; any diff to `compareGroup.js`, `stripe.js`, `publicTip.js` mounts.
   Lens: NEW `abuse-limits`. ADDITION.
   Defects caught: D1334, D1336 (2). Earns its place: D1336 locked a client out of paying; money.
   Row-truth: no rule to read; the check is on bucket identity.

3. **A billed external action carries three bounds: per-call duration, per-window count behind the signature gate, and a destination rule.** Every `<Dial>` and `calls.create` carries `timeLimit` (`timeLimitSec()`); every inbound or triggered voice route has a DB-backed or per-minute cap (`VA_INBOUND_PER_MIN_CAP`, `*_DAILY_CAP`) mounted after `isValidTwilioRequest`; `callerId` is `VOICE_CALLER_ID` / `CONSULT_CALLER_ID` from env, never the inbound From; every call or SMS target passes `toUsE164` (`NON_US_NANP_AREA_CODES` and `BLOCKED_AREA_CODES` denylists), never a bare `normalizePhone`.
   Trigger: any `<Dial`, `calls.create`, `messages.create`, `callerId=`, new TwiML route, new `*_CAP` env var, or phone normalizer used for a call target in `server/routes/voice*.js`, `telegram.js`, `server/utils/*Call*.js`.
   Lens: NEW `abuse-limits`. ADDITION (no lens mentions toll fraud).
   Defects caught: D1358, D1359, D1361, D1363 (4).
   Row-truth: no; these are spend caps, read the env-var table for the current ceilings.

4. **An operator-triggered send to a person carries a per-target throttle recorded in an audit row, send-then-audit.** A button that emails or texts a client, applicant, or staffer checks an event row (`event_type = 'reminder_sent'` within 24h is the pattern in `server/routes/admin/applications.js`) before sending and writes the row after a successful send.
   Trigger: any admin route calling `sendEmail`/`sendSMS` on a button press; any new notify helper invoked from a route handler without a lookback query.
   Lens: NEW `abuse-limits`. ADDITION.
   Defects caught: D1337 (1). Earns its place: duplicate sends burn Resend allowance and deliverability, and the pattern exists so the check is a grep.

5. **A new send path states its daily volume against the vendor cap and degrades by deferring, not failing.** Any new email or SMS path estimates sends per day, adds it to the current consumers of `RESEND_DAILY_CAP` (proposals, invoices, login codes, lead alerts, lifecycle, campaigns), and routes through the quota-defer path (`emailQuotaDefer.js`) so a capped day delays rather than drops; login codes and payment mail must have priority or their own budget.
   Trigger: any new `sendEmail` / `sendSMS` call site, scheduler, or campaign; any change to `RESEND_DAILY_CAP` handling.
   Lens: NEW `abuse-limits`. ADDITION.
   Defects caught: D1332 (1). Earns its place: a prod incident (SERVER-Q/T/W) where login codes and proposal mail failed on capped days; open.

Not anticipable: none.

---

## comms-routing (18 defects)

**Shape.** Thirteen of eighteen are a URL or path built from the wrong base: a client link on the admin origin (`CLIENT_URL`), a staff link on the client origin, a relative `/api/...` stored in a column and served on an origin with no `/api` rewrite, an admin-only `/files/<name>` on an anonymous page, a token lifted from the admin's request instead of the proposal row, a drink-plan nudge carrying the proposal token, and seven navigate or API targets that no longer exist on the host rendering them (pre-cutover `/staff-v2/*`, retired `/admin/events/shift/:id`, `/client/login`, `/apply` on the staff host). The other five are recipient resolution: an email to a snapshot address instead of the live client row, a push fan-out that ignored the `surface` tag (owner's phone treated as a staff device, staff pushes reaching admin subscriptions), a missed-call ping never gated per line, and the phone's Text action sending from the owner's personal number. `server/utils/urls.js` exports exactly one builder (`proposalUrl`); plan, invoice, and shopping-list links are built inline, which is where D1394 lived.

1. **Every link is absolute and built on the origin for its audience.** Client-facing links use `PUBLIC_SITE_URL` (`server/utils/urls.js`; `client/src/utils/constants.js` on the client); staff links use `STAFF_URL`; admin links use `ADMIN_URL` (`CLIENT_URL`); API-served assets referenced from another origin use `API_URL`. A relative `/api/...` or `/files/...` stored in a column or returned to a page on another origin, an admin-only asset route on a public page, or `CLIENT_URL` in a client email is the finding. Add the missing builders (`drinkPlanUrl`, `invoiceUrl`, `shoppingListUrl`) to `urls.js` rather than approving another inline template.
   Trigger: any template literal containing `/proposal/`, `/plan/`, `/invoice/`, `/list/`, `/staff-portal`, `${CLIENT_URL}`, `${PUBLIC_SITE_URL}`; any URL stored into a DB column (`logo_url`, image src); any public response carrying a `/files/` path.
   Lens: NEW `comms-routing`. ADDITION.
   Defects caught: D1372, D1374, D1375, D1381, D1394 (5).

2. **The token in a link comes from the row the link is about, and its kind matches the surface.** A proposal link carries `proposals.token`; a drink-plan link carries the drink plan's own token (`/plan/:token` is the drink-plan token, never the proposal token); an invoice link carries the invoice token; a post-payment redirect reads the proposal row's token, never `req.query.token` from whoever issued the request.
   Trigger: any `req.query.token` / `req.body.token` used to build a redirect or link; any nudge or reminder that builds a `/plan/` or `/proposal/` URL; any join that selects one `token` column from two tables that both have one.
   Lens: NEW `comms-routing`. ADDITION.
   Defects caught: D0080, D1384 (2). Earns its place: D1384 lands a client on a wrong or blank proposal after paying (money, and the `?paid=true` load must never render money); D0080 made every scheduled nudge a dead link, found by the owner.
   Row-truth: D1384 is the post-payment landing; read the `?paid=true`-beats-the-webhook rule.

3. **Every navigate, Link, href, redirect, and API path target exists on the host that renders it; after a route cutover the retired string is grep-zero.** For each target in the diff, confirm the route exists in `client/src/App.js` for the subdomain the component runs on (admin, staff, hiring, public) and each API path is mounted in `server/index.js` (`scripts/route-inventory.js` lists both). Redirect targets in `SessionExpiryHandler.js`, `Login.js`, and `getHomePath` are host-conditional. When a route is removed or renamed, grep the whole client and every server template for the old path and the old API path.
   Trigger: any `navigate(`, `<Link to=`, `href=`, `window.location`, `api.get|post|put|delete('/...')`, `Navigate to=`; any removal or rename of a `<Route path>` or a `router.*` mount; any subdomain-conditional routing change.
   Lens: NEW `comms-routing`. ADDITION (the generic half of A10's host check).
   Defects caught: D1365, D1366, D1367, D1368, D1369, D1370, D1371, D1389 (8).

4. **Recipient, line, and surface are resolved from the live row and filtered by who the message is for.** `to` is the live column (`c.email`, `c.phone` via the client join), not a snapshot column (`dp.client_email`, `proposal.client_email`); every `sendPushToUser` call passes `surface`, every subscription write stamps its surface (`mePush.js` stamps `'admin'`; `staffPortal/notifications.js` stores none for staff), and `subscriptionsOf` is the only filter; per-line behaviors (missed-call ping, voicemail text) are gated by line in the plan and the code; a client-facing SMS sends from a company line (`smsLines.allowedLines`, `defaultLine`), owner alerts go to the 312 GV line, and no phone-surface action opens the device's own SMS app with the owner's personal number.
   Trigger: any `sendEmail` / `sendSMS` / `sendPushToUser` call: trace `to` and `surface` to their source; any new push subscription writer; any `sms:` or `tel:` href on a phone surface; any diff in `voice.js` ping or `notificationChannelResolver.js`.
   Lens: NEW `comms-routing`. ADDITION.
   Defects caught: D1376, D1386, D1387, D1393, D1405 (5).

5. **Opt-out and consent resolve to one row per number, so any path that can create a second row for a number is a routing change.** `lookupSender` takes the newest row for a number; a shadow row created by a public form receives the victim's later STOP while the real row stays SMS-on, and a planted `sms_opt_out_at` blocks a number for good. Any diff that inserts a `clients` row from a phone number, or writes `sms_opt_out_at` / `sms_consent_log` from an unauthenticated request, is reviewed against this rule as well as A7.
   Trigger: any `INSERT INTO clients` reachable without `auth`/`clientAuth`; any write to `sms_opt_out_at`, `sms_consent_log`; any diff in `smsOptOut.js`, `smsInbound.js` sender lookup, `smsConsent.js`.
   Lens: NEW `comms-routing` (shared with security-review A7).
   Defects caught: D0067, D0085, D0086 (3, all also cited under A7; listed here because the consequence is a message landing on the wrong row).

Not anticipable: none.

---

## Totals

- auth-scope: 12 checks (A1 to A12), 1 cross-class, 1 not anticipable.
- pii-leak: 7 checks (P1 to P7), 2 cross-class, 1 not anticipable.
- input-security: 5 checks (I1 to I5), 1 cross-class, 0 not anticipable.
- abuse-limits: 5 checks (L1 to L5), 0 not anticipable.
- comms-routing: 5 checks (C1 to C5), 0 not anticipable.

NEW lenses proposed: `data-egress` (P1 to P7), `abuse-limits` (L1 to L5), `comms-routing` (C1 to C5). Existing lenses receiving checks: security-review (A1, A3 to A12, I1, I3, I4), consistency-check (A2, I2), code-review (I5).
