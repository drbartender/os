// Merging a create-intent quote into the client's proposal state.
//
// Election-at-payment (spec 2026-08-03): POST /stripe/create-intent computes
// the tip-jar election IN MEMORY and stamps it into PaymentIntent metadata. It
// writes NOTHING to the proposal — the webhook applies the election when the
// money lands. So the `total_price` it returns is a PROJECTION of what the
// client is about to be charged, and the row still holds the pre-election
// total until then.
//
// That distinction is load-bearing, which is why this merge lives in its own
// tested module. The snapshot is what the page RENDERS, so the projection
// belongs there. `proposal.total_price` is the row value the signature
// acknowledges (handleSign sends it as `acknowledged_total`, and publicToken.js
// re-asserts it in the sign UPDATE's WHERE: ABS(total_price - $14) < 0.005).
// Overwriting it with the projection made every gratuity-electing client
// acknowledge a number the row had never held, so the assertion rejected their
// signature with 409 TOTAL_CHANGED and the pay button could never reach
// stripe.confirmPayment — a total payment block, not a decline. Keep the
// projection OUT of total_price; only a real row rewrite (the options switch,
// which re-seeds from the server payload) may move it.
export function applyIntentQuote(proposal, quote) {
  if (typeof quote?.total_price !== 'number') return proposal;
  if (!proposal) return proposal;
  return {
    ...proposal,
    pricing_snapshot: {
      ...(proposal.pricing_snapshot || {}),
      total: quote.total_price,
      gratuity: quote.gratuity,
    },
  };
}
