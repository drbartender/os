import React from 'react';

/**
 * LogisticsTag — staff-facing equipment / supply-run summary chip
 * (staffing roster project, Lane 6 §2).
 *
 * Tells a staffer, before they request, whether this shift is a plain
 * "show up and pour" gig or one that needs them to haul gear and/or run
 * supplies. The transport-required version of this signal is what gates
 * the acknowledgment checkbox in RequestSheet.
 *
 * Props:
 *   equipment_required   — JSON string of canonical equipment tokens
 *                          (e.g. '["portable_bar","cooler"]'), an array,
 *                          null, or '[]'. Parsed defensively.
 *   supply_run_required  — boolean (the shift's supply_run_required flag).
 *
 * Render:
 *   - No equipment AND no supply run  → green "Bar Kit Only" chip.
 *   - Otherwise                       → a warning chip naming the burden:
 *                                       "Equipment", "Supplies", or both.
 *
 * Styling reuses the portal's existing chip classes (sp-chip + ok / warn)
 * from index.css; no new design system is introduced here.
 */
export default function LogisticsTag({ equipment_required, supply_run_required }) {
  const equipment = parseEquipment(equipment_required);
  const hasEquipment = equipment.length > 0;
  const hasSupplies = supply_run_required === true;

  if (!hasEquipment && !hasSupplies) {
    return (
      <span className="sp-chip ok">
        <span className="sp-chip-dot" />
        Bar Kit Only
      </span>
    );
  }

  // Name the burden so the staffer knows what they're acknowledging.
  const parts = [];
  if (hasEquipment) parts.push('Equipment');
  if (hasSupplies) parts.push('Supplies');

  return (
    <span className="sp-chip warn">
      <span className="sp-chip-dot" />
      {parts.join(' + ')}
    </span>
  );
}

/**
 * Parse the shift's equipment_required field (TEXT JSON or array) into a
 * string array, tolerating null, '[]', malformed JSON, and non-array
 * shapes. Mirrors the defensive parsing used elsewhere in the portal so a
 * bad row never crashes the card.
 */
function parseEquipment(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((t) => typeof t === 'string' && t.trim().length > 0);
}
