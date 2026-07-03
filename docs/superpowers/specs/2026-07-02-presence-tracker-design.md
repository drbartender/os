# Presence Tracker (Time Clock): Design Spec

Date: 2026-07-02
Status: approved in brainstorm (section-by-section), pre-plan

## Summary

A two-person presence tracker for Dallas and Zul in the Admin OS shell. Each tracked
admin has one of three manually set states (desk, available, away), shown as a compact
strip at the top of the admin sidebar. The strip also derives and displays a single
"lead pointer": who responds to the next inbound lead and sends the proposal. Every
state and lead-toggle change is logged as an interval, giving a browsable history with
weekly and monthly totals. A scheduler nudges anyone sitting on desk abnormally long
(Telegram for Zul, SMS for Dallas) and auto-flips them to away if the nudge is ignored,
so totals stay honest.

Display-only: presence never routes notifications, never suppresses alerts, and has no
client-facing or staff-portal surface.

## Goals

- Mutual glanceable awareness: who is working, who is reachable, who is off.
- One unambiguous answer to "who fires on the next lead," derived, never manually set.
- A trustworthy time log: on/off boundaries, durations, weekly and monthly totals.
- A "forgot to clock out" guard that keeps the log honest without human vigilance.

## Non-goals

- No notification routing, suppression, or escalation based on presence.
- No per-lead claiming or assignment on proposals/leads.
- No WhatsApp integration.
- No auto-promotion (the system never guesses someone started working).
- No staff-portal or client-facing visibility.
- No per-person "tier-1 task" description cards (the lead pointer is the contract).

## States and semantics

Three states per tracked user, default `away`:

| State | Meaning | Lead-eligible |
|---|---|---|
| `desk` | Working and ready; near-immediate responses; handles tier-1 (leads) | yes |
| `available` | Around with phone; may respond with delay/brevity | yes |
| `away` | Off (asleep, out, unavailable) | no |

State changes are manual only, via your own row in the strip. Nothing auto-promotes.
The only automatic transition is the nudge auto-flip (desk to away, below).

### Taking-leads toggle

Each tracked user has a boolean `taking_leads`. Rules, enforced server-side on every
state transition:

- Transition away -> desk or away -> available: reset to **true** (default on).
- Transition desk <-> available: **preserved** (an explicit opt-out sticks).
- Transition to away: forced **false**.
- Explicit toggle: allowed in desk and available, rejected in away.

So coming online always starts on leads; opting out is deliberate and lasts until you
next go away; nobody inherits a stale opt-out across an off period.

### Lead pointer derivation

Tracked users carry a `presence_lead_rank` (Zul = 1, Dallas = 2; NULL = not tracked).
The pointer is pure derivation, never stored:

```
eligible = tracked users where state != 'away' AND taking_leads = true
owner    = eligible user with the LOWEST rank
fallback = tracked user with the HIGHEST rank (Dallas), when eligible is empty
```

This encodes: Zul at desk or available-and-opted-in owns leads; otherwise Dallas,
unconditionally, including both-away (owner's company, he wakes up for leads). A third
tracked admin someday is just another rank; no code change.

The pointer is computed in one shared pure helper `server/utils/presence.js` (no DB
calls, mirroring the pricingEngine pattern) so the strip, badge-counts, and tests all
agree.

## Data model

All DDL in `server/db/schema.sql`, idempotent (`ADD COLUMN IF NOT EXISTS`; CHECK
constraints via the existing duplicate_object-safe pattern). Note: schema.sql is not
auto-applied to the dev DB; apply the new statements by hand in dev (prod gets them
via initDb).

New columns on `users`:

| Column | Type | Notes |
|---|---|---|
| `presence_state` | VARCHAR(20) NOT NULL DEFAULT 'away' | CHECK in ('desk','available','away') |
| `presence_since` | TIMESTAMPTZ | start of current state |
| `presence_taking_leads` | BOOLEAN NOT NULL DEFAULT false | current toggle value |
| `presence_lead_rank` | INTEGER | NULL = not tracked; partial UNIQUE index where NOT NULL |
| `presence_last_seen_at` | TIMESTAMPTZ | throttled activity stamp (sign of life) |
| `presence_nudge_channel` | VARCHAR(10) | CHECK in ('sms','telegram'); NULL = never nudged |

New table `presence_log` (one row per interval, all three states logged so time off is
first-class):

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `user_id` | INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE | |
| `state` | VARCHAR(20) NOT NULL | CHECK in ('desk','available','away') |
| `taking_leads` | BOOLEAN NOT NULL | value during this interval |
| `started_at` | TIMESTAMPTZ NOT NULL | |
| `ended_at` | TIMESTAMPTZ | NULL = open (current) interval |
| `ended_reason` | VARCHAR(20) | CHECK in ('switch','auto_flip'); NULL while open |
| `nudged_at` | TIMESTAMPTZ | stamped when the stale-desk nudge for this interval was sent |

Indexes: partial UNIQUE on `(user_id) WHERE ended_at IS NULL` (exactly one open
interval per user, doubles as the concurrency guard); btree on
`(user_id, started_at DESC)` for the drawer query.

Every state change and every explicit toggle flip runs in one transaction: close the
open row (`ended_at = NOW()`, `ended_reason = 'switch'`), update the `users` presence
columns, insert the new open row. A toggle flip logs a boundary too (same state, new
`taking_leads`), so "who owned leads at 9:42 last Tuesday" is answerable from the log
alone.

Backfill (idempotent UPDATEs in schema.sql, keyed by account email, no-op where the
account is absent, e.g. dev): Zul's admin account gets rank 1 + channel 'telegram';
Dallas's admin account (`admin@drbartender.com`, the seeded admin) gets rank 2 +
channel 'sms'. Exact emails confirmed against the users table at build time. Rollout
prerequisite: Dallas confirms his admin account's `users.phone` is his cell (not the
shared 312 Google Voice line), since that is where nudge SMS goes and what inbound
sign-of-life matching keys on.

