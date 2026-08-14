# Mobile Admin (Phase 1): Installable Phone-First Admin App

**Date:** 2026-08-13
**Status:** Approved (section-by-section, 2026-08-12/13)
**Audience:** Dallas only. Admin surface. Android Chrome on a Pixel is the design and test target. iOS remains relevant only to the staff portal, which this project does not touch.

## 1. Problem and North Star

The admin console is desktop-first. On a phone, its responsive CSS collapses dense multi-column layouts into very tall single columns: a correct rendering of the wrong information architecture. Dallas runs DRB from his phone whenever he is not at a desk, dislikes typing on the phone, and hates hitting "I simply can't do this from here."

**North star: no dead ends.** The common actions get a genuinely phone-first fast path. Everything else gets an escape hatch (Desktop view) that always exists, even when it is ugly.

**Not the fix:** more responsive CSS retrofits. `client/src/index.css` is ~19,700 lines with 104 ad-hoc media queries at dozens of breakpoints; that path stays "fine" forever and never becomes good.

**Chosen approach:** phone-first admin surfaces inside the existing React app, shipped as an installable PWA on the admin host. Native app rejected: the felt gap is phone-first IA versus desktop IA, not web versus native, and a second codebase forever is the wrong trade for a sole developer.

## 2. Scope and Phasing

- **Phase 1 (this spec):** app shell, Events list + detail, Proposals list + detail, global search, install/push/offline, biometric auth, resume-where-I-left-off.
- **Phase 2 (later spec):** staffing and payroll. Payroll touches money across 12 files and gets its own design pass.
- **Phase 3 (later spec):** rest of Workspace: Messages, Clients, Hiring, Overview.

Explicitly out of phase 1: proposal creation from the phone (the New Proposal button routes to Desktop view), free-text price overrides, composing new custom line items, any offline write queueing, any staff-portal changes.

## 3. Architecture

Same repo, same React app, same admin host and URLs.

- **Fork point:** a new `useIsPhone` hook: one `matchMedia` check at a single breakpoint constant, **700px**, defined once. No new scattered breakpoints.
- **Route-level fork:** each phase-1 route keeps its existing desktop component; at phone width the route renders a phone component instead. `/events/:id` stays one URL answering with `EventDetailPage` or the mobile equivalent. Deep links from push, SMS, and the command palette keep working unchanged.
- **Phone components** live in `client/src/pages/mobile/` with their own small CSS. They share everything below the presentation layer: `utils/api.js`, hooks, `AuthContext`, `components/adminos/format.js`. No new API endpoints for phase-1 reads and edits.
- **Desktop-view escape hatch:** every mobile screen carries a toggle that forces the desktop component at phone width, persisted per-screen (a real exit, not a one-shot). This is the "no dead ends" guarantee for anything phase 1 does not build natively.

### Shell

- Bottom tab bar: **Events**, **Proposals**, **More**. The `unstaffed_events` badge moves from the sidebar to the Events tab; `pending_proposals` to the Proposals tab.
- Top bar carries a global-search magnifier on every tab (see §6).
- Safe-area insets respected for the Android gesture bar; the tab bar and thumb-zone actions sit above it.
- Shell ships **first**, before any screen: standalone mode changes viewport height (no URL bar) and adds bottom insets, so screens are designed inside the real container and tested from the actual installed icon.

### Visual design round-trip

Per the settled 2026-08-04 workflow: these are brand-new surfaces, so each goes through claude.ai/design against the **Dr. Bartender OS Design System** project (`72035042-c993-47e2-9dc8-c452b7bf5fa4`). Lean prompts out (paths + plain descriptions; the design project carries the token law), DesignSync MCP back, then the generated screens are fitted to the stack here: real endpoints via `utils/api.js`, CSS folded in, routes and auth guards, real data. The **shell goes out first** so the design project learns the mobile idiom (bottom tabs, sheets, thumb zone) before the four screens are prompted.

## 4. Events

### List (`/events`, phone)

