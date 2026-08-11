// Pure helpers for the Sign & Pay gratuity floor: the legacy no-jar
// $50/staff/hr rule AND the admin mandate (spec 2026-08-10), which floors
// BOTH jar answers at its own rate. Floor dollars are computed HERE
// (gratuityFloorDollars) and mirrored server-side
// (pricingEngine.GRATUITY_FLOOR_RATE / deriveGratuityRate). Keep the
// predicate, the dollars, and the client-facing message in this one place so
// the inline warning and the handleSign guard can never drift apart.

// True when the gratuity is below the required floor. Coerce the input
// (which may be '', a raw string, or undefined) so a cleared field reads as 0,
// never NaN — NaN < floor is false and would silently slip the guard.
// `mandated` (admin mandate, spec 2026-08-10) floors BOTH jar answers: the
// jar-yes short-circuit only applies when there is no mandate.
export function isGratuityBelowFloor({ gratuityEnabled, tipJar, gratuityTotal, gratuityFloor, mandated = false }) {
  if (!gratuityEnabled) return false;
  if (!mandated && tipJar) return false;
  return (Number(gratuityTotal) || 0) < gratuityFloor;
}

// The single client-facing floor message, shared by the inline warning and the
// handleSign guard. `floorText` is the already-formatted dollar floor (fmt()).
export function gratuityFloorMessage(floorText, staffNoun, mandated = false) {
  return mandated
    ? `This event includes a required gratuity of at least ${floorText} for your ${staffNoun}s.`
    : `Without a tip jar, gratuity must be at least ${floorText} so your ${staffNoun}s are covered.`;
}

// Floor dollars for the Sign & Pay card. mandateRate > 0 = admin mandate
// (spec 2026-08-10), which REPLACES the 50 rule; otherwise the no-jar
// $50/staff/hr dollars. The literal 50 mirrors server GRATUITY_FLOOR_RATE
// (server/utils/pricingEngine.js) — keep them in sync.
export function gratuityFloorDollars({ mandateRate, staffCount, hours }) {
  const r = Number(mandateRate) || 0;
  const sc = Number(staffCount) || 0;
  const h = Number(hours) || 0;
  if (r > 0) return Math.round(r * sc * h * 100) / 100;
  return Math.round(50 * sc * h);
}
