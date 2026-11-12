# AUTH fixes: lane `audit-auth` (/home/user/worktrees/audit-auth, cut from main at 13f2645)

Eight commits, one per finding plus one test-only follow-up; working tree clean; nothing pushed. Environment: no database (every DB-backed suite dies with `connect ECONNREFUSED 127.0.0.1:5432`) and no `client/node_modules` (no client test or build could run; no client file was changed). Every finding got a pure test that runs here and fails on the old code for the finding's reason, plus a DB-backed sibling in the neighbouring suite's style where the path is DB-backed.

## Per finding

### AUTH-01 (high) CONFIRMED-FIXED: 4dadd63 (+ 9ffc365, a test fixture follow-up)
- Files: `server/routes/staffPortal.js`, `server/routes/me.js` (both: `router.use(auth); router.use(requireOnboarded);` with a header paragraph), `server/routes/staffShiftActions.js` (`requireOnboarded` on `POST /requests/:shiftId/claim-cover`), `ARCHITECTURE.md` (generated route table: guard chains), `server/routes/mePush.test.js` (staff fixture now `approved`, so its 403s keep coming from the role guard), `server/routes/staffPortal.test.js` (DB-backed case: an `in_progress` user gets 403 on `/staff-home`), new `server/routes/staffPortal.onboardedGate.test.js`; follow-up 9ffc365: `server/routes/staffPortal/accountReads.test.js` seeds its users-only "new hire" as `submitted` instead of `applied` (it drives `/profile`, `/calendar-settings`, `/documents` expecting 200, which the gate would now refuse).
- Decision: whole-router gate on staffPortal.js and me.js, no exceptions; claim-cover at the route. Evidence: every client call to `/me/*` (grep `api.<verb>('/me` over client/src) is on a page behind `RequirePortal` (HomePage, PayPage, PayoutDetail, TipCardPage, the account sections, StaffShellWithThemeWiring), an admin surface (NotificationSettings, NotificationsPhone, adminPush, admin-sw.js) or the standalone tip-sign download; the onboarding pages (Application, ApplicationStatus, PreHireOnboarding, Welcome, FieldGuide, Agreement, ContractorProfile, PaydayProtocols, Completion, Layout) call only `/auth`, `/application`, `/progress`, `/agreement`, `/contractor`, `/payment`. `RequirePortal`'s status set equals `requireOnboarded`'s. Admin and manager pass the gate whatever their status, so the mobile admin's `/notification-preferences`, `/push-subscriptions` and `/push-test` are unaffected. mePush.js already ran `requireAdminOrManager`; payment.js and emailChange.js stay on bare auth as instructed. The other three staffShiftActions routes keep their ownership predicates (a non-onboarded account owns no shift_requests).
- Test: `staffPortal.onboardedGate.test.js` (real routers over HTTP, stubbed pool via the `pool.query = ...` seam of sms.status.test.js): on the old code `GET /api/me/staff-home: expected 403, got 200 {...cover_broadcasts...}`; after: 5/5 (every route of both routers plus claim-cover refused for `in_progress` before any handler query; approved staffer reaches `/staff-home` (200) and claim-cover (409 `no_active_cover_request`); admin passes whatever its status; unknown token still 401). DB-backed cases: could not run here.
- Side effect to know: `client/src/pages/staff/DownloadTipSign.jsx` (mounted outside RequirePortal) now gets a 403 for a non-onboarded user and shows its load error; such a user has no tip page, so this is correct, and no client change was made.

### AUTH-02 (high, was PLAUSIBLE) CONFIRMED-FIXED: fc8f623

> Superseded before ship. The second-row design below is the fixer's round-1 record; the owner chose a different design on 2026-11-11, and what shipped is in "What shipped (2026-11-11)" at the end of this file. `clientDedup.phoneMatch.test.js` is now `clientDedup.stampEmail.test.js`.

