// Client-side only. A suggestion is a pre-filled, removable chip; it is never
// PATCHed on render and becomes a credit only when the admin confirms (spec
// §7). The server keeps validating credit user ids against active staff.
//
// Ids come back as strings because that is what the credit select and the
// saved-credit list use (the retired Reviews page mapped credits through
// String() too).
// Name precedence is display_name then preferred_name, matching the
// active-staff feed's own COALESCE(cp.display_name, cp.preferred_name, ...).
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function suggestNames(excerpt, staff) {
  const text = String(excerpt || '');
  if (!text) return [];
  const out = [];
  for (const s of staff || []) {
    const full = (s.display_name || s.preferred_name || '').trim();
    if (!full) continue;
    const first = full.split(/\s+/)[0];
    if (!first) continue;
    const re = new RegExp(`(^|[^A-Za-z])${escapeRe(first)}(?=$|[^A-Za-z])`, 'i');
    if (re.test(text)) out.push(String(s.id));
  }
  return out;
}
