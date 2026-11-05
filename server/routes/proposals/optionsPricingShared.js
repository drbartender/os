// The pricing identity shared by the options quote (publicOptions.js) and the
// switch commit (publicSwitch.js). These two endpoints MUST price a given
// configuration identically: the switch 409s whenever its engine total differs
// from the number the client acknowledged off a quote card, so any drift
// between the two is not a subtle bug, it is every cross-package switch
// grinding 409s forever. Everything that defines "how a configuration is
// priced for this proposal" lives here so it exists exactly once.
//
// This is a plain shared module (the changeRequests.js pattern) rather than
// properties hung off a router export: router-attached helpers exist in this
// repo but only tests consume them, and a production money seam deserves the
// proven mechanism.
const { visibleAddonsFor } = require('../../utils/proposalRules');
const { storedToInputCount } = require('../../utils/addonQuantity');
const { overrideOnlyBartenders } = require('../../utils/changeRequests');

// Everything priceProposedState reads off the proposal. A column missed here
// prices as undefined and silently drops a discount, the syrups, or the
// gratuity mandate floor, so this list is load-bearing rather than convenient.
// (The switch endpoint appends its guard fields; the pricing set is THIS.)
const PROPOSAL_SELECT = `
  p.id, p.token, p.status, p.package_id, p.total_price, p.total_price_override,
  p.guest_count, p.event_duration_hours, p.num_bars, p.num_bartenders,
  p.event_date, p.event_start_time, p.event_location, p.event_type,
  p.event_type_custom, p.event_type_category,
  p.adjustments, p.pricing_snapshot, p.client_provides_glassware,
  p.gratuity_rate, p.tip_jar, p.gratuity_floor_rate, p.client_signed_at`;

/** Event facts, not package features: an admin-added add-on the client cannot
 *  see (a parking fee) follows the event onto every option (spec 2026-08-14,
 *  decision 10). applies_to is the only gate that can drop one. */
function fitsPackage(addon, pkg) {
  return addon.applies_to === 'all' || addon.applies_to === pkg.category;
}

/** The proposal's own add-ons that are INVISIBLE to the client on the current
 *  package: Dallas put them there, the offered extras list can never contain
 *  them, so the request body can never carry them back. Returned as catalog
 *  addon OBJECTS (downstream needs applies_to and name). A retired add-on
 *  absent from the active catalog is skipped: it never carried onto
 *  alternatives before this module existed either.
 *  `selectionIds` is the client's current selection, because visibility is
 *  selection-dependent (a dependent add-on is visible only while its parent
 *  is selected). `tierIds` excludes BYOB support tiers, which are a
 *  configuration axis, not a hidden extra. */
function computeOwnHidden({ catalog, currentPkg, guestCount, currentAddonIds, selectionIds = [], tierIds }) {
  const visible = new Set(
    visibleAddonsFor({
      addons: catalog.addons, pkg: currentPkg, guestCount: Number(guestCount),
      addonIds: selectionIds,
    }).map((a) => a.id)
  );
  return currentAddonIds
    .filter((id) => !visible.has(id) && !tierIds.has(id))
    .map((id) => catalog.addons.find((a) => a.id === id))
    .filter(Boolean);
}

/** overrideOnlyBartenders (the stored crew kept only when it is a real
 *  override, never a persisted derivation) now lives beside priceProposedState
 *  in utils/changeRequests.js, which applies it whenever a request carries no
 *  num_bartenders, so the quote, the switch and the change-request preview
 *  price the crew by one rule (audit PRC-02). Re-exported here so the quote
 *  and the switch keep their explicit pass and their import. */

/** Integer ids only: the body is public input that selects priced rows. */
function safeIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw.slice(0, 40)) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return [...new Set(out)];
}

/** Recover engine INPUTS from stored proposal_addons rows.
 *  `proposal_addons.quantity` is an OUTPUT column (for per_guest it stores the
 *  guest count); feeding it back in multiplies twice. storedToInputCount is the
 *  ONE sanctioned inverter (utils/addonQuantity.js); this wrapper exists so the
 *  quote and the switch recover identical inputs by construction.
 *  `addonMetaRows` must cover ALL the proposal's add-ons, active or not: a
 *  retired add-on still on the proposal must recover its real count rather
 *  than silently reprice at 1. */
function recoverAddonInputs(currentAddonRows, addonMetaRows, durationHours) {
  const quantities = {};
  const variants = {};
  for (const r of currentAddonRows) {
    if (r.variant !== null && r.variant !== undefined) variants[String(r.addon_id)] = r.variant;
    const addon = addonMetaRows.find((a) => a.id === r.addon_id);
    if (!addon) continue;
    const count = storedToInputCount(addon, r.quantity, durationHours, {
      lineTotal: r.line_total, rate: r.rate,
    });
    if (count !== null && count > 1) quantities[String(r.addon_id)] = count;
  }
  return { quantities, variants };
}

module.exports = {
  PROPOSAL_SELECT, fitsPackage, computeOwnHidden, overrideOnlyBartenders,
  safeIds, recoverAddonInputs,
};
