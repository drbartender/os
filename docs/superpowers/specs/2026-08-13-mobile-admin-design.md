# Mobile Admin (Phase 1): Installable Phone-First Admin App

**Date:** 2026-08-13. Revised 2026-08-14: design-session decisions banked, then the full `/review-spec` fleet output folded in (10 blockers, 8 warnings closed as spec text).
**Status:** Approved (section-by-section 2026-08-12/14)
**Audience:** Dallas only (admin + managers share the routes; see the cache-keying rule in §7). Android Chrome on a Pixel is the design and test target. iOS remains relevant only to the staff portal, which this project does not touch.

## 1. Problem and North Star

The admin console is desktop-first. On a phone, its responsive CSS collapses dense multi-column layouts into very tall single columns: a correct rendering of the wrong information architecture. Dallas runs DRB from his phone whenever he is not at a desk, dislikes typing on the phone, and hates hitting "I simply can't do this from here."

**North star: no dead ends.** The common actions get a genuinely phone-first fast path. Everything else gets an escape hatch (Desktop view) that always exists, even when it is ugly.

**Not the fix:** more responsive CSS retrofits. `client/src/index.css` is ~20,200 lines with 108 ad-hoc media queries; that path stays "fine" forever and never becomes good.

**Chosen approach:** phone-first admin surfaces inside the existing React app, shipped as an installable PWA on the admin host. Native app rejected: the felt gap is phone-first IA versus desktop IA, not web versus native, and a second codebase forever is the wrong trade for a sole developer.

## 2. Scope and Phasing

- **Phase 1 (this spec):** app shell, Events list + detail, Proposals list + detail, global search, install/push/offline, biometric auth, resume-where-I-left-off.
- **Phase 2 (later spec):** staffing and payroll surfaces.
- **Phase 3 (later spec):** rest of Workspace: Messages, Clients, Hiring, Overview.

Explicitly out of phase 1: proposal creation from the phone (the New Proposal button routes to Desktop view), free-text price overrides, composing new custom line items, **cancel-line-item** (settled 2026-08-14: it is a preview→fingerprint→execute flow with a required free-text reason and an idempotency key that fires real Stripe refunds and a client email; it stays Desktop-view), any offline write queueing, any staff-portal changes.

