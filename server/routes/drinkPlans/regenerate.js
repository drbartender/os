// POST /api/drink-plans/:id/shopping-list/regenerate — build a FRESH list
// from the plan's stored inputs and the live par catalog, and return it
// WITHOUT saving. The modal's existing PUT /:id/shopping-list and
// PATCH /:id/shopping-list/approve remain the only writers.
//
// This is the server-side replacement for the client-side generator mirror
// (there was no server manual-generate path before this). Mounted in
// server/index.js BEFORE the flat drinkPlans router; its single specific
// POST cannot shadow anything there (no method+path overlap), and unmatched
// requests fall through.
//
// Builder choice: shopping_list_source 'consult' uses the consult builder;
// 'planner' or NULL (every manually generated legacy list) uses the planner
// builder. Spec §4.
const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { generateShoppingList } = require('../../utils/shoppingList');
const {
  loadCatalog,
  reportUnresolvedIngredients,
  buildPlannerGeneratorInput,
  buildConsultGeneratorInput,
  buildDerivationForPlan,
  applyAdminSetHolds,
} = require('../../utils/shoppingListGen');

const router = express.Router();

router.post('/:id/shopping-list/regenerate', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const planId = parseInt(req.params.id, 10);
  if (!Number.isInteger(planId)) throw new NotFoundError('Plan not found.');

  let override = req.body ? req.body.guest_count_override : undefined;
  if (override !== undefined && override !== null && override !== '') {
    override = Number(override);
    if (!Number.isInteger(override) || override < 1 || override > 1000) {
      throw new ValidationError({
        guest_count_override: 'Guest count must be a whole number between 1 and 1000.',
      });
    }
  } else {
    override = null;
  }

  // Live catalog; a failed read degrades to the legacy constants inside the
  // generator (Sentry-reported by loadCatalog). No transaction here at all —
  // this endpoint only reads.
  const catalog = await loadCatalog(pool);

  const planResult = await pool.query(
    `SELECT dp.*, p.guest_count AS proposal_guest_count, p.event_duration_hours
       FROM drink_plans dp
       LEFT JOIN proposals p ON p.id = dp.proposal_id
      WHERE dp.id = $1`,
    [planId]
  );
  const plan = planResult.rows[0];
  if (!plan) throw new NotFoundError('Plan not found.');

  plan.guest_count = override || plan.proposal_guest_count;
  if (!plan.guest_count) {
    throw new ValidationError({
      guest_count_override: 'Set a guest count to generate this list.',
    });
  }

  const input = plan.shopping_list_source === 'consult'
    ? await buildConsultGeneratorInput(plan, pool)
    : await buildPlannerGeneratorInput(plan, pool);
  const list = generateShoppingList(input, catalog);
  reportUnresolvedIngredients(list, 'regenerate');

  // Hold admin-set quantity overrides from the currently-saved list so a
  // regenerate never silently clobbers the admin's deliberate judgment
  // (pp2-quantity-review HARD REQ #2). No-op when the saved list carries no
  // admin_set lines (every pre-lane list).
  applyAdminSetHolds(list, plan.shopping_list);

  // Attach the quantity-review derivation metadata (v2 crowd plans only; null
  // -> no key -> unchanged output). Metadata only; quantities untouched.
  const derivation = await buildDerivationForPlan(plan, pool);
  if (derivation) list._derivation = derivation;

  res.json({ list });
}));

module.exports = router;
