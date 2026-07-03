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
constraints via the existing `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` pattern,
e.g. the users role CHECK at schema.sql:269-270). Note: schema.sql is not
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
| `presence_nudge_phone` | VARCHAR(20) | E.164; nudge-SMS destination AND inbound sign-of-life match key (channel 'sms' only). NOT `contractor_profiles.phone` and NOT the shared 312 GV line. There is no `users.phone` column; this column is the only phone the feature touches |

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

Backfill (idempotent statements in schema.sql, no-op where the account is absent,
e.g. dev): Zul's admin account gets rank 1 + channel 'telegram'; Dallas's admin
account gets rank 2 + channel 'sms' + `presence_nudge_phone` = his cell. The
backfill is keyed by account email; note `admin@drbartender.com` is only the seed
FALLBACK (`seed.js:11` uses `ADMIN_EMAIL` first), so the exact prod emails for both
accounts are read from the prod users table at build time, not assumed. The backfill
also seeds the clock so no consumer ever sees a half-initialized user: for each row
it ranks, set `presence_since = NOW()` where NULL, and insert an open `away`
interval into presence_log where that user has no open row (guarded, so re-runs at
every boot are no-ops). Because an email mismatch would silently no-op, rollout
includes a post-deploy verification (see Rollout checklist).

Retention: none needed; a dozen rows a day at most, keep forever.

## API