**Endpoint rule (amended 2026-08-14):** no NEW API endpoints for phase-1 reads and edits, but **parameter, field, and projection extensions to existing endpoints are in scope** where this spec names them (§4 shifts feed, §5 proposals list, §7's `admin_push_preferences` field on the existing `me.js` preferences PATCH). The §8 auth endpoints are the deliberate exception: a new route file, mounted under the existing `/api/auth/` prefix (§8).

## 3. Architecture

Same repo, same React app, same admin host and URLs.

- **Fork point:** a new `useIsPhone` hook: one `matchMedia` check at a single breakpoint constant, **700px**, defined once. No new scattered breakpoints. (700px matches no existing CSS cluster, which is fine for the JS fork; note the Desktop-view escape hatch will render desktop components inside their existing 600/640px CSS band.)
- **Route-level fork:** each phase-1 route keeps its existing desktop component; at phone width the route renders a phone component instead. `/events/:id` stays one URL. Deep links from push, SMS, and the command palette keep working unchanged.
- **Phone components** live in `client/src/pages/mobile/` and share everything below the presentation layer: `utils/api.js`, hooks, `AuthContext`, `components/adminos/format.js`. URL-backed list state uses the existing `useUrlListState` hook; sheet state uses `useDrawerParam` **with push-history semantics on the phone** (the hook replaces the history entry by design today, which would make Android hardware Back leave the page instead of closing the sheet; the mobile variant pushes, so Back closes an open sheet, always).
- **Desktop-view escape hatch:** every mobile screen carries a toggle that forces the desktop component at phone width, persisted per-screen in `localStorage` (key `adminDesktopViewOverrides`, a JSON map of screen-key → true), cleared on logout along with the rest of the phone's local state (§7 purge rule).

### Visual contract

Per CLAUDE.md "Design artifacts are contracts":

- **Benchmark artifact:** `docs/design-artifacts/2026-08-14-mobile-admin-shell.dc.html`, the repo snapshot of `Phone Admin Shell.dc.html` from design project **8d8da3a4-97b1-4aa4-8999-0fec9f2a5f99** ("Dr. Bartender admin shell", Dallas's working session). If the session continues, the snapshot is refreshed and this line's date updates; the snapshot in the repo is always the build benchmark.
- **Token and component law:** the **Dr. Bartender OS Design System** project `72035042-c993-47e2-9dc8-c452b7bf5fa4`, whose mobile family (`components/mobile/*`, `components-mobile.css`, `guidelines/mobile-idiom.html`, authored 2026-08-13) carries the idiom. The mobile family is vendored beside the benchmark under `docs/design-artifacts/_ds/`, and it is the benchmark for the components the shell snapshot does not exercise (steppers, sheet title, card sub-elements). Token-translation rule: token NAMES are identical to `index.css` and mobile CSS consumes the product's `[data-app="admin-os"][data-skin]` custom properties directly, with new mobile rules landing in `index.css` under the `.m-*` namespace. Fidelity nuance, stated so reviewers don't trip on it: the design system's *neutral* values are extracted verbatim; its *semantic hue* values follow the rainbow palette and may differ numerically from a given `index.css` accent config, so fidelity review compares structure and token usage, never resolved hue values.
- **Component vocabulary:** `.m-shell` / `.m-header` / `.m-main` / `.m-tabbar` / `.m-tab(-icon/-badge/-label)` / `.m-card(-title/-meta/-chip)` / `.m-stale` / `.m-sheet(-scrim/-handle/-title/-row)` / `.m-stepper(-label/-ctl/-btn/-value)` / `.m-more(-heading/-list/-row)` / `.m-return-pill`, composing the existing `chip`/`chip-dot` and `Icon` primitives. The benchmark's accordion reuse of `.m-more-list`/`.m-sheet-row` inside detail screens gets promoted to proper `.m-section` classes at fit-back rather than shipped as class abuse.
- **Per-screen composition (from the benchmark):** shell = top bar (℞ mark, title, search, Desktop-view escape) + bottom tabs (Events / Proposals / More; needs-you badges, neutral aggregate on More) + active-tab top stripe. Events list = date-rail cards (DOW/day/month, TODAY in accent) with client · type, guests, time · venue meta, color-coded staffing fraction, pending-request chip, Bar/Supplies tags. Proposals list = same card family with pipeline chip and total. Detail screens = collapsible Contacts / Staffing / Financials sections under a back-arrow header. Assignment sheet = bottom sheet with roster context and candidate rows. Desktop escape = full desktop chrome plus the floating "℞ Phone view" return pill.
- **Where this spec overrides the benchmark:** no one-tap auto-assign; suggestions are unranked (§4); the Waitlist section wires to real waitlist semantics (§4); the filter apparatus of §4/§5 is added; role-selection rows are added to the sheet (§4); the benchmark's "Desktop escape" screen is a mockup placeholder, in the real app the desktop chrome itself renders.

## 4. Events

### List (`/events`, phone)

- Card list, not a table, **date-ordered**, card layout per the Visual contract. No balance on cards.
- Filter apparatus (settled 2026-08-14): an **Upcoming / Past** switch under the header (upcoming default, opens on today) and one tap-chip, **Needs staff**. Chips, not dropdowns; URL-backed via `useUrlListState`. Everything else stays desk work.
- **Needs-staff chip predicate = the badge predicate, verbatim** (settled 2026-08-14): the chip filters to events having a shift that matches the `unstaffed_events` SQL in `server/routes/admin/settings.js` (status `open`, `event_date >= CURRENT_DATE`, approved-and-not-dropped < `positions_needed`; pending requests deliberately NOT counted). One predicate, two units, stated so nobody "fixes" it: the badge counts **shifts**, the chip filters **event cards**, so an event with three unstaffed shifts is badge 3, chip 1 card. If pending-awareness is ever wanted it changes in both places at once. The chip is hidden on the Past tab (the predicate is upcoming-only by construction).
- **Feed grounding:** the list rides the admin branch of `GET /shifts`, which today returns one row **per shift**, `ORDER BY event_date ASC LIMIT 500` with no lower bound. Phase 1 extends it (parameter extension per §2): `scope=upcoming|past` (upcoming = `event_date >= CURRENT_DATE` ascending; past = descending) and server-side `limit`/`offset` with a bounded default. The pending-request chip needs **no** projection change: the admin branch already projects `rc.pending_count` (pending `shift_requests`), and the chip renders when it is > 0. (The benchmark's "requested cover" copy is cover semantics, a staff-branch concept; phase 1's chip means pending applications, and the copy says so.) The phone groups rows into one card per event by `proposal_id`; **manual shifts (`proposal_id IS NULL`) render as cards that open the shift's assignment sheet directly**, never a dead tap into a nonexistent event page.

### Detail (`/events/:id`, phone)

Keeps the existing four-block structure, stacked: **header, staffing, pricing, activity**, rendered per the Visual contract's collapsible-section composition.

- **Header:** client, date, time, venue, guests. Venue address opens Google Maps via the existing `AddressLink` markup; in standalone display mode the link must open externally (verify `target="_blank"` behavior inside the installed app). Client phone is tap-to-call / tap-to-text. Existing page actions (edit, send invite, re-enroll, cancel) become full-width tap targets.
- **Staffing:** keeps `ShiftDrawer` semantics as a bottom sheet. Tap a shift; assign / approve / remove are rows you tap.
- **Role selection (settled 2026-08-14, closes the position money seam):** `POST /shifts/:id/assign` 400s without a canonical `position`, and waitlist approval 400s whenever no ranked role is open, which is the definition of a waitlisted request. So the sheet's assign and approve actions carry a **role row step**: when more than one role is open (or none ranks), the sheet shows one tap-row per role (Bartender / Barback / Server, from `positionsNeeded`), and the chosen role is sent explicitly. Never defaulted, never a dropdown, never inferred: `shift_requests.position` keys payroll tip splits.
- **Candidate list:** plain **alphabetical** active-staff (same `GET /admin/active-staff` feed the desktop drawer uses). The word "ranked" is retired: no one-tap "Auto-assign top match", no seniority/distance/kit machinery in admin UI (settled 2026-08-14; that early-project data is de-emphasized). The Waitlist section wires to the real derivation: requests from `GET /shifts/detail/:id` classified exactly as `ShiftDrawer` does today via the CLIENT-side module it imports, `client/src/utils/staffingRoles.js` (`staffingClassification.js` is the server's CJS twin; do not import it in the client); 'approved' requires `dropped_at IS NULL`.
- **Structured edits:** date and time use native Android pickers; counts use steppers; statuses are chips. Event-side edits reuse the event editor's existing update path, which owns the cross-cutting rule (event detail change → linked shifts). Event note is a plain textarea that behaves with Android dictation.
- **Pricing:** read-heavy. Line items listed. Cancel-line is Desktop-view (§2). Anything deeper is a Desktop-view case in phase 1.
- **Activity:** plain feed, unchanged shape.

## 5. Proposals

### List (`/proposals`, phone)

Card list per the Visual contract, pipeline-stage chip on the card. Apparatus (settled 2026-08-14): a sort toggle **Event date / Newest lead** and one tap-chip, **Unviewed**. A Modified chip was considered and deliberately left out (card chips + tab badge already carry it; add later only if missed).

**Feed grounding:** `GET /api/proposals` is server-paginated (50/page) with a whitelisted sort map. "Event date" maps to the existing `event_date` key; "Newest lead" maps to `created_at DESC`, added to the whitelist (it is already the default order, the toggle makes it explicit). The map's comment says its keys mirror the desktop `SortableTh` keys exactly and `list.sort.test.js` asserts on the map; both get updated in the same change ("phone adds created_at"; desktop columns unchanged). **Unviewed** is a new server-side predicate param (`unviewed=1` → `last_viewed_at IS NULL AND status = 'sent'`; the column exists at `schema.sql:867`, and `modified` implies viewed). A client-side filter over a paginated page would return a wrong subset; the predicate must be server-side.

### Detail (`/proposals/:id`, phone)

- **Read view:** stacked blocks per the Visual contract. Tap-to-act carries over. Actions row: send, remind, archive as tap targets.
- **Edits:** structured edits only, with pickers and steppers: date, times, guest count, bar count, add-on quantities. All edits run through the existing `proposalEditor/` logic (`formState.js`, `patchBody.js`, `repriceSummary.js`), **with full hydration required** (settled 2026-08-14): the PATCH is a full replace, so a phone sheet editing one field must be hydrated by the same loader the desktop editor uses — `recoverAddonQuantities` against the add-on catalog, the detected `numBartendersOverride`, and carry-forward of `total_price_override`, `adjustments`, `syrup_selections`, `setup_minutes_before`. Module reuse without full hydration is the known add-on-quantity/free-bartender bug class and is forbidden.
- **No money-bearing edit sheet opens from a cache-served read** (settled 2026-08-14): opening any sheet that can change a price requires a fresh, non-cache fetch to succeed first. Offline, money edits are simply unavailable; the sheet says so.
- A reprice-triggering edit shows the same before/after confirmation as the desktop modal, as a bottom sheet.
- **Desktop-view cases in phase 1:** free-text price overrides, new custom line items, cancel-line, proposal creation.

## 6. Global Search

- Magnifier in the shell top bar on every tab, backed by the same `/admin/search` endpoint the ⌘K palette uses. Full-screen takeover, results grouped as the palette groups them, large tap rows.
- **Grounding:** the endpoint returns max 6 rows per group, empty under 2 characters AND over 100 characters, and is rate-limited 60/min per user. The phone search reuses the palette's debounce, renders an explicit no-results state (distinguishing "type more" from "nothing matched"), and each group with 6 results ends in a "More on desktop" row (Desktop-view escape) rather than pretending the list is complete.

## 7. Install, Push, Offline

### Install

- New `client/public/admin-manifest.json`: name "DrB OS", its own icon, `display: standalone`, `start_url: /events` (route restore then takes over, §9).
- Injected at runtime by a new sibling module of `installStaffPwaMeta.js`, **named exactly `client/src/utils/installAdminPwaMeta.js`** (the name is load-bearing: `scripts/sensitive-paths.txt` matches literal paths, and this file is listed there), gated by the same host mapping `getSiteContext()` uses for the admin surface: `admin.*` prefixes AND bare `localhost`/`127.0.0.1` (so dev installs work). The staff gate and staff files are untouched. Known dev-only caveat: on bare localhost the admin SW registers at scope `/` and can evict a locally-tested staff SW registration; prod hosts are separate origins and unaffected.
- Chrome's install banner plus an explicit "Install app" row in **More**.

### Push (rewritten 2026-08-14; the fleet found the reuse claim false)

Real server work, stated honestly:

- **One integration point:** `notifyAdminCategory` (`server/utils/adminNotifications.js`) is where every phase-1 trigger already flows. It gains a **push channel** beside email/SMS: direct, at-call-time dispatch to the admin user's stored subscriptions via the existing `pushSender`/VAPID plumbing. **Never** via `scheduled_messages` (5-minute scheduler latency defeats a lead alert). Push send is fire-and-forget after the caller's transaction commits and can never fail the calling money path.
- **Toggles are per-CATEGORY over the existing category model** (corrected 2026-08-14: the four phase-1 event names are not four categories; proposal-accepted and payment-received both arrive as `urgent_booking`, and `notifyAdminCategory` serves 13 categories from 20+ callers). The push channel fires ONLY for categories in a hardcoded dispatch-side allowlist: `urgent_booking`, `urgent_staffing`, `routine_thumbtack`, `routine_finance`. Everything else NEVER pushes, which is the blast-radius guard. More → Notifications shows one toggle per allowlisted category with honest labels ("Bookings & payments" covers the urgent_booking collision, acceptable for phase 1), stored in `users.admin_push_preferences JSONB NOT NULL DEFAULT '{}'` (idempotent DDL; absent key = enabled *within the allowlist only*).
- **Preference layering, stated:** the existing per-category master prefs (`users.notification_preferences`) gate the whole category BEFORE the recipient loop, exactly as they do for email/SMS today; the push toggle then subtracts within an enabled category. "Push on, email off" for a category is therefore unreachable in phase 1, deliberately; push is an additive channel, not an independent one.
- **Toggle writer:** the existing `me.js` preferences PATCH gains the `admin_push_preferences` field, validated against the allowlist (field extension per §2; no new endpoint).
- **Subscriptions:** reuse the existing `POST /api/me/push-subscriptions` storage (auth-only; subscriptions are per-device; they live in the `staff_notification_preferences.push_subscriptions` blob today and stay there, a naming wart phase 1 accepts rather than migrating). `client/src/utils/pushSubscribe.js` is generalized to take the SW path (`/staff-sw.js` is currently hardcoded in register/getRegistration/unsubscribe) so the admin surface registers `/admin-sw.js`.
- **Deep links:** `notificationclick` focuses/opens the target route. If the lock (§8) applies at tap time, the deep link is **held through unlock**, not dropped.
- New `client/public/admin-sw.js` handles push display + clicks (pattern from `staff-sw.js`) plus the offline duties below.

### Offline (law tightened 2026-08-14)

- `admin-sw.js` caches the app shell for instant open. Mechanics per the foundation plan: runtime cache-on-fetch (network-first navigations falling back to cached `index.html`; cache-first for content-hashed `/static/` assets), versioned cache names purged on activate. No workbox, no hand-written precache manifest (CRA's hashed names make one impossible to maintain; runtime caching sidesteps it, and a fresh navigation always fetches the current `index.html`, so `skipWaiting` cannot mix asset versions).
- **Reads:** network-first with cache fallback, under these rules:
  - Fallback fires **only on transport failure** (no response at all). A server-answered non-2xx — especially 401/403 after expiry or revocation — is NEVER answered from cache; a dead session renders no data.
  - **Allowlist:** the SW caches only the phone surfaces' GET paths (events/shifts feed, event detail, proposals list/detail, badge-counts, search). Desktop-view traffic through the escape hatch (payroll, users, paystubs) is never cached.
  - **Weak signal:** the fetch races a short timeout (~4s); on timeout with a cached copy present, serve the cache with the staleness line. No cached copy = normal loading state (the "never a spinner" promise applies only when a cached copy exists; a cold cache may spin).
  - Cached responses carry `x-sw-cached-at`; the client surfaces it as the "as of 2:14 PM" line (device-local time: it answers "how old is what I'm seeing"). Because the SW synthesizes the cached Response, this header is readable regardless of the cross-origin API host.
  - **Cache keying and purge:** the API cache name embeds the authenticated user id; on boot with a different user, old namespaces are purged (managers share these routes; one device must never show another user's cached data). Full purge on logout. Honest limit, stated as accepted risk: a *remote* credential revoke cannot reach a phone's CacheStorage; revoke kills access to fresh data and live sessions (§8), while the cached snapshot persists on-device until next app open + auth failure, behind the OS device lock. No remote-wipe theater.
- **Writes: never queued.** The SW fetch handler explicitly ignores non-GET requests (stated so a future edit cannot quietly add replay semantics). A failed save keeps the sheet open with input intact and says "no connection, didn't save."

## 8. Auth: Biometric Unlock (rewritten 2026-08-14 after the fleet review)

Max-effort area; 5-agent pre-prod fleet before merge. **Library:** `@simplewebauthn/server` + `@simplewebauthn/browser` (none exists in the repo today; new dependency, documented per the docs law).

- **Mechanism:** WebAuthn passkeys via the Android platform authenticator. First phone launch: password login once, then passkey registration.
- **The credential IS the device session** (the separately-stored "opaque device token" from the earlier draft is deleted from the design; it was an unexplained second bearer credential). Enrollment creates a `webauthn_credentials` row (user id, credential id, public key, signature counter, label, created/last-used; idempotent DDL in `schema.sql`, prod DDL run before push). Unlock = a WebAuthn assertion against that credential; the server verifies and mints a fresh JWT. Nothing else can mint the phone-lifetime token.
- **Endpoints:** a NEW route file `server/routes/webauthn.js` (`auth.js` is at ~482 lines and does not grow), **mounted under `/api/auth/webauthn/`** (corrected 2026-08-14): the client's 401 interceptor excludes URLs starting `/auth/` from the session-expired dispatch, so a failed assertion or consumed challenge must live under that prefix or the unlock attempt itself would fire `SessionExpiryHandler` and log the phone out. Routes: register-options, register-verify, assert-options, assert-verify, plus credential list + revoke. Register and the credential-management endpoints require an authenticated session; assert-verify is the unlock path.
- **Challenges:** server-issued, stored server-side (small DB table, single-use, ~5-minute TTL, deleted on use). Assertions without a live matching challenge are rejected; this is the replay control.
- **RP ID and origin:** pinned to `admin.drbartender.com` (env-overridable `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN`, localhost defaults in dev). One bundle serves four hosts; a bare-domain RP ID would let an admin passkey assert from the public/hiring/staff origins. It must not.
- **Signature counter:** stored; if the stored counter is > 0 and an assertion's counter is not greater, reject and Sentry-alert (cloned-credential signal). Android authenticators that always report 0 never trip this (0 stays 0).
- **Rate limiting:** a dedicated limiter for the webauthn endpoints, separate from `authLimiter`, so unlock retries neither ride nor exhaust the login lockout budget.
- **Session model:** the assert-verify endpoint is the ONLY minting site for the phone-lifetime token: a **12-hour** JWT carrying the credential id claim (informational: it feeds audit lines and Sentry context; `middleware/auth.js` does NOT look credentials up per-request). Password login keeps minting 7d everywhere it does today (all three sites), including on the phone as the fallback path; that is exactly today's risk posture, no regression, and the server never needs to trust a client-declared "I am a phone" flag: the token's minting site is the discriminator.
- **Lock behavior:** app backgrounded > 30 minutes, or JWT expired → full-screen lock that fully occludes content (no cached data visible behind it). One biometric tap asserts and re-enters. **In-scope client changes the fleet caught:** `SessionExpiryHandler` currently force-logs-out and navigates to `/login` on the first 401 and its once-only guard never resets in a long-lived PWA document; on the phone surface a 401 routes to the lock screen instead (desktop behavior unchanged), and the guard resets on re-auth. `AuthContext` currently clears the stored token on ANY `/auth/me` rejection; it must clear only on a real 401/`TOKEN_VERSION_MISMATCH`, never on a transport failure — otherwise an offline cold launch permanently signs the phone out, which the §7/§9 offline promises cannot survive.
- **Revocation, tied to the mechanism that actually kills JWTs:** live tokens die via the existing `token_version` bump in `middleware/auth.js`, and that bump is **per-user, not per-device** (corrected 2026-08-14, stated honestly rather than promised away): desktop credential revoke = delete the credential row AND bump `token_version`, which kills the phone's live 12h JWT immediately *and* logs out every other session, including the desktop performing the revoke, which simply logs back in. For a one-admin shop responding to a lost phone, a global logout is the correct blast radius, and it avoids putting a per-request credential lookup in the hot auth path. Password reset also bumps `token_version` (stolen-phone standard response works). Passkeys survive a password reset (possession + biometric factor); explicit revoke is the kill switch.
- **Escape hatches:** password login always works on the phone. Credential list + revoke in desktop Settings.
- **Observability:** Sentry events for registration, failed assertions, counter regressions, and revocations; push-send failures (§7) likewise. These are the records needed two weeks after a phone goes missing.
- **Review scaling:** `scripts/sensitive-paths.txt` gains `server/routes/webauthn.js`, `server/routes/auth.js`, `client/src/context/AuthContext.js`, `client/src/components/SessionExpiryHandler.js`, `client/public/admin-sw.js`, `client/public/admin-manifest.json`, and the PWA meta injector, so the promised fleet actually fires (the file currently lists neither the auth router nor any client path; its own comments document that failure mode).

## 9. Resume Where I Left Off

- Current route persisted on navigation; cold standalone launch restores it (behind the lock when the lock applies; unlock lands exactly where you were, including a held push deep link).
- **Never persisted:** `/login` and the auth/reset pages (the expiry handler navigates there; persisting it would defeat resume).
- **Restore fallback:** a saved route that now 404s or is denied (archived proposal, role change) falls back to `/events` instead of stranding on an error screen.
- Events and Proposals lists remember scroll position.
- A half-finished edit sheet does not survive a cold start; stale form state over changed data is how wrong numbers get saved (§5 extends this: money sheets also never open from cache-served reads while live).

## 10. Error Handling

- Every write reports failure inline in the sheet or form it came from, keeps input, offers retry. Nothing fails silently into a missable toast. (Cancel-line's retry-with-idempotency-key subtleties are moot in phase 1: Desktop-view.)
- API errors surface the server's message via the client's normalized error shape from `utils/api.js` — `err.status` / `err.message` / `err.fieldErrors` (the server-side `AppError.statusCode` never reaches the client; components must not read `err.statusCode`).
- Reads degrade per the §7 offline law (cached-with-staleness on transport failure only; cold cache may load normally).
- Phone components report to Sentry with a `surface: mobile-admin` tag.

## 11. Testing

- **Unit tests:** new pure logic (route-restore, staleness formatting, `useIsPhone` fork, screen keys). Money math is reused, already-tested code; no duplicate suites.
- **Per-screen gate:** Playwright at phone viewport with dev JWTs per the existing mobile-review recipe, `elementFromPoint` checks on primary actions, then a walkthrough by Dallas on the actual Pixel against dev data. Owed walks logged in `docs/walkthroughs-owed.md`.
- **Auth lane owns its test debt:** the "full server auth-route test suite" does not exist today (only preferred-name and client-auth files). The auth lane writes it: login, register, forgot/reset password, plus the full webauthn register/assert/revoke/counter/challenge matrix, and the `SessionExpiryHandler`/`AuthContext` behavior changes. Plus the 5-agent pre-prod fleet.
- **Docs law (per CLAUDE.md, not optional):** README folder tree (pages/mobile, hooks, SW, manifest, icons, scripts) + Tech Stack (`@simplewebauthn`); ARCHITECTURE route table (webauthn routes, push channel), Database Schema (`webauthn_credentials`, challenge table, `admin_push_preferences`), PWA/integrations section; CLAUDE.md env-vars table (`WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`).

## 12. Decisions Log

| Decision | Call |
| --- | --- |
| App form | Installable PWA on admin host; native rejected |
| Target | Android Chrome (Pixel); iOS = staff portal only |
| Surfaces | Phone-first components, route-level fork at 700px; not CSS retrofits |
| Escape hatch | Per-screen persisted Desktop-view toggle; "no dead ends" |
| Visual contract | Benchmark snapshot in docs/design-artifacts + OS design system as token law; overrides listed in §3 |
| Events list | Date-ordered; design-session card layout; Upcoming/Past switch + Needs-staff chip (chip = badge SQL, verbatim); grouped per event; manual shifts open the sheet |
| Proposals apparatus | Sort toggle Event date / Newest lead (created_at) + server-side Unviewed predicate; Modified chip omitted |
| Assignment sheet | Alphabetical candidates, no ranking machinery; explicit role rows on assign AND waitlist approval (position = payroll seam); waitlist via classifyRequest |
| Money edits | Full formState hydration required; no money sheet from a cache-served read; overrides, custom lines, cancel-line stay Desktop-view |
| Offline | Transport-failure-only cache fallback; allowlisted GETs; per-user cache namespace; purge on logout; remote-revoke residual stated, not hidden |
| Push | Channel inside notifyAdminCategory, direct send, fire-and-forget post-commit; per-CATEGORY toggles over a 4-category dispatch allowlist (blast-radius guard); layered under existing notification_preferences; toggle field on me.js PATCH; pushSubscribe generalized |
| Auth | Passkey = device session (no second bearer token); assert-verify is the only 12h mint; webauthn routes mounted under /api/auth/ (401-exclusion prefix); challenges single-use server-side; RP ID pinned to admin host; revocation = global token_version bump, stated honestly; 401/transport handling fixed in SessionExpiryHandler + AuthContext |
| Sheets vs Back | Mobile sheets push history so Android Back closes the sheet, never leaves the page |
| Resume | Route + list scroll restore; /login never persisted; dead-route fallback to /events; edit sheets never restored |
| Fleet trigger | Auth + SW + manifest paths added to scripts/sensitive-paths.txt |
