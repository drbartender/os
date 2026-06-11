/**
 * Pricing Engine — pure functions, zero DB dependencies.
 * Takes package/addon data as arguments, returns a pricing snapshot.
 */

const {
  SHARED_GRATUITY_LABEL, GRATUITY_LABEL, currentDisplayLabels,
} = require('./gratuityLabels');

/**
 * HOSTED PACKAGE RULE — do not lose this.
 * ─────────────────────────────────────────────────────────────
 * Hosted (per_guest) packages price bartender staffing INTO the per-guest
 * rate AT A 1:100 GUEST RATIO. So 100 guests = 1 included, 250 guests = 3
 * included, etc. Bartenders WITHIN the ratio (computed from
 * pkg.guests_per_bartender, default 100) are $0 line items AND $0 gratuity.
 *
 * Bartenders ABOVE the ratio — whether the client adds them via the
 * num_bartenders override OR the 'additional-bartender' add-on — are
 * CHARGED at the standard hourly rate (pkg.extra_bartender_hourly, default
 * $40/hr) plus the same sub-100-guest gratuity surcharge that applies on
 * BYOB ($50/$25/$15 per hour for <50/<75/<100 guests).
 *
 * EXCEPTION: hosted packages with `bar_type = 'class'` (cocktail classes,
 * 8-20 guests, 2hr fixed) keep the legacy "all bartenders free" behavior.
 * The per-guest class rate already absorbs staffing flexibility, and
 * over-ratio override on a class is a staffing-prep choice, not a luxury
 * upcharge. Both base hourly AND gratuity surcharge are zeroed for classes.
 *
 * If you add a new code path that charges for bartenders, call this
 * helper, get `staffing.required` from calculateStaffing(), and only zero
 * the charge for the first `staffing.required` bartenders (or all of them
 * if `pkg.bar_type === 'class'`). Grep for `isHostedPackage` before adding
 * bartender logic anywhere else.
 */
function isHostedPackage(pkg) {
  return pkg?.pricing_type === 'per_guest';
}

/**
 * Hosted-package gap helpers — used by the Potion Planning Lab (client) and
 * by the drink-plan submit handler (server) to validate auto-added addons.
 * Load-bearing: do NOT move these away from isHostedPackage — keep them
 * grep-adjacent so anyone touching hosted-package pricing finds both.
 */
function computeCocktailGap(cocktail, pkg) {
  const required = cocktail?.upgrade_addon_slugs || [];
  const covered = pkg?.covered_addon_slugs || [];
  return required.filter(slug => !covered.includes(slug));
}

function packageSuppressedAddons(pkg) {
  return pkg?.covered_addon_slugs || [];
}

function isCocktailFullyCovered(cocktail, pkg) {
  return computeCocktailGap(cocktail, pkg).length === 0;
}

function calculateBaseCost(pkg, guestCount, durationHours) {
  if (!durationHours || durationHours <= 0) {
    throw new Error('Duration must be greater than zero.');
  }
  if (pkg.pricing_type !== 'flat' && (!guestCount || guestCount <= 0)) {
    throw new Error('Guest count must be greater than zero for per-guest packages.');
  }

  if (pkg.pricing_type === 'flat') {
    // BYOB: flat rate based on duration
    if (pkg.base_rate_3hr && durationHours <= 3) return Number(pkg.base_rate_3hr);
    const base = Number(pkg.base_rate_4hr || pkg.base_rate_3hr);
    if (durationHours <= 4) return base;
    return base + (durationHours - 4) * Number(pkg.extra_hour_rate);
  }

  // Hosted: per-guest rate with small/standard tiers
  const isSmall = pkg.min_guests && guestCount < pkg.min_guests;
  const rate4hr = Number(isSmall ? pkg.base_rate_4hr_small : pkg.base_rate_4hr);
  const rate3hr = isSmall ? (pkg.base_rate_3hr_small || pkg.base_rate_3hr) : pkg.base_rate_3hr;
  const extraRate = Number(isSmall ? (pkg.extra_hour_rate_small || pkg.extra_hour_rate) : pkg.extra_hour_rate);

  const floor = Number(pkg.min_total || 0);
  if (rate3hr && durationHours <= 3) return Math.max(guestCount * Number(rate3hr), floor);
  if (durationHours <= 4) return Math.max(guestCount * rate4hr, floor);
  return Math.max(guestCount * rate4hr + guestCount * (durationHours - 4) * extraRate, floor);
}

