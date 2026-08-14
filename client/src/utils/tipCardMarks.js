// Pure: given the server's computed tip-method tokens, return which payment
// marks a surface may show.
//
// Availability comes from the server (server/utils/tipMethods.js), which both
// /api/me/tip-page and the public tip endpoint call, so the sign a bartender
// downloads and the sign on their tablet cannot disagree about which methods
// exist. Passing raw handles here instead of the server's `methods` array
// reintroduces exactly that drift.
//
// TWO ORDERS, one per surface, because the surfaces answer different questions:
//
//   SIGN (and the phone display) leads with the wallets and the card emblem.
//   The tip-tray research measured a credit-card emblem raising tips ~4.29%
//   even from people paying cash, and that effect is sign-shaped: an object in
//   view, cueing that tipping is possible at all. The wallets carry that cue
//   too — Apple Pay and Google Pay ARE card emblems, and they lead the rail on
//   every surface — which is what makes it safe to drop Visa in the one case
//   below where the cap forces a choice.
//
//   CARD leads with P2P. It is pocketed and read later, by which point network
//   acceptance is assumed and the specific handles are the information that
//   actually changes what someone does.
//
// ONE credit cue, not three. Visa carries it; Mastercard and Amex are the same
// Stripe rail and add nothing next to it, so they are FILLER: they expand into
// whatever slots the wallets and the bartender's real P2P handles leave. That
// is what keeps the floor from ever being empty, since Stripe ships with every
// tip page: a bartender with no P2P still shows the full wallet-plus-network
// rail, while one with everything shows wallets and every handle they own.
//
// Under the sign's cap of five the generic cue yields to a real handle. That
// bites in exactly ONE input class, the bartender running card plus all three
// P2P rails, who shows their handles instead of Visa; the wallets still carry
// the card emblem, so the sign never stops saying cards work here.
//
// zelle is deliberately absent everywhere: it is offered on the chooser page
// but never shown as a mark.

const WALLETS = ['apple', 'google'];
const CREDIT_CUE = ['visa'];
const NETWORK_FILLER = ['mc', 'amex'];
const P2P = [
  ['venmo', 'venmo'],
  ['cashapp', 'cashapp'],
  ['paypal', 'paypal'],
];

export const SIGN_MARK_CAP = 5;
export const CARD_MARK_CAP = 8;

function marksFor(methods, cap, p2pFirst) {
  const available = new Set(Array.isArray(methods) ? methods : []);
  const hasCard = available.has('card');
  const wallets = hasCard ? WALLETS : [];
  const cue = hasCard ? CREDIT_CUE : [];
  const filler = hasCard ? NETWORK_FILLER : [];
  const p2p = P2P.filter(([method]) => available.has(method)).map(([, mark]) => mark);

  // SELECTION and ORDER are separate decisions. What survives the cap is
  // wallets, then the bartender's real handles, then the generic cue, then
  // filler — a rail that actually routes money to this person always outranks
  // a network logo. Only then are they laid out in the surface's own order.
  // Selecting in display order instead is what made the sign, capped at five,
  // drop PayPal for a Visa mark from any bartender running all three handles.
  const keep = new Set([...wallets, ...p2p, ...cue, ...filler].slice(0, cap));

  const order = p2pFirst
    ? [...wallets, ...p2p, ...cue, ...filler]
    : [...wallets, ...cue, ...p2p, ...filler];

  return order.filter((mark) => keep.has(mark));
}

// Sign and phone: wallets, the credit cue, then P2P, capped at five so the row
// never wraps. Stripe-only lands on the full wallet + network rail.
export function buildTipCardMarks(methods) {
  return marksFor(methods, SIGN_MARK_CAP, false);
}

// Hand-out card: wallets, then P2P, then the cue, then filler. Up to eight,
// laid out in balanced rows by the caller.
export function buildCardMarks(methods) {
  return marksFor(methods, CARD_MARK_CAP, true);
}

// Split a mark list into balanced rows so a row is never left holding a single
// orphaned mark: 5 becomes [3,2], 7 becomes [4,3].
export function splitMarkRows(marks, maxPerRow = 4) {
  // No marks is NO rows, not one empty row. Returning [[]] pushed the "is
  // there anything to render" question onto all three layouts plus PaymentRows.
  if (!marks.length) return [];
  if (marks.length <= maxPerRow) return [marks];
  const rowCount = Math.ceil(marks.length / maxPerRow);
  const per = Math.ceil(marks.length / rowCount);
  const rows = [];
  for (let i = 0; i < marks.length; i += per) rows.push(marks.slice(i, i + per));
  return rows;
}
