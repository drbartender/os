// Pure: given the server's computed tip-method tokens, return which payment
// marks the printed sign may show.
//
// Availability comes from the server (server/utils/tipMethods.js), which both
// /api/me/tip-page and the public tip endpoint call, so the sign a bartender
// downloads and the sign on their tablet cannot disagree about which methods
// exist. Passing raw handles here instead of the server's `methods` array
// reintroduces exactly that drift.
//
// This function is also the methods-to-marks translation: the single `card`
// token becomes five brand glyphs, and `zelle` becomes none. A zelle-only
// bartender therefore gets a sign with no mark row, which is correct: the QR
// still leads to the chooser page, where Zelle does render.
//
// ORDER here is the sign's own, deliberately fixed. The staffer's saved
// tip_card_order governs the chooser page guests land on after scanning, which
// is where their preference actually matters; it does not reorder the artwork.

const CARD_NETWORK_MARKS = ['apple', 'google', 'visa', 'mc', 'amex'];

export function buildTipCardMarks(methods) {
  const available = new Set(Array.isArray(methods) ? methods : []);
  const marks = [];
  if (available.has('venmo')) marks.push('venmo');
  if (available.has('cashapp')) marks.push('cashapp');
  if (available.has('paypal')) marks.push('paypal');
  if (available.has('card')) marks.push(...CARD_NETWORK_MARKS);
  return marks;
}
