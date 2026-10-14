# Mobile Admin Push (lane ma-c-push) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin phone buzzes for seven kinds of event (client signed, signed and paid, payment landed, last-minute booking, drink plan submitted, shift drops, cover and swaps), each kind with its own switch under More > Notifications, with a per-phone on switch, a test row, and the honest states (off, on, blocked by Android, not set up on the server, offline).

**Architecture:** Server: one new module owns the seven kinds, the banner copy and the one "send to this user's subscriptions, prune the dead" routine; `notifyAdminCategory` gains a push leg that fires only when a call site passes a `push` block, after the category gate and the per-kind preference gate; the preferences read and write carry the kind switches and the server's VAPID public key; one new route sends a test banner. Client: the existing `pushSubscribe.js` is generalized to the admin service worker, a small state module reads this phone's real state, a pure view-model holds the screen's copy, and `NotificationsPhone` renders the benchmark's screen under the existing back-arrow chrome. The service worker learns one more allowlisted read and navigates an open window on a banner tap.

**Tech Stack:** Express 4 + `pg` raw SQL, `web-push` 3.6 (VAPID), node:test against the shared dev DB (one suite at a time); React 18, jest + RTL (jest-dom per file, CRA `resetMocks: true`), `playwright-core` driving `~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome` or `/opt/google/chrome/chrome` for the gate.

**Spec:** `docs/superpowers/specs/2026-08-13-mobile-admin-design.md`, section 7 "Push (rewritten 2026-10-14)" (the contract for the server and the states) and section 3 "Design-session decisions of 2026-10-14" (the contract for the screen), with section 7's Offline law for the one new cached read and section 8 for the revoke.

**Benchmark (Visual contract):** `docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html`, the "Notifications" screen and the More row that opens it (tweaks `notifPhone` off | on | blocked, `notifTest` idle | sent | failed, `notifLoading`, `offline`, `skin`), pulled through DesignSync on 2026-10-14 and byte-identical to the design project. It renders with `python3 -m http.server` in `docs/design-artifacts/` and a headless Chromium at 460x960 (React from unpkg: needs network); the screen opens by tapping More, then "Push notifications". The `.m-switch` family is in the vendored `docs/design-artifacts/_ds/dr-bartender-os-design-system-72035042-c993-47e2-9dc8-c452b7bf5fa4/components-mobile.css`, last 63 lines.

**Scope:** server: `server/utils/adminPush.js` (new), `server/utils/pushDispatch.js`, `server/utils/adminNotifications.js`, `server/routes/me.js`, `server/routes/mePush.js` (new), `server/index.js` (one mount line), `server/db/schema.sql` (one column), `server/routes/webauthn.js` (the revoke), nine call sites (`server/routes/proposals/public.js`, `server/routes/proposals/publicToken.js`, `server/utils/stripePaymentNotifications.js`, `server/utils/bankPaymentProcessingNotify.js`, `server/utils/lastMinuteAlert.js`, `server/routes/staffShiftActions.js`, `server/utils/smsInbound.js`, `server/routes/drinkPlans/submitNotify.js`). Client: `client/src/utils/pushSubscribe.js`, `client/src/utils/adminPush.js` (new), `client/src/utils/notificationsView.js` (new), `client/src/pages/mobile/NotificationsPhone.js` (new), `client/src/pages/mobile/MorePage.js`, `client/src/utils/screenKey.js`, `client/src/components/AdminLayout.js` (one map entry), `client/src/context/AuthContext.js` (one call in logout), `client/src/App.js` (one route), `client/public/admin-sw.js`, `client/src/index.css`. Docs: README, ARCHITECTURE, CLAUDE.md env table, `scripts/sensitive-paths.txt`, `scripts/mobile-capture.manifest.json`, walkthroughs-owed, the fix list, the spec (two sentences).

**Proven context (verified against main `20389657` on 2026-10-14):**
- `server/utils/adminNotifications.js` (147 lines): `VALID_CATEGORIES` `:9-23`; `resolveCategoryRecipients(category)` `:36-57` (its SELECT `:43-50`, its mapping `:51-56`) selects `u.id, u.email, u.communication_preferences, cp.phone` for `role IN ('admin','manager')` with `COALESCE(u.notification_preferences->>$1, 'true') = 'true'`; `notifyAdminCategory({ category, subject, emailHtml, emailText, smsBody })` `:75-145` loops recipients (email, then SMS when `smsBody` and `prefs.sms_enabled !== false`), never throws, returns `{ emailed, texted }`; exports `:147`. Test `server/utils/adminNotifications.test.js` inserts real admin, manager and staff rows into the dev DB and asserts `resolveCategoryRecipients` (additive columns are safe).
- `server/utils/pushDispatch.js` (134 lines): header comment `:1-18`, `Sentry` and `pool` requires `:20-21`, the `pushSender` require `:23` (its comment `:22`); `dispatchPushRow(row)` reads `staff_notification_preferences` with a plain query `:30-33`, marks the row `failed` when the user is gone `:34-40`, `suppressed` / `no_push_subscriptions` when there are none `:42-48`, sends each subscription through `pushSender.sendPush` `:53-69`, prunes gone endpoints in a short `FOR UPDATE` transaction `:71-110`, then records `sent` (breadcrumb `push_partial_prune` when some were gone) or `failed` with `all_subscriptions_gone` | `push_send_failed` `:113-133`. Its regression read is `server/utils/scheduledMessageDispatcher.test.js:923-1000`, three push-channel tests (no subscriptions suppressed; sends ok and prunes gone, keeps flaky; all fail) that monkey-patch `pushSender.sendPush` through the module object.
- `server/utils/pushSender.js`: `sendPush({ subscription, title, body, url, tag, icon })` returns `{ ok }`, `{ ok: false, gone: true }` on 410/404, `{ ok: false, error }` otherwise, and `{ ok: false, error: 'vapid_unset' }` when `VAPID_PRIVATE_KEY` is unset (checked per call). `pushSender.test.js` generates keys with `webpush.generateVAPIDKeys()` when the env has none.
- `server/routes/me.js` (303 lines): `router.use(auth)` `:18`; `NOTIFICATION_CATEGORIES` `:24-38`; `applyNotificationPrefPatch(current, patch)` `:47-75` (pure, throws `ValidationError` on an unknown key, a non-boolean, or an empty patch); `GET /notification-preferences` `:266-279`; `PATCH /notification-preferences` with `requireAdminOrManager` `:283-299`; exports `:301-303`. Test `me.notificationPrefs.test.js` pins the pure helper. Mounted at `/api/me` in `server/index.js:342`, before `./routes/staffPortal` `:346`, whose `router.use(auth)` (`staffPortal.js:45`, no role gate) hosts `POST` and `DELETE /push-subscriptions` (`staffPortal/notifications.js:134-233`; the stored entry is `{ endpoint, keys: { p256dh, auth }, user_agent, subscribed_at }`, 10-cap, evict oldest).
- `server/middleware/rateLimiters.js`: `adminWriteLimiter` `:147-154`, 10 per minute keyed `admin-<user id>` in memory, and it has NO `NODE_ENV=test` skip (the five skips at `:204`, `:233`, `:245`, `:264`, `:280` belong to other limiters), so a test file may call the test route fewer than ten times per process; repeated runs start fresh.
- There is NO `server/middleware/errorHandler.js` (the directory holds asyncHandler, auth, corsOptions, rateLimiters). The global error handler is inline at `server/index.js:446-482`; a route test writes its own, as `server/routes/webauthn.test.js:135-143` does over `AppError.statusCode` (`requireAdminOrManager` hands a `PermissionError` to `next`, `server/middleware/auth.js:88-92`).
- Call sites, each already passing the category the spec names: `server/routes/proposals/public.js:573-583` (`clientSignedAdmin`, `urgent_booking`; has `client_name`, `eventTypeLabel`, `proposal.id`); `server/routes/proposals/publicToken.js:600-608` (same template; `pd.client_name`, `eventTypeLabel`, `pd.id`); `server/utils/stripePaymentNotifications.js:188-199` (`isCoupledSigning` picks `signedAndPaidAdmin` + `urgent_booking` or `paymentReceivedAdmin` + `routine_finance`; has `pi.client_name`, `eventLabel`, `amountFormatted`, `payLabel`, `proposalId`); `server/utils/bankPaymentProcessingNotify.js:74-94` (`notifyAdminBankPaymentProcessing`; `initial` = deposit or full; `client`, `label`, `dollars`, `proposalId`; its test `bankPaymentProcessingNotify.test.js:13` replaces `require('./adminNotifications').notifyAdminCategory` with a recorder); `server/utils/lastMinuteAlert.js:31-42` (`label`, `date`, `time`, `p.id`); `server/routes/staffShiftActions.js`: the wrapper `notifyManagementOfAction({ category, subject, emailHtml, emailText, smsBody, daysOut })` `:197-222` is called by the clean drop `:329-336` (ctx has `shift_event_type`, `client_name`, `event_date`, `position`, `proposal_id`) and the cover request `:465-472`, while the swap proposal `:687-696` calls `notifyAdminCategory` directly (`sc = swapResult.shift_context` with `event_type_label`, `event_date_long`, `client_name`, `position`; `swapResult.shift_id`); `server/utils/smsInbound.js:465-471` (`alertStaffCant`, through `_deps.notifyAdminCategory`, `__setDeps` `:136`; `cant.shiftId`, `cant.clientName`, `eventLabel`, `dateStr`, `outLabel`; `handleCant` in `server/utils/smsShiftCommands.js:263-271` returns `{ ok, shiftId, requestId, eventDate, clientName, eventType, eventTypeCustom }` and NO `proposalId` or `position`, though its SELECT already reads `s.proposal_id` at `:133`; the only suite that records that alert is `server/utils/smsInbound.nearestShift.endInstant.test.js:207-241`, through `sent[0]`; `smsInbound.test.js` has none); the swap's `shift_context` (`staffShiftActions.js:641-650`) carries no `proposal_id` though `orig.proposal_id` is selected at `:527`; `server/routes/drinkPlans/submitNotify.js:79-98` (`sendFinancialSubmitNotifications`, admin email only when `balanceChanged`, with `pn.id`, `clientName`, `pn.event_type`) and `sendFastPathConfirmation(planId, selections)` `:142+` (selects `p.id`, `c.name AS client_name`, the proposal's `event_type`, `event_type_custom`). Both tails are awaited post-commit in `submit.js:622` and `:729`.
- `server/routes/webauthn.js:193-213`: the revoke deletes the credential and bumps `token_version` in one transaction on `client`. `webauthn.test.js:276` pins IDOR, the owner delete and the bump.
- `server/db/schema.sql:2969`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{...}'`; `:3772` the staff blob. `server/db/index.js` re-executes `schema.sql` on every server boot, so prod DDL self-applies; the dev DB needs the statement run by hand before the suites (Task 1).
- `client/src/utils/pushSubscribe.js`: `permissionState()` ('unsupported' | Notification.permission), `isPushSubscribed()` `:85-97`, `subscribePush()` `:108-155` (reads `process.env.REACT_APP_VAPID_PUBLIC_KEY`, registers `/staff-sw.js`, POSTs `/me/push-subscriptions`), `unsubscribePush()` `:163-185`; `/staff-sw.js` is hard-coded three times. Callers: `client/src/pages/staff/account/NotificationsSection.js:5-8` (no arguments). Test `pushSubscribe.test.js` pins `urlBase64ToUint8Array` only.
- `client/src/pages/mobile/MorePage.js` (126 lines): `InstallRow`, the NAV sections, then `<MoreSecurityRow />`, then Lighting. `MorePage.test.js` mocks AuthContext, UserPrefsContext, MoreSecurityRow and installPrompt with plain functions and renders through an `Outlet context={{ badges }}`.
- `client/src/components/AdminLayout.js:257-263`: `DETAIL_BACK = { 'event-detail': '/events', 'proposal-detail': '/proposals', 'inbox-item': '/inbox' }` decides the back-arrow header; `MobileHeader` (`client/src/components/mobile/MobileHeader.js:53-111`) renders Back (aria-label "Back", by design: it returns wherever you came from, Dallas 2026-09-30) when `onBack`, the search button only without Back, and the Desktop-view escape unless `screenKey === 'more'`, calling `setDesktopView(screenKey, true)`. `client/src/utils/screenKey.js`: `routeScreenKey` returns the first segment for `/more/...`; `TITLES` map. `client/src/context/MobileViewContext.js:31-45`: `desktopView(screenKey)`, `setDesktopView(screenKey, on)`.
- `client/src/context/AuthContext.js:112-117`: `logout` calls `purgeMobileAdminState()` then removes the token synchronously. `client/src/utils/adminSw.js:54-60` `purgeMobileAdminState`. `client/src/context/AuthContext.test.js:12` mocks `../utils/adminSw` and `../utils/api`; `AdminLayout.badges.test.js:14` mocks AuthContext whole.
- `client/public/admin-sw.js`: `SW_VERSION = 'admin-sw-2026-09-29-v10'` `:33`; `API_EXACT` `:185-196`; `isAllowlisted` `:197-212`; `notificationclick` `:376-420` focuses a window on the exact path or `openWindow`s a new one, and never navigates an open window on another path. `client/src/utils/adminSwAllowlist.test.js` runs the real file in a vm context and reads `isAllowlisted`, `SW_VERSION` and the listeners; its version assertion is the regex at `:95` (`/^admin-sw-\d{4}-\d{2}-\d{2}-v10$/`), after a `not.toBe` of the v8 name at `:94`.
- `client/src/utils/offlineRead.js`: `offlineGet(url, config)` adds `X-Offline-Ok: 1`; a cache-served response carries `res.staleAt`. `client/src/utils/staleTime.js`: `formatStaleTime(iso)`. `EventsListPhone.js:213-216` is the `.m-stale` markup ("offline copy · as of").
- `client/src/index.css`: `.m-more-row` `:21256-21274` (`span { flex: 1 }`, `svg:last-child` ink 4), `.m-seg-note` `:21328`, `.m-stale` `:21162`; `@keyframes m-pulse` at `:21543`; the sheets' reduced-motion block `:22053-22058`; the House Lights comment `:21335-21337` with the light-skin rules after it; `--link` is defined nowhere in the file. `client/src/utils/mobileClassContract.test.js:7-22` lists the phone files whose `m-*` classes must exist in `index.css`.
- `client/src/components/adminos/Icon.js` has `bell`, `chat`, `alert`, `left`, `right`, `external`.
- `scripts/mobile-capture.manifest.json:68-77`: admin pages on host `localhost` with `"auth": "admin"` and `"authAssert": ".m-shell"`; the `admin-event-detail` entry spans `:75-77`.
- Lanes share `.env` and `client/.env` by symlink (`scripts/worktree-new.js:14-15`), so a lane's server reads main's env; dev has no VAPID keys (`.env` has none; `.env.example:259-262` documents them). Prod has never stored a push subscription (checked 2026-10-14).
- Sensitive-listed (`scripts/sensitive-paths.txt`), nine lane files: `staffShiftActions.js:79`, `schema.sql:83`, `smsInbound.js:119`, `smsShiftCommands.js:125`, `submitNotify.js:294`, `server/index.js:384`, `publicToken.js:406`, `webauthn.js:436`, `AuthContext.js:438`, `admin-sw.js:440`. Full lane fleet; a merge conflict in any of them escalates to Dallas; sensitive re-review and `/second-opinion` at push.

**Decisions this plan makes** (with the spec's section 7 and the 2026-10-14 decisions list, the contract for review):
1. The push leg is fire-and-forget inside `notifyAdminCategory`: the sends start after the email and SMS loop and are NOT awaited by the caller; `adminNotifications.__flushPush()` awaits them for tests. The return gains `pushQueued` (recipients eligible), not a delivery count.
2. Bank-debit notices ride `booking_signed_paid` (initial) or `payment_landed` (later) with their own copy, "Bank payment started", never "landed".
3. A kind's banner url is a path (`/events/:id`, `/proposals/:id`); a staffing banner with no proposal id (a manual shift) opens `/staffing`.
4. The More row's state needs no server read: device permission plus the admin registration's subscription. The screen adds the server's key to that.
5. The server-unset state ("Push isn't set up on the server yet.") shows whenever the preferences read returns `push.public_key: null`; the switch is disabled and the test row reads "Phone is off".
6. `notificationclick` gains one behaviour: with no window on the exact path, it focuses an open admin window and navigates it to the target, and opens a new window only when none is open. It navigates and opens ONLY a same-origin path (the payload's url is parsed against the worker's origin; anything else becomes `/`), so a banner can never steer the app off the admin host. The spec's "changes it only for the allowlist entry" sentence is amended in Task 11. Dallas may veto this before Task 9 runs; the fallback is the fix-list line in Task 11 Step 5.
7. Logout unsubscribes this device in the browser only and never calls the server (as built: the token is removed in the same tick, so a DELETE could never carry it and would 401 into a false session-expired toast; the push service answers 410 for a browser-unsubscribed endpoint, so the server prunes the row on its next send). The screen's own Off switch keeps the server DELETE. Every entry point of the phone's push module is a no-op off the admin host, because `getRegistration('/admin-sw.js')` resolves by scope and would return the staff worker on the staff host.
8. The test endpoint answers 200 with `{ subscriptions, sent, failed, gone, reason }`; `reason` is `vapid_unset` or `no_subscriptions` when nothing could send, else null. The row reads "Didn't send" unless `sent > 0`.
9. The kind switch flips optimistically with `aria-busy` until the PATCH settles; a failed PATCH flips back and the row's trailing slot reads "Didn't save" with Retry, rendered as a sibling of the switch inside its list item (interactive content may not nest in a button).
10. The banner body carries the event date where the site has it: the five booking, payment and drink-plan builders take `dateLabel` (from `formatEventDateLong`, as the bank notice already formats it) and end the body with " · <date>"; a site without the date in hand passes nothing and the body stands without it.
11. `publicKey()` answers the public key only when the private key is also set: a server that cannot sign must not invite a subscription it can never serve.
12. The back arrow keeps the chrome's "Back" label (the event, proposal and Inbox details' precedent; it returns wherever you came from), not the benchmark's "Back to More".
13. Beyond the drawing, the screen has: a failed-load state ("Couldn't load notification settings." with Retry) when the read fails with no stored copy; two toasts when enabling fails short of a denial ("Android did not grant permission.", "Could not turn notifications on."); an `unsupported` device state (no service worker or no Push API) that hides the More row and disables the switch; and the server-unset sub-line "Not set up on the server yet" under the switch, beside the note the spec names. The spec's plan-decisions sentence gains them in Task 11.
14. Texted drops and swap proposals open the event too: `handleCant`'s result gains `proposalId` (its SELECT already reads it) and the swap's `shift_context` gains `proposal_id` (already selected as `orig.proposal_id`); a manual shift still has none and opens `/staffing`. The CANT banner's position reads "Bartender" (the texted command is a bartender's).
15. "Sending" on the test row keeps the row's ink and is not a disabled state (the benchmark keeps `nTestInk` at ink 1 while sending; a second tap is ignored by the handler).

## Global Constraints

- **No em dashes** in copy, comments, commit messages or docs. The kinds, in order: `booking_signed`, `booking_signed_paid`, `payment_landed`, `booking_last_minute`, `drink_plan_submitted`, `staffing_drop`, `staffing_cover_swap`.
- **A banner body never carries a phone number, an address, a note, or a staffer's contact.** Client display name, event kind, date, amount only.
- **Push never fails a caller.** Every new server path catches its own errors, logs, breadcrumbs or captures, and returns.
- **One pooled connection per request:** the send loop holds no connection or transaction; the prune takes its own short one.
- **Server tests** run one file at a time against the shared dev DB: `node --test server/utils/adminPush.test.js` etc. Read the pass count. Every fixture row is deleted in `after`.
- **Client tests:** `import '@testing-library/jest-dom'` in every test file; `jest.mock` factories close over `mock`-prefixed names only; plain functions where `resetMocks` would wipe a `jest.fn` implementation.
- **Client gate before every client commit:** `cd client && CI=true npx react-scripts build` (exit 0).
- **Unique `m-*` class names, every one defined in `index.css`** with the `html[data-app="admin-os"]` prefix; **44px** minimum for every button and row.
- **File size:** `NotificationsPhone.js` under 350 lines, `adminPush.js` (server) under 300, `me.js` under 400. Four files the lane touches already sit over the 700 soft cap and grow by a few lines each (`staffShiftActions.js` 948 to about 963, `smsInbound.js` 795 to about 801, `server/index.js` 935 to 936, `App.js` 706 to 708): the ratchet warns and blocks only growth past 1000, so nothing blocks here, and a `staffShiftActions.js` split goes on the fix list (Task 11) because the next lane there must split first.
- **Explicit staging only;** commit with `git commit -F - <<'MSG'` (no backticks in messages); never `npm install` inside the lane; never write VAPID keys to any file (the gate passes them as env vars on the command line).

## Review Focus

1. **A banner tapped while the lock is up.** Expected: the lock screen shows over the target route; after unlock the target route is on screen; never the Events list. Pinned by the SW click test in Task 9 (the URL is the route) and gate check N10.
2. **A category turned off on desktop.** Expected: no push for any kind in that category, whatever the kind switch says. Pinned in Task 2 (recipient resolution is the first gate).
3. **A phone whose Android permission was revoked after it subscribed.** Expected: the switch reads blocked, never on; the server keeps the stale subscription until a send 410s it. Pinned in Task 6 (`readDevicePushState` reads permission before the subscription).
4. **Two admins, one with push off for drops.** Expected: the drop pushes the other only; email to both as today. Pinned in Task 2.
5. **A drink plan submitted twice (a re-submit after an edit) and a Stripe webhook retried.** Expected: the second banner replaces the first (same tag), never a second banner. Pinned in Task 1 (`pushTag`) and Task 4 (every call passes `recordId`).

## Lane map

