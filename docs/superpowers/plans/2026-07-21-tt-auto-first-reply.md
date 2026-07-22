---
spec: docs/superpowers/specs/2026-07-21-tt-auto-first-reply-design.md
lanes:
  - id: first-reply-server
    footprint:
      - server/db/schema.sql                      # 5 lead columns + partial index (spec 4.1)
      - server/utils/leadCallTrigger.js           # enqueueFirstReply + skipWindowCheck flag
      - server/utils/leadCallTrigger.test.js
      - server/routes/thumbtack.js                # tail fork on TT_AUTOREPLY_ENABLED
      - server/routes/thumbtack.test.js
      - server/routes/thumbtackAgent.js           # 3 new agent-secret endpoints + limiter bump
      - server/routes/thumbtackAgent.replies.test.js  # new suite for the reply endpoints
      - server/utils/firstReplySweepScheduler.js  # new: Arm A call fallback + Arm B hygiene (Scheduler suffix matches the sensitive-path glob)
      - server/utils/firstReplySweepScheduler.test.js
      - server/index.js                           # 60s scheduler registration
      - server/routes/proposals/getOne.js         # first_reply object
      - server/routes/proposals/getOne.leadCall.test.js  # extend for first_reply
      - client/src/pages/admin/ProposalDetail.js  # First reply line
      - .env.example
      - README.md
      - ARCHITECTURE.md
      - .claude/CLAUDE.md                         # env rows + agent-secret blast-radius note
    blockedBy: []
    review: full-fleet   # webhook tail + call-trigger gates + agent-secret surface; sensitive
  - id: first-reply-agent
    footprint:
      - thumbtack-agent/src/index.js              # single-loop rework: 25s tick, harvest piggyback, reply jobs
      - thumbtack-agent/src/cadence.js            # new: pure tick/piggyback/daily-cap math (extract.js precedent)
      - thumbtack-agent/src/cadence.test.js
      - thumbtack-agent/.env.example              # REPLY_POLL_INTERVAL_MS, REPLY_DAILY_CAP
      - thumbtack-agent/README.md
      - README.md                                 # thumbtack-agent row ONLY (shared with server lane; blockedBy serializes; expect a trivial doc conflict at merge)
    blockedBy: [first-reply-server]
    review: standard     # box-only automation; code-review + consistency-check (no server surfaces)
---

# Thumbtack Auto First-Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **House override:** lane model per CLAUDE.md; run order `first-reply-server` then `first-reply-agent`. The Launch checklist is ops, not a lane. Box-agent deploy = restart the systemd service on this machine (no Render involvement).

**Goal:** Every new Thumbtack lead gets Dallas's saved `day`/`night` quick reply sent through his real TT session within ~30 seconds, and day-lead calls fire only after the reply is confirmed (respond-then-ring), with fallbacks that guarantee the reply path can never lose a call.

**Architecture:** Webhook tail forks on `TT_AUTOREPLY_ENABLED`: off = today's direct `triggerLeadCall`; on = `enqueueFirstReply` (template = call-eligibility at arrival; night/skip rows keep call-log parity; throw falls back to the direct trigger). The box agent's single loop ticks every 25s, sends the quick reply via per-negotiation navigation, reports back; the `first-reply-sent` callback fires the call chain via `skipWindowCheck` with a freshness bound. A 60s sweep backstops confirmation (Arm A) and turns strands into visible fault rows (Arm B).

**Tech Stack:** Express + raw SQL, node:test with `__setDeps` seams, playwright-core box agent.

## Global Constraints

- Raw SQL parameterized; schema idempotent; snake_case JSON.
- Tail law: never throws to the webhook, bare `pool.query` only.
- **Lead-shape law (fleet blocker):** every non-webhook `triggerLeadCall` call site constructs `{ customerPhone: row.customer_phone }` explicitly; tests exercise the REAL snake_case row through the real path.
- **Never promise a call the system will not place:** `day` template requires window AND `LEAD_CALL_ENABLED` AND agent phone configured AND `toUsE164` pass, re-checked at offer (day-to-night downgrade when calls are killed).
- The DB `first_reply_template` is the source of truth for the call decision; the agent-posted `template` is logged, never trusted.
- `skipWindowCheck` bypasses ONLY the window gate; freshness bound `FIRST_REPLY_CALL_MAX_AGE_MINUTES` (default 240) bounds all callback/sweep calls.
- The sweep is NOT gated by `TT_AUTOREPLY_ENABLED` (rollback drains in-flight leads).
- No em dashes in any copy. Server test law: one suite at a time, `node -r dotenv/config --test <file>`. Client gate: `CI=true npx react-scripts build`.
- Git: explicit pathspec staging; footprint discipline (out-of-footprint = ABORT and surface).

