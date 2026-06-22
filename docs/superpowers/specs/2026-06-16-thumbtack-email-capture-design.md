# Thumbtack Lead Email Harvester

**Date:** 2026-06-16
**Status:** Design v3.1 — revised after two `/review-spec` passes + reconciliation
with `2026-05-20-automated-communication-design.md`, then patched after `/review-plan`
(re-arm SQL column names, alert category, test harness). Build-ready.
**Author:** Dallas + Claude

## Review fixes folded in (2026-06-22, fresh /review-spec + /review-plan)

A full design-fleet re-review of this combined spec and its plan (run after the binding/render/extraction de-risk passed live) surfaced the following, mostly at the agent / manual-paste seam. All are folded into the build:

1. **Collision is agent-only harsh.** The `failed` + alert + no-stamp reaction applies to the AGENT path. On the **admin manual-paste** path, a collision returns a recoverable inline error ("that email already belongs to another client"), matching the existing client-email editor (`clients.js`). No `failed`, no alert.
2. **Manual-paste UI lives on `client/src/pages/admin/ClientDetail.js`**, reusing the existing client-email field. Do NOT build a second email editor. The retry-harvest button lives there too. Client-side validation mirrors the FULL server predicate (pro domain, `ADMIN_EMAIL`, active `users.email`).
3. **Wrong-email correction re-fires the drip re-arm.** An admin email correction shares the same after-commit re-arm helper, so fixing a bad or late address re-arms suppressed `client_no_email` touches. Otherwise they stay terminally missed.
4. **Wrong-address predicate, pinned:** reject if the email domain is the pro domain, OR the email equals `ADMIN_EMAIL`, OR it matches any ACTIVE `users.email`. Every `users.role` is internal (`staff`, `manager`, `admin` — there is NO `bartender` role; bartenders are `staff`), so any active user is a wrong-address. "Active" = `onboarding_status NOT IN ('deactivated','rejected','suspended')`, so ex-staff who may now be real customers are allowed. Same predicate on server and client.
5. **Race-safety:** the `pending-harvest` lease and the `email-harvested` agent write-guard are each a single guarded `UPDATE ... RETURNING` (rowCount checked), never read-then-write.
6. **Admin-override audit:** the admin path stamping `clients.email` writes a `logAdminAction` row (`adminAuditLog.js`), not just a log line.
7. **mergeClients rationale corrected** (in the body below): the real reason not to auto-merge is that silently cross-linking two clients' financial FKs on an unverifiable scraped string would corrupt real records. It is NOT about orphaning (mergeClients repoints FKs before deleting).
8. **Re-arm scope is explicit:** it flips only `status='suppressed'` with `error_message='client_no_email'`. The `suppressed_by_sibling` and `dead_letter` rows are knowingly left alone.
9. **Agent secret stays out of Sentry** (already true: `index.js` drops all request headers; keep it that way).

## Problem & Goal

Thumbtack leads arrive via the existing webhook (`server/routes/thumbtack.js`):
name + phone + `negotiation_id`, but **never an email**. We have no Thumbtack
API access. The email is reliably present in the Pro web UI on the "create price
estimate" page, gated behind a couple of clicks and loaded client-side
(Apollo/GraphQL).

That missing email is load-bearing: proposals read the recipient as
`c.email AS client_email` and sending is gated on it (`actions.js:81`,
`if (!proposal.client_email)`); the unsigned-proposal drip
(`scheduleDripForProposal`, `marketingHandlers.js`) needs the same field.

**Goal:** automatically populate `clients.email` for Thumbtack-originated
clients so a proposal created for that client already has the address — no manual
lookup. This implements the **"Thumbtack email harvester"** designed (as a
deferred workstream) in `2026-05-20-automated-communication-design.md`
§1.1 / §8.8 / §9, scoped down and hardened against two `/review-spec` passes.

## Relationship to the Automated-Communication spec

**Reuse as-is (already merged):** `clients.email_harvest_status`
(`not_needed | pending | harvested | failed`, default `not_needed`),
`clients.email_harvest_attempted_at`, and the partial index
`idx_clients_email_harvest_pending` (`schema.sql:2205-2228`); the §8.8 contract
`POST /api/admin/thumbtack/email-harvested { negotiation_id, email }`. **All
harvester admin alerts** (failed harvest, collision, session-expired re-login)
reuse the existing `notifyAdminCategory` category **`routine_thumbtack`** — there
is no dedicated "Failed Thumbtack email harvest" category in
`adminNotifications.js` (the §6 reference is aspirational; reuse `routine_thumbtack`
or `system_error`).

