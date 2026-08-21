// Turns the options quote into ONE ladder: how much Dr. Bartender handles, from
// bare bar service up to a fully stocked bar. Same event on every rung; the only
// thing that changes is how much we take off the client's hands.
//
// Pure. No React, no network, no formatting beyond money. The component renders
// what this returns, which is what lets the lane placement and the three price
// sublines be tested without mounting a drawer.

import { fmt } from '../proposalView/helpers';

// Whole dollars. A package minimum is a round number and reads like one:
// "$550 minimum", not "$550.00 minimum". Rates keep their cents via fmt.
const fmtWhole = (n) => `$${Math.round(Number(n)).toLocaleString('en-US')}`;

// Lane identity is DATA. Every hosted package is category 'hosted' and
// pricing_type 'per_guest', so neither can tell a full bar from beer-and-wine
// from the zero-proof package: bar_type is the only discriminator, and it ships
// on every option entry for exactly this reason. A slug list here would break on
// the next catalog edit.
const LANES = [
  { key: 'full_bar', label: 'Full bar', barType: 'full_bar' },
  { key: 'beer_wine', label: 'Beer & wine', barType: 'beer_and_wine' },
];
const SIDEWAYS_BAR_TYPE = 'mocktail';
const BYOB_BAR_TYPE = 'service_only';

/** The BYOB tier rows, as rungs. `addon_id: null` is bar-service-only. */
function tierRung(t) {
  return {
    // Tier entries carry no `available` on the wire, and the commit CTA gates
    // on it, so without this default EVERY BYOB rung renders with no way to act
    // on it: the ladder's whole bottom half, which is the default open state for
    // most clients. A tier the server priced and returned is by definition
    // offerable, so a numeric total IS availability here.
    available: t.total !== null && t.total !== undefined,
    ...t,
    kind: 'tier',
    rungKey: `tier:${t.addon_id ?? 'none'}`,
  };
}
function optionRung(o) {
  return { ...o, kind: 'option', rungKey: `pkg:${o.package_id}` };
}

/**
 * @param {object} quote the options payload (options, tiers, current_package_id)
 * @returns {{anchor, byobRungs, hostedLanes, sideways, unmapped, hasHostedOptions}}
 */
export function buildLadder(quote) {
  const options = (quote && quote.options) || [];
  const tiers = (quote && quote.tiers) || [];

  const currentOption = options.find((o) => o.is_current) || null;
  const onByob = !!currentOption && currentOption.bar_type === BYOB_BAR_TYPE;

  // A BYOB client stands on a TIER, not on the package: the three tier steps and
  // bar-service-only are the same package with a different tier addon, and the
  // client is never shown that distinction. A hosted client stands on the option.
  const selectedTier = tiers.find((t) => t.selected) || tiers.find((t) => t.addon_id === null) || null;
  const anchor = onByob && selectedTier
    ? tierRung(selectedTier)
    : (currentOption ? optionRung(currentOption) : null);

  const byobRungs = tiers
    .filter((t) => !(anchor && anchor.kind === 'tier' && (t.addon_id ?? null) === (anchor.addon_id ?? null)))
    .map(tierRung);

  const isAnchor = (o) => !!anchor && anchor.kind === 'option' && o.package_id === anchor.package_id;
  const rest = options.filter((o) => o.bar_type !== BYOB_BAR_TYPE && !isAnchor(o));

  const hostedLanes = LANES.map((l) => ({
    key: l.key,
    label: l.label,
    rungs: rest.filter((o) => o.bar_type === l.barType).map(optionRung),
  }));

  const sideways = rest.find((o) => o.bar_type === SIDEWAYS_BAR_TYPE) || null;

  // Anything whose bar_type this ladder does not know. Rendered in a trailing
  // catch-all rather than dropped: a catalog edit must never silently remove a
  // package from a money surface. The component also breadcrumbs on this.
  const known = new Set([...LANES.map((l) => l.barType), SIDEWAYS_BAR_TYPE, BYOB_BAR_TYPE]);
  const unmapped = rest.filter((o) => !known.has(o.bar_type));

  const hasHostedOptions = hostedLanes.some((l) => l.rungs.some((r) => r.available))
    || (!!sideways && sideways.available)
    || unmapped.some((o) => o.available);

  return {
    anchor,
    byobRungs,
    hostedLanes,
    sideways: sideways ? optionRung(sideways) : null,
    unmapped: unmapped.map(optionRung),
    hasHostedOptions,
  };
}

/**
 * The price line under a rung. Server-derived on purpose: below 50 guests the
 * engine prices on the _small rate columns, bills at a headcount minimum and
 * floors at a per-package dollar amount, so a rate x guests line computed here
 * would lie to roughly one proposal in six.
 */
export function sublineFor(entry, kind) {
  if (!entry) return '';
  const isTier = kind === 'tier' || entry.kind === 'tier';
  if (isTier) {
    return entry.per_guest_rate === null || entry.per_guest_rate === undefined
      ? 'flat service rate, you supply the alcohol'
      : `${fmt(entry.per_guest_rate)} per guest, on top of bar service`;
  }
  switch (entry.priced_by) {
    case 'rate':
      return `${fmt(entry.per_guest_rate)} per guest, everything included`;
    // Never per-head arithmetic here: the client is billed for heads they do not
    // have, so any "$X per guest" we print is a number they can disprove.
    case 'guest_min':
      return `priced at our ${entry.min_billed_guests}-guest minimum`;
    // The floor is per-package data, never a hardcoded 550.
    case 'dollar_min':
      return `${fmtWhole(entry.min_total)} minimum for smaller events`;
    default:
      return '';
  }
}

/**
 * How the drawer opens. A BYOB client sees four rows and one expand line; anyone
 * already up the ladder opens expanded with their OWN lane open, so they are not
 * hunting for the rung they are standing on.
 */
export function openState(ladder) {
  const anchor = ladder && ladder.anchor;
  const onByob = !!anchor && anchor.kind === 'tier';
  const lane = LANES.find((l) => !!anchor && anchor.bar_type === l.barType);
  return { expanded: !onByob, openLane: lane ? lane.key : 'full_bar' };
}

export default buildLadder;
