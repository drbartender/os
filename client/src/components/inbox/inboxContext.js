import { chicagoWeekdayDate } from '../../utils/chicagoDay';
import { fmt$, fmtDate } from '../adminos/format';

// The context card's view model, one shape for the phone card and the
// desktop pane (spec section 4.2), from the item payload's `context`, pinned
// by lane inbox-engine. Money arrives in DOLLARS (proposals money), so it goes
// through fmt$ (whole dollars, the dense-view convention). due_date is a DATE
// column: its first ten characters ARE the day (node-pg serialises a DATE as
// the server's local midnight, so a Chicago reading of it would slip a day on
// a UTC server). event_date on a Thumbtack lead is a real instant, so it reads
// on the Chicago calendar.

export const LEGAL_HOLD_TEXT = 'Legal hold: check with Dallas before contacting';
export const NO_QUOTE_TEXT = 'No quote yet. Totals show here once a proposal goes out.';

const PROPOSAL_CHIP_KIND = { Signed: 'ok', Unsigned: 'warn', None: 'neutral' };

/** "Booked · Wedding", "Staff · Bartender", "Thumbtack lead", "Not a client yet". */
export function kindLine(context) {
  const c = context || {};
  if (c.kind === 'client' || c.kind === 'lead') {
    const status = c.status_chip || (c.kind === 'client' ? 'Booked' : 'Lead');
    return c.event_type_label ? `${status} · ${c.event_type_label}` : status;
  }
  if (c.kind === 'staff') return c.role ? `Staff · ${c.role}` : 'Staff';
  if (c.kind === 'tt_lead') return 'Thumbtack lead';
  if (c.kind === 'unknown') return 'Not a client yet';
  return '';
}

function moneyCells(money) {
  if (!money) return null;
  const balance = Number(money.balance) || 0;
  const paid = Number(money.paid) || 0;
  let sub = '';
  if (balance <= 0) sub = 'paid in full';
  else if (money.due_date) sub = `due ${fmtDate(String(money.due_date).slice(0, 10))}`;
  else if (paid === 0) sub = 'no deposit yet';
  return { total: fmt$(money.total), paid: fmt$(money.paid), balance: fmt$(balance), sub, settled: balance <= 0 };
}

function clientModel(c) {
  const status = c.status_chip || (c.kind === 'client' ? 'Booked' : 'Lead');
  const rows = [];
  if (c.when_text) rows.push({ key: 'when', label: 'When', value: c.when_text });
  if (c.where_text) rows.push({ key: 'where', label: 'Where', value: c.where_text });
  // The server words the row, "Not sent yet" with a None chip included.
  if (c.proposal) {
    const chip = c.proposal.chip || null;
    rows.push({
      key: 'proposal', label: 'Proposal', value: c.proposal.status_label || '',
      chip: chip ? { kind: PROPOSAL_CHIP_KIND[chip] || 'neutral', label: chip } : null,
    });
  }
  const l = c.links || {};
  const links = [];
  if (l.client_id) links.push({ key: 'client', label: 'Client', to: `/clients/${l.client_id}` });
  if (l.proposal_id) links.push({ key: 'proposal', label: 'Proposal', to: `/proposals/${l.proposal_id}` });
  if (l.event_id) links.push({ key: 'event', label: 'Event', to: `/events/${l.event_id}` });
  if (!l.proposal_id) {
    links.push({ key: 'new', label: 'New proposal', to: l.client_id ? `/proposals/new?client_id=${l.client_id}` : '/proposals/new' });
  }
  return {
    chip: { kind: status === 'Booked' ? 'ok' : 'info', label: status },
    type: c.event_type_label || '',
    guests: c.guests === null || c.guests === undefined ? null : c.guests,
    rows,
    money: moneyCells(c.money),
    showNoQuote: !c.money,
    links,
  };
}

function staffModel(c) {
  const rows = [];
  const s = c.shift;
  if (s) {
    if (s.when_text) rows.push({ key: 'shift', label: 'Shift', value: s.when_text });
    if (s.event_text) rows.push({ key: 'event', label: 'Event', value: s.event_text });
    const r = s.roster;
    if (r && Number(r.total) > 0) {
      const open = Number(r.total) - Number(r.filled || 0);
      rows.push({
        key: 'roster', label: 'Roster', value: `${Number(r.filled || 0)} of ${Number(r.total)}`,
        chip: open > 0 ? { kind: 'warn', label: `${open} open` } : null,
      });
    }
  } else {
    rows.push({ key: 'shift', label: 'Shift', value: 'No upcoming shift' });
  }
  const l = c.links || {};
  const links = [];
  if (l.user_id) links.push({ key: 'profile', label: 'Staff profile', to: `/staffing/users/${l.user_id}` });
  if (l.shift_id) links.push({ key: 'shift', label: 'Shift', to: `/events/shift/${l.shift_id}` });
  return { chip: { kind: 'neutral', label: 'Staff' }, type: c.role || '', guests: null, rows, money: null, showNoQuote: false, links };
}

function thumbtackModel(c) {
  const rows = [];
  if (c.event_date) rows.push({ key: 'when', label: 'When', value: chicagoWeekdayDate(c.event_date) });
  if (c.location) rows.push({ key: 'where', label: 'Where', value: c.location });
  const links = c.negotiation_id
    ? [{ key: 'tt', label: 'Thumbtack', href: `https://www.thumbtack.com/pro-inbox/messages/${encodeURIComponent(c.negotiation_id)}` }]
    : [];
  return { chip: { kind: 'info', label: 'Lead' }, type: 'Thumbtack', guests: null, rows, money: null, showNoQuote: true, links };
}

function unknownModel(c) {
  return {
    chip: { kind: 'neutral', label: 'Not a client yet' },
    type: c.phone_display || '',
    guests: null,
    rows: [],
    money: null,
    showNoQuote: false,
    links: [{ key: 'new', label: 'New proposal', to: '/proposals/new' }],
  };
}

/** The context card, by kind, with the legal-hold banner when it applies. */
export function contextModel(context, { legalHold = false } = {}) {
  const c = context || {};
  let model = null;
  if (c.kind === 'client' || c.kind === 'lead') model = clientModel(c);
  else if (c.kind === 'staff') model = staffModel(c);
  else if (c.kind === 'tt_lead') model = thumbtackModel(c);
  else if (c.kind === 'unknown') model = unknownModel(c);
  if (!model) return null;
  return { ...model, hold: legalHold ? LEGAL_HOLD_TEXT : null };
}
