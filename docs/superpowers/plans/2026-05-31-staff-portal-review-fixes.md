# Staff Portal v2 — Review-Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (or executing-plans). Each task is a self-contained, separately-revertable fix. Steps use checkbox (`- [ ]`) syntax.

**Worktree:** `C:\Users\dalla\DRB_OS\worktrees\beo` · **Branch:** `beo` · **Date:** 2026-05-31

**Goal:** Fix the four issues found in the in-browser review of the staff portal v2 surface (`/staff-v2`), each at its verified root cause, not the symptom.

**Scope guard:** Bug fixes only. No new features, no refactors beyond what each root cause requires. The `open_shifts_teaser` wire-up (Task 3) completes an existing stub to its already-specced shape (spec §6.2) and is in scope. Do NOT touch the cutover (Task 48 in the parent plan), push notifications, or any Pay/Tip/Account surface.

---

## Requirements (review findings + verified root causes)

These are the "spec" each task must satisfy. Root causes were confirmed by reading the code + live DOM/token inspection in the browser.

- **R1 — Light theme never appears light.** Toggling the user-menu "House lights" control flips `document.documentElement.dataset.skin` and the `--sp-*` tokens correctly (verified: `--sp-bg-0` → `#f7f4ec` on `data-skin="light"`), but the visible page backdrop stays dark. **Root cause:** the page backdrop is the app-global `body { background-color: var(--chalkboard) }` = `#12161C` (`client/src/index.css:104-106`, `--chalkboard` at `:40`), which is NOT skin-aware. The staff portal sets `data-skin` but no app-scope, so nothing overrides the chalkboard body backdrop for the staff context. (Admin solves the mirror problem with `html[data-app="admin-os"]` scoping.)
- **R2 — User-pill menu header shows the email on both lines.** `StaffUserPillMenu` renders `user.name` then `user.email` (`StaffUserPillMenu.js:83-84`); `StaffShellWithThemeWiring` sets `shellUser.name = user.preferred_name || user.email` (`:151`). **Root cause:** the client `user` object has no `preferred_name`.
- **R3 — Hero greeting uses the email local-part** ("Good morning, sp-review-staff"). `HomePage.js:329` = `user?.preferred_name || user.email.split('@')[0]`. **Same root cause as R2.**
- **R2/R3 shared root cause:** the client `user` comes from `AuthContext`, hydrated from `GET /api/auth/me` (`AuthContext.js:35-36,63-65`) and the login response (`:46`). `/auth/me` returns `{ ...req.user }` (`auth.js:350`); `req.user` is built by the auth middleware from a users-table-only SELECT (`middleware/auth.js:32` — no `preferred_name`). `preferred_name` lives in `contractor_profiles`. So the field never reaches the client. **One server-side fix resolves both R2 and R3.**
- **R4 — Home "Open shifts" shows 0 while Shifts → Available shows the real list.** **Root cause:** `open_shifts_teaser: []` is a hardcoded stub in the `/api/me/staff-home` handler (`server/routes/staffPortal.js:143`), left empty in the parent plan's Task 12. HomePage renders from it (`HomePage.js:107`), so the count is always 0.

---

## Task 1: `preferred_name` in the auth payload (fixes R2 + R3)

**Files:**
- Modify: `server/routes/auth.js`
- Create or extend a route test (mirror the hand-rolled `node:http` harness in `server/routes/staffPortal.test.js` / `beo.test.js` — there is no supertest in this repo)
- Modify: `client/src/pages/staff/HomePage.js` (greeting first-name refinement only)

- [ ] **Step 1: Failing test.** Add a `node:test` that logs in / mints a `staff` user with a `contractor_profiles.preferred_name` and asserts `GET /api/auth/me` returns `user.preferred_name`. Use the established harness (mount the `auth` router on a bare `express()` with the real `auth` middleware + AppError error handler; `password_hash` + bcrypt; `onboarding_status='approved'`; JWT `{ userId, tokenVersion }`). Run with `bash -lc "export $(grep -E '^(DATABASE_URL|JWT_SECRET|ENCRYPTION_KEY)=' ../../os/.env | head -3); node --test <file>"`. Verify it FAILS (field absent).

