// Local helpers for ProposalView. Note: `fmt` here matches `fmt$2dp` from
// adminos/format. Kept local to keep the public proposal page self-contained.
import { fmtDateOnly, calcEndTime as sharedCalcEndTime } from '../../../components/adminos/format';

export const DEPOSIT_CENTS = parseInt(process.env.REACT_APP_DEPOSIT_AMOUNT) || 10000;
export const DEPOSIT_DOLLARS = DEPOSIT_CENTS / 100;

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
