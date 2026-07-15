// Formatters used app-wide; the adminos/ path is historical, not a scope restriction.
// Money convention (per server/db/schema.sql:478-487):
//   - NUMERIC(10,2) DOLLARS:  proposals.total_price/amount_paid/deposit_amount,
//                             service_packages.*_rate/*_fee, service_addons.rate,
//                             proposal_addons.rate, etc.
//   - INTEGER CENTS:          stripe_sessions.amount, proposal_payments.amount,
//                             invoices.amount_due/amount_paid
// Use fmt$2dp for dollar fields, fmt$fromCents for cents fields.

import { formatTime12h } from '../../utils/timeOptions';

export const fmt$ = (n) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

export const fmt$2dp = (n) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmt$fromCents = (n) =>
  n == null ? '—' : '$' + (Number(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Whole-dollar display for aggregate `*Cents` fields (unlinkedRefundsCents,
// leadSpend.*Cents). Aggregates round to whole dollars; unit-normalize at the
// call site (never a shared divide) so cents and dollar tables can't cross wires.
export const fmt$wholeFromCents = (n) => fmt$(Math.round(Number(n || 0) / 100));

export const fmtDate = (iso, opts = {}) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...opts });
};

export const fmtDateFull = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};

// Date-ONLY columns (event_date, due_date, signed/balance dates). A bare
// `new Date('2026-07-13')` parses as UTC midnight, which renders as the PREVIOUS
// day in negative-UTC zones (Chicago). Anchoring the date part at local noon
// pins it to the intended calendar day. Input is sliced to its date portion
// first so a full ISO timestamp (…T…Z) is reduced before anchoring; the sliced
// date equals the timestamp's UTC calendar date, matching the older
// `new Date(d)` + timeZone:'UTC' formatters this replaces.
export const fmtDateOnly = (iso, opts = {}) => {
  if (!iso) return '—';
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', ...opts });
};

// TIMESTAMPTZ moments (submitted_at, finalized_at, activity created_at). Bare
// `new Date(ts)` in local time is correct here — these are absolute instants,
// not date-only columns. 24-hour clock: admin-only importers (client-facing
// surfaces have their own 12h formatters — keep it that way).
export const fmtDateTime = (ts) => {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
};

// Tolerant 24h reformatter for the free-text shifts.start_time / end_time /
// proposals.event_start_time columns, which hold a mix of "7:00 PM" (server
// eventCreation), "6:00PM" (legacy free text), and canonical "HH:MM"
// (TimePicker). Admin display only — staff/client surfaces stay 12h.
// Empty → ''. Unparseable non-empty → returned as-is (never blank a value).
export const fmtTime24 = (str) => {
  if (!str) return '';
  const m = String(str).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return String(str);
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3] && m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  if (h > 23 || min > 59) return String(str);
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
};

// End time from a "HH:MM" start + duration in hours, wrapping past midnight.
// Formats via the canonical 12h formatter; the constructed HH:MM is always
// canonical, so the wrap math is what matters here.
export const calcEndTime = (startTime, durationHours) => {
  if (!startTime) return '';
  const [hStr, mStr] = startTime.split(':');
  const totalMinutes = parseInt(hStr, 10) * 60 + parseInt(mStr, 10) + Math.round(Number(durationHours) * 60);
  const endH = Math.floor(totalMinutes / 60) % 24;
  const endM = totalMinutes % 60;
  return formatTime12h(`${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`);
};

export const dayDiff = (iso) => {
  if (!iso) return 0;
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return 0;
  const t = new Date();
  t.setHours(12, 0, 0, 0);
  return Math.round((d - t) / 86400000);
};

export const relDay = (iso) => {
  const diff = dayDiff(iso);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 0) return `In ${diff}d`;
  return `${Math.abs(diff)}d ago`;
};
