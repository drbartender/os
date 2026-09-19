// Groups the admin GET /shifts rows (one per shift) into one card per event
// for the phone Events list (spec 2026-08-13-mobile-admin section 4, benchmark
// 2026-09-15). Pure: no React, no fetch, no clock unless the caller passes
// one. Lane ma-e2 reuses the Card shape for the detail header.
import { parsePositionsCount, approvedCount, isCancelledEvent } from '../components/adminos/shifts';
import { fmtTimeRange24, dayDiff } from '../components/adminos/format';
import { getEventTypeLabel } from './eventTypes';

export function eventKeyOf(row) {
  if (row.event_key) return row.event_key;
  return row.proposal_id == null ? `s${row.id}` : `p${row.proposal_id}`;
}

// Date rail parts from a YYYY-MM-DD, noon-anchored so no timezone can roll the
// day (same trick as format.js fmtDate).
export function railParts(ymd) {
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return { dow: '', day: '', mon: '' };
  return {
    dow: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
    day: String(d.getDate()).padStart(2, '0'),
    mon: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
  };
}

function finishCard(card, todayYmd) {
  const first = card.shifts[0];
  const slots = card.shifts.reduce((a, s) => a + parsePositionsCount(s), 0);
  const filled = Math.min(slots, card.shifts.reduce((a, s) => a + approvedCount(s), 0));
  const pending = card.shifts.reduce((a, s) => a + Number(s.pending_count || 0), 0);
  const cancelled = card.shifts.every(isCancelledEvent);
  const ymd = first.event_date ? String(first.event_date).slice(0, 10) : null;
  const hasType = !!(first.event_type || first.event_type_custom);
  // A nameless manual shift used to take 'Manual shift' for BOTH halves of the
  // title, so the card read "Manual shift · Manual shift". The venue is the
  // better name when there is one, and the kind is dropped rather than repeated
  // when it is not: an empty kind renders with no separator at all.
  const clientName = first.client_name || (card.manual ? (first.location || 'Manual shift') : 'Client');
  let kind;
  if (hasType) kind = getEventTypeLabel(first);
  else if (card.manual) kind = clientName === 'Manual shift' ? '' : 'Manual shift';
  else kind = 'event';
  return {
    ...card,
    id: card.manual ? first.id : card.proposalId,
    shiftCount: card.shifts.length,
    clientName,
    kind,
    ymd,
    isToday: !!ymd && dayDiff(ymd, todayYmd) === 0,
    timeRange: first.start_time ? fmtTimeRange24(first.start_time, first.end_time, first.event_duration_hours) : '',
    venue: first.location || '',
    guests: first.proposal_guest_count ?? first.guest_count ?? null,
    slots,
    filled,
    open: cancelled ? 0 : Math.max(0, slots - filled),
    pending: cancelled ? 0 : pending,
    full: filled >= slots,
    cancelled,
    barRental: card.shifts.some(s => !!s.bar_required),
    supplies: card.shifts.some(s => !!s.supply_run_required),
    tapTarget: card.manual ? { kind: 'shift', id: first.id } : { kind: 'event', id: card.proposalId },
  };
}

export function groupShiftRows(rows, { todayYmd } = {}) {
  const byKey = new Map();
  for (const row of rows || []) {
    const key = eventKeyOf(row);
    let card = byKey.get(key);
    if (!card) {
      card = { key, manual: row.proposal_id == null, proposalId: row.proposal_id ?? null, shiftIds: [], shifts: [] };
      byKey.set(key, card);
    }
    card.shiftIds.push(row.id);
    card.shifts.push(row);
  }
  return Array.from(byKey.values()).map(card => finishCard(card, todayYmd));
}
