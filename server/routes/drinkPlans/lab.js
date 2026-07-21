// The Enhancement Lab (planner v2, spec 2026-07-18 §3.3): the ONE selling
// surface. GET serves the shelves (submitted drinks + their enhancement
// dossiers + event extras + balance state); PUT reconciles the client's lab
// additions and FOLDS them into the proposal balance (2026-07-20 owner
// decision): lab-owned proposal_addons rows + the submit path's contract-safe
// reprice (utils/proposalExtrasFold), then the open Balance invoice absorbs
// the new total with each lab item as its own line. Only when nothing is
// owed does a separate itemized 'Enhancement Lab' invoice carry the
// remainder. NO PAYMENT UI: no Stripe, no card fields, nothing here takes
// payment — the money lands on the client's balance paperwork.
//
// Window: opens once the plan is submitted; closes when the shopping list is
// approved (shopping_list_status = 'approved') — that approval is the freeze
// line for what DRB shops and preps. Lab additions push the list back to
// pending_review (admin re-approves).
const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { publicReadLimiter, drinkPlanWriteLimiter } = require('../../middleware/rateLimiters');
const { requireUuidToken } = require('../../utils/tokens');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../../utils/errors');
const { calculateSyrupCost } = require('../../utils/pricingEngine');
const { createInvoice, writeLineItems, refreshUnlockedInvoices } = require('../../utils/invoiceHelpers');
const { foldExtrasIntoProposal, loadRepriceAddons } = require('../../utils/proposalExtrasFold');
const { generateShoppingList } = require('../../utils/shoppingList');
const {
  loadCatalog,
  buildPlannerGeneratorInput,
  buildDerivationForPlan,
  applyAdminSetHolds,
  SYRUP_NAME_LOOKUP,
} = require('../../utils/shoppingListGen');
const { normalizeName } = require('../../utils/potionCatalog');
const { isDrinkPlanPreBooking } = require('../../utils/drinkPlanAccess');

const router = express.Router();

// Event-level shelf slugs (per design canvas): toast + glassware always;
// NA add-ons join for hosted plans. The Jack-rule pair is EXCLUDED — those
// price mocktail PICKS at submit and are never a Lab upsell.
const EVENT_ADDON_SLUGS = ['champagne-toast', 'champagne-coupe-upgrade', 'real-glassware'];
const HOSTED_EVENT_ADDON_SLUGS = ['non-alcoholic-beer', 'soft-drink-addon', 'zero-proof-spirits'];
const JACK_PAIR = ['pre-batched-mocktail', 'mocktail-bar'];

const PLAN_SELECT = `
  SELECT dp.id, dp.token, dp.status, dp.selections, dp.client_name, dp.finalized_at,
         dp.planner_version,
         dp.shopping_list, dp.shopping_list_status, dp.shopping_list_source, dp.proposal_id,
         p.guest_count, p.num_bars, p.pricing_snapshot, p.event_date AS proposal_event_date,
         p.total_price AS proposal_total_price, p.amount_paid AS proposal_amount_paid,
         p.balance_due_date, p.event_duration_hours, p.status AS proposal_status,
         sp.category AS package_category,
         sp.covered_addon_slugs AS package_covered_addon_slugs
    FROM drink_plans dp
    LEFT JOIN proposals p ON p.id = dp.proposal_id
    LEFT JOIN service_packages sp ON sp.id = p.package_id
   WHERE dp.token = $1`;

function labState(plan) {
  // v2 only: legacy (v1) plans never see the lab, even by direct URL — their
  // wizard has its own syrup/upsell mechanics and never disclosed lab pricing.
  if (plan.planner_version < 2) return 'not_ready';
  // Pre-booking gate, mirroring GET /t/:token (cross-LLM push review,
  // 2026-07-20): before the deposit the lab must not exist — folding here
  // would mutate an UNSIGNED proposal's contract from a public token.
  if (plan.proposal_id && isDrinkPlanPreBooking(plan.proposal_status)) return 'not_ready';
  if (plan.status !== 'submitted' && plan.status !== 'reviewed') return 'not_ready';
  if (plan.finalized_at || plan.shopping_list_status === 'approved') return 'locked';
  return 'open';
}