**One new column (this spec):** `clients.email_harvest_attempts INTEGER DEFAULT 0`
— the review showed `email_harvest_attempted_at` cannot serve as lease, cooldown,
*and* attempt-count at once. `attempted_at` = lease/cooldown timestamp;
`attempts` = failure count for the retry cap. (Idempotent `ADD COLUMN`.)

**Deliberately deferred:** §8.8 also says the endpoint "triggers auto-proposal
generation." Auto-proposal is the larger Phase-5 workstream. **This spec stops at
populating `clients.email` + status.** Where §8.8 would trigger auto-proposal we
leave a documented one-call seam and do nothing. Proposal creation stays manual /
quote-wizard.

## Scope

In: webhook seeding (`pending`); `POST /email-harvested`; `GET /pending-harvest`
(work queue + lease); `POST /harvest-failed` (agent failure report); the
Playwright harvester on the box; manual-paste admin fallback (same `email-harvested`
endpoint, admin auth).

Out (non-goals): auto-proposal generation (seam only); marketing-list/`email_leads`;
multi-pro accounts; historical backfill of old `not_needed` rows (optional
admin-gated follow-up).

## Constraints & Why This Approach

1. **A real browser is required** — the email is not in the webhook, not in
   `__NEXT_DATA__`; Thumbtack loads it client-side (Apollo/GraphQL). A cookie-only
   fetch won't see it.
2. **No automated login** — the biggest bot-detection signal. Persistent
   logged-in Chrome profile; human logs in once over RDP.
3. **Read-only on Thumbtack** — only *open* the page; **never submit** the form.
4. **Low volume, human pace** — one at a time, jittered, daily cap, only `pending`
   rows. Kill-switch (agent-side env + server-side) to halt instantly. ToS /
   account-suspension exposure is owner-accepted (see Risk).

## Architecture

1. **`os` Express app (cloud / Render)** — webhook seeding change + three
   endpoints on a **dedicated router** (`server/routes/thumbtackAgent.js`), NOT
   the existing webhook router (which applies `router.use(verifyWebhook)` to every
   route — `thumbtack.js:66`).
2. **Harvester agent (always-on box, `192.168.0.93`)** — Node + Playwright,
   persistent logged-in Chrome profile, `systemd` service under `Xvfb`. In-repo
   under `thumbtack-agent/`, box-only (not deployed).

### Happy path

1. Lead webhook → existing handler creates/matches the `clients` row + inserts
   `thumbtack_leads` **(same transaction)**. New: if that client's email is null,
   set `email_harvest_status='pending'`. Because `pending` is set in the same
   commit that creates the client, the client always exists when it is `pending`
   — **no webhook-vs-poll race.**
2. Agent `GET /pending-harvest` → `negotiation_id`s for `pending`, email-null,
   past-cooldown clients. The query **leases** each returned row
   (`attempted_at=now()`), so an overlapping run won't re-hand it.
3. Agent opens `…/priceestimate/create/<negotiation_id>`, waits for an email
   other than the pro's own (`__NEXT_DATA__.props.pageProps.nextBaseProps.user.email`)
   to render.
4. Success → `POST /email-harvested`. Any non-success → `POST /harvest-failed`.
5. `email-harvested` sets `clients.email`, status `harvested`, **after commit**
   does the edge-case drip re-arm (below). Auto-proposal seam: no-op.

### Unhappy paths

