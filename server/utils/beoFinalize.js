'use strict';

// BEO finalize lifecycle: POST /api/drink-plans/:id/finalize (manual),
// autoFinalizeIfEligible (derived), POST /:id/unfinalize, and the lock guard.
//
// Lives here, not inline in server/routes/drinkPlans.js, so the whole
// finalize / auto-finalize / unfinalize / lock set stays in one place that is
// straightforward to grep for; they all share the same
// scheduleBeoNudgesForProposal / proposal_activity_log dance.
//
// Since 2026-09-11 finalize is DERIVED, not clicked, and since 2026-09-22
// approving the shopping list IS the review: a plan finalizes the moment its
// list is approved (never over unpaid extras), and the "Mark reviewed" click
// is gone. Finalize no longer asks for status='reviewed' beforehand; it stamps
// it in the same UPDATE as finalized_at and is the ONLY writer of 'reviewed'
// (the approve flip does not touch status, so a refused finalize never locks
// the client's planner), which keeps `finalized` implying `reviewed` for every
// reader of that status. The shopping-list approve is the ONLY derived
// trigger, so the derived predicate is simply "the list is approved". A hosted
// package never owes a list, so its one click is the manual route below, which
// works from any unfinalized plan with selections; the manual route is also
// the override for unpaid extras and the way back after Unfinalize.
//
// The single UPDATE enforces every preflight (not already finalized,
// non-empty selections, proposal exists and not archived, and in auto mode
// the list-approved predicate) atomically; on rowCount=0 the helper
// reads the row back to translate the failure into the right 404 / 409 with a
// machine-readable code.

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { NotFoundError, ConflictError } = require('./errors');
const { scheduleBeoNudgesForProposal, suppressBeoNudgesForProposal } = require('./beoHandlers');
const { findExtrasInvoice } = require('./invoiceHelpers');
const asyncHandler = require('../middleware/asyncHandler');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { drinkPlanWriteLimiter } = require('../middleware/rateLimiters');

// The derived predicate sits inside the finalize UPDATE's WHERE, not in a
// pre-check: a list edit that reverts the status to pending_review between a
// check and the UPDATE must make the UPDATE match zero rows, not finalize over
// it. (A hosted package never owes a list, so the approve action that fires
// this can only reach a hosted plan through a list built on purpose, in which
// case the list IS approved; hosted otherwise finalizes from the manual route.)
const LIST_APPROVED_SQL = `dp.shopping_list_status = 'approved'`;

// The one admin action that completes the derived state. opts.auto is used
// as a truthiness switch on the SQL above and as a JSON detail, never
// interpolated; the allow-list makes that provable rather than inferred.
const AUTO_TRIGGERS = new Set(['shopping_list_approved']);

/**
 * Finalize a drink plan inside one transaction.
 *
 * @param {number} planId
 * @param {number|null} actorId  admin whose click caused this (finalized_by)
 * @param {object} [opts]
 * @param {boolean} [opts.overrideUnpaidExtras]  manual "finalize anyway"
 * @param {string}  [opts.auto]  trigger name ('shopping_list_approved') when
 *        called by autoFinalizeIfEligible; adds the list-approved predicate to
 *        the UPDATE and is recorded as details.trigger.
 * @returns the drink_plans row (approved-snapshot blob stripped); status is
 *          'reviewed' on it, stamped by the finalize UPDATE itself
 * @throws NotFoundError | ConflictError(code) where code is one of not_linked,
 *         archived, no_selections, already_finalized, list_not_approved,
 *         unpaid_extras (carries .unpaidExtrasCents), finalize_refused.
 */