function calculateBarRental(pkg, numBars) {
  if (!numBars || numBars <= 0) return 0;
  const firstBar = Number(pkg.first_bar_fee || 50);
  const additionalBar = Number(pkg.additional_bar_fee || 100);
  return firstBar + Math.max(0, numBars - 1) * additionalBar;
}

function calculateStaffing(pkg, guestCount, durationHours, numBartendersOverride) {
  const perBartender = Number(pkg.guests_per_bartender || 100);
  const configIncluded = Number(pkg.bartenders_included || 1);
  const hourlyRate = Number(pkg.extra_bartender_hourly || 40);
  const isHosted = isHostedPackage(pkg);
  // HOSTED PACKAGE RULE EXCEPTION: see header comment by isHostedPackage().
  const isClassPackage = isHosted && pkg.bar_type === 'class';

  const required = guestCount > 0 ? Math.max(1, Math.ceil(guestCount / perBartender)) : 1;
  // HOSTED PACKAGE RULE: hosted packages include bartenders at the 1:100 ratio
  // (or pkg.bartenders_included if larger). BYOB only includes the configured
  // count and charges per extra above that.
  const included = isHosted ? Math.max(configIncluded, required) : configIncluded;
  const actual = numBartendersOverride !== null && numBartendersOverride !== undefined ? numBartendersOverride : required;
  const extra = Math.max(0, actual - included);

  // Gratuity surcharge for over-ratio extras. Applies on both BYOB and hosted
  // when the user adds a bartender BEYOND what the guest ratio requires
  // (sub-100-guest events get the bartender-livelihood bump because tip
  // volume is light). For BYOB, `actual > required` distinguishes a luxury
  // add from a ratio-driven extra above `included`. For hosted, the new
  // included = max(configIncluded, required) means any extra > 0 already
  // implies actual > required, so the guard is naturally satisfied. Class
  // packages are exempt — see HOSTED PACKAGE RULE EXCEPTION.
  let gratuityPerHour = 0;
  if (extra > 0 && actual > required && !isClassPackage) {
    if (guestCount < 50) gratuityPerHour = 50;
    else if (guestCount < 75) gratuityPerHour = 25;
    else if (guestCount < 100) gratuityPerHour = 15;
  }

  const cost = isClassPackage ? 0 : extra * durationHours * (hourlyRate + gratuityPerHour);

  return { required, actual, included, extra, hourlyRate, gratuityPerHour, cost, isHosted };
}

function calculateAddonCost(addon, guestCount, durationHours, staffCount, addonQuantity) {
  const rate = Number(addon.rate);
  const qty = addonQuantity || 1;
  switch (addon.billing_type) {
    case 'per_guest':
      return { quantity: guestCount, total: guestCount * rate * qty };
    case 'per_guest_timed': {
      const base = guestCount * rate;
      const extraHours = Math.max(0, durationHours - 4);
      const extraCost = extraHours * guestCount * Number(addon.extra_hour_rate || 0);
      return { quantity: guestCount, total: (base + extraCost) * qty };
    }
    case 'per_hour': {
      const effectiveHours = Math.max(durationHours, Number(addon.minimum_hours || 0));
      return { quantity: effectiveHours * qty, total: effectiveHours * rate * qty };
    }
    case 'per_staff': {
      // Single-instance by design: bills once per staff member. addonQuantity is
      // intentionally NOT applied here — no current addon flows through this branch with
      // qty > 1 (additional-bartender has its own block in calculateProposal). If a future
      // per_staff addon needs multiples, switch to `staff * rate * qty` and add a test.
      const staff = staffCount || 1;
      return { quantity: staff, total: staff * rate };
    }
    case 'per_100_guests': {
      const blocks = Math.ceil(guestCount / 100);
      return { quantity: blocks, total: blocks * rate };
    }
    case 'flat':
      return { quantity: qty, total: rate * qty };
    default:
      return { quantity: qty, total: rate * qty };
  }
}