- Re-verified: `findOrCreateClientDetailed` phone+name match on an email-less row ran `UPDATE clients SET email = COALESCE(email, $2)`; `public.js:303` called it with the wizard's name/email/phone; `clientAuth.js` resolves the OTP target by `LOWER(email)`; `clientPortal.js` lists every proposal token of `client_id = req.user.id`. The DB precondition (email-less rows with knowable names) is what the Thumbtack webhook creates and what the harvester queues, per the code comments; not observable here.
- Fix: `phoneMatch` option (default true) on `findOrCreateClientDetailed`; the wizard passes `phoneMatch: false`, so on the public path an existing row is resolved by email as-is or not at all, and the submitter gets a row of their own. Why this and not "resolve without the UPDATE": there is no per-proposal email column (`proposals` has none; the wizard's own send merges the body email in, but every later sender reads `clients.email`), so attaching the proposal to an email-less row would have silently dropped the submitter's address and lost their invoice and lifecycle mail. Cost of the chosen behavior (product-visible, for the owner): a returning phone-only Thumbtack lead who uses the website wizard becomes a second client row carrying their email, to merge by hand; `mergeClients` is still unwired (tech-debt register M-6). The admin proposal-create (crud.js) keeps the default and the backfill it exists for (the Jim case, plan 2026-06-03); the Thumbtack trusted path is unchanged; smsOptIn.js keeps its rollback and its default call (its two comment parentheticals now name crud.js as the backfill's owner instead of the wizard).
- Files: `server/utils/clientDedup.js`, `server/routes/proposals/public.js`, `server/routes/smsOptIn.js` (comments only), `server/utils/clientDedup.test.js` (first case retitled as the admin path it always was, plus a wizard case), new `server/utils/clientDedup.phoneMatch.test.js`, new `server/routes/proposals/public.clientMatch.test.js`.
- Test: `clientDedup.phoneMatch.test.js` (fake pg client recording every statement): on the old code `the stranger must not be handed the phone-only client` (expected id 42 not to be returned); after: 4/4 (no `UPDATE clients SET email` and no phone lookup on the public path; default path still backfills with `COALESCE(email, $2)`; email match resolves as-is; no-phone path inserts). DB-backed: `clientDedup.test.js` (+1 case) and `public.clientMatch.test.js` (seed a phone-only row, submit the wizard with its name+phone and a fresh email over the real router, assert the row's email stays NULL and the proposal hangs off a new row, then `POST /api/client-auth/request` with the new email leaves the victim's `auth_token` NULL): could not run here.

### AUTH-03 (high) CONFIRMED-FIXED: 0972b24
- Files: `server/routes/calendar.js` (feed lookup: `AND (role = 'admin' OR COALESCE(onboarding_status, '') NOT IN ('deactivated', 'rejected', 'suspended'))`, the predicate of middleware/auth.js including its admin exemption; unknown-token 404), `server/routes/admin/users.js` (only the status route's rejected/deactivated UPDATE: `calendar_token = gen_random_uuid(), calendar_token_created_at = NOW()`, one hunk), new `server/routes/calendar.feedStatus.test.js`, new `server/routes/calendar.feedRevocation.test.js`.
- Demotion (`DELETE /api/admin/managers/:id`) does not rotate, as the brief anticipated: the feed re-reads the role on every poll, so a demoted staffer's feed narrows to their own approved shifts on the next one. `suspended` has no live writer (db/index.js note), so the rotation covers the two reachable states and the feed predicate all three.
- Test: `calendar.feedStatus.test.js` (real routers, stubbed pool that applies the status predicate the lookup carries): on the old code `expected 404, got 200: BEGIN:VCALENDAR` for each of the three statuses, plus the missing rotation; after: 8/8. DB-backed `calendar.feedRevocation.test.js` (deactivate via the real status route, old URL dead, fresh token refused, re-activate, old URL still dead, fresh token 200): could not run here.

### AUTH-04 (medium) CONFIRMED-FIXED: 6db2451
- Files: `server/routes/clientAuth.js` (the increment is now one conditional UPDATE, `auth_token IS NOT NULL AND COALESCE(auth_token_attempts, 0) < 5 ... RETURNING auth_token, auth_token_expires_at`, before the compare; zero rows is the existing invalidate-and-neutral-400 branch; the compare runs on the returned hash; the post-compare increment is gone; the SELECT no longer projects the counter), new `server/routes/clientAuth.otpRace.test.js`.
- `clientAuth.otpNeutral.test.js` semantics kept (a row seeded at 5 attempts: claim returns no row, token cleared, counter reset, neutral 400 identical to the unknown-email answer). The schema.sql comment was NOT changed: it never described the order (the brief's condition), and the three-line note I first added shifted 220 generated `schema.sql:NNNN` references in ARCHITECTURE.md, so I dropped it; the order is documented at the route.
- Test: `clientAuth.otpRace.test.js` (real router, stubbed pool emulating the statements on one row, bcrypt.compare stubbed to count and take 30 ms, 20 concurrent verifies from 20 `X-Forwarded-For` addresses under `trust proxy 1`): on the old code `the ceiling allows 5 compares, 20 ran`; after: 4/4 (at most 5 compares, OTP invalidated, counter reset, no unconditional increment; ceiling and unknown-email bodies identical; the right code within the ceiling logs in; a wrong code counts once). DB-backed otpNeutral and revocation suites: could not run here.

### AUTH-05 (low) CONFIRMED-FIXED: 4d0db81
- Files: `server/utils/eventDetailsPayload.js` (`admin_notes: canSeeContact ? dp.admin_notes : null`, header note), new `server/utils/eventDetailsPayload.adminNotes.test.js`. The staff page's `NotesCard` returns nothing for a null body; both routes (beo.js, eventDetails.js) share the builder.
- Test (pure, builder over a stubbed pool): on the old code the browsing staffer received the note; after: 3/3 (browsing staffer: null notes and null phone; assigned staffer and admin: the note). DB-backed eventDetails/beo suites: could not run here.

### AUTH-06 (low) CONFIRMED-FIXED: 8f3bfea
- Files: `server/routes/blog.js` (`PUBLIC_IMAGE_KEY_RE = /^(?:blog|email)_<uuid v4 lowercase>(?:$|\.[A-Za-z0-9]{1,16}$)/`, checked before any signing; 404 otherwise), new `server/routes/blog.images.test.js`. No object moved, no URL changed; r2Proxy's `assertKeyUnder` is a single-prefix check that pulls in sharp, so the shape is pinned in the route. Assumption to confirm on prod data: every stored `cover_image_url` basename is `blog_<uuid>`/`email_<uuid>` plus an alphanumeric extension (the three writers produce exactly that; `path.extname` of an exotic upload name could in theory carry other characters).
- Test (real router; presign stubbed on the storage exports before the router loads; global fetch swapped): on the old code a headshot key and a W-9 key were answered 200 from the stub; after: 3/3 (headshot refused before signing or fetch; ten other root shapes refused; `blog_<uuid>.png`, `email_<uuid>.jpg`, `.JPEG` and no-extension pass through and proxy).

### AUTH-07 (low) CONFIRMED-FIXED: 3157d19
- File: `server/routes/auth.js` (`console.warn('Failed login attempt for user', user.id, 'from IP', req.ip)`). Grep `console\.(warn|log|error).*email` over the file: only the reset-mail error object remains. No test (the siblings do not assert log lines).

### AUTH-11 (low) CONFIRMED-FIXED by 4dadd63
- `POST /api/me/request-email-change` lives in staffPortal.js, so the router-wide `requireOnboarded` closes the oracle to self-registered accounts; the gate test lists the route. The 409 `EMAIL_IN_USE` for onboarded users is unchanged (a spec'd "helpful reason"); a neutral answer would be a spec change and was not made.

## Not touched (as instructed)
AUTH-08, AUTH-09, AUTH-10 (e-signature and payouts lanes); `server/routes/admin/users.js` outside the status route's one UPDATE; `admin/payroll*.js`, `contractorTipPage.js`, `shifts.handlers.js`, `shifts.approval.js`, `payrollAccrual.js`; `payment.js` and `emailChange.js` stay on bare auth.

## Commits on the branch (`git log --oneline main..HEAD`)
```
9ffc365 fix(auth): the accountReads new-hire fixture passes the /api/me onboarding gate
3157d19 fix(auth): the failed-login log line names the user id, not the submitted address
8f3bfea fix(auth): the public blog image proxy serves only blog and email-designer keys
4d0db81 fix(auth): the drink plan's admin_notes ride the event-details contact gate
6db2451 fix(auth): the client OTP verify claims an attempt before the compare, so a concurrent burst cannot pass the ceiling
0972b24 fix(auth): the calendar feed fails closed on account status and deactivation rotates the feed token
fc8f623 fix(auth): the public quote wizard never resolves or stamps a stranger's phone-only client row
4dadd63 fix(auth): the /api/me routers and the cover claim refuse a non-onboarded account
```
25 files, +1356/-66 (1,000+ of it new tests). Every commit carries the `Audit:` line and the session trailer; the pre-commit hook (docs check, file-size ratchet, eslint via lint-staged, main guard) passed on each.

## Suites run here (`NODE_ENV=test node --test`)
- New pure suites, on the committed tree: staffPortal.onboardedGate 5/5, clientDedup.phoneMatch 4/4, calendar.feedStatus 8/8, clientAuth.otpRace 4/4, eventDetailsPayload.adminNotes 3/3, blog.images 3/3 (27/27). Each was run on the old code first and failed for its finding's reason (quoted above).
- Existing pure suites beside the changed files and the auditor's set: me.notificationPrefs, tokens, sentryScrub, fileValidation, r2Proxy, middleware/corsOptions, legalHold: 74/74.
- `npx eslint` over every changed server file: 0 errors (44 pre-existing warnings; the one warning my code introduced, `detect-unsafe-regex` on the blog key regex, was removed by flattening the optional extension group). `node scripts/gen-docs.js --check` on HEAD: clean. Client tests and build: could not run (no `client/node_modules`); no client file changed.

## Suites that could not run (DB-backed, ECONNREFUSED)
staffPortal.test.js (+1 case), staffPortal/accountReads.test.js (fixture change), mePush.test.js (fixture change), clientDedup.test.js (+1 case, 1 retitled), proposals/public.clientMatch.test.js (new), calendar.feedRevocation.test.js (new), and the untouched siblings whose assertions I read for consistency: clientAuth.otpNeutral, clientAuth.revocation, eventDetails, beo, emailChange, adminCoverSwaps, shifts.bonus, staffShiftActions, me.tipPage, the other staffPortal suites (all seed `approved` users, so the gate does not change their outcomes).

## For the reviewer, first
1. AUTH-02's behavior choice (fc8f623): the wizard de-dupes on email only now; a returning phone-only Thumbtack lead who uses the website wizard becomes a second client row. This is a product-visible trade, chosen because the alternative silently drops the submitter's email from the record and loses their invoice mail; the owner may prefer a different merge story. (The owner did: see "What shipped (2026-11-11)" at the end.)
2. AUTH-01's router-wide gate (4dadd63): the inventory of gated routes is in the test; `DownloadTipSign` outside RequirePortal now sees a 403 for non-onboarded users.
3. AUTH-03's feed predicate mirrors auth.js including the admin exemption; if the owner wants no exemption on the feed, drop `role = 'admin' OR`.
4. AUTH-06's extension charset assumption on stored cover image basenames.
5. Soft file-size warnings printed by the hook, all pre-existing over-700 files: staffPortal.js 811, staffShiftActions.js 972 (+4 lines here; the hard cap is 1000), admin/users.js 780.

---

# Round 2 (verify pass follow-ups)

Three more commits on `audit-auth` (now 11 commits, tree clean, nothing pushed). Client tooling was available this round (`client/node_modules` linked), so the client Jest test and a `CI=true react-scripts build` ran.

### AUTH-12 (high, new from the verify pass) CONFIRMED-FIXED: 97ad261
- Re-verified: `findOrCreateClientDetailed`'s email-match branch resolves the row as-is and `public.js` attaches the proposal to it (`clients.email` is unique, so it must); the 201 handed back `proposal.token`; `publicToken.js` then served the row's `client_name` and the row's phone as `client_phone_prefill`. One more exposure the verify pass did not name: the post-commit `sendProposalSentEmail` texts `proposal.client_phone`, which public.js filled from the request body, so on a matched row the stranger's own phone would have received the proposal link by SMS and a withheld token alone would not have closed the path.
- Fix (server, `server/routes/proposals/public.js`): the client-prefs read also fetches the row's `phone` and `email`; for a submit that resolved to an EXISTING row (any match path) the proposal-sent email goes to the row's email and any SMS to the row's phone, never the submitted one, and the 201 is `{ token: null, delivered_to: 'v***@example.com', total, top_shelf }` (`maskEmail`: first character of the local part plus the domain; the submitter typed the address, so the mask reveals nothing to them); a submit that CREATED the row keeps `{ token, total, top_shelf }` and the submitted contact. The activity-log details gain `client_matched` so the admin can tell a returning client's quote from a stranger's.
- Fix (client): one shared panel `client/src/pages/website/quoteWizard/SubmitSuccess.js`, rendered by both consumers of the 201 (`QuoteWizard.js`, `ClassWizard.js`): with a token the existing copy and the "View Your Proposal" link; with `token: null` the heading "Check your email", the masked address, and no link (top-shelf variant: "We'll follow up with custom Top Shelf pricing at v***@example.com"). `QuoteWizard.js` dropped its now-unused `formatCurrency` import (a CI build fails on it). README's generated tree lists the new file. No other consumer of the submit's 201 exists (repo-wide grep: the two wizards only).
- `client_phone_prefill` for a matched proposal: left to the withheld token, as the brief allowed. Not cheap: the proposal row does not record how its client was resolved, so the public page would need an activity-log read on its hottest path or a schema column; `client_matched` in the activity log records the fact for the admin instead.
- Product-visible (for the owner): a returning client who re-quotes with their own email no longer lands on the proposal page from the wizard; they see "Check your email" and open the link from their inbox. The 201 now differs between a new and a known email, which is inherent to the chosen design.
- Tests: `server/routes/proposals/public.submitMatched.test.js` (real router over HTTP, table-keyed stubbed pool through the whole 'sent' transaction including `createInvoiceOnSend`, the send captured through `sendProposalSentEmail.__setDeps`): on the old code the matched submit returned the token (`actual: '0f3d2b4a-...'`); after, 2/2 (matched: token null and absent from the raw body, `delivered_to` masked, the proposals INSERT carries the victim's client_id, no `INSERT INTO clients`, no `UPDATE clients SET email|phone`, mail to the row's email, SMS only to the row's phone; new: token present, a client row inserted, delivery to the submitted contact). Client: `SubmitSuccess.test.js` 6/6 under `react-scripts test` (the wizard had no Jest tests before); `CI=true react-scripts build` exit 0, "Compiled with warnings" being one pre-existing source-map warning from `html2pdf.js` in node_modules, nothing from this code (an eslint warning fails a CI build, and none did).

### L3 (low) CONFIRMED-FIXED: ce91afd (follow-up to AUTH-06)
- Reader (`server/routes/blog.js`): the `blog_`/`email_` prefix plus the lowercase uuid stay the security; the extension is any 0-32 characters after the dot that are not `/`, `\`, whitespace or `..` (`isPublicImageKey`).
- Writers: `server/routes/admin/blog.js`'s upload route and its JSON importer now store `safeUploadExtension`'s extension (the repo's existing sniffed-bytes helper, used by payment.js, contractor.js and menuDraftApprove.js), so a new key is always `blog_<uuid>.jpg|.png|.webp`; `emailMarketing/designer.js` already derives its extension from the decoded format and is unchanged.
- Test: `blog.images.test.js` gained the exotic cases; on the old reader `blog_<uuid>.final-v2 must pass, got 404`; after 5/5 (passing: `.final-v2`, a bare dot, 27 and 32 characters, `.PNG`; refused: a slash, a backslash, a space, a tab, a newline, `..jpg`, `.a..b`, 33 characters). A `.jpg (1)` basename (a space) is refused by the rule as specified; if a stored cover ever carried one it would 404, which the rule accepts.

### L2 (note) DONE: 569bc43 (test-only, `Audit: AUTH-03, AUTH-04`)
- Both stubs now evaluate the predicate from the SQL: `calendar.feedStatus.test.js` parses the `[NOT] IN (...)` list on `onboarding_status` (COALESCE included) and the `role = 'admin' OR` exemption and applies them to the fixture row (14 lines); `clientAuth.otpRace.test.js` parses `auth_token IS [NOT] NULL` and `COALESCE(auth_token_attempts, 0) <op> N` and applies them (16 lines).
- Mutation-checked against the real code, then restored (git diff empty before committing): the feed predicate inverted to `IN` fails the suite 5 of 8; the claim loosened to `<= 5` fails the race test with "the ceiling allows 5 compares, 6 ran". Both suites pass 12/12 on the real code.
- Process note: my first commit of this change (fa050d3) carried a `claude.ac` typo in the session trailer; it was unpushed, so I recut it with `git reset --soft HEAD~1` and a new commit (569bc43), the lane-sanctioned way, with no amend. Every trailer on the branch is now correct (11/11).

### L4 (note, no change) — for the owner
With `phoneMatch: false` (fc8f623) a returning phone-only Thumbtack lead who uses the website wizard becomes a second client row holding their email. When the Thumbtack harvester (`server/routes/thumbtackAgent.js` ~255-279) later captures that same address for the Thumbtack row, the unique index on `clients.email` refuses the write and the harvester marks that row's harvest `failed` (with its alert) until the admin merges the pair. The harvester is unchanged; `mergeClients` is still unwired (tech-debt register M-6), so the merge is by hand today.

## Commits on the branch after Round 2 (`git log --oneline main..HEAD`)
```
569bc43 fix(auth): the feed-status and OTP-race stubs evaluate the real predicates instead of matching strings
ce91afd fix(auth): the blog image reader accepts any stored extension shape and the writers store a sanitized one
97ad261 fix(auth): the public quote wizard withholds the proposal token and delivers only to the address on file when the submit matched an existing client
9ffc365 fix(auth): the accountReads new-hire fixture passes the /api/me onboarding gate
3157d19 fix(auth): the failed-login log line names the user id, not the submitted address
8f3bfea fix(auth): the public blog image proxy serves only blog and email-designer keys
4d0db81 fix(auth): the drink plan's admin_notes ride the event-details contact gate
6db2451 fix(auth): the client OTP verify claims an attempt before the compare, so a concurrent burst cannot pass the ceiling
0972b24 fix(auth): the calendar feed fails closed on account status and deactivation rotates the feed token
fc8f623 fix(auth): the public quote wizard never resolves or stamps a stranger's phone-only client row
4dadd63 fix(auth): the /api/me routers and the cover claim refuse a non-onboarded account
```
Round 2 diff: 12 files, +442/-58 (README.md +1 generated line). Every commit passed the pre-commit hook (docs check, file-size ratchet, eslint via lint-staged, main guard); the hook's soft warning on `QuoteWizard.js` (830 lines, pre-existing over 700) is noted.

## Suites run on the final tree
- New pure suites (7): staffPortal.onboardedGate 5/5, clientDedup.phoneMatch 4/4, calendar.feedStatus 8/8, clientAuth.otpRace 4/4, eventDetailsPayload.adminNotes 3/3, blog.images 5/5, public.submitMatched 2/2 (31/31).
- Existing pure suites: me.notificationPrefs, tokens, sentryScrub, fileValidation, r2Proxy, middleware/corsOptions, legalHold: 74/74.
- Client: `SubmitSuccess.test.js` 6/6 (react-scripts test); `CI=true react-scripts build` exit 0.
- `npx eslint` over every changed server file on the branch: 0 errors (49 pre-existing warnings); client eslint on the four changed client files: clean. `node scripts/gen-docs.js --check` on HEAD: clean. PII scan of the round-2 diff: example.com addresses and 555 numbers only.
- Could not run (DB-backed, ECONNREFUSED): the round-1 list, unchanged; `publicSmsConsent.test.js` (same route, file untouched) and `public.clientMatch.test.js` would exercise the changed submit on the dev box.

## For the reviewer, first (Round 2)
1. AUTH-12's response shape and the product trade (97ad261): `token: null` plus `delivered_to` for a matched row; a returning client re-quoting with their own email now reads "Check your email".
2. The delivery change on a matched row: SMS goes to the phone on file, not the submitted one; a returning client who entered a new number gets the SMS at the old one (the email carries the link either way).
3. L4: the harvester consequence of fc8f623, for the owner.
4. The soft-reset recut of the L2 commit (no amend, no push).

---

# Round 3 (the last fix round)

Five more commits on `audit-auth` (now 16 commits, tree clean, nothing pushed, no amend). Every item got its failing or strengthened test first; the mutation checks edited the real file, ran the suite, and restored it (git diff empty before each commit).

### AUTH-13 (medium, new from the re-pass) CONFIRMED-FIXED: de49b05
- Re-verified: the submit handler held its `pool.connect()` client through the post-COMMIT tail and released it only in the `finally`; the tail queries through the pool (`notifyAdminCategory`'s admin lookup, `sendAndLogSms`, `loadProposalForHandler`, `hasLiveSiblingDrip`) and `scheduleDripForProposal`'s six concurrent `scheduleMessage` calls each take their own pooled connection: the SERVER-17 shape of the one-connection rule.
- Fix (`server/routes/proposals/public.js`): `dbClient.release()` right after COMMIT behind a `held` flag; the catch's ROLLBACK and the finally's release run only while the client is still held; the tail and its error handling are unchanged. No other `dbClient` use remains after COMMIT (checked).
- Test: `public.submitMatched.test.js`'s stub now tags every statement and release by connection (`held`, `pool`, `connN`); the new ordering case fails on the old code with "held client released at 26, first tail query at 23: held:COMMIT | pool:SELECT u.id ... | pool:SELECT p.id, p.token ... | pool:SELECT 1 FROM proposals me JOIN proposals sib ... | held:release" and passes after, with the release observed exactly once and nothing touching the client afterwards.

### L3 (low) CONFIRMED-FIXED: 6188f03 (`Audit: AUTH-12`)
- `sendProposalSentEmail` now resolves to `{ emailSent }` (set after a successful `sendEmail` await; every early return carries it); its swallow-and-log behavior is unchanged and its four other callers ignore the result. Its header paragraph grew, so README's generated tree line for it is regenerated in the same commit.
- `public.js`: the matched 'sent' path answers `delivered_to` only when the mail went out, else `{ token: null, delivered_to: null, delivery_failed: true, total, top_shelf }`; the new-row branch is unchanged; Top Shelf keeps its address-on-file promise because it sends the client no mail by design (the admin follows up at that address).
- `SubmitSuccess.js`: `delivery_failed` renders "We'll follow up shortly" with "We couldn't send the link just now. We'll follow up at the address on file, or reach us at (224) 222-1922" (`COMPANY_PHONE` / `COMPANY_PHONE_TEL` from `client/src/utils/constants.js`, the client mirror of `server/utils/companyPhone.js`, as a tel link), no delivery claim, no link.
- Tests: the route case fails on the old server code with `delivered_to: 'v***@example.com'` after a failed send (expected null; proven by reverse-applying the server diff from a scratchpad patch, then re-applying it byte-identically); after, the route suite is 4/4 and `sendProposalSentEmail.test.js` 9/9; `SubmitSuccess.test.js` gains the fallback case, 7/7 under react-scripts.

### L5 (low, test leak) FIXED: efce4d6 (`Audit: AUTH-12`, DB-backed, could not run here, read twice)
- `publicSmsConsent.test.js`'s takeover case now asserts the second submit's withheld token and collects every proposal of the client (`SELECT id FROM proposals WHERE client_id = $1`, expecting two) into `createdProposalIds`; the suite's existing `after()` already deletes invoice payments, invoices, proposal payments, the proposal's scheduled messages (the six drip rows) and the proposals by those ids, then the client.

### L1 (low, test oracle) FIXED: 5222915 (`Audit: AUTH-03`, test-only)
- `calendar.feedStatus.test.js`'s stub coalesces only when the SQL carries `COALESCE(onboarding_status, '')`; otherwise a NULL status is treated the way Postgres treats `NULL [NOT] IN (...)` (excluded either way). A third fixture user (a manager with `onboarding_status: null`) must still get a 200 feed. Mutation-checked: with the COALESCE dropped from calendar.js the new case fails (8/9); 9/9 on the real code.

### L2 (low, test oracle) FIXED: 8dc5645 (`Audit: AUTH-04`, test-only)
- `clientAuth.otpRace.test.js` routes the claim by either spelling (`COALESCE(auth_token_attempts, 0) + 1` or the bare `auth_token_attempts + 1`), reads predicates only from the WHERE clause, and takes a one-shot `afterSelect` hook. The interleaving was staged within the harness (about 15 lines): the new case reads a live token, clears the fixture between that read and the claim, sends the RIGHT code, and asserts no row claimed, no compare, and the neutral 400. Mutation-checked: with `auth_token IS NOT NULL` dropped from the claim the new case fails; with the claim rewritten to the bare column the suite still passes (5/5); 5/5 on the real code.

## Commits on the branch after Round 3 (`git log --oneline main..HEAD`)
```
8dc5645 fix(auth): the OTP-race stub reads the claim in either spelling and stages a token invalidated between a request's read and its claim
5222915 fix(auth): the feed-status stub applies the COALESCE only when the SQL carries it, and a NULL-status row must keep its feed
efce4d6 fix(auth): the consent suite's takeover case cleans up the second proposal the withheld token hid from it
6188f03 fix(auth): the wizard's matched-client response claims the delivery only when the proposal mail went out
de49b05 fix(auth): the public quote wizard releases its pooled client right after COMMIT, before the post-commit tail
569bc43 fix(auth): the feed-status and OTP-race stubs evaluate the real predicates instead of matching strings
ce91afd fix(auth): the blog image reader accepts any stored extension shape and the writers store a sanitized one
97ad261 fix(auth): the public quote wizard withholds the proposal token and delivers only to the address on file when the submit matched an existing client
9ffc365 fix(auth): the accountReads new-hire fixture passes the /api/me onboarding gate
3157d19 fix(auth): the failed-login log line names the user id, not the submitted address
8f3bfea fix(auth): the public blog image proxy serves only blog and email-designer keys
4d0db81 fix(auth): the drink plan's admin_notes ride the event-details contact gate
6db2451 fix(auth): the client OTP verify claims an attempt before the compare, so a concurrent burst cannot pass the ceiling
0972b24 fix(auth): the calendar feed fails closed on account status and deactivation rotates the feed token
fc8f623 fix(auth): the public quote wizard never resolves or stamps a stranger's phone-only client row
4dadd63 fix(auth): the /api/me routers and the cover claim refuse a non-onboarded account
```
Branch total: 34 files, +1956/-119; round 3: 9 files, +198/-34. Every commit passed the pre-commit hook; every trailer is correct (16/16).

## Final verification on HEAD
- `node scripts/static-checks.js --base 13f2645 --tip HEAD`: findings [], blocking 0, allowed 0 (34 files, 28 eslint files).
- New and neighbouring pure suites (`NODE_ENV=test node --test`): staffPortal.onboardedGate, clientDedup.phoneMatch, calendar.feedStatus (9), clientAuth.otpRace (5), eventDetailsPayload.adminNotes, blog.images, public.submitMatched (4), sendProposalSentEmail (9), me.notificationPrefs, tokens, sentryScrub, fileValidation, r2Proxy, middleware/corsOptions, legalHold: 118/118.
- Client: `SubmitSuccess.test.js` 7/7 (react-scripts test). The round-2 `CI=true react-scripts build` is not re-run this round; the only client change since is inside `SubmitSuccess.js` (an import from constants.js and one branch), which the client eslint pass covers.
- eslint: every changed server file on the branch, 0 errors (50 pre-existing warnings); every changed client file, clean. `node scripts/gen-docs.js --check` on HEAD: clean. PII scan of the round-3 diff: example.com addresses, 555 numbers and the business line `(224) 222-1922` only (the business lines are not exposures per CLAUDE.md).
- Could not run (DB-backed, ECONNREFUSED): the round-1 list, unchanged, plus `publicSmsConsent.test.js` (edited this round, read twice).

## For the reviewer, first (Round 3)
1. AUTH-13 (de49b05): the `held` flag and the release placement; nothing in the tail uses the client, and the tail's own try/catches are untouched.
2. L3 (6188f03): the new `{ emailSent }` return of `sendProposalSentEmail` is additive; Top Shelf's matched path keeps `delivered_to` on purpose (no client mail is sent there by design).
3. The wizard's 201 now has three shapes on the matched path (delivered, failed, top shelf); `SubmitSuccess.js` is the one consumer.

# What shipped (2026-11-11, merged and shipped as 5dc598b)

The lane's review rebuilt AUTH-02 before the merge. The owner answered "1" to this choice: "Match by name and phone again, but write nothing onto the record ... The link goes by text to the phone already on file, and the email they typed shows in the admin alert so it can be added by hand."

- `clientDedup.js`: `phoneMatch` is gone; `stampEmail` (default true) replaces it. The public wizard passes `stampEmail: false`, so its name and phone match on an email-less row still resolves, but resolve-only: the submitted email is never written onto the row. A returning phone-only client stays on their one row, and there is no second row to merge by hand. The admin create keeps the default and its backfill.
- `public.js`, a submit that matched an existing row (by email, or by name and phone): the proposal link goes only to the contact on file (the mail to the row's email, the text to the row's phone), the mail greets and the admin alert shows the row's name, and the 201 withholds the token. A phone-matched row has no email on file, so its link goes by text alone and the panel reads "Check your texts". The panel shows the masked last four digits only when the submitter typed that same number, else "the number on file".
- `sendProposalSentEmail` resolves `{ emailSent, smsSent }`. A matched link that went nowhere flags the admin alert's subject, adds a note to it, and texts the subscribed admins.
- The website quote's admin alert has its own template, `websiteQuoteAdmin` (it used to borrow the "Proposal Signed" body), and names any contact the submitter typed that the row does not hold, to add by hand once confirmed.
- Also from the review: the blog image proxy (`blog.js`) accepts the prefixes `blog_`, `email_` and `manual-art-` with a 1 to 200 character tail, because the lane's uuid rule refused every live Lab Notes image; the success panel's link contrast and wrapping.