## Lane first-reply-server

- [ ] F1. **Schema.** Append to `server/db/schema.sql`: the five `first_reply_*` columns (spec 4.1 verbatim, `ADD COLUMN IF NOT EXISTS`) + partial index `idx_thumbtack_leads_first_reply_pending ON thumbtack_leads(first_reply_attempted_at) WHERE first_reply_status='pending'` (mirrors `idx_clients_email_harvest_pending`, schema.sql:2490). Apply to dev via Neon MCP (initDb applies on prod boot), verify columns exist. **Checkpoint: database-review agent on this task.**
- [ ] F2. **`leadCallTrigger.js`: `skipWindowCheck` + `enqueueFirstReply`.** (a) `triggerLeadCall({ lead, leadId, skipWindowCheck = false })`: the window gate (`hour < START || hour >= END`) is skipped when the flag is true; every other gate unchanged; existing tests pass with default false. (b) New export `enqueueFirstReply({ lead, leadId })`, colocated so it reuses the private `insertRow` and the `CALL_WINDOW_*` constants: decide eligibility by walking the trigger's gates IN ITS EXACT ORDER (`LEAD_CALL_ENABLED` first, then window via `_deps.chicagoHourNow`, then `ADMIN_PHONE || VA_CELL` configured, then `toUsE164(lead.customerPhone)`; leadCallTrigger.js:211-231): the FIRST failing gate decides which skip row is inserted, exactly as the direct trigger would (fleet finding: parity breaks if the order differs); all gates pass → template `day`; else template `night` + that gate's skip row (`skipped_after_hours` / `skipped_unconfigured` / `skipped_invalid_phone`; calls-disabled inserts nothing); guarded enqueue `UPDATE thumbtack_leads SET first_reply_status='pending', first_reply_template=$2 WHERE id=$1 AND first_reply_status='not_needed'`; **any throw inside is caught and answered with the direct `triggerLeadCall({ lead, leadId })`** (spec 4.2.3, the risk-blocker fallback; the catch lives inside `enqueueFirstReply` so the tail contract is unchanged). Tests: decision matrix (5 branches), skip-row parity per reason, at-most-once, throw-falls-back-to-call (stub pool to throw on the UPDATE only; assert the direct trigger still opened a chain), `skipWindowCheck` bypasses only the window.
- [ ] F3. **Tail fork in `thumbtack.js`.** The lead-call step becomes: `TT_AUTOREPLY_ENABLED === 'true' ? _deps.enqueueFirstReply({ lead, leadId }) : _deps.triggerLeadCall({ lead, leadId })`; `enqueueFirstReply` joins `_deps`. Tests (extend thumbtack.test.js): flag off = trigger called, columns untouched (byte-for-byte today); flag on = enqueue called with `{ lead, leadId }`; heal path forks identically.
- [ ] F4. **Reply endpoints in `thumbtackAgent.js`** (file goes 467 → ~620, inside the yellow zone, single agent-surface concern; new suite `thumbtackAgent.replies.test.js`). All `agentSecretOnly`; body validation mirrors `harvest-failed` (negotiation_id required/trimmed; enums 400):
  - `GET /pending-first-replies?limit=N`: `[]` unless `TT_AUTOREPLY_ENABLED === 'true'`. Offer query: `first_reply_status='pending' AND (first_reply_attempted_at IS NULL OR first_reply_attempted_at < NOW() - FIRST_REPLY_COOLDOWN_INTERVAL)`, night rows additionally withheld until `created_at + ((2 + id % 13) || ' minutes')::interval` (spec 4.3 jitter). The offer is ONE writable CTE (the pending-harvest CTE at thumbtackAgent.js:79-117 is the template): pick with `FOR UPDATE SKIP LOCKED`, UPDATE stamps `first_reply_attempted_at=NOW()`, bumps `first_reply_attempts`, CASE-flips rows at `first_reply_attempts >= MAX_FIRST_REPLY_ATTEMPTS` to `failed` and downgrades day rows to `night` while `LEAD_CALL_ENABLED === 'false'`, and the FINAL SELECT filters to rows still `pending` so cap-flipped rows are NEVER handed to the agent (fleet finding: without the return filter, failed rows would be offered). Returns `negotiation_id, customer_name, first_reply_template, created_at`.
  - `POST /first-reply-sent { negotiation_id, template }`: guarded flip `SET first_reply_status='sent', first_reply_sent_at=NOW() WHERE negotiation_id=$1 AND first_reply_status='pending' RETURNING id, customer_phone, first_reply_template, created_at`; rowCount 0 = 200 no-op. Winner with DB template `day` AND `created_at > NOW() - FIRST_REPLY_CALL_MAX_AGE_MINUTES` → `triggerLeadCall({ lead: { customerPhone: row.customer_phone }, leadId: Number(row.id), skipWindowCheck: true })`; staler → insert attempt row `failed` detail `reply_confirmed_late`. Posted `template` mismatching the DB value logs a warning, never gates.
  - `POST /first-reply-failed { negotiation_id, reason }`: reason in `Set(['template_not_found','lead_not_found','quick_reply_unavailable','send_unverified','ambiguous_lead'])`, 400 otherwise; guarded flip `pending -> failed`. The reason is validated and logged (console + Sentry breadcrumb), NOT stored: there is deliberately no reason column in v1 (spec 4.6 surfaces status only). No email.
  - Bump `agentLimiter` (thumbtackAgent.js:22) from 20/min to 40/min (25s poll + harvest + callback drains; risk suggestion) with a one-line comment.
  Tests: lease + bump + cap-to-failed, cooldown re-offer, jitter withholding (night row too fresh not offered), day-to-night downgrade, kill switch `[]`, secret 401s, sent-flip fires trigger with the constructed camelCase shape from a REAL row (the gaps-blocker regression test), duplicate sent no-op, a NIGHT-template flip never dials (explicit spec 6 row), stale sent inserts `reply_confirmed_late` and never dials, failed-reason enum, cap-flipped rows never returned by the offer. If the file crosses the 700 soft cap, extract the offer-CTE builder to a sibling util rather than eat the warn.