- [ ] **Step 2: Add `preferred_name` to `GET /api/auth/me`.** In the handler at `auth.js:347`, alongside the existing `applications` lookup, fetch `preferred_name` for `req.user.id` via a `LEFT JOIN contractor_profiles` (one round trip; matches the Step 3 choice), and merge it into the returned `user` object. Non-staff (no `contractor_profiles` row) → `preferred_name: null` (graceful; their existing email fallback is unchanged).

- [ ] **Step 3: Add `preferred_name` to the login response** so the name shows immediately after login without waiting for the next `/auth/me`. The login handler's user SELECT is at `auth.js:305` (`SELECT id, email, role, ... FROM users`). `LEFT JOIN contractor_profiles cp ON cp.user_id = users.id` and project `cp.preferred_name`. Keep the existing returned fields intact.

  > Deliberately NOT changed: the auth middleware (`middleware/auth.js:32`). It runs on every authenticated request; adding a JOIN there is a hot-path cost for a display-only field. Scope the fix to the two payloads the client `user` is actually built from.

- [ ] **Step 4: Greeting first-name refinement.** `HomePage.js:329` currently shows the full `preferred_name` ("Sam Review"). Take the first whitespace token so the hero reads "Good morning, Sam." Leave the menu name-line as the full `preferred_name` (it already reads `shellUser.name`, no client change needed there).

- [ ] **Step 5: Verify.** Test passes. In the browser (seeded `sp-review-staff`), the hero greets "Sam" and the user-menu header shows "Sam Review" over the email.

- [ ] **Step 6: Commit** — `fix(staff-portal): surface preferred_name in auth payload (menu name + greeting)`

---

## Task 2: skin-aware staff backdrop (fixes R1)

**Files:**
- Modify: `client/src/components/StaffShell.js`
- Modify: `client/src/index.css`

- [ ] **Step 1: Confirm the visible backdrop element.** Root cause is the global `body { background-color: var(--chalkboard) }`. Before editing, confirm in the browser whether the dark backdrop the user sees is the `body` background-color and/or a chalkboard-texture container behind `.sp-shell` (inspect computed `background` on `body` and any wrapping `main`/container). Make the element that actually carries the visible backdrop skin-aware. (Evidence already gathered: `getComputedStyle(document.body).backgroundColor` = `rgb(18,22,28)` while `--sp-bg-0` was light.)

- [ ] **Step 2: Scope the staff context on `<html>`.** In StaffShell's existing skin `useEffect` (`StaffShell.js:77-82`, which sets `document.documentElement.dataset.skin`), also set `document.documentElement.dataset.app = 'staff'` on mount and **remove it on cleanup** (effect return), so the staff app-scope never leaks into the admin/public contexts (which rely on the chalkboard backdrop). Mirror the existing `data-app="admin-os"` convention.

- [ ] **Step 3: Skin-aware backdrop CSS.** Add to `index.css` (near the `.sp-shell` block, ~`:13994`):
  ```css
  html[data-app="staff"] body {
    background-color: var(--sp-bg-0);
    background-image: none;
  }
  ```
  This overrides the global chalkboard backdrop for the staff context only, and `var(--sp-bg-0)` tracks the skin (dark `#0b0d10` / light `#f7f4ec`). If Step 1 finds a texture container rather than `body` carrying the visible backdrop, scope the same override to that element instead.

- [ ] **Step 4: Verify in the browser.** `CI=true npm --prefix client run build` passes. With the dev server up, toggle the user-menu "House lights" / "After hours": the full backdrop switches light/dark (not just card tokens). Navigate away from `/staff-v2` and confirm `data-app` is cleaned up (admin/public backdrop unaffected).

- [ ] **Step 5: Commit** — `fix(staff-portal): skin-aware page backdrop via data-app="staff" scope`

