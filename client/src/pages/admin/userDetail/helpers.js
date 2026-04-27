// Helpers shared across AdminUserDetail tabs.
//
// YTD earnings estimate: `(past shifts this calendar year) × DEFAULT_HOURS ×
// hourly_rate`. Hourly rate comes from contractor_profiles.hourly_rate (default
// $20/hr in the schema, admin-editable on the Payouts tab). Once a payouts
// ledger lands we'll swap this rough estimate for the real sum.

export const DEFAULT_HOURS_PER_SHIFT = 4;
export const DEFAULT_HOURLY_RATE = 20;

export const PAYMENT_METHODS = ['Zelle', 'Venmo', 'CashApp', 'PayPal', 'Direct Deposit'];

export function rateOf(profile) {
  const r = Number(profile?.hourly_rate);
  return Number.isFinite(r) && r > 0 ? r : DEFAULT_HOURLY_RATE;
}

export function ytdShiftCount(pastEvents) {
  const yr = new Date().getFullYear();
  return (pastEvents || []).filter(ev => {
    if (!ev.event_date) return false;
    const d = new Date(String(ev.event_date).slice(0, 10) + 'T12:00:00');
    return !Number.isNaN(d.getTime()) && d.getFullYear() === yr;
  }).length;
}

export function computeYtdEstEarnings(pastEvents, profile) {
  return ytdShiftCount(pastEvents) * DEFAULT_HOURS_PER_SHIFT * rateOf(profile);
}

export function initialsOf(name, email) {
  const src = (name || email || '?').trim();
  return src.split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

export function parsePositions(raw) {
  if (Array.isArray(raw)) return raw.map(p => typeof p === 'string' ? p : (p?.position || 'Bartender'));
  if (typeof raw === 'string') {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(p => typeof p === 'string' ? p : (p?.position || 'Bartender')) : [];
    } catch { return []; }
  }
  return [];
}