New route file `server/routes/admin/presence.js`, composed via
`server/routes/admin/index.js`, mounted under `/api/admin`. Strip endpoints are
`auth` + `requireAdminOrManager` (same gate as badge-counts); the log endpoint is
**admin-only** (explicit `req.user.role === 'admin'` guard): the glanceable strip is
fine for a future manager, but the interval history is effectively a timesheet
(Zul's included) and stays admin-tier. Mutations additionally require the caller to
be tracked (`presence_lead_rank IS NOT NULL`) and only ever write the caller's own
row (IDOR-safe by construction: `req.user.id`).

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/presence` | Strip payload: `{ users: [{id, name, state, since, taking_leads, rank}], lead_owner_id }` |
| `POST /api/admin/presence/state` | Body `{state}`; validates enum; applies toggle transition rules; returns strip payload |
| `POST /api/admin/presence/leads` | Body `{taking}`; ValidationError when caller is away; returns strip payload |
| `GET /api/admin/presence/log` | Admin-only. Drawer payload: per-user this-week and this-month totals by state, plus the 50 most recent intervals |

Additionally, the existing `GET /api/admin/badge-counts` response
(`server/routes/admin/settings.js`) gains a `presence` block with the same strip
payload. AdminLayout already polls badge-counts every 60s with tab-visibility
handling (`client/src/components/AdminLayout.js`), so the strip stays fresh with zero
new polling machinery. POST responses update the strip instantly.

Totals bucketing: weeks start Monday 00:00 **America/Chicago**, months are Central
calendar months (company time; Zul's PH hours are displayed in Central like
everything else in the admin). Open intervals count up to NOW() in totals. An
interval spanning a bucket boundary is **split**: each bucket gets only the overlap
between the interval and the bucket window (`LEAST(ended_at, bucket_end)` minus
`GREATEST(started_at, bucket_start)`), so an overnight desk stint across Monday
00:00 lands partly in each week and totals always sum to wall-clock time.

## Sign of life

Sign of life has two layers. The **in-memory activity map** is the source of truth
within a process: the shared `auth` middleware records `NOW()` per tracked user in a
module-level Map on every authenticated request (free; gated in-process on
tracked-ness by adding `presence_lead_rank` to the existing auth SELECT, so
untracked users cost nothing, not even a no-op UPDATE). The **DB column**
`presence_last_seen_at` is the durable shadow: flushed from the map fire-and-forget
at most once per 60s per user, always with an attached `.catch` that logs once and
swallows (this runs in the hottest middleware in the app; an unhandled rejection
here would surface process-level). The flip pass reads
`GREATEST(in-memory value, DB value)`, which it can do because the scheduler runs in
the same process as the middleware (the primary Render instance; a secondary
instance with `RUN_SCHEDULERS=false` serves requests whose stamps reach the primary
via the 60s DB flush, so the worst cross-instance staleness is 60s). This closes the
throttle-shadow hole: a touch landing seconds after the nudge is visible to the flip
pass immediately, not after the next flush.

Stamp paths:

1. **App activity**: any authenticated request from a tracked user, per the above.
2. **Telegram reply** (Zul): in the existing webhook (`server/routes/telegram.js`),
   after secret verification and the allowed-user check, stamp the tracked user whose
   `presence_nudge_channel = 'telegram'` (map + immediate DB write; webhooks are not
   hot), then hand off to VA-calling processing with one precedence rule spliced in.
   The existing grammar (telegram.js): `YES_RE` routes to the call-confirm path and a
   parseable US number seeds a pending call. Order in the modified handler:
   (a) a YES-match **with a live pending_call** confirms the call as today (the
   confirm itself is sign of life); (b) a parseable number places a call as today;
   (c) a YES-match with **no** pending call, or any otherwise-unparseable text, while
   this user's open desk interval has `nudged_at` set, replies "Got it, keeping you
   on desk" (instead of today's "That request expired…" / couldn't-parse fallbacks);
   (d) with no pending nudge, all fallbacks behave exactly as today. So a natural
   "yes" to the nudge lands in the ack branch, VA-calling behavior is untouched, and
   the nudge copy (below) never invites a number-shaped reply.
3. **SMS reply** (Dallas): in the existing inbound webhook (`server/routes/sms.js`),
   after Twilio signature verification, if the normalized From matches a tracked
   user's `presence_nudge_phone`, stamp it (map + immediate DB write), then continue
   existing routing (staff CONFIRM/CANT resolution keys on `contractor_profiles.phone`,
   a different column, so no interference) unchanged. Inbound From is spoofable in
   principle; the only thing a forger gains is suppressing an auto-flip, log-honesty
   impact only, accepted.

## Nudge and auto-flip scheduler

New `server/utils/presenceScheduler.js`, registered in `server/index.js` alongside the
existing schedulers: every 15 minutes, wrapped with `schedulerHealth`, gated by
`RUN_SCHEDULERS` + new per-scheduler flag `RUN_PRESENCE_SCHEDULER` (default on,
following the established pattern). Two passes:

**Nudge pass.** Open `desk` intervals with `started_at < NOW() - 6h` and
`nudged_at IS NULL`: send one nudge via the user's `presence_nudge_channel`
(`sendTelegramMessage` to `TELEGRAM_ALLOWED_USER_ID` for telegram, `sendSMS` to
`presence_nudge_phone` for sms). Copy (deliberately does not invite "reply anything",
so a reply never collides with the VA-calling number grammar):

> You've been on desk for 6+ hours. Still working? Reply "yes" or touch the app
> within 30 minutes and I'll keep you clocked in. Otherwise I'll flip you to away.

**`nudged_at` is stamped only on a confirmed send.** Both senders return
skip/failure results without throwing (`notificationsEnabled()` gating produces
success-with-skip); a skipped or failed send must NOT stamp, or the flip pass would
clock someone out 30 minutes after a warning that was never delivered. An
unconfirmed send logs a console.warn + Sentry capture and leaves `nudged_at` NULL so
the next sweep retries; volume is bounded (two users, 15-min cadence) and the Sentry
noise is the alarm that a number or token has gone bad. Stamp-after-send means a
crash between send and stamp could double-send 15 minutes later; accepted (internal,
low volume).

**Flip pass.** Open `desk` intervals with `nudged_at < NOW() - 30min` and no sign of
life since the nudge, where sign of life = `GREATEST(in-memory activity, DB
presence_last_seen_at)` per the Sign of life section. The flip transaction is scoped
to the exact interval the sweep observed, never to "whatever is open now", so a
concurrent manual transition can never be clobbered (the partial unique index only
guards the INSERT; this guards the close):

1. `UPDATE presence_log SET ended_at = nudged_at, ended_reason = 'auto_flip'
   WHERE id = $observedIntervalId AND ended_at IS NULL`; if rowCount = 0 (the user
   switched state or toggled in the meantime, closing that row), ROLLBACK and skip.
2. `UPDATE users SET presence_state='away', presence_since=$nudgedAt,
   presence_taking_leads=false WHERE id = $userId AND presence_state='desk' AND
   presence_since = $observedSince`; if rowCount = 0, ROLLBACK and skip.
3. INSERT the open `away` interval starting at `nudged_at` with
   `taking_leads = false`.
4. COMMIT; emit one console line ("presence: auto-flipped <name> at <nudged_at>")
   so "why was I flipped" is answerable from logs.

Closing at the nudge time (not NOW()) keeps totals honest: an ignored nudge means
the tail was not work. By construction no path can produce `ended_at < started_at`.

`available` is never nudged. The 6h threshold and 30min grace live as named constants
in the scheduler (per-user tuning is YAGNI until someone asks).

If the user replies after the flip already happened, nothing reconciles automatically;
they just tap back to desk (new interval). The Telegram ack reply covers the common
case because sign-of-life stamps on any inbound message regardless.

## UI

**Presence strip** (`client/src/components/adminos/PresenceStrip.js`), rendered by
`Sidebar.js` directly under the brand row. Presence state has a single owner:
AdminLayout holds it alongside `badges`, fills it from the badge-counts poll, and
passes it down with a setter. POSTs are not blind-optimistic: the control disables
while the mutation is in flight, and the POST *response* payload (server truth)
replaces the state. On failure (ValidationError, 409 from the unique-index guard,
network), the strip re-fetches `GET /api/admin/presence`, renders whatever the
server says, and surfaces the existing Toast error pattern; it never keeps showing
a state the server refused. A stale-poll guard (AdminLayout records the timestamp of
the last mutation; a poll response whose request started before that timestamp does
not overwrite presence) stops the 60s poll from clobbering a just-committed change.

Before the first poll resolves (or when the presence block is absent/empty, e.g. the
badge-counts presence subquery failed), the strip renders a fixed-height muted
placeholder (two gray dots, no names), so the sidebar never jumps and never shows
stale or invented state.

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
the existing `Drawer` component and its sibling drawers' loading + error + retry
pattern). Contents, per tracked user: this-week and this-month totals for desk and
available (away shown as the implicit remainder, not totaled), and a table of the 50
most recent intervals (state, started, ended, duration, leads on/off, an "auto"
badge for auto_flip closes). States: spinner while loading, error row with a retry
button on fetch failure, and an explicit empty state ("No history yet") for a
freshly tracked user with only the seeded open interval. Times displayed in Central.
Admin-only, matching the log endpoint: the drawer trigger is hidden for managers.
No new nav item; if this outgrows the drawer it gets promoted to a page later, not
now.

## Error handling

- Route mutations follow AppError conventions (ValidationError for bad enum values,
  toggle-while-away, or untracked callers).
- The last-seen DB flush and the badge-counts presence block are non-fatal: a
  presence query failure never breaks badge counts (wrap and default to an empty
  block, which the strip renders as the placeholder) and a stamp failure never
  surfaces to the request (attached `.catch`, log-once).
- Scheduler failures are visible via the existing schedulerHealth staleness monitor;
  unconfirmed nudge sends additionally emit console.warn + Sentry capture.
- Concurrency: the partial unique index guards interval INSERTs (a losing concurrent
  transition gets a 409, which the strip resolves by re-fetching server truth), and
  the flip pass guards its close/update by observed interval id + conditional users
  UPDATE (see Flip pass), so no interleaving can produce a negative-duration row or
  clobber a manual switch.

## Testing

Server (node:test, run per-suite against the shared dev DB, `node -r dotenv/config`):

- `server/utils/presence.test.js`: pointer derivation (all rank/state/toggle
  combinations incl. both-away fallback), toggle transition matrix, nudge and flip
  eligibility predicates (injected clock), boundary splitting (an interval straddling
  Monday 00:00 Central lands in both weeks and sums to wall-clock).
- `server/routes/admin/presence.test.js`: auth + role gates (log endpoint rejects
  managers), untracked-caller rejection, cannot mutate another user, enum validation,
  toggle-while-away rejection, interval bookkeeping across a scripted sequence
  (close/open pairs, reasons), log totals math, badge-counts includes the presence
  block, badge-counts survives a presence subquery failure.
- Scheduler logic tested through the pure eligibility helpers plus a deps-injected run
  (mirroring the `__setTelegramDeps` pattern) asserting: nudge send and `nudged_at`
  stamp on confirmed send; NO stamp on skipped/failed send; flip closes at `nudged_at`
  by observed interval id; flip aborts cleanly (rowCount 0) when a manual transition
  won the race; in-memory activity after the nudge suppresses the flip.
- `server/routes/telegram.test.js` additions: nudge-pending "yes" with no pending
  call hits the ack branch; "yes" with a live pending_call still confirms the call;
  numbers still dial; no-nudge fallbacks unchanged.

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

## Rollout checklist

1. Apply the new schema.sql statements to the dev DB by hand (not auto-applied).
2. Before enabling the scheduler in prod: Dallas supplies his cell for
   `presence_nudge_phone` (never the shared 312 GV line; it is both the nudge
   destination and the sign-of-life key).
3. Post-deploy verification (the email-keyed backfill silently no-ops on a
   mismatch): `SELECT id, email, presence_lead_rank, presence_nudge_channel,
   presence_nudge_phone FROM users WHERE presence_lead_rank IS NOT NULL` on prod
   must return exactly the two expected rows, each with `presence_since` set and an
   open away interval in presence_log.
4. Smoke: flip states in the strip in both skins + rail mode; open the drawer;
   confirm the pointer follows the derivation table.

## Explicit decisions (from brainstorm + spec review 2026-07-02)

- Display-only; no routing or suppression (revisit only if it hurts).
- Auto-flip over passive nudge; interval closes at nudge time.
- Telegram for Zul, SMS for Dallas; WhatsApp rejected (new integration, no gain).
- Leads toggle defaults on in desk AND available; opt-out survives desk<->available;
  away wipes it.
- Both-away leads owner is Dallas, always.
- No tier-1 description cards; the pointer is the whole contract.
- History lives in a drawer off the strip, not a nav item.
- Company-time (Central) bucketing for totals; boundary-spanning intervals split.
- From spec review: phone lives in new `presence_nudge_phone` (users.phone does not
  exist); `nudged_at` stamps only on confirmed sends; flip transaction is scoped by
  observed interval id; nudge-ack precedence spliced into the Telegram grammar
  without touching VA-calling behavior; history endpoint + drawer are admin-only
  (manager tier sees only the strip); backfill seeds the open away interval.
