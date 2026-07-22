# Thumbtack Auto First-Reply (respond-then-ring)

**Date:** 2026-07-21 (rev 2, post design-review fleet)
**Status:** Approved in brainstorm (Dallas, 7/20-7/21); rev 2 folds in spec-grounding, spec-gaps, and spec-risk findings (both blockers and all warnings addressed below).
**Companion plan:** to be written after spec approval (`docs/superpowers/plans/`).

## 1. Why

The lead call bridge now rings the client before any response exists on Thumbtack. Thumbtack's guidance is respond-before-calling, and the platform response rate (plus response time) is a ranking input we currently leave on the table until Dallas replies by hand. The sanctioned messaging API exists but stamps messages with an automated-partner disclosure, which defeats the responsive-human signal.

The fix uses infrastructure we already trust: the email-harvester box drives the Thumbtack web UI inside Dallas's real logged-in session. Sending his saved quick reply through that session is indistinguishable from him tapping it himself. His flow today, which the agent replicates exactly: Jobs page, click Quick Reply on the new lead, choose the saved `day` or `night` template, Send; the lead then moves to Messages.

Wins: every lead (after-hours included, which today get nothing until morning) receives an on-platform response; the response rate metric covers 100% of leads; the day reply tells the client to expect a call, so the ring that follows lands as promised instead of cold; the respond-before-call concern evaporates.

## 2. Decisions (locked in brainstorm)

1. **Delivery path: the harvester-box UI automation, not the partner messaging API.** No partner badge, no API approval wait. Accepted tradeoff, stated plainly: outbound UI automation is a step past read-only scraping in ToS terms, on the primary lead channel, same account and machine as the existing harvesting. Dallas owns this risk and accepts it.
2. **Template selection maps to the call-eligibility decision at lead arrival:** `day` (promises a call) ONLY when the lead is in-window (8am to 9pm America/Chicago, via the exported `CALL_WINDOW_*` constants), calls are enabled, an agent phone is configured, AND the lead's phone passes `toUsE164`. Everything else gets `night`. This upholds the law the fleet caught rev 1 breaking: **the system never promises a call it will not place** (bad-phone and unconfigured leads previously got a day reply the trigger would then skip).
3. **Respond-then-ring ordering:** for day leads, the call chain fires when the agent confirms the reply was sent, not from the webhook tail.
4. **Sad-scraper fallback:** a day lead whose reply is unconfirmed after 3 minutes gets the call anyway; the reply goes out late when the agent recovers. The hot lead outranks perfect ordering.
5. **Freshness bound (new in rev 2):** the promise of a call expires. Callback- and sweep-fired calls only happen while the lead is younger than `FIRST_REPLY_CALL_MAX_AGE_MINUTES` (default 240). A staler day lead never gets a surprise call at 2am after an agent or flag recovers; it gets a fault row instead (5.4).
6. **Ship dark:** `TT_AUTOREPLY_ENABLED` defaults OFF. Off = byte-for-byte today's production flow (tail fires the call trigger directly). On only after a watched live test.
7. Template labels are matched against Dallas's saved quick replies, currently named exactly `day` and `night` (case-insensitive, trimmed).

## 3. Non-goals