function labAdditionsOf(selections) {
  const addOns = {};
  for (const [slug, meta] of Object.entries(selections?.addOns || {})) {
    if (meta && meta.labAdded === true) addOns[slug] = meta;
  }
  return { addOns, labSyrupSelections: selections?.labSyrupSelections || {} };
}

function coveredSlugsOf(plan) {
  return new Set(Array.isArray(plan.package_covered_addon_slugs) ? plan.package_covered_addon_slugs : []);
}

/** Syrups the CONTRACT already owns: priced into the proposal snapshot at sale
 *  time and NOT lab-added (stored lab ids are subtracted back out). These are
 *  never offered and never accepted as lab syrups — if a client could lab-add
 *  a contract syrup it would become lab-owned, and a later removal would shave
 *  that syrup out of total_price (cross-LLM push review, 2026-07-20). */
function contractSyrupSet(plan, selections) {
  const labIds = new Set(Object.values(selections?.labSyrupSelections || {}).flat());
  const snapIds = plan.pricing_snapshot?.syrups?.selections || [];
  return new Set(snapIds.filter((id) => !labIds.has(id)));
}

/** DISPLAY pricing of lab additions (integer cents): catalog addon rates plus
 *  the lab syrup SET priced together (pack discount, shared-flavor dedup).
 *  The ledger and running total render from this; the BILLED amount is the
 *  proposal fold (foldExtrasIntoProposal), which prices the same inputs at
 *  catalog — identical on native proposals, and on an override'd contract the
 *  fold moves the contract by this same catalog delta. */
function priceLabAdditions({ addonRows, labSyrupIds, guestCount }) {
  let addonTotal = 0;
  for (const addon of addonRows) {
    const rate = Number(addon.rate) || 0;
    addonTotal += addon.billing_type === 'per_guest' ? rate * (guestCount || 1) : rate;
  }
  const syrupTotal = calculateSyrupCost(labSyrupIds, guestCount || 1).total;
  return {
    addonCents: Math.round(addonTotal * 100),
    syrupCents: Math.round(syrupTotal * 100),
    totalCents: Math.round((addonTotal + syrupTotal) * 100),
  };
}

/** Itemized line items for the nothing-owed-case lab invoice: each addon its
 *  own line, syrups one set-priced line labeled exactly like the Balance
 *  invoice's syrup line so the same charge never renders under two names.
 *  Lines are drift-folded to amount_due by the caller. */
function buildLabLineItems({ addonRows, labSyrupIds, guestCount }) {
  const items = [];
  for (const addon of addonRows) {
    const rate = Number(addon.rate) || 0;
    const isPerGuest = addon.billing_type === 'per_guest';
    const qty = isPerGuest ? (guestCount || 1) : 1;
    const lineCents = Math.round(rate * qty * 100);
    items.push({
      description: isPerGuest ? `${addon.name} (${qty} guests)` : addon.name,
      quantity: qty,
      unit_price: Math.round(rate * 100),
      line_total: lineCents,
      source_type: 'addon',
      source_id: addon.id,
    });
  }
  const syrupCost = calculateSyrupCost(labSyrupIds, guestCount || 1);
  if (syrupCost.total > 0) {
    const cents = Math.round(syrupCost.total * 100);
    items.push({
      description: 'Signature Syrups',
      quantity: 1,
      unit_price: cents,
      line_total: cents,
      source_type: 'fee',
      source_id: null,
    });
  }
  return items;
}

function balanceOf(plan) {
  if (!plan.proposal_id) return null;
  const total = Number(plan.proposal_total_price) || 0;
  const paid = Number(plan.proposal_amount_paid) || 0;
  const due = Math.max(0, total - paid);
  const dueDate = plan.balance_due_date || null;
  const pastDue = due > 0 && dueDate && new Date(dueDate) < new Date();
  return { total, paid, due, due_date: dueDate, past_due: !!pastDue };
}

