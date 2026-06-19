# Staff Portal v2 + BEO — Project Tracker

**The contractor-facing portal + Banquet Event Order.** Living status doc for the
whole staff-portal redesign and the BEO feature: what is shipped, what is built
and awaiting deploy, and what is intentional backlog.

> **How to use this:** the status table is the source of truth for progress.
> The work was specced + planned in `docs/superpowers/specs/` and
> `docs/superpowers/plans/` and executed phase-by-phase in the `beo` worktree.
> Update the Status column as pieces ship. Decisions already locked live in the
> Decisions Log so we do not relitigate. Backlog at the bottom is the full
> deferred/declined set, verified against spec §13 (staff) and §14 (BEO).
>
> **Last updated:** 2026-06-04 · **Stage:** Phase A LIVE in prod; Phase 11 (push) built + merged to local `main`, **deploy pending**.

---

## Where things stand (TL;DR)

- **Phase A is live in production:** the new 4-tab staff portal (Home · Shifts ·
  Pay · Account), BEO embedded inside ShiftDetail, the drop/cover marketplace,
  and SMS + email notifications. The cutover (v2 mounted at root on
  `staff.drbartender.com`, old v1 fragments deleted) shipped and is the
  production staff site.
- **Phase 11 (push notifications / "Phase B") is built and merged to local
  `main` but NOT pushed.** web-push + VAPID, service worker, iOS coachmark,
  permission state machine, boot-safe sender. Needs: VAPID env in Render/Vercel,
  the pre-push fleet, push, then an on-device verification pass.
- **The Apothecary Press design system is in place** (`--sp-` tokens in
  `index.css`); the portal is skin-aware (light/dark).
- **One genuine half-built thing:** the paystub PDF (download + email-a-copy are
  stubbed "coming soon"; the PDF generation pipeline was never built). Next task.
- Everything below the line is **intentional backlog** (deferred v1.5 / declined),
  not unfinished work.

---

## Workstreams (status overview)

| # | Workstream | Status | Notes |
|---|---|---|---|
| 1 | BEO (Banquet Event Order) | **Live** | Embedded in ShiftDetail; T-3 unack nudge pipeline |
| 2 | Portal backend (`/api/me/*`, schema, payment methods) | **Live** | All reads/writes scoped to `req.user.id` |
| 3 | Drop / Cover marketplace | **Live** | `pay_period='processing'` guard protects payroll |
| 4 | Notification infrastructure (channels · dispatcher · SMS/email) | **Live** | Critical-path email fallback; SMS kill-switch mirrored in UI |
| 5 | Portal shell + Shifts + ShiftDetail | **Live** | StaffShell, 4-tab nav, deep-linkable shift/BEO |
| 6 | Pay + Tip Card | **Live (1 gap)** | Paystub PDF download/email stubbed — see Backlog |
| 7 | Account (Profile · Payment · Calendar · Notifications · Documents) | **Live** | Email-change flow, doc replace + history |
| 8 | Cutover (v2 → root) | **Live** | `getSiteContext` host gate; old paths redirect |
| 9 | Push notifications (Phase B) | **Built, deploy pending** | Merged to local `main` (`f0f4dcb`), unpushed |

**Status legend:** Live (in prod) · Built (deploy pending) · Live (1 gap) · Backlog · Declined.

**Build order (complete):** BEO + backend → shell + shifts → pay/tip → account →
cutover (Phase A, all live) → push (Phase B, built, deploy pending).

---

## Workstream detail

### 1 · BEO (Banquet Event Order)
The locked event order a bartender confirms. Lives **inside ShiftDetail** — no
standalone BEO route in the staff portal (the shift is the unit).

