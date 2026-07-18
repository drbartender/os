# Thumbtack Lead Call Bridge (real-time first-ring)

**Date:** 2026-07-18
**Status:** Approved in brainstorm (Dallas, 7/18). Section-by-section approvals are the approval.
**Companion plan:** to be written after spec review (`docs/superpowers/plans/`).

## 1. Why

Speed-to-lead is the single biggest conversion lever on Thumbtack: the first pro to reach the client by voice usually wins the job. The auto-draft pipeline already answers in-platform instantly; this feature adds the human-voice follow-up within a minute of the lead arriving, without anyone watching a dashboard.

When a lead lands, the system calls Dallas first. He hears a short spoken briefing of the lead, and presses 1 to be bridged to the client. If he does not pick up (or passes), the system tries Zul the same way. If both miss, the lead is logged for manual follow-up. No availability toggles, no UI to babysit.

Verified against production data (60 days to 2026-07-18, 148 leads):

- 100% of leads carry `customer_phone` in the webhook payload at creation time.
- 100% have `event_date`, 147/148 have `guest_count`, 100% have `location_city`. The briefing essentially never comes up empty.
- 27/148 (18%) arrive outside the 8am to 9pm Chicago window.
- Since 2026-06-08, Thumbtack masks most lead phones: 103/148 recent leads carry a unique 839 area-code proxy number (100 distinct proxies observed) that relays through Thumbtack. The remainder are real client numbers (Chicago-area codes). See section 8 (launch gate) for the relay implications.
- Volume is ~2.5 leads/day, so call spend is negligible and a modest daily cap is purely a fraud backstop.

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
- No changes to the auto-draft pipeline, harvester, or existing VA calling (Telegram) flow beyond sharing utilities.

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
                                     'skipped_unconfigured','failed')),
  answered_by    TEXT CHECK (answered_by IN ('admin','va')),
  admin_call_sid TEXT,
  va_call_sid    TEXT,
  bridge_started_at   TIMESTAMPTZ,
  bridge_duration_sec INTEGER,
  detail         TEXT,          -- terse machine note: twilio error code, skip reason
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`lead_id UNIQUE` is the idempotency guard: Thumbtack retries webhooks, and the trigger inserts with `ON CONFLICT (lead_id) DO NOTHING`; only the insert winner places a call. On a successful bridge, also flip `thumbtack_leads.status` to `'contacted'` (cross-cutting consistency with the lead lifecycle enum).

### 4.2 Trigger point: the webhook post-commit tail

`runPostCommitSteps` in `server/routes/thumbtack.js` (the existing best-effort tail that runs the auto-draft and admin notification, after the lead transaction commits and the pooled client is released) gains a third step: `triggerLeadCall({ lead })`. Properties it must keep:

- **Never blocks or fails the webhook response.** Any error is caught, logged, sent to Sentry, and recorded on the attempt row as `failed`. Thumbtack sees its normal 200/503 semantics unchanged.
- **Takes no DB client from the caller** (pool-deadlock rule for the post-commit tail); it uses `pool.query()` directly.
- **Runs on the heal path too** (duplicate webhook with `proposal_id` NULL): the `ON CONFLICT DO NOTHING` insert makes the call side effect at-most-once regardless of which path fires it.

`triggerLeadCall` logic, in order:

1. Kill switch: `LEAD_CALL_ENABLED=false` means insert nothing, do nothing (redeploy-free off switch, `HARVESTER_ENABLED` precedent).
2. Window check in America/Chicago at now(): outside 08:00 to 20:59:59 inserts the row as `skipped_after_hours` and stops.
3. Config check: no `ADMIN_PHONE` and no `VA_CELL` inserts `skipped_unconfigured` and stops. (One missing is fine: the chain just starts at, or skips to, the configured leg.)
4. Daily cap check: count of today's non-skipped attempts >= `LEAD_CALL_DAILY_CAP` (default 25) inserts `failed` with detail `cap_tripped` and stops. Pure toll-fraud backstop; normal volume is ~2.5/day.
5. Insert the row as `pending` with `ON CONFLICT (lead_id) DO NOTHING`; if no row was inserted (duplicate), stop.
6. Place the admin leg via the shared Twilio call helper and advance the row to `calling_admin` with the call SID. A `calls.create` failure marks the row `failed` (detail = Twilio error code) and emails admin.

Outbound dialing is gated identically to `sendSMS` / `placeBridgedCall` (`SEND_NOTIFICATIONS` / `NODE_ENV` gate in `server/utils/sms.js`): a dev server against the shared DB logs and skips, never dials the live auto-refill Twilio account. The gate is load-bearing; this is a billed-voice primitive.