---

## Task 3: wire `open_shifts_teaser` (fixes R4)

**Files:**
- Modify: `server/routes/staffPortal.js`
- Modify: `server/routes/staffPortal.test.js`

- [ ] **Step 1: Failing test.** In `staffPortal.test.js`, extend the `/staff-home` coverage: seed an open, unassigned shift the staffer is eligible for, and assert `open_shifts_teaser` is non-empty (and capped). Run the suite; verify the new assertion FAILS against the current `[]` stub.

- [ ] **Step 2: Replace the stub.** At `staffPortal.js:143`, replace `open_shifts_teaser: []` with the real query: the same open-shift selection the staff `GET /api/shifts` path uses (reuse `server/routes/shifts.queries.js` if it already centralizes that SQL — check first), filtered to upcoming open shifts the requester is not already approved/dropped on, ordered soonest-first, `LIMIT 2` for the teaser (spec §6.2: "top 2 open shifts"). Keep it inside the existing `Promise.all` composite so `/staff-home` stays one round trip.

- [ ] **Step 3: Verify.** Test passes. Browser: Home "Open shifts" shows the same top entries as Shifts → Available (and the "All (N)" count is consistent).

- [ ] **Step 4: Commit** — `fix(staff-portal): wire open_shifts_teaser to real open-shift query`

---

## Task 4: review-scaffolding cleanup (no product change)

**Files:**
- Modify: `client/src/App.js`
- Delete: `.claude/sp-review-seed.js`, the `sp-*.png` screenshots, `.playwright-mcp/` artifacts

- [ ] **Step 1: Revert the dev-only context override** added to `App.js` `getSiteContext()` during the review (the `localStorage 'dev-site-context'` branch). It is inert without the flag, but it is uncommitted tracked-file drift and should not ship. Revert it — per the scope guard this dev hack does not ship. No pause for input.

- [ ] **Step 2: Remove review scratch.** Delete the seed script and screenshots from the worktree. `client/.env` (gitignored) may stay — it is how the local dev server reaches the API.

- [ ] **Step 3: Remove seeded DB rows.** FIRST confirm the connection targets the dev/scratch Neon branch, not prod — inspect the `DATABASE_URL` host before running any delete. THEN, once browser re-verification is done: `DELETE FROM users WHERE email = 'sp-review-staff@example.com'` and the `sp-review-client` client (cascades clean its proposals/shifts/drink_plans).

- [ ] **Step 4: No commit** unless Step 1 reverts a tracked file — then `chore(staff-portal): remove dev-only review scaffolding`.

---

## Execution review cadence

Per project convention (auth and DB changes get specialized review before push):
- **After Task 1** (auth payload shape change): run `security-review`.
- **After Task 3** (new SQL in `/api/me/staff-home`): run `database-review` + `code-review`.
- Task 2 is CSS/DOM-scope only — no specialized agent.

## Final verification

- [ ] `node --test server/routes/auth.*.test.js server/routes/staffPortal.test.js` — all green.
- [ ] `CI=true npm --prefix client run build` — clean.
- [ ] Re-run the seeded browser pass at `/staff-v2`: (1) greeting shows first name, (2) menu shows name + email, (3) theme toggle switches the full backdrop both ways, (4) Home open-shifts count matches Available.
- [ ] `git log --oneline` shows 3 fix commits (+ optional cleanup), each independently revertable.

## Notes

- Dev-environment scaffolding used to review on localhost (NOT product changes): gitignored `client/.env` (`REACT_APP_API_URL=http://localhost:5000`, sidesteps the CRA-proxy trailing-slash CORS quirk) and the `App.js` context override (Task 4). The staff portal is host-gated to `staff.*`; localhost falls to the `app` (admin) context, hence the override is needed to view `/staff-v2` locally.
- R1's fix is CSS/DOM and not unit-testable in this harness; it is browser-verified. R2/R3/R4 get `node:test` coverage.
