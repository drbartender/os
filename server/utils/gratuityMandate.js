// Admin gratuity mandate (spec 2026-08-10) resolution for the proposal PATCH.
// Lives outside crud.js for the file-size ratchet; crud.js is the only consumer.
const { computeGratuityBasis, deriveGratuityRate } = require('./pricingEngine');
const { ValidationError } = require('./errors');

/** Resolve the gratuity columns for a PATCH. A mandate exists iff
 *  gratuity_floor_rate > 0. Returns { gratuityRate, floorRate, tipJar };
 *  floorRate null = no mandate. Throws ValidationError on a locked or
 *  invalid mandate change. Never touches gratuity_rate_change_origin. */
function resolveGratuityForPatch({ body, old, pkg, guestCount, durationHours, numBartenders, addons }) {
  const tipJar = old.tip_jar !== false;
  const gratuityRate = Number(old.gratuity_rate) || 0;
  const floorRate = Number(old.gratuity_floor_rate) > 0 ? Number(old.gratuity_floor_rate) : null;
  if (!Object.prototype.hasOwnProperty.call(body, 'gratuity_mandate_total')) {
    return { gratuityRate, floorRate, tipJar };
  }
  // A signature must never stand against a total admin changed afterward;
  // paid changes go through cancel-line-item.
  const locked = Number(old.amount_paid || 0) > 0
    || (old.client_signed_at !== null && old.client_signed_at !== undefined)
    || old.status === 'accepted';
  if (locked) {
    throw new ValidationError({
      gratuity_mandate_total: 'Gratuity cannot be changed after the client has signed or paid. Lower a paid gratuity via its line item.',
    });
  }
  const mt = body.gratuity_mandate_total;
  if (mt === null || mt === undefined) {
    // Clear: only a real mandate is clearable; an elected gratuity is never
    // wiped by this path. Forcing the jar on mirrors lineItemCancel (rate 0
    // with tip_jar = false would violate the DB CHECK).
    if (floorRate !== null) return { gratuityRate: 0, floorRate: null, tipJar: true };
    return { gratuityRate, floorRate, tipJar };
  }
  if (!(Number(mt) > 0)) {
    throw new ValidationError({ gratuity_mandate_total: 'Enter a required gratuity above $0, or clear it.' });
  }
  const { staffCount, hours } = computeGratuityBasis({ pkg, guestCount, durationHours, numBartenders, addons });
  if (staffCount * hours <= 0) {
    throw new ValidationError({ gratuity_mandate_total: 'Set staffing and duration before requiring a gratuity.' });
  }
  // tipJar true = no floor to satisfy on ENTRY (admin defines the floor);
  // sanity checks (finite, non-negative, <= max rate) still apply.
  const g = deriveGratuityRate({ enteredTotal: mt, staffCount, hours, tipJar: true });
  if (!g.ok) throw new ValidationError({ gratuity_mandate_total: g.message });
  // A sub-cent total can derive rate 0 at 4dp; a stored floor of 0 would break
  // the presence invariant (> 0) and neuter the CHECK's mandate clause.
  if (!(g.rate > 0)) {
    throw new ValidationError({ gratuity_mandate_total: 'Enter a required gratuity above $0, or clear it.' });
  }
  return { gratuityRate: g.rate, floorRate: g.rate, tipJar };
}

/** Staffing-notice resolution, moved verbatim from crud.js (ratchet): stamp
 *  origin 'staffing' + notify only on a PAID rescale (spec 2026-08-03 §7).
 *  A staffing change moves the gratuity amount at the SAME rate; stamp only
 *  when the amount actually changed, notify only on an increase. */
function staffingGratuityOrigin({ isPaid, origin, oldSnapshot, newSnapshot }) {
  const oldTotal = Number(oldSnapshot?.gratuity?.total) || 0;
  const newTotal = Number(newSnapshot?.gratuity?.total) || 0;
  if (isPaid && origin !== 'admin' && newTotal !== oldTotal) {
    return { origin: 'staffing', notify: newTotal > oldTotal };
  }
  return { origin, notify: false };
}

module.exports = { resolveGratuityForPatch, staffingGratuityOrigin };
