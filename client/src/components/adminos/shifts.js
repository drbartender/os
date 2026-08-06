// Shared shift-position helpers for admin-OS surfaces.
//
// `positions_needed` is stored as a JSON-encoded array TEXT column. Passing it
// through `Number(...)` returns NaN, which silently breaks any stat that
// derives from the count. These helpers parse it correctly and tolerate the
// older `assignments_count` field name some queries still emit.

import React from 'react';
import StatusChip from './StatusChip';
import { dayDiff } from './format';
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

// True when an event row represents a cancelled booking.
//
// The P6 cancel flow and the admin archive both reap staffing through
// server/utils/shiftReap.js, which soft-cancels the shift (`shifts.status =
// 'cancelled'`) precisely so it "hides it from the open-shift feeds, which
// filter status='open'". The staff feed (STAFF_OPEN_SHIFTS_SQL),
// GET /shifts/unstaffed-upcoming, and the badge-counts query all honor that.
//
// The admin GET /shifts feed deliberately does NOT — the Events dashboard's
// All / Past tabs still show cancelled events as history — so every
// UPCOMING-facing derivation off that feed has to apply this itself. Skipping it
// is what put a cancelled event at the top of the Needs-attention Staffing tab.
//
// `status` is the SHIFT status on rows from that feed (`SELECT s.*`);
// `shift_status` is the name some drawer/detail projections use. The
// proposal-level `archived` check is defense in depth: both writers set both
// flags today, so it only matters if a future path archives without reaping.
export function isCancelledEvent(e) {
  if (!e) return false;
  return e.status === 'cancelled'
    || e.shift_status === 'cancelled'
    || e.proposal_status === 'archived';
}

// The canonical "upcoming events" derivation for admin surfaces reading the
// GET /shifts feed: live (not cancelled), dated, today or later, soonest first.
// Shared so the Overview header count and its unstaffed queue cannot drift from
// each other again.
export function selectUpcoming(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(e => e.event_date && !isCancelledEvent(e) && dayDiff(e.event_date.slice(0, 10)) >= 0)
    .sort((a, b) => a.event_date.localeCompare(b.event_date));
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

// Shared event-status chip — used on Dashboard, EventsDashboard, drawers, and
// EventDetailPage. Accepts both shift-row shape (`proposal_status`,
// `proposal_total`, `proposal_amount_paid`) and proposal-row shape (`status`,
// `total_price`, `amount_paid`).
export function eventStatusChip(e) {
  if (!e) return null;
  const status = e.proposal_status || e.status;
  const total = Number(e.proposal_total || e.total_price || 0);
  const paid = Number(e.proposal_amount_paid || e.amount_paid || 0);
  // A cancelled/archived booking (via the P6 cancel flow or the archive reap) or a
  // soft-cancelled shift. Show this BEFORE the payment-state chips so a
  // refunded-then-archived event never reads "No payment" in an Upcoming list.
  //
  // Routed through the shared predicate because the old inline test read
  // `e.shift_status`, a field the GET /shifts feed does not emit (it sends the
  // shift status as `status`, via SELECT s.*). That made the shift-level half of
  // this check dead: a shift cancelled on its own — cancel-or-unassign
  // mode='cancel' cancels the shift WITHOUT archiving the proposal — kept
  // chipping its payment state ("Paid in full") while the shift was cancelled.
  if (isCancelledEvent(e)) {
    return <StatusChip kind="neutral">Cancelled</StatusChip>;
  }
  if (status === 'sent' || status === 'viewed' || status === 'modified') {
    return <StatusChip kind="warn">Contract out</StatusChip>;
  }
  if (paid <= 0) return <StatusChip kind="warn">No payment</StatusChip>;
  if (paid < total) return <StatusChip kind="info">Deposit paid</StatusChip>;
  return <StatusChip kind="ok">Paid in full</StatusChip>;
}