/** GET /api/drink-plans/t/:token/lab — the shelves. */
router.get('/t/:token/lab', requireUuidToken('token', 'This drink plan is no longer available'), publicReadLimiter, asyncHandler(async (req, res) => {
  const result = await pool.query(PLAN_SELECT, [req.params.token]);
  const plan = result.rows[0];
  if (!plan) throw new NotFoundError('This drink plan link is no longer valid');

  const state = labState(plan);
  const sel = plan.selections || {};
  const sigIds = Array.isArray(sel.signatureDrinks) ? sel.signatureDrinks : [];
  const mocIds = Array.isArray(sel.mocktails) ? sel.mocktails : [];

  const [cocktailRows, mocktailRows, addonRows] = await Promise.all([
    sigIds.length
      ? pool.query('SELECT id, name, emoji, description, enhancements, syrup_id FROM cocktails WHERE id = ANY($1::text[])', [sigIds])
      : Promise.resolve({ rows: [] }),
    mocIds.length
      ? pool.query('SELECT id, name, emoji, description, enhancements, syrup_id FROM mocktails WHERE id = ANY($1::text[])', [mocIds])
      : Promise.resolve({ rows: [] }),
    pool.query('SELECT slug, name, rate, billing_type, description FROM service_addons WHERE is_active = true'),
  ]);

  // Per-drink housemade-syrup upsell price, computed server-side so the page
  // shows exactly what the fold bills (calculateSyrupCost, same engine).
  // A syrup_id the pricing engine can't price (legacy alias, admin typo in the
  // recipe editor) is never offered: a $0 upsell would bill nothing while
  // still flipping the client's shopping-list line off.
  const syrupPriceFor = (syrupId) =>
    syrupId ? calculateSyrupCost([syrupId], plan.guest_count || 1).total : 0;
  // Never offer a syrup the contract already owns (see contractSyrupSet).
  const contractSyrups = contractSyrupSet(plan, sel);

  const drink = (row, table) => {
    const syrupPrice = syrupPriceFor(row.syrup_id);
    return {
      id: row.id,
      table,
      name: row.name,
      emoji: row.emoji,
      description: row.description,
      enhancements: Array.isArray(row.enhancements) ? row.enhancements : [],
      syrup: row.syrup_id && syrupPrice > 0 && !contractSyrups.has(row.syrup_id)
        ? { id: row.syrup_id, name: SYRUP_NAME_LOOKUP[row.syrup_id] || row.syrup_id, price: syrupPrice }
        : null,
    };
  };

  const isHosted = plan.package_category === 'hosted';
  // Never offer what the package already covers (a covered addon must not be
  // billable, mirroring the submit path's coveredAddonSlugs skip) or the
  // Jack pair (mocktail PICKS price those at submit, never the lab).
  const covered = coveredSlugsOf(plan);
  const offerable = addonRows.rows.filter((a) => !JACK_PAIR.includes(a.slug) && !covered.has(a.slug));
  const eventSlugs = (isHosted ? [...EVENT_ADDON_SLUGS, ...HOSTED_EVENT_ADDON_SLUGS] : EVENT_ADDON_SLUGS)
    .filter((s) => !covered.has(s));

  // Server-exact DISPLAY pricing of the STORED lab additions (integer cents),
  // so the page's running total matches the folded charge — the client never
  // re-derives pack discounts or shared-flavor dedup on its own.
  const storedAdditions = labAdditionsOf(sel);
  const storedSlugs = Object.keys(storedAdditions.addOns);
  const labBreakdown = priceLabAdditions({
    addonRows: addonRows.rows.filter((a) => storedSlugs.includes(a.slug)),
    labSyrupIds: [...new Set(Object.values(storedAdditions.labSyrupSelections).flat())],
    guestCount: plan.guest_count,
  });

  res.json({
    state,
    client_name: plan.client_name,
    guest_count: plan.guest_count,
    is_hosted: isHosted,
    balance: balanceOf(plan),
    drinks: [
      ...cocktailRows.rows.map((r) => drink(r, 'cocktails')),
      ...mocktailRows.rows.map((r) => drink(r, 'mocktails')),
    ],
    addon_pricing: offerable,
    event_addon_slugs: eventSlugs,
    lab_additions: storedAdditions,
    lab_breakdown: labBreakdown,
  });
}));

// ─── PUT: reconcile lab additions ────────────────────────────────────

const META_STRING_FIELDS = ['servingStyle', 'toastTime'];

