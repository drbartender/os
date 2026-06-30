// Shared shift-position helpers for admin-OS surfaces.
//
// `positions_needed` is stored as a JSON-encoded array TEXT column. Passing it
// through `Number(...)` returns NaN, which silently breaks any stat that
// derives from the count. These helpers parse it correctly and tolerate the
// older `assignments_count` field name some queries still emit.

import React from 'react';
import StatusChip from './StatusChip';
import {
  parsePositionsNeeded,
  computeRemaining,
} from '../../utils/staffingRoles';

// Returns the parsed `positions_needed` array. Tolerates both array-shaped
// (already parsed) and string-shaped (JSON-encoded TEXT) inputs. Empty array
// when the value is missing/malformed.
export function parsePositionsArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Canonical equipment tokens a shift can require, paired with human labels.
// These tokens MUST match the keys the auto-assign scorer compares against
// (server/utils/autoAssign.js → computeEquipmentScore equipmentMap +
// the `equipment_${item}` constraint check), so the equipment-match scoring
// actually fires. Labels mirror client/src/pages/admin/userDetail/components/
// EquipmentDisplay.js for consistency. Only the three ownable items are
// requirable — the profile-only flags (none_but_open / no_space / will_pickup)
// describe a bartender's situation, not a shift requirement.
export const SHIFT_EQUIPMENT_OPTIONS = [
  ['portable_bar', 'Portable Bar'],
  ['cooler', 'Cooler'],
  ['table_with_spandex', '6ft Table w/ Spandex'],
];

// Returns the parsed `equipment_required` array (token strings). Tolerates both
// array-shaped (already parsed) and string-shaped (JSON-encoded TEXT) inputs,
// the same way parsePositionsArray does. Empty array when missing/malformed.
export function parseEquipmentArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Returns the count of position slots a shift needs (length of the JSON array).
export function parsePositionsCount(s) {
  if (!s) return 1;
  const arr = parsePositionsArray(s.positions_needed);
  return arr.length || 1;
}

// Returns the count of approved bartenders for a shift.
export function approvedCount(s) {
  return Number(s?.approved_count || s?.assignments_count || 0);
}

// Parses the `approved_by_role` aggregate ({ [role]: count }) that the staff/
// admin feeds project (L4). Tolerates an already-parsed object, a JSON string,
// or a missing value. Counts are coerced to numbers; non-numeric entries drop.
export function parseApprovedByRole(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [role, count] of Object.entries(obj)) {
    const n = Number(count);
    if (Number.isFinite(n)) out[role] = n;
  }
  return out;
}

// Returns the per-role remaining (needed - approved-active) map for a shift,
// e.g. { Bartender: 0, 'Banquet Server': 1 }. Prefers the `approved_by_role`
// aggregate from the feed; for a legacy row that only carries the flat
// `approved_count`, it attributes that count to the first role in the roster
// (historically always Bartender), so single-role events stay accurate.
export function remainingByRole(s) {
  const roster = parsePositionsNeeded(s?.positions_needed);
  let approvedByRole = parseApprovedByRole(s?.approved_by_role);
  if (Object.keys(approvedByRole).length === 0) {
    const flat = approvedCount(s);
    if (flat > 0) {
      const firstRole = roster[0] || 'Bartender';
      approvedByRole = { [firstRole]: flat };
    }
  }
  return computeRemaining(roster, approvedByRole);
}

// Returns the count of pending (requested-but-not-yet-approved) bartenders.
export function pendingCount(s) {
  const needed = parsePositionsCount(s);
  const filled = approvedCount(s);
  return Math.min(Math.max(0, needed - filled), Number(s?.request_count || 0));
}

// Builds the positions[] array StaffPills consumes — one entry per slot, with
// the real role label per slot (from `positions_needed`), labelled approved →
// pending → open within each role. Approved counts come from the
// `approved_by_role` aggregate when present; pending is filled best-effort into
// the remaining open slots (the aggregate carries no per-role pending breakdown).
export function shiftPositions(s) {
  const roster = parsePositionsNeeded(s?.positions_needed);
  // Legacy/manual rows with no canonical roster fall back to a single open slot.
  const slots = roster.length ? roster : ['Bartender'];

  let approvedByRole = parseApprovedByRole(s?.approved_by_role);
  if (Object.keys(approvedByRole).length === 0) {
    const flat = approvedCount(s);
    if (flat > 0) approvedByRole = { [slots[0]]: flat };
  }
  // Per-role approved budget we still need to "spend" onto slots in order.
  const approvedLeft = { ...approvedByRole };

  // First pass: mark approved slots role-by-role.
  const marked = slots.map((role) => {
    if ((approvedLeft[role] || 0) > 0) {
      approvedLeft[role] -= 1;
      return { role, name: 'Filled', status: 'approved' };
    }
    return { role, name: null, status: null };
  });

  // Second pass: distribute pending requests into the remaining open slots in
  // display order (no per-role pending breakdown exists in the aggregate).
  let pendingLeft = pendingCount(s);
  for (const slot of marked) {
    if (pendingLeft <= 0) break;
    if (slot.status === null) {
      slot.status = 'pending';
      pendingLeft -= 1;
    }
  }
  return marked;
}

// Shared event-status chip — used on Dashboard, EventsDashboard, drawers, and
// EventDetailPage. Accepts both shift-row shape (`proposal_status`,
// `proposal_total`, `proposal_amount_paid`) and proposal-row shape (`status`,
// `total_price`, `amount_paid`).
export function eventStatusChip(e) {
  if (!e) return null;
  const status = e.proposal_status || e.status;
  const total = Number(e.proposal_total || e.total_price || 0);
  const paid = Number(e.proposal_amount_paid || e.amount_paid || 0);
  if (status === 'sent' || status === 'viewed' || status === 'modified') {
    return <StatusChip kind="warn">Contract out</StatusChip>;
  }
  if (paid <= 0) return <StatusChip kind="warn">No payment</StatusChip>;
  if (paid < total) return <StatusChip kind="info">Deposit paid</StatusChip>;
  return <StatusChip kind="ok">Paid in full</StatusChip>;
}
