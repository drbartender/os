// Local helpers for ProposalView. Note: `fmt` here matches `fmt$2dp` from
// adminos/format. Kept local to keep the public proposal page self-contained.

export const DEPOSIT_CENTS = parseInt(process.env.REACT_APP_DEPOSIT_AMOUNT) || 10000;
export const DEPOSIT_DOLLARS = DEPOSIT_CENTS / 100;

export const fmt = (n) =>
  `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function formatTime(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  const h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return `${h12}:${mStr} ${ampm}`;
}

export function calcEndTime(startTime, durationHours) {
  if (!startTime) return '';
  const [hStr, mStr] = startTime.split(':');
  const totalMinutes = parseInt(hStr, 10) * 60 + parseInt(mStr, 10) + Math.round(Number(durationHours) * 60);
  const endH = Math.floor(totalMinutes / 60) % 24;
  const endM = totalMinutes % 60;
  return formatTime(`${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`);
}

export function formatDateShort(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}