- **Session expired** (login redirect): agent does NOT log in →
  `POST /harvest-failed {reason:'session_expired'}`. The server fires the
  "Failed Thumbtack email harvest" re-login alert and **does not** increment
  `attempts` (it's an environment problem, not a per-lead failure); the agent
  stops the batch. Resumes once re-logged-in.
- **Render timeout / navigation error / page 404 (`lead_not_found`)** →
  `POST /harvest-failed` with the reason → increments `attempts`; at
  `MAX_ATTEMPTS` → `failed` + alert; otherwise stays `pending`, cooldown via
  `attempted_at`. (Fixes v2's silent infinite `lead_not_found` loop.)
- **Ambiguous (>1 non-pro email)** → `harvest-failed {reason:'ambiguous'}` →
  `failed` immediately + alert (manual). Never guess.
- **Collision** (captured email already on another client) → server-detected in
  `email-harvested` → this client `failed` + alert, **no merge, email not stamped
  anywhere** (see Risk).

## Data Model

Reuse the merged `email_harvest_*` columns + index. **One idempotent addition:**

```sql
ALTER TABLE clients ADD COLUMN IF NOT EXISTS email_harvest_attempts INTEGER NOT NULL DEFAULT 0;
```

State machine (existing enum):

```
not_needed  ─ client already has email, or non-Thumbtack origin
pending     ─ Thumbtack client, email null, awaiting harvest      (work queue)
harvested   ─ email set successfully
failed      ─ ambiguous / collision / attempts exhausted → alert, manual
```

- `attempted_at` = lease + cooldown timestamp. `attempts` = failure counter
  (incremented only by `harvest-failed`, never by the lease).
- Existing rows default `not_needed` → no queue flood.
- **`failed` → re-arm is an explicit admin action:** an admin control sets
  `failed → pending` (and zeroes `attempts`) to put a lead back in the agent
  queue; manual paste (below) is the other resolution.

## Webhook Change (`server/routes/thumbtack.js`)

In the existing lead-insert transaction (`~219-264`), after `findOrCreateClient`
(which returns a numeric `client_id`, not a row — so do not read `.email` off it):

```sql
UPDATE clients SET email_harvest_status='pending'
WHERE id=$1 AND email IS NULL AND email_harvest_status='not_needed';
```

Guarded on `email IS NULL` so a matched client that already has an email stays
`not_needed`. Inside the existing `BEGIN/COMMIT`. This is the only handler change;
purely additive.

## Endpoint Specs

Dedicated router `server/routes/thumbtackAgent.js`, mounted at
`/api/admin/thumbtack`, with its **own** auth — not the global admin guard, not
`verifyWebhook`.

**`agentOrAdminAuth` middleware:** allow if EITHER a valid admin/manager JWT (for
the manual-paste UI) OR header `x-thumbtack-agent-secret` matching
`THUMBTACK_AGENT_SECRET` **compared with `crypto.timingSafeEqual`** (reuse the
existing `safeEqual`, `thumbtack.js:24-28`). **Fail closed in every environment**
if the secret is unset on the machine path (do not copy the webhook's
warn-and-allow-in-dev). Tight rate limit; alert on bursts. The `pending-harvest`
and `harvest-failed` routes are **agent-secret only** (no admin-JWT path).

### `POST /api/admin/thumbtack/email-harvested`

- Body `{ negotiation_id, email }`.
- Validate: `negotiation_id` non-empty; `email` valid, lowercased, length-bounded.
  **Wrong-address guards (server-side):** reject if the email's domain is the pro
  domain, OR the email matches `ADMIN_EMAIL`, OR it matches any active `users.email`
  (staff/admin). The agent's "non-pro email" pick is unverifiable server-side, so
  these guards are the backstop against a drifted pro-email read.
- Transaction (`pool.connect()` + `BEGIN/COMMIT` + savepoints — the dedup helpers
  issue `SAVEPOINT` on the caller's client, so `pool.query()` is wrong):
  1. `thumbtack_leads` by `negotiation_id` → `client_id`. Not found → **404**
     `{status:'lead_not_found'}` (agent treats as a countable failure via the
     normal `harvest-failed` accounting on its side; it does not loop forever).
  2. **Agent path write-guard:** only set the email when the client is currently
     `email_harvest_status='pending'` AND `email IS NULL`. If the client already
     has an email → **200** `{status:'already_set'}`, set status `harvested` only
     if it was `pending` (preserve `not_needed` provenance). If status isn't
     `pending` (e.g. `failed`) on the agent path → **409** `{status:'not_pending'}`
     (a leaked secret can't stamp arbitrary clients). **Admin path may override**
     any status (admin authority), including `failed → harvested`.
  3. Email free → `UPDATE clients SET email=$1, email_harvest_status='harvested',
     email_harvest_attempted_at=now()`. **200** `{status:'set'}`.
  4. Email already on a **different** client (UNIQUE `idx_clients_email_unique`):
     set this client `failed`, fire the failed-harvest alert, **409**
     `{status:'collision'}` (AGENT path only; the admin manual-paste path returns a
     recoverable inline error instead, see the Review-fixes section). **Do not** call
     `mergeClients`: silently cross-linking two clients' financial FKs on an
     unverifiable *scraped* email would corrupt real records. (Note `mergeClients`
     repoints the loser's FKs to the winner before deleting, so the lead is NOT
     orphaned; the real risk is the bad-match cross-link, not orphaning.)
     **Do not** stamp the email on either client — only flip status.
- **After COMMIT, best-effort, non-blocking — edge-case drip re-arm:** in the
  normal flow the email is set **before** the proposal exists, so the drip enrolls
  cleanly and **no re-arm is needed.** Re-arm only matters when a proposal was
  created/sent before the email arrived and its drip touches were terminally
  suppressed. Do **not** re-run `scheduleDripForProposal` (it would re-insert all
  six touches re-anchored to `now()` and re-send already-fired ones). Instead, run
  a **targeted in-place re-arm**:

  ```sql
  UPDATE scheduled_messages SET status='pending'
  WHERE entity_type='proposal' AND entity_id = ANY($1)   -- drip rows are keyed entity_type/entity_id (no proposal_id column)
    AND status='suppressed' AND error_message='client_no_email'  -- reason lives in error_message (no suppress_reason column)
    AND scheduled_for > now();             -- never resurrect a past-window touch
  ```

  Past-window or ineligible-proposal touches are accepted as terminally missed
  (logged, not resent). This is the corrected "drip works" fix.
- Observability: log one line per outcome with `negotiation_id` + `{status}`
  (never the email); Sentry breadcrumb on `collision`/`lead_not_found`/`failed`.

### `GET /api/admin/thumbtack/pending-harvest?limit=N`

- Agent-secret only. Returns up to `N` (default 25) `{ negotiation_id }` for
  clients where `email_harvest_status='pending'` AND `email IS NULL` AND
  (`email_harvest_attempted_at IS NULL` OR `< now() - COOLDOWN`), oldest-first
  (served by `idx_clients_email_harvest_pending`). Use the client's **latest**
  `thumbtack_leads.negotiation_id`; exclude clients whose only lead is terminal
  `thumbtack_leads.status` (`converted`/`lost`).
- **Lease:** stamp `email_harvest_attempted_at=now()` for each returned row
  (does **not** touch `attempts`).
- When the server-side kill-switch is off, return `[]` (a redeploy-free stop).

### `POST /api/admin/thumbtack/harvest-failed`

- Agent-secret only. Body `{ negotiation_id, reason }` where `reason ∈
  {render_timeout, navigation_error, lead_not_found, ambiguous, session_expired}`.
- `session_expired` → fire the re-login admin alert; do **not** touch `attempts`
  or status.
- `ambiguous` → `email_harvest_status='failed'` + alert (terminal, manual).
- `render_timeout | navigation_error | lead_not_found` →
  `email_harvest_attempts = email_harvest_attempts + 1`; if `>= MAX_ATTEMPTS` →
  `failed` + alert; else leave `pending` (cooldown via `attempted_at`).

## Capture Agent (`thumbtack-agent/`)

- Node + Playwright `launchPersistentContext({ userDataDir })`; headful under
  `Xvfb`; `systemd` system service.
- Config (box `.env`, gitignored): `API_BASE_URL`, `THUMBTACK_AGENT_SECRET`,
  `POLL_INTERVAL_MS`, `MIN/MAX_DELAY_MS`, `DAILY_CAP`, `MAX_ATTEMPTS`,
  `COOLDOWN_MS`, `CHROME_PROFILE_DIR`, `PRO_EMAIL_OVERRIDE` (optional),
  `HARVESTER_ENABLED` (kill-switch).
- Loop: poll → for each, navigate, login-check, extract, then `POST` the success
  or the `harvest-failed` outcome.
- **Extraction (selector-free):** read the pro email from `__NEXT_DATA__`;
  `waitForFunction` for a rendered email that isn't the pro's; exactly one →
  customer; zero → `render_timeout`; >1 → `ambiguous`. Avoids the hashed
  `Type_text2__…` class. Fallback: intercept the Apollo GraphQL response.
- Never submits the form. `--dry-run`: extract + log with the email **masked**, no
  POST.

## Security, Errors & Edge Cases

- `THUMBTACK_AGENT_SECRET`: env-only, in `.env.example` + `CLAUDE.md`, never
  hardcoded; timing-safe compare; **fail closed all envs** when unset.
- Write authority: agent path can only set email on a `pending`+null client; admin
  path may override. A leaked secret cannot stamp arbitrary clients.
- Wrong-address backstop: server rejects pro-domain / `ADMIN_EMAIL` / any
  `users.email`.
- Collision: `failed` + alert, **no merge, no email stamped**.
- Data integrity: one `clients` write per harvest in a transaction; idempotent via
  status short-circuit + lease; drip re-arm runs **after** commit (it takes its own
  pooled connection — must not share the savepoint client or live inside the tx).
- Mis-attribution: binding depends on `negotiation_id == URL trailing id` (confirm
  in dry-run, Open Items) + the non-pro-email guard; any divergence fails safe.
- PII: customer email never logged; `--dry-run` masks it; confirm no seam writes
  the email into `thumbtack_leads.raw_payload`.
- Kill-switch: agent-side (`HARVESTER_ENABLED`) **and** server-side
  (`pending-harvest` returns `[]`) so the harvest can be stopped even if the box is
  unreachable.

## Manual-paste admin fallback (UI)

Admin form on the Thumbtack lead / client detail to paste the email — posts to
`POST /email-harvested` (admin-JWT path, may override `failed`). Define states:
loading/disabled submit while posting; client-side email validation mirroring the
server (valid format; reject pro-domain/staff addresses with inline copy);
success toast on `set`/`already_set`; inline errors for `collision` ("that email
already belongs to another client"), `lead_not_found`, and 400. Plus the
`failed → pending` re-arm control (admin) to hand a lead back to the agent. (May
ship as a fast-follow after the endpoints; flag at build time.)

## Testing Strategy

- **Endpoint (`node:test`, the repo's server harness — `npm test`):** set; `already_set` (no status downgrade from `not_needed`);
  `not_pending` 409 on agent path; collision → `failed` + alert + **no merge, no
  email stamped**; `lead_not_found` 404; pro-domain/`ADMIN_EMAIL`/`users.email`
  rejection (400); timing-safe-compare; fail-closed when secret unset (all envs);
  admin-override path can set a `failed` row.
- **Drip re-arm:** future `suppressed`+`client_no_email` rows flipped to `pending`;
  past-window rows untouched (no resend); ineligible-proposal touches left missed;
  runs after commit; not invoked when the email preceded the proposal.
- **harvest-failed:** `attempts` increments; `failed`+alert at `MAX_ATTEMPTS`;
  `ambiguous` immediate `failed`; `session_expired` no `attempts` change + alert.
- **pending-harvest:** filter, cooldown, lease stamping (no `attempts` change),
  terminal-status exclusion, kill-switch returns `[]`.
- **Webhook:** new null-email lead → `pending`; matched client with email →
  `not_needed`.
- **Agent:** extraction fixtures (pro-only / customer+pro / ambiguous / none);
  `--dry-run` masks email and **confirms `negotiation_id == URL id`**.
- **E2E:** real lead → dry-run → live → `clients.email` set, `harvested`, a
  proposal shows the address.

## Open Items / Non-Goals

- **Confirm** the price-estimate URL trailing id equals stored `negotiation_id`
  (dry-run, before go-live).
- **Auto-proposal generation** — deferred (Phase 5); seam only.
- **Historical backfill** of old `not_needed` email-less leads — optional,
  admin-gated.
- **Manual-paste UI** — in scope but may fast-follow the endpoints; confirm at
  build time.
- Agent code home `thumbtack-agent/` in-repo, box-only — confirm vs. separate repo.

## Docs to update on implementation (per CLAUDE.md)

- `CLAUDE.md` + `.env.example` + `README.md`: `THUMBTACK_AGENT_SECRET`,
  `HARVESTER_ENABLED`.
- `README.md` folder tree + `ARCHITECTURE.md` route table:
  `server/routes/thumbtackAgent.js`, the three `/api/admin/thumbtack/*` routes,
  `thumbtack-agent/`.
- `ARCHITECTURE.md` Database Schema: the new `clients.email_harvest_attempts`
  column (the other `email_harvest_*` columns are already documented).
