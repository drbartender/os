# AUTH audit: authentication, sessions, authorization and the access perimeter (os @ 13f2645, 2026-11-05)

**Summary**
- Findings: 3 high, 1 medium, 7 low (11 total); 0 critical. 10 CONFIRMED, 1 PLAUSIBLE.
- Worst: AUTH-01, `GET /api/me/staff-home` sits behind `router.use(auth)` with no `requireOnboarded`, so any account minted by the public `POST /api/auth/register` reads company-wide cover broadcasts (other staffers' email addresses, client names, venues, dates) and the open-shift teaser; the CLAUDE.md invariant names exactly this gate for exactly this reason, and `GET /api/shifts` carries it while its sibling does not.
- Close behind: AUTH-02 (the public quote wizard backfills an attacker-supplied email onto a phone+name-matched email-less client row, after which the OTP login mints a session for that client and the portal lists every proposal token) and AUTH-03 (the calendar feed never consults account status and deactivation never rotates `calendar_token`, so a deactivated manager keeps a 365-day feed of every client's phone, email and balance).
- Posture: strong. JWTs are HS256-family (jsonwebtoken 9), the role is re-read from the row on every request, `token_version` is checked on every request for staff and clients, the device JWT is minted only in `webauthn.js` with single-use DB-backed challenges and an atomic counter claim, every public route runs a UUID shape guard, the R2 proxies pin a prefix, every billed or PII-speaking Twilio route fails closed, and the 512-route inventory (appendix) shows one unguarded staff-data surface (AUTH-01) and no admin route reachable by a manager except by documented design.
- Coverage: all 57 mounted routers were walked (512 routes, chain names captured programmatically); the pure suites for tokens, sentryScrub, fileValidation, r2Proxy, corsOptions and legalHold were run here (65/65 pass); every DB-backed suite is listed under "Could not verify".

---

### AUTH-01 high CONFIRMED — `GET /api/me/staff-home` has no `requireOnboarded`, so a self-registered account reads other staffers' emails and client/venue data
- Category: auth
- Location: `server/routes/staffPortal.js:45` (`router.use(auth)` is the only guard on the router), `server/routes/staffPortal.js:76` (the route adds none), `server/routes/staffPortal.js:134-162` (cover_broadcasts: `u.email AS requester_email`, `requester_preferred_name`, `c.name AS client_name`, `s.location`, `cover_reason`, for every staffer except the caller), `server/routes/staffPortal.js:198-211` (open_shifts_teaser: `client_name`, `location`, `guest_count`), `server/routes/auth.js:51-87` (public register mints a 7d JWT), `server/db/schema.sql:19-20` (defaults `role 'staff'`, `onboarding_status 'in_progress'`), `server/middleware/auth.js:107-115` (`requireOnboarded`, the gate), contrast `server/routes/shifts.js:130` (`GET /shifts` carries it).
- Reachable by: unauthenticated (one public `POST /api/auth/register` away).
- Evidence: `router.use(auth)` at :45 is the whole chain (inventory: `GET /api/me/staff-home use=[auth] chain=[anon]`). The route at :76 runs six queries; three are not scoped to the caller: the cover-broadcast query at :134-162 (`WHERE sr.cover_requested_at IS NOT NULL AND sr.user_id <> $1`, projecting `u.email AS requester_email`), the teaser at :198-211 (`WHERE s.status = 'open'`), and the count at :217-222. `auth` (`server/middleware/auth.js:36-80`) rejects only deactivated/rejected/suspended; the comment on `requireOnboarded` at :99-105 states that `POST /api/auth/register` is public and "every staff-data surface needs it".
- Failure scenario: `POST /api/auth/register {email, password}` → 201 `{token}` for a `role='staff', onboarding_status='in_progress'` row. `GET /api/me/staff-home` with that bearer → 200 with up to 20 `cover_broadcasts` rows (each carrying a real staffer's email address and preferred name, the client's name, the venue and the date) and the two soonest open shifts with client name, venue and guest count. No admin ever reviewed the account.
- Existing tests: `server/routes/staffPortal.test.js` and `staffPortal.staffHome.endInstant.test.js` seed `onboarding_status='approved'` users only; nothing asserts the gate, nothing enshrines the defect.
- Proposed fix: add `requireOnboarded` to the `/staff-home` chain (`router.get('/staff-home', requireOnboarded, ...)`), and for defense in depth to `POST /requests/:shiftId/claim-cover` in `server/routes/staffShiftActions.js:520` (today it is saved only by `contractor_profiles.position` being unset for a self-registered account). No client change: the staff HomePage is already behind `RequirePortal` (`client/src/App.js:359`).
- Verification: DB-backed test in `server/routes/staffPortal.test.js`: an `in_progress` user's `GET /api/me/staff-home` → 403 `PERMISSION_DENIED`; an `approved` user → 200. Grep `router.use(auth)` routers for other company-wide reads (none found; see appendix).

### AUTH-02 high PLAUSIBLE — the public quote wizard backfills the submitter's email onto a phone+name-matched client row, which the OTP login then resolves to that client's portal
- Category: idor
- Location: `server/utils/clientDedup.js:64-96` (phone+name match on `email IS NULL`, then `UPDATE clients SET email = COALESCE(email, $2)` at :93), `server/routes/proposals/public.js:303-305` (the unauthenticated wizard calls it with the submitted name/email/phone), `server/routes/clientAuth.js:30-39` (OTP request resolves the client by `LOWER(email)`), `server/routes/clientAuth.js:85-137` (verify mints `{ id: client.id, role: 'client' }`), `server/routes/clientPortal.js:49-66, 87-92` (home lists the client's proposals with `p.token`), `server/routes/clientPortal.js:123-161` (detail by token AND client_id, with `client_phone`, payments), `server/routes/invoices.js:572-596`, contrast `server/routes/smsOptIn.js:190-215` (same helper, rolled back for exactly this reason).
- Reachable by: unauthenticated.
- Evidence: `findOrCreateClientDetailed` on no email match runs the phone+name match at :77-85 (`RIGHT(REGEXP_REPLACE(phone,'\D','','g'),10) = $1 AND LOWER(name) = LOWER($2) AND (email IS NULL OR ...)`) and at :92-94 writes the submitted email onto the matched row ("the Jim fix"). `public.js:303` passes the wizard's `client_name`, `client_email`, `client_phone` straight in. `smsOptIn.js:195-202` documents the consequence ("let anyone who knows a phone-only client's name and mobile ... attach their own address to that client's row and take over their portal") and rolls back; `public.js` keeps the write because a proposal hangs off it. `clientAuth.js:30-33` then looks the OTP target up by that email, and `clientPortal.js:87-92` returns `p.token` for every proposal of `client_id = req.user.id`.
- Failure scenario: a client row `{name: 'Jane Doe', phone: P, email: NULL}` exists (the Thumbtack webhook creates name+phone rows with no email; `server/routes/thumbtackAgent.js:120-140` queues `email IS NULL` rows for harvesting, so these rows are a known population). Attacker who knows the name and number posts `POST /api/proposals/public/submit {client_name:'Jane Doe', client_phone:P, client_email: the attacker's own address, package_id, guest_count, venue_city, venue_state}`. The row's email becomes the attacker's; a proposal is inserted under the victim's `client_id`. `POST /api/client-auth/request {email: the attacker's own address}` emails the OTP to the attacker; `/verify` mints a JWT for the victim's client id. `GET /api/client-portal/home` lists the victim's proposals and tokens; `GET /api/client-portal/proposals/:token` returns phone, venue, pricing and payments; change requests can be filed; and every later lifecycle email for the victim's bookings (invoice, balance reminder, BEO, planner nudge) is now addressed to the attacker, since `clients.email` is the recipient. The one unverifiable step here is DB state: whether email-less rows with guessable names exist in prod (the code comments say they do).
- Existing tests: `server/utils/clientDedup.test.js:10-20` asserts "email backfilled onto the phone-only row" (enshrines the write); `:55` pins only the reverse direction (email match must not backfill phone).
- Proposed fix: on unauthenticated callers never mutate a matched row. Add an option to `findOrCreateClientDetailed` (e.g. `{ backfillEmail: false }`) that `public.js:303` passes, so the phone+name match resolves the id without the UPDATE (the proposal still attaches; an admin merges later), or defer the backfill until the address is proven (the first successful OTP, or an admin action). Consumers to update in the same change: `public.js`, `smsOptIn.js` (already rolls back; can drop its workaround), `clientDedup.test.js:10-20`, the Thumbtack trusted path (unchanged, it passes no email).
- Verification: `clientDedup.test.js`: a website-source phone+name match against an email-less row leaves `email` NULL; `public.*test.js`: a wizard submit with another client's name+phone and a new email creates/attaches a proposal but the matched row's email is unchanged and `POST /api/client-auth/request` with the new email returns the neutral success without issuing an OTP to that row.

### AUTH-03 high CONFIRMED — the calendar feed never checks account status and deactivation never rotates `calendar_token`, so a deactivated manager keeps every client's phone, email and balance
- Category: auth
- Location: `server/routes/calendar.js:342-396` (feed: `SELECT id, role FROM users WHERE calendar_token = $1` at :344-347; `isAdmin = role === 'admin' || 'manager'` at :350; admin query at :358-368 selects `c.phone, c.email, p.total_price, p.amount_paid`), `server/routes/calendar.js:306-324` (the admin description writes client phone/email, total, balance and notes into every VEVENT), `server/routes/admin/users.js:112-175` (status route writes `onboarding_status` and `pre_hired` only), `server/routes/admin/managers.js:58-66` (demotion), `server/middleware/auth.js:56-66` (the API blocks deactivated/rejected/suspended, but the feed has no `auth`). The only writer of `calendar_token` is the owner's own regenerate (`calendar.js:572`).
- Reachable by: public token holder (the former staffer's or manager's calendar app).
- Evidence: the lookup at :344-347 has no status predicate; the response at :411-436 is built from `s.*` plus client contact and money for the admin branch. `PUT /api/admin/users/:id/status` (`users.js:112-175`) sets `onboarding_status='deactivated'` and clears `pre_hired`; nothing touches `calendar_token`. `grep calendar_token server/` shows no other writer.
- Failure scenario: a manager subscribes Google Calendar to `/api/calendar/feed/<token>` (the URL is handed out by `GET /api/me/calendar-settings`). The admin deactivates them. Their JWT dies on the next request (`auth.js:57`), but their calendar keeps polling the feed and receives, 30 days back and 365 forward, every shift with the client's name, phone, email, event total, balance due, notes and team list, indefinitely. A deactivated staffer keeps their own approved shifts (venue, team, notes) and any future shift whose request was not withdrawn. Demotion to staff (`DELETE /managers/:id`) narrows the feed but revokes nothing.
- Existing tests: `server/routes/calendar.description.test.js` covers the description text only; nothing asserts a status check; nothing enshrines the defect.
- Proposed fix: at the root, the feed lookup fails closed like `auth.js`: `WHERE calendar_token = $1 AND onboarding_status NOT IN ('deactivated','rejected','suspended')`; and the status route rotates the token when entering any of those states (`calendar_token = gen_random_uuid(), calendar_token_created_at = NOW()` in the same UPDATE at `users.js:157-162`), so a re-activated account does not resurrect an old subscription. Consumers: `calendar.js` (feed), `admin/users.js` (status), `staffPortal/accountReads.js` (reads the new token, no change), `tokenGuards.test.js` (unchanged).
- Verification: DB-backed test in `server/routes/calendar.*.test.js`: feed for a deactivated user's token → 404; `PUT /users/:id/status deactivated` changes `calendar_token`; a re-activated user gets a fresh token and the old URL stays 404.

### AUTH-04 medium CONFIRMED — the OTP attempt ceiling is read-then-written around a 250 ms bcrypt compare, so parallel guesses bypass the 5-attempt limit
- Category: race
- Location: `server/routes/clientAuth.js:85-124` (SELECT at :85-89 reads `auth_token_attempts`; ceiling check at :104; `bcrypt.compare` at :117; the increment at :119-121 runs after the compare), `server/routes/clientAuth.js:17-23` (`otpLimiter`, IP-keyed 10/15 min, express-rate-limit MemoryStore, per process).
- Reachable by: unauthenticated.
- Evidence: N concurrent `POST /api/client-auth/verify` requests for one email each read `auth_token_attempts = 0` at :85, pass :104, run the compare at :117, and only then increment at :120. Nothing serializes them (no `FOR UPDATE`, no conditional UPDATE).
- Failure scenario: the OTP is one of 900,000 values valid for 15 minutes (:42-44). The IP limiter gives 10 verifies per IP per window and is per-instance memory; with k source addresses an attacker fires 10k verifies in one burst, all inside the compare window, and the ceiling at :104 never trips. Per OTP window the hit chance is about 10k/900,000 (1,000 addresses ≈ 1.1 %), and `POST /request` lets the attacker mint a fresh OTP for the victim's address every window, so the chances accumulate across windows. A hit yields a client-portal session for the victim (proposals, phone, payments, change requests).
- Existing tests: `server/routes/clientAuth.otpNeutral.test.js` asserts the neutral response and invalidation once the counter reads 5; it does not exercise concurrency and does not enshrine the race.
- Proposed fix: make the increment the claim, before the compare: `UPDATE clients SET auth_token_attempts = COALESCE(auth_token_attempts,0) + 1 WHERE id = $1 AND auth_token IS NOT NULL AND auth_token_attempts < 5 RETURNING auth_token, auth_token_expires_at`; zero rows → invalidate (the existing :109-113 branch) and the neutral 400; then compare against the returned hash. Consumers: `clientAuth.otpNeutral.test.js` (the fixture at the ceiling still answers the neutral 400), the schema comment at `server/db/schema.sql:1479-1481`.
- Verification: a stubbed-bcrypt test that fires 20 concurrent wrong-code verifies for one seeded client and asserts at most 5 compares ran and the row's `auth_token` is NULL afterwards.

### AUTH-05 low CONFIRMED — the drink plan's `admin_notes` reach any onboarded staffer browsing an event they are not assigned to
- Category: pii
- Location: `server/utils/eventDetailsPayload.js:41-54` (`authorizeEventRead`: any onboarded staffer for any event with a non-cancelled shift), `:88-93` (SELECT `admin_notes`), `:333` (`admin_notes: dp.admin_notes` in the payload), contrast `:240-252` (contact is gated on `canSeeContact`); routes `server/routes/beo.js:33` and `server/routes/eventDetails.js:50`.
- Reachable by: staff (onboarded).
- Evidence: the 2026-07-22 ungating comment at `:21` says "contact details stay gated"; `admin_notes` is not gated anywhere in the builder.
- Failure scenario: an approved staffer iterates `GET /api/beo/:proposalId` over proposal ids and reads the admin's internal planning notes on every event (which can carry remarks about the client), not only the events they work.
- Existing tests: `server/routes/beo.test.js`, `server/routes/eventDetails.test.js` cover the contact gate; nothing asserts notes gating.
- Proposed fix: project `admin_notes` only when `canSeeContact` (assigned or privileged), the same switch as `client_phone`; the staff event page already tolerates a missing notes field.
- Verification: `eventDetails.test.js`: an unassigned onboarded staffer's payload has `drink_plan.admin_notes === null`; an assigned one sees it.

### AUTH-06 low CONFIRMED — the public blog image proxy serves any root-level R2 image object by basename
- Category: auth
- Location: `server/routes/blog.js:37-71` (`path.basename(req.params.filename)` → `getSignedUrl` → proxied if the content-type is an image), keys written at the bucket root by `server/routes/admin/blog.js:187-189` (`blog_<uuid>`), `server/routes/emailMarketing/designer.js:58-60` (`email_<uuid>`), and the onboarding headshots `server/routes/application.js:108-110`, `server/routes/contractor.js` (`<userId>_headshot_<uuid>.jpg`); `server/utils/storage.js` has no prefix model.
- Reachable by: unauthenticated.
- Evidence: no prefix check, unlike `r2Proxy.js:58-65` and `menuPrintFile.js:33-36`; only the content-type allowlist at :57 limits what streams (PDF W-9s are refused at :57-59).
- Failure scenario: anyone who learns a headshot key (it is shown in admin UIs, returned to the staffer by `GET /api/contractor`, and sits in logs) fetches the staffer's headshot without auth at `/api/blog/images/<key>`. The uuid in the key keeps it unguessable, which bounds this to leaked keys.
- Existing tests: none for the route.
- Proposed fix: write blog and email images under `blog/` and `email/` prefixes and have the route refuse any key outside them (reuse `assertKeyUnder` from `r2Proxy.js`); consumers: the two upload URL builders, existing `cover_image_url` values (accept the legacy bare `blog_` and `email_` basenames during migration).
- Verification: unit test on the route: a key not starting with `blog_`/`email_` (or the new prefix) → 404 before any R2 call.

### AUTH-07 low CONFIRMED — the failed-login log line writes the submitted email address
- Category: pii
- Location: `server/routes/auth.js:339` (`console.warn('Failed login attempt for', email, 'from IP', req.ip)`).
- Reachable by: unauthenticated.
- Evidence: the line runs for every wrong password on a known account, so each account's email lands in Render logs on every attempt, and the value is attacker-supplied (a credential-stuffing run writes its list into the logs).
- Failure scenario: logs are a third-party-retained copy of staff email addresses; the repo rule keeps PII out of files and diffs, and the Sentry scrub exists to keep it out of telemetry, but the log line bypasses both.
- Existing tests: none.
- Proposed fix: log the user id (available at :325) and the IP, or a hash of the email, never the address.
- Verification: grep `console.*email` in `server/routes/auth.js` is empty after the change.

### AUTH-08 low CONFIRMED — the contractor agreement's `signature_ip` and the change request's `request_ip` are read from the first `X-Forwarded-For` entry
- Category: data-integrity
- Location: `server/routes/agreement.js:92`, `server/routes/clientPortal/changeRequests.js:129`; contrast `server/routes/proposals/publicToken.js:476-480` and `server/routes/proposals/publicSwitch.js:143-147` ("req.ip FIRST ... the first x-forwarded-for entry is attacker-supplied. A signature IP is the strongest artifact in a payment dispute").
- Reachable by: staff (applicant / onboarded) for the agreement; client (portal) for the change request.
- Evidence: `trust proxy` is 1 (`server/index.js:187`), so `req.ip` is the proxy-validated address while the leftmost XFF entry is client-chosen; the two sites take the forgeable one and only fall back to the socket.
- Failure scenario: a signer sends `X-Forwarded-For: 203.0.113.9` and the stored audit IP on the signed contractor agreement, rendered into the PDF (`agreement.js:198`), is a value they chose; the same for a change request's audit row.
- Existing tests: `server/routes/emailChange.test.js` and the agreement suites do not assert the IP source.
- Proposed fix: `const ip = (req.ip || req.socket?.remoteAddress || null)`, sliced to the column width, at both sites (the publicToken pattern). Cross-domain: the e-signature auditor owns the artifact semantics.
- Verification: a route test that sets `X-Forwarded-For` to a junk value and asserts the stored IP equals the socket address.

### AUTH-09 low CONFIRMED — the public proposal payload returns the client's signature image to any holder of the link
- Category: pii
- Location: `server/routes/proposals/publicToken.js:157-158` (SELECT `p.client_signature_data`), the row spread at the return (`...publicProposal`), the allowlist comment at :143-148 (excludes signature IP/UA, not the image); contrast `server/routes/clientPortal.js:138-139` (the authenticated portal deliberately omits it).
- Reachable by: public token holder.
- Evidence: `GET /api/proposals/t/:token` is the link mailed to the client and forwarded freely (venue, partner); after signing, the response carries the drawn signature (up to 200 KB base64, `:84-86` cap on the staff side suggests the same order of magnitude).
- Failure scenario: anyone the link is forwarded to downloads a reusable image of the client's signature.
- Existing tests: `server/routes/proposals/publicLeak.test.js` asserts no hidden pricing leaks; it does not cover signature fields.
- Proposed fix: drop `client_signature_data` from the public SELECT; if `ProposalView` renders the image after signing, serve a boolean `client_signed` instead. Cross-domain: e-signature auditor.
- Verification: extend `publicLeak.test.js` with a signed fixture asserting the raw body never contains the signature data URI prefix.

### AUTH-10 low CONFIRMED — managers receive the full `agreements` row (signature image, IP, user agent) for any staffer
- Category: pii
- Location: `server/routes/admin/users.js:65-110` (`requireAdminOrManager`; `SELECT * FROM agreements` at :72; `agreement: agreementRes.rows[0]` returned whole at :106, while `payment` is withheld from managers at :105).
- Reachable by: manager.
- Evidence: the least-privilege block at :84-96 names the payroll tier as admin-only and strips `hourly_rate`, but the agreement row (which carries `signature_data`, `signature_ip`, `signature_user_agent`) is spread unfiltered.
- Failure scenario: any manager enumerates `GET /api/admin/users/:id` and collects every contractor's signature image.
- Existing tests: `server/routes/admin/users.managerScrub.test.js` pins the payment/hourly_rate scrub only.
- Proposed fix: project the agreement without `signature_data`, `signature_ip`, `signature_user_agent` (the admin's "view PDF" path uses the stored PDF key, not these columns).
- Verification: extend `users.managerScrub.test.js`: the manager payload's `agreement` has no `signature_data` key.

### AUTH-11 low CONFIRMED — `POST /api/me/request-email-change` is an email-existence oracle for any authenticated staff account
- Category: auth
- Location: `server/routes/staffPortal.js:690-697` (`SELECT id FROM users WHERE LOWER(email) = $1` → 409 `EMAIL_IN_USE`), reachable behind `router.use(auth)` only (`:45`), so a self-registered account can use it; `server/routes/auth.js:63-66` gives the same answer unauthenticated on register (common practice, noted for completeness).
- Reachable by: staff (applicant).
- Evidence: the distinct 409 is the signal; the limiter (`rateLimiters.js:229-237`) allows 3 per user per day, and accounts are free to create.
- Failure scenario: confirm which addresses belong to admins or managers before a phishing or credential-stuffing run.
- Existing tests: `server/routes/emailChange.test.js` covers the confirm side; the request side's 409 is asserted as intended behavior (the spec's "helpful reason"), so a neutral answer is a spec change.
- Proposed fix: answer the neutral `{ ok: true, pending: true }` and mail the existing owner a "someone tried to use your address" notice; or at minimum put `requireOnboarded` in front of the route.
- Verification: a test asserting the request for an in-use address returns the same body and status as a fresh one.

---

## Answers to the ten questions

1. JWT: `jsonwebtoken@9.0.3`; `jwt.verify(token, process.env.JWT_SECRET)` with a string secret (`middleware/auth.js:41,122`) limits algorithms to HS256/384/512 (v9 default), so `alg: none` and RS/HS confusion are impossible; no explicit `algorithms` pin (defense in depth only). `JWT_SECRET` is required at boot and ≥ 32 chars (`index.js:64-67`). Expiry: 7d password login and client OTP, 12h device token. `token_version` is compared on every request for staff (`auth.js:49`) and clients (`:131`); role, status and flags are re-read from the row on every request (`:42-45`), never trusted from the claim. The 12h device token is minted only at `webauthn.js:343-347` (grep confirms one `expiresIn: '12h'`). Logout is client-side token drop; revocation is the version bump (password reset `auth.js:478-481`, passkey revoke `webauthn.js:218`, email change `emailChange.js:109-116`); status changes revoke on the next request (`auth.js:56-66`, admins exempt by design). A stolen staff token works until expiry or a bump, with the role the row holds then; a stolen client token for 7 days or a client `token_version` bump.
2. Login: bcrypt cost 12 (`auth.js:68,113,477`); `bcrypt.compare` is constant-time but the unknown-email branch returns before the compare (`:326-328`), a timing oracle the file documents at `:19-27`; the neutral messages hold otherwise. Lockout: per-email, 10 in 15 min, in-process memory (`:28-30`; per instance, reset on deploy); IP limiter 10/15 min keyed by `req.ip` with `trust proxy 1` (`index.js:187`), skipped under `NODE_ENV=test` only. OTP: `crypto.randomInt(100000, 999999)` (6 digits), bcrypt-hashed, 15 min, 5 attempts then invalidation, neutral 400 everywhere (`clientAuth.otpNeutral.test.js`), but the ceiling is racy (AUTH-04). Email change: hashed 32-byte token, 24h, new address verified by link, old address warned, FOR UPDATE single-use, version bump (`staffPortal.js:672-795`, `emailChange.js:43-158`).
3. WebAuthn: challenges are DB rows with a 5-minute TTL, consumed by `DELETE ... RETURNING` (single use, `webauthn.js:85-96`); register challenges are bound to the user, assert challenges unbound by design (usernameless); the challenge is read from `clientDataJSON` but only accepted when the DB consume proves the server issued it, then the library binds the signature to it. rpId and origin come from env or the production defaults (`:29-39`). Counter: the library refuses regression, and the store is an atomic `UPDATE ... WHERE counter = 0 OR counter < $1` (`:328-337`); a regression refuses the unlock and emits a Sentry error but does not revoke the credential or bump the version (the "signal" stays a signal). Revoke is scoped `WHERE id = $1 AND user_id = $2` and bumps `token_version` in the same transaction (global logout), emptying push subscriptions (`:197-232`). The failure envelope is uniform (`:264-267`).
4. Role and onboarding guards: appendix. Every `/api/admin/*` route carries `adminOnly` or `requireAdminOrManager` (the manager set: user detail with the payment row withheld, contractor tip-page actions on non-admin targets, search, inbox, presence, staff-hub, badge counts, lead-call attention); payroll, payroll tax, reviews, managers, applications, settings, blog, marketing, refunds and cancel-line are `adminOnly`. Staff-data surfaces carry `requireOnboarded` (`GET /shifts`, `POST /shifts/:id/request`, event details, BEO) except AUTH-01; the self-service staff routes are scoped by `req.user.id`. An applicant's JWT reaches onboarding routes, its own rows, passkey enrollment and (AUTH-01) staff-home.
5. IDOR: shifts (`shifts.js:258-293` staff self-only; `:643-736` owner pending-only), drop/cover (`staffShiftActions.js:248-262, 390-407, 770-777` ownership under `FOR UPDATE`), payouts (`payouts.js:139-156` JOIN guard), documents/profile/calendar settings (self only), proposals and invoices for clients (`token AND client_id`), messages (`adminOnly` + UUID guard on `groupId`), push subscriptions (self row under `FOR UPDATE`), presence (own row), calendar feed (user by token; AUTH-03), `.ics` (approved-request check). Admin surfaces are single-tenant by design.
6. Public tokens: `gen_random_uuid()` defaults for proposals, invoices, drink plans, groups, calendar, listen links, sms groups (`schema.sql:308,381,864,1196,1542,2303,4285,4298`); tip-page tokens are `uuid.v4()` (`payment.js:259`). Every route runs `requireUuidToken`/`UUID_RE` before the query (`tokenGuards.test.js`); comparison is DB equality (uniform cost); no expiry except listen links (30 days) and quote drafts (30 days); revocation: archived proposals 404 (`publicToken.js:214-245`), void invoices 404, listen-link rotate/kill switch, tip-page rotate, calendar regenerate; legal hold refused on switch/lab; mutations are UPDATE-as-gate on status (`sign`, `switch`, extension accept). Leaks: `publicLeak.test.js` pins the pricing allowlist; AUTH-09 names the one residual field. No public route accepts a row id in the body that reaches a different token's rows (the portal re-checks `client_id`).
7. Files: every upload site is magic-byte validated (`fileValidation.js`; `application.js`, `contractor.js`, `payment.js`, `staffPortal.js:568`, `drinkPlans.js:144,590`, `admin/blog.js:179`, `designer.js:43` plus a sharp re-encode, `menuPrint.js` `menuPrintExt`, `menuDrafts.js:76`, `leads.js` CSV text only); stored extensions derive from the sniffed bytes; keys carry a uuid or timestamp. Downloads: `/api/files/:filename` admin/manager + `basename` (`index.js:316-329`), signed URLs 15 min, `r2Proxy.js:58-65` and `menuPrintFile.js:33-36` and both logo proxies pin a prefix and reject `..`/`//`; AUTH-06 is the one proxy without a prefix. No open redirect found (signed URLs are returned as JSON, never 302).
8. Inbound provider auth: Twilio signature over the proxied URL (`twilioSignature.js`); fail closed on lead/consult/escalate/voicemail routes in every environment, prod-only fail-closed with a documented dev allow on `sms/inbound`, `sms/status`, `voice/bridge`, `voice/status`; Cal.com HMAC-SHA256 timing-safe, 503 without the secret, body-hash replay dedupe (`calcom.js:44-90`); Resend svix (timestamped) in prod, skipped outside prod by design; Thumbtack timing-safe secret, 500 without it in prod, dev-open; Thumbtack agent fail-closed everywhere; Telegram header secret and path secret, 403 always, `update_id` dedupe; Stripe `constructEvent` (300 s tolerance) with the verifying secret deciding the mode (`stripeWebhook.js:26-85`).
9. Error funnel and logs: the global handler returns `{ error, code, fieldErrors }` for `AppError` and a fixed string for everything else (`index.js:455-491`); `ExternalServiceError` hides the provider message. `sentryScrub.js` redacts request bodies, headers, cookies, token path segments and span attributes by value on both pipelines (65-test suite passes here). Logs: tokens are logged only as prefixes/tails; AUTH-07 is the one PII log line found; OTPs and passwords never reach a log.
10. Headers and transport: helmet with CSP (scripts self + Stripe), `crossOriginResourcePolicy: cross-origin` (the listen link overrides to same-origin), CORS allowlist of fixed hosts plus `CLIENT_URL`, localhost only under `NODE_ENV=development`, credentials only for allowlisted origins, origin-less callers get no CORS headers (`corsOptions.test.js` passes). No cookies: both JWTs live in `localStorage` (`client/src/utils/api.js:14`, `ClientAuthContext.js:8`), so XSS is the exposure and CSP/React escaping the defense. Body limits: JSON 1 MB (10 MB on `/api/blog`), raw webhooks default 100 KB (Cal.com 256 KB), uploads `MAX_FILE_SIZE` (10 MB) with a JSON 413.

---

## Checked and sound
- `server/middleware/auth.js`: role and status re-read per request; `token_version` compared for staff and clients; deactivated/rejected/suspended blocked for non-admins; rejections through the canonical envelope (`auth.envelope.test.js`, DB-backed, not run).
- `server/routes/auth.js`: register/login/forgot/reset; hashed single-use reset tokens, 1 h, version bump; neutral forgot-password; password policy mirrored server-side.
- `server/routes/webauthn.js`: single minting site, DB-backed single-use challenges, uniform failure envelope, atomic counter claim, revoke bumps version and clears push.
- `server/routes/clientAuth.js` revocation path and neutral responses (`clientAuth.revocation.test.js`, `clientAuth.otpNeutral.test.js`, DB-backed).
- `server/routes/emailChange.js`: unauthenticated confirm by hashed token, `FOR UPDATE` single-use, IDOR-proof (user id from the row), version bump.
- `server/utils/onboardingPromotion.js` and `server/routes/payment.js`: promotion only from admin-conferred statuses or `in_progress` with an applications row; `pre_hired` is not evidence.
- `server/routes/application.js`: `FOR UPDATE` status gate, uploads validated, pre-hire branch from the locked row.
- `server/routes/admin/*`: every route role-guarded; manager scope narrowed on user detail (payment row), tip-page actions (no admin targets), badge counts; `active-staff` and staff-hub check `can_staff`.
- `server/routes/shifts.js`, `staffShiftActions.js`, `eventDetails.js`, `beo.js`, `serviceExtensions/create.js`: ownership and assignment predicates inside transactions; staff feed drops client contact; menu-print download assigned-only.
- `server/routes/staffPortal/*`: every read and write pinned to `req.user.id`; bank numbers through `encryption.js`, last-4 projection; allowlists on every PATCH; jsonb paths built only from allowlisted keys.
- `server/routes/adminCoverSwaps.js`: JWT swap token behind `auth` + role; claim shapes keep swap, staff, client, unsubscribe and dev tokens mutually unusable despite the shared secret (`unsubscribe.js:60-78` adds the `typ` check).
- Public token routes (`publicToken.js`, `publicOptions.js`, `publicSwitch.js`, `compareGroup.js`, `drinkPlans.js` + `lab.js` + `submit.js` + `shoppingList.js`, `invoices.js`, `publicAccept.js`, `publicTip.js`, `publicFeedback.js`, `publicReviews.js`, `unsubscribe.js`, `smsOptIn.js`, `voicemailListen.js`, `voiceAssets.js`, `venues.js`, `stripe.js`/`stripeCreateIntent.js` token guards): UUID guard before any query, token-keyed limiters, archived/void 404, UPDATE-as-gate mutations, allowlisted payloads (`publicLeak.test.js`, DB-backed).
- Client portal (`clientPortal.js`, `changeRequests.js`, `invoices.js:572`): `token AND client_id` on every read and write, `FOR UPDATE` on create.
- Webhooks: `sms.js`, `voice.js`, `voiceLeadCall.js`, `voiceConsultCall.js`, `voiceEscalate.js`, `calcom.js` (+ `calcomWebhookHelpers.js` timing-safe HMAC), `emailMarketingWebhook.js`, `thumbtack.js`, `thumbtackAgent.js`, `telegram.js`, `stripeWebhook.js` (signature only).
- R2 and uploads: `fileValidation.js`, `storage.js`, `r2Proxy.js`, `menuPrintFile.js`, `menuDraftImages.js`, both drink-plan logo proxies, `/api/files/:filename`.
- Dev minters: `scripts/dev-signin.js` and `scripts/mobile-capture.js` both call `assertDevDatabase` (`scripts/lib/devDbGate.js`) before any mint: refuses `NODE_ENV=production`, a non-postgres URL, a `?host=` override, and any host but the pinned dev branch; tokens carry `iss`. No `NODE_ENV` or bypass switch in server code opens auth: the only env-conditioned behaviors are the documented dev warn-and-allow webhook paths, the test-only limiter skips, the AI/mail wrappers refusing real calls under test, and the dev-only CORS localhost door.
- Client: tokens dropped on logout and revocation; the admin service worker caches only an allowlisted GET set per user id, evicts on a late 401/403, purges on logout, and refuses a stale identity whose token expired (`AuthContext.js:38-44`); `App.js` guards (`ProtectedRoute`, `RequireHired`, `RequirePortal`) mirror the server's role/status sets.
- Rate limits: IP-keyed limiters use `req.ip` behind `trust proxy 1`; token-keyed public money routes carry a second per-IP ceiling (`publicTokenIpLimiter`).
- Error funnel: no stack, SQL or provider message in any response path read; `sentryScrub.js` suite passes here.
- Pure suites run here with `NODE_ENV=test node --test`: `tokens`, `sentryScrub`, `fileValidation`, `r2Proxy`, `corsOptions`, `legalHold`: 65 tests, 65 pass.
- Hygiene noted, not reported: several admin and staff routes pass a raw `:id` to pg (`admin/users.js:65`, `shifts.js:651`, `drinkPlans.js:/:id`), so junk yields a 22P02 500 plus Sentry noise rather than a 400; no security consequence.

## Could not verify
- DB-backed suites (ECONNREFUSED 127.0.0.1:5432 here): `auth.core.test.js`, `auth.envelope.test.js`, `webauthn.test.js`, `clientAuth.otpNeutral.test.js`, `clientAuth.revocation.test.js`, `emailChange.test.js`, `tokenGuards.test.js`, `publicLeak.test.js`, `shifts.adminScoped.test.js`, `staffPortal*.test.js`, `clientDedup.test.js`, `users.managerScrub.test.js`, `calendar.description.test.js`; their assertions were read, not run.
- AUTH-02's DB precondition (email-less client rows with knowable names), stated by the code comments and the harvester queue but not observable here.
- Render configuration: that `NODE_ENV=production` is set on every instance (the dev warn-and-allow webhook paths and the CORS localhost door hinge on it), that `RESEND_WEBHOOK_SECRET`, `THUMBTACK_WEBHOOK_SECRET`, `CAL_WEBHOOK_SECRET` and `TELEGRAM_WEBHOOK_SECRET` are set, and whether more than one web instance runs (the in-memory login lockout and rate limiters are per process).
- Provider behavior: Twilio's signature over the proxied URL assumes Render forwards the original host and `https` scheme; svix timestamp tolerance; Stripe's 300 s tolerance.
- `client/src/pages/proposal` rendering of `client_signature_data` (whether AUTH-09's fix can drop the field outright or needs a flag).

---

## Appendix: route inventory with verdict per route

Generated from the mounted routers in `server/index.js` order (`route-chains.js` in the scratchpad, read-only; `inventory.txt` is the raw walk). Guard chain lists the named middleware in order (`use` then route); anonymous handlers and limiters are omitted. Verdicts for admin-/manager-/staffing-/client-guarded routes are rule-derived; every `auth`-only and public route carries a verdict from reading its handler.

| Method | Path | Guard chain | Verdict |
|---|---|---|---|
| **/api/auth/webauthn (routes/webauthn) 6 routes** | | | |
| POST | `/api/auth/webauthn/register-options` | auth | OK: self |
| POST | `/api/auth/webauthn/register-verify` | auth | OK: self; challenge single-use |
| GET | `/api/auth/webauthn/credentials` | auth | OK: self |
| DELETE | `/api/auth/webauthn/credentials/:id` | auth | OK: self; token_version bump |
| POST | `/api/auth/webauthn/assert-options` | none | OK: public by design; unbound single-use challenge |
| POST | `/api/auth/webauthn/assert-verify` | none | OK: only 12h mint site; uniform failure envelope |
| **/api/auth (routes/auth) 7 routes** | | | |
| POST | `/api/auth/register` | none | OK by design (public; mints in_progress staff JWT) — see AUTH-01 for what it reaches |
| POST | `/api/auth/register-pre-hired` | none | OK by design (pre_hired is self-assertable and proves nothing) |
| POST | `/api/auth/claim-pre-hire` | auth | OK: self-scoped (req.user.id), staff only |
| POST | `/api/auth/login` | none | OK: bcrypt, lockout, IP limiter (LOW AUTH-07: email in log; timing oracle acknowledged) |
| GET | `/api/auth/me` | auth | OK: self |
| POST | `/api/auth/forgot-password` | none | OK: neutral; hashed 1h token |
| POST | `/api/auth/reset-password` | none | OK: hashed single-use; token_version bump |
| **/api/progress (routes/progress) 5 routes** | | | |
| GET | `/api/progress/` | auth | OK: self-scoped |
| PUT | `/api/progress/step` | auth | OK: self-scoped |
| GET | `/api/progress/draft/:formKey` | auth | OK: self + allowlist |
| PUT | `/api/progress/draft/:formKey` | auth | OK: self + allowlist (payday draft excluded) |
| DELETE | `/api/progress/draft/:formKey` | auth | OK: self |
| **/api/agreement (routes/agreement) 4 routes** | | | |
| GET | `/api/agreement/legal-text` | none | OK: public text |
| GET | `/api/agreement/` | auth | OK: self |
| GET | `/api/agreement/download` | auth | OK: self (signed URL of own PDF) |
| POST | `/api/agreement/` | auth | LOW AUTH-08: signature_ip from first X-Forwarded-For |
| **/api/contractor (routes/contractor) 2 routes** | | | |
| GET | `/api/contractor/` | auth | OK: self |
| POST | `/api/contractor/` | auth | OK: self; uploads magic-checked |
| **/api/me (routes/emailChange) 1 routes** | | | |
| POST | `/api/me/confirm-email-change` | none | OK: unauthenticated by design; hashed token; FOR UPDATE; version bump |
| **/api/me (routes/me) 5 routes** | | | |
| GET | `/api/me/tip-page` | auth | OK: self |
| PATCH | `/api/me/tip-page` | auth | OK: self + allowlist |
| GET | `/api/me/tips` | auth | OK: self |
| GET | `/api/me/notification-preferences` | auth | OK: self |
| PATCH | `/api/me/notification-preferences` | auth > requireAdminOrManager | OK: admin/manager |
| **/api/me (routes/mePush) 1 routes** | | | |
| POST | `/api/me/push-test` | auth > requireAdminOrManager | OK: admin/manager |
| **/api/me (routes/staffPortal) 22 routes** | | | |
| GET | `/api/me/staff-home` | auth | FINDING AUTH-01: no requireOnboarded; serves company-wide cover broadcasts (requester emails) + open-shift teaser to any registered account |
| GET | `/api/me/payment-methods` | auth | OK: self; bank last-4 only |
| PATCH | `/api/me/payment-methods` | auth | OK: self + allowlist; encrypt() |
| PUT | `/api/me/preferred-payment-method` | auth | OK: self |
| GET | `/api/me/payouts` | auth | OK: self (contractor_id = req.user.id) |
| GET | `/api/me/payment-history` | auth | OK: self |
| GET | `/api/me/payouts/:periodId` | auth | OK: self JOIN guard |
| GET | `/api/me/payouts/:periodId/paystub` | auth | OK: self JOIN guard; signed URL |
| GET | `/api/me/profile` | auth | OK: self |
| GET | `/api/me/calendar-settings` | auth | OK: self (owner gets own token) |
| GET | `/api/me/documents` | auth | OK: self; no R2 keys |
| PUT | `/api/me/tip-card-order` | auth | OK: self + allowlist |
| PATCH | `/api/me/profile` | auth | OK: self + allowlist |
| GET | `/api/me/ui-preferences` | auth | OK: self |
| PATCH | `/api/me/ui-preferences` | auth | OK: self + allowlist |
| GET | `/api/me/staff-notifications` | auth | OK: self |
| PATCH | `/api/me/staff-notifications` | auth | OK: self + allowlist |
| POST | `/api/me/push-subscriptions` | auth | OK: self (FOR UPDATE, cap 10) |
| DELETE | `/api/me/push-subscriptions` | auth | OK: self |
| POST | `/api/me/documents/:doc_type/replace` | auth | OK: self; magic bytes; key under staff/<type>/<uid>/ |
| POST | `/api/me/request-email-change` | auth | OK: self; hashed token; both sides mailed (LOW AUTH-11: EMAIL_IN_USE oracle to authed staff) |
| POST | `/api/me/cancel-pending-email-change` | auth | OK: self |
| **/api/payment (routes/payment) 2 routes** | | | |
| GET | `/api/payment/` | auth | OK: self; bank masked |
| POST | `/api/payment/` | auth | OK: self; promotion gated by onboardingPromotion.js |
| **/api/application (routes/application) 2 routes** | | | |
| GET | `/api/application/` | auth | OK: self |
| POST | `/api/application/` | auth | OK: self; FOR UPDATE status gate; uploads validated |
| **/api/admin/thumbtack (routes/thumbtackAgent) 7 routes** | | | |
| GET | `/api/admin/thumbtack/pending-harvest` | agentSecretOnly | OK: agent secret (fail-closed) |
| POST | `/api/admin/thumbtack/email-harvested` | agentOrAdmin | OK: agent secret or admin/manager JWT |
| POST | `/api/admin/thumbtack/rearm` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/admin/thumbtack/harvest-failed` | agentSecretOnly | OK: agent secret |
| GET | `/api/admin/thumbtack/pending-first-replies` | agentSecretOnly | OK: agent secret |
| POST | `/api/admin/thumbtack/first-reply-sent` | agentSecretOnly | OK: agent secret |
| POST | `/api/admin/thumbtack/first-reply-failed` | agentSecretOnly | OK: agent secret |
| **/api/admin/packages (routes/packages) 8 routes** | | | |
| GET | `/api/admin/packages/` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/admin/packages/:id(\d+)` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/admin/packages/:id(\d+)` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/admin/packages/:id(\d+)/items` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/admin/packages/:id(\d+)/items/:itemId(\d+)` | auth > requireAdminOrManager | OK: admin/manager |
| DELETE | `/api/admin/packages/:id(\d+)/items/:itemId(\d+)` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/admin/packages/:id(\d+)/makeability` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/admin/packages/:id(\d+)/margin` | auth > requireAdminOrManager | OK: admin/manager |
| **/api/admin (routes/admin) 95 routes** | | | |
| GET | `/api/admin/users` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/users/:id` | auth > requireAdminOrManager | OK: admin/manager; payment row withheld from managers (LOW AUTH-10: agreements.signature_data served to managers) |
| PUT | `/api/admin/users/:id/status` | auth > adminOnly | OK: admin only |
| PUT | `/api/admin/users/:id/profile` | auth > adminOnly | OK: admin only |
| PUT | `/api/admin/users/:id/permissions` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/active-staff` | auth | OK: inline admin / can_staff manager check |
| GET | `/api/admin/users/:id/stub-co-participated-proposals` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/admin/users/:id/seniority` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/admin/users/:id/seniority` | auth > adminOnly | OK: admin only |
| PATCH | `/api/admin/contractors/:userId/tip-page` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/admin/contractors/:userId/tip-page/rotate-token` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/admin/contractors/:userId/tip-page/regenerate-stripe` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/admin/contractors/:userId/tip-page/generate-stripe` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/admin/contractors/:userId/tip-page/deactivate` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/admin/contractors/:userId/tip-page/activate` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/admin/tips` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/tip-feedback` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/tip-feedback/:id/review` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/applications` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/applications/:userId` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/applications/:userId/notes` | auth > adminOnly | OK: admin only |
| DELETE | `/api/admin/notes/:noteId` | auth > adminOnly | OK: admin only |
| PUT | `/api/admin/applications/:userId/interview` | auth > adminOnly | OK: admin only |
| DELETE | `/api/admin/applications/:userId/interview` | auth > adminOnly | OK: admin only |
| PUT | `/api/admin/applications/:userId/scorecard` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/applications/:userId/move` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/applications/:userId/reject` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/applications/:userId/restore` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/applications/:userId/reminder` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/managers` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/managers` | auth > adminOnly | OK: admin only |
| PUT | `/api/admin/managers/:id` | auth > adminOnly | OK: admin only |
| DELETE | `/api/admin/managers/:id` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/blog` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/blog/import` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/blog` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/blog/upload-image` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/blog/:id` | auth > adminOnly | OK: admin only |
| PUT | `/api/admin/blog/:id` | auth > adminOnly | OK: admin only |
| DELETE | `/api/admin/blog/:id` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/test-email` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/settings` | auth > adminOnly | OK: admin only |
| PUT | `/api/admin/settings` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/backfill-geocodes` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/badge-counts` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/admin/hiring/summary` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/hiring/search` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/hiring/uncertified` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/search` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/admin/payroll/healthcheck` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/payroll/periods` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/payroll/periods/current` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/payroll/periods/:id` | auth > adminOnly | OK: admin only |
| PATCH | `/api/admin/payroll/payout-events/:id` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/payroll/periods/:id/process` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/payroll/periods/:id/reopen` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/payroll/payouts/:id/mark-paid` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/payroll/payouts/:id/toggle-draw` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/payroll/unassigned-tips` | auth > adminOnly | OK: admin only |
| PATCH | `/api/admin/payroll/tips/:id/assign` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/payroll/deferred-tips` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/payroll/deferred-tips/retry` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/payroll/contractors/:userId/payouts` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/payroll/duty-lines` | auth > adminOnly | OK: admin only |
| PATCH | `/api/admin/payroll/duty-lines/:id` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/payroll/duty-lines/:id/remove` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/payroll/duty-lines/:id/restore` | auth > adminOnly | OK: admin only |
| PUT | `/api/admin/payroll/duty-attributions` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/payroll/periods/:id/unattributed-duties` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/payroll/contractors/:userId/payment-history` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/payroll/tax-totals` | auth > adminOnly | OK: admin only |
| PATCH | `/api/admin/payroll/tax-totals/:userId/exclude` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/staff-reviews/leaderboard` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/staff-reviews/contest-award` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/staff-reviews` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/staff-reviews` | auth > adminOnly | OK: admin only |
| PATCH | `/api/admin/staff-reviews/:id` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/staff-reviews/:id/confirm` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/staff-reviews/:id/dismiss` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/staff-hub/summary` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/admin/presence` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/admin/presence/state` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/admin/presence/leads` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/admin/presence/log` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/lead-call-attention` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/admin/name-notices` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/name-notices/:userId/ack` | auth > adminOnly | OK: admin only |
| GET | `/api/admin/inbox` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/admin/inbox/:personKey` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/admin/inbox/:personKey/seen` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/admin/inbox/:personKey/actions` | auth > requireAdminOrManager | OK: admin/manager |
| DELETE | `/api/admin/inbox/actions/:id` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/admin/inbox/:personKey/text` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/admin/proposals/:id/reenroll-drink-plan-nudge` | auth > adminOnly | OK: admin only |
| POST | `/api/admin/proposals/:id/reaccrue-payout` | auth > adminOnly | OK: admin only |
| **/api/admin (routes/adminCoverSwaps) 2 routes** | | | |
| GET | `/api/admin/cover-swaps/:swapToken` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/admin/cover-swaps/:swapToken` | auth > requireAdminOrManager | OK: admin/manager |
| **/api/shifts (routes/shifts) 16 routes** | | | |
| GET | `/api/shifts/` | auth > requireOnboarded | OK: requireOnboarded; staff feed drops client contact |
| GET | `/api/shifts/unstaffed-upcoming` | auth > requireStaffing | OK: admin or can_staff manager |
| GET | `/api/shifts/user/:userId/events` | auth | OK: staff self-only, manager any |
| GET | `/api/shifts/my-requests` | auth | OK: self-scoped |
| GET | `/api/shifts/by-proposal/:proposalId` | auth > requireStaffing | OK: admin or can_staff manager |
| GET | `/api/shifts/detail/:id` | auth > requireStaffing | OK: admin or can_staff manager |
| PATCH | `/api/shifts/:id/out-of-area` | auth > requireStaffing | OK: admin or can_staff manager |
| POST | `/api/shifts/:id/request` | auth > requireOnboarded | OK: requireOnboarded |
| DELETE | `/api/shifts/requests/:requestId` | auth | OK: owner pending-only, else can_staff; raw id reaches pg (hygiene) |
| PUT | `/api/shifts/:id` | auth > requireStaffing | OK: admin or can_staff manager |
| DELETE | `/api/shifts/:id` | auth > requireStaffing | OK: admin or can_staff manager |
| POST | `/api/shifts/:id/cancel-or-unassign` | auth > requireStaffing | OK: admin or can_staff manager |
| POST | `/api/shifts/:id/assign` | auth > requireStaffing | OK: admin or can_staff manager |
| GET | `/api/shifts/:id/requests` | auth > requireStaffing | OK: admin or can_staff manager |
| PUT | `/api/shifts/requests/:requestId` | auth > requireStaffing | OK: admin or can_staff manager |
| POST | `/api/shifts/:id/auto-assign` | auth > requireStaffing | OK: admin or can_staff manager |
| **/api/shifts (routes/eventDetails) 2 routes** | | | |
| GET | `/api/shifts/:shiftId/event-details` | auth > requireOnboarded | OK by spec: onboarded; contact gated |
| GET | `/api/shifts/:shiftId/menu-print` | auth > requireOnboarded | OK: assigned-only; prefix guard |
| **/api/shifts (routes/staffShiftActions) 4 routes** | | | |
| POST | `/api/shifts/requests/:requestId/drop` | auth | OK: ownership + status in FOR UPDATE tx |
| POST | `/api/shifts/requests/:requestId/request-cover` | auth | OK: ownership + status |
| POST | `/api/shifts/requests/:shiftId/claim-cover` | auth | OK: no requireOnboarded but contractor_profiles.position gate (unset for self-registered) |
| POST | `/api/shifts/requests/:requestId/emergency-drop` | auth | OK: ownership + status |
| **/api/drink-plans (routes/drinkPlans/regenerate) 1 routes** | | | |
| POST | `/api/drink-plans/:id/shopping-list/regenerate` | auth > requireAdminOrManager | OK: admin/manager |
| **/api/drink-plans (routes/drinkPlans) 24 routes** | | | |
| GET | `/api/drink-plans/t/:token/shopping-list` | none | OK: UUID guard |
| POST | `/api/drink-plans/t/:token/lab-cta` | none | OK: UUID guard, write-once |
| GET | `/api/drink-plans/t/:token/lab` | none | OK: UUID guard |
| PUT | `/api/drink-plans/t/:token/lab` | none | OK: UUID guard, FOR UPDATE, legal hold |
| GET | `/api/drink-plans/t/:token` | none | OK: UUID guard; pre-booking returns locked; sanitized snapshot |
| PUT | `/api/drink-plans/t/:token` | none | OK: UUID guard; finalized/submitted guard; selections allowlist |
| POST | `/api/drink-plans/t/:token/logo` | none | OK: UUID guard; magic bytes; key under drink-plan-logos/ |
| GET | `/api/drink-plans/t/:token/logo` | none | OK: prefix guard on stored key |
| GET | `/api/drink-plans/` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/drink-plans/` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/drink-plans/for-proposal/:proposalId` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/drink-plans/by-proposal/:proposalId` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/drink-plans/:id` | auth > requireAdminOrManager | OK: admin/manager |
| PATCH | `/api/drink-plans/:id/notes` | auth > requireAdminOrManager | OK: admin/manager |
| PATCH | `/api/drink-plans/:id/status` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/drink-plans/:id/finalize` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/drink-plans/:id/unfinalize` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/drink-plans/:id/shopping-list` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/drink-plans/:id/shopping-list` | auth > requireAdminOrManager | OK: admin/manager |
| PATCH | `/api/drink-plans/:id/shopping-list/approve` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/drink-plans/:id/logo` | auth > requireAdminOrManager | OK: admin/manager |
| DELETE | `/api/drink-plans/:id/logo` | auth > requireAdminOrManager | OK: admin/manager |
| DELETE | `/api/drink-plans/:id` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/drink-plans/:id/resend-nudge` | auth > requireAdminOrManager | OK: admin/manager |
| **/api/drink-plans (routes/drinkPlanConsult) 3 routes** | | | |
| GET | `/api/drink-plans/:id/consult` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/drink-plans/:id/consult` | auth > requireAdminOrManager | OK: admin/manager |
| PATCH | `/api/drink-plans/:id/shopping-list-source` | auth > requireAdminOrManager | OK: admin/manager |
| **/api/comms (routes/comms) 2 routes** | | | |
| POST | `/api/comms/preview` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/comms/send` | auth > requireAdminOrManager | OK: admin/manager |
| **/api/beo (routes/beo) 3 routes** | | | |
| GET | `/api/beo/:proposalId` | auth > requireOnboarded | OK by spec 2026-07-22: any onboarded staffer; contact gated (LOW AUTH-05: drink-plan admin_notes served) |
| GET | `/api/beo/:proposalId/logo` | auth > requireOnboarded | OK: prefix guard |
| POST | `/api/beo/:proposalId/acknowledge` | auth > requireOnboarded | OK: UPDATE predicates enforce assignment |
| **/api/cocktails (routes/cocktails) 12 routes** | | | |
| GET | `/api/cocktails/` | none | OK: public projection |
| GET | `/api/cocktails/admin` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/cocktails/categories` | none | OK: public |
| POST | `/api/cocktails/reorder` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/cocktails/categories/reorder` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/cocktails/categories` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/cocktails/categories/:id` | auth > requireAdminOrManager | OK: admin/manager |
| DELETE | `/api/cocktails/categories/:id` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/cocktails/` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/cocktails/:id` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/cocktails/:id/request-aliases` | auth > requireAdminOrManager | OK: admin/manager |
| DELETE | `/api/cocktails/:id` | auth > requireAdminOrManager | OK: admin/manager |
| **/api/mocktails (routes/mocktails) 12 routes** | | | |
| GET | `/api/mocktails/` | none | OK: public projection |
| GET | `/api/mocktails/admin` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/mocktails/categories` | none | OK: public |
| POST | `/api/mocktails/reorder` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/mocktails/categories/reorder` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/mocktails/categories` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/mocktails/categories/:id` | auth > requireAdminOrManager | OK: admin/manager |
| DELETE | `/api/mocktails/categories/:id` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/mocktails/` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/mocktails/:id` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/mocktails/:id/request-aliases` | auth > requireAdminOrManager | OK: admin/manager |
| DELETE | `/api/mocktails/:id` | auth > requireAdminOrManager | OK: admin/manager |
| **/api/potions (routes/potions) 6 routes** | | | |
| GET | `/api/potions/pars` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/potions/pars` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/potions/pars/:id` | auth > requireAdminOrManager | OK: admin/manager |
| DELETE | `/api/potions/pars/:id` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/potions/pars/reorder` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/potions/preview` | auth > requireAdminOrManager | OK: admin/manager |
| **/api/proposals (routes/proposals) 67 routes** | | | |
| GET | `/api/proposals/t/:token/resolve` | requireUuidToken | OK: UUID guard; group info only |
| GET | `/api/proposals/t/:token/payment-state` | requireUuidToken | OK: UUID guard; non-mutating |
| GET | `/api/proposals/t/:token` | requireUuidToken | OK: UUID guard; allowlist; archived 404 (LOW AUTH-09: client_signature_data served) |
| POST | `/api/proposals/t/:token/sign` | requireUuidToken | OK: UUID guard; signLimiter; UPDATE-as-gate |
| POST | `/api/proposals/t/:token/options` | none | OK: UUID guard; token-keyed limiter |
| POST | `/api/proposals/t/:token/switch` | none | OK: UUID guard; FOR UPDATE; signed/status/legal-hold refusals |
| GET | `/api/proposals/group/:token` | none | OK: UUID guard; positive allowlist |
| GET | `/api/proposals/group/:token/preview` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/public/packages` | none | OK: public catalog |
| GET | `/api/proposals/public/addons` | none | OK: public catalog |
| POST | `/api/proposals/public/calculate` | none | OK: pure pricing preview |
| POST | `/api/proposals/public/capture-lead` | none | OK: publicLimiter; email_leads upsert (no identity mutation) |
| GET | `/api/proposals/public/quote-draft/:token` | none | OK: UUID guard, 30-day |
| PUT | `/api/proposals/public/quote-draft/:token` | none | OK: UUID guard, size cap |
| POST | `/api/proposals/public/submit` | none | FINDING AUTH-02: findOrCreateClientDetailed backfills submitter email onto a phone+name-matched email-less client row (portal takeover + comms redirect) |
| GET | `/api/proposals/packages` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/addons` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/calculate` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/financials` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/:id/lead-cost` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/dashboard-stats` | auth > requireAdminOrManager | OK: admin/manager |
| PATCH | `/api/proposals/:id/status` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/resend` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/portal-invite` | auth > requireAdminOrManager | OK: admin/manager |
| PATCH | `/api/proposals/:id/notes` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/create-shift` | auth > requireAdminOrManager | OK: admin/manager |
| PATCH | `/api/proposals/:id/balance-due-date` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/send-reminder` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/record-payment` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/archive` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/cancel/preview` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/cancel` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/cancel/refund` | auth > adminOnly | OK: admin only |
| GET | `/api/proposals/:id/cancel-line/targets` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/cancel-line/preview` | auth > adminOnly | OK: admin only |
| POST | `/api/proposals/:id/cancel-line` | auth > adminOnly | OK: admin only |
| GET | `/api/proposals/change-requests` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/:id/change-requests` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/change-requests/:id/decline` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/alternative` | auth > requireAdminOrManager | OK: admin/manager |
| DELETE | `/api/proposals/:id/group-membership` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/:id/group` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/send-group` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/notify-preflight` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/:id/menu-print` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/menu-print` | auth > requireAdminOrManager | OK: admin/manager |
| PATCH | `/api/proposals/:id/menu-print` | auth > requireAdminOrManager | OK: admin/manager |
| DELETE | `/api/proposals/:id/menu-print` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/:id/menu-draft` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/menu-draft/generate` | auth > requireAdminOrManager | OK: admin/manager |
| PATCH | `/api/proposals/:id/menu-draft` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/menu-draft/pieces/:pieceKey/reroll` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/menu-draft/dismiss-plan-change` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/menu-draft/sync` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/:id/menu-draft/pieces/:pieceKey/image` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/:id/menu-draft/reference` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/:id/menu-draft/planner-image` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/menu-draft/approve` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/:id/remote-staffing-check` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/remote-fee-prompt-answered` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/:id/stop-drip` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/proposals/` | auth > requireAdminOrManager | OK: admin/manager |
| PATCH | `/api/proposals/:id` | auth > requireAdminOrManager | OK: admin/manager |
| DELETE | `/api/proposals/:id` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/metrics-split` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/proposals/:id` | auth > requireAdminOrManager | OK: admin/manager |
| **/api/clients (routes/clients) 4 routes** | | | |
| GET | `/api/clients/` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/clients/` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/clients/:id` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/clients/:id` | auth > requireAdminOrManager | OK: admin/manager |
| **/api/venues (routes/venues) 2 routes** | | | |
| GET | `/api/venues/search` | none | OK: public proxy, two limiters |
| GET | `/api/venues/details/:placeId` | none | OK: public proxy |
| **/api/messages (routes/messages) 6 routes** | | | |
| GET | `/api/messages/recipients` | auth > adminOnly | OK: admin only |
| POST | `/api/messages/send` | auth > adminOnly | OK: admin only |
| GET | `/api/messages/history` | auth > adminOnly | OK: admin only |
| GET | `/api/messages/history/:groupId` | auth > adminOnly | OK: admin only |
| GET | `/api/messages/user/:userId` | auth > adminOnly | OK: admin only |
| GET | `/api/messages/shifts` | auth > adminOnly | OK: admin only |
| **/api/stripe (routes/stripe) 9 routes** | | | |
| POST | `/api/stripe/create-intent/:token` | none | OK: UUID guard (payments auditor owns semantics) |
| GET | `/api/stripe/publishable-key` | none | OK: public key |
| POST | `/api/stripe/create-drink-plan-intent/:token` | none | OK: UUID guard |
| POST | `/api/stripe/payment-link/:id` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/stripe/charge-balance/:id` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/stripe/refunds/:id` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/stripe/refund/:id` | auth > adminOnly | OK: admin only |
| POST | `/api/stripe/create-intent-for-invoice/:token` | none | OK: UUID guard; sent/partially_paid only |
| POST | `/api/stripe/webhook` | none | OK: constructEvent; verifying secret decides mode |
| **/api/stripe-payouts (routes/stripePayouts) 3 routes** | | | |
| GET | `/api/stripe-payouts/` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/stripe-payouts/:id(\d+)` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/stripe-payouts/sync` | auth > requireAdminOrManager | OK: admin/manager |
| **/api/calendar (routes/calendar) 4 routes** | | | |
| GET | `/api/calendar/feed/:token` | none | FINDING AUTH-03: no onboarding_status check; token never rotated on deactivation (deactivated manager keeps all-client feed) |
| GET | `/api/calendar/event/:shiftId.ics` | auth | OK: approved-request check for staff |
| GET | `/api/calendar/token` | auth | OK: self |
| POST | `/api/calendar/token/regenerate` | auth | OK: self |
| **/api/blog (routes/blog) 3 routes** | | | |
| GET | `/api/blog/` | none | OK: published only |
| GET | `/api/blog/images/:filename` | none | LOW AUTH-06: proxies any root-level R2 image object by basename (no blog/ prefix) |
| GET | `/api/blog/:slug` | none | OK: published only |
| **/api/calcom (routes/calcom) 1 routes** | | | |
| POST | `/api/calcom/webhook` | none | OK: HMAC timingSafe; fails closed; body-hash replay dedupe |
| **/api/client-auth (routes/clientAuth) 3 routes** | | | |
| POST | `/api/client-auth/request` | none | OK: neutral; randomInt OTP; bcrypt hash; 15 min |
| POST | `/api/client-auth/verify` | none | FINDING AUTH-04: attempt counter incremented after compare (race past the 5-attempt ceiling) |
| GET | `/api/client-auth/me` | clientAuth | OK: self |
| **/api/client-portal (routes/clientPortal) 6 routes** | | | |
| GET | `/api/client-portal/home` | clientAuth | OK: client_id scope |
| GET | `/api/client-portal/proposals/:token` | clientAuth | OK: token AND client_id |
| POST | `/api/client-portal/proposals/:token/calculate` | clientAuth | OK: owned |
| POST | `/api/client-portal/proposals/:token/change-requests` | clientAuth | OK: owned, FOR UPDATE (LOW AUTH-08: request_ip from X-Forwarded-For) |
| GET | `/api/client-portal/proposals/:token/change-requests` | clientAuth | OK: owned |
| POST | `/api/client-portal/proposals/:token/change-requests/:id/cancel` | clientAuth | OK: owned + proposal_id |
| **/api/email-marketing (routes/emailMarketing) 32 routes** | | | |
| GET | `/api/email-marketing/leads` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/email-marketing/leads` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/email-marketing/leads/import` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/email-marketing/leads/:id` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/email-marketing/leads/:id` | auth > requireAdminOrManager | OK: admin/manager |
| DELETE | `/api/email-marketing/leads/:id` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/email-marketing/campaigns` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/email-marketing/campaigns` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/email-marketing/campaigns/:id` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/email-marketing/campaigns/:id` | auth > requireAdminOrManager | OK: admin/manager |
| DELETE | `/api/email-marketing/campaigns/:id` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/email-marketing/campaigns/:id/send` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/email-marketing/campaigns/:id/schedule` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/email-marketing/upload-image` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/email-marketing/preview` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/email-marketing/campaigns/:id/test` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/email-marketing/campaigns/:id/steps` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/email-marketing/campaigns/:id/steps` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/email-marketing/campaigns/:id/steps/:stepId` | auth > requireAdminOrManager | OK: admin/manager |
| DELETE | `/api/email-marketing/campaigns/:id/steps/:stepId` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/email-marketing/campaigns/:id/activate` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/email-marketing/campaigns/:id/pause` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/email-marketing/campaigns/:id/enroll` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/email-marketing/campaigns/:id/enrollments` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/email-marketing/analytics/overview` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/email-marketing/conversations` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/email-marketing/conversations/:leadId` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/email-marketing/conversations/:leadId/reply` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/email-marketing/conversations/:conversationId/read` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/email-marketing/conversations/:leadId/mark-replied` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/email-marketing/unsubscribe` | none | OK: JWT credential; GET confirms only |
| POST | `/api/email-marketing/unsubscribe` | none | OK: JWT credential; typ check |
| **/api/email-marketing/webhook (routes/emailMarketingWebhook) 1 routes** | | | |
| POST | `/api/email-marketing/webhook/resend` | none | OK: svix verify; fails closed in prod (non-prod skips by design) |
| **/api/marketing (routes/marketingContacts) 6 routes** | | | |
| PUT | `/api/marketing/contacts/:id/tags` | auth > adminOnly | OK: admin only |
| PUT | `/api/marketing/contacts/:id/do-not-contact` | auth > adminOnly | OK: admin only |
| PUT | `/api/marketing/contacts/:id/email-status` | auth > adminOnly | OK: admin only |
| GET | `/api/marketing/contacts` | auth > adminOnly | OK: admin only |
| GET | `/api/marketing/audiences` | auth > adminOnly | OK: admin only |
| GET | `/api/marketing/contacts/:id` | auth > adminOnly | OK: admin only |
| **/api/marketing (routes/marketingSend) 1 routes** | | | |
| POST | `/api/marketing/campaigns/:id/send` | auth > adminOnly | OK: admin only |
| **/api/marketing (routes/marketingOverview) 5 routes** | | | |
| GET | `/api/marketing/overview` | auth > adminOnly | OK: admin only |
| PUT | `/api/marketing/moments/:id` | auth > adminOnly | OK: admin only |
| POST | `/api/marketing/moments/:id/dismiss` | auth > adminOnly | OK: admin only |
| DELETE | `/api/marketing/moments/:id/dismiss` | auth > adminOnly | OK: admin only |
| GET | `/api/marketing/sent` | auth > adminOnly | OK: admin only |
| **/api/public/reviews (routes/publicReviews) 1 routes** | | | |
| GET | `/api/public/reviews/` | none | OK: curated public data |
| **/api/public/tip (routes/publicTip) 2 routes** | | | |
| GET | `/api/public/tip/:token` | none | OK: UUID guard; allowlist; sign projection |
| POST | `/api/public/tip/:token/feedback` | none | OK: UUID guard; IP+token limiter |
| **/api/public/feedback (routes/publicFeedback) 2 routes** | | | |
| GET | `/api/public/feedback/:token` | none | OK: UUID guard; archived 404 |
| POST | `/api/public/feedback/:token` | none | OK: UUID guard; unique per proposal |
| **/api/thumbtack (routes/thumbtack) 3 routes** | | | |
| POST | `/api/thumbtack/leads` | verifyWebhook | OK: verifyWebhook (timing-safe; dev-open without secret by design) |
| POST | `/api/thumbtack/messages` | verifyWebhook | OK: verifyWebhook |
| POST | `/api/thumbtack/reviews` | verifyWebhook | OK: verifyWebhook |
| **/api/sms (routes/smsOptIn) 1 routes** | | | |
| POST | `/api/sms/opt-in` | none | OK: rolls back any non-applied consent; no identity mutation |
| **/api/sms (routes/sms) 6 routes** | | | |
| POST | `/api/sms/inbound` | none | OK: Twilio signature (prod fail-closed; dev allow by design) |
| POST | `/api/sms/status` | none | OK: Twilio signature (prod fail-closed) |
| GET | `/api/sms/conversations` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/sms/conversations/:clientId` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/sms/conversations/:clientId/reply` | auth > requireAdminOrManager | OK: admin/manager |
| PUT | `/api/sms/conversations/:clientId/read` | auth > requireAdminOrManager | OK: admin/manager |
| **/api/telegram (routes/telegram) 1 routes** | | | |
| POST | `/api/telegram/:secret` | none | OK: header secret AND path secret; 403 always |
| **/api/voice/lead (routes/voiceLeadCall) 3 routes** | | | |
| POST | `/api/voice/lead/answer` | none | OK: fail-closed signature |
| POST | `/api/voice/lead/digit` | none | OK: fail-closed signature |
| POST | `/api/voice/lead/status` | none | OK: fail-closed signature |
| **/api/voice/consult (routes/voiceConsultCall) 4 routes** | | | |
| POST | `/api/voice/consult/answer` | none | OK: fail-closed signature |
| POST | `/api/voice/consult/digit` | none | OK: fail-closed signature |
| POST | `/api/voice/consult/dialend` | none | OK: fail-closed signature |
| POST | `/api/voice/consult/status` | none | OK: fail-closed signature |
| **/api/voice/escalate (routes/voiceEscalate) 4 routes** | | | |
| POST | `/api/voice/escalate/` | none | OK: fail-closed signature + cap/claim |
| POST | `/api/voice/escalate/whisper` | none | OK: fail-closed signature |
| POST | `/api/voice/escalate/accept` | none | OK: fail-closed signature |
| POST | `/api/voice/escalate/done` | none | OK: fail-closed signature |
| **/api/voice/vm (routes/voicemailListen) 1 routes** | | | |
| GET | `/api/voice/vm/:token` | none | OK: UUID guard; 30-day; kill switch; recording SID from row |
| **/api/voice (routes/voiceAssets) 2 routes** | | | |
| GET | `/api/voice/greeting.mp3` | none | OK: fixed asset map |
| GET | `/api/voice/audio/:name` | none | OK: own-property map |
| **/api/voice (routes/voice) 6 routes** | | | |
| POST | `/api/voice/inbound` | none | OK: fail-closed signature |
| POST | `/api/voice/inbound/primary` | none | OK: fail-closed signature |
| POST | `/api/voice/bridge` | none | OK: signature (prod fail-closed; dev allow by design) |
| POST | `/api/voice/status` | none | OK: signature (prod fail-closed; dev allow by design) |
| POST | `/api/voice/inbound/missed` | none | OK: fail-closed signature |
| POST | `/api/voice/inbound/voicemail` | none | OK: fail-closed signature |
| **/api/invoices (routes/invoices) 6 routes** | | | |
| GET | `/api/invoices/t/:token` | none | OK: UUID guard; void excluded; refund reason withheld |
| GET | `/api/invoices/recent` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/invoices/proposal/:proposalId` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/invoices/proposal/:proposalId` | auth > requireAdminOrManager | OK: admin/manager |
| PATCH | `/api/invoices/:id` | auth > requireAdminOrManager | OK: admin/manager |
| GET | `/api/invoices/client/:proposalToken` | clientAuth | OK: token AND client_id |
| **/api/service-extensions (routes/serviceExtensions) 6 routes** | | | |
| POST | `/api/service-extensions/t/:token/accept` | none | OK: UUID guard; pending/expiry guards |
| GET | `/api/service-extensions/eligibility/:shiftId` | auth | OK: requireAssignment predicate |
| POST | `/api/service-extensions/` | auth | OK: requireAssignment + limiter + FOR UPDATE |
| GET | `/api/service-extensions/proposal/:proposalId` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/service-extensions/:id/override` | auth > requireAdminOrManager | OK: admin/manager |
| POST | `/api/service-extensions/:id/cancel` | auth > requireAdminOrManager | OK: admin/manager |
