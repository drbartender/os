'use strict';

// Post-commit shopping-list refresh after an Enhancement Lab change
// (extracted verbatim from lab.js in the 2026-07-22 per-concern split;
// behavior-inert). Called via setImmediate from the PUT's post-release tail,
// so it always runs on `pool`, never the route's held client.

const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { generateShoppingList } = require('../../utils/shoppingList');
const {
  loadCatalog,
  buildPlannerGeneratorInput,
  buildDerivationForPlan,
  applyAdminSetHolds,
  isHostedPlan,
  SYRUP_NAME_LOOKUP,
} = require('../../utils/shoppingListGen');
const { normalizeName } = require('../../utils/potionCatalog');

// Post-commit, best-effort: rebuild the shopping list (holds preserved), strip
// lines covered by lab syrup upgrades ("flips it off their list onto prep"),
// and stage as pending_review so admin re-approves the changed plan. Never
// touches an approved list (guarded in the UPDATE).
async function refreshListAfterLabChange(planId) {
  try {
    const planRes = await pool.query(
      `SELECT dp.*, p.guest_count AS proposal_guest_count,
              sp.category AS package_category, sp.bar_type AS package_bar_type
         FROM drink_plans dp
         LEFT JOIN proposals p ON p.id = dp.proposal_id
         LEFT JOIN service_packages sp ON sp.id = p.package_id
        WHERE dp.id = $1`,
      [planId]
    );
    const plan = planRes.rows[0];
    if (!plan || plan.shopping_list_source === 'consult') return;
    // The Lab is hosted-capable and this UPDATE would build a list from
    // nothing; a hosted plan never owes one (see isHostedPlan). One that
    // already carries a list (stale, or admin-built on purpose) is kept in
    // step exactly as BYOB, the same policy as the consult save.
    if (isHostedPlan(plan) && plan.shopping_list === null) return;
    plan.guest_count = plan.proposal_guest_count;
    if (!plan.guest_count) return;

    // After the early returns: no transaction here, so the catalog read can sit
    // below the guards and a hosted Lab save never loads it just to drop it.
    const catalog = await loadCatalog(pool);
    const input = await buildPlannerGeneratorInput(plan, pool);
    const list = generateShoppingList(input, catalog);
    applyAdminSetHolds(list, plan.shopping_list);
    const derivation = await buildDerivationForPlan(plan, pool);
    if (derivation) list._derivation = derivation;

    // Strip lines the lab syrup upgrades now cover (DRB preps them).
    const labSyrups = Object.values(plan.selections?.labSyrupSelections || {}).flat();
    if (labSyrups.length > 0) {
      const covered = labSyrups.map((id) => normalizeName(SYRUP_NAME_LOOKUP[id] || id));
      for (const section of ['liquorBeerWine', 'everythingElse']) {
        if (!Array.isArray(list[section])) continue;
        list[section] = list[section].filter((line) => {
          const n = normalizeName(line.item || '');
          return !covered.some((c) => c && n.includes(c));
        });
      }
    }

    const upd = await pool.query(
      `UPDATE drink_plans
          SET shopping_list = $1::jsonb,
              shopping_list_status = 'pending_review',
              updated_at = NOW()
        WHERE id = $2
          AND shopping_list_status IS DISTINCT FROM 'approved'`,
      [JSON.stringify(list), planId]
    );
    if (upd.rowCount === 0) {
      // The list was approved between the lab COMMIT and this refresh: the
      // just-billed additions never reached the approved list. Surface it so
      // the admin re-stages by hand (accepted narrow race, fix-list).
      Sentry.captureMessage(`lab_list_refresh_blocked_by_approval (plan ${planId})`, 'warning');
    }
  } catch (err) {
    console.error('Lab list refresh failed (non-fatal):', err.message);
  }
}

module.exports = { refreshListAfterLabChange };