- Card list, not a table. Same upcoming/past tabs, URL-backed as today.
- **Date-ordered, period.** Upcoming opens on today, next event first. No status filter, no sort controls on the phone; that apparatus is desk work and stays desktop.
- Card = three lines, one big tap target: client + event name; date and time; staffing chip (the existing colored chip). "Am I covered Saturday" is the one non-date signal that earns a place on the card. No balance, no guests, no location on cards.
- Tap opens detail.

### Detail (`/events/:id`, phone)

Keeps the existing four-block structure, stacked in priority order: **header, staffing, pricing, activity**.

- **Header:** client, date, time, venue. Venue address opens Google Maps (extend `AddressLink` behavior); client phone is tap-to-call / tap-to-text. Existing page actions (edit, send invite, re-enroll, cancel) become full-width tap targets.
- **Staffing:** keeps `ShiftDrawer` semantics as a bottom sheet. Tap a shift; assign / approve / remove are rows you tap. No dropdowns.
- **Structured edits:** date and time use native Android pickers; counts use steppers; statuses are chips. Event note is a plain textarea that behaves with Android dictation (dictation is the accepted answer for free text; no snippet/template system in phase 1).
- **Pricing:** read-heavy. Line items listed; cancel-line behind a kebab. Anything deeper is a Desktop-view case in phase 1.
- **Activity:** plain feed, unchanged shape.

## 5. Proposals

### List (`/proposals`, phone)

Same treatment as events: card list, ordered by event date, tap to open. Proposals keep **one** state signal on the card: the pipeline-stage chip (draft / sent / viewed / modified / accepted), because a proposal's identity is its funnel position. No filters, no column sorting.

### Detail (`/proposals/:id`, phone)

- **Read view:** stacked blocks: client, event basics, package and line items, payment state, activity. Tap-to-act carries over (call, text, maps). Actions row: send, remind, archive as tap targets.
- **Edits:** structured edits only, with pickers and steppers: date, times, guest count, bar count, add-on quantities. All edits run through the **existing** `proposalEditor/` logic (`formState.js`, `patchBody.js`, `repriceSummary.js`) so the money math has exactly one implementation. A reprice-triggering edit shows the same before/after confirmation as the desktop modal, as a bottom sheet.
- **Desktop-view cases in phase 1:** free-text price overrides, new custom line items, proposal creation. Rare, money-bearing, already served by the tested desktop path.

## 6. Global Search

- Magnifier in the shell top bar on every tab. Backed by the **same global-search endpoint the ⌘K palette uses**. No per-screen filter boxes.
- Full-screen search takes over on tap; results grouped as the palette groups them (events, proposals, clients) rendered as large tap rows. Keyboard appears only when the field is focused; dictation works in the field.

## 7. Install, Push, Offline

### Install

- New `client/public/admin-manifest.json`: name "DrB OS", its own icon (visually distinct from the staff app), `display: standalone`, `start_url: /events` (route-restore then takes over, §9).
- Injected at runtime the same way `installStaffPwaMeta.js` does, **gated to the admin host**. The `staff.` gate and staff manifest are untouched; the injector generalizes so each host gets its own manifest and the installs never collide.
- Chrome's install banner will fire on its own; an explicit "Install app" row in **More** removes any dependence on Chrome's mood.

### Push

- Server side unchanged: `pushDispatch.js` + existing VAPID keys.
- New `client/public/admin-sw.js` registered on the admin host: handles push display and notification clicks with deep links into the tapped entity.
- Phase-1 push events (already admin-alert shaped): new lead, proposal accepted, payment received, staffing drop. Each toggleable in More → Notifications; all default-on. Android Chrome: permission grant just works; no install-first nagging needed.

### Offline

- `admin-sw.js` precaches the app shell (JS, CSS, fonts, icons): instant open, works as a container with no signal.
- **Reads:** network-first with cache fallback. Every GET the phone surfaces make is cached; on fetch failure the cached copy renders with a staleness line ("as of 2:14 PM"), never a spinner or bare error.
- **Writes: never queued.** A failed save keeps the sheet open with input intact and says plainly "no connection, didn't save"; retry when signal returns. No background sync, no conflict resolution, no IndexedDB mirror. The SW response cache is the entire mechanism.

