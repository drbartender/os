# Thumbtack Lead Call Bridge (real-time first-ring)

**Date:** 2026-07-18 (rev 2, post design-review fleet)
**Status:** Approved in brainstorm (Dallas, 7/18); rev 2 folds in spec-grounding, spec-gaps, and spec-risk findings (grounding PASS with warnings; gaps and risk blockers all addressed below).
**Companion plan:** to be written after spec approval (`docs/superpowers/plans/`).

## 1. Why

Speed-to-lead is the single biggest conversion lever on Thumbtack: the first pro to reach the client by voice usually wins the job. The auto-draft pipeline already answers in-platform instantly; this feature adds the human-voice follow-up within a minute of the lead arriving, without anyone watching a dashboard.

When a lead lands, the system calls Dallas first. He hears a short spoken briefing of the lead, and presses 1 to be bridged to the client. If he does not pick up (or passes), the system tries Zul the same way. If both miss, the lead is logged for manual follow-up. No availability toggles, no UI to babysit.

Verified against production data (60 days to 2026-07-18, 148 leads):

- 100% of leads carry `customer_phone` in the webhook payload at creation time, and all observed numbers are NANP (+1): either real Chicago-area numbers or Thumbtack's 839 proxies.
- 100% have `event_date`, 147/148 have `guest_count`, 100% have `location_city`. The briefing essentially never comes up empty.
- 27/148 (18%) arrive outside the 8am to 9pm Chicago window.
- Since 2026-06-08, Thumbtack masks most lead phones: 103/148 recent leads carry a unique 839 area-code proxy number (100 distinct proxies observed) that relays through Thumbtack. The remainder are real client numbers. See section 8 (launch gate) for the relay implications.
- Volume is ~2.5 leads/day, so call spend is negligible and the daily cap is purely a fraud backstop.

## 2. Decisions (locked in brainstorm)