### 4.3 Call flow (Twilio webhooks)

New route file `server/routes/voiceLeadCall.js` mounted at `/api/voice/lead` (keeps `voice.js` single-concern; same Twilio signature middleware, imported or extracted from `voice.js`). Three endpoints, all POST, all signature-verified with the existing fail-closed-in-prod / warn-in-dev semantics:

- **`/api/voice/lead/answer?attempt=<id>&leg=<admin|va>`** : the `url` on each agent leg. Returns TwiML: `<Gather numDigits="1" timeout="10" action=".../digit?attempt=..&leg=..">` wrapping a `<Say>` of the briefing (section 4.4), then a second `<Say>` of the briefing (one automatic repeat), then hang up. Answered-but-no-keypress (including voicemail) therefore ends the leg naturally and the status callback advances the chain.
- **`/api/voice/lead/digit`** : Gather action. Digit `1`: guard-update the attempt (`UPDATE ... SET status='connected', answered_by=$leg, bridge_started_at=NOW() WHERE id=$1 AND status IN ('calling_admin','calling_va')`); if the guard matched, respond `<Dial answerOnBridge="true" callerId="<VOICE_CALLER_ID>" timeLimit="<VA_CALL_TIME_LIMIT_SEC>"><Number statusCallback=".../status?...leg=lead">lead phone</Number></Dial>`; if it did not match (stale/duplicate webhook), apologize-and-hangup TwiML. Digit `9`: replay the Gather (max 3 total plays, then hang up). Any other digit: hang up (status callback advances).
- **`/api/voice/lead/status`** : `statusCallback` for all legs. On a terminal agent-leg status (`no-answer`, `busy`, `failed`, `canceled`, or `completed` while the row is still `calling_*`), advance under the same status-guarded UPDATE pattern: admin leg terminal moves to the VA leg (place call, `calling_va`); VA leg terminal marks `missed` and fires the missed-lead notification (section 5). The guard means a press-1 that raced the callback wins and the chain never advances past `connected`. On the lead-leg terminal status, record `bridge_duration_sec` from Twilio's `CallDuration`.

Agent legs are placed with `timeout: 25` (ring seconds) so an unanswered leg fails over in under 30 seconds. The lead's dialed number is `thumbtack_leads.customer_phone` verbatim (E.164 from the payload; it is either the real number or Thumbtack's 839 proxy, both dialable). It is never run through `normalizePhone` for dialing.

The existing `placeBridgedCall` in `server/utils/sms.js` is reused for call placement (it is already generic: `{ to, callerId, url, statusCallback, timeLimit }`); it gains an optional `timeout` passthrough. Its dev-gate and logging stay untouched; `cancelBridgedCall` remains available for the same persist-failure edge it covers today (a call SID that cannot be written to the attempt row gets a best-effort cancel so nobody answers into a dead bridge).

### 4.4 Briefing builder

`server/utils/leadCallBriefing.js`: a pure function `buildLeadBriefing(lead)` returning the spoken text, for example:

> "New Thumbtack lead: Sarah M. Wedding, Saturday October 10th, 6 PM, 120 guests, Naperville. Press 1 to call them now. Press 9 to hear this again."

Rules: fields render in that order (name, category, event date and time in America/Chicago with weekday, guest count, city); any absent field is skipped, never spoken as "unknown"; date formatting is TTS-friendly (no numeric `10/10 18:00`). Pure function, no DB, unit-tested directly. TwiML uses the default `<Say>` voice; voice selection is not a v1 concern.

## 5. Missed-lead surfacing

When a chain ends `missed` (and for `failed`):

1. **Admin email** via the existing `notifyAdminCategory` fan-out, new category `lead_call` added to `VALID_CATEGORIES` (and to the notification-preferences default set). Email only; no SMS.
2. **Needs-attention queue**: the overview NeedsYouStrip gains `missed lead call` items in the Sales-side tab, sourced the same way as the other queue categories, with `target: 'proposal'` linking to the auto-drafted proposal (`thumbtack_leads.proposal_id`); a lead with no proposal falls back to the client record. The item clears when the lead's status leaves `'new'` (Dallas or Zul made contact through any channel) or the lead is older than 7 days.
3. **Call log visibility**: the auto-drafted proposal's detail view shows a one-line call outcome for its lead (`connected, Dallas, 4m12s` / `missed` / `after hours`), read from `lead_call_attempts`. Read-only; no new admin actions.

