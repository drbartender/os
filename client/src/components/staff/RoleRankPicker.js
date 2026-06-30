import React from 'react';
import { rosterCounts } from '../../utils/staffingRoles';

/**
 * RoleRankPicker — staff picks (and ranks) which of an event's roles they
 * can work (staffing roster project, Lane 6 §4).
 *
 * The event needs a set of roles (derived from positions_needed); each role
 * shows its fill status (approved / needed). The staffer checks the roles
 * they can cover. Order is rank: the top-checked role is their first
 * preference, and the approval path resolves the highest-ranked OPEN role.
 *
 * Phone-first by design: reordering is up / down buttons, NOT HTML5 drag
 * (drag is unusable on touch and a poor fit for a 2-to-3-item list).
 * Reorder controls only appear once 2+ roles are selected, since a single
 * selection has no order to express.
 *
 * Props:
 *   roles        — ordered array of canonical role labels the event needs,
 *                  each unique (e.g. ['Bartender', 'Banquet Server']). The
 *                  caller derives these from parsePositionsNeeded.
 *   counts       — { [role]: neededCount } for the event (from rosterCounts).
 *   approved     — { [role]: approvedCount } (the feed's approved_by_role).
 *   value        — current ordered selection (array of role labels). This is
 *                  a controlled component; value is the source of truth.
 *   onChange     — (nextOrderedSelection: string[]) => void.
 *   disabled     — disables every control (used while a submit is in flight).
 *
 * Emits the ordered `requested_positions` array via onChange. Renders inline
 * blocking copy when nothing is selected so the parent can disable submit.
 */
export default function RoleRankPicker({
  roles,
  counts = {},
  approved = {},
  value = [],
  onChange,
  disabled = false,
}) {
  const available = Array.isArray(roles) ? roles : [];
  // Selected roles, in rank order, filtered to roles the event still needs
  // (a stale selection for a removed role is silently dropped).
  const selected = (Array.isArray(value) ? value : []).filter((r) => available.includes(r));
  const selectedSet = new Set(selected);

  // Unselected roles render after the selected block, in the event's roster
  // order, so the list reads selected-first then the rest.
  const unselected = available.filter((r) => !selectedSet.has(r));

  function toggle(role) {
    if (disabled) return;
    if (selectedSet.has(role)) {
      onChange(selected.filter((r) => r !== role));
    } else {
      // New selections append to the bottom of the rank (lowest preference).
      onChange([...selected, role]);
    }
  }

  function move(role, dir) {
    if (disabled) return;
    const idx = selected.indexOf(role);
    if (idx < 0) return;
    const swapWith = idx + dir;
    if (swapWith < 0 || swapWith >= selected.length) return;
    const next = selected.slice();
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    onChange(next);
  }

  if (available.length === 0) {
    return (
      <div className="sp-modal-warn">
        This event has no open roles to request right now.
      </div>
    );
  }

  const showRank = selected.length >= 2;
  const orderedRows = [...selected, ...unselected];

  return (
    <div>
      {showRank && (
        <div className="sp-modal-warn" style={{ marginTop: 0 }}>
          Listed in your order of preference. We give you the highest-ranked
          role that still has an open slot.
        </div>
      )}
      <div className="sp-rank-list">
        {orderedRows.map((role) => {
          const isSelected = selectedSet.has(role);
          const rank = isSelected ? selected.indexOf(role) : -1;
          const needed = Number(counts[role]) || 0;
          const filled = Number(approved[role]) || 0;
          const isFull = filled >= needed && needed > 0;
          return (
            <div
              key={role}
              className={'sp-rank-row' + (isSelected ? ' selected' : '')}
            >
              <label className="sp-rank-main">
                <input
                  type="checkbox"
                  checked={isSelected}
                  disabled={disabled}
                  onChange={() => toggle(role)}
                />
                <span className="sp-rank-role">
                  {showRank && isSelected && (
                    <span className="sp-rank-num">{rank + 1}</span>
                  )}
                  {role}
                </span>
                <span className={'sp-chip ' + (isFull ? 'neutral' : 'ok')}>
                  {filled}/{needed} filled
                </span>
              </label>
              {showRank && isSelected && (
                <span className="sp-rank-moves">
                  <button
                    type="button"
                    className="sp-icon-btn"
                    aria-label={`Move ${role} up`}
                    disabled={disabled || rank === 0}
                    onClick={() => move(role, -1)}
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    type="button"
                    className="sp-icon-btn"
                    aria-label={`Move ${role} down`}
                    disabled={disabled || rank === selected.length - 1}
                    onClick={() => move(role, 1)}
                  >
                    <ChevronDown size={14} />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {selected.length === 0 && (
        <div className="sp-modal-error">
          Pick at least one role you can work.
        </div>
      )}
    </div>
  );
}

/**
 * Build the { counts, approved } fill maps for an event from its needed
 * roles array and the feed's approved_by_role object. Exported so the
 * parent (RequestSheet / ShiftCard) can compute once and pass down.
 */
export function fillMaps(neededRoles, approvedByRole) {
  return {
    counts: rosterCounts(Array.isArray(neededRoles) ? neededRoles : []),
    approved: approvedByRole && typeof approvedByRole === 'object' ? approvedByRole : {},
  };
}

function ChevronUp({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function ChevronDown({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