function sanitizeLabAddOns(raw, validSlugs, storedLabSlugs = new Set()) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError({ addOns: 'addOns must be an object keyed by addon slug.' });
  }
  const entries = Object.entries(raw);
  if (entries.length > 20) throw new ValidationError({ addOns: 'At most 20 lab additions.' });
  const clean = {};
  for (const [slug, meta] of entries) {
    if (!validSlugs.has(slug) || JACK_PAIR.includes(slug)) {
      // A previously-stored lab addition whose slug drifted OUT of the offered
      // surface (package category flip, dossier edit, drink removed post-
      // submit) is silently DROPPED: the client can no longer render or untick
      // its card, so throwing would brick every subsequent save (re-verify F1,
      // 2026-07-20). The desired-state reconcile then removes it and the
      // invoice refreshes down. A never-stored non-offered slug is the actual
      // attack surface: reject.
      if (storedLabSlugs.has(slug)) continue;
      throw new ValidationError({ addOns: `Unknown or non-lab addon: ${String(slug).slice(0, 60)}` });
    }
    const entry = { enabled: true, labAdded: true };
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      for (const f of META_STRING_FIELDS) {
        if (typeof meta[f] === 'string' && meta[f].trim()) entry[f] = meta[f].trim().slice(0, 120);
      }
      if (Array.isArray(meta.drinks)) {
        entry.drinks = [...new Set(meta.drinks.map((d) => String(d).slice(0, 100)))].slice(0, 20);
      }
      if (meta.flavors && typeof meta.flavors === 'object' && !Array.isArray(meta.flavors)) {
        const flavors = {};
        for (const [k, v] of Object.entries(meta.flavors).slice(0, 20)) {
          if (typeof v === 'string') flavors[String(k).slice(0, 100)] = v.slice(0, 30);
        }
        entry.flavors = flavors;
      }
    }
    clean[slug] = entry;
  }
  return clean;
}

function sanitizeLabSyrups(raw, offeredSyrupByDrink) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError({ labSyrupSelections: 'Must be a map of drink id to syrup ids.' });
  }
  const clean = {};
  for (const [drinkId, ids] of Object.entries(raw).slice(0, 30)) {
    // Only the drink's OWN dossier syrup is offered (mirrors the GET). A
    // non-submitted drink or any other catalog syrup is silently dropped —
    // otherwise a token holder could bill/prep the wrong syrup while the
    // drink's real pairing line stays on the client's shopping list
    // (2026-07-20 push review). The pricing-engine check keeps the
    // $0-legacy-alias guard: an unpriceable syrup would bill nothing while
    // still flipping the client's list line off.
    const offered = offeredSyrupByDrink.get(drinkId);
    if (!offered || !Array.isArray(ids) || !ids.includes(offered)) continue;
    const valid = SYRUP_NAME_LOOKUP[offered] && calculateSyrupCost([offered], 1).total > 0
      ? [offered]
      : [];
    if (valid.length > 0) clean[drinkId] = valid;
  }
  return clean;
}

