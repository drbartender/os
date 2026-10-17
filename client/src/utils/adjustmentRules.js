// Client twin of server/utils/adjustmentRules.js: one definition of a price
// adjustment line (spec 2026-10-16 section 3). Keep the constants, the five
// readers and isWholeCents identical to the server's;
// server/utils/adjustmentRules.test.js imports this file and pins parity.
// adjVisible, adjAmount and adjLabel are the pricing engine's own coercions;
// adjSignedCents rounds per line (exact for whole-cent lines). isWholeCents is
// the server's whole-cents rule, so a client input can refuse what the server
// would. No validateAdjustments here: the server is the authority on what a
// saved line may hold.
//
// `source` marks a line the system wrote ('agreed_price' for Set agreed price
// and converted overrides, 'refund' for a refund line); protection keys on it,
// never on a label an admin can edit. `refund_id` rides only with 'refund'.

export const ADJUSTMENT_SOURCES = Object.freeze(['agreed_price', 'refund']);
export const AGREED_PRICE_LABEL = 'Agreed price adjustment';
export const REFUND_LABEL = 'Refund';
export const MAX_ADJUSTMENTS = 50;
export const MAX_ADJUSTMENT_DOLLARS = 1000000; // exclusive
export const MAX_ADJUSTMENT_LABEL = 255;

export const adjVisible = (adj) => !!(adj && adj.visible);
export const adjAmount = (adj) => Math.abs(Number(adj && adj.amount) || 0);
export const adjSignedCents = (adj) => {
  const cents = Math.round(adjAmount(adj) * 100);
  if (cents === 0) return 0; // a $0 discount is 0, never -0
  return adj && adj.type === 'discount' ? -cents : cents;
};
export const adjLabel = (adj) => (adj && adj.label) || (adj && adj.type === 'discount' ? 'Discount' : 'Surcharge');
export const isProtectedAdjustment = (adj) => !!adj && ADJUSTMENT_SOURCES.includes(adj.source);
// True when a dollar amount has no part finer than a cent. Tolerates the float
// noise of whole-cent arithmetic (0.1 + 0.2) and rounds nothing.
export const isWholeCents = (dollars) => {
  const cents = Number(dollars) * 100;
  return Number.isFinite(cents) && Math.abs(cents - Math.round(cents)) < 1e-6;
};
