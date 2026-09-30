'use strict';

/**
 * What one added hour costs on a booking's PACKAGE line, for display on the
 * client's proposal page. Agreement v4 Section 8.1 points the client at this
 * number ("as stated in the Event-Specific Agreement").
 *
 * The figure comes from extraHourCharge, the same function the on-site
 * extension bills with (serviceExtensionPricing.js), against the LIVE catalog
 * row and the booking's current guest count. What the page shows is what a
 * request tonight would quote. It is NOT locked at signing: a catalog rate
 * change moves it for clients who already signed (PRICING.md, On-Site Service
 * Extension).
 *
 * Package line only. Over-included bartenders, time-priced add-ons and
 * gratuity for the added time bill on top; Section 8.1 says so, and the
 * proposal line says so too.
 *
 * PRECONDITION: the extension bills the LARGER of extraHourCharge and the
 * catalog's own difference between the two durations. For every package shape
 * in the catalog today the catalog difference never exceeds extraHourCharge
 * (additionalTimeRate.test.js sweeps it), so hourly x added hours IS the
 * package line. A package with a 3-hour rate (base_rate_3hr set on a hosted
 * package) would break that: the 3h to 4h step would bill the rate jump, not
 * this figure. None exists; if one is added, this module must learn about it
 * before the line goes back on the page.
 *
 * Returns null when there is nothing to show: no package, a class (its
 * extra-hour rate is $0), a rate that prices to $0, or a per-guest package
 * with no guest count.
 *
 * Pure. `pkg` is a service_packages row (pg strings are fine).
 */

const { extraHourCharge, hostedRateTier } = require('./pricingEngine');

const toDollars = (n) => Math.round(Number(n) * 100) / 100;

function additionalTimeRate(pkg, guestCount) {
  if (!pkg || !pkg.pricing_type) return null;
  if (pkg.bar_type === 'class') return null;

  if (pkg.pricing_type === 'flat') {
    const hourly = toDollars(extraHourCharge(pkg, 0, 1));
    return Number.isFinite(hourly) && hourly > 0
      ? { hourly, per_guest_rate: null, billed_guests: null }
      : null;
  }

  const guests = Number(guestCount);
  if (!(guests > 0)) return null;
  const hourly = toDollars(extraHourCharge(pkg, guests, 1));
  if (!Number.isFinite(hourly) || !(hourly > 0)) return null;
  const { billedGuests, extraRate } = hostedRateTier(pkg, guests);
  return { hourly, per_guest_rate: toDollars(extraRate), billed_guests: billedGuests };
}

module.exports = { additionalTimeRate };