```yaml
lanes:
  - id: ma-c-push
    phase: 2
    scope: >
      Admin push per spec section 7 (2026-10-14): the kinds module and the
      one send-and-prune routine, the push leg in notifyAdminCategory behind
      the category and kind gates, the preferences read and write with the
      kind switches and the VAPID public key, the test route, nine call
      sites plus the new drink-plan emit, the revoke's subscription purge;
      the generalized pushSubscribe, the device-state module, the pure
      view-model, the Notifications screen, the More row, the route, the
      header map entry, logout's unsubscribe; the service worker's one new
      allowlisted read and the click handler's navigate; CSS; docs. Visual
      fidelity to the 2026-10-14 benchmark's Notifications screen is owned
      here.
    inputs:
      - docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html
      - docs/design-artifacts/_ds/dr-bartender-os-design-system-72035042-c993-47e2-9dc8-c452b7bf5fa4/components-mobile.css
    footprint:
      - server/utils/adminPush.js
      - server/utils/adminPush.test.js
      - server/utils/pushDispatch.js
      - server/utils/pushSender.js        # Checkpoint A: SEND_NOTIFICATIONS gate + send timeout
      - server/utils/pushSender.test.js
      - server/utils/adminNotifications.js
      - server/utils/adminNotifications.test.js
      - server/routes/me.js
      - server/routes/me.notificationPrefs.test.js
      - server/routes/mePush.js
      - server/routes/mePush.test.js
      - server/index.js
      - server/db/schema.sql
      - server/routes/webauthn.js
      - server/routes/webauthn.test.js
      - server/routes/proposals/public.js
      - server/routes/proposals/publicToken.js
      - server/utils/stripePaymentNotifications.js
      - server/utils/bankPaymentProcessingNotify.js
      - server/utils/bankPaymentProcessingNotify.test.js
      - server/utils/lastMinuteAlert.js
      - server/routes/staffShiftActions.js
      - server/utils/smsInbound.js
      - server/utils/smsInbound.nearestShift.endInstant.test.js
      - server/utils/smsShiftCommands.js
      - server/routes/staffShiftActions.test.js
      - server/routes/drinkPlans/submitPlannerV2.test.js
      - server/routes/drinkPlans/submitNotify.js
      - client/src/utils/pushSubscribe.js
      - client/src/utils/pushSubscribe.test.js
      - client/src/utils/adminPush.js
      - client/src/utils/adminPush.test.js
      - client/src/utils/notificationsView.js
      - client/src/utils/notificationsView.test.js
      - client/src/pages/mobile/NotificationsPhone.js
      - client/src/pages/mobile/NotificationsPhone.test.js
      - client/src/pages/mobile/MorePage.js
      - client/src/pages/mobile/MorePage.test.js
      - client/src/utils/screenKey.js
      - client/src/utils/screenKey.test.js
      - client/src/components/AdminLayout.js
      - client/src/context/AuthContext.js
      - client/src/context/AuthContext.test.js
      - client/src/App.js
      - client/public/admin-sw.js
      - client/src/utils/adminSwAllowlist.test.js
      - client/src/utils/mobileClassContract.test.js
      - client/src/index.css
      - scripts/sensitive-paths.txt
      - scripts/mobile-capture.manifest.json
      - README.md
      - ARCHITECTURE.md
      - .claude/CLAUDE.md
      - docs/walkthroughs-owed.md
      - docs/fix-list-remaining-2026-07-02.md
      - docs/superpowers/specs/2026-08-13-mobile-admin-design.md
      - docs/superpowers/plans/2026-10-14-mobile-admin-push.md
    depends_on: []   # ma-b-pwa and ma-d-auth are on origin
    review_fleet: [code-review, consistency-check, security-review, database-review, ui-ux-review, second-opinion]
    # Nine sensitive-listed files and a new column, so the full fleet.
    # security-review: the gates, the banner copy, the test route's scope,
    # the revoke purge, logout, and the worker's navigate (same-origin
    # paths only). database-review: the column default and the
    # prune's FOR UPDATE. consistency-check: the kind labels on the phone
    # against the server's kinds, the category each call site passes.
    # ui-ux-review: the benchmark's Notifications screen, both skins, 390,
    # 360 and 320. second-opinion at push.
```

**Execution:** subagent-driven, as Dallas chose for the previous lanes: implementers on Opus, each task's reviewer on Fable when available, else Opus. Tasks 1 to 5 are serial on the server (Tasks 3 and 5 need only Task 1 and Task 4 needs 1 and 2, but the server suites share the dev DB one file at a time, so one implementer at a time). **Checkpoint A** (a security and a database reviewer on the finished server contract: Tasks 1 to 5's diff, this header, the spec's section 7) runs BEFORE any client task, the method that paid for itself on lane ma-e2. Tasks 6, 7, 8 and 9 are serial too: one lane worktree has one index and one `client/build`, so two implementers staging and committing in it would sweep each other's files into their commits (the shared-index trap) and race the build gate. Task 10 (the signed-in browser gate), Task 11 (docs) and Task 12 (lane close) are the orchestrator's: subagents cannot mint the dev session.

**Each task reviewer's brief** carries: this header through "Who writes what"; the task's own text with its Interfaces block; the Review Focus lines that name the task; the spec's section 7 and the 2026-10-14 decisions list; the task's commit diff.

**Who writes what.** An implementer sees this header and their own task, commits only the paths their task names, and reports anything the plan should record. The plan and the spec live on main and are edited there by the orchestrator, never from the lane.

---

### Task 1: The kinds module and the one send-and-prune routine

**Files:**
- Create: `server/utils/adminPush.js`
- Create: `server/utils/adminPush.test.js`
- Modify: `server/utils/pushDispatch.js` (the send-and-prune body `:30-110` becomes one call)
- Modify: `server/db/schema.sql` (one `ALTER TABLE users ADD COLUMN IF NOT EXISTS` after the `notification_preferences` block that starts at `:2969`)

**Interfaces:**
- Consumes: `pushSender.sendPush` (unchanged), `pool`.
- Produces: `PUSH_KINDS` (frozen array of the seven kinds, in the screen's order), `isPushKind(kind)`, `pushTag(kind, recordId)`, `publicKey()` (the VAPID public key when BOTH keys are set, else null), `sendPushToUser({ userId, title, body, url, tag, icon }) -> Promise<{ subscriptions, sent, failed, gone }>`, `deleteAllSubscriptions(userId, db = pool)`, and the copy builders `pushCopy.bookingSigned`, `pushCopy.bookingSignedPaid`, `pushCopy.paymentLanded`, `pushCopy.bankPaymentStarted`, `pushCopy.lastMinuteBooking`, `pushCopy.drinkPlanSubmitted`, `pushCopy.staffingDrop`, `pushCopy.staffingCover`, `pushCopy.staffingSwap`, each returning `{ kind, title, body, url, recordId }`. Task 2 consumes `sendPushToUser`, `isPushKind`, `pushTag`; Task 3 consumes `PUSH_KINDS`, `publicKey`, `sendPushToUser`; Task 4 consumes `pushCopy`; Task 5 consumes `deleteAllSubscriptions`.

- [ ] **Step 1: The column, applied to the dev DB by hand**

The column leads the lane (nothing in this commit reads it) so the dev DB already holds it when Task 2's recipient SELECT lands; the DDL and the module are one commit because the module's tests seed the column's table.

Append to `server/db/schema.sql`, right after the `notification_preferences` ALTER's closing `}'::jsonb;` line (find it with `grep -n "notification_preferences JSONB" server/db/schema.sql`):

```sql
-- Mobile admin push (spec 2026-08-13-mobile-admin section 7, 2026-10-14): one
-- switch per push KIND, per account. An absent key is ON. Kinds are the
-- PUSH_KINDS list in server/utils/adminPush.js; nothing else is ever stored.
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_push_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
```

The test runner does not boot the server, so apply it to the dev DB now (dotenv first: `server/db` never loads it):

```bash
node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query(\"ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_push_preferences JSONB NOT NULL DEFAULT '{}'::jsonb\").then(()=>pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='admin_push_preferences'\")).then(r=>{console.log(r.rows);return pool.end();})"
```

Expected: `[ { column_name: 'admin_push_preferences' } ]`.

- [ ] **Step 2: The failing tests**

`server/utils/adminPush.test.js`:

```js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const pushSender = require('./pushSender');
const adminPush = require('./adminPush');

const NONCE = `${Date.now()}-${process.pid}`;
let userId;
const SUB = (n) => ({ endpoint: `https://push.example.test/${NONCE}/${n}`, keys: { p256dh: 'p', auth: 'a' }, subscribed_at: new Date().toISOString() });

before(async () => {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, staff_notification_preferences)
     VALUES ($1, 'x', 'admin', jsonb_build_object('push_subscriptions', $2::jsonb)) RETURNING id`,
    [`admin-push-${NONCE}@example.com`, JSON.stringify([SUB(1), SUB(2), SUB(3)])]
  );
  userId = r.rows[0].id;
});
after(async () => {
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

const subsOf = async () => (await pool.query('SELECT staff_notification_preferences->\'push_subscriptions\' AS s FROM users WHERE id = $1', [userId])).rows[0].s;

test('PUSH_KINDS is the seven kinds in the screen order and isPushKind knows only them', () => {
  assert.deepEqual([...adminPush.PUSH_KINDS], ['booking_signed', 'booking_signed_paid', 'payment_landed', 'booking_last_minute', 'drink_plan_submitted', 'staffing_drop', 'staffing_cover_swap']);
  assert.equal(adminPush.isPushKind('staffing_drop'), true);
  assert.equal(adminPush.isPushKind('routine_thumbtack'), false);
  assert.equal(adminPush.isPushKind('constructor'), false);
});

test('pushTag is kind plus record id, so a retry replaces its own banner', () => {
  assert.equal(adminPush.pushTag('payment_landed', 42), 'payment_landed:42');
  assert.equal(adminPush.pushTag('payment_landed', null), 'payment_landed');
});

test('publicKey is null unless BOTH VAPID keys are set', () => {
  const saved = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
  process.env.VAPID_PUBLIC_KEY = 'pub'; delete process.env.VAPID_PRIVATE_KEY;
  assert.equal(adminPush.publicKey(), null);
  process.env.VAPID_PRIVATE_KEY = 'priv';
  assert.equal(adminPush.publicKey(), 'pub');
  [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY] = saved;
  if (saved[0] === undefined) delete process.env.VAPID_PUBLIC_KEY;
  if (saved[1] === undefined) delete process.env.VAPID_PRIVATE_KEY;
});

test('sendPushToUser sends to every subscription, counts, and prunes only the gone ones', async () => {
  const calls = [];
  const real = pushSender.sendPush;
  pushSender.sendPush = async ({ subscription, title, tag }) => {
    calls.push({ endpoint: subscription.endpoint, title, tag });
    if (subscription.endpoint.endsWith('/2')) return { ok: false, gone: true };
    if (subscription.endpoint.endsWith('/3')) return { ok: false, error: 'boom' };
    return { ok: true };
  };
  try {
    const out = await adminPush.sendPushToUser({ userId, title: 'T', body: 'B', url: '/events/1', tag: 'payment_landed:1' });
    assert.deepEqual(out, { subscriptions: 3, sent: 1, failed: 1, gone: 1 });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].tag, 'payment_landed:1');
    const left = await subsOf();
    assert.deepEqual(left.map((s) => s.endpoint.slice(-2)), ['/1', '/3']);
  } finally { pushSender.sendPush = real; }
});

test('sendPushToUser with no subscriptions sends nothing and says so', async () => {
  const r = await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'manager') RETURNING id`, [`admin-push-none-${NONCE}@example.com`]);
  try {
    const out = await adminPush.sendPushToUser({ userId: r.rows[0].id, title: 'T', body: 'B', url: '/' });
    assert.deepEqual(out, { subscriptions: 0, sent: 0, failed: 0, gone: 0 });
  } finally { await pool.query('DELETE FROM users WHERE id = $1', [r.rows[0].id]); }
});

test('sendPushToUser never throws: a failed read returns zeros', async () => {
  const out = await adminPush.sendPushToUser({ userId: 'not-a-number', title: 'T', body: 'B', url: '/' });
  assert.deepEqual(out, { subscriptions: 0, sent: 0, failed: 0, gone: 0 });
});

test('deleteAllSubscriptions empties the array and keeps the rest of the blob', async () => {
  await pool.query(`UPDATE users SET staff_notification_preferences = jsonb_set(staff_notification_preferences, '{quiet_hours}', '"22:00-08:00"') WHERE id = $1`, [userId]);
  await adminPush.deleteAllSubscriptions(userId);
  const row = (await pool.query('SELECT staff_notification_preferences AS p FROM users WHERE id = $1', [userId])).rows[0].p;
  assert.deepEqual(row.push_subscriptions, []);
  assert.equal(row.quiet_hours, '22:00-08:00');
});

test('pushCopy builds a path url, a tag-able record id, and never an em dash', () => {
  const c = adminPush.pushCopy;
  const all = [
    c.bookingSigned({ clientName: 'Ada', eventTypeLabel: 'Wedding', proposalId: 7, dateLabel: 'Saturday, October 18' }),
    c.bookingSignedPaid({ clientName: 'Ada', eventTypeLabel: 'Wedding', amount: '$1,200.00', proposalId: 7 }),
    c.paymentLanded({ clientName: 'Ada', eventTypeLabel: 'Wedding', amount: '$500.00', paymentType: 'balance', proposalId: 7 }),
    c.bankPaymentStarted({ clientName: 'Ada', eventTypeLabel: 'Wedding', amount: '$100.00', initial: true, proposalId: 7 }),
    c.bankPaymentStarted({ clientName: 'Ada', eventTypeLabel: 'Wedding', amount: '$900.00', initial: false, proposalId: 7 }),
    c.lastMinuteBooking({ eventTypeLabel: 'Wedding', date: 'Sat, Oct 18', time: '6:00 PM', proposalId: 7 }),
    c.drinkPlanSubmitted({ clientName: 'Ada', eventTypeLabel: 'Wedding', proposalId: 7 }),
    c.staffingDrop({ clientName: 'Ada', eventTypeLabel: 'Wedding', dateLabel: 'Oct 18', position: 'Bartender', proposalId: 7, shiftId: 99 }),
    c.staffingCover({ clientName: 'Ada', eventTypeLabel: 'Wedding', dateLabel: 'Oct 18', position: 'Bartender', proposalId: null, shiftId: 99 }),
    c.staffingSwap({ clientName: null, eventTypeLabel: 'Wedding', dateLabel: 'Oct 18', position: 'Barback', proposalId: 7, shiftId: 99 }),
  ];
  assert.deepEqual(all.map((x) => x.kind), ['booking_signed', 'booking_signed_paid', 'payment_landed', 'booking_signed_paid', 'payment_landed', 'booking_last_minute', 'drink_plan_submitted', 'staffing_drop', 'staffing_cover_swap', 'staffing_cover_swap']);
  assert.equal(all[0].url, '/proposals/7');
  assert.equal(all[1].url, '/events/7');
  assert.equal(all[8].url, '/staffing');
  assert.equal(all[7].recordId, 99);
  for (const x of all) {
    assert.ok(x.title && x.body, JSON.stringify(x));
    assert.doesNotMatch(x.title + x.body, /\u2014/);
  }
  assert.match(all[3].title, /started/i);
  assert.doesNotMatch(all[3].body, /landed/i);
  assert.match(all[0].body, / · Saturday, October 18$/, 'the date ends the body when the site has it');
  assert.doesNotMatch(all[1].body, /undefined|null/, 'no date, no trace of one');
});
```

- [ ] **Step 3: Run it, expect every test to fail on the missing module**

Run: `node --test server/utils/adminPush.test.js`
Expected: FAIL, `Cannot find module './adminPush'`.

- [ ] **Step 4: The module**

`server/utils/adminPush.js`:

```js
'use strict';
// The admin phone's push channel (spec 2026-08-13-mobile-admin section 7,
// rewritten 2026-10-14). ONE module knows the seven kinds, builds each
// banner, and sends to a user's stored subscriptions. A send holds no DB
// connection across the network (the SERVER-17 lesson in pushDispatch.js), a
// dead subscription is pruned in its own short transaction, and nothing here
// ever throws into a caller: push can never fail a money path.
const Sentry = require('@sentry/node');
const { pool } = require('../db');
// Module-level (not destructured) so tests can monkey-patch pushSender.sendPush.
const pushSender = require('./pushSender');

// The dispatch allowlist. A notifyAdminCategory call pushes ONLY when it names
// one of these; the screen draws them in this order under three headings.
const PUSH_KINDS = Object.freeze([
  'booking_signed',
  'booking_signed_paid',
  'payment_landed',
  'booking_last_minute',
  'drink_plan_submitted',
  'staffing_drop',
  'staffing_cover_swap',
]);
const KIND_SET = new Set(PUSH_KINDS);
const isPushKind = (kind) => typeof kind === 'string' && KIND_SET.has(kind);

// Kind plus record id: a retried send replaces its own banner, and two records
// of the same kind never collapse into one.
const pushTag = (kind, recordId) => (recordId === null || recordId === undefined ? kind : `${kind}:${recordId}`);

// The phone learns the key from the API, not from a build-time variable. Only
// a server that can also SIGN (private key present) advertises a public key,
// so the screen's "not set up on the server" state is truthful.
function publicKey() {
  return process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY ? process.env.VAPID_PUBLIC_KEY : null;
}

function subscriptionsOf(prefs) {
  const subs = prefs && Array.isArray(prefs.push_subscriptions) ? prefs.push_subscriptions : [];
  return subs.filter((s) => s && typeof s.endpoint === 'string' && s.keys);
}