## 8. Auth: Biometric Unlock

The one place phase 1 touches auth. Gets max-effort treatment and the 5-agent pre-prod review fleet before merge.

- **Mechanism:** WebAuthn passkeys via the Android platform authenticator (fingerprint or face; the OS decides which are enrolled and strong enough, PIN is the OS-level fallback).
- **Enrollment:** first launch on the phone: password login once, then the app registers a passkey on the device.
- **Server:** new `webauthn_credentials` table (user id, credential id, public key, signature counter, label, created/last-used) and two endpoints on the existing auth router: register and assert.
- **Session model (phone only; desktop login unchanged):**
  - Access JWT drops to **12 hours** on the phone (desktop keeps 7d).
  - Paired with a long-lived opaque device token, hashed at rest, revocable.
  - JWT expired, or app backgrounded > **30 minutes** → lock screen. One biometric tap performs a WebAuthn assertion; server verifies against the stored credential and issues a fresh JWT. The phone holds no live token while locked; the unlock is not cosmetic.
- **Escape hatches:** password login always works on the phone (biometric failure, wiped passkey). Credential list + revoke button in desktop Settings, so the phone's access can be killed from the laptop.

## 9. Resume Where I Left Off

- Current route persisted on navigation; cold launch restores the saved route (behind the lock screen when the lock applies; unlock lands exactly where you were).
- Events and Proposals lists remember scroll position.
- A half-finished edit sheet does **not** survive a cold start: restoring stale form state over changed data is how wrong numbers get saved. Interrupted edits reopen fresh with the sheet closed. Ordinary backgrounding (app still in memory) keeps everything, sheets included, with the 30-minute lock as an overlay.

## 10. Error Handling

- Every write reports failure **inline in the sheet or form it came from**, keeps input, offers retry. Nothing fails silently into a missable toast.
- API errors surface the server's message per the existing `AppError.statusCode` convention, unchanged.
- Reads degrade to cached-with-staleness (§7).
- Phone components report to Sentry with a `surface: mobile-admin` tag so phone-specific breakage is independently visible.

## 11. Testing

- **Unit tests:** new pure logic only: route-restore, staleness formatting, the `useIsPhone` fork. Money math is deliberately reused, already-tested code; no duplicate suites.
- **Per-screen gate:** Playwright pass at phone viewport using dev JWTs per the existing mobile-review recipe, including `elementFromPoint` checks on primary actions (clipped-control false-pass lesson), then a walkthrough by Dallas on the actual Pixel against dev data before the screen is called done.
- **Auth changes additionally get:** the full server auth-route test suite plus the 5-agent pre-prod review fleet.
- Owed on-device walkthroughs are logged in `docs/walkthroughs-owed.md`, the single file.

## 12. Decisions Log

| Decision | Call |
| --- | --- |
| App form | Installable PWA on admin host; native rejected |
| Target | Android Chrome (Pixel); iOS = staff portal only, out of scope |
| Surfaces | Phone-first components, route-level fork at 700px; not CSS retrofits |
| Escape hatch | Per-screen persisted Desktop-view toggle; "no dead ends" |
| Events list | Date-ordered only; staffing chip is the sole non-date signal; no status/filter/sort apparatus |
| Proposals list | Same, plus pipeline-stage chip |
| Free text | Android dictation; no snippet system in phase 1 |
| Money edits | Reuse `proposalEditor/` form/patch/reprice logic; overrides and custom lines stay Desktop-view |
| Offline | Cached reads with staleness marker; writes never queue |
| Auth | WebAuthn biometric unlock; 12h phone JWT; 30-min background lock; desktop revoke |
| Resume | Route + list scroll restore; edit sheets never restored across cold start |
| Visual design | claude.ai/design round-trip against the OS design system; shell prompt first |
