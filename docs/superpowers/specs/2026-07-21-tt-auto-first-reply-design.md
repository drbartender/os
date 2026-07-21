# Thumbtack Auto First-Reply (respond-then-ring)

**Date:** 2026-07-21
**Status:** Approved in brainstorm (Dallas, 7/20-7/21). Section-by-section approvals are the approval.
**Companion plan:** to be written after spec review (`docs/superpowers/plans/`).

## 1. Why

The lead call bridge now rings the client before any response exists on Thumbtack. Thumbtack's guidance is respond-before-calling, and the platform response rate (plus response time) is a ranking input we currently leave on the table until Dallas replies by hand. The sanctioned messaging API exists but stamps messages with an automated-partner disclosure, which defeats the responsive-human signal.

The fix uses infrastructure we already trust: the email-harvester box drives the Thumbtack web UI inside Dallas's real logged-in session. Sending his saved quick reply through that session is indistinguishable from him tapping it himself. His flow today, which the agent will replicate exactly: Jobs page, click Quick Reply on the new lead, choose the saved `day` or `night` template, Send; the lead then moves to Messages.

Wins: every lead (after-hours included, which today get nothing until morning) receives an on-platform response within about a minute; the response rate metric covers 100% of leads; the day reply tells the client to expect a call, so the ring that follows lands as promised instead of cold; the respond-before-call concern evaporates.

## 2. Decisions (locked in brainstorm)