// Short transaction: re-read under FOR UPDATE and drop only the gone
// endpoints, so a concurrent subscribe of a different endpoint survives.
async function pruneGoneSubscriptions(userId, goneEndpoints) {
  if (!goneEndpoints.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT staff_notification_preferences AS prefs FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const fresh = subscriptionsOf(rows[0] && rows[0].prefs);
    const gone = new Set(goneEndpoints);
    const kept = fresh.filter((s) => !gone.has(s.endpoint));
    if (kept.length !== fresh.length) {
      await client.query(
        `UPDATE users SET staff_notification_preferences = jsonb_set(COALESCE(staff_notification_preferences, '{}'::jsonb), '{push_subscriptions}', $2::jsonb, true) WHERE id = $1`,
        [userId, JSON.stringify(kept)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection may be gone */ }
    Sentry.addBreadcrumb({ category: 'notifications', message: 'push_prune_failed', data: { user_id: userId, error: err && err.message } });
  } finally {
    client.release();
  }
}

// Send one banner to every subscription this user holds. Never throws.
async function sendPushToUser({ userId, title, body, url, tag, icon }) {
  const out = { subscriptions: 0, sent: 0, failed: 0, gone: 0 };
  let subs;
  try {
    const { rows } = await pool.query('SELECT staff_notification_preferences AS prefs FROM users WHERE id = $1', [userId]);
    subs = subscriptionsOf(rows[0] && rows[0].prefs);
  } catch (err) {
    Sentry.captureException(err, { tags: { feature: 'admin-push', step: 'read' } });
    return out;
  }
  out.subscriptions = subs.length;
  const goneEndpoints = [];
  for (const sub of subs) {
    let result;
    try {
      result = await pushSender.sendPush({ subscription: { endpoint: sub.endpoint, keys: sub.keys }, title, body, url, tag, icon });
    } catch (err) {
      result = { ok: false, error: err && err.message };
    }
    if (result && result.ok) out.sent += 1;
    else if (result && result.gone) { out.gone += 1; goneEndpoints.push(sub.endpoint); }
    else out.failed += 1;
  }
  await pruneGoneSubscriptions(userId, goneEndpoints);
  return out;
}

// The revoke (webauthn.js) runs this inside its own transaction; pass its client.
async function deleteAllSubscriptions(userId, db = pool) {
  await db.query(
    `UPDATE users SET staff_notification_preferences = jsonb_set(COALESCE(staff_notification_preferences, '{}'::jsonb), '{push_subscriptions}', '[]'::jsonb, true) WHERE id = $1`,
    [userId]
  );
}

// Banner copy. A path for url (the worker resolves it against the origin).
// Client display name, event kind, date and amount only: the banner shows on
// a locked Android screen. No em dashes.
const who = (clientName) => (clientName && String(clientName).trim()) || 'A client';
const eventUrl = (proposalId) => (proposalId ? `/events/${proposalId}` : '/staffing');
const forClient = (clientName) => (clientName ? ` for ${clientName}` : '');
// The event date ends the body when the site has it (decision 10).
const dated = (body, dateLabel) => (dateLabel ? `${body} · ${dateLabel}` : body);
const pushCopy = {
  bookingSigned: ({ clientName, eventTypeLabel, proposalId, dateLabel }) => ({
    kind: 'booking_signed', recordId: proposalId,
    title: `${who(clientName)} signed`,
    body: dated(`${eventTypeLabel}. Open the proposal.`, dateLabel),
    url: `/proposals/${proposalId}`,
  }),
  bookingSignedPaid: ({ clientName, eventTypeLabel, amount, proposalId, dateLabel }) => ({
    kind: 'booking_signed_paid', recordId: proposalId,
    title: `${who(clientName)} signed and paid`,
    body: dated(`${eventTypeLabel} · ${amount}`, dateLabel),
    url: eventUrl(proposalId),
  }),
  paymentLanded: ({ clientName, eventTypeLabel, amount, paymentType, proposalId, dateLabel }) => ({
    kind: 'payment_landed', recordId: proposalId,
    title: `Payment landed: ${amount}`,
    body: dated(`${who(clientName)} · ${eventTypeLabel}${paymentType ? ` (${paymentType})` : ''}`, dateLabel),
    url: eventUrl(proposalId),
  }),
  bankPaymentStarted: ({ clientName, eventTypeLabel, amount, initial, proposalId, dateLabel }) => ({
    kind: initial ? 'booking_signed_paid' : 'payment_landed', recordId: proposalId,
    title: `Bank payment started: ${amount}`,
    body: dated(`${who(clientName)} · ${eventTypeLabel}. Settles in four to six business days.`, dateLabel),
    url: eventUrl(proposalId),
  }),
  lastMinuteBooking: ({ eventTypeLabel, date, time, proposalId }) => ({
    kind: 'booking_last_minute', recordId: proposalId,
    title: 'Last-minute booking',
    body: `${eventTypeLabel} ${date} ${time}. Verify staffing now.`,
    url: eventUrl(proposalId),
  }),
  drinkPlanSubmitted: ({ clientName, eventTypeLabel, proposalId, dateLabel }) => ({
    kind: 'drink_plan_submitted', recordId: proposalId,
    title: 'Drink plan submitted',
    body: dated(`${who(clientName)} · ${eventTypeLabel}. Start the shopping list and the menu.`, dateLabel),
    url: eventUrl(proposalId),
  }),
  staffingDrop: ({ clientName, eventTypeLabel, dateLabel, position, proposalId, shiftId }) => ({
    kind: 'staffing_drop', recordId: shiftId,
    title: `Shift dropped: ${dateLabel}`,
    body: `${eventTypeLabel}${forClient(clientName)} · ${position || 'staff'}. Needs restaffing.`,
    url: eventUrl(proposalId),
  }),
  staffingCover: ({ clientName, eventTypeLabel, dateLabel, position, proposalId, shiftId }) => ({
    kind: 'staffing_cover_swap', recordId: shiftId,
    title: `Cover requested: ${dateLabel}`,
    body: `${eventTypeLabel}${forClient(clientName)} · ${position || 'staff'}. Teammates are being asked.`,
    url: eventUrl(proposalId),
  }),
  staffingSwap: ({ clientName, eventTypeLabel, dateLabel, position, proposalId, shiftId }) => ({
    kind: 'staffing_cover_swap', recordId: shiftId,
    title: `Swap proposed: ${dateLabel}`,
    body: `${eventTypeLabel}${forClient(clientName)} · ${position || 'staff'}. Approve it to confirm them.`,
    url: eventUrl(proposalId),
  }),
};

module.exports = { PUSH_KINDS, isPushKind, pushTag, publicKey, sendPushToUser, deleteAllSubscriptions, pushCopy };
```

- [ ] **Step 5: Run the test, expect 8 passing**

Run: `node --test server/utils/adminPush.test.js`
Expected: `pass 8`, `fail 0`.

- [ ] **Step 6: pushDispatch rides the shared routine**

Replace `server/utils/pushDispatch.js:22-134` (from the comment above the `pushSender` require to the end) with:

```js
const { sendPushToUser } = require('./adminPush');

async function dispatchPushRow(row) {
  const payload = row.payload || {};

  const { rows: userRows } = await pool.query('SELECT 1 FROM users WHERE id = $1', [row.recipient_id]);
  if (userRows.length === 0) {
    await pool.query(
      "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
      [row.id, 'recipient user not found']
    );
    return;
  }

  // The send-and-prune routine is shared with the admin push channel
  // (adminPush.js): no connection held across the network, the prune in its
  // own short FOR UPDATE transaction, a dead endpoint removed by endpoint.
  const r = await sendPushToUser({
    userId: row.recipient_id,
    title: payload.title,
    body: payload.body,
    url: payload.url,
    tag: payload.tag || row.message_type,
    icon: payload.icon,
  });

  if (r.subscriptions === 0) {
    await pool.query(
      "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
      [row.id, 'no_push_subscriptions']
    );
    return;
  }

  // Record the row outcome from the SEND result (independent of the prune).
  if (r.sent > 0) {
    await pool.query(
      "UPDATE scheduled_messages SET status = 'sent', sent_at = NOW(), error_message = NULL WHERE id = $1",
      [row.id]
    );
    if (r.gone > 0) {
      Sentry.addBreadcrumb({
        category: 'notifications',
        message: 'push_partial_prune',
        data: { user_id: row.recipient_id, row_id: row.id, pruned: r.gone },
      });
    }
  } else {
    await pool.query(
      "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
      [row.id, r.gone > 0 ? 'all_subscriptions_gone' : 'push_send_failed']
    );
  }
}

module.exports = { dispatchPushRow };
```

Keep the file's header comment (`:1-18`) and the `Sentry` and `pool` requires (`:20-21`); the `pushSender` require and its comment (`:22-23`) go (the routine owns it now; an unused require would only warn under lint-staged, but it is dead code). The SERVER-17 paragraph in the header stays true: the routine it describes moved, it did not change.

- [ ] **Step 7: The dispatcher suites still pass**

Run, one at a time: `node --test server/utils/scheduledMessageDispatcher.test.js` (its three push-channel tests at `:923-1000` are the regression read for the refactor: no subscriptions suppressed, sends ok and prunes gone while keeping a flaky one, all fail) and `node --test server/utils/adminPush.test.js`. Expected: every file `fail 0`; read the pass counts.

- [ ] **Step 8: Commit**

```bash
git add server/utils/adminPush.js server/utils/adminPush.test.js server/utils/pushDispatch.js server/db/schema.sql
git commit -F - <<'MSG'
feat(push): the kinds module, the one send-and-prune routine, the kind switches column

server/utils/adminPush.js owns the seven push kinds, the banner copy and
sendPushToUser, which pushDispatch now rides; users.admin_push_preferences
holds the per-account kind switches (absent key = on).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 2: The push leg in notifyAdminCategory, behind the three gates

**Files:**
- Modify: `server/utils/adminNotifications.js` (`resolveCategoryRecipients` `:36-57`, `notifyAdminCategory` `:75-145`, exports `:147`)
- Modify: `server/utils/adminNotifications.test.js` (append tests; the existing `before`/`after` fixtures stay)

**Interfaces:**
- Consumes: `sendPushToUser`, `isPushKind`, `pushTag` from Task 1.
- Produces: `notifyAdminCategory({ category, subject, emailHtml, emailText, smsBody, push })` where `push` is `{ kind, title, body, url, recordId }`; the return gains `pushQueued` (number of recipients the push leg will try). `pushAdminKind({ category, push }) -> Promise<{ pushQueued }>` (push only, no email or SMS; same recipient resolution). `__flushPush() -> Promise<void>` awaits every push leg started so far (tests). `__setDeps({ sendPushToUser })` injects the sender (tests). Recipients from `resolveCategoryRecipients` gain `admin_push_preferences` (object) and `push_subscription_count` (number). Tasks 4 and 11 consume `push` and `pushAdminKind`.

- [ ] **Step 1: The failing tests**

Append to `server/utils/adminNotifications.test.js`, before its `after` block (the file's `after` deletes `adminA`, `adminB`, `staffC`; the new rows below are deleted in their own test bodies):

```js
const adminNotifications = require('./adminNotifications');

test('recipients carry the kind switches and the subscription count', async () => {
  await pool.query(
    `UPDATE users SET admin_push_preferences = '{"staffing_drop": false}'::jsonb,
       staff_notification_preferences = jsonb_set(staff_notification_preferences, '{push_subscriptions}', '[{"endpoint":"https://push.example.test/a","keys":{"p256dh":"p","auth":"a"}}]'::jsonb, true)
     WHERE id = $1`, [adminA]
  );
  const rows = await resolveCategoryRecipients('system_error');
  const a = rows.find((r) => r.id === adminA);
  assert.deepEqual(a.admin_push_preferences, { staffing_drop: false });
  assert.equal(a.push_subscription_count, 1);
  const b = rows.find((r) => r.id === adminB);
  assert.deepEqual(b.admin_push_preferences, {});
  assert.equal(b.push_subscription_count, 0);
});

test('the push leg: category gate, then the kind switch, then a subscription; fire-and-forget; never throws', async () => {
  const sent = [];
  adminNotifications.__setDeps({ sendPushToUser: async (args) => { sent.push(args); return { subscriptions: 1, sent: 1, failed: 0, gone: 0 }; } });
  try {
    // adminA: subscribed to system_error, has a subscription, staffing_drop OFF.
    // adminB: subscribed to system_error, NO subscription.
    // staffC: never a recipient.
    const r1 = await adminNotifications.notifyAdminCategory({
      category: 'system_error', subject: 's', emailHtml: '<p>h</p>', emailText: 't',
      push: { kind: 'staffing_drop', title: 'T', body: 'B', url: '/events/1', recordId: 1 },
    });
    await adminNotifications.__flushPush();
    assert.equal(r1.pushQueued, 0, 'adminA has the kind off, adminB has no subscription');
    assert.equal(sent.length, 0);

    const r2 = await adminNotifications.notifyAdminCategory({
      category: 'system_error', subject: 's', emailHtml: '<p>h</p>', emailText: 't',
      push: { kind: 'payment_landed', title: 'T', body: 'B', url: '/events/1', recordId: 1 },
    });
    await adminNotifications.__flushPush();
    assert.equal(r2.pushQueued, 1);
    assert.deepEqual(sent.map((s) => s.userId), [adminA]);
    assert.equal(sent[0].tag, 'payment_landed:1');
    assert.equal(sent[0].url, '/events/1');

    // The category gate comes first: adminA is NOT subscribed to urgent_booking.
    sent.length = 0;
    const r3 = await adminNotifications.notifyAdminCategory({
      category: 'urgent_booking', subject: 's', emailHtml: '<p>h</p>', emailText: 't',
      push: { kind: 'payment_landed', title: 'T', body: 'B', url: '/events/1', recordId: 1 },
    });
    await adminNotifications.__flushPush();
    assert.equal(r3.pushQueued, 0);
    assert.equal(sent.length, 0);

    // No push block: nothing is pushed whatever the category.
    const r4 = await adminNotifications.notifyAdminCategory({ category: 'system_error', subject: 's', emailHtml: '<p>h</p>', emailText: 't' });
    assert.equal(r4.pushQueued, 0);

    // An unknown kind is dropped, not thrown.
    const r5 = await adminNotifications.notifyAdminCategory({
      category: 'system_error', subject: 's', emailHtml: '<p>h</p>', emailText: 't',
      push: { kind: 'routine_thumbtack', title: 'T', body: 'B', url: '/' },
    });
    assert.equal(r5.pushQueued, 0);

    // A sender that throws never reaches the caller.
    adminNotifications.__setDeps({ sendPushToUser: async () => { throw new Error('push service down'); } });
    const r6 = await adminNotifications.notifyAdminCategory({
      category: 'system_error', subject: 's', emailHtml: '<p>h</p>', emailText: 't',
      push: { kind: 'payment_landed', title: 'T', body: 'B', url: '/events/1', recordId: 2 },
    });
    assert.equal(r6.pushQueued, 1);
    await adminNotifications.__flushPush();
  } finally {
    adminNotifications.__setDeps({ sendPushToUser: require('./adminPush').sendPushToUser });
  }
});

test('pushAdminKind pushes without emailing or texting', async () => {
  const sent = [];
  adminNotifications.__setDeps({ sendPushToUser: async (args) => { sent.push(args); return { subscriptions: 1, sent: 1, failed: 0, gone: 0 }; } });
  try {
    const r = await adminNotifications.pushAdminKind({
      category: 'system_error',
      push: { kind: 'drink_plan_submitted', title: 'Drink plan submitted', body: 'Ada · Wedding.', url: '/events/5', recordId: 5 },
    });
    await adminNotifications.__flushPush();
    assert.equal(r.pushQueued, 1);
    assert.deepEqual(sent.map((s) => [s.userId, s.tag]), [[adminA, 'drink_plan_submitted:5']]);
  } finally {
    adminNotifications.__setDeps({ sendPushToUser: require('./adminPush').sendPushToUser });
  }
});
```

Email sends in this suite are already inert: `SEND_NOTIFICATIONS` is off outside production, so `sendEmail` logs and skips.

- [ ] **Step 2: Run it, expect the new tests to fail**

Run: `node --test server/utils/adminNotifications.test.js`
Expected: the three new tests FAIL (`admin_push_preferences` undefined, `__setDeps is not a function`); the old ones still pass.

- [ ] **Step 3: The implementation**

In `server/utils/adminNotifications.js`:

Add after the `require` lines at the top:

```js
const adminPush = require('./adminPush');

// Injected for tests; the push leg is the only network the module reaches
// besides email and SMS, and the suite must never contact a push service.
let _deps = { sendPushToUser: adminPush.sendPushToUser };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

// Every push leg started and not yet settled. Callers never await the leg
// (spec section 7: fire-and-forget after commit); tests do, through this.
const pendingPush = new Set();
function track(p) {
  pendingPush.add(p);
  p.finally(() => pendingPush.delete(p));
  return p;
}
async function __flushPush() { await Promise.allSettled([...pendingPush]); }
```

Replace the SELECT in `resolveCategoryRecipients` (`:47-53`) and its mapping (`:54-56`) with:

```js
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.communication_preferences, cp.phone,
            COALESCE(u.admin_push_preferences, '{}'::jsonb) AS admin_push_preferences,
            COALESCE(jsonb_array_length(
              CASE WHEN jsonb_typeof(u.staff_notification_preferences->'push_subscriptions') = 'array'
                   THEN u.staff_notification_preferences->'push_subscriptions' ELSE '[]'::jsonb END), 0) AS push_subscription_count
       FROM users u
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE u.role IN ('admin', 'manager')
        AND COALESCE(u.notification_preferences->>$1, 'true') = 'true'`,
    [category]
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    phone: r.phone || null,
    communication_preferences: r.communication_preferences || {},
    admin_push_preferences: r.admin_push_preferences || {},
    push_subscription_count: Number(r.push_subscription_count) || 0,
  }));
```

Add the push leg as its own function above `notifyAdminCategory`:

```js
// The push leg. Gates, in order: the recipient list (the category gate,
// already applied by resolveCategoryRecipients), the per-kind switch (an
// absent key is ON), and at least one stored subscription. Returns how many
// recipients it will try; the sends run in the background and never throw.
function pushRecipients(recipients, category, push) {
  if (!push || !adminPush.isPushKind(push.kind)) {
    if (push) console.error(`[adminNotifications] push dropped: unknown kind '${push && push.kind}' (category ${category})`);
    return 0;
  }
  const eligible = recipients.filter((r) =>
    (r.admin_push_preferences || {})[push.kind] !== false && (r.push_subscription_count || 0) > 0
  );
  if (!eligible.length) return 0;
  const tag = adminPush.pushTag(push.kind, push.recordId);
  for (const r of eligible) {
    track((async () => {
      try {
        await _deps.sendPushToUser({ userId: r.id, title: push.title, body: push.body, url: push.url, tag });
      } catch (err) {
        Sentry.captureException(err, {
          tags: { feature: 'admin-notification', category, channel: 'push', kind: push.kind },
          extra: { recipient_id: r.id },
        });
      }
    })());
  }
  return eligible.length;
}

// Push only (no email, no SMS): the drink-plan submit uses this, whose email
// keeps its own balance-changed throttle.
async function pushAdminKind({ category, push }) {
  let recipients = [];
  try {
    recipients = await resolveCategoryRecipients(category);
  } catch (err) {
    Sentry.captureException(err, { tags: { feature: 'admin-notification', category, channel: 'push' } });
    return { pushQueued: 0 };
  }
  return { pushQueued: pushRecipients(recipients, category, push) };
}
```

In `notifyAdminCategory`: add `push` to the destructured arguments (`:75`), change the early return at `:82` to `return { emailed: 0, texted: 0, pushQueued: 0 };`, and replace the final `return { emailed, texted };` (`:144`) with:

```js
  const pushQueued = pushRecipients(recipients, category, push);
  return { emailed, texted, pushQueued };
```

Update the JSDoc above it: `@param {{kind:string,title:string,body:string,url:string,recordId?:number|string}} [args.push] when set, also push subscribed admins whose switch for this kind is on (spec section 7, 2026-10-14). Fire-and-forget.` and the return type `{emailed:number, texted:number, pushQueued:number}`.

Replace the exports line with:

```js
module.exports = { notifyAdminCategory, pushAdminKind, resolveCategoryRecipients, VALID_CATEGORIES, __setDeps, __flushPush };
```

- [ ] **Step 4: Run it, expect every test to pass**

Run: `node --test server/utils/adminNotifications.test.js`
Expected: `fail 0`; the pass count is the old count plus 3.

Also run, one at a time, the two suites that replace or inject `notifyAdminCategory` and read its return: `node --test server/utils/bankPaymentProcessingNotify.test.js` and `node --test server/utils/smsInbound.test.js`. Expected: `fail 0` (nothing there reads `pushQueued`; this is the regression read).

- [ ] **Step 5: Commit**

```bash
git add server/utils/adminNotifications.js server/utils/adminNotifications.test.js
git commit -F - <<'MSG'
feat(push): notifyAdminCategory pushes a named kind behind the category and switch gates

A call pushes only when it names one of the seven kinds; the recipient
must be subscribed to the category (as for email), have the kind on, and
hold a subscription. The sends are fire-and-forget and never throw.
pushAdminKind pushes without email or SMS.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 3: The preferences read and write carry the kind switches and the key; the test route

**Files:**
- Modify: `server/routes/me.js` (the GET `:266-279`, the PATCH `:283-299`, the exports `:301-303`; one pure helper beside `applyNotificationPrefPatch`)
- Modify: `server/routes/me.notificationPrefs.test.js` (append)
- Create: `server/routes/mePush.js`
- Create: `server/routes/mePush.test.js`
- Modify: `server/index.js:342` (one mount line after `./routes/me`)

**Interfaces:**
- Consumes: `PUSH_KINDS`, `publicKey`, `sendPushToUser` from Task 1.
- Produces: `GET /api/me/notification-preferences` answers `{ notification_preferences, categories, admin_push_preferences: { <kind>: boolean for every kind }, push: { public_key: string|null, kinds: [...] } }`. `PATCH /api/me/notification-preferences` accepts `admin_push_preferences: { <kind>: boolean }` beside category keys (either or both; empty is a 400) and answers `{ notification_preferences, admin_push_preferences }`. `POST /api/me/push-test` (admin or manager, `adminWriteLimiter`) answers `200 { subscriptions, sent, failed, gone, reason }` with `reason` `'vapid_unset'` | `'no_subscriptions'` | `null`. `applyAdminPushPrefPatch(current, patch)` (pure, exported for tests). Tasks 6 and 8 consume all three.

- [ ] **Step 1: The failing tests**

Append to `server/routes/me.notificationPrefs.test.js` before its `after`:

```js
const { applyAdminPushPrefPatch } = require('./me');

test('applyAdminPushPrefPatch > merges a kind switch and keeps the rest', () => {
  const merged = applyAdminPushPrefPatch({ staffing_drop: false }, { payment_landed: false });
  assert.deepEqual(merged, { staffing_drop: false, payment_landed: false });
});
test('applyAdminPushPrefPatch > a true switch is stored as true (absent means on, true is explicit)', () => {
  assert.deepEqual(applyAdminPushPrefPatch({ staffing_drop: false }, { staffing_drop: true }), { staffing_drop: true });
});
test('applyAdminPushPrefPatch > rejects an unknown kind, a non-boolean, an inherited name, an empty patch', () => {
  assert.throws(() => applyAdminPushPrefPatch({}, { routine_thumbtack: true }), /kind/);
  assert.throws(() => applyAdminPushPrefPatch({}, { staffing_drop: 'yes' }), /boolean/);
  assert.throws(() => applyAdminPushPrefPatch({}, { constructor: true }), /kind/);
  assert.throws(() => applyAdminPushPrefPatch({}, {}), /at least one/);
});
```

Create `server/routes/mePush.test.js` (the hand-rolled harness `webauthn.test.js` uses, cut to this route; as built in the lane it also seeds `admin2`, an admin with no stored subscription, for the `no_subscriptions` test, and carries a concurrent-PATCH test, see the build record at the end):

