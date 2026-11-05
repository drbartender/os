/**
 * Drink-plan extras amount helper.
 *
 * computeExtrasBreakdown is the SINGLE source of truth for what a pay-now
 * drink-plan extras selection costs: the Stripe charge (create-drink-plan-intent
 * in server/routes/stripe.js) and the "Drink Plan Extras" invoice (submit) both
 * call it, so the invoice amount_due can never drift from what the client was
 * charged.
 *
 * Priced the way the submit FOLD prices them (audit PRC-03, 2026-11-05). The
 * fold adds an add-on or a bar to total_price as the difference of two engine
 * legs at today's catalog (proposalExtrasFold.catalogEngineArgs, before and
 * after the addition), so this helper prices the same two legs from the same
 * inputs: the package row, the reprice-ready add-ons already on the contract,
 * the contract's hours, the row's bars, bartenders, adjustments and gratuity.
 * A per_hour server then bills its hours, a timed per-guest bar its extra
 * hours, a per_staff fee the crew it rides on, and the charge, the invoice
 * lines and the contract delta agree to the cent. Before this the helper
 * priced every non-per_guest add-on as one flat catalog rate while the fold
 * added the engine's figure, so a banquet server was charged 7500 against the
 * 30000 the contract absorbed, and the remainder was owed with nothing
 * invoicing it. The submit checks the fold's own delta against this figure
 * before it mints the invoice.
 *
 * Syrups alone never fold (routes/drinkPlans/submit.js: no financial side
 * effects, total_price stands), so a syrup-only selection is priced directly
 * by calculateSyrupCost, as before, and stays additive money outside the
 * contract (money laws 5 and 7; the netting reads its lines as unfolded).
 *
 * A proposal the fold cannot price (no package, no guests or no hours) refuses
 * an add-on or a bar on the pay-now path with EXTRAS_NOT_PRICEABLE rather than
 * half-billing it: the fold would skip it too, and the add-to-balance path
 * bills it with the event.
 *
 * Money in / money out is INTEGER CENTS. `lines` are the invoice's line items
 * (cents) and sum to totalCents; an 'addon' line or a bar line marks the
 * invoice as folded (invoiceExtras.extrasLinesAreFolded).
 */

'use strict';

const { pool } = require('../db');
const { calculateProposal, calculateSyrupCost } = require('./pricingEngine');
const { loadRepriceAddons, catalogEngineArgs } = require('./proposalExtrasFold');
const { contractDurationHours } = require('./contractDuration');
const { ConflictError } = require('./errors');

const cents = (dollars) => Math.round(Number(dollars || 0) * 100);

function syrupLine(totalBottles, lineCents) {
  const bottles = Number(totalBottles) || 0;
  const bottleSuffix = bottles > 1 ? ` (${bottles} bottles)` : '';
  return {
    description: `Hand-Crafted Syrups${bottleSuffix}`,
    quantity: 1, unit_price: lineCents, line_total: lineCents, source_type: 'fee', source_id: null,
  };
}

function addonDescription(priced, guestCount) {
  const name = priced.name;
  switch (priced.billing_type) {
    case 'per_guest':
    case 'per_guest_timed':
      return `${name} (${guestCount} guests)`;
    case 'per_hour':
      return `${name} (${priced.quantity}hrs)`;
    case 'per_staff':
      return `${name} (${priced.quantity} staff)`;
    default:
      return name;
  }
}

/**
 * @param {{ selections:object, proposal:object }} args
 *   proposal: the proposals row (id, package_id, guest_count,
 *   event_duration_hours, num_bars, num_bartenders, gratuity_rate, tip_jar,
 *   gratuity_floor_rate, adjustments, pricing_snapshot) as the caller read it:
 *   the submit's locked, PRE-mutation row (before the bar increment and the
 *   add-on upsert), or the intent route's read.
 * @param {object} [dbClient] transaction client or pool fallback
 * @returns {Promise<{ totalCents:number, addonCents:number, barRentalCents:number,
 *   syrupCents:number, lines:Array, folded:boolean }>}
 */
