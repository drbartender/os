/**
 * Pricing Engine — pure functions, zero DB dependencies.
 * Takes package/addon data as arguments, returns a pricing snapshot.
 */

function calculateBaseCost(pkg, guestCount, durationHours) {
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
  const rate3hr = pkg.base_rate_3hr_small || pkg.base_rate_3hr;
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
  const included = Number(pkg.bartenders_included || 1);
  const hourlyRate = Number(pkg.extra_bartender_hourly || 40);

  const required = Math.ceil(guestCount / perBartender);
  const actual = numBartendersOverride !== null && numBartendersOverride !== undefined ? numBartendersOverride : required;
  const extra = Math.max(0, actual - included);
  // Hosted (per_guest) packages include additional bartenders in the per-guest rate
  const isHosted = pkg.pricing_type === 'per_guest';

  // Gratuity surcharge for extra bartenders added below guest-ratio threshold
  let gratuityPerHour = 0;
  if (!isHosted && extra > 0 && actual > required) {
    if (guestCount < 50) gratuityPerHour = 50;
    else if (guestCount < 75) gratuityPerHour = 25;
    else if (guestCount < 100) gratuityPerHour = 15;
  }

  const cost = isHosted ? 0 : extra * durationHours * (hourlyRate + gratuityPerHour);

  return { required, actual, included, extra, hourlyRate, gratuityPerHour, cost };
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

function calculateSyrupCost(syrupSelections) {
  if (!syrupSelections || !Array.isArray(syrupSelections) || syrupSelections.length === 0) {
    return { count: 0, packs: 0, singles: 0, total: 0 };
  }
  const count = syrupSelections.length;
  const packs = Math.floor(count / 3);
  const singles = count % 3;
  const total = packs * SYRUP_PRICE_3PACK + singles * SYRUP_PRICE_SINGLE;
  return { count, packs, singles, total };
}

function calculateProposal({ pkg, guestCount, durationHours, numBars, numBartenders, addons, syrupSelections }) {
  const baseCost = calculateBaseCost(pkg, guestCount, durationHours);
  const floorApplied = pkg.pricing_type === 'per_guest' && pkg.min_total && baseCost <= Number(pkg.min_total);
  const barRental = calculateBarRental(pkg, numBars);
  const staffing = calculateStaffing(pkg, guestCount, durationHours, numBartenders);

  // Total staff = bartenders + additional bartender add-ons + barbacks/servers
  const additionalBartenderQty = (addons || []).filter(a => a.slug === 'additional-bartender').reduce((sum, a) => sum + (a.quantity || 1), 0);
  const totalStaff = staffing.actual + additionalBartenderQty
    + (addons || []).filter(a => a.slug === 'barback' || a.slug === 'banquet-server').reduce((sum, a) => sum + (a.quantity || 1), 0);

  // Gratuity surcharge for additional bartenders added below guest-ratio threshold
  // Applies to ALL packages — hosted includes bartenders at the recommended ratio,
  // but extras beyond that are charged with the same gratuity rules
  let bartenderGratuityPerHour = 0;
  if (additionalBartenderQty > 0) {
    if (guestCount < 50) bartenderGratuityPerHour = 50;
    else if (guestCount < 75) bartenderGratuityPerHour = 25;
    else if (guestCount < 100) bartenderGratuityPerHour = 15;
  }

  const addonResults = (addons || []).map(addon => {
    if (addon.slug === 'additional-bartender') {
      // Apply gratuity surcharge on top of base rate
      const qty = addon.quantity || 1;
      const effectiveRate = Number(addon.rate) + bartenderGratuityPerHour;
      const totalCost = qty * durationHours * effectiveRate;
      return {
        id: addon.id,
        slug: addon.slug,
        name: addon.name,
        billing_type: addon.billing_type,
        rate: Number(addon.rate),
        extra_hour_rate: addon.extra_hour_rate ? Number(addon.extra_hour_rate) : null,
        quantity: durationHours * qty,
        gratuity_per_hour: bartenderGratuityPerHour,
        line_total: Math.round(totalCost * 100) / 100
      };
    }
    const { quantity, total } = calculateAddonCost(addon, guestCount, durationHours, totalStaff, addon.quantity);
    return {
      id: addon.id,
      slug: addon.slug,
      name: addon.name,
      billing_type: addon.billing_type,
      rate: Number(addon.rate),
      extra_hour_rate: addon.extra_hour_rate ? Number(addon.extra_hour_rate) : null,
      quantity,
      line_total: Math.round(total * 100) / 100
    };
  });

  const addonTotal = addonResults.reduce((sum, a) => sum + a.line_total, 0);
  const syrupCost = calculateSyrupCost(syrupSelections);
  const subtotal = baseCost + barRental + staffing.cost + addonTotal + syrupCost.total;
  const total = Math.round(subtotal * 100) / 100;

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
    const effectiveRate = staffing.hourlyRate + (staffing.gratuityPerHour || 0);
    const gratNote = staffing.gratuityPerHour ? ' incl. gratuity' : '';
    breakdown.push({
      label: `Additional Bartender${staffing.extra !== 1 ? 's' : ''} (${staffing.extra} × ${durationHours}hrs @ $${effectiveRate}/hr${gratNote})`,
      amount: Math.round(staffing.cost * 100) / 100
    });
  }
  for (const addon of addonResults) {
    let label = addon.name;
    if (addon.slug === 'additional-bartender') {
      const qty = addon.quantity / durationHours; // recover count from total hours
      const effectiveRate = Number(addon.rate) + (addon.gratuity_per_hour || 0);
      const gratNote = addon.gratuity_per_hour ? ' incl. gratuity' : '';
      label += ` (${qty} × ${durationHours}hrs @ $${effectiveRate}/hr${gratNote})`;
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
    let syrupLabel = 'Handcrafted Syrups';
    if (syrupCost.packs > 0 && syrupCost.singles > 0) {
      syrupLabel += ` (${syrupCost.packs} three-pack${syrupCost.packs !== 1 ? 's' : ''} + ${syrupCost.singles} single${syrupCost.singles !== 1 ? 's' : ''})`;
    } else if (syrupCost.packs > 0) {
      syrupLabel += ` (${syrupCost.packs} three-pack${syrupCost.packs !== 1 ? 's' : ''})`;
    } else {
      syrupLabel += ` (${syrupCost.singles} bottle${syrupCost.singles !== 1 ? 's' : ''})`;
    }
    breakdown.push({ label: syrupLabel, amount: syrupCost.total });
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
      packs: syrupCost.packs,
      singles: syrupCost.singles,
      total: syrupCost.total,
    },
    breakdown,
    floor_applied: !!floorApplied,
    total
  };
}

module.exports = { calculateProposal, calculateBaseCost, calculateBarRental, calculateStaffing, calculateAddonCost, calculateSyrupCost };
