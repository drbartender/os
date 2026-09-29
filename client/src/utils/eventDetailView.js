// Pure view-model for the phone event detail (spec 2026-08-13-mobile-admin
// section 4 Detail, benchmark 2026-09-15). No React, no fetch. Everything the
// screen shows is derived here from the four reads, so the rules are tested
// without rendering.
//
// MONEY. Nothing here computes a price. The lines are the stored pricing
// snapshot, the total and the amount paid are the proposal row, and "balance",
// "paid in full", "overpaid" and the off-platform line follow
// ProposalDetailPaymentPanel, so the phone and the desktop show the same
// figures for one event. What this module cannot know it does not claim: with
// the payment detail unread, a balance is a figure, never a verdict.
import { railParts } from './eventCards';
import { getEventTypeLabel } from './eventTypes';
import { resolveGratuityDisplayLabel } from './gratuityLabels';
import { formatPhone } from './formatPhone';
import { buildShiftView } from './staffingSheet';
import { venueMapQuery } from '../components/VenueAddressFields';
import { fmtTimeRange24, fmtTime24, fmt$2dp, dayDiff, ctDay } from '../components/adminos/format';

const text = (v) => String(v === null || v === undefined ? '' : v).trim();

// An archived proposal is a CANCELLED event only for these reasons (or none on
// file). The others (the date passed, another option was chosen, no hire) are
// archived and were never cancelled.
const CANCEL_REASONS = ['client_cancelled', 'we_cancelled'];
export function closedWord(proposal) {
  const p = proposal || {};
  if (p.status !== 'archived') return null;
  return !p.archive_reason || CANCEL_REASONS.includes(p.archive_reason) ? 'Cancelled' : 'Archived';
}
const ymdOf = (v) => (v ? String(v).slice(0, 10) : null);

// A stored address may carry a query (a@b.co?subject=..&bcc=..) or a second
// recipient, and a mailto: link would open a draft the client wrote. So a link
// is made only for an address of PLAIN SHAPE (one @, a local part of the
// characters RFC 5322 allows unquoted, a dotted domain of letters, digits and
// hyphens), and what is linked is percent-encoded, so an ampersand or a
// percent sign in a real address is an address and nothing else. @ and + are
// left as written: every mail client reads them raw. Anything else is shown
// as text and not linked.
const PLAIN_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
function mailHrefOf(email) {
  if (!email || !PLAIN_ADDRESS.test(email)) return null;
  return `mailto:${encodeURIComponent(email).replace(/%40/g, '@').replace(/%2B/gi, '+')}`;
}

function readJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; }
}

// Signed dollars to the cent, with a true minus sign as the design draws it.
// A value that is not a number renders as zero: the shared formatters answer a
// dash glyph for bad input, and phone copy carries none.
const MINUS = String.fromCharCode(0x2212);
function dollars(n) {
  const num = Number(n);
  if (n === null || n === undefined || n === '' || !Number.isFinite(num)) return fmt$2dp(0);
  return num < 0 ? `${MINUS}${fmt$2dp(Math.abs(num))}` : fmt$2dp(num);
}
const fromCents = (n) => (n === null || n === undefined ? dollars(0) : dollars(Number(n) / 100));

// "AUG 8": uppercase like the rail and the when line. Empty for a bad date.
function monthDay(date) {
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
}
const dayOfYmd = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || '')) ? monthDay(new Date(`${ymd}T12:00:00`)) : '');
const dayOfInstant = (iso) => (iso ? monthDay(new Date(iso)) : '');

export function headerOf(proposal) {
  const p = proposal || {};
  const venue = text(p.event_location);
  // Same rule as AddressLink: geocode the street address, not the venue name.
  const query = venue ? (venueMapQuery(p) || venue) : '';
  return {
    title: text(p.client_name) || 'Event',
    kind: getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom }),
    guests: p.guest_count === null || p.guest_count === undefined ? null : Number(p.guest_count),
    venue,
    mapHref: query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : null,
  };
}

export function whenOf(proposal, { todayYmd } = {}) {
  const p = proposal || {};
  const ymd = ymdOf(p.event_date);
  const rail = ymd ? railParts(ymd) : null;
  const dated = !!(rail && rail.day);
  // Today is the BUSINESS day, Chicago's, whatever zone the phone is in: a
  // phone on Eastern time would otherwise drop "Today" an hour before the
  // event night ends.
  const today = todayYmd || ctDay(new Date());
  const thisYear = String(today).slice(0, 4);
  const date = dated
    ? `${rail.dow} ${rail.mon} ${rail.day}${ymd.slice(0, 4) !== thisYear ? ` ${ymd.slice(0, 4)}` : ''}`
    : '';
  const range = p.event_start_time ? fmtTimeRange24(p.event_start_time, null, p.event_duration_hours) : '';
  return {
    text: [date, range].filter(Boolean).join(' · '),
    // `dated`, not `ymd`: dayDiff answers 0 for a date it cannot read.
    isToday: dated && dayDiff(ymd, today) === 0,
  };
}

