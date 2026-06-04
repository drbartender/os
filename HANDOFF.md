# Staff Portal + BEO — Handoff (updated 2026-06-03, Phase 11 BUILT)

**Worktree:** `C:\Users\dalla\DRB_OS\worktrees\beo` · **Branch:** `beo`
**Status:** **Phase A (Tasks 1–51) is LIVE in production.** **Phase 11 / Phase B (Tasks 52–56, push notifications) is now BUILT + committed on `beo`, UNPUSHED.** Remaining work is the VAPID env + a post-deploy on-device verification pass + closeout. Dallas holds the push.

---

## What Phase 11 delivered (7 commits on `beo`)

| Commit | Task | What |
|---|---|---|
| `2f7925c` | 52 | `web-push` dep + VAPID env vars documented (`.env.example`, CLAUDE.md, README) |
| `fec2ba5` + `1073038` | 53 | Service worker `client/public/staff-sw.js`, `client/src/utils/pushSubscribe.js`, **staff-scoped PWA manifest** (`staff-manifest.json` + `installStaffPwaMeta.js`, the iOS-install prerequisite the plan missed) + review fixes |
| `26053ef` + `25daff6` + `176dcfd` | 54 + 56 | Push column LIVE: `IOSCoachmark` 3-step walkthrough, `PushPermissionBanner` (granted/default/denied/unsupported/iosNeedsInstall), unlocked toggles, first-toggle subscribe flow + copy fix |
| `73cad33` | 55 | `pushSender.js` real web-push, **boot-safe** (VAPID unset/malformed never crashes the server) + 5 unit tests |
| `45a50d3` | docs | web-push in tech stack + ARCHITECTURE Web Push section |

The Phase-A dispatcher push path (`scheduledMessageDispatcher.dispatchPushRow`, fan-out + 410-prune + sibling cascade) was already built; Phase 11 supplied the client surface, the manifest, and flipped the sender stub to real.

## Two plan gaps caught + fixed (not just patched)
1. **Missing PWA manifest / Apple meta** — iOS push needs a home-screen-installed standalone PWA; the plan never created one. Added a **staff-host-only** manifest + meta injection (admin/public/hiring unaffected).
2. **`setVapidDetails` boot crash** — the plan's top-level call throws on unset/malformed keys, crashing the server at boot (every local run + prod-before-keys). Guarded behind a try/catch + call-time fail-closed check. Proven: require with unset AND malformed keys → no crash.

## Verified locally
- `CI=true npm --prefix client run build` green (only the pre-existing html2pdf source-map warning).
- `node --test server/utils/pushSender.test.js` → 5/5 (vapid_unset, success+payload shape, 410→gone, 404→gone, other→error).
- Boot-safety proven (unset + malformed VAPID).
- Task 53 **code-review**: ship. Task 55 **security-review**: ship (no Critical/High/Medium; secret handling, fail-closed, injection, error-mapping all passed).

## NOT verified — needs the deployed origin + real devices (spec §11 Phase B matrix)
Web push needs HTTPS + (for iOS) a home-screen-installed PWA on `staff.drbartender.com`, so these can't be done on localhost:
- Chrome desktop subscribe + receive · Android Chrome subscribe + receive
- iOS Safari **not** installed → coachmark shows, toggles disabled · iOS Safari installed → permission flow works
- Push-only BEO nudge → push fires, no SMS · all-channels-off `beo_finalized` → critical override still sends SMS
- Simulated `410` → server prunes the subscription next attempt

---

## Deploy checklist (Dallas)
1. **Set VAPID env.** A keypair was generated this session and is in the local gitignored `.env` files. Set in dashboards:
   - **Render (server):** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_CONTACT_EMAIL` (private key is server-only).
   - **Vercel (client):** `REACT_APP_VAPID_PUBLIC_KEY` (= the public key).
   - The server boots + runs fine without these; push just stays dormant (`vapid_unset`). Set them whenever.
2. **Merge + push** from the `os` window: `git merge beo`, run the **full pre-push fleet in the foreground** (`consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`), then `git push origin main`.
3. **Post-deploy:** run the §11 Phase B device matrix above on real hardware.
4. **Closeout:** `npm run worktree:rm -- beo`, then the trunk-based switch (beo is the last worktree).

## ⚠️ node_modules note for closeout
`npm install web-push` in this worktree **replaced the shared `node_modules` junction with a real directory** (npm can't install into a symlink). `os/node_modules` is untouched and the husky junction is intact. After `git merge beo` in `os`, run **`npm install`** there so `os` picks up `web-push` (it's in `package.json`/lock now). The standalone `beo/node_modules` is removed by `worktree:rm`.

## Key docs
- Plan: `docs/superpowers/plans/2026-05-27-staff-portal-redesign-implementation.md` (Phase 11 = lines 2559–2725).
- Spec: `docs/superpowers/specs/2026-05-27-staff-portal-redesign-design.md` (§6.13 Notifications UI, §6.17 push infra, §11 Phase B matrix).
