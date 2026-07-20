// The Enhancement Lab (planner v2, spec 2026-07-18 §3.3): the ONE selling
// surface. GET serves the shelves (submitted drinks + their enhancement
// dossiers + event extras + balance state); PUT reconciles the client's
// lab additions into the plan and refreshes the "Drink Plan Extras" invoice
// through the battle-tested drinkPlanExtras/invoiceExtras path. INVOICE-ONLY:
// no Stripe, no card fields, nothing here takes payment.
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
const { computeExtrasBreakdown } = require('../../utils/drinkPlanExtras');
const { calculateSyrupCost } = require('../../utils/pricingEngine');
const { createInvoice, writeExtrasLineItems } = require('../../utils/invoiceHelpers');
const { generateShoppingList } = require('../../utils/shoppingList');
const {
  loadCatalog,
  buildPlannerGeneratorInput,
  buildDerivationForPlan,
  applyAdminSetHolds,
  SYRUP_NAME_LOOKUP,
} = require('../../utils/shoppingListGen');
const { normalizeName } = require('../../utils/potionCatalog');

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
         p.balance_due_date, p.event_duration_hours,
         sp.category AS package_category
    FROM drink_plans dp
    LEFT JOIN proposals p ON p.id = dp.proposal_id
    LEFT JOIN service_packages sp ON sp.id = p.package_id
   WHERE dp.token = $1`;

function labState(plan) {
  // v2 only: legacy (v1) plans never see the lab, even by direct URL — their
  // wizard has its own syrup/upsell mechanics and never disclosed lab pricing.
  if (plan.planner_version < 2) return 'not_ready';
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
  // shows exactly what computeExtrasBreakdown will bill (single money source).
  // A syrup_id the pricing engine can't price (legacy alias, admin typo in the
  // recipe editor) is never offered: a $0 upsell would bill nothing while
  // still flipping the client's shopping-list line off.
  const syrupPriceFor = (syrupId) =>
    syrupId ? calculateSyrupCost([syrupId], plan.guest_count || 1).total : 0;

  const drink = (row, table) => {
    const syrupPrice = syrupPriceFor(row.syrup_id);
    return {
      id: row.id,
      table,
      name: row.name,
      emoji: row.emoji,
      description: row.description,
      enhancements: Array.isArray(row.enhancements) ? row.enhancements : [],
      syrup: row.syrup_id && syrupPrice > 0
        ? { id: row.syrup_id, name: SYRUP_NAME_LOOKUP[row.syrup_id] || row.syrup_id, price: syrupPrice }
        : null,
    };
  };

  const isHosted = plan.package_category === 'hosted';
  const eventSlugs = isHosted ? [...EVENT_ADDON_SLUGS, ...HOSTED_EVENT_ADDON_SLUGS] : EVENT_ADDON_SLUGS;

  // Server-exact pricing of the STORED lab additions (integer cents), so the
  // page's running total always equals what the invoice bills — the client
  // must never re-derive pack discounts or shared-flavor dedup on its own.
  const storedAdditions = labAdditionsOf(sel);
  let labBreakdown = null;
  if (plan.proposal_id) {
    labBreakdown = await computeExtrasBreakdown({
      selections: {
        addOns: storedAdditions.addOns,
        syrupSelections: storedAdditions.labSyrupSelections,
        syrupSelfProvided: [],
        logistics: {},
      },
      guestCount: plan.guest_count,
      pricingSnapshot: plan.pricing_snapshot,
      numBars: plan.num_bars,
    });
  }

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
    addon_pricing: addonRows.rows.filter((a) => !JACK_PAIR.includes(a.slug)),
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
    const shelfSlugs = plan.package_category === 'hosted'
      ? [...EVENT_ADDON_SLUGS, ...HOSTED_EVENT_ADDON_SLUGS]
      : EVENT_ADDON_SLUGS;
    const offeredSlugs = new Set(shelfSlugs.filter((s) => activeSlugs.has(s)));
    for (const row of drinkRows) {
      for (const e of (Array.isArray(row.enhancements) ? row.enhancements : [])) {
        if (e && typeof e.slug === 'string' && activeSlugs.has(e.slug)) offeredSlugs.add(e.slug);
      }
    }
    const offeredSyrupByDrink = new Map(drinkRows.map((r) => [r.id, r.syrup_id || null]));

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

    // Money: the cumulative LAB-ONLY breakdown funds its OWN 'Enhancement Lab'
    // invoice (single money source: computeExtrasBreakdown). It is deliberately
    // NOT the 'Drink Plan Extras' invoice — that label is welded to the submit
    // pay-now Stripe charge (webhook dedup, comp/void reconcile) and must never
    // drift from what the card was charged. Planner-time charges (fence picks,
    // submit extras) live on their invoices and are excluded here by
    // construction. refreshUnlockedInvoices skips non-standard labels, so
    // proposal edits can't rewrite this invoice. The label is OFF-LEDGER
    // (proposalMoneyShared.OFF_LEDGER_INVOICE_LABELS): its amounts have no
    // total_price entry, the webhook skips the amount_paid roll-up when it is
    // paid, and the Balance lockedTotal excludes it — lab dollars never
    // shrink what the contract still owes (2026-07-20 push review).
    let responseBreakdown = null;
    if (plan.proposal_id) {
      const labOnlySelections = {
        addOns: Object.fromEntries(
          Object.entries(nextAddOns).filter(([, meta]) => meta && meta.labAdded === true)
        ),
        syrupSelections: labSyrups,
        syrupSelfProvided: [],
        logistics: {},
      };
      const breakdown = await computeExtrasBreakdown({
        selections: labOnlySelections,
        guestCount: plan.guest_count,
        pricingSnapshot: plan.pricing_snapshot,
        numBars: plan.num_bars,
      }, client);
      responseBreakdown = breakdown;

      // Find-or-refresh scoped to the lab label. Settled (paid/locked) lab
      // invoices are subtracted so a pay-then-add-more client gets a fresh
      // delta invoice, never a mutated paid one and never a double-bill.
      // FOR UPDATE: the lab invoice is independently payable (public invoice
      // link → Stripe webhook → linkPaymentToInvoice flips it paid+locked
      // under its own row lock). Locking the read here makes read→decide→
      // update atomic against that writer, and the belt-and-braces guard on
      // the UPDATE below means even a missed case can never mutate a
      // paid/locked invoice (database-review fleet finding, 2026-07-18).
      const labInvRes = await client.query(
        `SELECT id, status, locked, amount_paid FROM invoices
          WHERE proposal_id = $1 AND label = 'Enhancement Lab' AND status <> 'void'
          ORDER BY id DESC
          FOR UPDATE`,
        [plan.proposal_id]
      );
      const openInv = labInvRes.rows.find(
        (r) => (r.status === 'sent' || r.status === 'partially_paid') && !r.locked
      );
      const settledCents = labInvRes.rows
        .filter((r) => !openInv || r.id !== openInv.id)
        .reduce((sum, r) => sum + (Number(r.amount_paid) || 0), 0);
      const dueCents = Math.max(0, breakdown.totalCents - settledCents);

      const lineItemState = {
        selections: labOnlySelections,
        guestCount: plan.guest_count,
        pricingSnapshot: plan.pricing_snapshot,
        numBars: plan.num_bars,
      };
      if (openInv) {
        const upd = await client.query(
          `UPDATE invoices SET amount_due = $1, updated_at = NOW()
            WHERE id = $2 AND locked = false AND status IN ('sent', 'partially_paid')`,
          [dueCents, openInv.id]
        );
        if (upd.rowCount > 0) {
          await writeExtrasLineItems(openInv.id, { ...lineItemState, totalCents: dueCents }, client);
        }
      } else if (dueCents > 0) {
        const inv = await createInvoice(
          { proposalId: plan.proposal_id, label: 'Enhancement Lab', amountDueCents: dueCents, status: 'sent', dueDate: null },
          client
        );
        await writeExtrasLineItems(inv.id, { ...lineItemState, totalCents: dueCents }, client);
      }
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      lab_additions: { addOns: Object.fromEntries(Object.entries(nextAddOns).filter(([, m]) => m?.labAdded)), labSyrupSelections: labSyrups },
      lab_breakdown: responseBreakdown,
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
