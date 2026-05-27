/**
 * Parse CC `Length` column → decimal hours.
 *
 * Real-world shapes (from `report (10).csv`):
 *   "1 hour"                  → 1
 *   "4 hours"                 → 4
 *   "4 hours, 30 minutes"     → 4.5
 *   "1 hour, 30 minutes"      → 1.5
 *   "0 minutes"               → 0
 *   "55 hours"                → 55 (rare typo — caller may want to clamp)
 *
 * Unparseable values return `null` so the caller can fall back to the
 * proposals schema default (4) and record a guess in admin_notes.
 *
 * Spec reference: docs/superpowers/specs/2026-05-25-checkcherry-import-design.md §8.3
 * "Length" row.
 */
function parseLengthHours(s) {
  if (s == null) return null;
  const txt = String(s).trim();
  if (!txt) return null;

  // Walk every "<n> hours" / "<n> minutes" segment. Tolerant of singular
  // ("1 hour"), plural ("4 hours"), spacing, and comma separator.
  const re = /(\d+)\s*(hour|hours|minute|minutes|hr|hrs|min|mins)/gi;
  let hours = 0;
  let minutes = 0;
  let matched = false;
  let m;
  while ((m = re.exec(txt)) !== null) {
    matched = true;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    const unit = m[2].toLowerCase();
    if (unit.startsWith('h')) hours += n;
    else minutes += n;
  }
  if (!matched) return null;
  return hours + minutes / 60;
}

module.exports = { parseLengthHours };