```js
require('dotenv').config();
process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const adminPush = require('../utils/adminPush');
const { AppError } = require('../utils/errors');

const NONCE = `${Date.now()}-${process.pid}`;
let server; let baseUrl; let admin; let staff; let adminToken; let staffToken;

const mint = (u) => jwt.sign({ userId: u.id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(new URL(path, baseUrl), {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

before(async () => {
  admin = (await pool.query(`INSERT INTO users (email, password_hash, role, staff_notification_preferences) VALUES ($1, 'x', 'admin', jsonb_build_object('push_subscriptions', '[{"endpoint":"https://push.example.test/t","keys":{"p256dh":"p","auth":"a"}}]'::jsonb)) RETURNING id`, [`me-push-a-${NONCE}@example.com`])).rows[0];
  staff = (await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`, [`me-push-s-${NONCE}@example.com`])).rows[0];
  adminToken = mint(admin); staffToken = mint(staff);
  const app = express();
  app.use(express.json());
  app.use('/api/me', require('./me'));
  app.use('/api/me', require('./mePush'));
  // The repo's global handler is inline in server/index.js; a route harness
  // writes its own, as webauthn.test.js:135-143 does. Copy that block here
  // verbatim (AppError -> its statusCode and message; anything else 500).
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'internal' });
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
// Delete first, guarded on the ids that exist, so a `before` that threw after
// its INSERTs (the RED step does exactly that) leaves no rows on the shared
// dev DB; close the server only if one exists; end the pool whatever happened.
after(async () => {
  try {
    try {
      const ids = [admin, admin2, staff].filter(Boolean).map((u) => u.id);
      if (ids.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
    } finally {
      if (server) await new Promise((r) => server.close(r));
    }
  } finally {
    await pool.end();
  }
});

test('GET notification-preferences carries every kind (absent = on) and the push block', async () => {
  const saved = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
  process.env.VAPID_PUBLIC_KEY = 'pub-test'; process.env.VAPID_PRIVATE_KEY = 'priv-test';
  try {
    const res = await request('GET', '/api/me/notification-preferences', { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.push, { public_key: 'pub-test', kinds: [...adminPush.PUSH_KINDS] });
    assert.deepEqual(Object.keys(res.body.admin_push_preferences), [...adminPush.PUSH_KINDS]);
    assert.equal(res.body.admin_push_preferences.staffing_drop, true);
    assert.ok(res.body.notification_preferences);
  } finally {
    [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY] = saved;
    if (saved[0] === undefined) delete process.env.VAPID_PUBLIC_KEY;
    if (saved[1] === undefined) delete process.env.VAPID_PRIVATE_KEY;
  }
});

test('GET push.public_key is null when the server cannot sign', async () => {
  const saved = process.env.VAPID_PRIVATE_KEY; delete process.env.VAPID_PRIVATE_KEY;
  try {
    const res = await request('GET', '/api/me/notification-preferences', { token: adminToken });
    assert.equal(res.body.push.public_key, null);
  } finally { if (saved !== undefined) process.env.VAPID_PRIVATE_KEY = saved; }
});

test('PATCH stores a kind switch, alone or beside a category, and rejects an empty body', async () => {
  let res = await request('PATCH', '/api/me/notification-preferences', { token: adminToken, body: { admin_push_preferences: { staffing_drop: false } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.admin_push_preferences.staffing_drop, false);
  assert.equal(res.body.admin_push_preferences.payment_landed, true);
  res = await request('PATCH', '/api/me/notification-preferences', { token: adminToken, body: { system_error: false, admin_push_preferences: { staffing_drop: true } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.notification_preferences.system_error, false);
  assert.equal(res.body.admin_push_preferences.staffing_drop, true);
  const row = (await pool.query('SELECT admin_push_preferences AS p FROM users WHERE id = $1', [admin.id])).rows[0].p;
  assert.deepEqual(row, { staffing_drop: true });
  res = await request('PATCH', '/api/me/notification-preferences', { token: adminToken, body: {} });
  assert.equal(res.status, 400);
  res = await request('PATCH', '/api/me/notification-preferences', { token: adminToken, body: { admin_push_preferences: { routine_thumbtack: false } } });
  assert.equal(res.status, 400);
  res = await request('PATCH', '/api/me/notification-preferences', { token: staffToken, body: { admin_push_preferences: { staffing_drop: false } } });
  assert.equal(res.status, 403);
});

test('POST push-test is admin or manager only and reports what it could send', async () => {
  const real = adminPush.sendPushToUser;
  const calls = [];
  require('../utils/adminPush').sendPushToUser = async (args) => { calls.push(args); return { subscriptions: 1, sent: 1, failed: 0, gone: 0 }; };
  const saved = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
  process.env.VAPID_PUBLIC_KEY = 'pub-test'; process.env.VAPID_PRIVATE_KEY = 'priv-test';
  try {
    let res = await request('POST', '/api/me/push-test', { token: staffToken });
    assert.equal(res.status, 403);
    res = await request('POST', '/api/me/push-test', { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { subscriptions: 1, sent: 1, failed: 0, gone: 0, reason: null });
    assert.equal(calls[0].userId, admin.id);
    assert.equal(calls[0].url, '/more/notifications');
    assert.equal(calls[0].tag, 'push_test');
    delete process.env.VAPID_PRIVATE_KEY;
    res = await request('POST', '/api/me/push-test', { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.reason, 'vapid_unset');
    assert.equal(res.body.sent, 0);
  } finally {
    require('../utils/adminPush').sendPushToUser = real;
    [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY] = saved;
    if (saved[0] === undefined) delete process.env.VAPID_PUBLIC_KEY;
    if (saved[1] === undefined) delete process.env.VAPID_PRIVATE_KEY;
  }
});
```

The route reads `adminPush.sendPushToUser` through the module object at call time (not destructured) so the test's replacement takes effect; write `mePush.js` that way.

- [ ] **Step 2: Run both, expect failures on the missing helper and module**

Run: `node --test server/routes/me.notificationPrefs.test.js` then `node --test server/routes/mePush.test.js`
Expected: the new tests FAIL (`applyAdminPushPrefPatch is not a function`; `Cannot find module './mePush'`).

- [ ] **Step 3: me.js**

Add after `applyNotificationPrefPatch` (after `:75`):

```js
const { PUSH_KINDS, publicKey: pushPublicKey } = require('../utils/adminPush');
const PUSH_KIND_SET = new Set(PUSH_KINDS);

/**
 * Merge a kind-switch patch (spec 2026-08-13-mobile-admin section 7, 2026-10-14)
 * into the current admin_push_preferences. Pure. Throws ValidationError on an
 * unknown kind, a non-boolean, or an empty patch. hasOwnProperty guards an
 * inherited name ("constructor") the Set would otherwise never see.
 */
function applyAdminPushPrefPatch(current, patch) {
  const keys = Object.keys(patch || {});
  if (keys.length === 0) {
    throw new ValidationError({ _form: 'Provide at least one kind to update.' }, 'Provide at least one kind to update.');
  }
  const merged = { ...(current || {}) };
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(patch, k) || !PUSH_KIND_SET.has(k)) {
      throw new ValidationError({ [k]: 'Unknown push kind.' }, `Unknown push kind: ${k}`);
    }
    if (typeof patch[k] !== 'boolean') {
      throw new ValidationError({ [k]: 'Must be a boolean.' }, `Push kind ${k} must be a boolean.`);
    }
    merged[k] = patch[k];
  }
  return merged;
}

// Every kind, absent = on, so the phone always renders all seven switches.
function fullPushPrefs(stored) {
  const out = {};
  for (const k of PUSH_KINDS) out[k] = (stored || {})[k] !== false;
  return out;
}
```

Replace the GET (`:266-279`) with:

```js
// GET /api/me/notification-preferences: the current user's category
// subscriptions, plus the phone's push kind switches and the server's VAPID
// public key (null when the server cannot sign: the phone then says push is
// not set up on the server). Spec 2026-08-13-mobile-admin section 7.
router.get('/notification-preferences', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT notification_preferences, admin_push_preferences FROM users WHERE id = $1',
    [req.user.id]
  );
  const stored = (rows[0] && rows[0].notification_preferences) || {};
  const prefs = {};
  for (const cat of NOTIFICATION_CATEGORIES) {
    prefs[cat] = stored[cat] !== false;
  }
  res.json({
    notification_preferences: prefs,
    categories: NOTIFICATION_CATEGORIES,
    admin_push_preferences: fullPushPrefs(rows[0] && rows[0].admin_push_preferences),
    push: { public_key: pushPublicKey(), kinds: [...PUSH_KINDS] },
  });
}));
```

Replace the PATCH (`:283-299`) with:

```js
// PATCH /api/me/notification-preferences: toggle one or more categories, the
// push kind switches (admin_push_preferences: { kind: boolean }), or both.
// Admin/manager only: staff are never notification recipients.
router.patch('/notification-preferences', requireAdminOrManager, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { admin_push_preferences: pushPatch, ...categoryPatch } = body;
  const hasCategories = Object.keys(categoryPatch).length > 0;
  // Present but not a plain object (a string, null, an array) is refused
  // outright, never silently dropped beside a category toggle.
  if (pushPatch !== undefined && (pushPatch === null || typeof pushPatch !== 'object' || Array.isArray(pushPatch))) {
    throw new ValidationError({ admin_push_preferences: 'Must be an object of kind switches.' }, 'admin_push_preferences must be an object of kind switches.');
  }
  const hasPush = pushPatch !== undefined;
  if (!hasCategories && !hasPush) {
    throw new ValidationError({ _form: 'Provide at least one category or kind to update.' }, 'Provide at least one category or kind to update.');
  }
  // The helpers validate (they throw on a bad key or value); merged into {}
  // they return exactly the validated patch. Only that patch is written, and
  // jsonb || merges it in SQL against the row as it stands at UPDATE time, so
  // two switches in flight (the phone flips each kind with its own PATCH; the
  // desktop toggles categories on the same row) can never erase each other.
  const categoryDelta = hasCategories ? applyNotificationPrefPatch({}, categoryPatch) : {};
  const pushDelta = hasPush ? applyAdminPushPrefPatch({}, pushPatch) : {};
  const { rows } = await pool.query(
    `UPDATE users
        SET notification_preferences = COALESCE(notification_preferences, '{}'::jsonb) || $1::jsonb,
            admin_push_preferences = COALESCE(admin_push_preferences, '{}'::jsonb) || $2::jsonb,
            updated_at = NOW()
      WHERE id = $3
      RETURNING notification_preferences, admin_push_preferences`,
    [JSON.stringify(categoryDelta), JSON.stringify(pushDelta), req.user.id]
  );
  res.json({
    notification_preferences: rows[0].notification_preferences,
    admin_push_preferences: fullPushPrefs(rows[0].admin_push_preferences),
  });
}));
```

Add to the exports: `module.exports.applyAdminPushPrefPatch = applyAdminPushPrefPatch;`

- [ ] **Step 4: mePush.js and its mount**

`server/routes/mePush.js`:

```js
'use strict';
// POST /api/me/push-test: one banner to every subscription the caller holds,
// so the phone can prove a device works (spec 2026-08-13-mobile-admin
// section 7, 2026-10-14: the one new push endpoint). Admin or manager, the
// admin write limiter (10 a minute per user). Never throws over a push
// failure: the counts are the answer.
const express = require('express');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { adminWriteLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../middleware/asyncHandler');
// Module object, not destructured, so tests can replace sendPushToUser.
const adminPush = require('../utils/adminPush');

const router = express.Router();

router.post('/push-test', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  if (!adminPush.publicKey()) {
    return res.json({ subscriptions: 0, sent: 0, failed: 0, gone: 0, reason: 'vapid_unset' });
  }
  const r = await adminPush.sendPushToUser({
    userId: req.user.id,
    title: 'Test notification',
    body: 'Push is working on this account.',
    url: '/more/notifications',
    tag: 'push_test',
  });
  const reason = r.subscriptions === 0 ? 'no_subscriptions' : null;
  return res.json({ ...r, reason });
}));

module.exports = router;
```

In `server/index.js`, after line 342 (`app.use('/api/me', require('./routes/me'));`):

```js
app.use('/api/me', require('./routes/mePush')); // POST /push-test (admin push, spec section 7)
```

- [ ] **Step 5: Run both suites, expect all passing**

Run: `node --test server/routes/me.notificationPrefs.test.js` then `node --test server/routes/mePush.test.js`
Expected: `fail 0` each; `mePush.test.js` `pass 4`.

- [ ] **Step 6: Commit**

```bash
git add server/routes/me.js server/routes/me.notificationPrefs.test.js server/routes/mePush.js server/routes/mePush.test.js server/index.js
git commit -F - <<'MSG'
feat(push): kind switches and the VAPID public key on the preferences read and write; the test route

GET/PATCH /api/me/notification-preferences carry admin_push_preferences
(absent = on) and push.public_key (null when the server cannot sign).
POST /api/me/push-test sends one banner to the caller's subscriptions and
answers the counts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 4: The nine call sites name their kind; every drink-plan submit pushes

**Files:**
- Modify: `server/routes/proposals/public.js:573-583`
- Modify: `server/routes/proposals/publicToken.js:600-608`
- Modify: `server/utils/stripePaymentNotifications.js:188-199`
- Modify: `server/utils/bankPaymentProcessingNotify.js:74-94`
- Modify: `server/utils/bankPaymentProcessingNotify.test.js` (one assertion)
- Modify: `server/utils/lastMinuteAlert.js:31-42`
- Modify: `server/routes/staffShiftActions.js` (`notifyManagementOfAction` `:197-222`; the drop `:329-336`; the cover `:465-472`; the swap `:687-696`)
- Modify: `server/utils/smsInbound.js:465-471`
- Modify: `server/utils/smsShiftCommands.js:263-271` (`handleCant`'s result gains `proposalId`)
- Modify: `server/utils/smsInbound.nearestShift.endInstant.test.js:207-241` (one assertion in the test that records the CANT alert)
- Modify: `server/routes/staffShiftActions.test.js` (a push recorder on the drop, cover and swap tests)
- Modify: `server/routes/drinkPlans/submitPlannerV2.test.js` (the drink-plan push pin)
- Modify: `server/routes/drinkPlans/submitNotify.js` (`sendFinancialSubmitNotifications` `:79+`, `sendFastPathConfirmation` `:142+`)

**Interfaces:**
- Consumes: `pushCopy.*` from Task 1; `notifyAdminCategory({ ..., push })` and `pushAdminKind` from Task 2.
- Produces: nothing new; every call below passes a `push` block from `pushCopy`, with `recordId` set, and the categories are unchanged.

- [ ] **Step 1: The two pins first (they fail until the sites change)**

In `server/utils/bankPaymentProcessingNotify.test.js`, in the test that asserts the admin call for an initial (deposit) payment (find it with `grep -n "urgent_booking" server/utils/bankPaymentProcessingNotify.test.js`), add after its category assertion:

```js
  assert.equal(adminCalls[0].push.kind, 'booking_signed_paid');
  assert.match(adminCalls[0].push.title, /Bank payment started/);
  assert.equal(adminCalls[0].push.url, `/events/${id}`);
```

(that test holds the proposal id as `id`, `:82-96`)

and in the routine (non-initial) test: `assert.equal(adminCalls[0].push.kind, 'payment_landed');`. Use the variables that test already holds for the proposal id and the recorded calls (`adminCalls` is the recorder at `:13`).

In `server/utils/smsInbound.nearestShift.endInstant.test.js:207-241`, the test that drives the CANT alert through a `notifyAdminCategory` recorder and reads `sent[0]`, add:

```js
  assert.equal(sent[0].push.kind, 'staffing_drop');
  assert.equal(sent[0].push.recordId, shiftId);
  assert.equal(sent[0].push.url, `/events/${proposalId}`);
  assert.match(sent[0].push.title, /^Shift dropped: /);
```

using the names that test holds for its shift and proposal ids.

In `server/routes/staffShiftActions.test.js`, the drop, cover and swap tests gain a push recorder on the leg itself (the suite has no `notifyAdminCategory` recorder and the module destructures it at load, so the seam is the push leg): at the top, `const adminNotifications = require('../utils/adminNotifications');`, a `before` that inserts one admin row subscribed to `urgent_staffing` with one stored subscription (the shape in `adminNotifications.test.js`) and an `after` that deletes it; in each of the three tests, `const pushed = []; adminNotifications.__setDeps({ sendPushToUser: async (a) => { pushed.push(a); return { subscriptions: 1, sent: 1, failed: 0, gone: 0 }; } });` before the request, `await adminNotifications.__flushPush();` after it, then `assert.equal(pushed[0].tag, 'staffing_drop:' + shiftId)` (cover and swap: `'staffing_cover_swap:' + shiftId`) and `assert.equal(pushed[0].url, '/events/' + proposalId)`, and a `finally` that restores `__setDeps({ sendPushToUser: require('../utils/adminPush').sendPushToUser })`.

In `server/routes/drinkPlans/submitPlannerV2.test.js`, the same recorder around one submit with add-ons and one without (the fast path): both must record exactly one push with `tag` `'drink_plan_submitted:' + proposalId` and `url` `'/events/' + proposalId`, the seeded admin subscribed to `routine_admin`.

Run each: `node --test server/utils/bankPaymentProcessingNotify.test.js`, `node --test server/utils/smsInbound.nearestShift.endInstant.test.js`, `node --test server/routes/staffShiftActions.test.js`, `node --test server/routes/drinkPlans/submitPlannerV2.test.js`. Expected: the touched tests FAIL on `push` or the recorder being empty; everything else passes.

- [ ] **Step 2: The call sites**

Each site adds a `require` of `pushCopy` (from `'../utils/adminPush'` or `'./adminPush'` as the file's depth needs) beside its `notifyAdminCategory` require, and one `push:` line. Nothing else moves.

The date: `formatEventDateLong` from `server/utils/staffShiftHandlers.js` (the bank notice imports it; it takes a row with `event_date` and `event_timezone`). In `public.js` and `publicToken.js` the signed proposal row is `proposal` / `pd`; `publicToken.js`'s `pd` SELECT (`:588-592`) gains `p.event_date, p.event_timezone`. In `stripePaymentNotifications.js`, `pi` carries `event_date` (`:22` reads it for the SMS). Each of `public.js`, `publicToken.js`, `stripePaymentNotifications.js` and `submitNotify.js` adds `const { formatEventDateLong } = require(<relative path to>/utils/staffShiftHandlers);` beside its other requires (`bankPaymentProcessingNotify.js` has it). Where a site cannot cheaply have the date, pass `null`.

`server/routes/proposals/public.js:578-583`:

```js
        await notifyAdminCategory({
          category: 'urgent_booking',
          subject: `New Website Quote: ${eventTypeLabel}`,
          emailHtml: tpl2.html,
          emailText: tpl2.text,
          push: pushCopy.bookingSigned({ clientName: client_name.trim(), eventTypeLabel, proposalId: proposal.id, dateLabel: proposal.event_date ? formatEventDateLong(proposal) : null }),
        });
```

`server/routes/proposals/publicToken.js:603-608`:

```js
        await notifyAdminCategory({
          category: 'urgent_booking',
          subject: tpl.subject,
          emailHtml: tpl.html,
          emailText: tpl.text,
          push: pushCopy.bookingSigned({ clientName: pd.client_name, eventTypeLabel, proposalId: pd.id, dateLabel: pd.event_date ? formatEventDateLong(pd) : null }),
        });
```

`server/utils/stripePaymentNotifications.js:199`:

```js
    const dateLabel = pi?.event_date ? formatEventDateLong(pi) : null;
    const push = isCoupledSigning
      ? pushCopy.bookingSignedPaid({ clientName: pi?.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, proposalId, dateLabel })
      : pushCopy.paymentLanded({ clientName: pi?.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, proposalId, dateLabel });
    await notifyAdminCategory({ category: isCoupledSigning ? 'urgent_booking' : 'routine_finance', subject: adminTpl.subject, emailHtml: adminTpl.html, emailText: adminTpl.text, push });
```

`server/utils/bankPaymentProcessingNotify.js:89-94` (the admin half's SELECT at `:76-80` gains `p.event_date, p.event_timezone`; `formatEventDateLong` is already imported there):

```js
    await notifyAdminCategory({
      category: initial ? 'urgent_booking' : 'routine_finance',
      subject: `Bank payment processing: ${client} (${label})`,
      emailText: `${line} ${url}`,
      emailHtml: `<p>${esc(line)}</p><p><a href="${url}">Open proposal #${proposalId}</a></p>`,
      push: pushCopy.bankPaymentStarted({ clientName: pc.client_name, eventTypeLabel: label, amount: dollars, initial, proposalId, dateLabel: pc.event_date ? formatEventDateLong({ event_date: pc.event_date, event_timezone: pc.event_timezone }) : null }),
    });
```

`server/utils/lastMinuteAlert.js:36-42`:

```js
      await notifyAdminCategory({
        category: 'urgent_booking',
        subject: `Last-minute booking: ${label} on ${date}`,
        emailHtml: `<p>${esc(lmBody)}</p>`,
        emailText: lmBody,
        smsBody: lmBody,
        push: pushCopy.lastMinuteBooking({ eventTypeLabel: label, date, time, proposalId: p.id }),
      });
```

`server/routes/staffShiftActions.js`: the wrapper passes `push` through unchanged:

```js
async function notifyManagementOfAction({
  category,
  subject,
  emailHtml,
  emailText,
  smsBody,
  daysOut,
  push,
}) {
  const args = {
    category,
    subject,
    emailHtml,
    emailText,
  };
  if (smsBody && Number.isFinite(daysOut) && daysOut <= 7) {
    args.smsBody = smsBody;
  }
  if (push) args.push = push;
```

(the rest of the function stays). The drop call (`:329-336`) gains:

```js
    push: pushCopy.staffingDrop({
      clientName: ctx.client_name, eventTypeLabel, dateLabel: eventDateLong, position: ctx.position,
      proposalId: ctx.proposal_id, shiftId: ctx.shift_id,
    }),
```

(`ctx` carries `shift_id`, `proposal_id`, `position`, `client_name` on both the drop and the cover path: verified.)

the cover call (`:465-472`) gains the same shape through `pushCopy.staffingCover`, and the swap call (`:690-695`) gains:

```js
      push: pushCopy.staffingSwap({
        clientName: sc.client_name, eventTypeLabel: sc.event_type_label, dateLabel: sc.event_date_long, position: sc.position,
        proposalId: sc.proposal_id || null, shiftId: swapResult.shift_id,
      }),
```

The swap's `shift_context` (`:641-650`) carries no `proposal_id` today though the row is already selected as `orig.proposal_id` (`:527`): add `proposal_id: orig.proposal_id` to that object (decision 14), so the banner opens the event.

`server/utils/smsInbound.js:465-471`:

```js
    await _deps.notifyAdminCategory({
      category: 'urgent_staffing',
      subject: `Bartender dropped the ${dateStr} shift`,
      emailHtml: ...unchanged...,
      emailText: ...unchanged...,
      ...(daysOut < 7 ? { smsBody: smsLine } : {}),
      push: pushCopy.staffingDrop({
        clientName: cant.clientName, eventTypeLabel: eventLabel, dateLabel: dateStr, position: 'Bartender',
        proposalId: cant.proposalId || null, shiftId: cant.shiftId,
      }),
    });
```

`handleCant` (`server/utils/smsShiftCommands.js:263-271`) returns no `proposalId` today though its SELECT reads `s.proposal_id` (`:133`): add `proposalId: s.proposal_id || null` to the returned object (decision 14; the file is sensitive-listed and in the footprint). The texted command is a bartender's, so the position is the literal.

- [ ] **Step 3: Commit the nine sites**

Run the suites of Step 4 that those files reach (all but the two drink-plan suites), then:

```bash
git add server/routes/proposals/public.js server/routes/proposals/publicToken.js server/utils/stripePaymentNotifications.js server/utils/bankPaymentProcessingNotify.js server/utils/bankPaymentProcessingNotify.test.js server/utils/lastMinuteAlert.js server/routes/staffShiftActions.js server/routes/staffShiftActions.test.js server/utils/smsInbound.js server/utils/smsShiftCommands.js server/utils/smsInbound.nearestShift.endInstant.test.js
git commit -F - <<'MSG'
feat(push): the nine call sites name their kind

Client signed, signed and paid, payment landed, bank payment started,
last-minute booking, shift drops (clean and texted), cover requests and
swap proposals each pass a push block from pushCopy, with the event date
where the site has it. Texted drops and swaps now carry the proposal id.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

- [ ] **Step 3b: The drink plan pushes on every submit (its own commit: new behaviour, reverts on its own)**

In `server/routes/drinkPlans/submitNotify.js`, add `pushAdminKind` to the `adminNotifications` require and `pushCopy` from `'../../utils/adminPush'`. In `sendFinancialSubmitNotifications`, BEFORE the `if (pendingNotifications.balanceChanged)` block (the email keeps its throttle; the push does not have one):

```js
  // Every submit pushes (spec section 7, 2026-10-14): the submit is Dallas's
  // cue to start the shopping list and the menu. The email below keeps its
  // balance-changed throttle. Push only, under routine_admin like the email.
  pushAdminKind({
    category: 'routine_admin',
    push: pushCopy.drinkPlanSubmitted({
      clientName,
      eventTypeLabel: getEventTypeLabel({ event_type: pn.event_type, event_type_custom: pn.event_type_custom }),
      proposalId: pn.id,
      dateLabel: pn.event_date ? formatEventDateLong(pn) : null,
    }),
  }).catch((err) => console.error('Drink plan push failed (non-blocking):', err && err.message));
```

In `sendFastPathConfirmation`, right after the row is read (`const row = r.rows[0]` or whatever the function names it; the SELECT already returns `p.id`, `c.name AS client_name`, `p.event_type`, `p.event_type_custom`; add `p.event_date, p.event_timezone` to it, and import `formatEventDateLong` from `'../../utils/staffShiftHandlers'`), and before the `client_email` check so a client with no email still pushes:

```js
    if (row && row.id) {
      pushAdminKind({
        category: 'routine_admin',
        push: pushCopy.drinkPlanSubmitted({
          clientName: row.client_name,
          eventTypeLabel: getEventTypeLabel({ event_type: row.event_type, event_type_custom: row.event_type_custom }),
          proposalId: row.id,
          dateLabel: row.event_date ? formatEventDateLong(row) : null,
        }),
      }).catch((err) => console.error('Drink plan push failed (non-blocking):', err && err.message));
    }
```

- [ ] **Step 4: The suites the change reaches, one at a time, reading each pass count**

```bash
node --test server/utils/bankPaymentProcessingNotify.test.js
node --test server/utils/smsInbound.test.js
node --test server/utils/smsInbound.nearestShift.endInstant.test.js
node --test server/routes/staffShiftActions.test.js
node --test server/routes/proposals/publicToken.test.js
node --test server/routes/proposals/publicToken.signPhone.test.js
node --test server/routes/drinkPlans/submitExtras.test.js
node --test server/routes/drinkPlans/submitPlannerV2.test.js
node --test server/utils/adminNotifications.test.js
```

Expected: `fail 0` in every file. The real `notifyAdminCategory` runs in several of them; with no VAPID keys in the dev env `sendPush` answers `vapid_unset` and nothing reaches a network. If a dev-DB admin row holds a stored subscription, a push leg may run after a suite's `pool.end()`: `sendPushToUser` catches the pool error and returns zeros, so no open handle and no failing test, one stray Sentry capture at most. The two sites with no suite of their own (`stripePaymentNotifications.js`, `lastMinuteAlert.js`) are read by `consistency-check` at lane close against the kind map in the spec. `public.js`'s quote submit does NOT push (controller ruling at the Task 4 review, 2026-10-14: it is a quote request, not a signature; the spec's kind map was amended the same day), so that file is unchanged by the lane.

- [ ] **Step 5: Commit the drink-plan emit**

```bash
git add server/routes/drinkPlans/submitNotify.js server/routes/drinkPlans/submitPlannerV2.test.js
git commit -F - <<'MSG'
feat(push): every drink-plan submit pushes, from both post-commit tails

The submit is the cue to start the shopping list and the menu. Push only;
the admin email keeps its balance-changed throttle.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 5: A passkey revoke deletes every stored subscription

**Files:**
- Modify: `server/routes/webauthn.js:205-208` (inside the revoke transaction)
- Modify: `server/routes/webauthn.test.js` (extend the test at `:276`)

**Interfaces:**
- Consumes: `deleteAllSubscriptions(userId, client)` from Task 1.
- Produces: nothing new. The revoke is already a global logout (`token_version` bump); it now also empties `staff_notification_preferences.push_subscriptions`, so a lost phone stops buzzing.

- [ ] **Step 1: The failing assertion**

In the `:276` test, before the owner's DELETE, seed a subscription on `userA`:

```js
  await pool.query(
    `UPDATE users SET staff_notification_preferences = jsonb_set(COALESCE(staff_notification_preferences, '{}'::jsonb), '{push_subscriptions}', '[{"endpoint":"https://push.example.test/revoke","keys":{"p256dh":"p","auth":"a"}}]'::jsonb, true) WHERE id = $1`,
    [userA.id]
  );
```

and after the `ok` assertion:

```js
  const subs = (await pool.query(`SELECT staff_notification_preferences->'push_subscriptions' AS s FROM users WHERE id = $1`, [userA.id])).rows[0].s;
  assert.deepEqual(subs, [], 'a revoke empties the stored push subscriptions (spec section 7, 2026-10-14)');
```

Run: `node --test server/routes/webauthn.test.js`. Expected: that test FAILS on the subscriptions assertion; the rest pass.

- [ ] **Step 2: The one line**

In `server/routes/webauthn.js`, add `const { deleteAllSubscriptions } = require('../utils/adminPush');` with the other requires, and after the `token_version` UPDATE (`:207`), still on `client`:

```js
      // A revoke is a global logout; the phones' push subscriptions go with it
      // (spec section 7, 2026-10-14), so a lost phone stops buzzing. The
      // remaining phones re-enable with one tap.
      await deleteAllSubscriptions(req.user.id, client);
```

- [ ] **Step 3: Run, expect all passing**

Run: `node --test server/routes/webauthn.test.js`. Expected: `fail 0`.

- [ ] **Step 4: Commit**

```bash
git add server/routes/webauthn.js server/routes/webauthn.test.js
git commit -F - <<'MSG'
feat(push): a passkey revoke empties the stored push subscriptions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Checkpoint A: security and database review of the server contract (orchestrator)

Before any client task: a `security-review` agent and a `database-review` agent (os `.claude/agents`, or general-purpose agents given those briefs when the os agents are not registered in the session) read the lane's diff for Tasks 1 to 5 against main, this plan's header, and the spec's section 7. Questions they answer: can any call reach a phone without a kind (no); can a category turned off on desktop push (no); does the banner copy carry PII beyond name, kind, date and amount (no); is the test route scoped to the caller and limited; does the prune hold a connection across a send; is the column default and the `fullPushPrefs` fallback consistent with "absent = on"; does the revoke's purge run on the transaction's client. A FAIL goes back to the task that owns it before Task 6 starts; the plan on main records what changed.

### Task 6: The admin push module on the phone, and logout's unsubscribe

**Files:**
- Modify: `client/src/utils/pushSubscribe.js` (`isPushSubscribed` `:85-97`, `subscribePush` `:108-155`, `unsubscribePush` `:163-185` take an options object; defaults keep the staff portal's behaviour)
- Modify: `client/src/utils/pushSubscribe.test.js` (append)
- Create: `client/src/utils/adminPush.js`
- Create: `client/src/utils/adminPush.test.js`
- Modify: `client/src/context/AuthContext.js:112-117` (one call in `logout`)
- Modify: `client/src/context/AuthContext.test.js` (one assertion: logout unsubscribes)

**Interfaces:**
- Consumes: `POST`/`DELETE /me/push-subscriptions` (existing).
- Produces: `pushSubscribe.js`: `isPushSubscribed({ swPath } = {})`, `subscribePush({ swPath, vapidKey } = {})`, `unsubscribePush({ swPath } = {})`; the staff callers pass nothing and get `/staff-sw.js` and the build-time key. `adminPush.js`: `ADMIN_SW_PATH = '/admin-sw.js'`; `readDevicePushState() -> Promise<'unsupported'|'blocked'|'on'|'off'>` (permission first, then this device's admin subscription); `enableAdminPush(publicKey) -> Promise<{ ok, state }>` (`state` is `'granted'`, `'denied'`, `'default'`, or `'unsupported'`; a missing key resolves `{ ok: false, state: 'server_unset' }`); `disableAdminPush() -> Promise<{ ok: true }>`. Task 7's view-model and Task 8's screen and More row consume these.

- [ ] **Step 1: The failing tests**

In `client/src/utils/pushSubscribe.test.js`: the two `import` lines and the `jest.mock` below go at the TOP of the file with its existing import (`import/first`); the `describe` block is appended at the end. The fake resolves a registration by script path, but the browser's `getRegistration` resolves by scope (`client/src/utils/adminSw.js:21-22`), so on one origin the two workers share a scope and the path selects nothing: this test proves the plumbing passes the path and key through, not that the two workers are kept apart. Say so in the test's comment.

```js
import { isPushSubscribed, unsubscribePush, subscribePush } from './pushSubscribe';
import api from './api';

jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn(), delete: jest.fn() } }));

function fakeServiceWorker(regs) {
  // regs: { [swPath]: { sub | null } }. getRegistration(path) resolves the
  // registration for that path; register(path) creates one.
  const made = {};
  const regFor = (path) => {
    if (!made[path]) {
      const state = regs[path] || { sub: null };
      made[path] = {
        pushManager: {
          getSubscription: async () => state.sub,
          subscribe: async () => {
            state.sub = { endpoint: `https://push.example.test${path}`, toJSON: () => ({ endpoint: `https://push.example.test${path}`, keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: async () => { state.sub = null; return true; } };
            return state.sub;
          },
        },
      };
    }
    return made[path];
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async (p) => (p in regs ? regFor(p) : undefined), register: async (p) => regFor(p), ready: Promise.resolve() },
  });
  return { regFor, regs };
}

