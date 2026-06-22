# Thumbtack Email Harvester — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-populate `clients.email` for Thumbtack-originated clients. The lead webhook flags new email-less clients `pending`; a Playwright agent on the always-on box reads the customer email off the Thumbtack "create price estimate" page (the only place it's exposed) and reports it back; the server sets `clients.email` so proposals + the drip just have it. Email-only — auto-proposal generation is deferred (seam only).

**Architecture:** `os` adds a dedicated, secret-authed router `server/routes/thumbtackAgent.js` (three routes: `pending-harvest` work queue, `email-harvested` writeback, `harvest-failed` outcome report) mounted at `/api/admin/thumbtack`, plus a one-line seeding change to the existing webhook. The box runs a separate in-repo project `thumbtack-agent/` (Playwright, persistent logged-in Chrome, `systemd`+`Xvfb`). Email state lives on the already-merged `clients.email_harvest_*` columns + one new `email_harvest_attempts` counter.

**Tech Stack:** Node.js 18+ / Express 4.18 / PostgreSQL (raw SQL via `pg`) / `crypto` (timing-safe secret compare) / `@sentry/node` (observability) / `node:test` (server tests) / Playwright (agent) / `systemd` + `Xvfb` (box runtime).

**Spec:** `docs/superpowers/specs/2026-06-16-thumbtack-email-capture-design.md` (v3)

> **Worktree:** all `os` work happens on branch `thumbtack-harvester` in its own worktree — `npm run worktree:new -- thumbtack-harvester` from the `os` folder, then drive `..\worktrees\thumbtack-harvester`. Never commit to `main`. Merge + push from `os` when verified. The `thumbtack-agent/` dir is committed to the repo but is **box-only** — it is not in `render.yaml` and is not deployed to Render.

---

## Review fixes folded in (2026-06-22, /review-spec + /review-plan)

Fresh design-fleet pass before build. Apply these as each task is executed:

- **Task 1:** the schema `email_harvest_*` block is at `schema.sql:2341-2364` (not ~2206). Append the new `email_harvest_attempts` column right after it.
- **Task 2:** real anchors are `BEGIN` at `thumbtack.js:233`, `findOrCreateClient` at 249 (returns a numeric id or null), `COMMIT` at 275. The `if (clientId)` guard is correct.
- **Task 3:** add the `THUMBTACK_AGENT_SECRET` and `HARVESTER_ENABLED` lines to `.env.example` HERE, not at Task 9. `safeEqual` is module-private (`thumbtack.js:29-33`; the file exports only `router`/`__setDeps`/`extractGuestCount`), so EXTRACT it to `server/utils/secrets.js`. Drop the "or duplicate it" option.
- **Task 4:** lease via a single `UPDATE ... RETURNING negotiation_id` (atomic select plus lease), not SELECT then UPDATE.
- **Task 5:** agent write-guard is a single guarded `UPDATE ... WHERE id=$1 AND email_harvest_status='pending' AND email IS NULL RETURNING` (check rowCount). **Admin-path collision is a recoverable 409 inline error, NOT `failed` plus alert** (that stays agent-only). Admin override writes a `logAdminAction` audit row. Wrong-address predicate pinned (pro domain, `ADMIN_EMAIL`, any ACTIVE `users.email` — all roles internal: staff/manager/admin, there is NO 'bartender' role; active = onboarding_status NOT IN deactivated/rejected/suspended). The `client_no_email` literal is thrown at `marketingHandlers.js:335` (citation fix). Add a code comment that the re-arm matches the BARE `error_message='client_no_email'` value (do not "fix" it to `LIKE 'suppressed:%'`).
- **Correction path:** an admin email correction on ClientDetail shares the re-arm helper, so a corrected address re-arms suppressed drip touches.
- **Task 8:** target `client/src/pages/admin/ClientDetail.js` and reuse the existing email field (no second editor). `ClientDrawer.js` does not exist. Mirror the full server validation predicate client-side. Cover loading/disabled/error states plus the `already_set` and `not_pending` responses.
- **Task 10:** the `thumbtack-agent/` tests run via their OWN runner. The repo `npm test` is `server/**` only.
- **Build shape:** executed as ONE sequential lane (server-first 1 to 7, then 8, then 10 to 12), so there is no multi-lane front-matter graph.

