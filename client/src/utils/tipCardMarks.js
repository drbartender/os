// Pure: given a bartender's saved tip handles + whether a Stripe Payment Link
// exists, return which payment-method marks the printed QR card may show.
//
// The card-network group (Apple/Google Pay + Visa/MC/Amex) is gated on the
// Stripe link because that link is what actually accepts cards. Each P2P mark
// appears only when that handle is set. Print layouts intersect this list with
// their own curated mark order, so an unavailable method simply drops out and
// the card never advertises a payment route that doesn't work.

const CARD_NETWORK_MARKS = ['apple', 'google', 'visa', 'mc', 'amex'];

export function buildTipCardMarks(handles) {
  const h = handles || {};
  const marks = [];
  if (h.venmo_handle) marks.push('venmo');
  if (h.cashapp_handle) marks.push('cashapp');
  if (h.paypal_url) marks.push('paypal');
  if (h.has_stripe_link) marks.push(...CARD_NETWORK_MARKS);
  return marks;
}