const minutesOf = (clock) => {
  const m = /^(\d{2}):(\d{2})$/.exec(fmtTime24(clock));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// The clock time is the server's (setup_time_display). The gap is read back
// from the two clock times instead of re-deriving the default minutes here:
// the hosted-versus-not rule lives on the server and must not grow a twin.
export function setupOf(proposal) {
  const p = proposal || {};
  const at = text(p.setup_time_display);
  if (!at) return null;
  const start = minutesOf(p.event_start_time);
  const setup = minutesOf(at);
  if (start === null || setup === null) return `from ${at}`;
  const gap = (((start - setup) % 1440) + 1440) % 1440;
  return gap ? `from ${at} · ${gap} min before` : `from ${at}`;
}

// A link only for a number a phone can dial as written: ten digits, eleven
// with a leading 1, or an international number that opens with +. Anything
// else (an extension, two numbers in one field, letters) is shown as stored,
// with no link: "1-800-FLOWERS" stripped to its digits dials 1800.
function dialable(raw) {
  const stored = text(raw);
  if (!/^[\d\s().+-]+$/.test(stored)) return null;
  const digits = stored.replace(/\D/g, '');
  if (stored.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return digits;
  return digits.length === 11 && digits.startsWith('1') ? digits : null;
}
function phoneOf(raw) {
  const stored = text(raw);
  const dial = dialable(raw);
  // A number that opens with + is shown as stored unless it is +1 and ten
  // digits: "+2125550142" dials Morocco, and must not read "(212) 555-0142".
  const american = !!dial && (!dial.startsWith('+') || /^\+1\d{10}$/.test(dial));
  return {
    phone: american ? formatPhone(dial.replace('+', '')) : stored,
    telHref: dial ? `tel:${dial}` : null,
    smsHref: dial ? `sms:${dial}` : null,
  };
}

// `dayOf` is the body of GET /drink-plans/by-proposal/:id?fields=day_of_contact,
// `{ day_of_contact: { name, phone } | null }`. The phone never reads the full
// drink plan: that payload carries the plan's token, the internal notes and
// the venue access notes, and none of it may sit in the phone's cache.
export function contactsOf(proposal, dayOf) {
  const p = proposal || {};
  const raw = dayOf && typeof dayOf === 'object' ? dayOf.day_of_contact : null;
  const name = text(raw && raw.name);
  const dayOfPhone = text(raw && raw.phone);
  const email = text(p.client_email);
  return {
    summary: name ? 'day-of set' : 'day-of pending',
    client: {
      ...phoneOf(p.client_phone),
      email,
      mailHref: mailHrefOf(email),
    },
    dayOf: name ? { name, ...phoneOf(dayOfPhone) } : null,
  };
}

// One group per shift. A head shows only when the event has more than one
// shift; it tells shifts apart by start time and roles, and by date when the
// event spans more than one day.
export function staffingOf(shifts, proposal) {
  const list = Array.isArray(shifts) ? shifts : [];
  const status = proposal ? proposal.status : undefined;
  const views = list.map((s) => buildShiftView({ ...s, proposal_status: status ?? s.proposal_status }, s.requesters));
  const days = new Set(list.map((s) => ymdOf(s.event_date)).filter(Boolean));
  const groups = list.map((s, i) => {
    const ymd = ymdOf(s.event_date);
    const rail = ymd ? railParts(ymd) : null;
    const parts = [
      days.size > 1 && rail && rail.day ? `${rail.dow} ${rail.mon} ${rail.day}` : null,
      fmtTime24(s.start_time) || null,
      views[i].rolesLabel,
    ].filter(Boolean);
    return { shiftId: s.id, showHead: list.length > 1, label: parts.join(' · '), view: views[i] };
  });
  // A cancelled shift's slots are nobody's to fill: they leave the head's sum,
  // as that shift's own fraction is hidden.
  const live = views.filter((v) => v.closedReason !== 'cancelled');
  const slots = live.reduce((sum, v) => sum + v.slots, 0);
  const filled = live.reduce((sum, v) => sum + v.filled, 0);
  const closed = views.length > 0 && views.every((v) => !!v.closedReason);
  const cancelled = views.length > 0 && views.every((v) => v.closedReason === 'cancelled');
  let state = 'open';
  if (closed) state = 'closed';
  else if (views.length > 0 && filled >= slots) state = 'full';
  return { groups, count: views.length === 0 || cancelled ? '' : `${filled}/${slots}`, state };
}

const PAID_STATUSES = ['balance_paid', 'confirmed', 'completed'];

export function financialsOf(proposal, invoicesPayload) {
  const p = proposal || {};
  const total = Number(p.total_price || 0);
  const paid = Number(p.amount_paid || 0);
  const owed = total - paid;

  const snapshot = readJson(p.pricing_snapshot);
  const breakdown = snapshot && Array.isArray(snapshot.breakdown) ? snapshot.breakdown : [];
  const lines = breakdown.length
    ? breakdown.map((b) => ({ label: resolveGratuityDisplayLabel(b.label, snapshot), amount: dollars(b.amount) }))
    : [{ label: text(p.package_name) || 'Package', amount: dollars(total) }];

  const payload = invoicesPayload && typeof invoicesPayload === 'object' ? invoicesPayload : null;
  const invoices = payload && Array.isArray(payload.invoices) ? payload.invoices : null;
  // Money taken outside any invoice (collected in CheckCherry before the move)
  // is counted in amount_paid and sits on no invoice. Without its own row the
  // list would read "No payments yet." for a client who has paid.
  const external = Number(p.external_paid);
  const offPlatform = Number.isFinite(external) && external > 0
    ? [{ key: 'ext', label: 'Off-platform', sub: 'collected in CheckCherry', amount: dollars(external) }]
    : [];
  // null, not []: "the payment detail could not be read" must never render as
  // "no payments were made".
  const payments = invoices
    ? offPlatform.concat(invoices
      .filter((i) => i.status !== 'void' && Number(i.amount_paid) > 0)
      .map((i) => {
        const got = Number(i.amount_paid);
        const due = Number(i.amount_due);
        return {
          key: `i${i.id}`,
          label: text(i.label) || text(i.invoice_number) || 'Payment',
          sub: got >= due ? 'paid' : `part paid · ${fromCents(got)} of ${fromCents(due)}`,
          amount: fromCents(got),
        };
      }))
    : null;

  // The bank debit in flight (spec 2026-09-14): money that has left the
  // client's hands and has not settled. Four to six days for an ACH.
  const pending = payload && Array.isArray(payload.pending_payments)
    ? payload.pending_payments.map((pp, i) => {
      const started = dayOfInstant(pp.started_at);
      return {
        key: `p${i}`,
        label: 'Bank payment processing',
        sub: [started ? `started ${started}` : null, text(pp.invoice_number) || null].filter(Boolean).join(' · '),
        amount: fromCents(pp.amount_cents),
      };
    })
    : [];

  // The rows are a detail; the proposal row is the truth. Where they do not add
  // up to what was paid (money recorded before invoices existed), the total is
  // stated on its own row, and "no payments" is said only when nothing was paid.
  const listed = invoices
    ? (offPlatform.length ? external : 0) + invoices
      .filter((i) => i.status !== 'void' && Number(i.amount_paid) > 0)
      .reduce((sum, i) => sum + Number(i.amount_paid), 0) / 100
    : null;
  const unlisted = listed !== null && paid - listed > 0.005;

  const archived = p.status === 'archived';
  const paidInFull = PAID_STATUSES.includes(p.status) && owed <= 0;
  const inFlight = pending.length > 0;
  // Whether a bank debit is in flight is only known once the invoices read
  // has been read. Until then a balance is a figure, not "due".
  const known = invoices !== null;
  // Server-derived and netted (spec 2026-09-15), never paid minus total.
  const over = Number(p.overpayment_cents);
  // Shown on a cancelled event too: cancel leaves total_price as it was and the
  // retainer sits inside it, so this is money beyond the whole contract, owed back.
  // The desktop panel's own rule: money that came through Stripe can be
  // refunded there; money taken outside it has to be returned by hand.
  const refundable = Number(p.max_overpayment_refundable_cents) > 0;
  const overpaid = Number.isFinite(over) && over > 0
    ? { amount: fromCents(over), sub: refundable ? 'refund it from desktop view' : 'return it by hand' }
    : null;
  const due = dayOfYmd(ymdOf(p.balance_due_date));
  const dueText = due ? `due ${due}` : 'due date not set';

  let chip;
  if (archived) chip = { kind: 'neutral', label: closedWord(p) };
  else if (inFlight) chip = { kind: 'info', label: 'Processing' };
  else if (overpaid) chip = { kind: 'warn', label: 'Overpaid' };
  else if (paidInFull) chip = { kind: 'ok', label: 'Paid' };
  else if (owed > 0) chip = known ? { kind: 'warn', label: 'Balance due' } : null;
  else chip = { kind: 'neutral', label: 'No balance' };

  let balanceSub = dueText;
  if (inFlight) balanceSub = `${dueText} · bank payment in flight`;
  else if (!known) balanceSub = `${dueText} · payment detail not loaded`;

  return {
    lines,
    total: dollars(total),
    payments,
    pending,
    paidToDate: dollars(paid),
    showPaidToDate: payments === null || unlisted,
    noPayments: payments !== null && payments.length === 0 && pending.length === 0 && !(paid > 0),
    paidInFull,
    overpaid,
    // A cancelled event owes nothing on a date: cancel leaves total_price as
    // it was, and "due AUG 8" under a Cancelled chip would be a false claim.
    balance: owed > 0 && !archived
      ? { label: known ? 'Balance due' : 'Balance', amount: dollars(owed), sub: balanceSub, inFlight }
      : null,
    chip,
  };
}

// The detail makes four reads; any of them may have been served from cache.
// The staleness line reports the oldest, because that is how old the least
// fresh thing on screen is.
export function earliestStale(...stamps) {
  const times = stamps
    .filter(Boolean)
    .map((s) => ({ s, t: new Date(s).getTime() }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  return times.length ? times[0].s : null;
}
