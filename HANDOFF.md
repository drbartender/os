# Staff Portal + BEO — Handoff (2026-05-31)

**Worktree:** `C:\Users\dalla\DRB_OS\worktrees\beo`
**Branch:** `beo`
**Last commit:** `46594c6 plan(staff-portal): fold in 2026-05-31 design re-review findings (feasibility + Gemini)`
**Branch position:** `beo` is **5 ahead / 2 behind `main`**. See "Re-sync before continuing" below — the 2 it's missing are load-bearing.

---

## TL;DR

The **BEO feature is complete**, the **staff-portal backend is complete**, and the **staff-portal frontend is ~half built** (shell + the entire Shifts surface incl. the BEO viewer). A 4-issue review-fix pass just landed and a design re-review of the unbuilt phases (feasibility + Gemini 2.5 Pro) is folded into the plan. What remains is the **Pay/Tip surface, the AccountPage, the cutover, and push notifications** — plus one **BLOCKER** to resolve at cutover. After the cutover, the worktree gets merged to `main`, pushed, and removed (and the worktree workflow gets dismantled in favor of trunk-based — a decision made this session).

---

## What's DONE (and verified)

All on branch `beo`. ~63 commits this session (`git log 0fccb52..HEAD`).

### BEO feature — complete
Banquet Event Order: schema, `beoHandlers.js` (T-3 unack nudge + scheduling/suppression/reanchor), `routes/beo.js` (GET payload + logo proxy + POST acknowledge), Finalize/Unfinalize lifecycle + lock guards, all shift-integration suppression hooks, admin DrinkPlanCard buttons + EventDetailPage "Confirmed" pills, `team_roster` projection. Server suites green.

### Staff-portal BACKEND (plan Phases 1–5, Tasks 1–28) — complete
- Schema: `ui_preferences` / `staff_notification_preferences` / `token_version` / `last_ics_fetch_at` on `users`, `zelle_handle`, cover/drop columns + `replaced_by_request_id` on `shift_requests`, `staff_document_history` / `staff_audit_log` / `pending_email_changes` tables, etc.
- Routers: `server/routes/staffPortal.js` (+ `staffPortal/paymentMethods.js`), `emailChange.js`, `adminCoverSwaps.js`. All `/api/me/*` endpoints (staff-home, payment-methods, profile, ui-preferences, staff-notifications, push-subscriptions, documents/replace, email-change request/cancel/confirm).
- Drop/Cover marketplace: drop / request-cover / claim-cover / emergency-drop / withdraw + `coverBroadcast.js` + `coverApprovalCascade.js`. Calendar feed BEO-confirm VEVENTs. Auth `suspended` deny + `dropped_at` filters.

### Staff-portal FRONTEND Phases 6–7 (Tasks 29–37) — complete
- Phase 6 (shell): `StaffShell.js`, `StaffUserPillMenu.js`, `StaffShellWithThemeWiring.js`, `staff/Placeholder.js`, design tokens ported to `index.css` (all `--sp-` prefixed), `/staff-v2/*` stub route block in `App.js`.
- Phase 7 (shifts): `staff/ShiftCard.js`, `staff/TeamRosterCard.js`, `pages/staff/HomePage.js`, `ShiftsPage.js`, `ShiftDetail.js`, `components/staff/DropCoverModal.js`, `BeoSections.js`. `team_roster` added to `GET /api/beo/:proposalId`.

### Review-fix pass (4 findings) — complete + browser-verified
Plan: `docs/superpowers/plans/2026-05-31-staff-portal-review-fixes.md`. Commits `63aa16f`, `efaf87d`, `8a69b9a`:
- **R2+R3** `preferred_name` surfaced in `/auth/me` + login payload (menu shows the name, greeting shows the first name).
- **R1** skin-aware page backdrop via `data-app="staff"` (light theme now actually renders light; was the non-skin-aware global chalkboard).
- **R4** `open_shifts_teaser` (top 2) + `open_shifts_count` wired into `/staff-home` (Home "Open shifts" now matches Available).
Review cadence ran clean (security "ship it", database clean, code-review benign).

---

## What's LEFT — staff-portal plan Phases 8–11 (Tasks 38–56)

**Primary doc:** `docs/superpowers/plans/2026-05-27-staff-portal-redesign-implementation.md` — **read the new "⚠️ Review Amendments (folded in 2026-05-31)" section at the top first.**

