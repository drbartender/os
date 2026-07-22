// server/utils/firstReplySweepScheduler.js
//
// TT auto first-reply fallback + hygiene sweep (spec 2026-07-21 section 4.5).
// One 60s tick, two arms, both bounded and re-entrant:
//
//   Arm A (call fallback): day-template leads in ANY reply state (pending,
//   sent, failed) past FIRST_REPLY_FALLBACK_MINUTES but inside
//   FIRST_REPLY_CALL_MAX_AGE_MINUTES with no lead_call_attempts row get the
//   promised call anyway (unconfirmed reply, or a crash/race that flipped
//   the row before its call fired). LIMIT 3 per tick, awaited sequentially.
//   Never touches first_reply_status. Skipped while LEAD_CALL_ENABLED is
//   'false' (no busy-loop against the kill switch).
//
//   Arm B (strand hygiene), all regardless of kill switches unless noted:
//   (1a) retirement: 'pending' rows past the freshness bound flip to
//   'failed', both templates, so a rollback queue actually drains and a
//   re-enable can never offer weeks-old replies. (1b) any-status day rows
//   past the bound with no attempt row get a one-time failed/reply_stale
//   fault row (the visible fact of a lost call). (2) enqueue-crash strands
//   ('not_needed', younger than 60 minutes, no attempt row) are re-enqueued,
//   ONLY while TT_AUTOREPLY_ENABLED === 'true'.
//
// The sweep itself is NOT gated by TT_AUTOREPLY_ENABLED (rollback runbook:
// flipping the flag off must still drain in-flight day leads).
//
// Idempotency: callback/sweep double-fires funnel into triggerLeadCall,
// whose lead_id UNIQUE open makes them placement-safe and email-safe.
//
// Deps are injected through one mutable `deps` object (vaCallingScheduler.js
// precedent) so both arms are testable with stubbed call/enqueue triggers
// against the real DB.

const leadCallTrigger = require('./leadCallTrigger');
const { pool } = require('../db');

let deps = {
  pool,
  triggerLeadCall: (...a) => leadCallTrigger.triggerLeadCall(...a),
  enqueueFirstReply: (...a) => leadCallTrigger.enqueueFirstReply(...a),
};

function __setDeps(overrides) {
  deps = { ...deps, ...overrides };
}

// Read at call time so a Render env edit takes effect on the next tick. The
// || fallback is load-bearing (leadCallTrigger dailyCap precedent): an unset
// env must not become a NaN bound that silently empties every query.
function fallbackMinutes() { return parseInt(process.env.FIRST_REPLY_FALLBACK_MINUTES, 10) || 3; }
function callMaxAgeMinutes() { return parseInt(process.env.FIRST_REPLY_CALL_MAX_AGE_MINUTES, 10) || 240; }

// Arm A. The NOT EXISTS is the double-fire guard against the agent's
// first-reply-sent callback: a confirmed reply already opened (or skipped)
// the chain, which plants the attempt row this predicate excludes. Status
// covers 'pending' (unconfirmed reply) AND 'sent'/'failed' (fleet finding:
// a crash between the callback's status flip and its triggerLeadCall, or a
// fast definitive failure racing this sweep, leaves a flipped row with no
// attempt row; the promised call must still fire).
async function sweepCallFallback() {
  if (process.env.LEAD_CALL_ENABLED === 'false') return 0;

  const r = await deps.pool.query(
    `SELECT id, customer_phone
     FROM thumbtack_leads
     WHERE first_reply_status IN ('pending', 'sent', 'failed')
       AND first_reply_template = 'day'
       AND created_at < NOW() - make_interval(mins => $1)
       AND created_at > NOW() - make_interval(mins => $2)
       AND NOT EXISTS (SELECT 1 FROM lead_call_attempts a WHERE a.lead_id = thumbtack_leads.id)
     ORDER BY created_at
     LIMIT 3`,
    [fallbackMinutes(), callMaxAgeMinutes()]
  );

  for (const row of r.rows) {
    // Lead-shape law: the camelCase lead is constructed from the DB row
    // explicitly; never pass a raw snake_case row. skipWindowCheck: the
    // window was already judged at lead arrival (template 'day' IS that
    // judgment); every other trigger gate still applies.
    await deps.triggerLeadCall({
      lead: { customerPhone: row.customer_phone },
      leadId: Number(row.id),
      skipWindowCheck: true,
    });
  }
  return r.rows.length;
}

