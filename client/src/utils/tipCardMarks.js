// Pure: given the server's computed tip-method tokens, return which payment
// marks the printed sign may show.
//
// Availability comes from the server (server/utils/tipMethods.js), which both
// /api/me/tip-page and the public tip endpoint call, so the sign a bartender
// downloads and the sign on their tablet cannot disagree about which methods
// exist. Passing raw handles here instead of the server's `methods` array
// reintroduces exactly that drift.
//
// ORDER AND CAP (2026-08-11, from the tipping research):
//
//   Apple Pay leads because wallet availability is the measured conversion
//   driver, and a card emblem is what the tip-tray studies actually measured
//   (a credit-card insignia on the tray raised tips ~4.29%, even from people
//   paying cash). Recognition is the mechanism, so the marks have to be
//   real emblems, not initials.
//
//   Visa stands in for the whole card rail and Mastercard/Amex are omitted:
//   Apple Pay, Google Pay, Visa, Mastercard and Amex all resolve to the SAME
//   Stripe payment link, so listing all five says one thing five times.
//
//   Capped at five, because acceptance badges past that read as clutter
//   rather than reassurance and the sign's job is to point at the QR. Be
//   clear about what the cap costs: a bartender with every rail set up shows
//   Apple Pay, Google Pay, Visa, Venmo, Cash App, and PayPal drops off. That
//   is deliberate. The wallets are the measured conversion driver and the
//   card emblem is the cue the tip-tray study actually tested, so they earn
//   their slots ahead of the weakest P2P option for a bar tip. Moving PayPal
//   ahead of Visa would trade tested lift for rail variety.
//
// zelle is deliberately absent: it is offered on the chooser page but never
// shown as a mark on the sign.

const SIGN_MARK_CAP = 5;

// Canonical order. Each entry is [method token, mark].
const MARK_ORDER = [
  ['card', 'apple'],
  ['card', 'google'],
  ['card', 'visa'],
  ['venmo', 'venmo'],
  ['cashapp', 'cashapp'],
  ['paypal', 'paypal'],
];

export function buildTipCardMarks(methods) {
  const available = new Set(Array.isArray(methods) ? methods : []);
  return MARK_ORDER
    .filter(([method]) => available.has(method))
    .map(([, mark]) => mark)
    .slice(0, SIGN_MARK_CAP);
}
