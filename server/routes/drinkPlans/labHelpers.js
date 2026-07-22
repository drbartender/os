'use strict';

// Shared pure/near-pure layer for the Enhancement Lab surface (extracted
// verbatim from lab.js in the 2026-07-22 per-concern split; behavior-inert).
// Window/state logic, display pricing, line-item building, and the two PUT
// sanitizers. No queries here except via the SQL text constant — callers own
// their connections.

const { ValidationError } = require('../../utils/errors');
const { calculateSyrupCost } = require('../../utils/pricingEngine');
const { SYRUP_NAME_LOOKUP } = require('../../utils/shoppingListGen');
const { isDrinkPlanPreBooking } = require('../../utils/drinkPlanAccess');

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

// ─── PUT sanitizers ──────────────────────────────────────────────────

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

module.exports = {
  EVENT_ADDON_SLUGS,
  HOSTED_EVENT_ADDON_SLUGS,
  JACK_PAIR,
  PLAN_SELECT,
  labState,
  labAdditionsOf,
  coveredSlugsOf,
  contractSyrupSet,
  priceLabAdditions,
  buildLabLineItems,
  balanceOf,
  sanitizeLabAddOns,
  sanitizeLabSyrups,
};