1. **Call window: 8:00am to 9:00pm America/Chicago**, judged at lead arrival time. Outside the window: no call, log only. No morning auto-call sweep; by morning the auto-draft proposal is the right artifact and cold-call receptivity has decayed.
2. **Fixed ring order: Dallas, then Zul.** No availability toggle in v1.
3. **Press-1 confirm with spoken briefing.** The lead's phone does not ring until the agent presses 1, so listening, replaying, or pulling the lead up in admin first is free. Voicemail can never be bridged to a client because voicemail cannot press 1.
4. **Caller IDs:** agent legs (to Dallas / Zul) present the 888 SMS line (`TWILIO_PHONE_NUMBER`), so "888 ringing" means "new lead alert." The lead-facing leg presents the 224 (`VOICE_CALLER_ID`): local-reading, better answer rates than toll-free, and it becomes the lead-facing voice number going forward.
5. **The 224 must be added to the Thumbtack business profile before launch** so Thumbtack's masked-number relay recognizes and connects calls from it (the 888 is already on file for SMS).
6. **Callbacks to the 224 keep their existing routing** (inbound dials Zul's cell). Acceptable for v1; voicemail fallback is a noted fast-follow, not in scope.

## 3. Non-goals (v1)

- No availability toggle or presence integration; ring order is fixed in config.
- No retry of a missed chain and no scheduled morning sweep.
- No voicemail on the 224 inbound path; no changes to `POST /api/voice/inbound`.
- No SMS notifications added anywhere (admin alerting is email, per standing preference).
- No Thumbtack message/reply triggers; only lead creation triggers a call.
- No changes to the auto-draft pipeline, harvester, or existing VA calling (Telegram) flow beyond sharing utilities and the scheduler pass noted in 4.5.

## 4. Architecture

### 4.1 New table: `lead_call_attempts` (in `server/db/schema.sql`, idempotent)

One row per lead, created at trigger time; the row is the state machine and the call log.

```sql
CREATE TABLE IF NOT EXISTS lead_call_attempts (
  id             BIGSERIAL PRIMARY KEY,
  lead_id        INTEGER NOT NULL UNIQUE REFERENCES thumbtack_leads(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','calling_admin','calling_va',
                                     'connected','missed','skipped_after_hours',
                                     'skipped_unconfigured','skipped_invalid_phone',
                                     'failed')),
  answered_by    TEXT CHECK (answered_by IN ('admin','va')),
  admin_call_sid TEXT,
  va_call_sid    TEXT,
  admin_call_status TEXT,   -- raw Twilio final status of the admin leg (per-leg disposition survives chain advance)
  va_call_status    TEXT,
  bridge_started_at   TIMESTAMPTZ,
  bridge_duration_sec INTEGER,
  detail         TEXT,          -- terse machine note: twilio error code, skip reason, 'stale_reaped', 'cap_tripped'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`lead_id UNIQUE` is the idempotency guard: Thumbtack retries webhooks, and the trigger inserts with `ON CONFLICT (lead_id) DO NOTHING`; only the insert winner proceeds. **Threading the PK (grounding fix):** the parsed `lead` object does not carry `thumbtack_leads.id` today. The normal webhook path's lead INSERT (`thumbtack.js:436`) gains `RETURNING id`, and both `runPostCommitSteps` call sites thread it: the normal path passes the returned id, the heal path passes the `row.id` it already has in scope. `triggerLeadCall` receives `{ lead, leadId }`.

On a successful bridge, also flip `thumbtack_leads.status` to `'contacted'`, **gated on the lead leg completing with duration of 20 seconds or more** (risk fix): a press-1 that hits a relay refusal (near-zero-duration bridge) must NOT mark the lead contacted, or the silent-failure mode section 8 warns about would also erase the lead from follow-up surfaces. A short bridge leaves status `'new'` and the attempt row visible.

### 4.2 Trigger point: the webhook post-commit tail

`runPostCommitSteps` in `server/routes/thumbtack.js` (the existing best-effort tail that runs the auto-draft and admin notification, after the lead transaction commits and the pooled client is released) gains a third step: `triggerLeadCall({ lead, leadId })`. Properties it must keep:

- **Never blocks or fails the webhook response.** Any error is caught, logged, sent to Sentry, and recorded on the attempt row as `failed`. Thumbtack sees its normal 200/503 semantics unchanged.
- **Takes no DB client from the caller** (pool-deadlock rule for the post-commit tail); it uses `pool.query()` directly.
- **Runs on the heal path too**: the `ON CONFLICT DO NOTHING` insert makes the call side effect at-most-once regardless of which path fires it.

`triggerLeadCall` logic, in order:

1. Kill switch: `LEAD_CALL_ENABLED=false` means insert nothing, do nothing (redeploy-free off switch, `HARVESTER_ENABLED` precedent; note an env change on Render does restart the service, so "redeploy-free" means code-deploy-free).
2. Window check at now() in America/Chicago: outside 08:00 to 20:59:59 inserts the row as `skipped_after_hours` and stops. The check uses a new small helper (natural home: `server/utils/businessTime.js`, alongside the existing Intl-based Chicago helpers) returning the current Chicago hour; never a fixed UTC offset (DST).
3. Config check: no `ADMIN_PHONE` and no `VA_CELL` inserts `skipped_unconfigured` and stops. (One missing is fine: the chain just starts at, or skips to, the configured leg.)
4. **Dial-target validation (risk blocker fix):** `customer_phone` is externally supplied and becomes a billed dial target; validate it with `toUsE164` (`server/utils/usPhone.js`, the same guard the Telegram VA flow uses) and reject premium-rate NANP prefixes (900/976). Invalid or non-US inserts `skipped_invalid_phone` and stops. All 148 observed leads are NANP, so this costs nothing and closes the IRSF vector. Validation only; the validated E.164 form is what gets dialed, and the number is never run through the US-centric `normalizePhone` display helper.
5. **Atomic daily cap (risk fix):** the cap must not be check-then-insert (concurrent webhooks would all pass the count). The `pending` insert itself enforces it in one statement: `INSERT ... SELECT ... WHERE (SELECT count(*) FROM lead_call_attempts WHERE created_at > NOW() - interval '24 hours' AND status NOT LIKE 'skipped%') < $CAP ON CONFLICT (lead_id) DO NOTHING`. Rolling 24 hours, matching the VA flow's `countPlacedSince` semantics. A cap-blocked lead gets a `failed` row with detail `cap_tripped` written in a follow-up statement (so it is still logged and surfaced), and cap-trip admin emails are deduped to at most one per 24h (Resend quota protection).
6. **Claim-then-call (risk/gaps blocker fix), the ordering rule for every billed leg in this feature:** a guarded UPDATE claims the state first (`SET status='calling_admin' WHERE id=$1 AND status='pending'`); only the claim winner (rowCount=1) calls `calls.create`; the SID is written after placement, with `cancelBridgedCall` as the existing best-effort cleanup if the SID write fails. This is the `telegram.js` Guard 5 precedent, and it makes duplicate triggers and duplicate status callbacks no-ops instead of double-billed calls.
7. An admin-leg `calls.create` failure does not kill the chain: record the error in `detail` and `admin_call_status`, then fail over to the VA leg (same claim-then-call). Only when the last configured leg fails to place does the row go `failed` with the admin email.

Outbound dialing is gated identically to `sendSMS` / `placeBridgedCall` (`SEND_NOTIFICATIONS` / `NODE_ENV` gate in `server/utils/sms.js`): a dev server against the shared DB logs and skips, never dials the live auto-refill Twilio account. The gate is load-bearing; this is a billed-voice primitive. Every log line involving the lead's phone uses the existing last-4 redaction convention (`slice(-4)`, as in `sms.js` / `telegram.js`).

### 4.3 Call flow (Twilio webhooks)

New route file `server/routes/voiceLeadCall.js` mounted at `/api/voice/lead` (keeps `voice.js` single-concern). The Twilio signature gate is extracted from `voice.js` into a shared helper (it is module-private today, so extraction, not import). **These three endpoints fail closed in every environment, dev included** (risk fix, matching the `telegram.js` precedent for privileged endpoints): they serve client PII and drive billed calls, and the `__setDeps`-style stub pattern keeps them testable without live signatures. Sentry-tagged 403 on failure, as `voice.js` does in prod.

- **`/api/voice/lead/answer?attempt=<id>&leg=<admin|va>`** : the `url` on each agent leg. Returns TwiML: `<Gather numDigits="1" timeout="10" action=".../digit?attempt=..&leg=..">` wrapping a `<Say>` of the briefing (section 4.4), then a second `<Say>` of the briefing (one automatic repeat), then hang up. Answered-but-no-keypress (including voicemail) therefore ends the leg naturally and the status callback advances the chain. A missing or already-terminal attempt row (e.g., cascade-deleted lead, stale webhook) gets a polite apology-and-hangup TwiML, never a 500.
- **`/api/voice/lead/digit`** : Gather action. Digit `1`: guard-update the attempt (`SET status='connected', answered_by=$leg, bridge_started_at=NOW() WHERE id=$1 AND status IN ('calling_admin','calling_va')`); if the guard matched, respond `<Dial answerOnBridge="true" callerId="<VOICE_CALLER_ID>" timeLimit="<VA_CALL_TIME_LIMIT_SEC>"><Number statusCallback=".../status?...leg=lead">validated lead phone</Number></Dial>`; if it did not match (stale/duplicate webhook), apology-and-hangup. Digit `9`: replay the Gather (max 3 total plays, then hang up). Any other digit: hang up (status callback advances).
- **`/api/voice/lead/status`** : `statusCallback` for all legs. Every transition is a guarded UPDATE; every side effect (placing the VA leg, sending the missed email) fires only when that UPDATE's rowCount is 1, so Twilio's at-least-once callback delivery can never double-place the billed PH leg or double-send the email. On a terminal admin-leg status (`no-answer`, `busy`, `failed`, `canceled`, or `completed` while the row is still `calling_admin`): record `admin_call_status`, claim `calling_va`, and the claim winner places the VA leg. On a terminal VA-leg status: record `va_call_status`, mark `missed`, fire the missed-lead notification (section 5). On the lead-leg terminal status: parse Twilio's `CallDuration` defensively (non-integer or absent stores NULL, never NaN) into `bridge_duration_sec`, and apply the `'contacted'` flip rule from 4.1. Unknown `CallStatus` values are logged and ignored (no state change).

Agent legs are placed with `timeout: 25` (ring seconds) so an unanswered leg fails over in under 30 seconds. The existing `placeBridgedCall` in `server/utils/sms.js` is reused for call placement (it is already generic: `{ to, callerId, url, statusCallback, timeLimit }`); it gains an optional `timeout` passthrough. Its dev-gate and logging stay untouched; `cancelBridgedCall` remains the persist-failure cleanup.

### 4.4 Briefing builder

`server/utils/leadCallBriefing.js`: a pure function `buildLeadBriefing(lead)` returning the spoken text, for example:

> "New Thumbtack lead: Sarah M. Wedding, Saturday October 10th, 6 PM, 120 guests, Naperville. Press 1 to call them now. Press 9 to hear this again."

Rules: fields render in that order (name, category, event date and time in America/Chicago with weekday, guest count, city); any absent field is skipped, never spoken as "unknown"; a null/absent lead yields a generic "New Thumbtack lead" line. Date formatting is TTS-friendly (no numeric `10/10 18:00`). Pure function, no DB, unit-tested directly. **Every interpolated value in every TwiML response is `xmlEscape`d, the `<Say>` briefing included** (risk fix): name and city are client-typed strings from an external payload and are a TwiML-injection surface inside the agent leg. TwiML uses the default `<Say>` voice; voice selection is not a v1 concern.

### 4.5 Stuck-row sweeper (gaps blocker fix)

A crash between insert and placement, a lost `statusCallback`, or a Twilio-side hang can strand a row in `pending` / `calling_admin` / `calling_va` with no webhook ever coming. The hourly VA-calling scheduler pass (`server/utils/vaCallingScheduler.js`, already gated by `RUN_VA_CALLING_SCHEDULER`) gains a reaper: any `lead_call_attempts` row still in `pending`, `calling_admin`, or `calling_va` after 30 minutes is marked `failed` with detail `stale_reaped` (a `connected` row is never reaped; a legitimate bridge can run to the `timeLimit`) (guarded UPDATE, same side-effect rules: the winner sends the one admin email). Reaped rows surface exactly like other `failed` rows, so a mid-chain crash costs visibility, never a silently lost lead.

## 5. Missed-lead surfacing

### 5.1 Admin email

When a chain ends `missed`, or `failed` for call-path reasons: one email via the existing `notifyAdminCategory` fan-out, new category `lead_call`. Adding a category touches four places, all in the same change (grounding fix): `VALID_CATEGORIES` in `server/utils/adminNotifications.js`, the `NOTIFICATION_CATEGORIES` mirror and PATCH allowlist in `server/routes/me.js`, `CATEGORY_LABELS` in `client/src/pages/admin/NotificationSettings.js`, and (optional, harmless) the `notification_preferences` JSONB default in `schema.sql`. Email only; no SMS. Send rules: only the guarded-UPDATE winner sends (no duplicates on callback retry); cap-trip (`cap_tripped`) emails are deduped to one per rolling 24h; `skipped_*` rows never email (the existing new-lead notification already covered arrival).

### 5.2 Needs-attention queue

The overview NeedsYouStrip gains "lead call" items in the Sales-side tab. This requires real plumbing the queue does not have today (gaps blocker fix), enumerated here:

- **Server:** a new admin/manager-guarded endpoint (e.g., `GET /api/thumbtack/lead-call-attention`; exact mount decided in the plan) returning open attention rows: `lead_call_attempts` in status `missed`, `failed`, `skipped_after_hours`, or `skipped_unconfigured` / `skipped_invalid_phone`, younger than 7 days, joined to `thumbtack_leads` for `customer_name`, `proposal_id`, `client_id`. Driven FROM `lead_call_attempts`, so historical pre-feature leads (which have no attempt row) never surface.
- **Client:** a new fetch in `OverviewPage`, a new builder in `queueItems.js` feeding the Sales tab, a `QUEUE_ICON` entry, and a new link chain in `NeedsYouStrip.queueItemHref`: `target: 'proposal'` when `proposal_id` is set; a **new `'client'` target** (`/clients/:id`, route exists) when only `client_id` is set; neither set renders plain text (the existing targetless-row behavior). Labels: "missed call", "call failed", "after hours", "call misconfigured".
- **Clearing:** an item clears when it ages past 7 days or when the lead's status leaves `'new'`. Honest note (grounding finding): nothing else in the codebase writes `thumbtack_leads.status` today, and this feature's own successful bridge (which does flip it) never produces an attention item, so in practice the 7-day age is the operative clear; the status filter is forward-compat for future manual contact-tracking UI.

### 5.3 Call log visibility

The auto-drafted proposal's detail view shows a one-line call outcome for its lead ("connected, Dallas, 4m12s" / "missed" / "after hours"), read from `lead_call_attempts` via the lead's `proposal_id` linkage. Read-only, no new admin actions. Absent row (pre-feature TT proposals, non-TT proposals) renders nothing, not "unknown"; the line rides the proposal detail's existing fetch and loading state.

## 6. Error handling and edge cases

- **Webhook retries / heal path:** `ON CONFLICT (lead_id) DO NOTHING` makes call placement at-most-once per lead across every retry and heal combination.
- **Races and duplicate callbacks:** every state transition is a guarded UPDATE keyed on the expected prior status, and every billed or notifying side effect belongs to the claim winner only. Press-1 racing a status callback: first writer wins; the chain never advances past `connected`.
- **Crash windows:** any strand in a non-terminal status is reaped by the 30-minute sweeper (4.5) into a surfaced `failed`.
- **Missing phone:** a phoneless lead short-circuits to `skipped_invalid_phone` (detail `no_phone`) rather than crashing the tail.
- **Twilio API error placing a leg:** fail over to the next leg; only the last leg's failure ends the chain as `failed` with the admin email. Nothing retries automatically beyond that (retry storms cost money; needs-attention is the recovery path).
- **Voicemail:** answered-machine legs time out the Gather, the leg completes without a keypress, and the status callback advances the chain. No answering-machine detection needed.
- **Masked-relay quirks:** a relay that answers and drops shows as `connected` with near-zero `bridge_duration_sec`, does NOT flip the lead to `'contacted'` (4.1), and is exactly what the launch gate (section 8) and first-week eyeball exist to catch.
- **DST:** the window check uses the Intl-based America/Chicago helper (4.2), never a fixed UTC offset.
- **Signature verification:** all three voice endpoints fail closed in every environment (4.3). The `attempt` query param is a lookup key, not an authorization; the signature is the authorization.
- **Toll-fraud bounds:** validated +1-only, non-premium dial targets (4.2); at most 2 agent legs + 1 bridged lead leg per lead by construction; `timeLimit` caps every leg; the atomic rolling-24h `LEAD_CALL_DAILY_CAP` bounds the day; and the Zul leg is the only international one, to the same `VA_CELL` destination the existing IRSF-guarded flow already dials.

## 7. Testing

`node:test` suites following the `voice.test.js` / `telegram.test.js` stub pattern (`__setDeps`-style injection so no real Twilio, live signatures, or provider sends are needed):

- Briefing builder: full lead, each field absent, null lead, TTS date formatting, Chicago rendering of a UTC `event_date`, xmlEscape of hostile name/city strings.
- Trigger: window edges (7:59am, 8:00am, 8:59pm, 9:00pm Chicago, under DST and standard time), kill switch, atomic cap under concurrent inserts, cap-trip email dedupe, phone validation (non-US, premium 900/976, missing, valid 839 proxy), unconfigured combinations, `ON CONFLICT` idempotency under a simulated webhook retry, PK threading on both webhook paths, tail-never-throws.
- State machine: claim-then-call on both agent legs; admin-terminal advances to VA; admin `calls.create` failure fails over to VA; VA-terminal marks missed and notifies exactly once under a duplicated status callback; press-1 guard beats a racing callback; digit 9 replay cap; stale-attempt digit press and missing-row `/answer` both get apology TwiML; non-integer `CallDuration`; unknown `CallStatus` ignored; the 20-second `'contacted'` flip floor.
- Sweeper: reaps only non-terminal rows older than 30 minutes; reap sends the single email.
- Route hardening: signature-failure 403 in dev AND prod mode for all three endpoints; every TwiML interpolation escaped.

Server tests run one suite at a time against the shared dev DB (`node -r dotenv/config`), per standing convention.

## 8. Rollout and launch gate

1. Dallas adds the 224 to the Thumbtack business profile (the 888 is already there).
2. **Before the deploy**, set `LEAD_CALL_ENABLED=false` in Render (ship dark; the default is on, so the var must exist first). Schema applies idempotently.
3. **Live relay test (the go/no-go gate):** with Dallas on the line, enable (env flip restarts the service; do it in a quiet moment), and on the next masked (839) lead confirm the full chain: briefing plays, press 1, Thumbtack relay connects from the 224, two-way audio with the client. A relay refusal (drop, IVR wall, dead air) means flip the kill switch back off and rethink the lead-leg design (fallback candidate: briefing-only alert calls with manual dial-back from the TT app); do not ship a bridge that dead-ends clients.
4. First week: eyeball `lead_call_attempts` for near-zero `bridge_duration_sec` rows (silent relay failures) before trusting it unattended.

Cost at current volume: ~2.5 leads/day, worst case 3 legs each, minutes-long calls on a thin Twilio balance; well under existing VA-calling spend patterns, bounded by the caps above.

## 9. Config and documentation

Env vars (all existing unless noted):

| Variable | Role here |
|---|---|
| `ADMIN_PHONE` | Dallas's cell, ring-order slot 1 (already the admin-alert number). Unset: chain starts at Zul. |
| `VA_CELL` | Zul's cell, ring-order slot 2 (existing strict-E.164 rules; never normalized). Unset: chain is Dallas-only. |
| `TWILIO_PHONE_NUMBER` | Caller ID on agent legs (the 888). |
| `VOICE_CALLER_ID` | Caller ID on the lead leg (the 224). |
| `VA_CALL_TIME_LIMIT_SEC` | Per-leg hard time cap, reused as-is. |
| `LEAD_CALL_ENABLED` | **New.** Kill switch, default on; `false` disables the trigger entirely. |
| `LEAD_CALL_DAILY_CAP` | **New.** Max non-skipped attempt chains per rolling 24h, default 25. |

The 8:00am to 9:00pm window is a code constant (with the timezone), not an env var; it changes rarely and belongs under test.

Doc updates in the same change, per the mandatory-docs table: README (folder tree: `voiceLeadCall.js`, `leadCallBriefing.js`; env table; Key Features entry for the lead call bridge), ARCHITECTURE (route table: the three `/api/voice/lead/*` endpoints plus the attention endpoint; schema section: `lead_call_attempts`; util mention for `leadCallBriefing.js`), CLAUDE.md (env table: the two new vars), and `.env.example` (both new vars).

## 10. Sensitive-path note for the build

This lane touches outbound billed voice, a Twilio webhook surface, and the TT webhook tail. It should be treated as sensitive-path work: full review fleet on the lane, and the live-test gate in section 8 before the kill switch opens in prod.
