// Local helpers for ProposalView. Note: `fmt` here matches `fmt$2dp` from
// adminos/format. Kept local to keep the public proposal page self-contained.
import { fmtDateOnly, calcEndTime as sharedCalcEndTime } from '../../../components/adminos/format';

// The deposit a proposal charges, in dollars (audit PAY-06, round 2 L2): the
// payload's deposit_amount_effective, the figure the server will charge
// (stripeRouteHelpers.depositCentsFor, with the server's own default for a
// row whose deposit_amount is NULL or 0). The client keeps no literal and does
// not read the row column: under a non-default STRIPE_DEPOSIT_AMOUNT a client
// fallback quoted a figure the server did not charge. Null when the payload
// carries none, and the page then names the deposit without an amount.
export function depositDollars(proposal) {
  const n = Number(proposal && proposal.deposit_amount_effective);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const fmt = (n) =>
  `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Kept LOCAL (not routed through utils/timeOptions.formatTime12h): event_start_time
// is a free-text VARCHAR(20) with mixed legacy formats ("6:00 PM", "6:00PM"). This
// lenient parser and the strict formatTime12h produce different output for those
// legacy values, so consolidating would change the rendered start time.
export function formatTime(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  const h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return `${h12}:${mStr} ${ampm}`;
}

// Delegates to the shared calcEndTime (adminos/format). The constructed end HH:MM
// is always canonical, so its 12h formatting matches this file's formatTime.
export const calcEndTime = (startTime, durationHours) => sharedCalcEndTime(startTime, durationHours);

// Delegates to the shared date-only formatter; preserves the '' empty-value
// sentinel this page's callers expect (the shared helper returns '—').
export const formatDateShort = (d) => (d ? fmtDateOnly(d) : '');