describe('pushSubscribe takes the service worker path', () => {
  afterEach(() => { delete navigator.serviceWorker; delete window.PushManager; delete window.Notification; });

  test('isPushSubscribed reads the registration it is asked about, staff by default', async () => {
    fakeServiceWorker({ '/staff-sw.js': { sub: null }, '/admin-sw.js': { sub: { endpoint: 'e' } } });
    expect(await isPushSubscribed()).toBe(false);
    expect(await isPushSubscribed({ swPath: '/admin-sw.js' })).toBe(true);
  });

  test('subscribePush registers the path it is given with the key it is given', async () => {
    window.PushManager = function PushManager() {};
    window.Notification = { permission: 'granted', requestPermission: async () => 'granted' };
    const sw = fakeServiceWorker({});
    const r = await subscribePush({ swPath: '/admin-sw.js', vapidKey: 'BJ3wofapYuJxZLJIjw7ytucfavC7v1_WkVPG9IDPY-8AN_EulCTtB7JfwVZ1lFotJbtaKcsVhTMrjtltE6MtSIE' });
    expect(r).toEqual({ ok: true, state: 'granted' });
    expect(await sw.regFor('/admin-sw.js').pushManager.getSubscription()).not.toBeNull();
    expect(api.post).toHaveBeenCalledWith('/me/push-subscriptions', expect.objectContaining({ endpoint: 'https://push.example.test/admin-sw.js' }));
  });

  test('subscribePush with no key is unsupported, and a denied permission is denied', async () => {
    window.PushManager = function PushManager() {};
    window.Notification = { permission: 'denied', requestPermission: async () => 'denied' };
    fakeServiceWorker({});
    expect(await subscribePush({ swPath: '/admin-sw.js', vapidKey: null })).toEqual({ ok: false, state: 'unsupported' });
    expect(await subscribePush({ swPath: '/admin-sw.js', vapidKey: 'k' })).toEqual({ ok: false, state: 'denied' });
  });

  test('unsubscribePush tears down the path it is given and tells the server', async () => {
    const sw = fakeServiceWorker({ '/admin-sw.js': { sub: null } });
    await sw.regFor('/admin-sw.js').pushManager.subscribe();
    await unsubscribePush({ swPath: '/admin-sw.js' });
    expect(await sw.regFor('/admin-sw.js').pushManager.getSubscription()).toBeNull();
    expect(api.delete).toHaveBeenCalledWith('/me/push-subscriptions', { data: { endpoint: 'https://push.example.test/admin-sw.js' } });
  });
});
```

`client/src/utils/adminPush.test.js`:

```js
import '@testing-library/jest-dom';
import { readDevicePushState, enableAdminPush, disableAdminPush, ADMIN_SW_PATH } from './adminPush';
import * as pushSubscribe from './pushSubscribe';

jest.mock('./pushSubscribe', () => ({
  permissionState: jest.fn(),
  isPushSubscribed: jest.fn(),
  subscribePush: jest.fn(),
  unsubscribePush: jest.fn(),
}));

describe('readDevicePushState', () => {
  test('unsupported wins, then blocked, then this device\'s admin subscription', async () => {
    pushSubscribe.permissionState.mockReturnValue('unsupported');
    expect(await readDevicePushState()).toBe('unsupported');
    pushSubscribe.permissionState.mockReturnValue('denied');
    pushSubscribe.isPushSubscribed.mockResolvedValue(true);
    expect(await readDevicePushState()).toBe('blocked');
    pushSubscribe.permissionState.mockReturnValue('granted');
    pushSubscribe.isPushSubscribed.mockResolvedValue(true);
    expect(await readDevicePushState()).toBe('on');
    expect(pushSubscribe.isPushSubscribed).toHaveBeenCalledWith({ swPath: ADMIN_SW_PATH });
    pushSubscribe.isPushSubscribed.mockResolvedValue(false);
    expect(await readDevicePushState()).toBe('off');
    pushSubscribe.permissionState.mockReturnValue('default');
    expect(await readDevicePushState()).toBe('off');
  });
});

describe('enableAdminPush and disableAdminPush', () => {
  test('enable passes the admin worker and the server key; no key is server_unset', async () => {
    pushSubscribe.subscribePush.mockResolvedValue({ ok: true, state: 'granted' });
    expect(await enableAdminPush('KEY')).toEqual({ ok: true, state: 'granted' });
    expect(pushSubscribe.subscribePush).toHaveBeenCalledWith({ swPath: ADMIN_SW_PATH, vapidKey: 'KEY' });
    expect(await enableAdminPush(null)).toEqual({ ok: false, state: 'server_unset' });
  });
  test('enable never throws: a rejected subscribe is a failed state', async () => {
    pushSubscribe.subscribePush.mockRejectedValue(new Error('AbortError'));
    expect(await enableAdminPush('KEY')).toEqual({ ok: false, state: 'failed' });
  });
  test('disable unsubscribes the admin worker', async () => {
    pushSubscribe.unsubscribePush.mockResolvedValue({ ok: true });
    expect(await disableAdminPush()).toEqual({ ok: true });
    expect(pushSubscribe.unsubscribePush).toHaveBeenCalledWith({ swPath: ADMIN_SW_PATH });
  });
});
```

- [ ] **Step 2: Run both, expect failures**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/pushSubscribe.test.js src/utils/adminPush.test.js`
Expected: FAIL (`isPushSubscribed` ignores its argument; `./adminPush` missing).

- [ ] **Step 3: pushSubscribe.js takes options**

Add near the top: `const STAFF_SW_PATH = '/staff-sw.js';` and a comment: `// The staff portal registers /staff-sw.js with the build-time key; the admin phone passes its own worker and the key the API served (client/src/utils/adminPush.js).`

`isPushSubscribed`:

```js
export async function isPushSubscribed({ swPath = STAFF_SW_PATH } = {}) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration(swPath);
    if (!reg) return false;
    const sub = await reg.pushManager.getSubscription();
    return !!sub;
  } catch {
    return false;
  }
}
```

`subscribePush`: signature `export async function subscribePush({ swPath = STAFF_SW_PATH, vapidKey = process.env.REACT_APP_VAPID_PUBLIC_KEY } = {})`; replace the `const vapidKey = process.env...` line with nothing (the parameter is the key) and `navigator.serviceWorker.register('/staff-sw.js')` with `register(swPath)`. The body is otherwise unchanged.

`unsubscribePush`: signature `export async function unsubscribePush({ swPath = STAFF_SW_PATH } = {})`; `getRegistration('/staff-sw.js')` becomes `getRegistration(swPath)`.

- [ ] **Step 4: adminPush.js**

```js
// The admin phone's push state and switches (spec 2026-08-13-mobile-admin
// section 7, 2026-10-14). Thin over pushSubscribe.js: this file knows the
// admin worker's path and the rule that the switch shows this device's REAL
// state (Android's permission, then whether the admin registration holds a
// subscription), never a stored flag. The VAPID key comes from the API
// (GET /me/notification-preferences, push.public_key), not from the build.
import { permissionState, isPushSubscribed, subscribePush, unsubscribePush } from './pushSubscribe';

export const ADMIN_SW_PATH = '/admin-sw.js';

export async function readDevicePushState() {
  const perm = permissionState();
  if (perm === 'unsupported') return 'unsupported';
  if (perm === 'denied') return 'blocked';
  const subscribed = await isPushSubscribed({ swPath: ADMIN_SW_PATH });
  return perm === 'granted' && subscribed ? 'on' : 'off';
}

// Resolves a state object, never throws: the switch's row says why.
export async function enableAdminPush(publicKey) {
  if (!publicKey) return { ok: false, state: 'server_unset' };
  try {
    return await subscribePush({ swPath: ADMIN_SW_PATH, vapidKey: publicKey });
  } catch (e) {
    return { ok: false, state: 'failed' };
  }
}

export async function disableAdminPush() {
  try {
    return await unsubscribePush({ swPath: ADMIN_SW_PATH });
  } catch (e) {
    return { ok: true };
  }
}
```

- [ ] **Step 5: Logout unsubscribes this device**

In `client/src/context/AuthContext.js`, import `{ disableAdminPush } from '../utils/adminPush'` and make `logout`:

```js
  const logout = () => {
    // Spec 2026-08-13-mobile-admin section 7: logout purges the phone's SW
    // caches and shell localStorage (one call, defined in utils/adminSw.js)
    // and unsubscribes this device from push. The browser-side unsubscribe is
    // immediate; the server's DELETE rides the token if it wins the race
    // below, and otherwise the dead endpoint dies on the next send's 410
    // (2026-10-14). Best effort, never awaited: logout must not wait on a
    // push service.
    disableAdminPush().catch(() => {});
    purgeMobileAdminState();
    localStorage.removeItem('token');
    setUser(null);
  };
```

`AuthContext.js` is sensitive-listed; this is the only line it gains. In `client/src/context/AuthContext.test.js` (it already mocks `../utils/adminSw` and `../utils/api`, so the new import loads), add `jest.mock('../utils/adminPush', () => ({ disableAdminPush: () => { mockDisableCalls.push(1); return Promise.resolve({ ok: true }); } }));` with `const mockDisableCalls = [];` above it, and in the test that exercises `logout` (or a new one that renders the provider, calls `logout` from a consumer, and checks the token is gone) assert `expect(mockDisableCalls).toHaveLength(1)`. `AdminLayout.badges.test.js` mocks AuthContext whole and needs nothing.

- [ ] **Step 6: Run, expect all passing, then the client gate**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/pushSubscribe.test.js src/utils/adminPush.test.js src/context` then `CI=true npx react-scripts build`.
Expected: all pass; build exit 0.

- [ ] **Step 7: Commit**

```bash
git add client/src/utils/pushSubscribe.js client/src/utils/pushSubscribe.test.js client/src/utils/adminPush.js client/src/utils/adminPush.test.js client/src/context/AuthContext.js
git commit -F - <<'MSG'
feat(push): pushSubscribe takes the worker path and key; the admin device state; logout unsubscribes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 7: The pure view-model and the CSS

**Files:**
- Create: `client/src/utils/notificationsView.js`
- Create: `client/src/utils/notificationsView.test.js`
- Modify: `client/src/index.css` (append after the `.m-more-row` block that ends at `:21274`, and the House Lights block near `:21336`)

