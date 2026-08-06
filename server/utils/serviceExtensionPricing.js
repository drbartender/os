'use strict';

/**
 * Price an on-site service extension as the pricing engine's delta.
 *
 * Spec: docs/superpowers/specs/2026-07-25-service-extension-design.md section 6.
 *
 * Discipline copied from foldExtrasIntoProposal: both legs price at CATALOG
 * (totalPriceOverride: null) and we difference the SERVICE portion, never
 * `.total`. A total_price_override is a service-level contract that the engine
 * substitutes for the calculated total, so differencing `.total` with an
 * override present collapses the service delta to zero (many Core Reaction
 * bookings are sold at $400 against a $350 catalog).
 *
 * The two legs differ ONLY in durationHours, so every component with no
 * duration term cancels exactly. calculateSyrupCost(selections, guestCount)
 * has no duration term, so syrups cancel and both legs pass []. Add-ons do NOT
 * cancel (per_guest_timed and per_hour carry duration terms), so the real
 * proposal_addons rows are loaded.
 *
 * READ-ONLY. This function never writes. The caller persists.
 */

const { calculateProposal, isHostedPackage } = require('./pricingEngine');
const { loadRepriceAddons } = require('./proposalExtrasFold');
const { eventEndInstantForDuration, maxDurationHoursBeforeCurfew } = require('./eventEndInstant');
// THE definition of "gratuity" for payroll purposes. It pools BOTH canonical
// breakdown labels, 'Shared Gratuity' (the forced sub-100-guest over-ratio
// surcharge) and 'Gratuity' (client-elected), per GRATUITY_PAYROLL_LABELS.
const { extractGratuityCents } = require('./payrollMath');

// Cap on how far a single request may extend, in hours. A mis-scroll must not
// be able to invoice a client for a second event.
const MAX_EXTENSION_HOURS = 3;

// Requests move in 30-minute steps (spec section 3 decision 5).
const INCREMENT_HOURS = 0.5;

/**
 * How many hours a given event may actually add, after BOTH limits: the
 * mis-scroll cap and the 2:00 AM insurance curfew (eventEndInstant.js).
 * Floored to a whole 30-minute step, never negative.
 *
 * ONE function so the picker and the validator cannot drift: an offered step
 * the validator would reject is a staffer promising a client time we then
 * refuse to sell, in front of the client, mid-event.
 *
 * Returns null when the event's stored time is unparseable, which callers
 * already surface as an explicit conflict rather than a silent zero.
 */
async function allowedAdditionalHours(client, proposalId, contractedHours) {
  const curfew = await maxDurationHoursBeforeCurfew(client, proposalId);
  if (!curfew) return null;
  const roomToCurfew = curfew.maxHours - Number(contractedHours);
  const raw = Math.min(MAX_EXTENSION_HOURS, roomToCurfew);
  // Floor to a 30-minute step, with a tolerance so float noise cannot shave a
  // legitimate step (e.g. 0.9999999 must still yield 0.5, and 1.0 yield 1.0).
  const steps = Math.floor(raw / INCREMENT_HOURS + 1e-6);
  return {
    hours: Math.max(0, steps * INCREMENT_HOURS),
    curfewDisplay: curfew.curfewDisplay,
    curfewBinds: roomToCurfew < MAX_EXTENSION_HOURS,
  };
}

/** Dollars-to-cents, matching invoiceShared.toCents rounding. */
function toCents(dollars) {
  return Math.round(Number(dollars) * 100);
}

/**
 * Total for an engine result, in cents. Includes both gratuity flavours:
 * the client-elected line is layered on top of serviceTotal, and the forced
 * sub-100-guest surcharge is inside staffing.cost -> subtotal -> serviceTotal.
 */
function totalCentsOf(snapshot) {
  return toCents(snapshot.total);
}

/**
 * The STAFF gratuity in an engine result, in cents.
 *
 * Deliberately NOT `snapshot.gratuity.total`, which holds only the
 * client-elected line. Payroll pools BOTH canonical breakdown labels
 * ('Shared Gratuity' + 'Gratuity') via extractGratuityCents, and the forced
 * sub-100-guest over-ratio surcharge carries the 'Shared Gratuity' label while
 * living inside staffing.cost. Reading `.gratuity.total` would classify that
 * surcharge as DRB service revenue, so on a 50-guest two-bartender event the
 * $25/hr surcharge the rule exists to pay bartenders with would never reach the
 * staff pool. This is the load-bearing hosted/staffing gratuity rule CLAUDE.md
 * flags as re-lost multiple times; extractGratuityCents is the single source.
 */