- [x] Schema: `drink_plans.finalized_at`/`finalized_by`, `shift_requests.beo_acknowledged_at`
- [x] `beoHandlers.js` — T-3 unack nudge scheduling, suppression, reanchor
- [x] `routes/beo.js` — `GET /api/beo/:proposalId` payload, `/logo` (staff-auth proxy), `POST /acknowledge`
- [x] Finalize / Unfinalize lifecycle + lock guards across `drinkPlans.js` + `drinkPlanConsult.js`
- [x] Suppression hooks on every shift-mutation path (cancel / unassign / deny / reschedule)
- [x] Admin DrinkPlanCard Finalize buttons + EventDetailPage "Confirmed [time]" pills
- [x] `team_roster` projection on the BEO payload
- **Decided:** SMS-only nudge; per-proposal-per-staffer dedup (`entity_type='proposal'` load-bearing).

### 2 · Portal backend
The `/api/me/*` surface + schema. Raw SQL, all scoped to `req.user.id` (no IDOR).

- [x] Schema adds: `ui_preferences`, `staff_notification_preferences` (+ `push_subscriptions[]`), `token_version`, `last_ics_fetch_at`, `zelle_handle`, cover/drop + `replaced_by_request_id` on `shift_requests`, `staff_document_history`, `staff_audit_log`, `pending_email_changes`
- [x] `staffPortal.js` (+ `paymentMethods.js`, `payouts.js`, `accountReads.js`), `emailChange.js`, `adminCoverSwaps.js`
- [x] Endpoints: staff-home, payment-methods, profile, calendar-settings, ui-preferences, staff-notifications, push-subscriptions, documents/replace, email-change request/cancel/confirm, payouts
- [x] Bank PII (routing/account) AES-256-GCM via `encryption.js`

### 3 · Drop / Cover marketplace
Self-serve shift drops + teammate cover, with a money-path guard.

- [x] drop / request-cover / claim-cover / emergency-drop / withdraw
- [x] `coverBroadcast.js` (chunked SMS) + `coverApprovalCascade.js`
- [x] `pay_periods.status='processing'` guard rejects drop/cover during payout settlement (409); emergency-drop bypasses by design (admin resolves)
- [x] `<72h` = emergency: requires reason, management pinged by email + SMS, resolved manually
- [x] auth `suspended` deny + `dropped_at` filters

### 4 · Notification infrastructure
Three channels (push / sms / email) per category, resolved server-side.

- [x] `notificationChannelResolver.js` — per-category channel set, kill-switch suppression, critical-path override
- [x] `scheduledMessageDispatcher.js` — dispatch loop, suppression, sibling-cascade dedup, **push channel routing + 410-prune**
- [x] Critical categories (`beo_finalized`, `schedule_change`, `payday`) keep an email fallback — never silent-drop
- [x] SMS kill-switch (STOP/START via `smsInbound.js`) mirrored visually in the UI (strikethrough toggles), saved prefs preserved

### 5 · Portal shell + Shifts + ShiftDetail
The 4-tab frame and the shift surfaces.

- [x] `StaffShell.js` / `StaffShellWithThemeWiring.js`, user pill menu, `--sp-` tokens, light/dark skin
- [x] `HomePage.js`, `ShiftsPage.js`, `ShiftDetail.js` (BEO embedded), `DropCoverModal.js`, `BeoSections.js`, `TeamRosterCard.js`
- [x] Deep-linkable ShiftDetail (`request_id` in the projection) so SMS-link / refresh entries work
- **Decided:** BEO nudge links to `/shifts/:shiftId` (shiftId-keyed); `BeoByProposalRedirect` catches legacy `/events/:proposalId/beo` links.

### 6 · Pay + Tip Card
Earnings, payout detail, and the QR tip card.

