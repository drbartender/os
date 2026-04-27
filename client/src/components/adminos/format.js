// Formatters used app-wide; the adminos/ path is historical, not a scope restriction.
// Money convention (per server/db/schema.sql:478-487):
//   - NUMERIC(10,2) DOLLARS:  proposals.total_price/amount_paid/deposit_amount,
//                             service_packages.*_rate/*_fee, service_addons.rate,
//                             proposal_addons.rate, etc.
//   - INTEGER CENTS:          stripe_sessions.amount, proposal_payments.amount,
//                             invoices.amount_due/amount_paid
// Use fmt$2dp for dollar fields, fmt$fromCents for cents fields.

export const fmt$ = (n) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

export const fmt$2dp = (n) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmt$fromCents = (n) =>
  n == null ? '—' : '$' + (Number(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
