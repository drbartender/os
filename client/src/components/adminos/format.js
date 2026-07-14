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
// not date-only columns.
export const fmtDateTime = (ts) => {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
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