Retention: none needed; a dozen rows a day at most, keep forever.

## API

New route file `server/routes/admin/presence.js`, composed via
`server/routes/admin/index.js`, mounted under `/api/admin`. All endpoints `auth` +
`requireAdminOrManager` (same gate as badge-counts). Mutations additionally require
the caller to be tracked (`presence_lead_rank IS NOT NULL`) and only ever write the
caller's own row (IDOR-safe by construction: `req.user.id`).

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/presence` | Strip payload: `{ users: [{id, name, state, since, taking_leads, rank}], lead_owner_id }` |
| `POST /api/admin/presence/state` | Body `{state}`; validates enum; applies toggle transition rules; returns strip payload |
| `POST /api/admin/presence/leads` | Body `{taking}`; ValidationError when caller is away; returns strip payload |
| `GET /api/admin/presence/log` | Drawer payload: per-user this-week and this-month totals by state, plus the 50 most recent intervals |

Additionally, the existing `GET /api/admin/badge-counts` response
(`server/routes/admin/settings.js`) gains a `presence` block with the same strip
payload. AdminLayout already polls badge-counts every 60s with tab-visibility
handling (`client/src/components/AdminLayout.js`), so the strip stays fresh with zero
new polling machinery. POST responses update the strip instantly.

Totals bucketing: weeks start Monday 00:00 **America/Chicago**, months are Central
calendar months (company time; Zul's PH hours are displayed in Central like
everything else in the admin). Open intervals count up to NOW() in totals.

## Sign of life

`presence_last_seen_at` is stamped by three paths, all fire-and-forget (never blocks
or fails the wrapping request):

1. **App activity**: the shared `auth` middleware stamps the column for tracked users,
   throttled by an in-memory per-user timestamp (write at most once per 60s). The
   UPDATE's WHERE clause includes `presence_lead_rank IS NOT NULL` so untracked users
   cost nothing but the throttle check.
2. **Telegram reply** (Zul): in the existing webhook (`server/routes/telegram.js`),
   after secret verification and the allowed-user check, stamp the tracked user whose
   `presence_nudge_channel = 'telegram'`, then continue normal VA-calling processing
   unchanged. If the message is a plain nudge acknowledgment (does not parse as a call
   trigger) while this user's open desk interval has `nudged_at` set, reply a short
   confirmation ("Got it, keeping you on desk") instead of the couldn't-parse fallback.
3. **SMS reply** (Dallas): in the existing inbound webhook (`server/routes/sms.js`),
   after Twilio signature verification, if the normalized From number matches a tracked
   user's `users.phone`, stamp it, then continue existing routing (staff CONFIRM/CANT
   resolution etc.) unchanged.

## Nudge and auto-flip scheduler

New `server/utils/presenceScheduler.js`, registered in `server/index.js` alongside the
existing schedulers: every 15 minutes, wrapped with `schedulerHealth`, gated by
`RUN_SCHEDULERS` + new per-scheduler flag `RUN_PRESENCE_SCHEDULER` (default on,
following the established pattern). Two passes:

**Nudge pass.** Open `desk` intervals with `started_at < NOW() - 6h` and
`nudged_at IS NULL`: send one nudge via the user's `presence_nudge_channel`
(`sendTelegramMessage` to `TELEGRAM_ALLOWED_USER_ID` for telegram, `sendSMS` to
`users.phone` for sms), then stamp `nudged_at`. Copy:

> You've been on desk for 6+ hours. Still working? Reply anything (or touch the app)
> within 30 minutes and I'll keep you clocked in. Otherwise I'll flip you to away.

Stamp-after-send means a crash between send and stamp could double-send 15 minutes
later; accepted (internal, low volume). Send failure leaves `nudged_at` NULL so the
next sweep retries. Outbound sends respect the same dev gating as all other
notifications (`SEND_NOTIFICATIONS` / NODE_ENV log-and-skip discipline; verified at
the call site if `sendTelegramMessage` is not already gated).

**Flip pass.** Open `desk` intervals with `nudged_at < NOW() - 30min` and no sign of
life since the nudge (`presence_last_seen_at IS NULL OR presence_last_seen_at <
nudged_at`): in one transaction, close the interval at **`nudged_at`** (not NOW()) with
`ended_reason = 'auto_flip'`, insert an open `away` interval starting at `nudged_at`
with `taking_leads = false`, and update the `users` row (state away, since =
`nudged_at`, taking_leads false). Closing at the nudge time keeps totals honest: an
ignored nudge means the tail was not work.

`available` is never nudged. The 6h threshold and 30min grace live as named constants
in the scheduler (per-user tuning is YAGNI until someone asks).

If the user replies after the flip already happened, nothing reconciles automatically;
they just tap back to desk (new interval). The Telegram ack reply covers the common
case because sign-of-life stamps on any inbound message regardless.

## UI

**Presence strip** (`client/src/components/adminos/PresenceStrip.js`), rendered by
`Sidebar.js` directly under the brand row. Data arrives via the badge-counts payload
passed down from AdminLayout, plus a refresh callback; POST responses update
optimistically.

- One row per tracked user: colored dot (green desk, yellow available, gray away),
  first name, state label, time in state ("2h", "35m"; recomputed client-side from
  `since` on a 60s tick).
- Your own row opens a small three-option popover on click (explicit options, no
  cycling; too easy to fat-finger past desk into away). Other rows are read-only.
- Every tracked row except the fallback (highest rank, whose toggle can never change
  the pointer) shows a small "leads" pill; in the two-person case that is Zul's row
  only. The pill is clickable only on your own row and only while your state is not
  away; read-only display otherwise.
- A third line shows the pointer: "Leads -> Zul" / "Leads -> Dallas".
- Rail mode: collapses to the stacked dots plus the pointer as a colored initial;
  labels via the existing nav-rail tooltip pattern.
- A small clock icon (or clicking the strip header) opens the history drawer.
- Vanilla CSS in `client/src/index.css`, tokens for both skins (House Lights and
  After Hours), comfy/compact density respected.

**History drawer** (`client/src/components/adminos/drawers/PresenceDrawer.js`, using
the existing `Drawer` component). Contents, per tracked user: this-week and this-month
totals for desk and available (away shown as the implicit remainder, not totaled), and
a table of the 50 most recent intervals (state, started, ended, duration, leads on/off,
an "auto" badge for auto_flip closes). Times displayed in Central. No new nav item; if
this outgrows the drawer it gets promoted to a page later, not now.

## Error handling

- Route mutations follow AppError conventions (ValidationError for bad enum values,
  toggle-while-away, or untracked callers).
- The last-seen stamp and the badge-counts presence block are non-fatal: a presence
  query failure never breaks badge counts (wrap and default to an empty block) and a
  stamp failure never surfaces to the request.
- Scheduler failures are visible via the existing schedulerHealth staleness monitor.
- The partial unique index makes concurrent double-transitions safe: the second
  transaction fails on insert and retries by re-reading current state (or surfaces a
  409, acceptable for a two-user feature).

## Testing

Server (node:test, run per-suite against the shared dev DB, `node -r dotenv/config`):

- `server/utils/presence.test.js`: pointer derivation (all rank/state/toggle
  combinations incl. both-away fallback), toggle transition matrix, nudge and flip
  eligibility predicates (injected clock).
- `server/routes/admin/presence.test.js`: auth + role gates, untracked-caller
  rejection, cannot mutate another user, enum validation, toggle-while-away rejection,
  interval bookkeeping across a scripted sequence (close/open pairs, reasons), log
  totals math, badge-counts includes the presence block.
- Scheduler logic tested through the pure eligibility helpers plus a deps-injected run
  (mirroring the `__setTelegramDeps` pattern) asserting nudge send, `nudged_at` stamp,
  and the flip transaction closing at `nudged_at`.

Client: manual verification in both skins and rail mode (strip render, popover, toggle
pill, drawer totals), per the usual practice for admin-shell UI.

## Docs and env updates (same change, per CLAUDE.md)

- `README.md`: folder tree (presence route, PresenceStrip, PresenceDrawer, scheduler
  util), env table (`RUN_PRESENCE_SCHEDULER`).
- `ARCHITECTURE.md`: route table (4 endpoints + badge-counts change), schema section
  (users columns + presence_log), scheduler list.
- `CLAUDE.md`: env table (`RUN_PRESENCE_SCHEDULER`).

## Review level

This touches `server/db/schema.sql` (sensitive: schema/DDL), `server/routes/sms.js`
and `server/routes/telegram.js` (external-send seams), and the shared `auth`
middleware (auth seam). Per convention: full per-lane fleet before merge, sensitive
re-review + `/second-opinion` at push. The feature itself carries no money movement.

## Explicit decisions (from brainstorm)

- Display-only; no routing or suppression (revisit only if it hurts).
- Auto-flip over passive nudge; interval closes at nudge time.
- Telegram for Zul, SMS for Dallas; WhatsApp rejected (new integration, no gain).
- Leads toggle defaults on in desk AND available; opt-out survives desk<->available;
  away wipes it.
- Both-away leads owner is Dallas, always.
- No tier-1 description cards; the pointer is the whole contract.
- History lives in a drawer off the strip, not a nav item.
- Company-time (Central) bucketing for totals.
