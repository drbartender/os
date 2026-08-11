const Sentry = require('@sentry/node');
const { normalizePaypalUrl, normalizeZelleHandle } = require('./tipHandleValidation');

// Tip-method derivation, shared by the public tip page and /me/tip-page
// (extracted from publicTip.js 2026-08-11). The WHOLE derivation lives here,
// not just the ordering: the two endpoints diverged on read-side
// NORMALIZATION, so sharing only the sort would have left a bartender's
// downloaded sign advertising a PayPal mark the chooser page silently refuses
// to render, printed at 300 DPI onto photo paper.

// Spec §6.8 — known method tokens, in the natural fallback order used when a
// staffer has not saved (or has partially saved) a tip_card_order. Tokens in
// the saved order that are NOT available on the profile are skipped; available
// methods that are NOT in the saved order fall to the end in this order.
const TIP_METHOD_TOKENS = ['card', 'venmo', 'cashapp', 'paypal', 'zelle'];

function computeOrderedMethods(available, savedOrder) {
  // available: Set of token strings that are actually on the profile.
  // savedOrder: array | null | undefined — the staffer's saved tip_card_order.
  const order = Array.isArray(savedOrder) ? savedOrder : [];
  const result = [];
  const used = new Set();
  for (const tok of order) {
    // Defensive: skip any unknown token a future migration / malformed write
    // might have introduced, and skip methods not actually available on the
    // profile (e.g. user removed a handle after saving the order).
    if (!available.has(tok) || used.has(tok)) continue;
    if (!TIP_METHOD_TOKENS.includes(tok)) continue;
    result.push(tok);
    used.add(tok);
  }
  for (const tok of TIP_METHOD_TOKENS) {
    if (available.has(tok) && !used.has(tok)) {
      result.push(tok);
      used.add(tok);
    }
  }
  return result;
}

// Defense-in-depth: re-validate paypal_url and zelle_handle on read. The
// write-time validator (server/utils/tipHandleValidation.js) was added after
// some rows already existed; pre-existing rows could hold non-paypal.me URLs,
// raw usernames in unexpected shapes, or whitespace-padded values. If a stored
// value can't be normalized to its canonical form, drop it — the consumer
// simply won't render that method. Sentry-warns so admin can clean up the
// stored data via /me/tip-page or the admin tab.
//
// ctx.route drives the Sentry tag so a warning still says which reader saw it.
function readSideNormalize(row, { route, tokenPrefix }) {
  let paypalUrl = null;
  if (row.paypal_url) {
    try {
      paypalUrl = normalizePaypalUrl(row.paypal_url);
    } catch (err) {
      Sentry.captureMessage('Stored paypal_url failed read-side validation', {
        level: 'warning',
        tags: { route, op: 'paypal_url_validate' },
        extra: {
          tokenPrefix,
          reason: err && err.fieldErrors && err.fieldErrors.paypal_url,
        },
      });
    }
  }

  let zelleHandle = null;
  if (row.zelle_handle) {
    try {
      zelleHandle = normalizeZelleHandle(row.zelle_handle);
    } catch (err) {
      Sentry.captureMessage('Stored zelle_handle failed read-side validation', {
        level: 'warning',
        tags: { route, op: 'zelle_handle_validate' },
        extra: {
          tokenPrefix,
          reason: err && err.fieldErrors && err.fieldErrors.zelle_handle,
        },
      });
    }
  }

  return { paypalUrl, zelleHandle };
}

// Availability takes the NORMALIZED paypal/zelle, never the raw columns. That
// is the whole point of this module: a caller that passes row.paypal_url here
// reintroduces the drift the extraction exists to remove.
function deriveAvailableMethods({
  stripe_payment_link_url: stripePaymentLinkUrl,
  venmo_handle: venmoHandle,
  cashapp_handle: cashappHandle,
  paypalUrl,
  zelleHandle,
}) {
  const available = new Set();
  if (stripePaymentLinkUrl) available.add('card');
  if (venmoHandle) available.add('venmo');
  if (cashappHandle) available.add('cashapp');
  if (paypalUrl) available.add('paypal');
  if (zelleHandle) available.add('zelle');
  return available;
}

module.exports = {
  TIP_METHOD_TOKENS,
  computeOrderedMethods,
  readSideNormalize,
  deriveAvailableMethods,
};
