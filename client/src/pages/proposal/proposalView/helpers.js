// Local helpers for ProposalView. Note: `fmt` here matches `fmt$2dp` from
// adminos/format. Kept local to keep the public proposal page self-contained.
import { fmtDateOnly, calcEndTime as sharedCalcEndTime } from '../../../components/adminos/format';

// The deposit a proposal charges, in dollars (audit PAY-06): the row's
// deposit_amount, which the public payload carries and the server charges
// (stripeRouteHelpers.depositCentsFor), with the schema default (100) for a
// row that carries none. The client's own REACT_APP_DEPOSIT_AMOUNT copy of
// the figure is gone: a hand-set deposit must read the same everywhere the
// client sees it and everywhere the server collects it.
export const DEFAULT_DEPOSIT_DOLLARS = 100;
export function depositDollars(proposal) {
  const n = Number(proposal && proposal.deposit_amount);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEPOSIT_DOLLARS;
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
