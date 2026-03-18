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

  if (rate3hr && durationHours <= 3) return guestCount * Number(rate3hr);
  if (durationHours <= 4) return guestCount * rate4hr;
  return guestCount * rate4hr + guestCount * (durationHours - 4) * extraRate;
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
  const actual = numBartendersOverride != null ? numBartendersOverride : required;
  const extra = Math.max(0, actual - included);
  const cost = extra * durationHours * hourlyRate;

  return { required, actual, included, extra, hourlyRate, cost };
}

function calculateAddonCost(addon, guestCount, durationHours) {
  const rate = Number(addon.rate);
  switch (addon.billing_type) {
    case 'per_guest':
      return { quantity: guestCount, total: guestCount * rate };
    case 'per_guest_timed': {
      const base = guestCount * rate;
      const extraHours = Math.max(0, durationHours - 4);
      const extraCost = extraHours * guestCount * Number(addon.extra_hour_rate || 0);
      return { quantity: guestCount, total: base + extraCost };
    }
    case 'per_hour': {
      const effectiveHours = Math.max(durationHours, Number(addon.minimum_hours || 0));
      return { quantity: effectiveHours, total: effectiveHours * rate };
    }
    case 'flat':
      return { quantity: 1, total: rate };
    default:
      return { quantity: 1, total: rate };
  }
}

function calculateProposal({ pkg, guestCount, durationHours, numBars, numBartenders, addons }) {
  const baseCost = calculateBaseCost(pkg, guestCount, durationHours);
  const barRental = calculateBarRental(pkg, numBars);
  const staffing = calculateStaffing(pkg, guestCount, durationHours, numBartenders);

  const addonResults = (addons || []).map(addon => {
    const { quantity, total } = calculateAddonCost(addon, guestCount, durationHours);
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
  const subtotal = baseCost + barRental + staffing.cost + addonTotal;
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
    breakdown.push({
      label: `Additional Bartender${staffing.extra !== 1 ? 's' : ''} (${staffing.extra} × ${durationHours}hrs @ $${staffing.hourlyRate}/hr)`,
      amount: Math.round(staffing.cost * 100) / 100
    });
  }
  for (const addon of addonResults) {
    let label = addon.name;
    if (addon.billing_type === 'per_guest' || addon.billing_type === 'per_guest_timed') {
      label += ` (${guestCount} guests)`;
    } else if (addon.billing_type === 'per_hour') {
      label += ` (${durationHours}hrs)`;
    }
    breakdown.push({ label, amount: addon.line_total });
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
    breakdown,
    total
  };
}

module.exports = { calculateProposal, calculateBaseCost, calculateBarRental, calculateStaffing, calculateAddonCost };