- [ ] F5. **`firstReplySweepScheduler.js`** (new util + 60s scheduler in `server/index.js` behind `enabled('RUN_FIRST_REPLY_FALLBACK_SCHEDULER')`, registered with `wrapScheduler('first_reply_sweep', 60, ...)` + a stagger, the va-calling block pattern at index.js:495). One tick:
  - Arm A (skip entirely while `LEAD_CALL_ENABLED === 'false'`): `SELECT` day-template `pending` leads older than `FIRST_REPLY_FALLBACK_MINUTES` (default 3), younger than `FIRST_REPLY_CALL_MAX_AGE_MINUTES`, with `NOT EXISTS (attempt row)`, `ORDER BY created_at LIMIT 3`; for each, sequentially `await triggerLeadCall({ lead: { customerPhone: row.customer_phone }, leadId, skipWindowCheck: true })`. Never touches `first_reply_status`.
  - Arm B: (1) day `pending` rows PAST the freshness bound with no attempt row → insert attempt row `failed` detail `reply_stale` (at-most-once via the lead_id UNIQUE); (2) enqueue-crash strands: `not_needed` rows with no attempt row, younger than 60 minutes, and ONLY while `TT_AUTOREPLY_ENABLED === 'true'` → `enqueueFirstReply` with the row-constructed lead shape (the narrow age + flag gate keeps Arm B from retroactively enqueueing leads captured while the feature or the calls were deliberately off; fleet finding). Arm B's stale-marking arm runs regardless of kill switches.
  Tests: every bound and filter, callback/sweep double-fire = one chain, sequential LIMIT 3 drain across ticks, Arm B stale-mark one-time + `not_needed` re-enqueue, scheduler flag gating, NOT gated by `TT_AUTOREPLY_ENABLED`.