const SYRUP_PRICE_SINGLE = 30;
const SYRUP_PRICE_3PACK = 75;

function getBottlesPerSyrup(guestCount) {
  if (!guestCount || guestCount <= 50) return 1;
  return Math.ceil(guestCount / 50);
}

function calculateSyrupCost(syrupSelections, guestCount) {
  if (!syrupSelections || !Array.isArray(syrupSelections) || syrupSelections.length === 0) {
    return { count: 0, bottlesPerFlavor: 1, totalBottles: 0, packs: 0, singles: 0, total: 0 };
  }
  const count = syrupSelections.length;
  const bottlesPerFlavor = getBottlesPerSyrup(guestCount);
  const totalBottles = count * bottlesPerFlavor;
  // 3-pack discount applies to total bottles — every 3 bottles = $75
  const packs = Math.floor(totalBottles / 3);
  const singles = totalBottles % 3;
  const total = packs * SYRUP_PRICE_3PACK + singles * SYRUP_PRICE_SINGLE;
  return { count, bottlesPerFlavor, totalBottles, packs, singles, total };
}

// ─── Client-elected gratuity (spec §3, §8.3) ─────────────────────────────────
// A per-staff-per-hour RATE (dollars), stored as proposals.gratuity_rate
// NUMERIC(10,4). The dollar line scales: rate x staffCount x hours. It is STAFF
// pass-through money — added on top of the service total, never reduced by a
// discount/surcharge or total_price_override (DD #2). Layered on top of the
// forced "Shared Gratuity" surcharge, which is unchanged.
const GRATUITY_FLOOR_RATE = 50;        // no-jar minimum, $/staff/hr (linking rule §3)
const GRATUITY_SANITY_MAX_RATE = 1000; // reject absurd rates; honest typos fixed via refund (§6)

/** 'instructor' for class packages, else 'bartender'. Frozen into the snapshot
 *  (snapshot.staff_noun) so a later re-categorization can't swap the noun on a
 *  signed proposal (spec §3). */
function getStaffNoun(pkg) {
  return pkg && pkg.bar_type === 'class' ? 'instructor' : 'bartender';
}

/** The single definition of the gratuity staff basis: bartenders (staffing.actual already
 *  folds the numBartenders override) + additional-bartender addon qty. EXCLUDES
 *  barbacks/servers. Shared by computeGratuityBasis, calculateProposal, and
 *  gratuityBasisFromSnapshot so they can never drift (audit con-pricing-types). */
function gratuityStaffCountFrom(staffing, additionalBartenderQty) {
  return staffing.actual + additionalBartenderQty;
}

/** Staff that share the client gratuity: bartenders (staffing.actual already
 *  folds the numBartenders override) + additional-bartender addon qty. EXCLUDES
 *  barbacks/servers — a SEPARATE count from the engine's totalStaff (spec §3). */
function computeGratuityBasis({ pkg, guestCount, durationHours, numBartenders, addons }) {
  const staffing = calculateStaffing(pkg, guestCount, durationHours, numBartenders);
  const additionalBartenderQty = (addons || [])
    .filter(a => a.slug === 'additional-bartender')
    .reduce((sum, a) => sum + (a.quantity || 1), 0);
  return { staffCount: gratuityStaffCountFrom(staffing, additionalBartenderQty), hours: Number(durationHours) || 0 };
}

/** Derive the same basis from a computed snapshot (used by the surgical
 *  create-intent recompute). Prefers the frozen gratuity.staff_count; falls back
 *  to staffing.actual + the addon count recovered from snapshot.addons. */