// Arm B(1a). Retirement (fleet finding): rows still 'pending' past the
// freshness bound flip to 'failed', BOTH templates, regardless of every kill
// switch. Without this, a rollback flag-off strands its queue in 'pending'
// forever (the offer returns [], attempts never accrue, the runbook's
// "until pending drains" never terminates, and a later re-enable would offer
// weeks-old call-promising replies). The offer CTE also excludes over-age
// rows, so retirement and offering can never race a stale send.
async function retireStalePending() {
  const r = await deps.pool.query(
    `UPDATE thumbtack_leads SET first_reply_status = 'failed'
     WHERE first_reply_status = 'pending'
       AND created_at <= NOW() - make_interval(mins => $1)`,
    [callMaxAgeMinutes()]
  );
  return r.rowCount;
}

// Arm B(1b). One-time via the lead_id UNIQUE: the second tick's INSERT hits
// ON CONFLICT and marks nothing, so each stale lead surfaces exactly once in
// the fault feed. Any-status day rows: a day lead that aged past the bound
// with no attempt row lost its call no matter which state it died in
// (pending wedge, sent/failed crash strand); the fault row is the visible
// fact. 7-day scan bound keeps the query off ancient history.
async function markStaleDayLeads() {
  const r = await deps.pool.query(
    `INSERT INTO lead_call_attempts (lead_id, status, detail)
     SELECT id, 'failed', 'reply_stale'
     FROM thumbtack_leads
     WHERE first_reply_template = 'day'
       AND created_at <= NOW() - make_interval(mins => $1)
       AND created_at > NOW() - INTERVAL '7 days'
       AND NOT EXISTS (SELECT 1 FROM lead_call_attempts a WHERE a.lead_id = thumbtack_leads.id)
     ON CONFLICT (lead_id) DO NOTHING`,
    [callMaxAgeMinutes()]
  );
  return r.rowCount;
}

// Arm B(2). Heals the crash window between lead commit and enqueue (the heal
// path cannot reach these rows because proposal_id is already set). The
// 60-minute bound is the PLAN's number (plan F5, plan-fleet finding), a
// deliberate narrowing of the spec 4.5 text's 24h. Accepted residuals, eyes
// open: (a) a crash strand that outlives 60 minutes is silently lost (rare:
// crash + hour-long outage + flag on); (b) a lead captured while calls were
// killed leaves no attempt row, so a flag-on within the hour retro-enqueues
// it, and if Dallas already hand-replied on TT the client sees a duplicate
// canned reply. Runbook note: before flipping TT_AUTOREPLY_ENABLED on, work
// or wait out any lead younger than an hour.
async function healEnqueueStrands() {
  if (process.env.TT_AUTOREPLY_ENABLED !== 'true') return 0;

  const r = await deps.pool.query(
    `SELECT id, customer_phone
     FROM thumbtack_leads
     WHERE first_reply_status = 'not_needed'
       AND created_at > NOW() - INTERVAL '60 minutes'
       AND NOT EXISTS (SELECT 1 FROM lead_call_attempts a WHERE a.lead_id = thumbtack_leads.id)
     ORDER BY created_at`
  );

  for (const row of r.rows) {
    // Lead-shape law, same construction as Arm A. enqueueFirstReply owns its
    // own fallback (a throw inside it answers with the direct trigger).
    await deps.enqueueFirstReply({
      lead: { customerPhone: row.customer_phone },
      leadId: Number(row.id),
    });
  }
  return r.rows.length;
}

// One tick. Each arm is guarded separately so one arm's failure cannot mask
// the other; a failed arm still rethrows AFTER every arm ran, so wrapScheduler
// records the tick as failed (schedulerHealth contract: schedulers rethrow).
async function runFirstReplySweep() {
  const counts = { calledBack: 0, retired: 0, staleMarked: 0, reEnqueued: 0 };
  const errors = [];

  try {
    counts.calledBack = await sweepCallFallback();
  } catch (err) {
    console.error('[firstReplySweep] call fallback (Arm A) failed:', err.message);
    errors.push(err);
  }

  try {
    counts.retired = await retireStalePending();
  } catch (err) {
    console.error('[firstReplySweep] retirement (Arm B) failed:', err.message);
    errors.push(err);
  }

  try {
    counts.staleMarked = await markStaleDayLeads();
  } catch (err) {
    console.error('[firstReplySweep] stale-mark (Arm B) failed:', err.message);
    errors.push(err);
  }

  try {
    counts.reEnqueued = await healEnqueueStrands();
  } catch (err) {
    console.error('[firstReplySweep] strand re-enqueue (Arm B) failed:', err.message);
    errors.push(err);
  }

  if (errors.length > 0) throw errors[0];
  return counts;
}

module.exports = { runFirstReplySweep, __setDeps };