- [ ] F6. **Visibility.** `getOne.js`: add `first_reply` (status, template, sent_at; null when `not_needed`) to the existing parallel fetch (one more cheap query on the newest lead by `proposal_id`, same lateral shape as `lead_call`). `ProposalDetail.js`: one muted line under the Lead call line ("First reply: sent (day, 8:14 PM)" / "failed" / "pending"); absent renders nothing. Extend `getOne.leadCall.test.js` (present/absent). Client build gate + a one-line manual check on dev: open a proposal with a seeded sent/failed/pending first_reply and confirm the rendered line reads e.g. "First reply: sent (day, 8:14 PM)" (the render must not debut in prod).
- [ ] F7. **Docs + env.** Root `.env.example` (six new server vars with comments), CLAUDE.md env rows + the `THUMBTACK_AGENT_SECRET` blast-radius note (spec 8), README env table + Key Features (update the stale "overnight leads log only" line to the night-reply behavior), ARCHITECTURE (thumbtackAgent route table +3 rows; thumbtack_leads schema columns + partial index; lead-call section: respond-then-ring ordering).
- [ ] F8. **Lane gate.** All touched suites green one-at-a-time; client CI build; footprint check. **Full fleet, named: security-review (agent-secret surface, skipWindowCheck reachability, blast radius) + code-review + database-review + consistency-check.** Manual dev check: with the flag off, POST a synthetic lead to the local webhook and confirm byte-for-byte today's behavior (trigger fired, first_reply columns untouched); flip flag on locally, POST another, confirm pending row + template decision and NO call until a simulated first-reply-sent.

## Lane first-reply-agent

- [ ] A1. **Loop rework in `thumbtack-agent/src/index.js`** (180 → ~300 lines): tick interval becomes `REPLY_POLL_INTERVAL_MS` (default 25000); the existing harvest poll runs every Nth tick where `N = ceil(POLL_INTERVAL_MS / REPLY_POLL_INTERVAL_MS)` (defaults: every 12th tick, preserving ~5 min); reply jobs poll every tick via `GET /pending-first-replies`. Single browser context, single throttle, single session-recovery path (spec 4.3; the existing disconnect-relaunch handler at index.js:130-140 covers both job types). New `REPLY_DAILY_CAP` counter (default 40) beside the harvest counter. The tick/piggyback/cap arithmetic lives in a PURE helper `thumbtack-agent/src/cadence.js` with a real `node:test` (`cadence.test.js`, the extract.js precedent; fleet finding: an off-by-one here silently drifts the harvest cadence and nothing else would catch it).
- [ ] A2. **Reply job handler.** Navigate per-negotiation (discover the deterministic messaging/lead URL during the first live session, `priceEstimateUrl` precedent at index.js:30; Jobs-page name match is the FALLBACK, and two same-name candidates = `ambiguous_lead` definitive failure, never a guess). Click Quick Reply; select the template whose visible label case-insensitively equals the offer's `first_reply_template`; Send; verify the thread exists under Messages; `POST first-reply-sent`. Definitive failures post `first-reply-failed` with the matching enum reason; anything else releases the lease silently (cooldown re-offer). Human pacing: reuse the existing jittered throttle for every page action.
- [ ] A3. **Agent docs + env.** `thumbtack-agent/.env.example` += `REPLY_POLL_INTERVAL_MS`, `REPLY_DAILY_CAP`; `thumbtack-agent/README.md` gains the reply-job section (flow, failure reasons, kill switch semantics: server flag empties the queue, agent needs no local flag); root README thumbtack-agent row updated.
- [ ] A4. **Lane gate.** cadence.test.js green; code-review + consistency-check agents on the lane diff, with the code-review explicitly scoped to the mis-send guardrails (deterministic navigation, ambiguous-lead fail-closed never-guess, verify-thread-before-reporting-sent); `node --check` the agent file; manual dry-run on this box with the server flag OFF (agent polls, gets `[]`, idles clean through several ticks + one harvest piggyback tick). Live selectors are exercised only in the staged rollout below.

## Launch checklist (ops, Dallas + this box, NOT a lane)

- [ ] L1. Server lane merged; push per house push model (sensitive fleet + /second-opinion at push). Render env: add the six new server vars only if overriding defaults; `TT_AUTOREPLY_ENABLED` stays unset (OFF).
- [ ] L2. Agent lane merged; `git pull` in the os checkout on this box and restart the agent: `systemctl --user restart thumbtack-agent` (or the unit in `thumbtack-agent/systemd/`); journal shows 25s ticks, `[]` offers, harvest piggyback on schedule.
- [ ] L3. **Live test (spec 7.3):** flip `TT_AUTOREPLY_ENABLED=true` in Render at a quiet in-window moment. Next lead: reply visible in TT Messages within ~30s, call fires only after it, ProposalDetail shows the First reply line. After 9pm lead: night reply lands on the 2-15 min jitter, no call.
- [ ] L4. No-go: flip the flag off (new leads revert instantly); leave `RUN_FIRST_REPLY_FALLBACK_SCHEDULER` on until `pending` drains.
- [ ] L5. Week one: `first_reply_status='failed'` count, `reply_stale` fault rows in the Sales tab feed, and the wedge signal (`pending` older than 1 hour).
