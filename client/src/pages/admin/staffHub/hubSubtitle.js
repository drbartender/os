// The hub's one live subtitle line. Pure: given the summary payload, return
// the string. pg DATE values arrive as ISO midnight-UTC strings, so every
// date is formatted in UTC to avoid the off-by-one a local-zone format would
// introduce for US evenings.

const ymd = (v) => String(v || '').slice(0, 10);
const asUtcDate = (v) => new Date(`${ymd(v)}T00:00:00Z`);

export function ymdLabel(v, { weekday = false } = {}) {
  const d = asUtcDate(v);
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (weekday) opts.weekday = 'short';
  // en-US yields "Tue, Aug 25"; the design drops the comma.
  return d.toLocaleDateString('en-US', opts).replace(',', '');
}

export function windowLabel(start, end) {
  const s = asUtcDate(start);
  const e = asUtcDate(end);
  const sameMonth = s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear();
  return sameMonth ? `${ymdLabel(start)} to ${e.getUTCDate()}` : `${ymdLabel(start)} to ${ymdLabel(end)}`;
}

export function hubSubtitle(summary, { isAdmin }) {
  if (!summary) return '';
  const parts = [];
  if (summary.active_count !== null && summary.active_count !== undefined) {
    parts.push(summary.active_count === 0 ? 'No active staff yet' : `${summary.active_count} active`);
  }
  if (!isAdmin) return parts.join(' · ');

  const p = summary.open_period;
  if (p) {
    // "open" when there is no row yet or the row is open; otherwise the row's
    // own status, so the line never calls a mid-process week open.
    const word = !p.exists || p.status === 'open' ? 'open' : p.status;
    parts.push(`pay run ${windowLabel(p.start_date, p.end_date)} ${word}, payday ${ymdLabel(p.payday, { weekday: true })}`);
  }
  const n = summary.pending_reviews;
  if (n !== null && n !== undefined) {
    parts.push(n === 0 ? 'nothing to confirm' : `${n} ${n === 1 ? 'review' : 'reviews'} to confirm`);
  }
  return parts.join(' · ');
}