- [x] `PayPage.js`, `PayoutDetail.js`, `PayoutEventRow.js`, `TipCardPage.js`, `formatMoney.js`
- [x] `GET /api/me/payouts` (list) + `/:periodId` (detail), IDOR-scoped, no PII
- [x] `publicTip.js` extension (Zelle handle in the allowlist, copy-handle + tip-card order)
- [ ] **Paystub PDF download** — button disabled "coming soon"; `paystub_storage_key` never generated (see Backlog #1)
- [ ] **Email-a-copy of paystub** — disabled "coming soon"

### 7 · Account
Profile / Payment methods / Calendar sync / Notifications / Documents.

- [x] `AccountPage.js` shell + sub-nav, `ProfileSection`, `PaymentMethodsSection` (+ `PaymentMethodRows`, `AddMethodModal`), `CalendarSyncSection`, `NotificationsSection`, `DocumentsSection` (+ `ReplaceConfirmModal`)
- [x] Email-change request → verify (`EmailVerifyPage.js`, handles logged-out confirm)
- [x] Doc replace (magic-byte validated → R2) + `staff_document_history`; alcohol-cert expiry date gate
- [x] Notifications matrix (8 categories × 3 channels), critical-path inline guard

### 8 · Cutover (v2 → root)
Swapped the new portal in as the live staff site.

- [x] StaffV2 mounted at ROOT on the `staff.` host (`RequirePortal`); old `/staff-v2/*` stub removed
- [x] Old v1 staff pages + `StaffLayout` deleted; old-path redirects in place
- [x] `Login.js` → `getHomePath(u)`; BEO nudge URL reconciled server-side
- [x] In-portal nav repointed off `/staff-v2` to root (the ship-blocker caught in review)

### 9 · Push notifications (Phase B) — built, deploy pending
- [x] `web-push` dep + VAPID env vars documented (Task 52)
- [x] Service worker `staff-sw.js` + `pushSubscribe.js` + **staff-scoped PWA manifest** (`staff-manifest.json` + `installStaffPwaMeta.js`, the iOS-install prerequisite the plan missed) (Task 53)
- [x] iOS coachmark + `PushPermissionBanner` (granted/default/denied/unsupported/iosNeedsInstall) + unlocked toggles + first-toggle subscribe (Tasks 54+56)
- [x] `pushSender.js` real web-push — **boot-safe** (VAPID unset/malformed never crashes) + 5 tests (Task 55)
- [x] code-review (Task 53) + security-review (Task 55): ship
- [ ] **Set VAPID env** — Render (`VAPID_PUBLIC_KEY`/`PRIVATE_KEY`/`CONTACT_EMAIL`) + Vercel (`REACT_APP_VAPID_PUBLIC_KEY`)
- [ ] **Push** (pre-push fleet → `git push origin main`)
- [ ] **On-device matrix** (§11 Phase B): Chrome desktop · Android Chrome · iOS installed/not · push-only nudge · critical override · 410-prune
- [ ] **Closeout:** `worktree:rm -- beo` + trunk-based switch (after merge `os` ran `npm install` for web-push)

---

## Decisions Log

- **Worktree-per-project, push is user-gated.** All staff-portal work ran in the
  `beo` worktree; merges happen in `os`; pushes are explicit-only. After this
  ships, dismantle the worktree workflow and return to trunk-based (`beo` is the
  last worktree).
- **BEO embeds in ShiftDetail.** No standalone BEO route in the staff portal; the
  shift is the unit a bartender thinks in. Nudge links to `/shifts/:shiftId`.
- **BEO nudge is SMS-only, dedup keyed `entity_type='proposal'`.** Per-proposal-
  per-staffer is what makes the multi-shift case one SMS, not N. Email channel
  deferred.
- **Notifications: three channels, critical-path never silent-drops.**
  `beo_finalized` / `schedule_change` / `payday` always retain ≥1 channel and
  fall back to email if SMS is killed. STOP/START kill-switch is mirrored, not
  auto-flipped.
- **Push is Phase B (v1.5-class), shipped after Phase A.** Phase A runs on SMS +
  email; push is purely additive. Sender fails closed (`vapid_unset`) and never
  crashes boot.
- **Drop/cover protects payroll.** The `pay_period='processing'` guard blocks
  re-composition during settlement; `<72h` emergency routes to management manually.
- **Money is integer cents; hosted-bartender 1:100 ratio honored.** Bank PII is
  AES-256-GCM, fails closed in prod.
- **PWA install is the iOS path.** No app-store packaging; iOS push requires a
  home-screen-installed standalone PWA — a staff-host-only manifest + Apple meta
  enable it. A first-class install prompt is v1.5.
- **Paystub PDF deferred (next task).** The Pay page ships read-only earnings; the
  downloadable PDF artifact is the next build.

---

## Backend anchors (so we do not re-derive each session)

- **Auth:** JWT, `req.user.role` for admin/manager guards; every `/api/me/*`
  endpoint scoped by `req.user.id`. Public token routes (BEO logo is staff-auth,
  not token).
- **Routes:** `server/routes/staffPortal.js` (+ `staffPortal/paymentMethods.js`,
  `payouts.js`, `accountReads.js`), `emailChange.js`, `adminCoverSwaps.js`,
  `routes/beo.js`.
- **Notification utils:** `scheduledMessageDispatcher.js` (dispatch + push channel
  `dispatchPushRow`), `notificationChannelResolver.js`, `pushSender.js`,
  `beoHandlers.js`, `messageScheduling.js`, `coverBroadcast.js`.
- **Endpoints:** `/api/me/{staff-home, payment-methods, profile, calendar-settings,
  documents, staff-notifications, push-subscriptions, payouts}`, `/api/beo/:proposalId`
  (+ `/logo`, `/acknowledge`), drink-plans finalize/unfinalize.
- **Schema (key adds):** `users.{ui_preferences, staff_notification_preferences
  (+push_subscriptions[]), token_version, zelle_handle}`, `shift_requests`
  cover/drop cols, `staff_document_history`, `staff_audit_log`,
  `pending_email_changes`, `scheduled_messages`.
- **Frontend:** `client/src/components/StaffShell*.js`,
  `client/src/pages/staff/*` (HomePage, ShiftsPage, ShiftDetail, PayPage,
  PayoutDetail, TipCardPage, `account/*`), `utils/pushSubscribe.js`,
  `utils/installStaffPwaMeta.js`, `public/staff-sw.js`, `public/staff-manifest.json`.
- **Env:** `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_CONTACT_EMAIL`
  (server) + `REACT_APP_VAPID_PUBLIC_KEY` (client). Server boots fine without
  them; push stays dormant.

---

## Invariants (load-bearing, do not violate)

- **Critical-path notifications never silent-drop.** `beo_finalized` /
  `schedule_change` / `payday` keep an email fallback even when SMS is killed
  (`notificationChannelResolver.js`, test-locked).
- **`pay_period='processing'` guard** blocks drop/cover re-composition during
  payout settlement. NULL-payout (future shift) proceeds; emergency-drop bypasses.
- **BEO nudge dedup is keyed `entity_type='proposal'`.** Changing it to `'shift'`
  re-introduces the duplicate-nudge bug across multi-shift coverage.
- **Push fails closed.** Missing/malformed VAPID → `{ok:false, error:'vapid_unset'}`,
  never an uncaught throw at module load.
- **Money is integer cents; hosted-bartender 1:100.** Only the first
  `staffing.required` bartenders are $0; over-ratio bartenders charge hourly +
  gratuity. Grep `isHostedPackage` before touching bartender pricing.
- **Bank PII is encrypted at rest** (AES-256-GCM, fails closed in prod). Every new
  `payment_profiles` read/write routes through `encryption.js`.
- **Event identity:** client name + event type are separate; display via
  `getEventTypeLabel`. Never an `event_name`.

---

## Backlog (deferred + declined) — full set

### Staff portal — deferred (build later)
1. **Paystub PDF download + email-a-copy** — *next task.* `PayoutDetail` buttons disabled "coming soon"; `paystub_storage_key` never written. Build: PDF generation → R2 → populate the key (likely at settlement) → enable the buttons.
2. **Admin-side BEO redesign** — lifecycle bar + nudge preview + activity log (per `admin-os/beo.jsx`).
3. **Bank-PII key-rotation runbook** — provision new key → re-encrypt rows → verify → retire old. v1.5.
4. **Plaid Link for direct-deposit onboarding** — replace manual routing/account entry. v1.5.
5. **First-class PWA install-prompt component** — v1 relies on the iOS coachmark. v1.5 if push adoption is slow.
6. **Notification quiet-hours UI** — `quiet_hours` JSON shape reserved, UI hidden in v1.
7. **"Connected calendars" multi-app sync** — v1 sets `calendar_subscribed_app` from a User-Agent heuristic.
8. **Admin DocumentsTab "Previous versions" expander** — surface `staff_document_history` on the admin user-detail tab.
9. **"Past BEOs" archive in the Documents tab** — removed in the redesign; small re-add if requested.
10. **Brand-kit row** — asset doesn't exist yet.

### Staff portal — declined (won't build)
Per-bartender Stripe Connect · in-portal direct chat with admin · post-event surveys/debriefs · shift-handoff notes between leads · time clock / clock-in · carpool coordination.

### BEO — deferred (build later)
1. **BEO PDF export / print stylesheet.**
2. **Email channel for the BEO nudge** — SMS-only ships; add if open rates demand.
3. **Per-staffer ack-channel column** on `shift_requests` — v1 just shows the time.
4. **BEO version history** — Unfinalize→Finalize loop is the v1 escape hatch.
5. **Acknowledgment expiry** — re-ack if event >30 days out and the BEO changed.
6. **Force re-nudge admin button** on EventDetailPage — resets one row to pending; closes the "Unfinalize then Finalize with a prior *sent* row" dead-end.
7. **StaffShell BEO badge** — "BEO awaiting confirmation: N" in the nav.
8. **SMS-spend threshold trigger** — shorter body / URL shortener if Twilio spend on nudges grows.
9. **Tri-state ack pill on admin** — add "Opted out (SMS disabled)" for STOPped staffers.
10. **User-keyed `drinkPlanWriteLimiter`** — today falls back to `req.ip`, bucketing all office admins together.
11. **Generic admin "BEO retry" surface** — list `scheduled_messages` with status filters.

### BEO — declined
"View BEO" link from the staff WhatsApp group flow (wrong channel).

### Acknowledged tech-debt (deferred fixes, not features)
- Refinalize-after-Unfinalize race guarded by admin-click serialization, not at the DB level (v1).
- Generic `PUT /api/shifts/:id` cancellation bypasses the broader `shift_reminder` / `staff_thank_you` suppression normalization (BEO suppression added; the old back-door path not normalized).
- The suppression subquery assumes one shift mutation per handler call; a future batch-cancel endpoint would leave stale `approved` rows counting against suppression.

### Verification debt
- Phases 8–9 surfaces (Pay / Tip / Account) got limited responsive + **no formal a11y pass**; a loading/empty/error sweep was flagged but not done.
- Production-watch (§12): drop/cover money path, notification critical-override, push 410 lifecycle, Twilio cover-broadcast rate limiting under load.

---

## Reference artifacts

- **Plan (PRIMARY):** `docs/superpowers/plans/2026-05-27-staff-portal-redesign-implementation.md` (Tasks 1–56; Phase 11 = lines 2559–2725).
- **Spec:** `docs/superpowers/specs/2026-05-27-staff-portal-redesign-design.md` (§6.13 Notifications, §6.17 push, §9 phasing, §11 verification, §13 out-of-scope).
- **BEO plan:** `docs/superpowers/plans/2026-05-26-beo-implementation.md` · **BEO spec:** `docs/superpowers/specs/2026-05-25-beo-design.md` (§14 out-of-scope).
- **Review-fix plan:** `docs/superpowers/plans/2026-05-31-staff-portal-review-fixes.md`.
- **Deploy checklist:** `HANDOFF.md` in the `beo` worktree.
- **Design source:** `C:\Users\dalla\Downloads\Dr Bartender (6)\staff\` (`app.jsx`, `account.jsx`, `details.jsx`, `data.jsx`, `icons.jsx`, `styles.css`).
