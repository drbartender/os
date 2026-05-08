// Admin consult-form routes — alternate input path for shopping lists.
// Mounted under /api/drink-plans alongside the main drinkPlans router.
//
// Workflow: when a client doesn't fill out the potion planner, the admin
// captures their phone/email-consult info via the consult form on the drink
// plan detail page. This produces `consult_selections` and a generator-derived
// `shopping_list` in `pending_review` state — same approval/email/public-token
// pipeline as a planner-derived list. The source toggle lets admin switch
// between planner-derived and consult-derived output when both exist.

const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');
const { generateShoppingList } = require('../utils/shoppingList');
const {
  buildPlannerGeneratorInput,
  buildConsultGeneratorInput,
} = require('../utils/shoppingListGen');

const router = express.Router();

const VALID_BAR_TYPES = ['full_bar', 'sig_beer_wine', 'beer_wine', 'mocktails'];
const VALID_MIXER_MODES = ['full', 'matching', 'none'];

/** GET /api/drink-plans/:id/consult — fetch consult-form payload for pre-population.
 *  Returns the raw consult_selections so the form can re-open with the admin's
 *  prior input intact. Empty object when nothing's been saved yet. */
router.get('/:id/consult', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT consult_selections, consult_filled_at, consult_filled_by_user_id
     FROM drink_plans WHERE id = $1`,
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');
  res.json({
    consult_selections: result.rows[0].consult_selections || null,
    consult_filled_at: result.rows[0].consult_filled_at || null,
    consult_filled_by_user_id: result.rows[0].consult_filled_by_user_id || null,
  });
}));

/** PUT /api/drink-plans/:id/consult — save admin consult-form payload, run the
 *  generator, persist the resulting shopping list as `pending_review`. Atomic
 *  in a single transaction: the consult_selections, audit fields, source flag,
 *  and shopping_list all move together. Re-runnable — submitting again
 *  overwrites the prior consult and regenerates. */
router.put('/:id/consult', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { consult } = req.body;
  if (!consult || typeof consult !== 'object') {
    throw new ValidationError({ consult: 'Invalid consult payload.' });
  }
  if (consult.barType && !VALID_BAR_TYPES.includes(consult.barType)) {
    throw new ValidationError({ barType: 'Invalid bar type.' });
  }
  if (consult.mixers && !VALID_MIXER_MODES.includes(consult.mixers)) {
    throw new ValidationError({ mixers: 'Invalid mixer mode.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const planRes = await client.query(
      `SELECT dp.id, dp.client_name, dp.event_date, dp.admin_notes,
              p.guest_count
       FROM drink_plans dp
       LEFT JOIN proposals p ON p.id = dp.proposal_id
       WHERE dp.id = $1
       FOR UPDATE`,
      [req.params.id]
    );
    if (!planRes.rows[0]) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Plan not found.');
    }
    const plan = planRes.rows[0];
    plan.consult_selections = consult;

    const overrideGc = Number(consult.guestCountOverride) || 0;
    if (overrideGc > 0) plan.guest_count = overrideGc;
    if (!plan.guest_count) {
      await client.query('ROLLBACK');
      throw new ValidationError({
        guestCountOverride: 'Guest count is required — set it on the proposal or override here.',
      });
    }

    const input = await buildConsultGeneratorInput(plan, client);
    const list = generateShoppingList(input);

    await client.query(
      `UPDATE drink_plans
         SET consult_selections = $1::jsonb,
             consult_filled_by_user_id = $2,
             consult_filled_at = NOW(),
             shopping_list = $3::jsonb,
             shopping_list_status = 'pending_review',
             shopping_list_approved_at = NULL,
             shopping_list_source = 'consult',
             updated_at = NOW()
       WHERE id = $4`,
      [JSON.stringify(consult), req.user.id, JSON.stringify(list), req.params.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, shopping_list_source: 'consult' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* swallow rollback failure */ }
    throw err;
  } finally {
    client.release();
  }
}));

/** PATCH /api/drink-plans/:id/shopping-list-source — flip the active source
 *  between 'planner' and 'consult'. Validates the requested source has data,
 *  regenerates from that source, resets `shopping_list_status` to
 *  `pending_review` so admin re-approves before client sees the new numbers. */
router.patch('/:id/shopping-list-source', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { source } = req.body;
  if (!['planner', 'consult'].includes(source)) {
    throw new ValidationError({ source: 'Source must be "planner" or "consult".' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const planRes = await client.query(
      `SELECT dp.id, dp.serving_type, dp.selections, dp.consult_selections,
              dp.client_name, dp.event_date, dp.admin_notes,
              p.guest_count
       FROM drink_plans dp
       LEFT JOIN proposals p ON p.id = dp.proposal_id
       WHERE dp.id = $1
       FOR UPDATE`,
      [req.params.id]
    );
    if (!planRes.rows[0]) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Plan not found.');
    }
    const plan = planRes.rows[0];

    if (source === 'planner' && !plan.selections) {
      await client.query('ROLLBACK');
      throw new ConflictError('No planner submission exists yet for this plan.');
    }
    if (source === 'consult' && !plan.consult_selections) {
      await client.query('ROLLBACK');
      throw new ConflictError('No consult-form input exists yet for this plan.');
    }
    if (!plan.guest_count && source === 'planner') {
      await client.query('ROLLBACK');
      throw new ValidationError({ guest_count: 'Guest count is required to generate a shopping list.' });
    }

    const input = source === 'planner'
      ? await buildPlannerGeneratorInput(plan, client)
      : await buildConsultGeneratorInput(plan, client);
    const list = generateShoppingList(input);

    await client.query(
      `UPDATE drink_plans
         SET shopping_list = $1::jsonb,
             shopping_list_status = 'pending_review',
             shopping_list_approved_at = NULL,
             shopping_list_source = $2,
             updated_at = NOW()
       WHERE id = $3`,
      [JSON.stringify(list), source, req.params.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, shopping_list_source: source });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* swallow rollback failure */ }
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
