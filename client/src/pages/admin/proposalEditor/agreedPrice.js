// The agreed-price math behind the editor's "Set agreed price" (spec
// 2026-10-16 section 5; plan Task E3). Pure: no React, no fetch.
//
// The agreed price is the SERVICE total, before the client gratuity. Apply
// writes one line for the difference between it and the live preview's
// service total, with the agreed-price line itself backed out first: a lower
// price writes a discount, a higher one a surcharge, an equal one removes the
// line. The line is found by its `source` marker, never its label; it is
// replaced in place (label reset, visibility kept as the admin left it) or
// appended hidden.
//
// The engine clamps the service total at $0 (pricingEngine.js
// calculatedTotal), so a $0 preview hides how far below $0 the lines reach.
// Apply refuses there rather than guess: with the agreed-price line present
// (it cannot be backed out), or with a discount among the other lines (the
// base under it is unknown).
import {
  AGREED_PRICE_LABEL, MAX_ADJUSTMENT_DOLLARS, adjSignedCents,
} from '../../../utils/adjustmentRules';

export const AGREED_PRICE_INPUT_ERROR = 'Enter a price of $0 or more';
export const AGREED_PRICE_CLAMP_LINE = 'Remove the agreed price line, then set the price again.';
export const AGREED_PRICE_CLAMP_DISCOUNTS = 'The discounts already take this booking to $0. Lower one, then set the price again.';
const PREVIEW_NOT_READY = 'Wait for the price preview, then apply.';
const MAX_CENTS = MAX_ADJUSTMENT_DOLLARS * 100; // exclusive, the server's bound

// Whole dollars, optional cents (at most two digits), after $, commas and
// spaces are stripped. Parsed as text, so cents are exact (0.29 stays 29).
const PRICE = /^(\d*)(?:\.(\d{0,2}))?$/;

/** The typed agreed price as integer cents, or the input message. */
export function parseAgreedCents(text) {
  const fail = { cents: null, error: AGREED_PRICE_INPUT_ERROR };
  if (typeof text !== 'string' && typeof text !== 'number') return fail;
  const m = PRICE.exec(String(text).replace(/[$,\s]/g, ''));
  if (!m || (m[1] === '' && !m[2])) return fail;
  const cents = Number(m[1] || '0') * 100 + Number((m[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents >= MAX_CENTS) return fail;
  return { cents, error: null };
}

/** The preview's service total in cents (total less client gratuity), or null. */
export function previewServiceCentsOf(preview) {
  if (!preview) return null;
  const total = Number(preview.total);
  if (preview.total === null || preview.total === undefined || preview.total === '' || !Number.isFinite(total)) return null;
  const gratuity = Number(preview.gratuity && preview.gratuity.total) || 0;
  return Math.round(total * 100) - Math.round(gratuity * 100);
}

/**
 * The lines after setting the agreed price, or the unchanged lines and a
 * message when it refuses.
 */
export function applyAgreedPrice({ adjustments, previewServiceCents, agreedCents }) {
  const lines = Array.isArray(adjustments) ? adjustments : [];
  const refuse = (error) => ({ adjustments: lines, error });
  if (!Number.isSafeInteger(agreedCents) || agreedCents < 0 || agreedCents >= MAX_CENTS) {
    return refuse(AGREED_PRICE_INPUT_ERROR);
  }
  if (!Number.isSafeInteger(previewServiceCents) || previewServiceCents < 0) return refuse(PREVIEW_NOT_READY);

  const at = lines.findIndex((a) => a && a.source === 'agreed_price');
  const others = at >= 0 ? lines.filter((_, i) => i !== at) : lines;
  if (previewServiceCents === 0 && at >= 0) return refuse(AGREED_PRICE_CLAMP_LINE);
  if (previewServiceCents === 0 && others.some((a) => adjSignedCents(a) < 0)) return refuse(AGREED_PRICE_CLAMP_DISCOUNTS);

  const base = previewServiceCents - (at >= 0 ? adjSignedCents(lines[at]) : 0);
  const diff = agreedCents - base;
  if (diff === 0) return { adjustments: others, error: null };

  const line = {
    type: diff < 0 ? 'discount' : 'surcharge',
    label: AGREED_PRICE_LABEL,
    amount: Math.abs(diff) / 100,
    visible: at >= 0 ? !!lines[at].visible : false,
    source: 'agreed_price',
  };
  if (at < 0) return { adjustments: [...lines, line], error: null };
  const next = [...lines];
  next[at] = line;
  return { adjustments: next, error: null };
}