`skipped_after_hours` rows surface through the same needs-attention item (they are exactly the "call these in the morning" list) but do NOT fire the admin email; the existing new-lead notification already covered arrival.

## 6. Error handling and edge cases

- **Webhook retries / heal path:** `ON CONFLICT (lead_id) DO NOTHING` makes call placement at-most-once per lead across every retry and heal combination.
- **Race between press-1 and the status callback:** every state transition is a guarded UPDATE keyed on the expected prior status; the first writer wins and later webhooks no-op.
- **Missing phone:** 100% coverage today, but a phoneless lead short-circuits to `skipped_unconfigured` with detail `no_phone` rather than crashing the tail.
- **Twilio API error placing any leg:** the row goes `failed` with the error code in `detail`, admin gets the `lead_call` email, and nothing retries automatically (retry storms cost money; the needs-attention row is the recovery path).
- **Voicemail:** answered-machine legs time out the Gather, the leg completes without a keypress, and the status callback advances the chain. No answering-machine detection needed.
- **Masked-relay quirks:** if Thumbtack's relay answers and immediately drops (unrecognized caller), the symptom is a `connected` row with `bridge_duration_sec` near zero. The launch gate (section 8) exists to catch this before the feature is trusted; the call log makes it visible afterward.
- **DST:** the window check uses an America/Chicago-aware comparison (the codebase's existing Chicago-time pattern), never a fixed UTC offset.
- **Signature verification:** all three voice endpoints sit behind the same Twilio signature gate as `voice.js` (403 in prod on failure, Sentry warning tagged, dev warn-and-allow). The `attempt` query param is a lookup key, not an authorization; the signature is the authorization.
- **Toll-fraud bounds:** at most 2 agent legs + 1 bridged lead leg per lead by construction, `timeLimit` caps every leg, `LEAD_CALL_DAILY_CAP` bounds the day, and the Zul leg is the only international one (same `VA_CELL` destination the existing IRSF-guarded flow already dials).

## 7. Testing

`node:test` suites following the `voice.test.js` / `telegram.test.js` stub pattern (`__setDeps`-style injection so no real Twilio, Neon writes beyond the shared-dev-DB rules, or webhook signatures are needed):

- Briefing builder: full lead, each field absent, TTS date formatting, Chicago rendering of a UTC `event_date`.
- Trigger: window edges (7:59am, 8:00am, 8:59pm, 9:00pm Chicago, judged under DST and standard time), kill switch, cap trip, unconfigured combinations, `ON CONFLICT` idempotency under a simulated webhook retry, tail-never-throws.
- State machine: admin-terminal advances to VA; VA-terminal marks missed and notifies; press-1 guard beats a racing status callback; digit 9 replay cap; stale-attempt digit press gets the apology TwiML.
- Route hardening: signature-failure 403 in prod mode; the lead leg's `<Dial>` XML-escapes interpolated values (existing `xmlEscape` pattern).

Server tests run one suite at a time against the shared dev DB (`node -r dotenv/config`), per standing convention.

## 8. Rollout and launch gate

1. Dallas adds the 224 to the Thumbtack business profile (the 888 is already there).
2. Ship dark: deploy with `LEAD_CALL_ENABLED=false`; schema applies idempotently.
3. **Live relay test (the go/no-go gate):** with Dallas on the line, enable, and on the next masked (839) lead confirm the full chain: briefing plays, press 1, Thumbtack relay connects from the 224, two-way audio with the client. A relay refusal (drop, IVR wall, dead air) means flip the kill switch back off and rethink the lead-leg design (fallback candidate: briefing-only alert calls with manual dial-back from the TT app); do not ship a bridge that dead-ends clients.
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
| `LEAD_CALL_DAILY_CAP` | **New.** Max non-skipped attempt chains per day, default 25. |

The 8:00am to 9:00pm window is a code constant (with the timezone), not an env var; it changes rarely and belongs under test.

Doc updates in the same change, per the mandatory-docs table: README (folder tree: `voiceLeadCall.js`, `leadCallBriefing.js`; env table), ARCHITECTURE (route table: the three `/api/voice/lead/*` endpoints; schema section: `lead_call_attempts`), CLAUDE.md (env table: the two new vars).

## 10. Sensitive-path note for the build

This lane touches outbound billed voice, a Twilio webhook surface, and the TT webhook tail. It should be treated as sensitive-path work: full review fleet on the lane, and the live-test gate in section 8 before the kill switch opens in prod.
