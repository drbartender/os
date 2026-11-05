/**
 * Drink-plan extras amount helper.
 *
 * computeExtrasBreakdown is the SINGLE source of truth for what a pay-now
 * drink-plan extras selection costs. It mirrors the create-intent math in
 * server/routes/stripe.js EXACTLY (raw enabled add-on slugs priced through the
 * pricing engine's own per-type math, bar rental from the pricing snapshot
 * branching on numBars, syrups via calculateSyrupCost excluding self-provided
 * and already-in-snapshot ids). Both the Stripe charge (create-intent) and the
 * "Drink Plan Extras" invoice (submit) call this so the invoice amount_due can
 * never drift from what the client was charged.
 *
 * ADD-ON PRICING (audit 2026-11-05, M3): every add-on is priced by the same
 * engine function the submit fold uses to raise total_price
 * (calculateAddonCost, or additionalBartenderLine for the bespoke bartender
 * branch). Before this, only per_guest multiplied; per_staff (parking-fee),
 * per_hour, per_guest_timed and per_100_guests were charged `rate` once, so
 * the fold raised total_price by the engine's figure while Stripe collected a
 * fraction of it and the booking showed a phantom balance. The inputs the
 * engine needs that the selection does not carry — the contract's hours and
 * the staff count a per_staff line bills — come from the caller (contract
 * hours, see contractDuration.js) and the pricing snapshot.
 *
 * Money in / money out is INTEGER CENTS. totalCents is the rounded SUM of the
 * dollar components (matching Math.round(extrasAmount * 100) in stripe.js), NOT
 * the sum of the individually-rounded component cents — so it equals the Stripe
 * charge to the cent. The per-component *Cents are individually rounded and are
 * exposed for callers/tests that want a component breakdown; the comp/void
 * reconcile (B4) does NOT use them — it derives the folded amount from the
 * persisted invoice line items.
 */

'use strict';

const { pool } = require('../db');
const {
  calculateSyrupCost, calculateAddonCost, additionalBartenderLine, gratuityBasisFromSnapshot,
} = require('./pricingEngine');
const { storedToInputCount } = require('./addonQuantity');

// Fallback when neither the caller nor the snapshot carries a duration. Four
// hours is the modal booked length (same assumption as shiftEndInstant.js).
const DEFAULT_DURATION_HOURS = 4;

// The staffing catalog rows (barback, banquet-server) carry minimum_hours = 4;
// the snapshot stores their engine OUTPUT quantity (hours x count) and not the
// catalog's minimum, so the inversion assumes it the way eventCreation.js does
// (STAFFING_ADDON_MIN_HOURS). Keep in step with addonQuantity.effectiveHoursFor.
const STAFFING_ADDON_MIN_HOURS = 4;

/**
 * The contract's hours for the extras math. Callers inside the submit
 * transaction and create-intent pass contract hours (contractDuration.js);
 * anything else falls back to the snapshot's priced duration, then 4.
 */
function resolveDurationHours(durationHours, pricingSnapshot) {
  const explicit = Number(durationHours);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const snap = Number(pricingSnapshot && pricingSnapshot.inputs && pricingSnapshot.inputs.durationHours);
  if (Number.isFinite(snap) && snap > 0) return snap;
  return DEFAULT_DURATION_HOURS;
}

/**
 * The staff count a per_staff add-on bills, derived from the snapshot the way
 * calculateProposal derives totalStaff: bartenders (staffing.actual plus any
 * additional-bartender add-ons, which gratuityBasisFromSnapshot already folds
 * in) plus barbacks / banquet servers already on the proposal, their counts
 * recovered from the stored per_hour quantities. Never below 1 (the engine's
 * own floor for a missing count).
 */
function staffCountFromSnapshot(pricingSnapshot, durationHours) {
  const { staffCount } = gratuityBasisFromSnapshot(pricingSnapshot, durationHours);
  let helpers = 0;
  for (const a of (pricingSnapshot && pricingSnapshot.addons) || []) {
    if (!a || (a.slug !== 'barback' && a.slug !== 'banquet-server')) continue;
    const count = storedToInputCount(
      { slug: a.slug, billing_type: a.billing_type || 'per_hour', minimum_hours: STAFFING_ADDON_MIN_HOURS },
      a.quantity, durationHours
    );
    helpers += count === null ? 1 : count;
  }
  return Math.max(1, (Number(staffCount) || 0) + helpers);
}

/**
 * Price ONE add-on catalog row the way the fold will. Returns the engine's
 * output quantity (what proposal_addons / the invoice line carry) and the
 * dollar total. Shared with invoiceExtras.writeExtrasLineItems so the invoice
 * lines sum to exactly the charge.
 *
 * @param {object} addon  a service_addons row (slug, rate, billing_type,
 *   extra_hour_rate, minimum_hours)
 * @param {{ guestCount:number, durationHours:number, staffCount:number, isClassPackage:boolean }} ctx
 * @returns {{ quantity:number, total:number, gratuityPerHour:number }}
 */
