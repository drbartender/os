// Shared helpers for assembling generateShoppingList() inputs from a drink_plans
// row. Keeps drinkPlans.js and drinkPlanConsult.js small and aligned: both the
// planner auto-gen path and the admin consult path call into these helpers so
// the shopping list shape stays identical regardless of input source.

const { generateShoppingList, buildGeneratorInputFromConsult } = require('./shoppingList');

// Mirror of client/src/data/syrups.js SYRUPS — id → display name. Keep in sync
// when adding new flavors. Only used for shopping-list rendering of the
// self-provided syrup line items, so a missing entry just drops that flavor
// from the list (no crash).
const SYRUP_NAME_LOOKUP = {
  'mixed-berry': 'Mixed Berry', 'blackberry': 'Blackberry', 'strawberry': 'Strawberry',
  'mango': 'Mango', 'passion-fruit': 'Passion Fruit', 'pineapple': 'Pineapple',
  'peach': 'Peach', 'watermelon': 'Watermelon', 'grenadine': 'Grenadine (Pomegranate)',
  'cherry': 'Cherry (Dark/Tart)',
  'jalapeno': 'Jalapeño', 'habanero': 'Habanero', 'cherry-habanero': 'Cherry Habanero',
  'reaper-ghost': 'Carolina Reaper / Ghost Pepper',
  'lavender': 'Lavender', 'rosemary': 'Rosemary', 'thyme': 'Thyme', 'basil': 'Basil',
  'mint': 'Mint', 'ginger': 'Ginger', 'cardamom': 'Cardamom', 'cinnamon': 'Cinnamon',
  'vanilla': 'Vanilla', 'lemongrass': 'Lemongrass', 'hibiscus': 'Hibiscus',
  'rose': 'Rose', 'elderflower': 'Elderflower',
  'honey': 'Honey', 'maple': 'Maple', 'salted-caramel': 'Salted Caramel',
  'brown-butter': 'Brown Butter', 'espresso': 'Espresso', 'chocolate': 'Chocolate',
};

// Resolve cocktail IDs to [{name, ingredients}] preserving order. Missing IDs
// are dropped silently so a renamed/deactivated cocktail doesn't break a
// shopping list regen.
async function resolveCocktailIds(cocktailIds, dbClient) {
  if (!Array.isArray(cocktailIds) || cocktailIds.length === 0) return [];
  const result = await dbClient.query(
    'SELECT id, name, ingredients FROM cocktails WHERE id = ANY($1::text[])',
    [cocktailIds]
  );
  const byId = Object.fromEntries(result.rows.map(c => [c.id, c]));
  return cocktailIds
    .filter(id => byId[id])
    .map(id => ({ name: byId[id].name, ingredients: byId[id].ingredients || [] }));
}

// Build generateShoppingList input from a plan row's planner-side selections.
// Caller must have already joined `proposals` for `guest_count`.
async function buildPlannerGeneratorInput(plan, dbClient) {
  const sel = plan.selections || {};
  const sigDrinkIds = Array.isArray(sel.signatureDrinks) ? sel.signatureDrinks : [];
  const signatureCocktails = await resolveCocktailIds(sigDrinkIds, dbClient);
  const syrupSelfProvided = Array.isArray(sel.syrupSelfProvided) ? sel.syrupSelfProvided : [];
  const syrupNamesById = syrupSelfProvided.length > 0 ? SYRUP_NAME_LOOKUP : {};
  const isFullBar = (plan.serving_type || 'full_bar') === 'full_bar';
  const beerSelections = isFullBar ? (sel.beerFromFullBar || []) : (sel.beerFromBeerWine || []);
  const wineSelections = isFullBar ? (sel.wineFromFullBar || []) : (sel.wineFromBeerWine || []);
  return {
    clientName: plan.client_name,
    guestCount: plan.guest_count,
    signatureCocktails,
    syrupSelfProvided,
    syrupNamesById,
    eventDate: plan.event_date,
    notes: plan.admin_notes || '',
    serviceStyle: plan.serving_type || 'full_bar',
    beerSelections,
    wineSelections,
    mixersForSignatureDrinks: sel.mixersForSignatureDrinks ?? null,
    activeAddonSlugs: Object.entries(sel.addOns || {})
      .filter(([, meta]) => meta && meta.enabled)
      .map(([slug]) => slug),
  };
}

