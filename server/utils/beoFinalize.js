'use strict';

// POST /api/drink-plans/:id/finalize — handler body + route registration.
//
// Lives here, not inline in server/routes/drinkPlans.js, for two reasons:
//   1. drinkPlans.js is over the 1000-line ratchet, so any inline addition
//      would block the pre-commit hook.
//   2. The finalize/unfinalize pair (and the Phase-4 lock guards) all share
//      the same scheduleBeoNudgesForProposal / proposal_activity_log dance,
//      so co-locating them here keeps the BEO finalize lifecycle in one place
//      that's straightforward to grep for.
//
// The single UPDATE enforces every preflight (status='reviewed', not already
// finalized, non-empty selections, proposal exists and not archived)
// atomically; on rowCount=0 the helper reads the row back to translate the
// failure into the right 404 / 409.

const { pool } = require('../db');
const { NotFoundError, ConflictError } = require('./errors');
const { scheduleBeoNudgesForProposal, suppressBeoNudgesForProposal } = require('./beoHandlers');
const asyncHandler = require('../middleware/asyncHandler');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { drinkPlanWriteLimiter } = require('../middleware/rateLimiters');

async function finalizeDrinkPlan(planId, actorId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE drink_plans dp
          SET finalized_at = NOW(), finalized_by = $2
         FROM proposals p
        WHERE dp.id = $1
          AND dp.proposal_id = p.id
          AND dp.proposal_id IS NOT NULL
          AND dp.status = 'reviewed'
          AND dp.finalized_at IS NULL
          AND p.status != 'archived'
          AND COALESCE(dp.selections, '{}'::jsonb) != '{}'::jsonb
        RETURNING dp.*, dp.proposal_id`,
      [planId, actorId]
    );
    if (upd.rowCount === 0) {
      const check = await client.query(
        `SELECT dp.status, dp.finalized_at, dp.proposal_id,
                COALESCE(dp.selections, '{}'::jsonb) = '{}'::jsonb AS empty_selections,
                p.status AS proposal_status
           FROM drink_plans dp LEFT JOIN proposals p ON p.id = dp.proposal_id
          WHERE dp.id = $1`,
        [planId]
      );
      await client.query('ROLLBACK');
      const row = check.rows[0];
      if (!row) throw new NotFoundError('Plan not found.');
      if (!row.proposal_id) throw new ConflictError('Plan not linked to a proposal.');
      if (row.proposal_status === 'archived') throw new ConflictError('Proposal is archived.');
      if (row.empty_selections) throw new ConflictError('Plan has no selections.');
      if (row.finalized_at) throw new ConflictError('Plan is already finalized.');
      if (row.status !== 'reviewed') throw new ConflictError('Plan is not reviewed.');
      throw new ConflictError('Finalize refused.');
    }
    const plan = upd.rows[0];
    // Pass the transaction client (not pool) so the scheduled_messages INSERTs
    // are atomic with the UPDATE and the activity-log row below.
    const sched = await scheduleBeoNudgesForProposal(plan.proposal_id, client);
    await client.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'beo_finalized', 'admin', $2, $3)`,
      [plan.proposal_id, actorId, JSON.stringify({
        finalized_at: plan.finalized_at,
        nudge_count: sched.inserted || 0,
      })]
    );
    await client.query('COMMIT');
    console.log(`[beo] finalize plan=${plan.id} proposal=${plan.proposal_id} nudges=${sched.inserted || 0}`);
    return plan;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow rollback noise */ }
    throw err;
  } finally {
    client.release();
  }
}

function registerFinalizeRoute(router) {
  router.post('/:id/finalize', auth, requireAdminOrManager, drinkPlanWriteLimiter, asyncHandler(async (req, res) => {
    const planId = parseInt(req.params.id, 10);
    if (!Number.isFinite(planId)) throw new NotFoundError('Plan not found.');
    const plan = await finalizeDrinkPlan(planId, req.user.id);
    res.json(plan);
  }));
}

// Unfinalize reverses Finalize: clears finalized_at/finalized_by, clears the
// beo_acknowledged_at stamp on EVERY linked shift_request (so the admin pill
// is honest immediately), and suppresses any PENDING beo_unack_nudge_sms rows
// for the proposal. Sent rows stay sent — that's the audit trail. The single
// transaction covers all three writes plus the proposal_activity_log entry.
function registerUnfinalizeRoute(router) {
  router.post('/:id/unfinalize', auth, requireAdminOrManager, drinkPlanWriteLimiter, asyncHandler(async (req, res) => {
    const planId = parseInt(req.params.id, 10);
    if (!Number.isFinite(planId)) throw new NotFoundError('Plan not found.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const upd = await client.query(
        `UPDATE drink_plans SET finalized_at = NULL, finalized_by = NULL
          WHERE id = $1 AND finalized_at IS NOT NULL
          RETURNING *, proposal_id`,
        [planId]
      );
      if (upd.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new ConflictError('Plan is not finalized.');
      }
      const plan = upd.rows[0];

      // Clear acks on EVERY linked shift_request (not just approved) so the
      // admin pill is honest immediately after Unfinalize.
      const clearedAcks = await client.query(
        `UPDATE shift_requests sr
            SET beo_acknowledged_at = NULL
           FROM shifts s
          WHERE sr.shift_id = s.id AND s.proposal_id = $1
            AND sr.beo_acknowledged_at IS NOT NULL`,
        [plan.proposal_id]
      );

      const sup = await suppressBeoNudgesForProposal(plan.proposal_id, client, 'unfinalized: BEO unfinalized by admin');

      await client.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
         VALUES ($1, 'beo_unfinalized', 'admin', $2, $3)`,
        [plan.proposal_id, req.user.id, JSON.stringify({ suppressed_count: sup.suppressed || 0, cleared_ack_count: clearedAcks.rowCount })]
      );
      await client.query('COMMIT');
      console.log(`[beo] unfinalize plan=${plan.id} proposal=${plan.proposal_id} suppressed=${sup.suppressed || 0} cleared_acks=${clearedAcks.rowCount}`);
      res.json(plan);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* swallow rollback noise */ }
      throw err;
    } finally {
      client.release();
    }
  }));
}

// Lock guard: every BEO-protected mutation route on drinkPlans.js calls this
// FIRST to refuse changes while finalized_at is set. Admins must Unfinalize
// before editing; client UI surfaces "reach out if you need a change" instead.
async function ensureNotFinalized(planId) {
  const r = await pool.query('SELECT finalized_at FROM drink_plans WHERE id = $1', [planId]);
  if (r.rows[0] && r.rows[0].finalized_at) {
    throw new ConflictError('Plan is finalized. Unfinalize first to change.');
  }
}

module.exports = { finalizeDrinkPlan, registerFinalizeRoute, registerUnfinalizeRoute, ensureNotFinalized };
