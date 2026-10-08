// Pure view-model for the phone edit sheet (lane ma-e3; spec
// 2026-08-13-mobile-admin section 3, "Brainstorm decisions of 2026-10-05";
// benchmark 2026-09-15, Edit details and the edit sheet). No React, no fetch.
// The money lines come from the desktop's own buildRepriceSummary, so both
// surfaces say the same thing from one copy.
import { buildRepriceSummary, BOOKED_STATUSES } from '../pages/admin/proposalEditor/repriceSummary';
import { dollars, setupOf } from './eventDetailView';
import { railParts } from './eventCards';
import { fmtTime24 } from '../components/adminos/format';

export const HOURS_MIN = 1;
export const HOURS_MAX = 12;
export const GUESTS_MIN = 1;
export const GUESTS_MAX = 1000;
export const START_MIN = '06:00';
export const START_MAX = '23:30';
export const SHEET_NOTE = 'event edit · reprices the booking';
export const STALE_EVENT = 'This event changed since you opened it.';
export const PREVIEW_FAILED = "Couldn't price the change.";
export const NO_CONNECTION = "No connection, didn't save.";
// A write that got no answer may still have landed: only a failure before the
// write was sent is a definite "didn't save".
export const SAVE_UNCONFIRMED = 'No connection. It may not have saved; reopen the event to check.';
export const LOCKED_NOTE = 'This event can no longer be edited here. Use desktop view.';
// Every read the two sheets make, and the read-only preview and preflight,
// give up after this long. On weak signal a request hangs rather than fails,
// and a hung read would show nothing at all. The writes have no timeout: a
// timed-out write can still commit (the updated_at re-read catches a retry).
export const READ_TIMEOUT_MS = 10000;
const GENERIC = 'Something went wrong. Try again.';
const CURFEW_DEFAULT = 'This booking runs past our 2:00 AM service curfew.';
// A figure not yet known, as the design pass draws it (2026-10-06): three middle dots.
export const PENDING_FIGURE = String.fromCharCode(0xb7).repeat(3);
// The second line after a change, before its figure.
export const BALANCE_BECOMES = 'balance due becomes';
// Under the curfew sentence when "Book it anyway" resends a notice the screen no longer shows.
export const RIDES_CLIENT = 'Your update to the client goes out with it.';
export const RIDES_BOTH = 'Your update to the client and the assigned staff goes out with it.';
export const RIDES_STAFF = 'Your update to the assigned staff goes out with it.';

// Half hours (Dallas, 2026-10-05: the half hours must be visible). A stored
// off-grid value (4.25) lands on the grid on its first step.
export function stepHours(value, dir) {
  const v = Number(value) || 0;
  const next = dir > 0 ? Math.floor(v * 2) / 2 + 0.5 : Math.ceil(v * 2) / 2 - 0.5;
  return Math.min(HOURS_MAX, Math.max(HOURS_MIN, next));
}

// Fives, landing on multiples of five, so 137 steps to 140 or 135.
export function stepGuests(value, dir) {
  const v = Math.round(Number(value) || 0);
  const next = dir > 0 ? Math.floor(v / 5) * 5 + 5 : Math.ceil(v / 5) * 5 - 5;
  return Math.min(GUESTS_MAX, Math.max(GUESTS_MIN, next));
}

// A stored value past a bound (worked hours after an extension) must not let "+" lower it or "-" raise it.
export function canStep(value, dir, step) {
  const v = Number(value) || 0;
  const next = step(value, dir);
  return dir > 0 ? next > v : next < v;
}

export const fmtHours = (value) => `${String(Number(value))} hr`;

const minutesOf = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const hhmmOf = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

// The desktop editor's start picker runs 06:00 through 23:30 (TimePicker,
// minHour 6, maxHour 23, last slot :30).
export function clampStart(value) {
  const mins = minutesOf(String(value || '').slice(0, 5));
  if (mins === null) return null;
  return hhmmOf(Math.min(minutesOf(START_MAX), Math.max(minutesOf(START_MIN), mins)));
}