---

## File structure

**Create:**
- `server/routes/thumbtackAgent.js` : the dedicated router — `agentOrAdminAuth` middleware, `GET /pending-harvest`, `POST /email-harvested`, `POST /harvest-failed`, the targeted drip re-arm helper.
- `server/routes/thumbtackAgent.test.js` : integration tests against real Postgres via `pool`.
- `thumbtack-agent/package.json`, `thumbtack-agent/src/index.js` (poll loop), `thumbtack-agent/src/extract.js` (pure extraction), `thumbtack-agent/src/extract.test.js`, `thumbtack-agent/.env.example`, `thumbtack-agent/README.md`, `thumbtack-agent/systemd/thumbtack-agent.service`.

**Modify:**
- `server/db/schema.sql` : append one idempotent `ADD COLUMN` (`clients.email_harvest_attempts`).
- `server/routes/thumbtack.js` : seed `email_harvest_status='pending'` in the existing lead transaction.
- `server/index.js` : mount the new router; startup check for `THUMBTACK_AGENT_SECRET`.
- `server/utils/adminNotifications.js` (or wherever `notifyAdminCategory` lives) : reuse the existing "Failed Thumbtack email harvest" notification path (confirm category name).
- Client lead/client-detail surface for manual paste — confirm exact file at build (candidates: `client/src/components/adminos/drawers/ClientDrawer.js`, `client/src/pages/admin/ClientDetail.js`).
- `.env.example`, `CLAUDE.md`, `README.md`, `ARCHITECTURE.md` : per the Mandatory Documentation Updates table.

---

## Execution review checkpoints

Run AFTER the task's commit, BEFORE the next task. Advisory; a blocker stops progress.

| After task | Run agents | Why |
|---|---|---|
| 1 (schema) | `database-review` | New column, idempotency |
| 2 (webhook seeding) | `code-review` + `consistency-check` | Write inside the hot lead transaction |
| 3 (router + auth) | `security-review` | Timing-safe compare, fail-closed, IDOR posture |
| 5 (email-harvested + drip re-arm) | `security-review` + `code-review` + `database-review` + `consistency-check` | Write-guards, collision no-merge, tx boundaries, `scheduled_messages` after-commit side effect |
| 6 (failed→pending admin endpoint) | `security-review` | New admin-auth state-changing endpoint |
| 7 (harvest-failed) | `code-review` | Attempt accounting, alert paths |
| 8 (manual-paste UI) | `ui-ux-review` + `code-review` | Loading/empty/error states, validation parity |
| 9 (docs) | none | Doc-only |
| 10–11 (agent code) | `code-review` | Extraction correctness, secret handling, never-submit |
| 12 (box deploy) | none (ops) | Live dry-run validation instead |

Final gate after Task 12: `/review-before-deploy` (all six in parallel) before the push.

---

## Task 1: Schema — attempt counter

**Files:** Modify `server/db/schema.sql` (append near the existing `email_harvest_*` block, ~line 2206).

- [ ] **Step 1:** Append:
```sql
-- ─── Thumbtack email harvester (2026-06-16): attempt counter ──────
-- Separates failure-count (this) from lease/cooldown (email_harvest_attempted_at).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS email_harvest_attempts INTEGER NOT NULL DEFAULT 0;
```
- [ ] **Step 2:** Restart the dev server (schema reapplies on boot); confirm no ALTER error.
- [ ] **Step 3:** Verify via the Node-through-`pool` one-liner that `clients.email_harvest_attempts` exists, `integer`, default 0.
- [ ] **Step 4:** `git commit -m "feat(thumbtack-harvester): add clients.email_harvest_attempts counter"`

**Revert:** `ALTER TABLE clients DROP COLUMN email_harvest_attempts;`

---

## Task 2: Webhook seeding

