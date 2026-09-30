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
  rosterCounts,
  canonicalizeRole,
} from '../../utils/staffingRoles';

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
// array-shaped (already parsed) and string-shaped (JSON-encoded TEXT) inputs.
// Empty array when missing/malformed. A bare JSON.parse is CORRECT here and is
// NOT correct for positions_needed: equipment tokens are a flat string list with
// one historical shape, while positions_needed has two and must go through
// parsePositionsNeeded (see parsePositionsCount below).
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

// The ONE fallback rule for "how many people does this shift need".
//
// An empty roster is a DATA GAP -- nobody declared the roles -- not a shift that
// needs nobody, so it counts as 1. That guess is load-bearing rather than
// cosmetic: roleFill (below) is built on it, and roleFill feeds every staffing
// count, from the Events dashboard's Unstaffed tab to the badge's SQL twin
// (openSlotsSql). Reading an empty roster literally as 0 would make every such
// shift "fully staffed" and drop it out of every surface silently.
//
// Exported for its tests; parsePositionsCount is built on it. Two hand-written
// copies of this is how the card came to say "2/1 staffed" while the drawer
// said "2/0" for one shift.
export function neededCount(rosterArray) {
  return (Array.isArray(rosterArray) ? rosterArray.length : 0) || 1;
}

// Returns the count of position slots a shift needs.
//
// Goes through parsePositionsNeeded, the client twin of
// server/utils/positionsNeeded.js, whose header states the law this function
// used to break: "Production holds two historical shapes: a flat string array
// ["Bartender","Bartender"] and a legacy object array
// [{position:'bartender',count:2}]. Every reader of positions_needed must go
// through this, never a bare JSON.parse."
//
// It WAS a bare JSON.parse taking the raw array's LENGTH, so a legacy
// object-shaped row declaring two bartenders counted as ONE position. That is a
// staffing hole rather than a display bug: the shift leaves the unstaffed queue
// the moment a single person is approved and the second bartender is never
// hired. The drawer, which already used parsePositionsNeeded, said 2 for the
// same row -- the visible half of the same defect.
export function parsePositionsCount(s) {
  if (!s) return 1;
  return neededCount(parsePositionsNeeded(s.positions_needed));
}

// Returns the count of approved bartenders for a shift.
export function approvedCount(s) {
  return Number(s?.approved_count || s?.assignments_count || 0);
}

// How many of a shift's slots are filled, counted BY ROLE: a slot is filled
// only by someone approved for that role, so an extra bartender never fills an
// open barback slot, and an approval in a role the roster never declared fills
// nothing. An approval with no role on file takes the first role with room, in
// roster order (the safe direction: fewer open slots, never an over-fill
// offered). A roster that declares no roles is one slot any approval fills
// (neededCount). ONE rule for every staffing count: the phone list and card,
// the desktop Unstaffed tab, staffing column and overview queue (Dallas,
// 2026-09-30). Its CJS twin is roleFill in server/utils/staffingClassification.js
// and its SQL statement is openSlotsSql (server/utils/positionsNeeded.js), which
// the Needs staff flag and the badge read; keep all three in step.
export function roleFill(roster, approvedByRole = {}, roleless = 0) {
  const needed = rosterCounts(roster);
  const roleOrder = Object.keys(needed);
  const byRole = { ...approvedByRole };
  for (let i = 0; i < roleless; i++) {
    const room = roleOrder.find((role) => needed[role] - (byRole[role] || 0) > 0) || roleOrder[0];
    if (room) byRole[room] = (byRole[room] || 0) + 1;
  }
  const remaining = computeRemaining(roster, byRole);
  const slots = neededCount(roster);
  const approvedTotal = Object.values(approvedByRole).reduce((a, n) => a + n, 0) + roleless;
  const open = roleOrder.length === 0
    ? Math.max(0, slots - approvedTotal)
    : roleOrder.reduce((sum, role) => sum + Math.max(0, remaining[role] || 0), 0);
  return { slots, open, filled: Math.max(0, slots - open), remaining, approvedByRole: byRole };
}

// roleFill over a feed row, which carries aggregates rather than requests:
// `approved_by_role` counts approved, undropped requests WITH a role, and
// `approved_count` counts all of them, so the difference is the approvals with
// no role on file. A key this app cannot read as a role counts as roleless too,
// the way normalizeRequest reads a stray role on the phone card. A legacy row
// with no aggregate at all is all roleless, each taking the first role with room.
export function rowRoleFill(s) {
  const roster = parsePositionsNeeded(s?.positions_needed);
  const byRole = {};
  let named = 0;
  for (const [key, count] of Object.entries(parseApprovedByRole(s?.approved_by_role))) {
    const role = canonicalizeRole(key);
    if (!role || count <= 0) continue;
    byRole[role] = (byRole[role] || 0) + count;
    named += count;
  }
  return roleFill(roster, byRole, Math.max(0, approvedCount(s) - named));
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

// Returns the per-role remaining (needed - approved-active) map for a feed row,
// e.g. { Bartender: 0, 'Banquet Server': 1 }, by the staffing rule (rowRoleFill):
// an approval with no role on file, and the whole flat count of a legacy row
// with no `approved_by_role`, takes the first role WITH ROOM (it used to go to
// the first roster role whether or not it had room, so the event page could
// read a barback slot open that every other surface read filled).
export function remainingByRole(s) {
  return rowRoleFill(s).remaining;
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
