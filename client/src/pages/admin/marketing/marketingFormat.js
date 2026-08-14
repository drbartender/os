/**
 * Small shared formatters for the Marketing contact surfaces.
 *
 * These live in one place because the alternative is six components each
 * rolling their own money conversion, and the money conversion here is the
 * exact trap this feature already fell into once.
 */
import { formatMoney } from '../../../utils/formatMoney';

/**
 * The marketing endpoints return `lifetime_dollars` in DOLLARS, while the house
 * formatter takes integer CENTS. This is a deliberate exception to CLAUDE.md's
 * integer-cents invariant: `proposals.amount_paid` is NUMERIC(10,2) dollars and
 * `legacy_cc_proposals.total_cost_cents` is cents, and the resolver already
 * normalizes both onto dollars. Passing dollars straight to formatMoney renders
 * a $760 client as $7.60, so the conversion happens here, once, named.
 */
export function formatDollars(dollars) {
  const n = Number(dollars);
  if (!Number.isFinite(n)) return formatMoney(0);
  return formatMoney(Math.round(n * 100));
}

const DAY_OPTS = { year: 'numeric', month: 'short', day: 'numeric' };

/**
 * A DATE column (proposals.event_date). Null renders as a dash.
 *
 * Pinned to UTC on purpose: a date-only value arrives as UTC midnight, and
 * rendering that in a negative-offset zone like Chicago shows the PREVIOUS day.
 * An event on the 14th must not read as the 13th.
 */
export function formatDay(value) {
  if (!value) return '—';
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleDateString(undefined, { ...DAY_OPTS, timeZone: 'UTC' });
}

/**
 * The day part of a TIMESTAMPTZ (last_contacted, marketing_excluded_at).
 *
 * Deliberately NOT formatDay. These are real instants, so pinning them to UTC
 * is the same bug in reverse: an email sent at 8pm Chicago is already the next
 * day in UTC and would render as tomorrow. Use the viewer's zone.
 */
export function formatLocalDay(value) {
  if (!value) return '—';
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleDateString(undefined, DAY_OPTS);
}

/** A timestamp (message history). Shows the time, so UTC pinning is wrong here. */
export function formatStamp(value) {
  if (!value) return '—';
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/**
 * Operator-facing labels for the four buckets HELD_BACK_SQL can produce. The
 * server returns the raw reason; an unrecognized one falls through to itself
 * rather than rendering blank, so a new bucket is visible instead of silent.
 */
export const HELD_BACK_LABELS = {
  do_not_contact: 'Do not contact',
  unsubscribed: 'Unsubscribed',
  bounced: 'Bounced',
  no_address: 'No address',
};

export function heldBackLabel(reason) {
  return HELD_BACK_LABELS[reason] || reason || 'Held back';
}

/**
 * The human message for a failed request.
 *
 * utils/api.js's response interceptor never rejects with a raw axios error: it
 * normalizes everything to `{message, code, fieldErrors, status}`, using the
 * server's `error` field when there is a response and "Network error. Check
 * your connection." when there is not. Reaching for `err.response.data.error`
 * here would be dead code that quietly fell through to the fallback on every
 * real failure.
 *
 * fieldErrors wins over message when present: a ValidationError's envelope
 * message is the generic "Please fix the errors below", while the text an
 * operator can act on ("Send at most 500 at a time") rides in fieldErrors,
 * and these surfaces render toasts, not per-field form errors, so an unread
 * fieldErrors object left the operator with no guidance at all (push-review
 * 2026-08-13).
 */
export function errorText(err, fallback) {
  const fieldMsgs = err?.fieldErrors
    ? Object.values(err.fieldErrors).filter((m) => typeof m === 'string' && m)
    : [];
  if (fieldMsgs.length) return fieldMsgs.join(' ');
  return err?.message || fallback;
}

/**
 * DS chip hues for marketing tags, from the design artifact's TAG_HUE map
 * (spec §10 Tags bullet). The vehicle is the Admin OS `.chip` kinds, which
 * carry House Lights overrides; `.tag` has no hue variants. Anything not in
 * these maps renders neutral; Untagged and held-back reasons use the dashed
 * `chip derived` variant (visually distinct because nobody can set them).
 */
export const TAG_HUES = {
  corporate: 'violet',
  wedding: 'info',
  birthday: 'warn',
  graduation: 'neutral',
  thumbtack: 'accent',
};

export const DERIVED_HUES = {
  paid: 'ok',
  quoted: 'neutral',
};

export function tagHue(id) {
  return TAG_HUES[id] || 'neutral';
}
