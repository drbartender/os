// Shared shift-position helpers for admin-OS surfaces.
//
// `positions_needed` is stored as a JSON-encoded array TEXT column. Passing it
// through `Number(...)` returns NaN, which silently breaks any stat that
// derives from the count. These helpers parse it correctly and tolerate the
// older `assignments_count` field name some queries still emit.

import React from 'react';
import StatusChip from './StatusChip';

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

// Returns the count of pending (requested-but-not-yet-approved) bartenders.
export function pendingCount(s) {
  const needed = parsePositionsCount(s);
  const filled = approvedCount(s);
  return Math.min(Math.max(0, needed - filled), Number(s?.request_count || 0));
}

// Builds the positions[] array StaffPills consumes — one entry per slot,
// labelled approved → pending → open in display order.
export function shiftPositions(s) {
  const needed = parsePositionsCount(s);
  const filled = approvedCount(s);
  const pending = pendingCount(s);
  return Array.from({ length: needed }, (_, i) => {
    if (i < filled) return { role: 'Bartender', name: 'Filled', status: 'approved' };
    if (i < filled + pending) return { role: 'Bartender', name: null, status: 'pending' };
    return { role: 'Bartender', name: null, status: null };
  });
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