// Build generateShoppingList input from a plan row's consult-side selections.
async function buildConsultGeneratorInput(plan, dbClient) {
  const consult = plan.consult_selections || {};
  const sigIds = Array.isArray(consult.signatureDrinks) ? consult.signatureDrinks : [];
  const mockIds = Array.isArray(consult.mocktails) ? consult.mocktails : [];
  const [resolvedSigs, resolvedMocktails] = await Promise.all([
    resolveCocktailIds(sigIds, dbClient),
    resolveCocktailIds(mockIds, dbClient),
  ]);
  const generatorInput = buildGeneratorInputFromConsult(
    consult,
    {
      clientName: plan.client_name,
      guestCount: plan.guest_count,
      eventDate: plan.event_date,
    },
    resolvedSigs,
    resolvedMocktails
  );
  return {
    ...generatorInput,
    activeAddonSlugs: Object.entries(consult.addOns || {})
      .filter(([, meta]) => meta && meta.enabled)
      .map(([slug]) => slug),
  };
}

// Auto-generate a shopping list for a submitted drink plan and stage it as
// `pending_review`. Strict no-overwrite semantics: only generates when no list
// exists yet — the WHERE-clause `shopping_list IS NULL` guard keeps an admin's
// concurrent manual save (or already-approved list) from being clobbered by a
// late-firing auto-gen after submit COMMIT. Failures are non-fatal — admin can
// still trigger the manual generator from the modal as a fallback.
async function autoGenerateShoppingList(planId, dbClient) {
  const planRes = await dbClient.query(
    `SELECT dp.id, dp.serving_type, dp.selections, dp.client_name, dp.event_date,
            dp.admin_notes, dp.shopping_list IS NOT NULL AS has_list,
            p.guest_count
     FROM drink_plans dp
     LEFT JOIN proposals p ON p.id = dp.proposal_id
     WHERE dp.id = $1`,
    [planId]
  );
  const plan = planRes.rows[0];
  if (!plan || !plan.guest_count) return null;
  if (plan.has_list) return null;

  const input = await buildPlannerGeneratorInput(plan, dbClient);
  const list = generateShoppingList(input);

  await dbClient.query(
    `UPDATE drink_plans
       SET shopping_list = $1::jsonb,
           shopping_list_status = 'pending_review',
           shopping_list_source = 'planner',
           updated_at = NOW()
     WHERE id = $2
       AND shopping_list IS NULL`,
    [JSON.stringify(list), planId]
  );
  return list;
}

// Fire-and-forget wrapper. Two routes (PUT /t/:token financial branch + fast
// path) post-commit kick off auto-gen the same way; collapsing into one helper
// keeps drinkPlans.js under the line-count ratchet and the failure handling in
// one place (console + optional Sentry capture).
function triggerShoppingListAutoGen(planId, opTag = 'auto_gen_shopping_list') {
  if (!planId) return;
  const { pool } = require('../db');
  const Sentry = require('@sentry/node');
  autoGenerateShoppingList(planId, pool).catch((genErr) => {
    console.error('Shopping list auto-gen failed:', genErr);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(genErr, { tags: { route: 'drinkPlans/putToken', op: opTag }, extra: { planId } });
    }
  });
}

module.exports = {
  SYRUP_NAME_LOOKUP,
  resolveCocktailIds,
  buildPlannerGeneratorInput,
  buildConsultGeneratorInput,
  autoGenerateShoppingList,
  triggerShoppingListAutoGen,
};