function gratuityBasisFromSnapshot(snapshot, durationHours) {
  const g = snapshot && snapshot.gratuity;
  const dh = Number(durationHours) || 0;
  if (g && Number.isFinite(g.staff_count)) {
    return { staffCount: g.staff_count, hours: Number.isFinite(g.hours) ? g.hours : dh };
  }
  const staffActual = (snapshot && snapshot.staffing && snapshot.staffing.actual) || 0;
  const addonQty = ((snapshot && snapshot.addons) || [])
    .filter(a => a.slug === 'additional-bartender')
    // snapshot.addons[].quantity for a bartender is durationHours x rawQty; recover rawQty.
    .reduce((s, a) => s + (dh > 0 && a.quantity ? Math.round(a.quantity / dh) : (a.quantity || 0)), 0);
  return { staffCount: gratuityStaffCountFrom({ actual: staffActual }, addonQty), hours: dh };
}

/** The gratuity dollar line, rounded to cents. ONE source of the math (DD #4). */
function gratuityLineAmount(rate, staffCount, hours) {
  const r = Number(rate) || 0;
  const sc = Number(staffCount) || 0;
  const h = Number(hours) || 0;
  if (r <= 0 || sc <= 0 || h <= 0) return 0;
  return Math.round(r * sc * h * 100) / 100;
}

/** Derive + validate a stored rate from a client/admin-entered TOTAL (dollars).
 *  PURE: the route turns {ok:false} into a clean ValidationError BEFORE the DB
 *  CHECK fires; the DB CHECK is the final backstop (spec §3, §4, §6). */
function deriveGratuityRate({ enteredTotal, staffCount, hours, tipJar }) {
  const basis = (Number(staffCount) || 0) * (Number(hours) || 0);
  // Degenerate crew/hours: no gratuity is possible — coerce to 0 (the UI step is
  // disabled here; the caller also forces tip_jar=true so the DB CHECK passes).
  if (basis <= 0) return { ok: true, rate: 0 };
  const total = Number(enteredTotal);
  if (!Number.isFinite(total) || total < 0) {
    return { ok: false, code: 'INVALID_GRATUITY', message: 'Enter a gratuity amount of $0 or more.' };
  }
  if (tipJar === false) {
    const floorTotal = GRATUITY_FLOOR_RATE * basis;
    if (total < floorTotal - 0.005) {
      return {
        ok: false, code: 'GRATUITY_BELOW_FLOOR',
        message: `Without a tip jar, gratuity must be at least $${floorTotal.toFixed(2)}.`,
      };
    }
  }
  const rate = Math.round((total / basis) * 10000) / 10000; // NUMERIC(10,4)
  if (rate > GRATUITY_SANITY_MAX_RATE) {
    return { ok: false, code: 'GRATUITY_TOO_LARGE', message: 'That gratuity is unusually large — please re-enter it.' };
  }
  return { ok: true, rate };
}

/** Return a NEW snapshot with the client Gratuity line recomputed for a new
 *  rate, leaving every other line byte-identical (drift-free, DD #3). */
function recomputeSnapshotGratuity(snapshot, { gratuityRate, tipJar, staffNoun, durationHours }) {
  const snap = JSON.parse(JSON.stringify(snapshot)); // never mutate the caller's object
  const { staffCount, hours } = gratuityBasisFromSnapshot(snap, durationHours);
  const priorAmount = Number(snap.gratuity && snap.gratuity.total) || 0;
  const newAmount = gratuityLineAmount(gratuityRate, staffCount, hours);
  snap.breakdown = (snap.breakdown || []).filter(l => l.label !== GRATUITY_LABEL);
  if (newAmount > 0) snap.breakdown.push({ label: GRATUITY_LABEL, amount: newAmount });
  snap.total = Math.round((Number(snap.total || 0) - priorAmount + newAmount) * 100) / 100;
  snap.staff_noun = staffNoun || snap.staff_noun || 'bartender';
  snap.display_labels = snap.display_labels || currentDisplayLabels();
  snap.gratuity = {
    ...snap.gratuity, // preserve any future fields; overwrite only what this helper owns
    rate: Number(gratuityRate) || 0,
    tip_jar: tipJar !== false,
    staff_count: staffCount,
    hours,
    staff_noun: snap.staff_noun,
    total: newAmount,
  };
  return snap;
}

