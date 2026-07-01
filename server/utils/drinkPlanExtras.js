/**
 * Drink-plan extras amount helper.
 *
 * computeExtrasBreakdown is the SINGLE source of truth for what a pay-now
 * drink-plan extras selection costs. It mirrors the create-intent math in
 * server/routes/stripe.js EXACTLY (raw enabled add-on slugs, per-guest vs flat
 * rates from service_addons, bar rental from the pricing snapshot branching on
 * numBars, syrups via calculateSyrupCost excluding self-provided and
 * already-in-snapshot ids). Both the Stripe charge (create-intent) and the
 * "Drink Plan Extras" invoice (submit) call this so the invoice amount_due can
 * never drift from what the client was charged.
 *
 * Money in / money out is INTEGER CENTS. totalCents is the rounded SUM of the
 * dollar components (matching Math.round(extrasAmount * 100) in stripe.js), NOT
 * the sum of the individually-rounded component cents — so it equals the Stripe
 * charge to the cent. The per-component *Cents are individually rounded and are
 * used by the comp/void total_price reconcile (B4), which needs the add-on +
 * bar-rental portion in isolation.
 */

'use strict';

const { pool } = require('../db');
const { calculateSyrupCost } = require('./pricingEngine');

/**
 * @param {{ selections:object, guestCount:number, pricingSnapshot:object, numBars:number }} args
 * @param {object} [dbClient] transaction client or pool fallback (service_addons lookup)
 * @returns {Promise<{ totalCents:number, addonCents:number, barRentalCents:number, syrupCents:number }>}
 */
async function computeExtrasBreakdown({ selections, guestCount, pricingSnapshot, numBars }, dbClient) {
  const client = dbClient || pool;
  const sel = selections || {};

  // Add-ons: raw enabled slugs (NOT validated against package coverage/triggers),
  // exactly as create-intent charges them.
  const addOns = sel.addOns || {};
  const addonSlugs = Object.keys(addOns).filter((slug) => addOns[slug]?.enabled);

  let addonTotal = 0;
  if (addonSlugs.length > 0) {
    const addonRes = await client.query(
      'SELECT slug, rate, billing_type FROM service_addons WHERE slug = ANY($1) AND is_active = true',
      [addonSlugs]
    );
    for (const addon of addonRes.rows) {
      const rate = Number(addon.rate);
      if (addon.billing_type === 'per_guest') {
        addonTotal += rate * (guestCount || 1);
      } else {
        addonTotal += rate;
      }
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
  const selfProvided = sel.syrupSelfProvided || [];
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

module.exports = { computeExtrasBreakdown };
