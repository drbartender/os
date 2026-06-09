// Pure helpers for the no-jar gratuity floor on the proposal Sign & Pay card.
// The floor is GRATUITY_FLOOR_RATE ($50) x staff x hours, computed in
// ProposalView and mirrored server-side (pricingEngine.GRATUITY_FLOOR_RATE).
// Keep the predicate and the client-facing message here, in one place, so the
// inline warning and the handleSign guard can never drift apart.

// True when a no-jar gratuity is below the required floor. Coerce the input
// (which may be '', a raw string, or undefined) so a cleared field reads as 0,
// never NaN — NaN < floor is false and would silently slip the guard.
export function isGratuityBelowFloor({ gratuityEnabled, tipJar, gratuityTotal, gratuityFloor }) {
  if (!gratuityEnabled || tipJar) return false;
  return (Number(gratuityTotal) || 0) < gratuityFloor;
}

// The single client-facing floor message, shared by the inline warning and the
// handleSign guard. `floorText` is the already-formatted dollar floor (fmt()).
export function gratuityFloorMessage(floorText, staffNoun) {
  return `Without a tip jar, gratuity must be at least ${floorText} so your ${staffNoun}s are covered.`;
}