function priceExtrasAddon(addon, { guestCount, durationHours, staffCount, isClassPackage }) {
  if (addon.slug === 'additional-bartender') {
    const line = additionalBartenderLine({
      rate: addon.rate, guestCount, durationHours, qty: 1, isClassPackage: !!isClassPackage,
    });
    return { quantity: line.quantity, total: line.total, gratuityPerHour: line.gratuityPerHour };
  }
  const priced = calculateAddonCost(addon, guestCount || 0, durationHours, staffCount, 1);
  return { quantity: priced.quantity, total: Math.round(priced.total * 100) / 100, gratuityPerHour: 0 };
}

/**
 * @param {{ selections:object, guestCount:number, pricingSnapshot:object, numBars:number,
 *           durationHours?:number, isClassPackage?:boolean }} args
 *   durationHours: the CONTRACT's hours (contractDuration.js). isClassPackage:
 *   hosted class package (its bartenders are free; see pricingEngine HOSTED
 *   PACKAGE RULE EXCEPTION).
 * @param {object} [dbClient] transaction client or pool fallback (service_addons lookup)
 * @returns {Promise<{ totalCents:number, addonCents:number, barRentalCents:number, syrupCents:number }>}
 */
async function computeExtrasBreakdown(
  { selections, guestCount, pricingSnapshot, numBars, durationHours, isClassPackage = false },
  dbClient
) {
  const client = dbClient || pool;
  const sel = selections || {};
  const hours = resolveDurationHours(durationHours, pricingSnapshot);

  // Add-ons: raw enabled slugs (NOT validated against package coverage/triggers),
  // exactly as create-intent charges them, each priced by the engine's own
  // per-type math (see the header).
  const addOns = sel.addOns || {};
  const addonSlugs = Object.keys(addOns).filter((slug) => addOns[slug]?.enabled);

  let addonTotal = 0;
  if (addonSlugs.length > 0) {
    const addonRes = await client.query(
      'SELECT * FROM service_addons WHERE slug = ANY($1) AND is_active = true',
      [addonSlugs]
    );
    const staffCount = staffCountFromSnapshot(pricingSnapshot, hours);
    for (const addon of addonRes.rows) {
      addonTotal += priceExtrasAddon(addon, { guestCount, durationHours: hours, staffCount, isClassPackage }).total;
    }
  }

  // Bar rental: first-vs-additional fee from the pricing snapshot, keyed on the
  // numBars the client had BEFORE this submit (matches create-intent). Callers
  // in the submit transaction must pass the pre-increment numBars.
  let barRentalCost = 0;
  if (sel.logistics?.addBarRental === true) {
    const snapshot = pricingSnapshot || {};
    const barRental = snapshot.bar_rental || {};
    if ((numBars || 0) >= 1) {
      barRentalCost = barRental.additional_bar_fee || 100;
    } else {
      barRentalCost = barRental.first_bar_fee || 50;
    }
  }

  // Syrups: only NEW ones (exclude self-provided and any already priced into the
  // proposal snapshot), priced by calculateSyrupCost.
  const rawSyrups = sel.syrupSelections || {};
  const allSyrupIds = Array.isArray(rawSyrups)
    ? rawSyrups
    : [...new Set(Object.values(rawSyrups).flat())];
  // Array.isArray guard: a public token payload could send a non-array
  // syrupSelfProvided — a string would suppress charges via substring .includes,
  // an object/number would throw.
  const selfProvided = Array.isArray(sel.syrupSelfProvided) ? sel.syrupSelfProvided : [];
  const proposalSyrups = pricingSnapshot?.syrups?.selections || [];
  const newSyrupIds = allSyrupIds
    .filter((id) => !selfProvided.includes(id))
    .filter((id) => !proposalSyrups.includes(id));
  const syrupCost = calculateSyrupCost(newSyrupIds, guestCount);

  const addonCents = Math.round(addonTotal * 100);
  const barRentalCents = Math.round(barRentalCost * 100);
  const syrupCents = Math.round(syrupCost.total * 100);
  // Rounded SUM of the dollar components — equals stripe.js's extrasCents.
  const totalCents = Math.round((addonTotal + barRentalCost + syrupCost.total) * 100);

  return { totalCents, addonCents, barRentalCents, syrupCents };
}

module.exports = {
  computeExtrasBreakdown,
  priceExtrasAddon,
  staffCountFromSnapshot,
  resolveDurationHours,
};
