// Groups the admin GET /shifts rows (one per shift) into one card per event
// for the phone Events list (spec 2026-08-13-mobile-admin section 4, benchmark
// 2026-09-15). Pure: no React, no fetch, no clock unless the caller passes
// one. Lane ma-e2 reuses the Card shape for the detail header.
import { rowRoleFill, isCancelledEvent } from '../components/adminos/shifts';
import { fmtTimeRange24, dayDiff } from '../components/adminos/format';
import { getEventTypeLabel } from './eventTypes';
import { eventPaymentState } from '../components/adminos/eventPlan';

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

// The card's place line: "City, ST" from the proposal's structured venue
// (venue_city / venue_state, projected by the SCOPED admin feed only). The full
// address stays in `venue` (shifts.location) for the ma-e2 detail header; the
// list names the town (Dallas, 2026-09-24: "the full address can be in the
// details"). venue_state is stored as the full name (VenueAddressFields
// VENUE_STATES); legacy rows carry 'IL'-style codes, which pass through, and an
// unknown name renders as stored rather than being guessed at.
const STATE_CODES = { Illinois: 'IL', Indiana: 'IN', Michigan: 'MI', Minnesota: 'MN', Wisconsin: 'WI' };
export function placeOf(row) {
  const city = String(row?.venue_city ?? '').trim();
  if (!city) return '';
  const st = String(row?.venue_state ?? '').trim();
  const code = STATE_CODES[st] || st;
  return code ? `${city}, ${code}` : city;
}

function finishCard(card, todayYmd) {
  const first = card.shifts[0];
  const cancelled = card.shifts.every(isCancelledEvent);
  // Counted by role, the event detail's rule (roleFill), so the list and the
  // detail cannot show different fractions for one event. A cancelled shift's
  // slots leave the sum as they do on the detail; a card whose every shift is
  // cancelled keeps them all, as it always has.
  const counted = cancelled ? card.shifts : card.shifts.filter((s) => !isCancelledEvent(s));
  const fills = counted.map(rowRoleFill);
  const slots = fills.reduce((a, f) => a + f.slots, 0);
  const filled = fills.reduce((a, f) => a + f.filled, 0);
  const pending = card.shifts.reduce((a, s) => a + Number(s.pending_count || 0), 0);
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
  // What the client still owes, exactly as the desktop Events list's Status
  // cell says it (eventPaymentState, whole dollars), so the two lists cannot
  // disagree: the amount while a balance is open, null when paid in full,
  // cancelled, a manual shift, or a booking with no total. Read off a live
  // shift, so one cancelled shift of a two-shift event hides nothing. A bank
  // debit still in flight counts as owed, as it does on the desktop. Past
  // cards show it too: an unpaid past event is the one to chase. Dallas,
  // 2026-09-30: "show the balance in red if it's unpaid".
  const live = card.shifts.find((s) => !isCancelledEvent(s)) || first;
  const pay = eventPaymentState(live);
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
    place: placeOf(first),
    guests: first.proposal_guest_count ?? first.guest_count ?? null,
    slots,
    filled,
    open: cancelled ? 0 : Math.max(0, slots - filled),
    pending: cancelled ? 0 : pending,
    full: filled >= slots,
    cancelled,
    barRental: card.shifts.some(s => !!s.bar_required),
    supplies: card.shifts.some(s => !!s.supply_run_required),
    balance: pay && pay.kind === 'owed' ? pay.label : null,
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