**Files:** Modify `server/routes/thumbtack.js` (lead handler, inside the existing `BEGIN/COMMIT`, after `findOrCreateClient` ~line 243).

- [ ] **Step 1:** `findOrCreateClient` returns a numeric `client_id` (or `null` when both name and phone are absent — `thumbtack.js:235-243`). Guard on a truthy `clientId`, then run a guarded update so a client that already has an email stays `not_needed`:
```js
if (clientId) {
  await dbClient.query(
    `UPDATE clients SET email_harvest_status='pending'
     WHERE id=$1 AND email IS NULL AND email_harvest_status='not_needed'`,
    [clientId]
  );
}
```
- [ ] **Step 2:** Tests (`thumbtack.js` test, or co-located): new lead with null email → client `pending`; lead matched to a client that already has email → `not_needed`; null `clientId` → no error, no write.

> Note: once this ships, new email-less leads start accumulating `pending` rows in the shared Neon DB with **no drainer until Task 4** lands. Harmless (the agent isn't running yet), but expected.
- [ ] **Step 3:** `git commit -m "feat(thumbtack-harvester): flag new email-less leads pending for harvest"`

---

## Task 3: Router shell + auth + mount

**Files:** Create `server/routes/thumbtackAgent.js`; modify `server/index.js`.

- [ ] **Step 1:** `agentOrAdminAuth` middleware — pass if a valid admin/manager JWT (reuse the existing `auth`+role check) OR header `x-thumbtack-agent-secret` equals `process.env.THUMBTACK_AGENT_SECRET`, compared timing-safely. **Note:** `safeEqual` is module-private in `thumbtack.js` (only `router` is exported) — **first extract it to a shared util** (e.g. `server/utils/secrets.js`) and import from both, or duplicate the `crypto.timingSafeEqual` wrapper. **Fail closed in every env** if the secret is unset on the machine path (do NOT mirror `verifyWebhook`'s warn-and-allow-in-dev). Add a `webhookLimiter`-style rate limit; the `pending-harvest`/`harvest-failed` routes are secret-only.
- [ ] **Step 2:** Mount at `/api/admin/thumbtack` in `server/index.js` (its OWN router — not the `verifyWebhook` one). Add a startup check that logs a clear warning if `THUMBTACK_AGENT_SECRET` is unset (routes fail closed regardless).
- [ ] **Step 3:** Tests: 401 on missing/wrong secret in all envs; admin-JWT path allowed; timing-safe compare used.
- [ ] **Step 4:** `git commit -m "feat(thumbtack-harvester): agent router + fail-closed secret/admin auth"`

---

## Task 4: `GET /pending-harvest`

**Files:** Modify `server/routes/thumbtackAgent.js` (+ tests).

- [ ] **Step 1:** Query: clients where `email_harvest_status='pending'` AND `email IS NULL` AND (`email_harvest_attempted_at IS NULL` OR `< now() - $cooldown`), with an **explicit `ORDER BY email_harvest_attempted_at NULLS FIRST, id`** (fresh rows have null `attempted_at`; the index can't order them without a tiebreaker), limit `N` (default 25). Join `thumbtack_leads` for the client's **latest** `negotiation_id`; exclude clients whose only lead is terminal `thumbtack_leads.status IN ('converted','lost')`. Return `[{ negotiation_id }]`. (`idx_clients_email_harvest_pending` covers the `status='pending'`+`attempted_at` part; the `email IS NULL` and the join are not index-covered — fine at this volume.)
- [ ] **Step 2:** **Lease** each returned row: `UPDATE clients SET email_harvest_attempted_at=now() WHERE id = ANY($ids)` (does NOT touch `email_harvest_attempts`).
- [ ] **Step 3:** Server kill-switch: if `process.env.HARVESTER_ENABLED === 'false'`, return `[]`.
- [ ] **Step 4:** Tests: filter + cooldown + lease stamping (attempts unchanged); terminal-status exclusion; kill-switch returns `[]`.
- [ ] **Step 5:** `git commit -m "feat(thumbtack-harvester): pending-harvest work queue with lease + kill-switch"`

---

## Task 5: `POST /email-harvested` (writeback + after-commit drip re-arm)

**Files:** Modify `server/routes/thumbtackAgent.js` (+ tests). The drip re-arm ships in **this** commit — it is the after-commit tail of the same handler, one logical feature.

- [ ] **Step 1:** Body `{ negotiation_id, email }`. Validate format; lowercase; bound length. **Wrong-address guards:** reject (400) if domain is the pro domain, OR email == `ADMIN_EMAIL`, OR matches a staff/admin `users.email` (define the predicate at build — likely `role IN ('admin','manager','bartender')`; confirm whether there's a separate active/onboarding flag to honor).
- [ ] **Step 2:** Use `pool.connect()` + `BEGIN/COMMIT` (+ savepoints — dedup helpers issue `SAVEPOINT` on the caller's client). Resolve `client_id` from `thumbtack_leads.negotiation_id`; not found → **404** `{status:'lead_not_found'}`.
- [ ] **Step 3:** Write logic:
  - Client already has email → **200** `{status:'already_set'}`; set `harvested` only if it was `pending`.
  - Agent path + status not `pending` → **409** `{status:'not_pending'}` (admin-JWT path may override any status).
  - Email free → `UPDATE clients SET email=$1, email_harvest_status='harvested', email_harvest_attempted_at=now() WHERE id=$2` → **200** `{status:'set'}`.
  - UNIQUE collision (email on a different client) → set this client `failed`, fire the failed-harvest alert (`notifyAdminCategory({ category:'routine_thumbtack', ... })`), **409** `{status:'collision'}`. **No `mergeClients`, no email stamped on either client.**
- [ ] **Step 4: After-commit targeted drip re-arm.** Best-effort / non-blocking, on its **own pooled connection after COMMIT** (never inside the tx). For this client's open proposals, flip only future suppressed `client_no_email` touches back to `pending` — do **NOT** call `scheduleDripForProposal` (it re-inserts all six touches re-anchored to `now()`):
```sql
UPDATE scheduled_messages SET status='pending'
WHERE entity_type='proposal' AND entity_id = ANY($1)
  AND status='suppressed' AND error_message='client_no_email'
  AND scheduled_for > now();
```
(`scheduled_messages` is keyed `entity_type`/`entity_id` — there is no `proposal_id` column; the suppression reason is stored in `error_message`, value `client_no_email`, per `scheduledMessageDispatcher.js:638-644`.) Past-window / ineligible-proposal touches are logged as terminally missed.
- [ ] **Step 5:** Observability: one log line per outcome (`negotiation_id` + status, never the email); Sentry breadcrumb on `collision`/`lead_not_found`/`failed`.
- [ ] **Step 6:** Tests: set; already_set (no `not_needed`→`harvested` downgrade); not_pending 409; collision 409 + failed + no-merge + no-stamp; lead_not_found 404; each wrong-address guard 400; admin override sets a `failed` row. **Re-arm:** future suppressed `client_no_email` rows → `pending`; past rows untouched; other `error_message`s untouched; runs after commit; NOT triggered when the email preceded the proposal (no suppressed rows).
- [ ] **Step 7:** `git commit -m "feat(thumbtack-harvester): email-harvested writeback + collision-as-failed + after-commit drip re-arm"`

---

## Task 6: `failed → pending` admin re-arm endpoint

**Files:** Modify `server/routes/thumbtackAgent.js` (+ tests).

(The drip re-arm moved into Task 5 — it's the after-commit tail of `email-harvested`, one feature/commit. This slot is now the admin control the spec requires to put a `failed` lead back in the agent queue — a distinct state-changing endpoint that earns its own `security-review`.)

- [ ] **Step 1:** `POST /api/admin/thumbtack/rearm { negotiation_id }` — **admin-JWT only** (not the agent secret). Resolve `client_id` from `negotiation_id`; if `email_harvest_status='failed'` → set `email_harvest_status='pending'`, `email_harvest_attempts=0`, `email_harvest_attempted_at=NULL` (clears cooldown so the agent re-picks it). Return new state; **404** if no such lead, **409** if not `failed`.
- [ ] **Step 2:** Tests: `failed → pending` zeroes attempts + clears `attempted_at`; non-`failed` → 409; agent-secret-only caller (no JWT) rejected; admin allowed.
- [ ] **Step 3:** `git commit -m "feat(thumbtack-harvester): admin re-arm endpoint for failed harvests"`

---

## Task 7: `POST /harvest-failed`

**Files:** Modify `server/routes/thumbtackAgent.js` (+ tests).

- [ ] **Step 1:** Body `{ negotiation_id, reason }`, `reason ∈ {render_timeout, navigation_error, lead_not_found, ambiguous, session_expired}`. All alerts below go through `notifyAdminCategory({ category:'routine_thumbtack', ... })`.
  - `session_expired` → fire re-login admin alert; do NOT change `attempts`/status.
  - `ambiguous` → `email_harvest_status='failed'` + alert (terminal).
  - `render_timeout|navigation_error|lead_not_found` → `email_harvest_attempts = email_harvest_attempts + 1`; if `>= MAX_ATTEMPTS` → `failed` + alert; else stay `pending`.
- [ ] **Step 2:** Tests: increment + cap→failed+alert; ambiguous immediate failed; session_expired alert with no count change.
- [ ] **Step 3:** `git commit -m "feat(thumbtack-harvester): harvest-failed outcome reporting + retry cap"`

---

## Task 8: Manual-paste admin UI (may fast-follow)

**Files:** Modify the confirmed client lead/client-detail component (+ `client/src/utils/api.js` calls). UI-only — the server endpoints it calls already exist (Task 5 `email-harvested`, Task 6 `rearm`).

- [ ] **Step 1:** A paste-email form on the Thumbtack lead/client detail → `POST /email-harvested` (admin-JWT path). States: disabled submit while posting; client-side validation mirroring the server (format + reject pro-domain/staff with inline copy); success toast on `set`/`already_set`; inline errors for `collision`/`lead_not_found`/400.
- [ ] **Step 2:** A "retry harvest" button on `failed` leads → calls the Task 6 `POST /rearm` endpoint; on success show the lead returned to the queue.
- [ ] **Step 3:** `git commit -m "feat(thumbtack-harvester): admin manual-paste + retry-harvest UI"`

---

## Task 9: Docs

**Files:** Modify `.env.example`, `CLAUDE.md`, `README.md`, `ARCHITECTURE.md`.

- [ ] `.env.example` + `CLAUDE.md` env table + `README.md` env mirror: `THUMBTACK_AGENT_SECRET`, `HARVESTER_ENABLED`.
- [ ] `README.md` folder tree: `server/routes/thumbtackAgent.js`, `thumbtack-agent/`. `ARCHITECTURE.md` route table: the three `/api/admin/thumbtack/*` routes; Thumbtack integration section gains the harvester flow; Database Schema gains `clients.email_harvest_attempts`.
- [ ] `git commit -m "docs(thumbtack-harvester): env vars, routes, schema, harvester flow"`

---

## Task 10: Agent — scaffold + extraction module

**Files:** Create `thumbtack-agent/package.json`, `src/extract.js`, `src/extract.test.js`, `.env.example`, `README.md`.

- [ ] **Step 1:** Scaffold the project (Playwright dep). Config loader reads the env vars from the spec (`API_BASE_URL`, `THUMBTACK_AGENT_SECRET`, pacing, `MAX_ATTEMPTS`, `COOLDOWN_MS`, `CHROME_PROFILE_DIR`, `PRO_EMAIL_OVERRIDE`, `HARVESTER_ENABLED`).
- [ ] **Step 2:** `extract.js` — pure function over a page's HTML/DOM: read pro email from `__NEXT_DATA__.props.pageProps.nextBaseProps.user.email` (or `PRO_EMAIL_OVERRIDE`); collect rendered emails; exclude the pro's → exactly one ⇒ customer, zero ⇒ `render_timeout`, >1 ⇒ `ambiguous`. No hashed-class selectors.
- [ ] **Step 3:** Unit tests against saved HTML fixtures: pro-only, customer+pro, ambiguous, none.
- [ ] **Step 4:** `git commit -m "feat(thumbtack-agent): scaffold + selector-free email extraction"`

---

## Task 11: Agent — navigation, reporting, dry-run

**Files:** Create `thumbtack-agent/src/index.js`.

- [ ] **Step 1:** `launchPersistentContext({ userDataDir })`, headful. Poll `GET /pending-harvest`; for each `negotiation_id`: navigate to `…/priceestimate/create/<id>`; **login-check** (redirect → `POST /harvest-failed {reason:'session_expired'}` + stop batch); else `waitForFunction` for a non-pro email; success → `POST /email-harvested`, else `POST /harvest-failed` with the reason. Jittered delays, `DAILY_CAP`, `HARVESTER_ENABLED` gate. **Never** submits the form.
- [ ] **Step 2:** `--dry-run`: extract + log the **masked** email **and** the handed `negotiation_id` next to the page's trailing URL id (so the operator can eyeball the `negotiation_id == URL id` equality the writeback depends on), no POST.
- [ ] **Step 3:** `git commit -m "feat(thumbtack-agent): poll loop, navigation, outcome reporting, dry-run"`

---

## Task 12: Box deployment + live dry-run

**Files:** `thumbtack-agent/systemd/thumbtack-agent.service`; box-side ops (no repo deploy).

- [ ] **Step 1:** On the box (`192.168.0.93`, over RDP): the manual login MUST populate the **same** profile Playwright uses. Launch **Chromium via the Playwright `userDataDir` / `CHROME_PROFILE_DIR` under the agent's Xvfb display** (e.g. a one-off `node` script calling `launchPersistentContext({ userDataDir, headless:false })`, or `npx playwright ... --user-data-dir=...`) — **not** stock desktop Chrome (a normal desktop login does NOT write the Playwright profile). **Log into Thumbtack manually** in that window (no automated login). This human-login → Playwright-profile bridge is the single biggest live-run risk; verify the saved session by re-launching the agent and confirming it lands authenticated.
- [ ] **Step 2:** Install the `systemd` unit running the agent under `Xvfb`; enable it; set the box `.env`.
- [ ] **Step 3:** **Live dry-run against one real lead** — this confirms the spec's open item: the price-estimate URL trailing id **equals** the stored `negotiation_id`. If they differ, stop and adjust the URL construction before any live writeback.
- [ ] **Step 4:** Flip from `--dry-run` to live; watch one real harvest land `clients.email` + `harvested`.

---

## Final task: Verify + deploy gate

- [ ] Run the full server test suite (`npm test` per repo) — all green.
- [ ] From the `os` integration window: `git merge thumbtack-harvester`.
- [ ] Run `/review-before-deploy` (all six agents) as the pre-push gate. Resolve any blocker per the root-cause discipline. Push is user-initiated only.

---

## Spec coverage self-check

| Spec v3 item | Task |
|---|---|
| `email_harvest_attempts` column | 1 |
| Webhook seeds `pending` (guarded, in-tx) | 2 |
| Dedicated router, timing-safe + fail-closed auth, own mount | 3 |
| `pending-harvest` queue + lease + cooldown + terminal-status exclusion + kill-switch | 4 |
| `email-harvested` writeback + wrong-address guards + write-guard + collision-as-failed (no merge/stamp) + HTTP codes | 5 |
| After-commit targeted drip re-arm (future-only, no resend) | 5 |
| `failed → pending` admin re-arm endpoint | 6 |
| `harvest-failed` + attempt cap + ambiguous/session_expired handling | 7 |
| Manual-paste UI + retry-harvest button | 8 |
| Docs (env, routes, schema, flow) | 9 |
| Agent extraction (non-pro email, selector-free) | 10 |
| Agent navigation/reporting + `--dry-run` masking + never-submit | 11 |
| Box runtime (systemd/Xvfb/persistent login) + confirm `negotiation_id == URL id` | 12 |
| Auto-proposal generation | Deferred (seam only) — not in this plan |
| Historical backfill | Deferred (optional) — not in this plan |