async function computeExtrasBreakdown({ selections, proposal }, dbClient) {
  const client = dbClient || pool;
  const sel = selections || {};
  const snapshot = proposal.pricing_snapshot && typeof proposal.pricing_snapshot === 'object'
    ? proposal.pricing_snapshot : {};
  const guestCount = Number(proposal.guest_count) || 0;
  const numBars = Number(proposal.num_bars) || 0;

  // Add-ons: raw enabled slugs, exactly as the submit honours a user-added one.
  const addOns = sel.addOns || {};
  const addonSlugs = Object.keys(addOns).filter((slug) => addOns[slug]?.enabled);
  const addBar = sel.logistics?.addBarRental === true;

  // Syrups: the client's selection minus the self-provided ones (never
  // priced); NEW ones are those not already priced into the contract's
  // snapshot. Array.isArray guards: a public token payload could send a
  // non-array syrupSelfProvided (a string would suppress charges via
  // substring .includes, an object would throw).
  const rawSyrups = sel.syrupSelections || {};
  const allSyrupIds = Array.isArray(rawSyrups) ? rawSyrups : [...new Set(Object.values(rawSyrups).flat())];
  const selfProvided = Array.isArray(sel.syrupSelfProvided) ? sel.syrupSelfProvided : [];
  const dropSelfProvided = (id) => !selfProvided.includes(id);
  const syrupsBefore = (snapshot.syrups?.selections || []).filter(dropSelfProvided);
  const newSyrupIds = allSyrupIds.filter(dropSelfProvided).filter((id) => !syrupsBefore.includes(id));

  if (addonSlugs.length === 0 && !addBar) {
    const syrupCost = calculateSyrupCost(newSyrupIds, guestCount);
    const syrupCents = cents(syrupCost.total);
    return {
      totalCents: syrupCents, addonCents: 0, barRentalCents: 0, syrupCents,
      lines: syrupCents > 0 ? [syrupLine(syrupCost.totalBottles, syrupCents)] : [],
      folded: false,
    };
  }

  const pkg = proposal.package_id
    ? (await client.query('SELECT * FROM service_packages WHERE id = $1', [proposal.package_id])).rows[0]
    : null;
  if (!pkg || guestCount <= 0 || !(Number(proposal.event_duration_hours) > 0)) {
    throw new ConflictError(
      'These extras can\'t be paid separately on this booking. Choose "add to my balance" and they will be billed with your event.',
      'EXTRAS_NOT_PRICEABLE'
    );
  }

  const addonRows = addonSlugs.length > 0
    ? (await client.query('SELECT * FROM service_addons WHERE slug = ANY($1) AND is_active = true', [addonSlugs])).rows
    : [];
  const addonsBefore = await loadRepriceAddons(client, proposal.id);
  const contractHours = await contractDurationHours(client, proposal.id, proposal.event_duration_hours);
  // The fold's upsert keys on addon_id: an add-on already on the contract is
  // not added a second time. A new row carries the input count 1, which is
  // what the fold's upsert prices and loadRepriceAddons recovers.
  const onContract = new Set(addonsBefore.map((a) => a.id));
  const newRows = addonRows.filter((a) => !onContract.has(a.id)).map((a) => ({ ...a, quantity: 1 }));
  // The fold's syrup rule: a payload that carries syrupSelections is the
  // selection; one without the key leaves the contract's syrups alone.
  const clientSentSyrups = sel.syrupSelections !== undefined && sel.syrupSelections !== null;
  const syrupsAfter = clientSentSyrups ? allSyrupIds.filter(dropSelfProvided) : syrupsBefore;

  const leg = (addons, syrups, bars) => calculateProposal(catalogEngineArgs({
    proposal, pkg, contractHours, numBars: bars, numBartenders: proposal.num_bartenders,
    addons, syrups, adjustments: Array.isArray(proposal.adjustments) ? proposal.adjustments : [],
  }));
  const before = leg(addonsBefore, syrupsBefore, numBars);
  const after = leg([...addonsBefore, ...newRows], syrupsAfter, numBars + (addBar ? 1 : 0));
  const totalCents = cents(after.total) - cents(before.total);

  const lines = [];
  let addonCents = 0;
  for (const row of newRows) {
    const priced = (after.addons || []).find((a) => a.id === row.id);
    if (!priced) continue;
    const lineCents = cents(priced.line_total);
    addonCents += lineCents;
    const qty = Number(priced.quantity) > 0 ? Number(priced.quantity) : 1;
    lines.push({
      description: addonDescription(priced, guestCount),
      quantity: qty, unit_price: Math.round(lineCents / qty), line_total: lineCents,
      source_type: 'addon', source_id: row.id,
    });
  }
  const barRentalCents = cents(after.bar_rental?.total) - cents(before.bar_rental?.total);
  if (addBar) {
    lines.push({
      description: numBars >= 1 ? 'Additional Portable Bar' : 'Portable Bar Rental',
      quantity: 1, unit_price: barRentalCents, line_total: barRentalCents, source_type: 'fee', source_id: null,
    });
  }
  const syrupCents = cents(after.syrups?.total) - cents(before.syrups?.total);
  if (syrupCents !== 0) lines.push(syrupLine(after.syrups?.total_bottles, syrupCents));
  // Whatever else the addition moved on the contract (an existing per_staff fee
  // repriced by the crew a server adds, the gratuity line an added bartender
  // brings): the lines must sum to what the contract absorbed.
  const remainder = totalCents - lines.reduce((sum, line) => sum + line.line_total, 0);
  if (remainder !== 0) {
    lines.push({ description: 'Contract repricing', quantity: 1, unit_price: remainder, line_total: remainder, source_type: 'fee', source_id: null });
  }
  return { totalCents, addonCents, barRentalCents, syrupCents, lines, folded: true };
}

module.exports = { computeExtrasBreakdown };
