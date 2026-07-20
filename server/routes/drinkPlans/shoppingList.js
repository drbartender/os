'use strict';

// Shopping-list routes extracted from drinkPlans.js (which was over the 700-line
// soft cap). Behavior-inert extraction: these are the exact handler bodies,
// their comments, middleware order, and auth verbatim. They register back onto
// the SAME drinkPlans router at their original positions (public token route at
// the top of the file; the three admin /:id routes after the finalize routes),
// so the router's middleware chain is byte-identical to before.
//
// Split into two register functions because the routes sat at two different
// points in the original file: the public GET /t/:token/shopping-list mounted
// early (before the other /t/:token handlers), and the admin /:id/shopping-list
// trio mounted mid-file. Keeping both insertion points preserves the effective
// Express matching order exactly.
//
// Shared helpers (ensureNotFinalized, etc.) are imported from where they live,
// exactly as drinkPlans.js imports them — no ownership moves.

const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { publicReadLimiter } = require('../../middleware/rateLimiters');
const { requireUuidToken } = require('../../utils/tokens');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { ensureNotFinalized } = require('../../utils/beoFinalize');

/** Registers the public token-based shopping-list route. Called at the top of
 *  drinkPlans.js so it keeps its original early position among the /t/:token
 *  handlers. */
function registerPublicShoppingListRoute(router) {
  /** GET /api/drink-plans/t/:token/shopping-list — public shopping list for clients.
   *  Returns the list only when admin has explicitly approved it. While the list
   *  is auto-generated and waiting for review (status='pending_review'), or no
   *  list exists yet, the response stays in the "being prepared" placeholder
   *  state so clients don't see unreviewed quantities. */
  router.get('/t/:token/shopping-list', requireUuidToken('token', 'This drink plan is no longer available'), publicReadLimiter, asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT dp.shopping_list, dp.shopping_list_status,
              dp.client_name, dp.event_type, dp.event_type_custom, dp.event_date, dp.status
       FROM drink_plans dp WHERE dp.token = $1`,
      [req.params.token]
    );
    if (!result.rows[0]) throw new NotFoundError('This drink plan link is no longer valid');
    const plan = result.rows[0];
    const isApproved = plan.shopping_list && plan.shopping_list_status === 'approved';
    if (!isApproved) {
      return res.json({
        ready: false,
        client_name: plan.client_name,
        event_type: plan.event_type,
        event_type_custom: plan.event_type_custom,
        event_date: plan.event_date,
      });
    }
    // The server-side auto-gen persists underscore-prefixed generation-run
    // diagnostics at submit time and this route serves the blob wholesale, so
    // strip them from the RESPONSE only (the stored blob keeps them so the
    // admin modal's first open still shows the unresolved warning).
    const publicList = { ...plan.shopping_list };
    for (const key of Object.keys(publicList)) {
      if (key.startsWith('_')) delete publicList[key];
    }
    res.json({
      ready: true,
      shopping_list: publicList,
      client_name: plan.client_name,
      event_type: plan.event_type,
      event_type_custom: plan.event_type_custom,
      event_date: plan.event_date,
    });
  }));
}

/** Registers the admin (auth-gated) shopping-list routes. Called mid-file in
 *  drinkPlans.js, immediately after registerFinalizeRoute/registerUnfinalizeRoute
 *  and before POST /:id/logo — the original position. */
function registerAdminShoppingListRoutes(router) {
  /** GET /api/drink-plans/:id/shopping-list — load saved shopping list */
  router.get('/:id/shopping-list', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT shopping_list, shopping_list_status, shopping_list_approved_at,
              shopping_list_approved_snapshot IS NOT NULL AS ever_approved
         FROM drink_plans WHERE id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) throw new NotFoundError('Plan not found.');
    res.json({
      shopping_list: result.rows[0].shopping_list || null,
      shopping_list_status: result.rows[0].shopping_list_status || null,
      shopping_list_approved_at: result.rows[0].shopping_list_approved_at || null,
      ever_approved: result.rows[0].ever_approved === true,
    });
  }));

  /** PUT /api/drink-plans/:id/shopping-list — save/update shopping list. Keeps
   *  the list in `pending_review` until the admin explicitly approves; an admin
   *  re-edit of an already-approved list reverts it to pending so the client
   *  doesn't keep reading stale numbers. */
  router.put('/:id/shopping-list', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
    await ensureNotFinalized(parseInt(req.params.id, 10));
    const { shopping_list } = req.body;
    if (!shopping_list || typeof shopping_list !== 'object') {
      throw new ValidationError({ shopping_list: 'Invalid shopping list data.' });
    }
    // Underscore keys are generation-run diagnostics (built fresh by every
    // generate/regenerate); never persisted, so stale copies can't outlive
    // the generation they described.
    for (const key of Object.keys(shopping_list)) {
      if (key.startsWith('_')) delete shopping_list[key];
    }
    const result = await pool.query(
      `UPDATE drink_plans
         SET shopping_list = $1,
             shopping_list_status = 'pending_review',
             shopping_list_approved_at = NULL,
             updated_at = NOW()
       WHERE id = $2
       RETURNING id`,
      [JSON.stringify(shopping_list), req.params.id]
    );
    if (!result.rows[0]) throw new NotFoundError('Plan not found.');
    res.json({ success: true });
  }));

  /** PATCH /api/drink-plans/:id/shopping-list/approve — DEPRECATED direct
   *  approve, kept mounted for API compatibility. Delegates to the
   *  shopping_list_approve comms action (spec 4.4): idempotent side effects
   *  (atomic flip + approved snapshot), then the default unedited email on the
   *  email channel, awaited and ledgered by the action, never fire-and-forget.
   *  New UI goes through POST /api/comms/send instead. */
  router.patch('/:id/shopping-list/approve', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
    const { getAction } = require('../../utils/comms/registry');
    const action = getAction('shopping_list_approve');
    const planId = parseInt(req.params.id, 10);

    const sideEffects = await action.ensureSideEffects(planId);
    if (!sideEffects.applied) {
      // Already approved by another click — idempotent success, no re-email,
      // matching the old route's alreadyApproved contract.
      const check = await pool.query(
        'SELECT shopping_list_approved_at FROM drink_plans WHERE id = $1',
        [planId]
      );
      return res.json({
        success: true,
        approved_at: check.rows[0]?.shopping_list_approved_at || null,
        alreadyApproved: true,
      });
    }

    const results = await action.dispatch(planId, undefined, ['email'], { sentBy: req.user.id });
    if (results.email === 'failed') {
      console.error('Shopping-list-ready email failed:', results.email_error);
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(new Error(results.email_error || 'shopping-list email failed'), {
          tags: { route: 'drinkPlans/approveShoppingList', step: 'email' },
          extra: { planId },
        });
      }
    }

    res.json({
      success: true,
      approved_at: new Date().toISOString(),
      email: results.email,
      email_error: results.email_error || null,
      recipient_email: results.recipient_email || null,
    });
  }));
}

module.exports = { registerPublicShoppingListRoute, registerAdminShoppingListRoutes };