| Phase | Tasks | What | Risk |
|---|---|---|---|
| 8 — Pay + Tip Card | 38–41 | PayoutEventRow/PayoutDetail, PayPage, TipCardPage, publicTip extension | Low (publicTip is PII-sensitive, see W2) |
| 9 — AccountPage | 42–47 | Account shell + Profile/EmailVerify, PaymentMethods/AddMethod, CalendarSync, Notifications, Documents | Low–medium (async states under-specced, see W1) |
| 10 — Cutover | 48–51 | Swap `/staff-v2` → real staff site, redirects, delete old fragments, docs | **Highest — has the BLOCKER** |
| 11 — Push (Phase B) | 52–56 | web-push, service worker, iOS coachmark, dispatcher activation | Deferred; not needed to close the tree |

### Review findings to address (folded into the plan; re-stated here)

- **🔴 BLOCKER — Task 49 (cutover): BEO nudge URL not reconciled.** The nudge SMS links to `/events/:proposalId/beo` (proposalId-keyed, `server/utils/beoHandlers.js`) but the new ShiftDetail/BEO viewer is `/staff-v2/shifts/:shiftId` (shiftId-keyed). After cutover, **every BEO nudge link 404s.** Triple-confirmed (manual feasibility + plan-feasibility agent + Gemini). Fix: a `/events/:proposalId/beo` redirect that resolves proposalId→shiftId (model on `ShiftDetailRedirect`, `App.js:442`), OR change the nudge URL server-side. An explicit Step 2.5 was added to Task 49.
- **🟡 W2 — Task 41:** `publicTip.js` is unauthenticated with a hardcoded public-safe SELECT. Add `zelle_handle` to that explicit list (NOT `SELECT *`) + read-side validation mirroring `normalizePaypalUrl`. (Inlined into Task 41.)
- **🟡 W1 — Phase 9:** Account sub-sections lack loading/empty/error/disabled state specs (§6.1.5). Define all four per section.
- **🟡 W3 — Task 46/18:** EmailVerifyPage must handle the **logged-out** click of the confirm link (it's token-keyed, so confirm works without a session; then prompt login or show clean success).
- **🟢 S1 — Phase 8:** shared money formatter (integer cents → `$1,234.56`); check `client/src/utils/` for an existing one first.
- **🟢 S2 — Phase 11:** push permission-request + denial UX (not in the backend-only plan).

**Feasibility confirmed sound:** `App.js` cutover structure is intact (`StaffSiteRoutes`/`HiringRoutes` both have old `StaffLayout` mount + `/staff-v2` block; 492 lines, no ratchet risk; Task 50 delete list matches disk). Phase 8–9 backend contracts all exist.

---

## ‼️ Re-sync before continuing

`beo` is **2 behind `main`** — `main` has two fixes (landed from a parallel window) that touch code this branch also touches:
- `187d31e fix(beo): rate-limit unauthenticated email-change confirm + extend suspended/deactivated gate to managers`
- `e29929e fix(beo): exclude emergency-dropped staff from money/coverage/BEO reads, throw on cover-cascade mismatch, fire-and-forget cover broadcast`

**Before doing more Phase 8+ work, merge `main` into `beo`** (`git merge main` from this worktree) so you build on those fixes and don't re-diverge on emergency-drop / email-change / cover-cascade. Expect a clean merge (different surfaces), but resolve `README.md`/`ARCHITECTURE.md` by union if they conflict.

---

## Key documents (all referenced)

- **Staff-portal plan (PRIMARY):** `docs/superpowers/plans/2026-05-27-staff-portal-redesign-implementation.md` — has the folded-in Review Amendments + per-task inlines (Task 49 Step 2.5, Task 41 PII note).
- **Review-fix plan (just executed):** `docs/superpowers/plans/2026-05-31-staff-portal-review-fixes.md`.
- **Staff-portal spec:** `docs/superpowers/specs/2026-05-27-staff-portal-redesign-design.md` (§ anchors per task; §6.1.5 = async states; §6.8 = tip; §9 = phasing).
- **BEO plan:** `docs/superpowers/plans/2026-05-26-beo-implementation.md`.
- **Gemini re-review output (verbatim):** `.claude/gemini-plan-out.txt` (prompt in `.claude/gemini-plan-prompt.txt`).
- **Design source for the frontend:** `C:\Users\dalla\Downloads\Dr Bartender (6)\staff\` — `app.jsx`, `account.jsx`, `details.jsx`, `data.jsx`, `icons.jsx`, `styles.css`. Phases 8–9 build their surfaces from this + the spec.

---

## Operational context (local dev / review)

Viewing `/staff-v2` on localhost is non-obvious — full notes in the memory `reference_staff_portal_local_review.md`. Essentials:
- **Run the dev server from this worktree:** `NODE_ENV=development HOST=localhost DANGEROUSLY_DISABLE_HOST_CHECK=true npm run dev`. The forced `NODE_ENV`/`HOST` are required — the shell has them set to empty strings, and dotenv won't override empties (breaks CORS + CRA's allowedHosts).
- **`beo/.env`** (copied from `../../os/.env`) and **`client/.env`** (`REACT_APP_API_URL=http://localhost:5000`) already exist, gitignored. The `client/.env` sidesteps a CRA-proxy trailing-slash CORS bug.
- **Host-gating:** `/staff-v2` only mounts when the host starts with `staff.`. On localhost it falls to the admin context. To review locally, force the staff context (a dev-only `localStorage 'dev-site-context'` override in `App.js getSiteContext()` — was added and reverted during the review; re-add temporarily if you need to browse, revert before commit).
- **DB:** Neon dev branch; `DATABASE_URL` lives in `../../os/.env`, NOT the shell. Prefix DB commands: `export $(grep -E '^(DATABASE_URL|JWT_SECRET|ENCRYPTION_KEY)=' ../../os/.env | head -3);`.
- **nodemon EADDRINUSE:** rapid server-file saves can make nodemon crash on restart (port not released). If `:5000` is down after edits, kill `:3000`+`:5000` by PID (`netstat -ano | grep :5000` → `taskkill //F //PID`) and relaunch.

### Tests
- BEO + staff-portal suites are green in isolation (run with the DB prefix above). Full `npm test` shows ~150 PRE-EXISTING shared-DB concurrency failures — not regressions; ignore unless a file that passed in isolation starts failing in isolation.
- `CI=true npm --prefix client run build` passes (only a pre-existing html2pdf source-map warning).

### Testing status (interactive pass done 2026-06-01)
Backend is well-tested. The **Phase 6–7 frontend mutation flows were exercised end-to-end** via Playwright + DB verification (seeded scenario, 0 console errors):
- ✅ BEO viewer renders with real drink data (signature cocktails resolve from real slugs + custom + custom-menu); ✅ Confirm-BEO stamps `beo_acknowledged_at` + flips the pill; ✅ clean-drop / ✅ request-cover / ✅ emergency-drop (all 3 modal modes, correct by time-window, DB-verified incl. `drop_emergency` + `proposal_activity_log`); ✅ claim-cover (creates pending + `replaced_by_request_id` swap link); ✅ withdraw (deletes the pending row); ✅ desktop (1024) renders cleanly.
- 🐞 **Bug found + fixed during the pass** (commit `7108b01`): the BEO route did not return `request_id` in `shift_requests`, so on a **deep-linked** ShiftDetail (no nav-state, e.g. from an SMS link or a refresh) drop / request-cover / emergency-drop silently bailed (`myRequestId` was null; the error was a `toast?.error` that fired but the modal just sat there). Added `sr.id AS request_id` to the projection + a regression test. **This is exactly the seam the cutover's BEO-nudge deep-link will hit — verify it again post-cutover.**
- Still untested by definition: Phases 8–9 surfaces (Pay/Tip/Account — not built yet). Responsive limited to a 390 + 1024 spot-check; no formal a11y pass. A loading/empty/error sweep is still worth doing per Phase 9.

---

## Direction / closing out this tree

Decision made this session: **after this work ships, dismantle the worktree workflow and return to trunk-based** (serial work made long-lived worktrees a net cost — staleness + repeated re-merges). Don't act on that yet; it happens at closeout.

**Path to close the tree:**
1. Re-sync `main` into `beo` (see above).
2. Build Phase 8 (Pay/Tip), then Phase 9 (Account) — similar in size/approach to the Phase 6–7 work (subagent build from spec + design source, build-gated + browser checks).
3. Interactive browser test pass (close the testing gap above).
4. Phase 10 cutover — carefully, **resolving the BLOCKER** (BEO nudge redirect). Verify in-browser, then `/staff-v2` is the live staff site.
5. Run the full review-before-deploy fleet, then merge `beo` → `main` → push → `npm run worktree:rm -- beo`. Phase 11 (push) is a separate later effort.

## Recommended next-window prompt

> Continue the staff portal at `docs/superpowers/plans/2026-05-27-staff-portal-redesign-implementation.md` starting Phase 8. **First read the "⚠️ Review Amendments" section at the top of the plan**, then `git merge main` into this `beo` worktree to pick up the 2 missing fixes (see HANDOFF.md "Re-sync"). Phases 1–7 + the review fixes are done. Watch the Task 49 BLOCKER (BEO nudge URL redirect) when you reach the cutover. Local-dev gotchas: HANDOFF.md "Operational context".

## Don't touch unless asked
- `docs/superpowers/specs/*` — settled.
- The kept `.claude/beo-gemini-*` and `.claude/spec-*-prompt.md` scratch (the user keeps these).
