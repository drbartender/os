'use strict';

// Context-card shapes (spec 4.2), PURE. Field names are pinned in the plan for
// lane inbox-page. Money is in DOLLARS, the unit proposals stores.

const { isBooked } = require('../proposalStatus');
const { getEventTypeLabel } = require('../eventTypes');

// Same labels as client/src/utils/proposalStatusMap.js.
const STATUS_LABELS = new Map([
  ['draft', 'Draft'], ['sent', 'Sent'], ['viewed', 'Viewed'], ['modified', 'Modified'], ['accepted', 'Accepted'],
  ['deposit_paid', 'Deposit paid'], ['balance_paid', 'Paid in full'], ['confirmed', 'Confirmed'],
  ['completed', 'Completed'], ['archived', 'Archived'],
]);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ms = (d) => new Date(d).getTime();

// "(312) 555-0100" for a US number; anything else exactly as stored.
function phoneDisplay(phone) {
  if (!phone) return null;
  const raw = String(phone);
  const digits = raw.replace(/\D/g, '');
  let ten = null;
  if (digits.length === 11 && digits[0] === '1') ten = digits.slice(1);
  else if (digits.length === 10) ten = digits;
  if (ten && (raw.startsWith('+1') || !raw.startsWith('+'))) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return raw;
}

function clockText(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const h24 = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (h24) {
    const h = Number(h24[1]);
    return `${h % 12 || 12}:${h24[2]} ${h < 12 ? 'AM' : 'PM'}`;
  }
  const h12 = /^(0?[1-9]|1[0-2]):([0-5]\d)\s*([AaPp][Mm])$/.exec(s);
  if (h12) return `${Number(h12[1])}:${h12[2]} ${h12[3].toUpperCase()}`;
  return s;
}

// "Sat, Nov 28 · 6:00 PM"; the year shows only when it is not this year.
function formatWhen(ymd, startTime, todayYmd) {
  if (!ymd) return null;
  const [y, m, d] = String(ymd).split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const sameYear = Boolean(todayYmd) && String(todayYmd).slice(0, 4) === String(y);
  const date = `${weekday}, ${MONTHS[m - 1]} ${d}${sameYear ? '' : `, ${y}`}`;
  const time = clockText(startTime);
  return time ? `${date} · ${time}` : date;
}

// The proposal the card shows (4.2): the soonest upcoming event that is not
// archived, else the most recent proposal.
function chooseProposal(proposals, todayYmd) {
  const upcoming = (proposals || [])
    .filter((p) => p.status !== 'archived' && p.event_date && p.event_date >= todayYmd)
    .sort((a, b) => (a.event_date < b.event_date ? -1 : (a.event_date > b.event_date ? 1 : a.id - b.id)));
  if (upcoming.length) return upcoming[0];
  return [...(proposals || [])].sort((a, b) => (ms(b.created_at) - ms(a.created_at)) || (b.id - a.id))[0] || null;
}

function moneyOf(p) {
  if (p.total_price === null || p.total_price === undefined) return null;
  const totalCents = Math.round(Number(p.total_price) * 100);
  const paidCents = Math.round(Number(p.amount_paid || 0) * 100);
  return { total: totalCents / 100, paid: paidCents / 100, balance: Math.max(0, totalCents - paidCents) / 100, due_date: p.balance_due_date || null };
}

function whereText(p) {
  return [p.venue_name, p.venue_city].filter(Boolean).join(', ') || p.event_location || null;
}

function clientContext({ clientId, proposals, todayYmd }) {
  const p = chooseProposal(proposals, todayYmd);
  const booked = Boolean(p && isBooked(p.status));
  return {
    kind: booked ? 'client' : 'lead',
    status_chip: booked ? 'Booked' : 'Lead',
    event_type_label: p ? getEventTypeLabel(p) : null,
    guests: p && p.guest_count !== null && p.guest_count !== undefined ? Number(p.guest_count) : null,
    when_text: p ? formatWhen(p.event_date, p.event_start_time, todayYmd) : null,
    where_text: p ? whereText(p) : null,
    proposal: p
      ? { id: p.id, status_label: STATUS_LABELS.get(p.status) || String(p.status), chip: p.client_signed_at ? 'Signed' : 'Unsigned' }
      : { id: null, status_label: 'Not sent yet', chip: 'None' },
    money: p ? moneyOf(p) : null,
    links: { client_id: Number(clientId), proposal_id: p ? p.id : null, event_id: booked ? p.id : null },
  };
}

function staffContext({ userId, role, shift, todayYmd }) {
  let card = null;
  if (shift) {
    const total = Math.max(1, Number(shift.total) || 1);
    const open = Math.max(0, Number(shift.open_slots) || 0);
    const label = shift.event_type || shift.event_type_custom ? getEventTypeLabel(shift) : null;
    card = {
      id: shift.id,
      when_text: formatWhen(shift.event_date, shift.start_time, todayYmd),
      event_text: [label, shift.location].filter(Boolean).join(' · ') || null,
      roster: { filled: Math.max(0, total - open), total },
    };
  }
  return { kind: 'staff', role, shift: card, links: { user_id: Number(userId), shift_id: shift ? shift.id : null } };
}

function ttLeadContext(lead, negotiationId) {
  return {
    kind: 'tt_lead',
    name: (lead && lead.customer_name) || null,
    // An instant (TIMESTAMPTZ), sent as ISO: the page reads it on the Chicago calendar.
    event_date: lead && lead.event_date ? new Date(lead.event_date).toISOString() : null,
    location: lead ? ([lead.location_city, lead.location_state].filter(Boolean).join(', ') || null) : null,
    negotiation_id: String(negotiationId),
  };
}

function unknownContext(phone) {
  return { kind: 'unknown', phone_display: phoneDisplay(phone) };
}

module.exports = {
  phoneDisplay, formatWhen, chooseProposal, clientContext, staffContext, ttLeadContext, unknownContext,
};