**Interfaces:**
- Consumes: nothing.
- Produces: `KIND_GROUPS` (the three groups with `label`, `help`, `kinds: [{ kind, label }]`, in benchmark order); `kindOn(prefs, kind)`; `phoneState({ device, publicKey })` -> `'on' | 'off' | 'blocked' | 'server_unset' | 'unsupported'`; `phoneSub(state, prompting)` (the switch row's sub-line); `rowState(state)` -> `{ text: 'On'|'Off'|'Blocked', tone: 'on'|'off'|'warn' }` (the More row); `testStatus({ offline, state, test })` -> `{ text, tone: 'ok'|'muted'|'danger'|null, disabled }`; `catsIntro(state)`; `NOTE_BLOCKED`, `NOTE_SERVER_UNSET`, `FOOT_LINES`, `OFFLINE_BANNER` copy constants. CSS classes: `.m-switch`, `.m-switch-track`, `.m-switch-thumb`, `.m-more-row.m-switch-row`, `.m-more-sub`, `.m-more-state(.on/.off/.warn)`, `.m-notif-note`, `.m-notif-banner`, `.m-notif-intro`, `.m-notif-group`, `.m-notif-group-label`, `.m-notif-group-help`, `.m-notif-foot`, `.m-notif-skel`, `.m-notif-skel-bar`, `.m-notif-skel-pill`, `.m-notif-retry`. Task 8 consumes all of it.

- [ ] **Step 1: The failing test**

`client/src/utils/notificationsView.test.js`:

```js
import '@testing-library/jest-dom';
import {
  KIND_GROUPS, kindOn, phoneState, phoneSub, rowState, testStatus, catsIntro,
  NOTE_BLOCKED, NOTE_SERVER_UNSET, FOOT_LINES, OFFLINE_BANNER,
} from './notificationsView';

test('the three groups carry the seven kinds in the benchmark order with its copy', () => {
  expect(KIND_GROUPS.map((g) => g.label)).toEqual(['Bookings and payments', 'Drink plans', 'Staffing']);
  expect(KIND_GROUPS.flatMap((g) => g.kinds.map((k) => k.kind))).toEqual([
    'booking_signed', 'booking_signed_paid', 'payment_landed', 'booking_last_minute', 'drink_plan_submitted', 'staffing_drop', 'staffing_cover_swap',
  ]);
  expect(KIND_GROUPS.flatMap((g) => g.kinds.map((k) => k.label))).toEqual([
    'Client signed', 'Signed and paid', 'Payment landed', 'Last-minute booking', 'Plan submitted', 'Shift drops', 'Cover and swaps',
  ]);
  expect(KIND_GROUPS[1].help).toBe('A client submits their drink plan. Your cue to start the shopping list and the menu.');
});

test('kindOn: absent is on', () => {
  expect(kindOn({}, 'staffing_drop')).toBe(true);
  expect(kindOn({ staffing_drop: false }, 'staffing_drop')).toBe(false);
  expect(kindOn(null, 'staffing_drop')).toBe(true);
});

test('phoneState: the server key gates a device that would otherwise be off or on', () => {
  expect(phoneState({ device: 'on', publicKey: 'k' })).toBe('on');
  expect(phoneState({ device: 'off', publicKey: 'k' })).toBe('off');
  expect(phoneState({ device: 'off', publicKey: null })).toBe('server_unset');
  expect(phoneState({ device: 'on', publicKey: null })).toBe('server_unset');
  expect(phoneState({ device: 'blocked', publicKey: null })).toBe('blocked');
  expect(phoneState({ device: 'unsupported', publicKey: 'k' })).toBe('unsupported');
});

test('the switch row sub-line, the More row state and the intro follow the benchmark copy', () => {
  expect(phoneSub('on', false)).toBe('Banners for what you pick below');
  expect(phoneSub('off', false)).toBe('Android asks for permission when you turn this on');
  expect(phoneSub('blocked', false)).toBe('Blocked in Android settings');
  expect(phoneSub('server_unset', false)).toBe('Not set up on the server yet');
  expect(phoneSub('off', true)).toBe('Android is asking for permission…');
  expect(rowState('on')).toEqual({ text: 'On', tone: 'on' });
  expect(rowState('off')).toEqual({ text: 'Off', tone: 'off' });
  expect(rowState('server_unset')).toEqual({ text: 'Off', tone: 'off' });
  expect(rowState('blocked')).toEqual({ text: 'Blocked', tone: 'warn' });
  expect(catsIntro('on')).toBe('Saved to your account, so every phone you turn on follows these.');
  expect(catsIntro('off')).toBe('Saved to your account. Nothing reaches this phone until it is on above.');
});

test('the test row status', () => {
  expect(testStatus({ offline: true, state: 'on', test: 'idle' })).toEqual({ text: 'Offline', tone: 'muted', disabled: true });
  expect(testStatus({ offline: false, state: 'off', test: 'idle' })).toEqual({ text: 'Phone is off', tone: 'muted', disabled: true });
  expect(testStatus({ offline: false, state: 'server_unset', test: 'idle' })).toEqual({ text: 'Phone is off', tone: 'muted', disabled: true });
  expect(testStatus({ offline: false, state: 'on', test: 'idle' })).toEqual({ text: '', tone: null, disabled: false });
  expect(testStatus({ offline: false, state: 'on', test: 'sending' })).toEqual({ text: 'Sending', tone: 'muted', disabled: false });
  expect(testStatus({ offline: false, state: 'on', test: 'sent' })).toEqual({ text: 'Sent', tone: 'ok', disabled: false });
  expect(testStatus({ offline: false, state: 'on', test: 'failed' })).toEqual({ text: 'Didn’t send', tone: 'danger', disabled: false });
});

test('copy constants carry no em dash', () => {
  const all = [NOTE_BLOCKED, NOTE_SERVER_UNSET, ...FOOT_LINES, OFFLINE_BANNER.title, OFFLINE_BANNER.body, ...KIND_GROUPS.map((g) => g.help)];
  for (const s of all) expect(s).not.toMatch(/\u2014/);
  expect(NOTE_BLOCKED).toBe('Android has blocked notifications for DrB OS. Allow them for DrB OS in Android settings, then come back here.');
  expect(NOTE_SERVER_UNSET).toBe('Push isn’t set up on the server yet.');
  expect(FOOT_LINES).toEqual(['Texts and emails keep coming as they do today. This only adds the phone banner.', 'Managers see this same page for their own account.']);
  expect(OFFLINE_BANNER).toEqual({ title: 'Offline', body: 'Changing these needs a connection. You are looking at the last saved settings.' });
});
```

- [ ] **Step 2: Run it, expect a missing module**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/notificationsView.test.js`
Expected: FAIL, cannot find `./notificationsView`.

- [ ] **Step 3: The module**

`client/src/utils/notificationsView.js`:

```js
// The Notifications screen's copy and state rules (spec 2026-08-13-mobile-admin
// section 3, "Design-session decisions of 2026-10-14", and section 7). Pure:
// no React, no network, so the words the screen shows are pinned by tests.
// Copy law: no em dashes; the typographic apostrophe where the benchmark
// draws one.

export const KIND_GROUPS = [
  {
    label: 'Bookings and payments',
    help: 'A client signs and pays, or a last-minute booking comes in.',
    kinds: [
      { kind: 'booking_signed', label: 'Client signed' },
      { kind: 'booking_signed_paid', label: 'Signed and paid' },
      { kind: 'payment_landed', label: 'Payment landed' },
      { kind: 'booking_last_minute', label: 'Last-minute booking' },
    ],
  },
  {
    label: 'Drink plans',
    help: 'A client submits their drink plan. Your cue to start the shopping list and the menu.',
    kinds: [{ kind: 'drink_plan_submitted', label: 'Plan submitted' }],
  },
  {
    label: 'Staffing',
    help: 'A staff member drops a shift, or asks for cover or a swap.',
    kinds: [
      { kind: 'staffing_drop', label: 'Shift drops' },
      { kind: 'staffing_cover_swap', label: 'Cover and swaps' },
    ],
  },
];

export const NOTE_BLOCKED = 'Android has blocked notifications for DrB OS. Allow them for DrB OS in Android settings, then come back here.';
export const NOTE_SERVER_UNSET = 'Push isn’t set up on the server yet.';
export const FOOT_LINES = [
  'Texts and emails keep coming as they do today. This only adds the phone banner.',
  'Managers see this same page for their own account.',
];
export const OFFLINE_BANNER = { title: 'Offline', body: 'Changing these needs a connection. You are looking at the last saved settings.' };

// An absent key is ON (the server stores only explicit values).
export const kindOn = (prefs, kind) => !prefs || prefs[kind] !== false;

// device: readDevicePushState()'s answer. The server's key gates on and off:
// with no key nothing can subscribe, and a stale subscription cannot be
// served, so the honest state is "not set up on the server".
export function phoneState({ device, publicKey }) {
  if (device === 'unsupported' || device === 'blocked') return device;
  if (!publicKey) return 'server_unset';
  return device === 'on' ? 'on' : 'off';
}

export function phoneSub(state, prompting) {
  if (prompting) return 'Android is asking for permission…';
  if (state === 'on') return 'Banners for what you pick below';
  if (state === 'blocked') return 'Blocked in Android settings';
  if (state === 'server_unset') return 'Not set up on the server yet';
  return 'Android asks for permission when you turn this on';
}

export function rowState(state) {
  if (state === 'on') return { text: 'On', tone: 'on' };
  if (state === 'blocked') return { text: 'Blocked', tone: 'warn' };
  return { text: 'Off', tone: 'off' };
}

export function catsIntro(state) {
  return state === 'on'
    ? 'Saved to your account, so every phone you turn on follows these.'
    : 'Saved to your account. Nothing reaches this phone until it is on above.';
}

// test: 'idle' | 'sending' | 'sent' | 'failed'
export function testStatus({ offline, state, test }) {
  if (offline) return { text: 'Offline', tone: 'muted', disabled: true };
  if (state !== 'on') return { text: 'Phone is off', tone: 'muted', disabled: true };
  // Sending keeps the row's ink (the benchmark's nTestInk stays ink 1); the
  // handler ignores a second tap while a send is in flight (decision 15).
  if (test === 'sending') return { text: 'Sending', tone: 'muted', disabled: false };
  if (test === 'sent') return { text: 'Sent', tone: 'ok', disabled: false };
  if (test === 'failed') return { text: 'Didn’t send', tone: 'danger', disabled: false };
  return { text: '', tone: null, disabled: false };
}
```

- [ ] **Step 4: Run, expect 6 passing**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/notificationsView.test.js`. Expected: 6 pass.

- [ ] **Step 5: The CSS**

Append to `client/src/index.css` right after `html[data-app="admin-os"] .m-more-row svg:last-child { ... }` (`:21274`). The switch rules are the vendored `components-mobile.css` block with the product's `html[data-app="admin-os"]` prefix; the numbers are the benchmark's (the design's inline styles for the note row, the banner, the groups and the skeleton):

```css
/* ---- Switch (mobile on/off, the design system's .m-switch family, added
   2026-10-14 for More > Notifications). Two uses: standalone <button
   class="m-switch" role="switch"> with the track inside, or a whole
   .m-more-row as the switch with the track as its last child. State is read
   from aria-checked / :disabled / aria-busy on the parent. ---- */
html[data-app="admin-os"] .m-switch {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  min-width: 44px; min-height: 44px; padding: 0; border: none; background: none; cursor: pointer;
}
html[data-app="admin-os"] span.m-switch-track {
  position: relative; flex: none; width: 40px; height: 24px; box-sizing: border-box;
  border-radius: 999px; border: 1px solid var(--line-2); background: var(--bg-3);
  transition: background 160ms ease, border-color 160ms ease, opacity 160ms ease;
}
html[data-app="admin-os"] span.m-switch-thumb {
  position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
  background: var(--ink-3);
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1), background 160ms ease;
}
html[data-app="admin-os"] [aria-checked="true"] > span.m-switch-track { background: var(--accent); border-color: var(--accent); }
html[data-app="admin-os"] [aria-checked="true"] > span.m-switch-track > span.m-switch-thumb { transform: translateX(16px); background: #fff; }
html[data-app="admin-os"] :disabled > span.m-switch-track,
html[data-app="admin-os"] [aria-disabled="true"] > span.m-switch-track { opacity: 0.4; }
html[data-app="admin-os"] [aria-busy="true"] > span.m-switch-track > span.m-switch-thumb { transform: translateX(8px); animation: m-pulse 1.2s ease-in-out infinite; }
html[data-app="admin-os"] :focus-visible > span.m-switch-track { outline: 2px solid var(--accent-line); outline-offset: 2px; }
/* A switch row: the two-line label, 56px for the phone switch. */
html[data-app="admin-os"] .m-more-row.m-switch-row { min-height: 56px; padding-top: 8px; padding-bottom: 8px; }
html[data-app="admin-os"] .m-more-row:disabled { cursor: default; }
html[data-app="admin-os"] .m-more-row .m-more-sub { display: block; flex: none; margin-top: 2px; font-size: var(--fs-meta, 11.5px); color: var(--ink-3); line-height: 1.4; }
/* The trailing state on a row ("On", "Sent", "Didn't send"): mono, 10px, uppercase. */
html[data-app="admin-os"] .m-more-row .m-more-state { flex: none; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-4); }
html[data-app="admin-os"] .m-more-state.on { color: var(--ink-2); }
html[data-app="admin-os"] .m-more-state.ok { color: hsl(var(--ok-h) var(--ok-s) 52%); }
html[data-app="admin-os"] .m-more-state.warn { color: hsl(var(--warn-h) var(--warn-s) 62%); }
html[data-app="admin-os"] .m-more-state.danger { color: hsl(var(--danger-h) var(--danger-s) 70%); }
html[data-app="admin-os"][data-skin="light"] .m-more-state.ok { color: var(--ms-emerald); }
html[data-app="admin-os"][data-skin="light"] .m-more-state.warn { color: hsl(var(--warn-h) var(--warn-s) 34%); }
html[data-app="admin-os"][data-skin="light"] .m-more-state.danger { color: var(--ms-bordeaux); }
html[data-app="admin-os"] .m-notif-retry { flex: none; min-height: 44px; padding: 0 8px; border: none; background: transparent; color: hsl(212 60% 62%); font-family: var(--font-ui); font-size: 12.5px; font-weight: 600; cursor: pointer; }
/* A kind row whose save failed: the switch and its Retry sit side by side in the li. */
html[data-app="admin-os"] .m-more-list li.m-row-retry { display: flex; align-items: center; }
html[data-app="admin-os"] .m-more-list li.m-row-retry > .m-more-row { flex: 1; min-width: 0; }
/* The note under the phone switch (blocked, or not set up on the server). */
html[data-app="admin-os"] .m-notif-note { display: flex; gap: 10px; align-items: flex-start; padding: 10px 16px 12px; background: var(--bg-1); font-size: var(--fs-meta, 11.5px); color: var(--ink-2); line-height: 1.5; text-wrap: pretty; }
html[data-app="admin-os"] .m-notif-note svg { flex: none; margin-top: 1px; color: hsl(var(--warn-h) var(--warn-s) 62%); }
html[data-app="admin-os"][data-skin="light"] .m-notif-note svg { color: hsl(var(--warn-h) var(--warn-s) 34%); }
/* The offline banner at the top of the screen. */
html[data-app="admin-os"] .m-notif-banner { margin: 0 0 14px; padding: 10px 12px; border: 1px solid var(--line-2); border-radius: var(--radius); background: var(--bg-1); display: flex; gap: 8px; align-items: flex-start; }
html[data-app="admin-os"] .m-notif-banner .m-stale-dot { margin-top: 6px; }
html[data-app="admin-os"] .m-notif-banner-title { font-size: var(--fs-meta, 11.5px); font-weight: 600; color: var(--ink-1); }
html[data-app="admin-os"] .m-notif-banner-body { font-size: var(--fs-meta, 11.5px); color: var(--ink-3); line-height: 1.5; text-wrap: pretty; }
/* What buzzes: the intro, a group's label and help, the closing lines. */
html[data-app="admin-os"] .m-notif-intro { margin: 0 2px 12px; font-size: var(--fs-meta, 11.5px); color: var(--ink-3); line-height: 1.5; text-wrap: pretty; }
html[data-app="admin-os"] .m-notif-group { margin: 0 0 14px; }
html[data-app="admin-os"] .m-notif-group-label { padding: 0 2px; font-size: 12.5px; font-weight: 600; color: var(--ink-1); }
html[data-app="admin-os"] .m-notif-group-help { padding: 2px 2px 7px; font-size: var(--fs-meta, 11.5px); color: var(--ink-3); line-height: 1.45; text-wrap: pretty; }
html[data-app="admin-os"] .m-notif-foot { display: flex; flex-direction: column; gap: 6px; padding: 0 2px 10px; font-size: var(--fs-meta, 11.5px); color: var(--ink-3); line-height: 1.55; text-wrap: pretty; }
/* Loading: three groups of pulsing bars and track-shaped pills. */
html[data-app="admin-os"] .m-notif-skel-bar { height: 10px; border-radius: 3px; background: var(--bg-3); animation: m-pulse 1.4s ease-in-out infinite; }
html[data-app="admin-os"] .m-notif-skel-bar.heading { height: 9px; margin: 2px 0 9px; }
html[data-app="admin-os"] .m-notif-skel-pill { width: 40px; height: 24px; flex: none; border-radius: 999px; background: var(--bg-3); animation: m-pulse 1.4s ease-in-out infinite; }
html[data-app="admin-os"] .m-notif-skel li { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 0 16px; pointer-events: none; }
```

The switch block MUST sit after `:21274`: `.m-more-row span { flex: 1 }` has the same specificity as `span.m-switch-track { flex: none }`, and the track keeps its 40px only because the later rule wins. And after the light-skin rules that follow the House Lights comment (`:21335-21337`):

```css
html[data-app="admin-os"][data-skin="light"] span.m-switch-track,
html[data-app="admin-os"][data-skin="light"] span.m-switch-thumb,
html[data-app="admin-os"][data-skin="light"] .m-notif-skel-pill { border-radius: 0; }
html[data-app="admin-os"][data-skin="light"] [aria-checked="true"] > span.m-switch-track > span.m-switch-thumb { background: var(--bg-0); }
```

`@keyframes m-pulse` already exists (`:21543`, after the insertion point, which is fine for a keyframe). In the sheets' reduced-motion block (`:22053-22058`, `@media (prefers-reduced-motion: reduce)`) add `.m-switch-thumb, .m-notif-skel-bar, .m-notif-skel-pill { animation: none; }`. `--link` is defined nowhere in `index.css`, so the Retry colour is the literal above (the benchmark's link hue).

- [ ] **Step 6: Build, commit**

Run: `cd client && CI=true npx react-scripts build`. Expected: exit 0.

```bash
git add client/src/utils/notificationsView.js client/src/utils/notificationsView.test.js client/src/index.css
git commit -F - <<'MSG'
feat(push): the Notifications screen's view-model and the switch family CSS

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 8: The Notifications screen, its route, its header, and the More row

**Files:**
- Create: `client/src/pages/mobile/NotificationsPhone.js`
- Create: `client/src/pages/mobile/NotificationsPhone.test.js`
- Modify: `client/src/pages/mobile/MorePage.js` (a Notifications section between the NAV sections and `<MoreSecurityRow />`)
- Modify: `client/src/pages/mobile/MorePage.test.js`
- Modify: `client/src/utils/screenKey.js` (`routeScreenKey`, `TITLES`)
- Modify: `client/src/utils/screenKey.test.js`
- Modify: `client/src/components/AdminLayout.js:257` (`DETAIL_BACK` gains `notifications: '/more'`)
- Modify: `client/src/App.js:611` (one route under the admin shell)
- Modify: `client/src/utils/mobileClassContract.test.js:8-14` (add `pages/mobile/NotificationsPhone.js` and `pages/mobile/MorePage.js`)

**Interfaces:**
- Consumes: `offlineGet`, `api.patch`, `api.post`; `readDevicePushState`, `enableAdminPush`, `disableAdminPush` (Task 6); everything in `notificationsView.js` (Task 7); `useMobileView`, `useToast`, `formatStaleTime`.
- Produces: route `/more/notifications` (phone only; at desktop width it renders `<Navigate to="/settings" replace />`); screen key `notifications` with title "Notifications"; the More row.

- [ ] **Step 1: The failing tests**

`client/src/utils/screenKey.test.js`, append:

```js
test('/more/notifications is its own screen, titled Notifications; /more stays More', () => {
  expect(routeScreenKey('/more/notifications')).toBe('notifications');
  expect(screenTitle('notifications')).toBe('Notifications');
  expect(routeScreenKey('/more')).toBe('more');
});
```

(`screenTitle` is already imported there; check the file's imports.)

`client/src/pages/mobile/MorePage.test.js`, add the mock beside the others and two tests:

```js
let mockDeviceState = 'off';
jest.mock('../../utils/adminPush', () => ({ readDevicePushState: () => Promise.resolve(mockDeviceState) }));

test('More has a Notifications row that opens the screen and shows this phone\'s state', async () => {
  mockDeviceState = 'on';
  renderMore({});
  const row = await screen.findByText('Push notifications');
  expect(row.closest('a')).toHaveAttribute('href', '/more/notifications');
  expect(await screen.findByText('On')).toHaveClass('m-more-state');
});

test('a blocked phone reads Blocked on the More row', async () => {
  mockDeviceState = 'blocked';
  renderMore({});
  expect(await screen.findByText('Blocked')).toBeInTheDocument();
});
```

`client/src/pages/mobile/NotificationsPhone.test.js`:

```js
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import NotificationsPhone from './NotificationsPhone';
import api from '../../utils/api';
import { offlineGet } from '../../utils/offlineRead';
import * as adminPush from '../../utils/adminPush';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), patch: jest.fn(), post: jest.fn() } }));
jest.mock('../../utils/offlineRead', () => ({ offlineGet: jest.fn(), OFFLINE_OK_HEADER: 'X-Offline-Ok' }));
jest.mock('../../utils/adminPush', () => ({
  readDevicePushState: jest.fn(), enableAdminPush: jest.fn(), disableAdminPush: jest.fn(), ADMIN_SW_PATH: '/admin-sw.js',
}));
const mockView = { isPhone: true, desktopView: () => false, setDesktopView: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockView }));
jest.mock('../../context/ToastContext', () => ({ useToast: () => ({ success: () => {}, error: () => {}, info: () => {} }) }));

const PREFS = (over = {}) => ({
  data: {
    notification_preferences: {}, categories: [],
    admin_push_preferences: { booking_signed: true, booking_signed_paid: true, payment_landed: true, booking_last_minute: true, drink_plan_submitted: true, staffing_drop: true, staffing_cover_swap: true, ...over.prefs },
    push: { public_key: over.key === undefined ? 'KEY' : over.key, kinds: [] },
  },
  staleAt: over.staleAt || null,
});
const renderScreen = () => render(
  <MemoryRouter initialEntries={['/more/notifications']}>
    <Routes>
      <Route path="/more/notifications" element={<NotificationsPhone />} />
      <Route path="/settings" element={<div>desktop settings</div>} />
    </Routes>
  </MemoryRouter>
);
const sw = (name) => screen.getByRole('switch', { name });

beforeEach(() => {
  offlineGet.mockResolvedValue(PREFS());
  adminPush.readDevicePushState.mockResolvedValue('on');
  api.patch.mockResolvedValue({ data: {} });
  api.post.mockResolvedValue({ data: { subscriptions: 1, sent: 1, failed: 0, gone: 0, reason: null } });
});

test('loads the seven switches on, the phone switch on, from the preferences read', async () => {
  renderScreen();
  expect(await screen.findByText('Banners for what you pick below')).toBeInTheDocument();
  expect(offlineGet).toHaveBeenCalledWith('/me/notification-preferences');
  for (const name of ['Client signed', 'Signed and paid', 'Payment landed', 'Last-minute booking', 'Plan submitted', 'Shift drops', 'Cover and swaps']) {
    expect(sw(name)).toHaveAttribute('aria-checked', 'true');
  }
  expect(sw('Notifications on this phone')).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByText('Saved to your account, so every phone you turn on follows these.')).toBeInTheDocument();
  expect(screen.getByText('Managers see this same page for their own account.')).toBeInTheDocument();
});