1. **Delivery path: the harvester-box UI automation, not the partner messaging API.** No partner badge, no API approval wait. Accepted tradeoff, stated plainly: outbound UI automation is a step past read-only scraping in ToS terms, on the primary lead channel, same account and machine as the existing harvesting. Dallas owns this risk and accepts it.
2. **Template selection maps to the existing call window** (8am to 9pm America/Chicago, decided at lead arrival): in-window leads get the `day` quick reply (promises a call); out-of-window leads get the `night` quick reply (no call, unchanged behavior). Template labels are matched against Dallas's saved quick replies, which are currently named exactly `day` and `night` (match case-insensitive, trimmed).
3. **Respond-then-ring ordering:** for day leads, the call chain fires when the agent confirms the reply was sent, not from the webhook tail.
4. **Sad-scraper fallback:** a day lead whose reply is unconfirmed after 3 minutes gets the call anyway; the reply goes out late when the agent recovers. Never lose the lead to a stuck browser. (Policy is deliberate: the hot lead outranks perfect ordering on the rare bad day.)
5. **Kill-switch interplay:** if `LEAD_CALL_ENABLED=false` (calls disabled) while auto-reply is on, every lead gets the `night` template. The day reply promises a call; the system must never promise a call it will not place.
6. **Ship dark:** the new `TT_AUTOREPLY_ENABLED` flag defaults OFF (unlike the harvester's default-on). With it off, behavior is byte-for-byte today's production flow (tail fires the call trigger directly). It goes on only after a watched live test.

## 3. Non-goals

- No partner messaging API integration (revisit only if TT ever drops the automation badge or cracks down on UI automation).
- No free-text or per-lead message rendering; the copy lives in Dallas's saved quick replies inside Thumbtack, curated there.
- No change to the call chain itself (legs, claims, caps, reaper, surfacing all stay as shipped).
- No retry of the call, no morning call for night leads (standing decisions).
- No change to email harvesting; it keeps its own queue and cadence. (The agent MAY combine visits later; not in scope.)

## 4. Architecture

### 4.1 Lead columns (mirror the proven `email_harvest_*` lease pattern on `clients`)

New columns on `thumbtack_leads` (idempotent `ADD COLUMN IF NOT EXISTS`):

```sql
first_reply_status TEXT NOT NULL DEFAULT 'not_needed'
  CHECK (first_reply_status IN ('not_needed','pending','sent','failed')),
first_reply_template TEXT CHECK (first_reply_template IN ('day','night')),
first_reply_attempted_at TIMESTAMPTZ,   -- lease/cooldown timestamp (pending-harvest semantics)
first_reply_attempts INTEGER NOT NULL DEFAULT 0,
first_reply_sent_at TIMESTAMPTZ
```

The lease semantics are the harvester's: `pending-first-replies` offers rows that are `pending` AND (`attempted_at` IS NULL OR older than the cooldown); offering stamps `attempted_at`; only the failure callback bumps `attempts`; attempts at the cap flip to `failed`.

### 4.2 Webhook tail change (`runPostCommitSteps`)

The lead-call step becomes a fork on `TT_AUTOREPLY_ENABLED`:

- **Off (default):** exactly today's code path: `triggerLeadCall({ lead, leadId })` fires directly from the tail.
- **On:** the tail calls `enqueueFirstReply({ lead, leadId })` instead:
  1. Decide the template: `day` when `8 <= chicagoHourNow() < 21` AND `LEAD_CALL_ENABLED` is not `'false'`; else `night`.
  2. Guarded enqueue: `UPDATE thumbtack_leads SET first_reply_status='pending', first_reply_template=$2 WHERE id=$1 AND first_reply_status='not_needed'` (at-most-once under webhook retries and the heal path, same guard shape as the harvest flag flip).
  3. **Night leads:** also insert the `skipped_after_hours` attempt row immediately (via the existing insert helper), keeping the call log exactly as complete as today. No further call logic ever runs for them.
  4. **Day leads:** no attempt row yet; the call chain starts at reply confirmation (4.4) or the fallback sweep (4.5). Both paths funnel into the unchanged `triggerLeadCall`, whose `ON CONFLICT (lead_id)` idempotency makes double-fire (callback + sweep racing) placement-safe by construction.

Same tail laws as today: never throws to the webhook, bare `pool.query` only.

### 4.3 Agent work loop (thumbtack-agent, box-only)

A second, faster poll loop beside the 5-minute harvest loop:

- `GET /api/admin/thumbtack/pending-first-replies?limit=N` (agent-secret only, same `agentSecretOnly` gate). Returns `[]` when `TT_AUTOREPLY_ENABLED` is not `'true'` (server-side kill switch, `pending-harvest`/`HARVESTER_ENABLED` precedent), else offers leased rows: `negotiation_id`, `customer_name`, `first_reply_template`.
- Poll cadence: `REPLY_POLL_INTERVAL_MS`, default 25000 (agent env). The endpoint is one cheap indexed query; 25s keeps first ring roughly under a minute after the lead.
- UI flow per job, replicating Dallas exactly: open the Jobs page, locate the new lead (newest first; match on customer name from the offer), click Quick Reply, select the saved template whose visible label case-insensitively equals the offered template (`day` / `night`), click Send, verify the thread now exists under Messages.
- Report back:
  - `POST /api/admin/thumbtack/first-reply-sent { negotiation_id, template }` on success.
  - `POST /api/admin/thumbtack/first-reply-failed { negotiation_id, reason }` on a definitive failure (template label not found, lead not on Jobs page). Transient failures just release the lease (cooldown re-offer), mirroring harvest retry semantics; `MAX_FIRST_REPLY_ATTEMPTS` (default 3) then flips to `failed`.
- Selector fragility is accepted and owned like the harvester's (the box agent is already the maintenance surface for TT UI drift).

### 4.4 Reply-sent callback (server)

`first-reply-sent` (agent-secret only, same auth family as `email-harvested`):

1. Guarded flip: `SET first_reply_status='sent', first_reply_sent_at=NOW() WHERE negotiation_id=$1 AND first_reply_status='pending'` (rowCount 0 = duplicate report, no-op).
2. If the flip won AND `first_reply_template='day'`: invoke `triggerLeadCall({ lead, leadId, skipWindowCheck: true })`. The window was decided at arrival; a reply confirmed at 9:02pm on an 8:58pm lead still calls, because the day reply promised one. Every other trigger gate (kill switch, config, phone validation, cap, idempotent open) applies unchanged. `skipWindowCheck` is a new optional flag on `triggerLeadCall`, defaulting false; the direct-tail path never sets it.

### 4.5 Fallback sweep (server)

A 60-second interval in the scheduler block (gated by `RUN_SCHEDULERS` like its siblings, per-flag `RUN_FIRST_REPLY_FALLBACK_SCHEDULER` default on): one query for day leads still `pending` past `FIRST_REPLY_FALLBACK_MINUTES` (default 3) with no `lead_call_attempts` row, then `triggerLeadCall({ lead, leadId, skipWindowCheck: true })` for each. Idempotency notes:

- The sweep does NOT touch `first_reply_status`; the reply job stays queued and goes out late when the agent recovers (response rate still banked).
- Callback-vs-sweep races are safe: both funnel into `triggerLeadCall`, and the attempt row's `lead_id UNIQUE` guarantees one chain.
- The no-attempt-row filter makes the sweep itself re-entrant across ticks.

### 4.6 Failure surfacing

A `failed` first reply is logged, visible on the lead, and NOT emailed: the day-lead call already fired via the fallback (the lead was never at risk), and the response-rate cost of one missed reply is soft. Persistent agent sickness already has its own signals (harvest queue backing up). The existing lead-call fault alerting is untouched.

## 5. Edge cases

- **Webhook retries / heal path:** the `not_needed -> pending` guard makes the enqueue at-most-once; a heal re-run on an already-enqueued lead is a silent no-op.
- **Duplicate agent reports:** the `pending -> sent` guard absorbs them; the day trigger only fires for the flip winner, and `triggerLeadCall` is idempotent anyway.
- **Lead arrives at 8:58pm, reply confirmed 9:02pm:** calls (promise made). Lead arrives 9:01pm: night template, no call, `skipped_after_hours` logged at arrival exactly as today.
- **`LEAD_CALL_ENABLED=false` mid-stream:** enqueue-time check sends `night` for new leads; a day lead already enqueued whose callback lands after the flip still hits the trigger's own kill switch and dials nothing (reply sent, no call; acceptable during a manual kill).
- **Agent down for hours:** day leads call via the sweep at +3 minutes (today's behavior, minus a 3-minute delay); replies drain late when the agent returns; leases and the attempts cap prevent a thundering re-send of stale leads. A reply that would go out absurdly late is bounded by the lease cap, not a time guard, keeping v1 simple; Dallas curates the quick-reply copy so even a late night reply reads fine.
- **Template renamed/deleted in TT:** definitive failure path, `failed` after the cap; calls unaffected (sweep). The live-test checklist pins the labels (`day`, `night` today).
- **Client replies before our reply sends:** the agent sends anyway (thread exists; quick reply still valid). The message webhook ingests their reply as today; no interaction.

## 6. Testing

Server (`node:test`, shared-dev-DB law, stubs via existing seams):

- Enqueue: template decision matrix (in-window, after-hours, calls-disabled), at-most-once under retry/heal, night path inserts `skipped_after_hours` exactly once, tail never throws, OFF flag preserves today's direct-call path byte-for-byte (trigger called from tail, no columns touched).
- Callback: guarded flip, duplicate report no-op, day flip fires trigger with `skipWindowCheck`, night flip never fires it, agent-secret 401s.
- Trigger flag: `skipWindowCheck: true` bypasses only the window gate (kill switch, validation, cap still enforced; existing tests keep passing with the default false).
- Sweep: fires only past the threshold, only day, only reply-pending, only no-attempt-row; callback/sweep double-fire yields one attempt row; scheduler flag gates it.
- Pending-first-replies endpoint: lease semantics (offer, cooldown re-offer, attempts cap to failed), kill switch returns `[]`, agent-secret only.

Agent: no automated harness (matches the harvester); verified by the staged live test below. Selector code reviewed, not unit-tested.

## 7. Rollout (staged, Dallas-driven gates)

1. Ship with `TT_AUTOREPLY_ENABLED` unset (OFF): prod behavior unchanged.
2. Deploy the updated box agent (restart the systemd service); it polls, gets `[]`, idles.
3. **Live test:** flip `TT_AUTOREPLY_ENABLED=true` in Render at a quiet in-window moment. On the next lead, watch: quick reply lands on TT within ~30s (Dallas eyeballs the Messages thread), then the call fires only after it. Then one after-hours lead: night reply, no call.
4. No-go on either: flip the flag off (prod reverts to direct-call behavior instantly), fix, retry.
5. Week one: watch `first_reply_status='failed'` counts and the harvest queue for agent health.

## 8. Config and documentation

| Variable | Where | Role |
|---|---|---|
| `TT_AUTOREPLY_ENABLED` | Render (server) | **New.** Master switch, default OFF. Gates the tail fork AND empties the agent offer endpoint. |
| `FIRST_REPLY_FALLBACK_MINUTES` | Render (server) | **New.** Day-lead call fallback threshold, default 3. |
| `RUN_FIRST_REPLY_FALLBACK_SCHEDULER` | Render (server) | **New.** Per-scheduler disable, default on, honored only when `RUN_SCHEDULERS` is not `false`. |
| `MAX_FIRST_REPLY_ATTEMPTS` | Render (server) | **New.** Agent attempt cap before `failed`, default 3 (`MAX_HARVEST_ATTEMPTS` sibling). |
| `FIRST_REPLY_COOLDOWN_INTERVAL` | Render (server) | **New.** Lease re-offer interval, default `'10 minutes'` (harvest-cooldown sibling, but short: replies are urgent or worthless). |
| `REPLY_POLL_INTERVAL_MS` | Box agent env | **New.** Fast-poll cadence, default 25000. |
| `LEAD_CALL_ENABLED` | existing | Also consulted at enqueue: calls-off forces the `night` template. |

Docs in the same change, per the mandatory table: README (env table, thumbtack-agent README section, Key Features bullet update), ARCHITECTURE (thumbtackAgent route table: the three new endpoints; `thumbtack_leads` schema section: five new columns; VA/lead-call feature section: the respond-then-ring ordering), CLAUDE.md (env table), `.env.example`.

## 9. Sensitive-path note for the build

The lane touches the webhook tail, the call trigger's gate structure, and the agent-secret surface: sensitive-path work, full fleet on the lane, and the staged rollout gates in section 7 before the flag goes on in prod.