function calculateProposal({ pkg, guestCount, durationHours, numBars, numBartenders, addons, syrupSelections, adjustments, totalPriceOverride, gratuityRate = 0, tipJar = true }) {
  const isHosted = isHostedPackage(pkg); // HOSTED PACKAGE RULE — see helper comment.
  const isClassPackage = isHosted && pkg.bar_type === 'class';
  const baseCost = calculateBaseCost(pkg, guestCount, durationHours);
  const floorApplied = isHosted && pkg.min_total && baseCost <= Number(pkg.min_total);
  const barRental = calculateBarRental(pkg, numBars);
  const staffing = calculateStaffing(pkg, guestCount, durationHours, numBartenders);

  // Total staff = bartenders + additional bartender add-ons + barbacks/servers
  const additionalBartenderQty = (addons || []).filter(a => a.slug === 'additional-bartender').reduce((sum, a) => sum + (a.quantity || 1), 0);
  const totalStaff = staffing.actual + additionalBartenderQty
    + (addons || []).filter(a => a.slug === 'barback' || a.slug === 'banquet-server').reduce((sum, a) => sum + (a.quantity || 1), 0);

  // Gratuity surcharge for additional-bartender add-on. Addon bartenders are
  // treated as luxury adds layered on top of the auto/override staffing count
  // — even if `num_bartenders` was simultaneously set under-ratio (an admin
  // edge case), the addon-driven extra still carries the small-event gratuity
  // because the bartender's tip volume is what's at stake. Class packages are
  // exempt — see HOSTED PACKAGE RULE EXCEPTION by isHostedPackage().
  let bartenderGratuityPerHour = 0;
  if (additionalBartenderQty > 0 && !isClassPackage) {
    if (guestCount < 50) bartenderGratuityPerHour = 50;
    else if (guestCount < 75) bartenderGratuityPerHour = 25;
    else if (guestCount < 100) bartenderGratuityPerHour = 15;
  }

  const addonResults = (addons || []).map(addon => {
    if (addon.slug === 'additional-bartender') {
      // HOSTED PACKAGE RULE: hosted packages cover bartenders at the 1:100
      // ratio; addon-bartenders are always over-ratio and charged at the same
      // hourly + gratuity rate as BYOB. Class packages are exempt — see
      // HOSTED PACKAGE RULE EXCEPTION by isHostedPackage().
      const qty = addon.quantity || 1;
      const effectiveRate = isClassPackage ? 0 : Number(addon.rate) + bartenderGratuityPerHour;
      const totalCost = qty * durationHours * effectiveRate;
      return {
        id: addon.id,
        slug: addon.slug,
        name: addon.name,
        billing_type: addon.billing_type,
        rate: Number(addon.rate),
        extra_hour_rate: addon.extra_hour_rate ? Number(addon.extra_hour_rate) : null,
        quantity: durationHours * qty,
        gratuity_per_hour: isClassPackage ? 0 : bartenderGratuityPerHour,
        line_total: Math.round(totalCost * 100) / 100
      };
    }
    const { quantity, total } = calculateAddonCost(addon, guestCount, durationHours, totalStaff, addon.quantity);
    const displayName = (addon.slug === 'champagne-toast' && addon.variant === 'non-alcoholic-bubbles')
      ? 'Non-Alcoholic Bubbles Toast' : addon.name;
    return {
      id: addon.id,
      slug: addon.slug,
      name: displayName,
      billing_type: addon.billing_type,
      rate: Number(addon.rate),
      extra_hour_rate: addon.extra_hour_rate ? Number(addon.extra_hour_rate) : null,
      variant: addon.variant || null,
      quantity,
      line_total: Math.round(total * 100) / 100
    };
  });

  const addonTotal = addonResults.reduce((sum, a) => sum + a.line_total, 0);
  const syrupCost = calculateSyrupCost(syrupSelections, guestCount);
  const subtotal = baseCost + barRental + staffing.cost + addonTotal + syrupCost.total;

  // Apply price adjustments (discounts/surcharges)
  const safeAdjustments = Array.isArray(adjustments) ? adjustments : [];
  const adjustmentNet = safeAdjustments.reduce((sum, adj) => {
    const amt = Math.abs(Number(adj.amount) || 0);
    return sum + (adj.type === 'discount' ? -amt : amt);
  }, 0);
  const calculatedTotal = Math.max(0, Math.round((subtotal + adjustmentNet) * 100) / 100);

  // Client-elected gratuity (DD #2/#4): staff pass-through, added on top of the
  // service total. staffing.actual already folds the numBartenders override.
  const gratuityStaffCount = gratuityStaffCountFrom(staffing, additionalBartenderQty);
  const staffNoun = getStaffNoun(pkg);
  const clientGratuityAmount = gratuityLineAmount(gratuityRate, gratuityStaffCount, durationHours);

  const serviceTotal = totalPriceOverride !== null && totalPriceOverride !== undefined
    ? Math.round(Number(totalPriceOverride) * 100) / 100
    : calculatedTotal;
  const total = Math.round((serviceTotal + clientGratuityAmount) * 100) / 100;

  // Build human-readable breakdown
  const breakdown = [];
  breakdown.push({
    label: `${pkg.name} (${durationHours}hr${durationHours !== 1 ? 's' : ''}, ${guestCount} guests)`,
    amount: Math.round(baseCost * 100) / 100
  });
  if (numBars > 0) {
    breakdown.push({
      label: `Bar Rental (${numBars} bar${numBars !== 1 ? 's' : ''})`,
      amount: Math.round(barRental * 100) / 100
    });
  }
  if (staffing.extra > 0) {
    if (isClassPackage) {
      // HOSTED PACKAGE RULE EXCEPTION: classes keep "all bartenders free."
      breakdown.push({
        label: `Additional Bartender${staffing.extra !== 1 ? 's' : ''} (${staffing.extra}) — Included with class`,
        amount: 0
      });
    } else {
      // HOSTED PACKAGE RULE: hosted packages cover bartenders at the 1:100 ratio
      // via staffing.included = max(configIncluded, ratioRequired). Anything in
      // staffing.extra is OVER ratio and charged the same as BYOB.
      const baseCostStaffing = staffing.extra * durationHours * staffing.hourlyRate;
      breakdown.push({
        label: `Additional Bartender${staffing.extra !== 1 ? 's' : ''} (${staffing.extra})`,
        amount: Math.round(baseCostStaffing * 100) / 100
      });
      if (staffing.gratuityPerHour > 0) {
        const gratuityAmount = staffing.extra * durationHours * staffing.gratuityPerHour;
        breakdown.push({
          label: SHARED_GRATUITY_LABEL,
          amount: Math.round(gratuityAmount * 100) / 100
        });
      }
    }
  }
  for (const addon of addonResults) {
    let label = addon.name;
    if (addon.slug === 'additional-bartender') {
      const qty = addon.quantity / durationHours; // recover count from total hours
      if (isClassPackage) {
        // HOSTED PACKAGE RULE EXCEPTION: classes keep "all bartenders free."
        breakdown.push({
          label: `Additional Bartender${qty !== 1 ? 's' : ''} (${qty}) — Included with class`,
          amount: 0
        });
      } else {
        // HOSTED PACKAGE RULE: addon bartenders are always over-ratio and
        // charged at standard hourly + gratuity on both BYOB and hosted.
        const baseCostAddon = qty * durationHours * Number(addon.rate);
        breakdown.push({
          label: `Additional Bartender${qty !== 1 ? 's' : ''} (${qty})`,
          amount: Math.round(baseCostAddon * 100) / 100
        });
        if (addon.gratuity_per_hour > 0) {
          const gratuityAmount = qty * durationHours * addon.gratuity_per_hour;
          breakdown.push({ label: SHARED_GRATUITY_LABEL, amount: Math.round(gratuityAmount * 100) / 100 });
        }
      }
      continue;
    } else if (addon.billing_type === 'per_guest' || addon.billing_type === 'per_guest_timed') {
      label += ` (${guestCount} guests)`;
    } else if (addon.billing_type === 'per_hour') {
      label += ` (${addon.quantity}hrs)`;
    } else if (addon.billing_type === 'per_staff') {
      label += ` (${addon.quantity} staff)`;
    } else if (addon.billing_type === 'per_100_guests') {
      label += addon.quantity > 1 ? ` (${addon.quantity} × 100 guests)` : '';
    }
    breakdown.push({ label, amount: addon.line_total });
  }
  if (syrupCost.total > 0) {
    let syrupLabel = `Hand-Crafted Syrups — ${syrupCost.count} flavor${syrupCost.count !== 1 ? 's' : ''}`;
    if (syrupCost.bottlesPerFlavor > 1) {
      syrupLabel += `, ${syrupCost.totalBottles} bottles (${syrupCost.bottlesPerFlavor} per flavor for ${guestCount} guests)`;
    } else {
      syrupLabel += `, ${syrupCost.totalBottles} bottle${syrupCost.totalBottles !== 1 ? 's' : ''}`;
    }
    breakdown.push({ label: syrupLabel, amount: syrupCost.total });
  }
  for (const adj of safeAdjustments) {
    const amt = Math.abs(Number(adj.amount) || 0);
    breakdown.push({
      label: adj.label || (adj.type === 'discount' ? 'Discount' : 'Surcharge'),
      amount: adj.type === 'discount' ? -amt : amt
    });
  }
  if (clientGratuityAmount > 0) {
    breakdown.push({ label: GRATUITY_LABEL, amount: clientGratuityAmount });
  }

  return {
    calculated_at: new Date().toISOString(),
    inputs: { guestCount, durationHours, numBars, numBartenders: staffing.actual },
    package: {
      id: pkg.id,
      slug: pkg.slug,
      name: pkg.name,
      category: pkg.category,
      pricing_type: pkg.pricing_type,
      base_cost: Math.round(baseCost * 100) / 100
    },
    bar_rental: {
      num_bars: numBars,
      first_bar_fee: Number(pkg.first_bar_fee || 50),
      additional_bar_fee: Number(pkg.additional_bar_fee || 100),
      total: Math.round(barRental * 100) / 100
    },
    staffing: {
      included: staffing.included,
      required: staffing.required,
      actual: staffing.actual,
      extra: staffing.extra,
      hourly_rate: staffing.hourlyRate,
      total: Math.round(staffing.cost * 100) / 100
    },
    addons: addonResults,
    syrups: {
      selections: syrupSelections || [],
      count: syrupCost.count,
      bottles_per_flavor: syrupCost.bottlesPerFlavor,
      total_bottles: syrupCost.totalBottles,
      packs: syrupCost.packs,
      singles: syrupCost.singles,
      total: syrupCost.total,
    },
    breakdown,
    staff_noun: staffNoun,
    display_labels: currentDisplayLabels(),
    gratuity: {
      rate: Number(gratuityRate) || 0,
      tip_jar: tipJar !== false,
      staff_count: gratuityStaffCount,
      hours: Number(durationHours) || 0,
      staff_noun: staffNoun,
      total: clientGratuityAmount,
    },
    floor_applied: !!floorApplied,
    adjustments: safeAdjustments,
    total_price_override: totalPriceOverride ?? null,
    subtotal: Math.round(subtotal * 100) / 100,
    total
  };
}

module.exports = {
  calculateProposal, calculateBaseCost, calculateBarRental, calculateStaffing,
  calculateAddonCost, calculateSyrupCost, getBottlesPerSyrup, isHostedPackage,
  computeCocktailGap, packageSuppressedAddons, isCocktailFullyCovered,
  getStaffNoun, computeGratuityBasis, gratuityBasisFromSnapshot, gratuityLineAmount,
  deriveGratuityRate, recomputeSnapshotGratuity,
  GRATUITY_FLOOR_RATE, GRATUITY_SANITY_MAX_RATE,
};