test('a kind switch flips at once, saves, and flips back with Didn’t save when the save fails', async () => {
  let reject;
  api.patch.mockImplementation(() => new Promise((_, r) => { reject = r; }));
  renderScreen();
  await screen.findByText('Banners for what you pick below');
  fireEvent.click(sw('Shift drops'));
  expect(sw('Shift drops')).toHaveAttribute('aria-checked', 'false');
  expect(sw('Shift drops')).toHaveAttribute('aria-busy', 'true');
  expect(api.patch).toHaveBeenCalledWith('/me/notification-preferences', { admin_push_preferences: { staffing_drop: false } });
  await act(async () => { reject(new Error('offline')); });
  await waitFor(() => expect(sw('Shift drops')).toHaveAttribute('aria-checked', 'true'));
  expect(screen.getByText('Didn’t save')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(api.patch).toHaveBeenCalledTimes(2);
});

test('the phone switch asks Android, then subscribes; blocked shows the note and disables the test row', async () => {
  adminPush.readDevicePushState.mockResolvedValue('off');
  adminPush.enableAdminPush.mockResolvedValue({ ok: true, state: 'granted' });
  renderScreen();
  await screen.findByText('Android asks for permission when you turn this on');
  expect(screen.getByText('Phone is off')).toBeInTheDocument();
  fireEvent.click(sw('Notifications on this phone'));
  expect(sw('Notifications on this phone')).toHaveAttribute('aria-busy', 'true');
  expect(adminPush.enableAdminPush).toHaveBeenCalledWith('KEY');
  await screen.findByText('Banners for what you pick below');
  expect(sw('Notifications on this phone')).toHaveAttribute('aria-checked', 'true');

  adminPush.readDevicePushState.mockResolvedValue('blocked');
  renderScreen();
  const notes = await screen.findAllByText(/Android has blocked notifications for DrB OS/);
  expect(notes.length).toBeGreaterThan(0);
  const blocked = screen.getAllByRole('switch', { name: 'Notifications on this phone' }).pop();
  expect(blocked).toBeDisabled();
});

test('no server key: the switch is disabled with the server note; the row says Phone is off', async () => {
  offlineGet.mockResolvedValue(PREFS({ key: null }));
  adminPush.readDevicePushState.mockResolvedValue('off');
  renderScreen();
  expect(await screen.findByText('Push isn’t set up on the server yet.')).toBeInTheDocument();
  expect(sw('Notifications on this phone')).toBeDisabled();
  expect(screen.getByText('Not set up on the server yet')).toBeInTheDocument();
  expect(screen.getByText('Phone is off')).toBeInTheDocument();
});

test('the test row posts, reads Sent, and Didn’t send with Retry when nothing was sent', async () => {
  renderScreen();
  await screen.findByText('Banners for what you pick below');
  fireEvent.click(screen.getByRole('button', { name: /Send a test notification/ }));
  expect(api.post).toHaveBeenCalledWith('/me/push-test');
  expect(await screen.findByText('Sent')).toBeInTheDocument();
  api.post.mockResolvedValue({ data: { subscriptions: 1, sent: 0, failed: 1, gone: 0, reason: null } });
  fireEvent.click(screen.getByRole('button', { name: /Send a test notification/ }));
  expect(await screen.findByText('Didn’t send')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
});

test('a stored copy renders the offline banner with its time and disables everything', async () => {
  offlineGet.mockResolvedValue(PREFS({ staleAt: new Date().toISOString() }));
  renderScreen();
  // 'Offline' is also the test row's trailing state, so select the banner's title.
  expect(await screen.findByText('Offline', { selector: '.m-notif-banner-title' })).toBeInTheDocument();
  expect(screen.getByText(/You are looking at the last saved settings/)).toBeInTheDocument();
  // RTL trims the span's own text to 'as of'.
  expect(screen.getByText(/as of/)).toBeInTheDocument();
  for (const s of screen.getAllByRole('switch')) expect(s).toBeDisabled();
  expect(screen.getByText('Offline', { selector: '.m-more-state' })).toBeInTheDocument();
});

test('a failed read with no stored copy offers Retry; the skeleton shows while loading', async () => {
  let resolve;
  offlineGet.mockImplementation(() => new Promise((r) => { resolve = r; }));
  renderScreen();
  expect(document.querySelector('.m-notif-skel')).toBeInTheDocument();
  await act(async () => { resolve(Promise.reject(new Error('down'))); });
  expect(await screen.findByText(/Couldn’t load notification settings/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
});

test('a desktop-width visit, and a Desktop-view override, both land on Settings', async () => {
  mockView.isPhone = false;
  renderScreen();
  expect(await screen.findByText('desktop settings')).toBeInTheDocument();
  mockView.isPhone = true;
  mockView.desktopView = (k) => k === 'notifications';
  renderScreen();
  expect(await screen.findAllByText('desktop settings')).toHaveLength(2);
  expect(mockView.setDesktopView).toHaveBeenCalledWith('notifications', false);
  expect(mockView.setDesktopView).toHaveBeenCalledWith('settings', true);
  mockView.desktopView = () => false;
});
```

- [ ] **Step 2: Run, expect failures**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/screenKey.test.js src/pages/mobile/MorePage.test.js src/pages/mobile/NotificationsPhone.test.js`
Expected: FAIL (no screen key, no row, no module).

- [ ] **Step 3: screenKey, the header map, the route**

`client/src/utils/screenKey.js`, in `routeScreenKey` before the final `return segs[0];`:

```js
  if (segs[0] === 'more' && segs[1] === 'notifications') return 'notifications';
```

and in `TITLES`: `notifications: 'Notifications',`.

`client/src/components/AdminLayout.js:257`:

```js
    const DETAIL_BACK = { 'event-detail': '/events', 'proposal-detail': '/proposals', 'inbox-item': '/inbox', notifications: '/more' };
```

(The back header then renders with a plain title; `headerDetail` is null for this key, so the header shows "Notifications" and the Desktop-view escape, as drawn.)

`client/src/App.js`: beside the `MorePage` lazy import (`:141`) add `const NotificationsPhone = lazy(() => import('./pages/mobile/NotificationsPhone'));`, and after the `/more` route (`:611`):

```jsx
        <Route path="/more/notifications" element={<NotificationsPhone />} />
```

- [ ] **Step 4: The screen**

`client/src/pages/mobile/NotificationsPhone.js`:

```jsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { offlineGet } from '../../utils/offlineRead';
import { formatStaleTime } from '../../utils/staleTime';
import { readDevicePushState, enableAdminPush, disableAdminPush } from '../../utils/adminPush';
import {
  KIND_GROUPS, kindOn, phoneState as derivePhoneState, phoneSub, testStatus, catsIntro,
  NOTE_BLOCKED, NOTE_SERVER_UNSET, FOOT_LINES, OFFLINE_BANNER,
} from '../../utils/notificationsView';
import { useMobileView } from '../../context/MobileViewContext';
import { useToast } from '../../context/ToastContext';
import Icon from '../../components/adminos/Icon';

// More > Notifications (spec 2026-08-13-mobile-admin section 7 and the
// 2026-10-14 design-session decisions). The phone switch is THIS device's real
// state (Android's permission, then the admin worker's subscription), read
// each time the screen opens; the seven kind switches are the account's and
// save at once. Offline, the last loaded settings render disabled under the
// banner with the staleness time. Phone only: desktop width, or the
// Desktop-view escape, lands on the desktop Settings page, where the
// category master switches live.

const KIND_PATH = '/me/notification-preferences';

function Track() {
  return <span className="m-switch-track"><span className="m-switch-thumb" /></span>;
}

function Skeleton() {
  const groups = [[64, 52], [46, 40, 52, 44], [38, 48]];
  return (
    <div className="m-notif-skel" aria-hidden="true">
      {groups.map((rows, g) => (
        <section key={g}>
          <div className="m-notif-skel-bar heading" style={{ width: [70, 84, 60][g] }} />
          <ul className="m-more-list">
            {rows.map((w, i) => (
              <li key={i}>
                <div style={{ flex: 1 }}><div className="m-notif-skel-bar" style={{ width: `${w}%` }} /></div>
                <div className="m-notif-skel-pill" />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default function NotificationsPhone() {
  const { isPhone, desktopView, setDesktopView } = useMobileView();
  const navigate = useNavigate();
  const toast = useToast();
  const [read, setRead] = useState({ status: 'loading', prefs: null, publicKey: null, staleAt: null });
  const [device, setDevice] = useState('off');
  const [prompting, setPrompting] = useState(false);
  const [busy, setBusy] = useState({});      // kind -> true while its PATCH is in flight
  const [failed, setFailed] = useState({});  // kind -> true after a failed PATCH
  const [test, setTest] = useState('idle');  // idle | sending | sent | failed
  const sentTimer = useRef(null);

  // The Desktop-view escape on this screen opens the desktop Settings page
  // (decision 3 of 2026-10-14): clear this screen's override so the next
  // visit renders the phone screen, and arm Settings' own.
  const escaped = desktopView('notifications');
  useEffect(() => {
    if (!escaped) return;
    setDesktopView('notifications', false);
    setDesktopView('settings', true);
    navigate('/settings', { replace: true });
  }, [escaped, setDesktopView, navigate]);

  const load = useCallback(async () => {
    setRead((r) => ({ ...r, status: 'loading' }));
    try {
      const res = await offlineGet(KIND_PATH);
      const d = res.data || {};
      setRead({ status: 'ready', prefs: d.admin_push_preferences || {}, publicKey: (d.push && d.push.public_key) || null, staleAt: res.staleAt || null });
    } catch (e) {
      setRead((r) => ({ ...r, status: 'failed' }));
    }
    try { setDevice(await readDevicePushState()); } catch (e) { setDevice('off'); }
  }, []);
  useEffect(() => { load(); return () => clearTimeout(sentTimer.current); }, [load]);

  if (!isPhone) return <Navigate to="/settings" replace />;
  if (escaped) return null;

  const offline = Boolean(read.staleAt);
  const state = derivePhoneState({ device, publicKey: read.publicKey });
  const phoneDisabled = offline || state === 'blocked' || state === 'server_unset' || state === 'unsupported' || prompting;
  const tStatus = testStatus({ offline, state, test });

  const onPhoneToggle = async () => {
    if (phoneDisabled) return;
    if (state === 'on') {
      setPrompting(true);
      await disableAdminPush();
      setPrompting(false);
      setDevice(await readDevicePushState());
      setTest('idle');
      return;
    }
    setPrompting(true);
    const r = await enableAdminPush(read.publicKey);
    setPrompting(false);
    if (r.ok) { setDevice('on'); return; }
    if (r.state === 'denied') { setDevice('blocked'); return; }
    setDevice(await readDevicePushState());
    toast.error(r.state === 'default' ? 'Android did not grant permission.' : 'Could not turn notifications on.');
  };

  const onTest = async () => {
    if (tStatus.disabled || test === 'sending') return;
    setTest('sending');
    try {
      const res = await api.post('/me/push-test');
      const ok = res && res.data && res.data.sent > 0;
      setTest(ok ? 'sent' : 'failed');
      if (ok) {
        clearTimeout(sentTimer.current);
        sentTimer.current = setTimeout(() => setTest('idle'), 2400);
      }
    } catch (e) {
      setTest('failed');
    }
  };

  const flip = async (kind) => {
    if (offline || busy[kind]) return;
    const next = !kindOn(read.prefs, kind);
    const before = read.prefs;
    setRead((r) => ({ ...r, prefs: { ...r.prefs, [kind]: next } }));
    setBusy((b) => ({ ...b, [kind]: true }));
    setFailed((f) => ({ ...f, [kind]: false }));
    try {
      await api.patch(KIND_PATH, { admin_push_preferences: { [kind]: next } });
    } catch (e) {
      setRead((r) => ({ ...r, prefs: before }));
      setFailed((f) => ({ ...f, [kind]: true }));
    } finally {
      setBusy((b) => ({ ...b, [kind]: false }));
    }
  };

  return (
    <div className="m-more" style={{ paddingTop: 12 }}>
      {offline && (
        <div className="m-notif-banner" role="status">
          <span className="m-stale-dot" aria-hidden="true" />
          <div>
            <div className="m-notif-banner-title">{OFFLINE_BANNER.title}</div>
            <div className="m-notif-banner-body">
              {OFFLINE_BANNER.body} <span className="m-stale">as of <span className="m-stale-time">{formatStaleTime(read.staleAt)}</span></span>
            </div>
          </div>
        </div>
      )}
      {read.status === 'loading' && <Skeleton />}
      {read.status === 'failed' && (
        <div className="m-notif-note" role="alert">
          <Icon name="alert" size={16} />
          <span style={{ flex: 1 }}>Couldn’t load notification settings.</span>
          <button type="button" className="m-notif-retry" onClick={load}>Retry</button>
        </div>
      )}
      {read.status === 'ready' && (
        <>
          <section>
            <h2 className="m-more-heading">This phone</h2>
            <ul className="m-more-list">
              <li>
                <button
                  type="button" className="m-more-row m-switch-row" role="switch"
                  aria-checked={state === 'on'} aria-busy={prompting || undefined} disabled={phoneDisabled && !prompting}
                  aria-label="Notifications on this phone" onClick={onPhoneToggle}
                >
                  <Icon name="bell" size={20} />
                  <span>
                    <span>Notifications on this phone</span>
                    <span className="m-more-sub">{phoneSub(state, prompting)}</span>
                  </span>
                  <Track />
                </button>
              </li>
              {state === 'blocked' && (
                <li className="m-notif-note"><Icon name="alert" size={16} /><span>{NOTE_BLOCKED}</span></li>
              )}
              {state === 'server_unset' && (
                <li className="m-notif-note"><Icon name="alert" size={16} /><span>{NOTE_SERVER_UNSET}</span></li>
              )}
              <li>
                {test === 'failed' && !tStatus.disabled ? (
                  <div className="m-more-row" style={{ cursor: 'default', paddingRight: 8 }}>
                    <Icon name="chat" size={20} />
                    <span>Send a test notification</span>
                    <span className="m-more-state danger">{tStatus.text}</span>
                    <button type="button" className="m-notif-retry" onClick={onTest}>Retry</button>
                  </div>
                ) : (
                  <button type="button" className="m-more-row" onClick={onTest} disabled={tStatus.disabled} style={tStatus.disabled ? { color: 'var(--ink-4)' } : undefined}>
                    <Icon name="chat" size={20} />
                    <span>Send a test notification</span>
                    <span className={`m-more-state${tStatus.tone ? ` ${tStatus.tone}` : ''}`}>{tStatus.text}</span>
                  </button>
                )}
              </li>
            </ul>
          </section>
          <section>
            <h2 className="m-more-heading">What buzzes</h2>
            <div className="m-notif-intro">{catsIntro(state)}</div>
            {KIND_GROUPS.map((g) => (
              <div className="m-notif-group" key={g.label}>
                <div className="m-notif-group-label">{g.label}</div>
                <div className="m-notif-group-help">{g.help}</div>
                <ul className="m-more-list">
                  {g.kinds.map(({ kind, label }) => (
                    <li key={kind} className={failed[kind] ? 'm-row-retry' : undefined}>
                      <button
                        type="button" className="m-more-row" role="switch"
                        aria-checked={kindOn(read.prefs, kind)} aria-busy={busy[kind] || undefined}
                        disabled={offline} aria-label={label} onClick={() => flip(kind)}
                      >
                        <span>{label}</span>
                        {failed[kind] && <span className="m-more-state danger">Didn’t save</span>}
                        <Track />
                      </button>
                      {/* Retry is a sibling of the switch, never inside it: interactive
                          content may not nest in a button (decision 9). */}
                      {failed[kind] && <button type="button" className="m-notif-retry" onClick={() => flip(kind)}>Retry</button>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
          <div className="m-notif-foot">
            {FOOT_LINES.map((line) => <div key={line}>{line}</div>)}
          </div>
        </>
      )}
    </div>
  );
}
```

Notes for the implementer: the file uses the typographic apostrophe in "Couldn’t" and "Didn’t" (as the benchmark draws). If a test's `getByRole('button', { name: 'Retry' })` finds two (a kind row's and the test row's), scope the assertion with `within(sw('Shift drops').closest('li'))`.

- [ ] **Step 5: The More row**

In `client/src/pages/mobile/MorePage.js`, import `{ readDevicePushState } from '../../utils/adminPush'` and `{ rowState } from '../../utils/notificationsView'`, and add before `<MoreSecurityRow />`:

```jsx
      <NotificationsRow />
```

with, beside `InstallRow`:

```jsx
// More > Notifications (spec section 7, 2026-10-14). The trailing state is
// this phone's: Android's permission, then the admin worker's subscription.
// No server read here; the screen adds the server's key to the picture.
function NotificationsRow() {
  const [device, setDevice] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    readDevicePushState().then((d) => { if (alive) setDevice(d); }).catch(() => { if (alive) setDevice('off'); });
    return () => { alive = false; };
  }, []);
  if (device === 'unsupported') return null;
  const st = device ? rowState(device) : null;
  return (
    <section>
      <h2 className="m-more-heading">Notifications</h2>
      <ul className="m-more-list">
        <li>
          <Link className="m-more-row" to="/more/notifications">
            <Icon name="bell" size={20} />
            <span>Push notifications</span>
            {st && <span className={`m-more-state ${st.tone}`}>{st.text}</span>}
            <Icon name="right" size={16} />
          </Link>
        </li>
      </ul>
    </section>
  );
}
```

Add `'pages/mobile/NotificationsPhone.js'` and `'pages/mobile/MorePage.js'` to the file list in `client/src/utils/mobileClassContract.test.js:8-14`.

- [ ] **Step 6: Run the touched suites and the gate**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/screenKey.test.js src/pages/mobile src/utils/mobileClassContract.test.js src/components/AdminLayout` then `CI=true npx react-scripts build`.
Expected: all pass (NotificationsPhone 8, MorePage's old tests plus 2); build exit 0.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/mobile/NotificationsPhone.js client/src/pages/mobile/NotificationsPhone.test.js client/src/pages/mobile/MorePage.js client/src/pages/mobile/MorePage.test.js client/src/utils/screenKey.js client/src/utils/screenKey.test.js client/src/components/AdminLayout.js client/src/App.js client/src/utils/mobileClassContract.test.js
git commit -F - <<'MSG'
feat(push): More > Notifications, the phone switch, the test row and the seven kind switches

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 9: The service worker: one more allowlisted read, and a banner tap navigates an open window

**Files:**
- Modify: `client/public/admin-sw.js` (`SW_VERSION` `:33`, `API_EXACT` `:185-196`, `notificationclick` `:376-420`)
- Modify: `client/src/utils/adminSwAllowlist.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /api/me/notification-preferences` is stored and stale-served under the opt-in header; a banner tap with no window on the exact path focuses any open admin window and navigates it to the target, and opens a window only when none is open. `SW_VERSION = 'admin-sw-2026-10-14-v11'`.

- [ ] **Step 1: The failing tests**

In `client/src/utils/adminSwAllowlist.test.js`, add `'/api/me/notification-preferences'` to the `test.each` list of paths that are cached, change the version regex at `:95` to `/^admin-sw-\d{4}-\d{2}-\d{2}-v11$/` (the `not.toBe` of the v8 name at `:94` stays), and append:

```js
describe('notificationclick', () => {
  function run(windows, data, { openWindow = true } = {}) {
    const { onNotificationClick, clients } = loadServiceWorkerWithClients(windows, openWindow);
    const calls = [];
    const event = {
      notification: { close: () => calls.push(['close']), data },
      waitUntil: (p) => { calls.push(['waitUntil']); event.done = p; },
    };
    onNotificationClick(event);
    // `clients` is the loader's object: its `opened` array records openWindow.
    return { calls, done: event.done, clients };
  }
  const client = (url) => {
    const c = { url, focused: false, navigatedTo: null };
    c.focus = async () => { c.focused = true; return c; };
    c.navigate = async (u) => { c.navigatedTo = u; return c; };
    return c;
  };

  test('focuses the window already on the exact path', async () => {
    const a = client('https://admin.example.test/events/10');
    const b = client('https://admin.example.test/events/1');
    const r = run([a, b], { url: '/events/1' });
    await r.done;
    expect(b.focused).toBe(true);
    expect(a.focused).toBe(false);
    expect(b.navigatedTo).toBeNull();
  });

  test('with no window on the path, focuses an open admin window and navigates it there', async () => {
    const a = client('https://admin.example.test/events');
    const r = run([a], { url: '/events/7' });
    await r.done;
    expect(a.focused).toBe(true);
    expect(a.navigatedTo).toBe('/events/7');
    expect(r.clients.opened).toEqual([]);
  });

  test('with no window at all, opens one at the target', async () => {
    const r = run([], { url: '/more/notifications' });
    await r.done;
    expect(r.clients.opened).toEqual(['/more/notifications']);
  });

  test('a payload url off the admin origin navigates nothing and opens the root', async () => {
    const a = client('https://admin.example.test/events');
    const r = run([a], { url: 'https://evil.example.test/phish' });
    await r.done;
    expect(a.navigatedTo).toBeNull();
    expect(r.clients.opened).toEqual(['/']);
  });
});
```

and extend the loader so a test can hand it clients:

```js
function loadServiceWorkerWithClients(windows, openWindow = true) {
  const src = fs.readFileSync(path.resolve(__dirname, '../../public/admin-sw.js'), 'utf8');
  const listeners = {};
  const clients = { opened: [], matchAll: async () => windows };
  if (openWindow) clients.openWindow = async (u) => { clients.opened.push(u); return null; };
  const self = { addEventListener: (type, fn) => { listeners[type] = fn; }, location: { origin: 'https://admin.example.test' }, clients, registration: { showNotification: async () => {} } };
  const context = vm.createContext({ self, caches: {}, fetch: () => Promise.reject(new Error('no network in test')), URL, Response: function Response() {}, Headers: function Headers() {}, console });
  vm.runInContext(src, context);
  return { onNotificationClick: listeners.notificationclick, clients };
}
```

(Match the `vm.createContext` globals the existing `loadServiceWorker` passes; copy its list and add `console` if it is missing. The loader returns its `clients` object so `run` can read `opened`.)

- [ ] **Step 2: Run, expect the three click tests and the version test to fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/adminSwAllowlist.test.js`

- [ ] **Step 3: The worker**

`SW_VERSION`: `'admin-sw-2026-10-14-v11'`.

`API_EXACT`: add, after `'/api/admin/active-staff',`:

```js
  // More > Notifications (spec section 7, 2026-10-14): the kind switches and
  // the server's VAPID public key. The screen renders a stored copy disabled
  // under an offline banner with the staleness time, and acts on nothing.
  '/api/me/notification-preferences',
```

`notificationclick`: the `targetPath` block (`:390-395`) becomes a same-origin resolution, so a payload can never steer the app off the admin host:

```js
      // Same-origin paths only (2026-10-14): the payload's url is resolved
      // against this worker's origin, and anything else collapses to '/'.
      let target = '/';
      let targetPath = '/';
      try {
        const u = new URL(targetUrl, self.location.origin);
        if (u.origin === self.location.origin) {
          target = u.pathname + u.search + u.hash;
          targetPath = u.pathname;
        }
      } catch (e) {
        // unparseable: stays '/'
      }
```

and `openWindow(targetUrl)` at the end becomes `openWindow(target)`. After the exact-path loop and before `openWindow`, add:

```js
      // No window on that path. An open admin window is navigated there
      // rather than a second one opened (2026-10-14): on the installed app a
      // second window is a second copy of the app behind the first.
      if (!isRootDefault) {
        for (const client of allClients) {
          if (!('focus' in client)) continue;
          try {
            await client.focus();
            if ('navigate' in client) return client.navigate(target);
            return null;
          } catch (e) {
            // A client that cannot be focused or navigated (gone, or not
            // controlled): fall through to the next, then to openWindow.
          }
        }
      }
```

Update the header comment's job 2 to read `notificationclick -> focus the window on the deep link, else navigate an open window to it, else open one.`

- [ ] **Step 4: Run, expect all passing; build**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/adminSwAllowlist.test.js` then `CI=true npx react-scripts build`. Expected: all pass; exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/public/admin-sw.js client/src/utils/adminSwAllowlist.test.js
git commit -F - <<'MSG'
feat(push): admin-sw v11 caches the preferences read; a banner tap navigates an open window

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 10: Browser gate (orchestrator)

**Files:** none committed. The script and screenshots live in the session scratchpad and `~/.playwright-mcp/ma-c-gate/`; the results go into "Browser checks" at the end of this plan, on main.

- [ ] **Step 1: Servers and sign-in**

Confirm `git -C <lane> diff main -- server/db/schema.sql` shows only the new column (Task 1 applied it to the dev DB). Start the lane API with dev VAPID keys that live only in this shell's environment, never in a file:

```bash
KEYS=$(cd <lane> && node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log(k.publicKey+' '+k.privateKey)")
set -- $KEYS
(cd <lane> && VAPID_PUBLIC_KEY=$1 VAPID_PRIVATE_KEY=$2 PORT=5100 NODE_ENV=development node server/index.js > /tmp/claude-1000/.../lane-api.log 2>&1 &)
(cd <lane>/client && PORT=3001 REACT_APP_API_URL=http://localhost:5100 BROWSER=none npx react-scripts start > .../lane-client.log 2>&1 &)
```

For the server-unset check (N5) a second API without the keys runs on 5101, and the client is pointed at it for that check only (`REACT_APP_API_URL` is read at build time: start a second client on 3002 for it, or run N5 first against an API started without keys and then restart it with keys).

Sign in with `node /home/drbartender/projects/os/scripts/dev-signin.js --as admin` (plants the token on ports 3000 and 3001; the init script path it prints goes to `context.addInitScript`). Playwright: `chromium.launch({ executablePath: <chrome> })`, `newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })`, and `context.grantPermissions(['notifications'], { origin: 'http://localhost:3001' })` for the enable checks; for the blocked check `addInitScript` overrides `Object.defineProperty(Notification, 'permission', { get: () => 'denied' })` and `requestPermission` to resolve `'denied'`.

Fixture: none beyond the admin account. Reset between checks with `UPDATE users SET admin_push_preferences = '{}'::jsonb, staff_notification_preferences = jsonb_set(staff_notification_preferences, '{push_subscriptions}', '[]'::jsonb, true) WHERE id = 1` (dotenv node one-liner), and `context.clearPermissions()`.

- [ ] **Step 2: The checks**

Each at 390x844 in After Hours and House Lights unless it says otherwise; 360x740 and 320x568 for N2.

- N1 The More row: with permission `prompt` and no subscription the row reads Off; it opens `/more/notifications` with the back-arrow header titled Notifications and the escape icon at the right; Back returns to `/more`; Android Back (`page.goBack()`) from the screen returns to `/more`, never out of the app.
- N2 The screen beside the benchmark, loaded: the seven switches on, the headings, the intro, the group labels and help, the two closing lines, at 390, 360 and 320 in both skins; no sideways scroll; every row at least 44px; the phone switch row 56px. Screenshot each beside the rendered benchmark (`notifPhone: on`).
- N3 Flip Shift drops off: `aria-busy` while the PATCH is in flight (throttle the network with `page.route` delaying the PATCH 800ms), then off; reload: still off; the DB row reads `{"staffing_drop": false}`. Flip it back on. Then with the API stopped, flip Payment landed: it flips back and the row reads "Didn't send"'s sibling, "Didn't save", with Retry; start the API, Retry saves.
- N4 Enable: permission granted, tap the phone switch: the sub-line reads the prompting copy with the thumb mid-track while `enableAdminPush` runs; then on, and the DB row holds one subscription whose endpoint is a real push-service URL (Chromium's). If `pushManager.subscribe` rejects in this headless build (no push service reachable), record the exact error and mark N4 PARTIAL: the Pixel walk is then the proof of enabling.
- N5 Server unset: against the API without keys, the switch is disabled, the note reads "Push isn't set up on the server yet.", the sub-line "Not set up on the server yet", the test row "Phone is off".
- N6 Blocked: with permission overridden to denied, the switch is off and disabled, the note reads the Android copy, the test row reads "Phone is off"; the More row reads Blocked in the warn ink.
- N7 Test row: with N4's subscription live, tap it: "Sending" then "Sent" for about two seconds; the API log shows `POST /api/me/push-test` 200 with `sent: 1`. Stop the API: tap again: "Didn't send" and Retry; the row is no longer the button (click the label: nothing posts).
- N8 Offline: load the screen once online, then `context.setOffline(true)` and reload: the banner with "as of <time>", every switch disabled at 0.4 opacity, the test row "Offline"; the More row still renders. Back online, reload: live again, no banner.
- N9 Desktop escape: tap the escape icon: the desktop chrome renders `/settings` with the "Phone view" return pill; tap the pill: the phone chrome is back; open `/more/notifications` again: the phone screen renders (the override was cleared).
- N10 The lock holds the route: arm the lock (set `drb-admin-passkey-enrolled` or the key `mobileLock.js` uses, and backdate the last-active key past 30 minutes), navigate to `/events/<an id>` as a banner tap would: the lock screen shows and the URL stays `/events/<id>`; dismiss the lock the way the C-series checks of lane ma-d did (a CDP virtual authenticator, or clear the arm and reload); the event detail is on screen. Record the method used.
- N11 Logout: with N4's subscription live, log out from More (or Settings): the DB row's `push_subscriptions` is `[]` within a second (the DELETE won the race) or the browser's `pushManager.getSubscription()` on `/admin-sw.js` is null (the local unsubscribe), and in prod terms either is enough for no banner to land. Record which.
- N12 A real banner, best effort: with N4's subscription live and the API holding the keys, `POST /api/me/push-test` and watch the worker: `page.evaluate` cannot see an OS notification, so instead wrap `registration.showNotification` through a `page.addInitScript` that posts to `console.log` when the worker's push event fires (the worker is a separate context; if that cannot be hooked, record N12 as "proved on the Pixel only").

- [ ] **Step 3: Record**

Write the table into "Browser checks" at the end of this plan, on main. A FAIL goes back to the task that owns it; its check runs again before that task's review closes.

### Task 11: Docs, the sensitive list, the capture manifest, the walk owed, the spec's two sentences (orchestrator, on main and in the lane)

**Files:**
- Modify (lane): `README.md`, `ARCHITECTURE.md`, `.claude/CLAUDE.md`, `scripts/sensitive-paths.txt`, `scripts/mobile-capture.manifest.json`
- Modify (main): `docs/superpowers/specs/2026-08-13-mobile-admin-design.md`, `docs/walkthroughs-owed.md`, `docs/fix-list-remaining-2026-07-02.md`, this plan

- [ ] **Step 1: README and ARCHITECTURE (lane)**

README folder tree: `server/utils/adminPush.js` ("the admin phone's push channel: the seven kinds, the banner copy, sendPushToUser (send to a user's subscriptions, prune the dead), deleteAllSubscriptions"), `server/routes/mePush.js` ("POST /api/me/push-test"), `client/src/utils/adminPush.js` ("this phone's push state over pushSubscribe.js: readDevicePushState, enableAdminPush, disableAdminPush; the admin worker's path"), `client/src/utils/notificationsView.js` ("the Notifications screen's copy and state rules, pure"), and `NotificationsPhone` in the `pages/mobile/` line (`:697`: "NotificationsPhone (More > Notifications at /more/notifications: the phone switch, the test row, the seven kind switches, offline and blocked states)"). Under the offline paragraph (`:793`) add that `/api/me/notification-preferences` is cached for the Notifications screen. Under Key features, one line: admin push per kind, with the Render keys as the prerequisite.

ARCHITECTURE: the `/api/me` route table (`:807-808`) gains the `push` block and `admin_push_preferences` on GET and PATCH, and a row `| POST | /push-test | Admin/Manager | One test banner to the caller's subscriptions; answers the counts. (server/routes/mePush.js) |`. The schema section: `users.admin_push_preferences JSONB NOT NULL DEFAULT '{}'` (kind switches, absent = on). The Web Push section (`:2119`): the admin channel paragraph (kinds, the three gates, fire-and-forget, the revoke purge, the click handler's navigate).

- [ ] **Step 2: CLAUDE.md env table (lane)**

`VAPID_PUBLIC_KEY`: append "Since 2026-10-14 the admin phone reads it from `GET /api/me/notification-preferences` (`push.public_key`, served only when the private key is also set), so the admin push needs nothing in Vercel." `REACT_APP_VAPID_PUBLIC_KEY`: append "Staff portal only; the admin phone never reads it."

- [ ] **Step 3: The sensitive list and the capture manifest (lane)**

`scripts/sensitive-paths.txt`, beside `client/public/admin-sw.js` (`:440`), with a comment line each: `server/utils/adminPush.js` (the dispatch allowlist is the blast-radius guard; its copy reaches a locked screen), `server/utils/adminNotifications.js` (the three gates), `server/routes/mePush.js` (sends to devices on request), `client/src/utils/adminPush.js` (subscribes and unsubscribes a device). Run `node scripts/sensitive-match.js <each path>` (or however the matcher is invoked; see its header) to confirm each matches.

`scripts/mobile-capture.manifest.json`, after the `admin-event-detail` entry (it spans `:75-77`; insert after `:77`):

```json
    { "name": "admin-notifications", "host": "localhost", "path": "/more/notifications", "auth": "admin", "settleMs": 2600, "authAssert": ".m-shell" },
```

Commit in the lane:

```bash
git add README.md ARCHITECTURE.md .claude/CLAUDE.md scripts/sensitive-paths.txt scripts/mobile-capture.manifest.json
git commit -F - <<'MSG'
docs(push): README, ARCHITECTURE, the env table, the sensitive list, the capture manifest

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

- [ ] **Step 4: The spec's sentences (main): DONE at the plan-fleet fold on 2026-10-14, see the fold record at the end; nothing left for lane time unless Dallas vetoes decision 6, in which case both sentences revert and the click change moves to the fix list.**

What was written. In section 7 Push: replace "`client/public/admin-sw.js` already displays pushes and handles clicks (lane ma-b); this lane changes it only for the allowlist entry." with "`client/public/admin-sw.js` already displays pushes and handles clicks (lane ma-b); this lane adds the allowlist entry and one behaviour to the click handler: with no window on the exact path it focuses an open admin window and navigates it there, and opens a new window only when none is open; it navigates and opens same-origin paths only (plan decision 6, 2026-10-14)." In the Subscriptions bullet, after "Logout unsubscribes this device the same way, as part of section 7's purge, so a signed-out phone never buzzes." add "(The browser-side unsubscribe is immediate; the server's copy is deleted when the DELETE wins the race with the token removal, and otherwise dies on the next send's 410.)" No em dashes. In the section 3 plan-decisions sentence (the one that starts "Plan decisions, stated here so the contract is whole"), append items (6) to (10): the failed-load state with Retry; the two enable-failure toasts; the `unsupported` state hiding the More row; the server-unset sub-line "Not set up on the server yet"; the back arrow's "Back" label kept from the chrome; and that "Sending" keeps the row's ink. Commit on main: `spec(mobile-admin): the click handler navigates; logout's unsubscribe race; six more plan decisions`.

- [ ] **Step 5: Walkthroughs owed and the fix list (main)**

`docs/walkthroughs-owed.md`, Tier 6 (moves to Tier 3b with the push): "**Admin push (lane ma-c-push).** Before the push: Dallas generates the VAPID pair (`npx web-push generate-vapid-keys`) and sets `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in Render (nothing in Vercel). On the Pixel after the deploy: More shows the Notifications row reading Off; the screen's switch asks Android and turns on; Send a test notification lands a banner within seconds and the row reads Sent; tapping the banner opens the Notifications screen (through the lock if it is up); turn Shift drops off and back on; a real event (the next client signature or payment) lands a banner that opens the event; log out and confirm no banner lands on a test send from desktop. Zul repeats the enable on his phone when he wants it."

Fix list, Admin UI, a "Push follow-ups (lane ma-c-push)" block: (1) replacing the 312's texts with push for a category needs a per-call-site SMS switch (SMS is decided per caller today), a later decision once push has proven itself; (2) Inbox pings stay out (the Inbox spec's "no pings"); (3) the `.m-switch` block is upstreamed to the design-system project `72035042` at lane close if Dallas approves the DesignSync write, else it stays owed here; (4) `staff-sw.js` still focuses by substring (the 8/14 finding) and does not navigate an open window; the admin worker's two fixes are its pattern; (5) `server/routes/staffShiftActions.js` ends this lane at about 963 lines, under 40 from the 1000 ratchet, so the next lane that touches it splits it first (the per-concern composition router pattern of `server/routes/proposals/`).

- [ ] **Step 6: The plan's as-built record (main)**

When the lane closes, append "Lane ma-c-push close record" with the as-built deltas and the browser checks table, as the previous lanes did.

### Task 12: Lane close (orchestrator)

- Run `npm run lane:status`; the lane must not be stale.
- The lane fleet on the whole branch against main's HEAD: `code-review`, `consistency-check`, `security-review`, `database-review`, `ui-ux-review` (pointed at the 2026-10-14 benchmark's Notifications screen and the More row, both skins, 390, 360 and 320, with Task 10's screenshots), and `/second-opinion`. Every file in `git diff --name-only main` gets a real verdict (the manifest rule); a non-completing agent is never a pass. Fix rounds re-run the affected reviewers.
- Suites the change reaches, green on the merged main: the server files named in Tasks 1 to 5 one at a time, and the client suites of Tasks 6 to 9 plus the AuthContext and AdminLayout suites; `CI=true npx react-scripts build` exit 0.
- Merge by squash through `scripts/merge-lane.sh` (the message names the lane and this plan); record the squash sha here and on the build board through `scripts/board-write.sh`; remove the worktree and the branch after the three checks.
- Offer Dallas the DesignSync write of the `.m-switch` block to project `72035042`'s `components-mobile.css` (`finalize_plan` names the one path; he sees the permission prompt). If he declines or is away, the fix-list line stands.
- Tell Dallas what the push needs from his hand: the two VAPID keys in Render. The screen ships honest without them.

## Self-Review (2026-10-14)

1. **Spec coverage.** Section 7 Push: the kinds and the one integration point (Tasks 1, 2); the kind-to-call-site map, every row (Task 4); the named exclusions (nothing passes a block for them; Task 2 drops an unknown kind); the three gates (Task 2); per-account switches and the per-device switch (Tasks 3, 6, 8); the key served by the API (Tasks 1, 3); the subscription store reused, `pushSubscribe` generalized, the real device state, logout and the revoke (Tasks 5, 6); the test send (Task 3); the banner copy rule and the tag (Task 1); deep links by kind (Task 1's `pushCopy`) and the lock holding the route (Task 9's click test, gate N10); the screen's route, header, escape target, offline caching and the four phone states (Tasks 7, 8, 9); the worker's one entry plus the navigate (Task 9, decision 6, spec amended in Task 11). Section 3's 2026-10-14 decisions: the More row, the header, the switch row and its sub-lines, the blocked note, the test row's states, the intro, the groups, the closing lines, the offline banner, the skeleton, the switch's CSS, the plan decisions 1 to 5 (Tasks 7, 8). Section 2's endpoint rule (the test route named). Render keys and the Pixel walk (Tasks 11, 12).
2. **Placeholder scan.** None. The fleet fold removed the two "confirm before writing" hedges (the shift contexts' `proposal_id`, which is plumbed by decision 14, and the error handler, which is inline).
3. **Type consistency.** `sendPushToUser` returns `{ subscriptions, sent, failed, gone }` in Tasks 1, 2 (stub), 3 (route and test); `push` blocks are `{ kind, title, body, url, recordId }` from `pushCopy` (Task 1) into `notifyAdminCategory` (Task 2) and the call sites (Task 4); `readDevicePushState` returns `'unsupported'|'blocked'|'on'|'off'` (Task 6) which `phoneState` (Task 7) maps with the key to the screen's five states (Task 8); `rowState` takes the device state on More and the derived state on the screen; `GET` answers `admin_push_preferences` and `push.public_key` (Task 3) which `NotificationsPhone` reads as `d.admin_push_preferences` and `d.push.public_key` (Task 8).
4. **Review Focus.** 1 (lock holds the route): Task 9 and N10. 2 (category off on desktop): Task 2's third sub-test. 3 (permission revoked after subscribing): Task 6's state order test. 4 (two admins, one kind off): Task 2's first sub-test with adminA and adminB. 5 (a re-submit, a retried webhook): Task 1's `pushTag` test, every `pushCopy` builder setting `recordId`, and Task 4's recorder pins on the drop, cover, swap, CANT and drink-plan sites asserting the `kind:id` tag.

## Plan fleet fold (2026-10-14)

Three reviewers ran on `16daa37d` (fidelity PASS 0/4/4, decomposition PASS 0/7/7, feasibility FAIL 4/8/4; blockers were all test-step defects, every production step was found executable, and the feasibility reviewer proved the client suites in a scratch mirror). Everything was folded: the error-handler import that did not exist (Task 3), the CANT pin aimed at a suite without the recorder and outside the footprint (Task 4), the `clients` object the click-test loader dropped and two RTL matchers (Tasks 8, 9), the banner date (decision 10), the proposal id for texted drops and swaps (decision 14), the undeclared screen states (decision 13), the back label (12), the both-keys rule (11), Sending's ink (15), the same-origin guard on the worker's navigate (decision 6), the nine sensitive files, the serialized client tasks, the footprint gaps (`AuthContext.test.js`, the endInstant suite, `smsShiftCommands.js`, `staffShiftActions.test.js`, `submitPlannerV2.test.js`, this plan), the drink-plan emit as its own commit with its pin, the recorder pins on the staffing sites, the size growth stated, and the stale line numbers. Decision 6 (the worker navigates an open window) is the one item flagged for Dallas's veto before Task 9. The spec's sentences of Task 11 Step 4 were written at the fold.

## Lane ma-c-push build record (2026-10-14; merged `f6d0b1a6`)

- **Task 1** (`a4646065`, fix `6c54766a`): as planned, plus the review's one Important: `pool.connect()` moved inside the prune's try/finally and the prune call guarded, so `sendPushToUser` cannot throw (pinned by a test whose connect stub rejects only the promise form; pg-pool's `query` uses the callback form). As-built deltas: a read failure inside the routine at first left a dispatcher row `suppressed` (superseded at Checkpoint A: the routine returns `readFailed` and the dispatcher writes `failed` with the message); malformed stored subscriptions are skipped and dropped by any prune; `pushDispatch.js` does a separate existence read.
- **Task 2** (`948c0e05`, fix `e31af53b`): as planned, plus: the push leg starts BEFORE the email and SMS loop (a banner is not held behind Resend and Twilio); the tests assert the fixture users' presence or absence in the sent list, never totals, so a real subscribed admin on the shared dev DB cannot break them.
- **Checkpoint A** (security PASS 0/0/0/5 Low; database PASS 0/0/0/2 Low/5 Info): both passed; the Lows folded in one server fix (below): a read failure inside `sendPushToUser` returns `readFailed` so the dispatcher writes `failed` with the message; `pushSender.sendPush` gains the `SEND_NOTIFICATIONS` gate email and SMS have and a 10s send timeout (the file joins the footprint); `pushCopy` clamps the client name and event kind (public-form text reaches a locked screen); the push leg's catch also logs. Fix list: stored push endpoints are not scheme/host validated at `POST /push-subscriptions` (SSRF-shaped, Low, admin JWT needed), and `adminNotifications.test.js`'s fixed fixture emails.
- **Task 4** (`f052ca04` the sites, `43b91b06` the drink-plan emit, `0726b7d6`, `c7259753`): as planned, with rulings: the emergency drop (under 72h) pushes `staffing_drop` like the clean drop (the plan had named only the clean one); `pushAdminKind` tracks its own promise and `__flushPush` drains in a loop, so a fire-and-forget push-only emit is awaitable in tests; `track` uses `then(untrack, untrack)`; and the website quote submit in `public.js` does NOT push (a quote request is not a signature; the file ends the lane byte-identical to the base). Stripe banner amounts carry "$". The `smsInbound.nearestShift.endInstant.test.js` suite has a time-of-day fixture (fails before about 10:30 Chicago on HEAD too); its CANT pin was proven through a copy and the full suite is re-run at lane close in daytime.
- **Task 5** (`5e98b377`): as planned; one line on the revoke's transaction client.
- **Server polish after Checkpoint A** (`982ec643`, `89f2b104`): push-test answers `reason: 'read_failed'` from the flag, never the error text; the clip cuts by code point, pinned beside an emoji.
- **Task 6** (`a2008106`, fix `d11aec74`): as planned, plus two rulings the implementer's own probe forced: logout unsubscribes in the browser only (a DELETE after the token is gone can never carry it and 401s into a false session-expired toast); every entry point of `client/src/utils/adminPush.js` is a no-op off the admin host (`getRegistration` resolves by scope and would return the staff worker on the staff host). `enableAdminPush` can answer `state: 'failed'`.
- **Task 7** (`711075bd`, fix `ec031863`): as planned, plus: the reduced-motion rule names the busy thumb's full selector (the bare class loses the specificity contest); the Retry colour follows the accent in both skins (the brief's literal was a wrong premise and failed contrast in House Lights); explicit `.off` and `.muted` state rules.
- **Task 8** (`a1facf9d`, fix `df5baafc`): as planned, plus the implementer's self-review deltas (both reads settle before the first paint; a failed save reverts only its own kind; Off never shows the prompting copy; kind and test rows 44px; desktop width redirects before reading) and the review's: the `unsupported` sub-line "Not available in this browser"; a toast when Off fails ("Could not turn notifications off."); `aria-busy` during the Off write; switches described by their sub-line or "Didn't save"; Retries named "Retry loading", "Retry the test notification", "Retry saving <label>"; `MorePage.test.js` awaits the row. 276 lines.
- **Task 9** (`977410f3`): as planned, plus: `return await client.navigate(target)` (a rejected navigate on an uncontrolled window must fall through; the brief's un-awaited return skipped the catch), the fourth click test corrected to decision 6 (an off-origin url with a window open focuses it and opens nothing), a no-window case, and a fifth test with a rejecting navigate. 58 tests.
- **Task 11, lane side** (`b3a20e4f`): README, ARCHITECTURE, the env table (`SEND_NOTIFICATIONS` now gates push), `.env.example`, `notificationsEnabled.js`'s header, the sensitive list (four entries), the capture manifest, `pushSubscribe.js`'s header, `serviceExtensionNotify.js`'s stale citation, the staffPortal mount comment.

### Browser checks (Task 10, 2026-10-14, third run; lane API on 5100 with dev VAPID keys in env and `SEND_NOTIFICATIONS=true`, lane client on 3001, headless Chrome `/opt/google/chrome/chrome`, 390x844 unless noted, both skins where it says so; screenshots in `~/.playwright-mcp/ma-c-gate/`)

| Check | Result | What was seen |
| --- | --- | --- |
| N1 More row, header, Back, Android Back | PASS | row state Off; title Notifications; the escape icon; Back and `goBack` both land on `/more` |
| N2 beside the benchmark, 390/360/320, After Hours and House Lights | PASS x6 | seven kind switches on, the phone switch off in a fresh profile, no sideways scroll, no control under 44px, the phone row 69px (its sub-line wraps at 390) |
| N3 flips | PASS | `aria-busy` while the PATCH is in flight; off survives a reload; the row reads `{"staffing_drop": false}`; a failed save flips back with "Didn't save" and "Retry saving Payment landed"; Retry saves (PATCH 200) |
| N4 enable | PASS | with permission granted the switch turns on; one subscription stored, endpoint host `fcm.googleapis.com` (a persistent Chrome profile: the default incognito context has no Push API) |
| N5 not set up on the server | PASS | switch disabled, the note, the sub-line, test row "Phone is off" (the worker blocked in that context so the response could be rewritten) |
| N6 blocked | PASS | More row Blocked in the warn ink; switch off and disabled; the Android note; test row "Phone is off" |
| N7 test row | PASS | "Sending" then "Sent"; `POST /api/me/push-test` answered `sent: 1` |
| N7b failed test send | PASS | "Didn't send" with "Retry the test notification"; a tap on the label posts nothing |
| N8 offline | PASS | with the API stopped (a true transport failure; Playwright's `setOffline` does not reach the worker's own fetch), an in-document open renders the stored copy: the banner with "as of", every switch disabled, test row Offline; worker v11 controlling |
| N9 Desktop escape | PASS | lands on `/settings` in the desktop chrome with the return pill; the pill returns; the phone screen renders again at `/more/notifications` |
| N10 the lock holds the route | PASS | an armed profile shows the lock AT `/events/9819`; an unarmed one renders the detail at the same URL (the URL is the route; no passkey ceremony was run) |
| N11 logout | PASS | the browser's subscription is gone after a revocation-coded logout; the server row stays until its next send's 410, by ruling |
| N12 a real banner | PASS | after N7 the worker's `getNotifications()` listed "Test notification": delivered end to end through FCM to headless Chrome. (The second run had FCM answer 410 to a send; it did not recur with fresh keys.) |

The `smsInbound.nearestShift.endInstant.test.js` suite has a time-of-day fixture (its CANT pin was proven through a copy at 05:00 Chicago); the full suite is run between 10:30 and 23:29 Chicago before the push.
- **Task 3** (`21cdeb9a`, fixes `b2a5c3c6`, `aa5e495d`): as planned, plus two Important review findings in the brief's verbatim blocks and one load-bearing re-review finding, all three folded into the plan text above: the harness's `after` deletes first and guarded; a non-object `admin_push_preferences` beside a category key is a 400; and the PATCH merges in SQL (`column || $patch`, only the validated delta per column) instead of read-modify-write, because two quick kind flips from the phone lost one update and a desktop category toggle erased a phone kind toggle (the concurrent test failed on every run against the old code). `mePush.test.js` has 6 tests as built.

## Lane ma-c-push close record (2026-10-14)

- **Final whole-branch review** (55810d5d..f13152ca, 55 files): five seats PASS (code-review, security, database, consistency, ui-ux), every file verdicted; second opinion: gemini NO FINDINGS, codex 2 confirmed (a shared subscription array across the admin phone and the staff portal; no rollback of the browser subscription when the server POST fails).
- **Fix wave** (`6039eb0c` server, `edd9e1a5` client; scoped re-review PASS on every item): subscriptions carry a `surface` (`'admin'` from the phone; absent = staff) and each channel sends to its own, with the prune and the revoke still acting on the whole array; the drink-plan fast-path emit is guarded; the Stripe banner date reads `event_timezone`; `SEND_NOTIFICATIONS='false'` pinned in two suites; `subscribePush` unsubscribes the fresh browser subscription when the POST fails and answers `failed`; `disableAdminPush` reports a Sentry warning (no endpoint) when the local unsubscribe fails; `purgePhoneSession` runs at all five AuthContext purge sites; `javascript:` and `data:` click payloads pinned to collapse to `/`; the design seat's four Should Fix (wrapper inset, focus rings, the pinned track under Retry, the offline banner's time) plus live regions, the failed-load strip inside the list, rem insets, and a two-line reserve on the phone row's sub-line.
- **Controller fixes**: `d6d09f19` the staff portal's NotificationsSection maps `failed` to the banner's `default` (PushPermissionBanner has no `failed` branch, so "Enable push" would have vanished); `c22c8472` serviceExtensionNotify skips admin-surface entries (the one staff sender outside the dispatcher) and two comments match the code.
- **Merge**: squash `f6d0b1a6` (58 files, +2891/-206) onto main `752adc55`; merge-tree dry run clean; client build on merged main exit 0; board line `f160e446` under Recently shipped. Worktree and branch removed after those three checks. NOT pushed.
- **Deferred to the fit lane** (fix list, "Push follow-ups"): status spans that mount with their text may not announce as live regions; the failed-load strip's chrome; px against rem insets inherited from the benchmark; House Lights `ink-3` contrast is a design-system token matter.
- **Owed**: the `smsInbound.nearestShift.endInstant.test.js` full run between 10:30 and 23:29 Chicago before the push (RAN 2026-10-14 16:38 Chicago on merged main: 7 tests, 7 pass, 0 fail); the two VAPID keys in Render (SET by Dallas 2026-10-14, before the push); the Pixel walk after the push (walkthroughs-owed, Tier 6 "Admin push").
- **Dev note**: an admin-phone subscription stored on the dev DB before `6039eb0c` carries no surface, so that phone reads on but receives no admin banners until its switch is cycled. Prod has no entries.