// The native time input takes HH:MM. Stored start times come in several
// shapes ("7:00 PM" from server-side creation, "18:00" from the editor).
export function startInputValue(value) {
  const t = fmtTime24(value);
  return /^\d{2}:\d{2}$/.test(t) ? t : '';
}

// The value the form takes for a picked time. Picking the time the event
// already has keeps the stored value as stored, so an unchanged time is never
// sent in a new shape (which would read as a reschedule).
export function nextStartValue(picked, initialRaw) {
  const clamped = clampStart(picked);
  if (!clamped) return null;
  return clamped === startInputValue(initialRaw) ? initialRaw : clamped;
}

// A real date, today (Chicago) or later. Moving an upcoming event into the
// past is a desktop job.
export function nextDateValue(picked, todayYmd) {
  const ymd = String(picked || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return ymd >= todayYmd ? ymd : null;
}

// "SAT AUG 15", the rail's words, with the year when it is not this one.
export function sheetDateText(ymd, todayYmd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return '';
  const r = railParts(ymd);
  if (!r.day) return '';
  const year = ymd.slice(0, 4) !== String(todayYmd || '').slice(0, 4) ? ` ${ymd.slice(0, 4)}` : '';
  return `${r.dow} ${r.mon} ${r.day}${year}`;
}

// "45 min before", from the detail's own setup line (setupOf).
export function setupMinutesText(proposal) {
  const line = setupOf(proposal);
  if (!line) return '';
  const at = line.indexOf(' · ');
  return at >= 0 ? line.slice(at + 3) : line;
}

// The desktop editor's hint, word for word (ProposalEditorForm, Duration).
export function extensionHint(proposal, hours) {
  const settled = Number(proposal?.settled_extension_hours) || 0;
  if (!(settled > 0)) return null;
  const contract = Math.max(Number(proposal.contract_floor_hours) || 0, (Number(hours) || 0) - settled);
  return `Includes ${settled}h of on-site extension, billed on its own invoice. The contract prices ${contract}h.`;
}

// The save moves a shift with the event only when the event has exactly one
// (eventCreation.js syncShiftsFromProposal).
export function multiShiftNote(count) {
  return count > 1
    ? `This event has ${count} shifts. Changing the date or time here does not move them; each shift is edited from desktop view.`
    : null;
}

// Upcoming and live (spec section 3, 2026-10-05). The server knows a shift's
// end instant (`finished`); without a roster, the event's date against
// Chicago's today stands in for it.
export function editableEvent(proposal, shifts, todayYmd) {
  const p = proposal || {};
  if (p.status === 'archived' || p.status === 'completed') return false;
  if (shifts && shifts.state === 'ready' && Array.isArray(shifts.rows) && shifts.rows.length > 0) {
    return shifts.rows.some((s) => s.status !== 'cancelled' && !s.finished);
  }
  const ymd = String(p.event_date || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) && ymd >= todayYmd;
}

// The sheet's fresh read can find the event closed since the row was drawn.
export function editLockedReason(proposal) {
  const s = proposal && proposal.status;
  return s === 'archived' || s === 'completed' ? LOCKED_NOTE : null;
}

// The four fields the sheet edits, out of the desktop form.
export function sheetValuesOf(form) {
  return {
    event_date: form.event_date,
    event_start_time: form.event_start_time,
    event_duration_hours: Number(form.event_duration_hours),
    guest_count: Number(form.guest_count),
  };
}

export function fieldsChanged(a, b) {
  if (!a || !b) return false;
  return a.event_date !== b.event_date
    || fmtTime24(a.event_start_time) !== fmtTime24(b.event_start_time)
    || Number(a.event_duration_hours) !== Number(b.event_duration_hours)
    || Number(a.guest_count) !== Number(b.guest_count);
}

// updated_at moves on every UPDATE of the row (schema.sql trigger
// update_proposals_updated_at), so any write since the sheet opened shows here.
// Fails closed: a read that lacks updated_at (on either side) counts as moved,
// so a narrowed GET can never switch the guard off.
export function changedSinceOpen(openedAt, fresh) {
  const now = fresh && fresh.updated_at;
  if (!openedAt || !now) return true;
  return String(now) !== String(openedAt);
}

// What the sheet shows under the steppers. Nothing until a field changed: an
// untouched sheet closes with "Done" and sends nothing, even when today's
// catalog would price the event differently.
export function confirmView({ proposal, preview, changed }) {
  const p = proposal || {};
  const oldNum = Number(p.total_price) || 0;
  const none = { repriced: false, oldTotal: dollars(oldNum), newTotal: dollars(oldNum), balanceLine: null, lines: [], button: 'Done' };
  if (!changed || !preview) return none;
  const newNum = Number(preview.total);
  if (!Number.isFinite(newNum) || Math.abs(newNum - oldNum) < 0.005) return none;
  const booked = BOOKED_STATUSES.includes(p.status);
  const summary = buildRepriceSummary({
    status: p.status,
    totalPrice: p.total_price,
    amountPaid: p.amount_paid,
    newTotal: newNum,
    offContractPaidCents: p.off_contract_paid_cents,
    gratuityOrigin: p.gratuity_rate_change_origin,
    oldGratuityTotal: p.pricing_snapshot && p.pricing_snapshot.gratuity ? p.pricing_snapshot.gratuity.total : null,
    newGratuityTotal: preview.gratuityTotal,
  });
  // The balance is the shared summary's, so both surfaces keep one copy of it.
  const known = summary && !summary.unknown;
  return {
    repriced: true,
    oldTotal: dollars(oldNum),
    newTotal: dollars(newNum),
    balanceLine: booked && known ? `${BALANCE_BECOMES} ${dollars(Math.max(0, Number(summary.newBalance) || 0))}` : null,
    lines: known ? summary.lines : [],
    button: 'Confirm new total',
  };
}

// The block as it stands while a newer figure is on its way, or failed: the
// last figure that landed stays on screen, marked stale (Confirm is disabled
// until the new one lands). Before any figure describes a change, it shows the
// stored total and three dots. So the block never leaves under the finger.
export function confirmViewNow({ proposal, preview, shown, changed }) {
  if (preview && preview.state === 'ready') return confirmView({ proposal, preview, changed });
  if (!changed) return confirmView({ proposal, preview: null, changed });
  const last = confirmView({ proposal, preview: shown, changed });
  if (last.repriced) return { ...last, stale: true };
  return { ...last, repriced: true, stale: true, pending: true, newTotal: PENDING_FIGURE, button: 'Confirm new total' };
}

// The readout's two top lines and its lines (design pass 2026-10-06, "readout
// above, controls pinned"). Untouched, or after a change that leaves the total
// where it was: the booking as it stands, from the event row. After a change
// that reprices: "New total", old and new, the balance it becomes, and the
// reprice lines. While the next figure is on its way the last one stays,
// dimmed, under PRICING; before any figure describes the change, three dots
// (pending). Paid is amount_paid and the balance the total less paid, floored
// at zero: the basis of the shared summary's newBalance and of the detail's
// Financials, so the three agree; an overpaid row reads the server's netted
// overpayment_cents, as the detail's Financials does; a bank debit in flight,
// which only the detail's invoices read knows (inFlight), outranks both, as it
// does on the detail's chip, and is said on any row the detail marks in
// flight, booked or not; the balance and overpaid lines are booked-only.
export function readoutView({ proposal, preview, shown, changed, inFlight = false }) {
  const p = proposal || {};
  const v = confirmViewNow({ proposal: p, preview, shown, changed });
  const booked = BOOKED_STATUSES.includes(p.status);
  if (!v.repriced) {
    const total = Number(p.total_price) || 0;
    const paid = Number(p.amount_paid) || 0;
    const over = Number(p.overpayment_cents) || 0;
    let sub = null;
    if (inFlight) sub = `paid ${dollars(paid)} · bank payment in flight`;
    else if (booked && over > 0) sub = `paid ${dollars(paid)} · overpaid ${dollars(over / 100)}`;
    else if (booked) sub = `paid ${dollars(paid)} · balance due ${dollars(Math.max(0, total - paid))}`;
    return { label: 'Total', old: null, now: dollars(total), sub, pricing: false, dim: false, pending: false, lines: [], button: v.button };
  }
  const pending = !!v.pending;
  return {
    label: 'New total',
    old: v.oldTotal,
    now: v.newTotal,
    sub: pending ? (booked ? `${BALANCE_BECOMES} ${PENDING_FIGURE}` : null) : v.balanceLine,
    pricing: !!changed && !!preview && preview.state === 'loading',
    dim: !!v.stale && !pending,
    pending,
    lines: v.lines,
    button: v.button,
  };
}

// What a changed field held when the sheet opened ("was 3 hr", design pass
// 2026-10-06), drawn under its label inside the row. Null for a field that has
// not changed, or one whose stored value cannot be read.
export function wasLine(field, initial, now, todayYmd) {
  if (!initial || !now) return null;
  const a = initial[field];
  const b = now[field];
  let was = '';
  if (field === 'event_date') was = a !== b ? sheetDateText(a, todayYmd) : '';
  else if (field === 'event_start_time') was = fmtTime24(a) !== fmtTime24(b) ? startInputValue(a) : '';
  else if (field === 'event_duration_hours') was = Number(a) !== Number(b) ? fmtHours(a) : '';
  else if (field === 'guest_count') was = Number(a) !== Number(b) ? String(Number(a)) : '';
  return was ? `was ${was}` : null;
}

// The line under Start: what it was, once changed, then the setup ("setup 45
// min before"; "setup from 17:15" when the stored start cannot be read).
export function startSubLine(proposal, initial, now) {
  const setup = setupMinutesText(proposal);
  return [wasLine('event_start_time', initial, now), setup ? `setup ${setup}` : null].filter(Boolean).join(' · ') || null;
}

// The line under the curfew sentence when the held retry still carries a
// client notice or a staff send (the staff go only with a channel ticked, as
// the server's runRescheduleStaffHooks requires).
export function curfewRidesLine(notify, staff) {
  const client = Array.isArray(notify) && notify.length > 0;
  const crew = !!(staff && staff.enabled && (staff.sms || staff.email));
  if (client && crew) return RIDES_BOTH;
  if (client) return RIDES_CLIENT;
  if (crew) return RIDES_STAFF;
  return null;
}

// A refusal's reason lives in fieldErrors; the message of a ValidationError
// is the generic "Please fix the errors below". sent: the write itself went
// out, so no answer means it may have landed.
export function saveErrorText(err, sent = false) {
  if (!err || err.status === 0 || err.code === 'NETWORK_ERROR') return sent ? SAVE_UNCONFIRMED : NO_CONNECTION;
  const texts = Object.entries(err.fieldErrors || {})
    .filter(([k, v]) => k !== 'past_curfew' && typeof v === 'string' && v.trim())
    .map(([, v]) => v);
  return texts.length ? texts.join(' ') : (err.message || GENERIC);
}

// The past_curfew refusal (crud.js curfew gate): its reason rides on
// event_duration_hours.
export function curfewReason(err) {
  const fe = (err && err.fieldErrors) || {};
  if (!fe.past_curfew) return null;
  return fe.event_duration_hours || CURFEW_DEFAULT;
}

export function noteFirstLine(note) {
  return String(note || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
}