async function finalizeDrinkPlan(planId, actorId, opts = {}) {
  const trigger = opts.auto || 'manual';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE drink_plans dp
          SET finalized_at = NOW(), finalized_by = $2, status = 'reviewed'
         FROM proposals p
        WHERE dp.id = $1
          AND dp.proposal_id = p.id
          AND dp.proposal_id IS NOT NULL
          AND dp.finalized_at IS NULL
          AND p.status != 'archived'
          AND COALESCE(dp.selections, '{}'::jsonb) != '{}'::jsonb
          ${opts.auto ? `AND ${LIST_APPROVED_SQL}` : ''}
        RETURNING dp.*, dp.proposal_id`,
      [planId, actorId]
    );
    if (upd.rowCount === 0) {
      const check = await client.query(
        `SELECT dp.finalized_at, dp.proposal_id, dp.shopping_list_status,
                COALESCE(dp.selections, '{}'::jsonb) = '{}'::jsonb AS empty_selections,
                p.status AS proposal_status
           FROM drink_plans dp
           LEFT JOIN proposals p ON p.id = dp.proposal_id
          WHERE dp.id = $1`,
        [planId]
      );
      // No ROLLBACK here: every throw below lands in the catch, which owns
      // it (a second ROLLBACK would log "no transaction in progress" on
      // every routine derived-finalize refusal).
      const row = check.rows[0];
      if (!row) throw new NotFoundError('Plan not found.');
      // Finalized first: autoFinalizeIfEligible reads already_finalized as
      // "finalized now", so no other refusal may mask it.
      if (row.finalized_at) throw new ConflictError('Plan is already finalized.', 'already_finalized');
      if (!row.proposal_id) throw new ConflictError('Plan not linked to a proposal.', 'not_linked');
      if (row.proposal_status === 'archived') throw new ConflictError('Proposal is archived.', 'archived');
      if (row.empty_selections) throw new ConflictError('Plan has no selections.', 'no_selections');
      if (opts.auto && row.shopping_list_status !== 'approved') {
        throw new ConflictError('Shopping list is not approved.', 'list_not_approved');
      }
      throw new ConflictError('Finalize refused.', 'finalize_refused');
    }
    // The approved-snapshot column stays off the wire (the status route strips
    // it the same way).
    const { shopping_list_approved_snapshot, ...plan } = upd.rows[0];

    // Server-enforced unpaid-extras gate. The finalize UPDATE above already
    // ran; if the proposal has an open, unpaid "Drink Plan Extras" invoice and
    // the admin has NOT explicitly overridden, throw so the whole transaction
    // (including the finalize) rolls back. This is the authoritative gate: the
    // client "finalize anyway" confirm is UX only; a direct / non-UI finalize
    // cannot skip the warning or the audit entry. Auto-finalize never passes
    // overrideUnpaidExtras, so unpaid extras always leave the plan for the
    // manual button, where a human sees the amount first.
    const extrasInv = await findExtrasInvoice(plan.proposal_id, client);
    const unpaidExtrasCents = extrasInv
      ? Math.max(0, Number(extrasInv.amount_due) - Number(extrasInv.amount_paid))
      : 0;
    if (unpaidExtrasCents > 0 && !opts.overrideUnpaidExtras) {
      const err = new ConflictError(
        `Plan has $${(unpaidExtrasCents / 100).toFixed(2)} in unpaid extras; confirm to finalize anyway.`,
        'unpaid_extras'
      );
      err.unpaidExtrasCents = unpaidExtrasCents;
      throw err;
    }

    // Pass the transaction client (not pool) so the scheduled_messages INSERTs
    // are atomic with the UPDATE and the activity-log row below.
    const sched = await scheduleBeoNudgesForProposal(plan.proposal_id, client);
    await client.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'beo_finalized', 'admin', $2, $3)`,
      [plan.proposal_id, actorId, JSON.stringify({
        finalized_at: plan.finalized_at,
        nudge_count: sched.inserted || 0,
        trigger,
      })]
    );
    // Audit who finalized over the unpaid-extras warning, and how much was unpaid.
    if (unpaidExtrasCents > 0 && opts.overrideUnpaidExtras) {
      await client.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
         VALUES ($1, 'finalized_unpaid_extras', 'admin', $2, $3)`,
        [plan.proposal_id, actorId, JSON.stringify({ amount_cents: unpaidExtrasCents, drink_plan_id: plan.id })]
      );
    }
    await client.query('COMMIT');
    console.log(`[beo] finalize plan=${plan.id} proposal=${plan.proposal_id} trigger=${trigger} nudges=${sched.inserted || 0}`);
    return plan;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow rollback noise */ }
    throw err;
  } finally {
    client.release();
  }
}

// Skip reasons that are the ordinary "not there yet" state of a plan; logging
// them on every approve would be noise.
const QUIET_SKIPS = new Set(['list_not_approved', 'already_finalized']);

/**
 * Derived finalize. Called by the shopping-list approve, the one admin action
 * that completes the list-approved state; finalizes when every
 * guard holds and otherwise reports why. Never throws for anything the
 * database says: the caller's own write (the list approve) has already
 * committed and must not fail because the BEO could not finalize. The one
 * throw is the unknown-trigger guard below, a programmer error raised before
 * any DB work. The manual Finalize button remains the fallback for every
 * non-finalized outcome.
 *
 * @param {number} planId
 * @param {number|null} actorId
 * @param {'shopping_list_approved'} trigger
 * @returns {Promise<{finalized: boolean, reason?: string, plan?: object, unpaid_extras_cents?: number}>}
 *   `finalized` is "the plan is finalized now" (true on already_finalized
 *   too); `plan` is present only when THIS call finalized.
 */
async function autoFinalizeIfEligible(planId, actorId, trigger) {
  if (!AUTO_TRIGGERS.has(trigger)) throw new Error(`autoFinalizeIfEligible: unknown trigger ${trigger}`);
  try {
    const plan = await finalizeDrinkPlan(planId, actorId, { auto: trigger });
    return { finalized: true, plan };
  } catch (err) {
    if (err instanceof NotFoundError) {
      return { finalized: false, reason: 'not_found' };
    }
    if (err instanceof ConflictError) {
      const reason = String(err.code || 'conflict').toLowerCase();
      if (!QUIET_SKIPS.has(reason)) {
        console.log(`[beo] auto-finalize skip plan=${planId} trigger=${trigger} reason=${reason}`);
      }
      // `finalized` means "the plan is finalized NOW", so losing the race to
      // the other trigger still reports true (the caller locks its UI on it).
      const out = { finalized: reason === 'already_finalized', reason };
      if (err.unpaidExtrasCents) out.unpaid_extras_cents = err.unpaidExtrasCents;
      return out;
    }
    console.error(`[beo] auto-finalize error plan=${planId} trigger=${trigger}:`, err);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, {
        tags: { route: 'beo/autoFinalize', trigger },
        extra: { planId, actorId },
      });
    }
    return { finalized: false, reason: 'error' };
  }
}

/**
 * The wire shape both trigger routes hand the client: what the derived
 * finalize did, or why not. One builder so the two sites cannot drift.
 * @param {{finalized: boolean, reason?: string, unpaid_extras_cents?: number}} auto
 */
function beoReport(auto) {
  const beo = { finalized: Boolean(auto && auto.finalized) };
  if (auto && auto.reason) beo.reason = auto.reason;
  if (auto && auto.unpaid_extras_cents) beo.unpaid_extras_cents = auto.unpaid_extras_cents;
  return beo;
}

function registerFinalizeRoute(router) {
  router.post('/:id/finalize', auth, requireAdminOrManager, drinkPlanWriteLimiter, asyncHandler(async (req, res) => {
    const planId = parseInt(req.params.id, 10);
    if (!Number.isFinite(planId)) throw new NotFoundError('Plan not found.');
    const plan = await finalizeDrinkPlan(planId, req.user.id, {
      overrideUnpaidExtras: req.body?.overrideUnpaidExtras === true,
    });
    res.json(plan);
  }));
}

// Unfinalize reverses Finalize: clears finalized_at/finalized_by, clears the
// beo_acknowledged_at stamp on EVERY linked shift_request (so the admin pill
// is honest immediately), and suppresses any PENDING beo_unack_nudge_sms rows
// for the proposal. Sent rows stay sent — that's the audit trail. The single
// transaction covers all three writes plus the proposal_activity_log entry.
// Nothing re-fires the derived finalize afterwards until the admin re-approves
// an edited list or presses Finalize. Status stays 'reviewed' for a plan the
// client submitted (the review happened; only the BEO is reopened). A plan the
// client never submitted (finalized off an admin-built list, submitted_at
// NULL) goes back to 'draft': 'reviewed' without finalized_at would read to
// the public planner as "already submitted" and lock a client out of a plan
// they never sent.
function registerUnfinalizeRoute(router) {
  router.post('/:id/unfinalize', auth, requireAdminOrManager, drinkPlanWriteLimiter, asyncHandler(async (req, res) => {
    const planId = parseInt(req.params.id, 10);
    if (!Number.isFinite(planId)) throw new NotFoundError('Plan not found.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const upd = await client.query(
        `UPDATE drink_plans
            SET finalized_at = NULL, finalized_by = NULL,
                status = CASE WHEN submitted_at IS NULL THEN 'draft' ELSE status END
          WHERE id = $1 AND finalized_at IS NOT NULL
          RETURNING *, proposal_id`,
        [planId]
      );
      if (upd.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new ConflictError('Plan is not finalized.', 'not_finalized');
      }
      const { shopping_list_approved_snapshot, ...plan } = upd.rows[0];

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
    throw new ConflictError('Plan is finalized. Unfinalize first to change.', 'finalized');
  }
}

module.exports = {
  finalizeDrinkPlan,
  autoFinalizeIfEligible,
  beoReport,
  registerFinalizeRoute,
  registerUnfinalizeRoute,
  ensureNotFinalized,
};