// Post-commit, best-effort: rebuild the shopping list (holds preserved), strip
// lines covered by lab syrup upgrades ("flips it off their list onto prep"),
// and stage as pending_review so admin re-approves the changed plan. Never
// touches an approved list (guarded in the UPDATE).
async function refreshListAfterLabChange(planId) {
  try {
    const catalog = await loadCatalog(pool);
    const planRes = await pool.query(
      `SELECT dp.*, p.guest_count AS proposal_guest_count
         FROM drink_plans dp LEFT JOIN proposals p ON p.id = dp.proposal_id
        WHERE dp.id = $1`,
      [planId]
    );
    const plan = planRes.rows[0];
    if (!plan || plan.shopping_list_source === 'consult') return;
    plan.guest_count = plan.proposal_guest_count;
    if (!plan.guest_count) return;

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

/** PUT /api/drink-plans/t/:token/lab — reconcile the client's lab additions.
 *  Body: { addOns: {slug: {servingStyle?, toastTime?, drinks?, flavors?}},
 *          labSyrupSelections: {drinkId: [syrupId]} } — the DESIRED lab state
 *  (idempotent; removing an addition = omitting it). Non-lab addOns entries
 *  (planner fence picks, legacy) are never touched. */
router.put('/t/:token/lab', requireUuidToken('token', 'This drink plan is no longer available'), drinkPlanWriteLimiter, asyncHandler(async (req, res) => {
  const client = await pool.connect();
  let planId = null;
  try {
    await client.query('BEGIN');
    const result = await client.query(`${PLAN_SELECT} FOR UPDATE OF dp`, [req.params.token]);
    const plan = result.rows[0];
    if (!plan) {
      await client.query('ROLLBACK');
      throw new NotFoundError('This drink plan link is no longer valid');
    }
    const state = labState(plan);
    if (state === 'not_ready') {
      await client.query('ROLLBACK');
      throw new ConflictError('The Enhancement Lab opens after you submit your drink plan.');
    }
    if (state === 'locked') {
      await client.query('ROLLBACK');
      throw new ConflictError('The lab is closed for your event. Reach out and we will help.');
    }
    planId = plan.id;

    const sel = plan.selections || {};
    const sigIds = Array.isArray(sel.signatureDrinks) ? sel.signatureDrinks : [];
    const mocIds = Array.isArray(sel.mocktails) ? sel.mocktails : [];

    // Allowlist = the OFFERED surface, mirroring the GET exactly: the event
    // shelf for this package category plus the submitted drinks' dossier
    // enhancement slugs, intersected with active service_addons. Anything
    // wider on a PUBLIC token endpoint that mints invoices lets a token
    // holder bill arbitrary addons — e.g. additional-bartender flat at its
    // base rate, bypassing the hosted-ratio/hourly pricing paths (2026-07-20
    // push review). Sequential queries: this is the HELD transaction client.
    const drinkRows = [];
    if (sigIds.length) {
      const r = await client.query('SELECT id, enhancements, syrup_id FROM cocktails WHERE id = ANY($1::text[])', [sigIds]);
      drinkRows.push(...r.rows);
    }
    if (mocIds.length) {
      const r = await client.query('SELECT id, enhancements, syrup_id FROM mocktails WHERE id = ANY($1::text[])', [mocIds]);
      drinkRows.push(...r.rows);
    }
    const activeRows = await client.query('SELECT slug FROM service_addons WHERE is_active = true');
    const activeSlugs = new Set(activeRows.rows.map((r) => r.slug));
    // Package-covered addons are un-billable AND un-addable, mirroring the
    // GET's offer filter and the submit path's coveredAddonSlugs skip.
    const covered = coveredSlugsOf(plan);
    const shelfSlugs = plan.package_category === 'hosted'
      ? [...EVENT_ADDON_SLUGS, ...HOSTED_EVENT_ADDON_SLUGS]
      : EVENT_ADDON_SLUGS;
    const offeredSlugs = new Set(shelfSlugs.filter((s) => activeSlugs.has(s) && !covered.has(s)));
    for (const row of drinkRows) {
      for (const e of (Array.isArray(row.enhancements) ? row.enhancements : [])) {
        if (e && typeof e.slug === 'string' && activeSlugs.has(e.slug) && !covered.has(e.slug)) offeredSlugs.add(e.slug);
      }
    }
    // A drink's dossier syrup is offered UNLESS the contract already owns it
    // (mirrors the GET; keeps a contract syrup from ever becoming lab-owned).
    const contractSyrups = contractSyrupSet(plan, sel);
    const offeredSyrupByDrink = new Map(
      drinkRows.map((r) => [r.id, r.syrup_id && !contractSyrups.has(r.syrup_id) ? r.syrup_id : null])
    );

    const storedLabSlugs = new Set(
      Object.entries(sel.addOns || {})
        .filter(([, m]) => m && m.labAdded === true)
        .map(([s]) => s)
    );
    const labAddOns = sanitizeLabAddOns(req.body?.addOns, offeredSlugs, storedLabSlugs);
    const labSyrups = sanitizeLabSyrups(req.body?.labSyrupSelections, offeredSyrupByDrink);

    // Rebuild selections: keep every non-lab addOns entry untouched; replace
    // the lab-added set wholesale with the desired state.
    const nextAddOns = {};
    for (const [slug, meta] of Object.entries(sel.addOns || {})) {
      if (!(meta && meta.labAdded === true)) nextAddOns[slug] = meta;
    }
    for (const [slug, meta] of Object.entries(labAddOns)) {
      if (nextAddOns[slug]) {
        // Planner already carries this slug (e.g. fence pick) — keep it; the
        // lab cannot double-bill an existing addon.
        continue;
      }
      nextAddOns[slug] = meta;
    }
    const nextSelections = { ...sel, addOns: nextAddOns, labSyrupSelections: labSyrups };

    await client.query(
      'UPDATE drink_plans SET selections = $1::jsonb, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(nextSelections), plan.id]
    );

    // Money: lab additions FOLD INTO THE PROPOSAL — lab-owned proposal_addons
    // rows, contract-safe reprice (foldExtrasIntoProposal, the exact submit-
    // path sequence), payment-status re-eval, then rebill. The open Balance
    // invoice absorbs the new total and re-renders line items (each lab addon
    // its own line, syrups a Signature Syrups line). Only when the client
    // owes nothing (every balance-bearing invoice locked) does a separate
    // itemized 'Enhancement Lab' invoice carry the remainder — owner rule,
    // 2026-07-20. That invoice is ordinary CONTRACT money (its items are in
    // total_price), which is why 'Enhancement Lab' left
    // OFF_LEDGER_INVOICE_LABELS in this same change. Nothing here ever takes
    // payment.
    let responseBreakdown = null;
    let responseBalance = null;
    if (plan.proposal_id) {
      // Same lock order as the submit financial path: drink_plans row, then
      // proposals FOR UPDATE, then invoice-row locks via the rebill helpers.
      const propRes = await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [plan.proposal_id]);
      const proposal = propRes.rows[0];
      const pkg = proposal?.package_id
        ? (await client.query('SELECT * FROM service_packages WHERE id = $1', [proposal.package_id])).rows[0]
        : null;
      // Fail closed: additions we cannot reprice are refused, never absorbed
      // unbilled. (400 so the page shows the save-error state, not the
      // locked screen — 409 is reserved for the window.)
      if (!proposal || !pkg || !proposal.guest_count || !proposal.event_duration_hours) {
        await client.query('ROLLBACK');
        throw new ValidationError({
          addOns: "We can't price enhancements for this event online yet. Reply to your confirmation email and we'll take care of it.",
        });
      }

      // Lab-owned proposal_addons reconcile. Lab-owned NOW = entries the
      // selections rebuild accepted as labAdded (a slug colliding with a
      // planner/admin-owned entry was skipped there, so it can NEVER reach
      // the upsert and reset a negotiated quantity/line_total — fleet
      // finding, 2026-07-20). Lab-owned BEFORE = labAdded flags in the
      // stored selections; removed = before − now.
      const prevLabSlugs = Object.entries(sel.addOns || {})
        .filter(([, m]) => m && m.labAdded === true)
        .map(([s]) => s);
      const ownedNextSlugs = Object.entries(nextAddOns)
        .filter(([, m]) => m && m.labAdded === true)
        .map(([s]) => s);
      const removedSlugs = prevLabSlugs.filter((s) => !ownedNextSlugs.includes(s));

      const addonsBefore = await loadRepriceAddons(client, proposal.id);

      if (removedSlugs.length > 0) {
        await client.query(
          `DELETE FROM proposal_addons
            WHERE proposal_id = $1
              AND addon_id IN (SELECT id FROM service_addons WHERE slug = ANY($2::text[]))`,
          [proposal.id, removedSlugs]
        );
      }
      const labAddonRows = ownedNextSlugs.length > 0
        ? (await client.query('SELECT * FROM service_addons WHERE slug = ANY($1) AND is_active = true', [ownedNextSlugs])).rows
        : [];
      for (const addon of labAddonRows) {
        const rate = Number(addon.rate);
        let quantity = 1;
        let lineTotal = rate;
        if (addon.billing_type === 'per_guest') {
          quantity = proposal.guest_count || 1;
          lineTotal = rate * quantity;
        }
        await client.query(`
          INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (proposal_id, addon_id) DO UPDATE SET
            quantity = EXCLUDED.quantity,
            line_total = EXCLUDED.line_total
        `, [proposal.id, addon.id, addon.name, addon.billing_type, rate, quantity, lineTotal]);
      }
      const addonsAfter = await loadRepriceAddons(client, proposal.id);

      // Syrup legs — the lab ADDS syrups on top of the contract; it must not
      // shave the contract's own syrups. CONTRACT syrups = the priced snapshot
      // set MINUS the ids the lab already owns (a prior fold writes lab syrups
      // into the snapshot, so they can't be told apart later without this
      // subtraction). before = contract ∪ prior-lab (= the whole snapshot, what
      // total_price reflects); after = contract ∪ THIS PUT's lab set. So an
      // empty reconcile reproduces the snapshot exactly (no shift), a lab add
      // adds only the new id, and a lab removal drops only a lab-owned id —
      // never a contract syrup. v1 planner syrups don't exist on v2 plans (the
      // only cohort that reaches the lab), so there is no legacy leg.
      // Reachability today: 0 v2 proposals carry contract syrups, but this
      // keeps the fold faithful if one ever does (cross-LLM push review,
      // 2026-07-20). Self-provided filtered from both sides.
      const selfProvided = Array.isArray(sel.syrupSelfProvided) ? sel.syrupSelfProvided : [];
      const dropSelfProvided = (id) => !selfProvided.includes(id);
      const storedLabSyrupIds = new Set(Object.values(sel.labSyrupSelections || {}).flat());
      const snapSyrups = (proposal.pricing_snapshot?.syrups?.selections || []).filter(dropSelfProvided);
      const contractSyrups = snapSyrups.filter((id) => !storedLabSyrupIds.has(id));
      const labSyrupIds = [...new Set(Object.values(labSyrups).flat())];
      const syrupsBefore = snapSyrups;
      const syrupsAfter = [...new Set([...contractSyrups, ...labSyrupIds])];

      const { snapshot } = await foldExtrasIntoProposal({
        client,
        proposal,
        pkg,
        addonsBefore,
        addonsAfter,
        syrupsBefore,
        syrupsAfter,
        numBarsBefore: proposal.num_bars ?? 0,
        numBarsAfter: proposal.num_bars ?? 0,
        statusChangeReason: 'enhancement_lab_reconciled',
      });

      // Rebill. The Balance/Full Payment refresh absorbs the fold. Then the
      // lab invoice reconciles under FOR UPDATE (it is independently payable;
      // a webhook can pay+lock it mid-reconcile — 2026-07-18 fleet finding):
      //   - absorbing invoice exists → any standing open lab invoice zeroes
      //     (its money now rides the Balance; also migrates any invoice
      //     minted under the pre-fold off-ledger model, and closes the
      //     post-refund-unlock coexistence corner);
      //   - nothing absorbs but locked invoices exist (the fully-paid case) →
      //     ONE open itemized lab invoice find-or-refreshed to the UNINVOICED
      //     remainder: total − external − lockedContract − other open invoices
      //     that already carry contract money. Both the locked AND open
      //     subtractions EXCLUDE 'Drink Plan Extras': pay-now extras are
      //     additive money that never enters total_price, so counting a paid
      //     (locked) or open one would shrink the remainder by money the
      //     contract never contained and under-bill the lab (cross-LLM push
      //     review, 2026-07-20). Subtracting the open others (Deposit,
      //     Additional Services, manual) also prevents billing a standing
      //     unpaid Additional Services invoice twice (fleet HIGH). A locked
      //     'Enhancement Lab' from a prior paid round IS contract money now
      //     (its items are in total_price), so it stays counted.
      await refreshUnlockedInvoices(proposal.id, client);
      const [absorbing, lockedAgg, unlockedOthers, labInvRes] = await Promise.all([
        client.query(
          `SELECT id FROM invoices
            WHERE proposal_id = $1 AND locked = false AND status != 'void'
              AND label IN ('Balance', 'Full Payment')
            LIMIT 1`,
          [proposal.id]
        ),
        client.query(
          `SELECT COALESCE(SUM(amount_due), 0) AS locked_total,
                  COUNT(*)::int AS locked_count
             FROM invoices
            WHERE proposal_id = $1 AND locked = true AND status != 'void'
              AND COALESCE(label, '') <> 'Drink Plan Extras'`,
          [proposal.id]
        ),
        client.query(
          `SELECT COALESCE(SUM(amount_due), 0) AS open_total
             FROM invoices
            WHERE proposal_id = $1 AND locked = false AND status != 'void'
              AND COALESCE(label, '') NOT IN ('Drink Plan Extras', 'Enhancement Lab')`,
          [proposal.id]
        ),
        client.query(
          `SELECT id, status, locked FROM invoices
            WHERE proposal_id = $1 AND label = 'Enhancement Lab' AND status <> 'void'
            ORDER BY id DESC
            FOR UPDATE`,
          [proposal.id]
        ),
      ]);
      const openLabInv = labInvRes.rows.find(
        (r) => (r.status === 'sent' || r.status === 'partially_paid') && !r.locked
      );
      const guardedLabUpdate = (cents, invId) => client.query(
        `UPDATE invoices SET amount_due = $1, updated_at = NOW()
          WHERE id = $2 AND locked = false AND status IN ('sent', 'partially_paid')`,
        [cents, invId]
      );
      if (absorbing.rows.length > 0) {
        if (openLabInv) {
          const upd = await guardedLabUpdate(0, openLabInv.id);
          if (upd.rowCount > 0) await writeLineItems(openLabInv.id, [], client);
        }
      } else if (lockedAgg.rows[0].locked_count > 0) {
        const totalCents = Math.round(Number(snapshot.total) * 100);
        const externalCents = Math.round(Number(proposal.external_paid || 0) * 100);
        const remainderCents = Math.max(0,
          totalCents - externalCents - Number(lockedAgg.rows[0].locked_total) - Number(unlockedOthers.rows[0].open_total));

        const lines = buildLabLineItems({ addonRows: labAddonRows, labSyrupIds, guestCount: proposal.guest_count });
        // Drift-fold so lines always sum to amount_due (ledger invariant).
        const foldLinesTo = (cents) => {
          const sum = lines.reduce((s, li) => s + li.line_total, 0);
          const drift = cents - sum;
          if (drift !== 0 && lines.length > 0) {
            const last = lines[lines.length - 1];
            last.line_total += drift;
            last.unit_price = last.quantity > 1 ? Math.round(last.line_total / last.quantity) : last.line_total;
          }
          return lines;
        };
        if (openLabInv) {
          const upd = await guardedLabUpdate(remainderCents, openLabInv.id);
          if (upd.rowCount > 0) {
            await writeLineItems(openLabInv.id, foldLinesTo(remainderCents), client);
          }
        } else if (remainderCents > 0) {
          const inv = await createInvoice(
            { proposalId: proposal.id, label: 'Enhancement Lab', amountDueCents: remainderCents, status: 'sent', dueDate: null },
            client
          );
          await writeLineItems(inv.id, foldLinesTo(remainderCents), client);
        }
      }

      await client.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
         VALUES ($1, 'enhancement_lab_updated', 'client', $2)`,
        [proposal.id, JSON.stringify({
          added: ownedNextSlugs,
          removed: removedSlugs,
          syrups: labSyrupIds,
          new_total: snapshot.total,
        })]
      );

      responseBreakdown = priceLabAdditions({ addonRows: labAddonRows, labSyrupIds, guestCount: proposal.guest_count });
      const paid = Number(proposal.amount_paid) || 0;
      const due = Math.max(0, Math.round((Number(snapshot.total) - paid) * 100) / 100);
      const dueDate = proposal.balance_due_date || null;
      responseBalance = {
        total: Number(snapshot.total),
        paid,
        due,
        due_date: dueDate,
        past_due: !!(due > 0 && dueDate && new Date(dueDate) < new Date()),
      };
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      lab_additions: { addOns: Object.fromEntries(Object.entries(nextAddOns).filter(([, m]) => m?.labAdded)), labSyrupSelections: labSyrups },
      lab_breakdown: responseBreakdown,
      balance: responseBalance,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }

  // Best-effort post-commit tail: rebuild the shopping list to reflect the
  // additions. setImmediate defers past the release() above, so this never
  // overlaps the held client (one-pooled-connection rule) and a failure can
  // never fail the already-sent response.
  if (planId) setImmediate(() => refreshListAfterLabChange(planId));
}));

module.exports = { router, refreshListAfterLabChange };
