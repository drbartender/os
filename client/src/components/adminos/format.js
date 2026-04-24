// Formatting helpers shared across Admin OS components.
// Mirrors the handoff bundle's data.jsx helpers (lines 157–179).

export const fmt$ = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

export const fmt$cents = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