function staffGratuityCentsOf(snapshot) {
  return extractGratuityCents(snapshot);
}

async function computeExtensionDelta({ client, proposalId, requestedDurationHours }) {
  const propRes = await client.query(
    `SELECT id, package_id, guest_count, event_duration_hours, num_bars, num_bartenders,
            gratuity_rate, tip_jar, adjustments, total_price_override
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = propRes.rows[0];
  if (!proposal) return { ok: false, reason: 'missing_proposal' };
  if (!proposal.package_id || !proposal.event_duration_hours || !proposal.guest_count) {
    return { ok: false, reason: 'missing_package' };
  }

  const pkgRes = await client.query('SELECT * FROM service_packages WHERE id = $1', [proposal.package_id]);
  const pkg = pkgRes.rows[0];
  if (!pkg) return { ok: false, reason: 'missing_package' };

  const contracted = Number(proposal.event_duration_hours);
  const requested = Number(requestedDurationHours);
  if (!Number.isFinite(requested) || requested <= contracted) {
    return { ok: false, reason: 'not_an_extension' };
  }
  const added = Math.round((requested - contracted) * 100) / 100;
  if (added > MAX_EXTENSION_HOURS) return { ok: false, reason: 'over_cap' };
  // Integer number of 30-minute steps, tolerant of float noise.
  const steps = added / INCREMENT_HOURS;
  if (Math.abs(steps - Math.round(steps)) > 1e-6) return { ok: false, reason: 'bad_increment' };

  // The 2:00 AM curfew, enforced HERE because this function is the one both
  // the pre-flight check and the in-transaction repricing call. A request that
  // would run the bar past 2:00 AM is refused even though the client is
  // willing to pay: serving past it can void the liquor liability policy, so
  // the uninsured hour costs far more than the sale.
  const allowed = await allowedAdditionalHours(client, proposalId, contracted);
  if (!allowed) return { ok: false, reason: 'unparseable_time' };
  if (added > allowed.hours) {
    return { ok: false, reason: 'past_curfew', curfewDisplay: allowed.curfewDisplay, allowedHours: allowed.hours };
  }

  const contractedEnd = await eventEndInstantForDuration(client, proposalId, contracted);
  const requestedEnd = await eventEndInstantForDuration(client, proposalId, requested);
  if (!contractedEnd || !requestedEnd) return { ok: false, reason: 'unparseable_time' };

  const addons = await loadRepriceAddons(client, proposalId);

  // Identical on both legs. Only durationHours moves.
  const common = {
    pkg,
    guestCount: proposal.guest_count,
    numBars: proposal.num_bars,
    numBartenders: proposal.num_bartenders,
    addons,
    syrupSelections: [], // no duration term, cancels across the legs
    adjustments: proposal.adjustments || [],
    totalPriceOverride: null, // price the delta at CATALOG
    gratuityRate: proposal.gratuity_rate,
    tipJar: proposal.tip_jar,
  };

  const before = calculateProposal({ ...common, durationHours: contracted });
  const after = calculateProposal({ ...common, durationHours: requested });

  // The whole delta is the total delta. The gratuity share of it comes from the
  // pooled payroll labels, and service is whatever is left. Deriving service as
  // the remainder (rather than differencing a separate service figure) means the
  // three numbers can never fail to reconcile.
  const amountCents = totalCentsOf(after) - totalCentsOf(before);
  const gratuityDeltaCents = staffGratuityCentsOf(after) - staffGratuityCentsOf(before);
  const serviceDeltaCents = amountCents - gratuityDeltaCents;

  // Catalog totals are monotonic in duration for every current package, so a
  // negative delta means pathological pricing data (e.g. a >100% negative
  // adjustment binding the zero clamp at both durations). That is corruption to
  // surface loudly, not a shape to invoice: throw rather than hand the create
  // route a negative amount. Zero stays legal (D13, the acceptance-only path).
  if (amountCents < 0) {
    throw new Error(`computeExtensionDelta: negative delta ${amountCents} for proposal ${proposalId}`);
  }

  return {
    ok: true,
    contractedDurationHours: contracted,
    requestedDurationHours: requested,
    contractedEndDisplay: contractedEnd.endDisplay,
    requestedEndDisplay: requestedEnd.endDisplay,
    contractedEndInstant: contractedEnd.endInstant,
    serviceDeltaCents,
    gratuityDeltaCents,
    amountCents,
    isHosted: isHostedPackage(pkg),
  };
}

module.exports = {
  computeExtensionDelta, allowedAdditionalHours, MAX_EXTENSION_HOURS, INCREMENT_HOURS,
};