- No partner messaging API integration.
- No free-text or per-lead message rendering; copy lives in Dallas's saved quick replies, curated in Thumbtack.
- No change to the call chain internals (legs, claims, caps, reaper, fault surfacing stay as shipped).
- No call retries, no morning calls (standing decisions).
- No change to email harvesting semantics (cadence sharing is 4.3's coordination, not a behavior change).

## 4. Architecture

### 4.1 Lead columns + index (mirror the `email_harvest_*` lease pattern on `clients`)

New on `thumbtack_leads` (idempotent):

```sql
first_reply_status TEXT NOT NULL DEFAULT 'not_needed'
  CHECK (first_reply_status IN ('not_needed','pending','sent','failed')),
first_reply_template TEXT CHECK (first_reply_template IN ('day','night')),
first_reply_attempted_at TIMESTAMPTZ,   -- lease/cooldown timestamp
first_reply_attempts INTEGER NOT NULL DEFAULT 0,
first_reply_sent_at TIMESTAMPTZ
```

Plus the partial index the harvester ships for its queue (grounding finding; without it the 25s poll seq-scans):

```sql
CREATE INDEX IF NOT EXISTS idx_thumbtack_leads_first_reply_pending
  ON thumbtack_leads(first_reply_attempted_at) WHERE first_reply_status = 'pending';
```

Lease semantics diverge from harvest in ONE deliberate way (risk finding: rev 1's "bounded by the lease cap" was illusory because transient failures never bump the counter): **the offer itself bumps `first_reply_attempts`** when it stamps `first_reply_attempted_at`. Offer number `MAX_FIRST_REPLY_ATTEMPTS + 1` flips the row to `failed` instead of offering. A dead-then-flapping agent therefore cannot re-offer a stale lead forever, and no failure report is needed to reach the cap. Definitive failures still short-circuit to `failed` immediately via the failure callback.

Backfill note: historical rows default `'not_needed'`; any future response-rate report over this column undercounts history by design.

### 4.2 Webhook tail change (`runPostCommitSteps`)

The lead-call step becomes a fork on `TT_AUTOREPLY_ENABLED`:

- **Off (default):** exactly today's code: `triggerLeadCall({ lead, leadId })` directly.
- **On:** call `enqueueFirstReply({ lead, leadId })`, which **lives in `server/utils/leadCallTrigger.js`** (grounding finding: it reuses the module-private `insertRow` helper and the window constants; colocating avoids exporting internals). Logic:
  1. Decide call eligibility exactly as the trigger would: window (`CALL_WINDOW_*` + `chicagoHourNow`), `LEAD_CALL_ENABLED`, agent phone configured, `toUsE164(lead.customerPhone)` valid. Eligible: template `day`. Not eligible: template `night`, AND insert the same attempt row the direct trigger would have inserted for that reason right now (`skipped_after_hours` / `skipped_unconfigured` / `skipped_invalid_phone`; calls-disabled inserts nothing, matching the kill switch's existing insert-nothing semantics). Call-log parity with today is exact.
  2. Guarded enqueue: `UPDATE thumbtack_leads SET first_reply_status='pending', first_reply_template=$2 WHERE id=$1 AND first_reply_status='not_needed'` (at-most-once under retries and the heal path).
  3. **Enqueue-failure fallback (risk blocker fix):** any throw inside `enqueueFirstReply` is caught and answered with the direct `triggerLeadCall({ lead, leadId })` (today's behavior: call without reply, worst case). The reply path must never be able to lose the call. The tail's never-throw and bare-`pool.query` laws hold throughout.

### 4.3 Agent work loop (thumbtack-agent, box-only)

The agent stays a SINGLE loop over its single browser context, single throttle, single session-recovery path (grounding finding; no concurrent second loop). The loop tick becomes `REPLY_POLL_INTERVAL_MS` (default 25000); reply jobs are polled every tick, and the harvest poll piggybacks every Nth tick to preserve its ~5-minute cadence. Reply sends draw from their own modest daily counter (`REPLY_DAILY_CAP`, default 40).

- `GET /api/admin/thumbtack/pending-first-replies?limit=N` (agent-secret only). Returns `[]` when `TT_AUTOREPLY_ENABLED` is not `'true'`. Offers: `negotiation_id`, `customer_name`, `first_reply_template`, `created_at`. Offer-side rules:
  - Lease + attempts-bump per 4.1; cooldown `FIRST_REPLY_COOLDOWN_INTERVAL` (default `'10 minutes'`).
  - **Offer-time downgrade (risk finding):** a `day` row offered while `LEAD_CALL_ENABLED` is `'false'` is flipped to `night` in the DB before offering, shrinking the false-promise window from queue-depth to seconds.
  - **Night jitter (risk finding, detectability):** night rows are withheld until `created_at + (2 + id % 13) minutes`, so night replies land minutes-spread instead of a constant 25 seconds after every 3am lead. Day rows offer immediately (call ordering dominates, and instant daytime replies read as an eager pro).
- UI flow per job: navigate deterministically to the lead (per-negotiation URL, the harvester's `priceEstimateUrl` precedent; the Jobs-page name match is the fallback, and an ambiguous name match is a definitive failure, never a guess), click Quick Reply, select the template whose visible label case-insensitively equals the offered template, Send, verify the thread exists under Messages.
- Report back (validation parity with `harvest-failed`: `negotiation_id` required and trimmed, enums 400 on unknown values):
  - `POST /api/admin/thumbtack/first-reply-sent { negotiation_id, template }`.
  - `POST /api/admin/thumbtack/first-reply-failed { negotiation_id, reason }` with `reason` in a fixed set: `template_not_found`, `lead_not_found`, `quick_reply_unavailable`, `send_unverified`, `ambiguous_lead`. Definitive: straight to `failed`. Transient troubles are not reported; the lease cooldown re-offers and the offer-side attempts cap bounds them.
- Selector fragility is accepted and owned like the harvester's.

### 4.4 Reply-sent callback (server)

`first-reply-sent` (agent-secret only):

1. Guarded flip WITH the trigger's inputs returned (gaps blocker fix): `UPDATE thumbtack_leads SET first_reply_status='sent', first_reply_sent_at=NOW() WHERE negotiation_id=$1 AND first_reply_status='pending' RETURNING id, customer_phone, first_reply_template, created_at` (rowCount 0 = duplicate report, no-op).
2. The call decision reads the RETURNED `first_reply_template` (the DB is the source of truth; the posted `template` is logged for mismatch visibility but never trusted, so a forged body cannot influence the trigger).
3. If the flip won AND template is `day` AND the lead is younger than `FIRST_REPLY_CALL_MAX_AGE_MINUTES`: invoke `triggerLeadCall({ lead: { customerPhone: row.customer_phone }, leadId: row.id, skipWindowCheck: true })`. **The lead-shape construction is explicit and mandatory** (gaps blocker: the trigger reads camelCase `lead.customerPhone`; passing a raw snake_case row would silently kill every day call as `skipped_invalid_phone`). Tests must exercise the real row shape.
4. Staler than the bound: no call; insert a `failed` attempt row with detail `reply_confirmed_late` (surfaces once in the fault feed).

`skipWindowCheck` is a new optional flag on `triggerLeadCall`, default false, bypassing ONLY the window gate (kill switch, config, phone validation, cap all still apply); the direct-tail path never sets it. An 8:58pm lead confirmed at 9:02pm calls; the freshness bound (not the window) is what stops pathological late calls.

### 4.5 Fallback + hygiene sweep (server, 60s)

Gated by `RUN_SCHEDULERS` + `RUN_FIRST_REPLY_FALLBACK_SCHEDULER` (default on). **Explicitly NOT gated by `TT_AUTOREPLY_ENABLED`** (gaps finding): after a rollback flip, the sweep must keep draining in-flight day leads; the rollback runbook (7.4) says so. Two arms, both bounded and re-entrant:

- **Arm A, call fallback:** day-template leads still `pending`, older than `FIRST_REPLY_FALLBACK_MINUTES` (default 3), younger than `FIRST_REPLY_CALL_MAX_AGE_MINUTES`, with no `lead_call_attempts` row, skipped while `LEAD_CALL_ENABLED` is `'false'` (no busy-loop against the kill switch). `LIMIT 3` per tick, triggers awaited sequentially (risk finding: a post-outage catch-up must not ring the house down in one minute; later ticks drain the rest). Same explicit lead-shape construction as 4.4. Does NOT touch `first_reply_status` (the reply still goes out late; response rate banked).
- **Arm B, strand hygiene (risk blocker's second half + wedge visibility):** rows that fell out of the machine get turned into visible facts instead of silent losses:
  - Day leads `pending` past the freshness bound with no attempt row: insert a `failed` attempt row, detail `reply_stale` (one-time; surfaces in the fault feed, which is exactly the "agent wedged" alarm the week-one watch needs).
  - Flag-on-era leads stuck `not_needed` younger than 24h with no attempt row (the enqueue-crash strand the heal path cannot reach because `proposal_id` is already set): run `enqueueFirstReply` for them now.

Idempotency: callback/sweep races funnel into `triggerLeadCall`, whose `lead_id UNIQUE` open makes double-fire placement-safe and email-safe (one attempt row, one chain, the existing claim-winner email rules).

### 4.6 Failure surfacing

A `failed` first reply is logged and visible on the lead (4.7); it is NOT emailed. Rationale, corrected per the fleet: the reply path can no longer lose a call (enqueue falls back to the direct trigger; the sweep backstops confirmation), so a failed reply costs only response-rate points. Wedge-scale sickness surfaces through Arm B's `reply_stale` fault rows and the week-one pending-age check (7.5). Existing lead-call fault alerting untouched.

### 4.7 Visibility (named consumers, grounding finding)

`proposals/getOne.js` adds a `first_reply` object (status, template, sent_at; null when `not_needed`) beside the existing `lead_call` block, and `ProposalDetail.js` renders one more muted line ("First reply: sent (day, 8:14 PM)" / "failed" / "pending"). No other consumer in v1.

## 5. Edge cases

- **Webhook retries / heal path:** `not_needed -> pending` guard = at-most-once enqueue; heal re-runs are silent no-ops; the enqueue-crash strand is healed by sweep Arm B.
- **Duplicate agent reports:** absorbed by the `pending -> sent` guard; day trigger fires only for the flip winner; trigger idempotent regardless.
- **Kill flip with a queued day backlog:** offer-time downgrade converts them to night at the next offer; already-offered ones hit the trigger's own kill switch (reply sent, no call, nothing inserted, matching kill semantics); sweep Arm A skips while killed; the freshness bound retires anything that outlives the flip.
- **Agent down for hours:** day calls fire via Arm A at +3 minutes; night replies drain late (jitter bound + attempts cap + freshness make "absurdly late" impossible: the offer cap retires the row); wedged rows become `reply_stale` fault rows.
- **Template renamed in TT:** `template_not_found` definitive failure; calls unaffected (Arm A). Live-test checklist pins the labels (`day`, `night` today).
- **Client replies first:** agent sends anyway; the message webhook ingests their reply as today.
- **`agentLimiter` headroom:** the 20/min agent-surface limiter must absorb the 25s poll + harvest poll + callback bursts during drains; the plan verifies and bumps it if needed (risk suggestion).

## 6. Testing

Server (`node:test`, shared-dev-DB law, existing seams):

- Enqueue: full template decision matrix (in-window, after-hours, calls-disabled, bad phone, unconfigured), skip-row parity with the direct trigger per reason, at-most-once under retry/heal, enqueue-throw falls back to direct trigger (the call survives a dead enqueue), OFF flag preserves today's path byte-for-byte.
- Offer endpoint: lease + offer-side attempts bump + cap-to-failed, cooldown re-offer, night jitter withholding, day-to-night downgrade while calls killed, kill switch returns `[]`, agent-secret only.
- Callback: guarded flip returns the trigger inputs; duplicate no-op; day flip fires trigger with the CONSTRUCTED lead shape (test passes the real snake_case row through the real code path and asserts the dial-target validation passes: this is the regression test for the gaps blocker); night flip never fires; stale flip inserts `reply_confirmed_late` and never calls; body validation 400s.
- `skipWindowCheck`: bypasses only the window gate; every other gate enforced; default-false untouched (existing suites keep passing).
- Sweep: Arm A bounds (threshold, freshness, no-attempt-row, kill-switch skip, LIMIT + sequential), callback/sweep double-fire = one chain; Arm B stale-marking one-time and `not_needed` re-enqueue; scheduler flags gate it; NOT gated by the autoreply flag.
- Failure callback: reason enum, definitive-to-failed, unknown 400.

Agent: no automated harness (harvester precedent); staged live test below. Selector code review only.

## 7. Rollout (staged, Dallas-driven gates)

1. Ship with `TT_AUTOREPLY_ENABLED` unset (OFF): prod unchanged.
2. Deploy the box agent update; restart the systemd service; it polls, gets `[]`, idles.
3. **Live test:** flip `TT_AUTOREPLY_ENABLED=true` in Render at a quiet in-window moment. Next lead: quick reply lands on TT within ~30s (Dallas eyeballs Messages), the call fires only after it, ProposalDetail shows "First reply: sent". Then one after-hours lead: night reply on a minutes-jitter, no call.
4. No-go: flip the flag off. New leads instantly revert to direct-call; **leave the fallback sweep on until `pending` drains** (it is deliberately not gated by the flag).
5. Week one: watch `first_reply_status='failed'` counts, any `reply_stale` fault rows, and the wedge signal `pending` rows older than an hour.

## 8. Config and documentation

| Variable | Where | Role |
|---|---|---|
| `TT_AUTOREPLY_ENABLED` | Render | **New.** Master switch, default OFF. Gates the tail fork and empties the offer endpoint. Does NOT gate the sweep. |
| `FIRST_REPLY_FALLBACK_MINUTES` | Render | **New.** Day-lead call fallback threshold, default 3. |
| `FIRST_REPLY_CALL_MAX_AGE_MINUTES` | Render | **New.** Freshness bound on callback/sweep calls, default 240. |
| `RUN_FIRST_REPLY_FALLBACK_SCHEDULER` | Render | **New.** Per-scheduler disable, default on, `RUN_SCHEDULERS` wins. |
| `MAX_FIRST_REPLY_ATTEMPTS` | Render | **New.** Offer cap before `failed`, default 3. |
| `FIRST_REPLY_COOLDOWN_INTERVAL` | Render | **New.** Lease re-offer interval, default `'10 minutes'`. |
| `REPLY_POLL_INTERVAL_MS` | Box agent env (`thumbtack-agent/.env.example`) | **New.** Loop tick, default 25000; harvest piggybacks every Nth tick. |
| `REPLY_DAILY_CAP` | Box agent env | **New.** Agent-side reply cap, default 40. |
| `LEAD_CALL_ENABLED` | existing | Consulted at enqueue AND at offer (day-to-night downgrade) AND inside the trigger. |

Docs in the same change: README (env table, Key Features: update the now-stale "overnight leads log only" line, thumbtack-agent section), ARCHITECTURE (thumbtackAgent route table: three new endpoints; `thumbtack_leads` schema: five columns + partial index; lead-call feature section: respond-then-ring ordering), CLAUDE.md (env rows; **note the enlarged `THUMBTACK_AGENT_SECRET` blast radius**: the secret now reads customer names, can trigger window-bypassed call chains one-shot per pending day lead, and can suppress replies; leak response = rotate secret + flip `TT_AUTOREPLY_ENABLED` and `LEAD_CALL_ENABLED`), root `.env.example` AND `thumbtack-agent/.env.example`.

## 9. Sensitive-path note for the build

The lane touches the webhook tail, the call trigger's gate structure, and the agent-secret surface: sensitive-path work, full fleet on the lane, staged rollout gates before the flag goes on in prod.
