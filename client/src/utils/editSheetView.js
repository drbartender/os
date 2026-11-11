// Pure view-model for the phone edit sheet (lane ma-e3; spec
// 2026-08-13-mobile-admin section 3, "Brainstorm decisions of 2026-10-05";
// benchmark 2026-09-15, Edit details and the edit sheet). No React, no fetch.
// The money lines come from the desktop's own buildRepriceSummary, so both
// surfaces say the same thing from one copy.
import { buildRepriceSummary, BOOKED_STATUSES } from '../pages/admin/proposalEditor/repriceSummary';
import { dollars, setupOf } from './eventDetailView';
import { railParts } from './eventCards';
import { fmtTime24 } from '../components/adminos/format';
import { isQuantityCapable } from './proposalRules';
import { addonRateWords } from './addonRateLabel';
import { HOLD_NOTE, proposalEditable } from './proposalDetailView';

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
// Spec 2026-10-16 section 5.3: a held booking opens read-only, on both editors.
export const LEGAL_HOLD_NOTE = "This booking is on legal hold and can't be edited here.";
// The proposal variant (plan 2026-11-05, lane proposal-edit-sheet): the same
// sheet on a proposal, its copy naming a proposal.
export const PROPOSAL_SHEET_NOTE = 'proposal edit · pickers & steppers';
export const STALE_PROPOSAL = 'This proposal changed since you opened it.';
export const PROPOSAL_LOCKED_NOTE = 'This proposal can no longer be edited here. Use desktop view.';
export const PROPOSAL_SAVE_UNCONFIRMED = 'No connection. It may not have saved; reopen the proposal to check.';
export const ADDONS_DESKTOP_NOTE = 'To add or remove an add-on, use desktop view.';
// The words each variant says, in one place.
export const SHEET_COPY = Object.freeze({
  event: Object.freeze({
    note: SHEET_NOTE, title: 'Event', loading: 'Loading the event',
    loadFailed: "Couldn't load this event. Editing needs a connection.",
    stale: STALE_EVENT, unconfirmed: SAVE_UNCONFIRMED, hold: LEGAL_HOLD_NOTE, saved: 'Event updated.',
  }),
  proposal: Object.freeze({
    note: PROPOSAL_SHEET_NOTE, title: 'Proposal', loading: 'Loading the proposal',
    loadFailed: "Couldn't load this proposal. Editing needs a connection.",
    stale: STALE_PROPOSAL, unconfirmed: PROPOSAL_SAVE_UNCONFIRMED, hold: HOLD_NOTE, saved: 'Proposal updated.',
  }),
});
// Every read the two sheets make, and the read-only preview and preflight,
// give up after this long. On weak signal a request hangs rather than fails,
// and a hung read would show nothing at all. The writes have no timeout: a
// timed-out write can still commit (the pre-save re-read catches a retry: the
// first write moved what the save rests on, sheetBasis below).
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

// The sheet's fresh read can find the event closed since the row was drawn,
// or on legal hold (the admin GET's legal_hold flag).
export function editLockedReason(proposal) {
  if (proposal && proposal.legal_hold === true) return LEGAL_HOLD_NOTE;
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

// The proposal variant's two more values (extra_bartenders, addon_counts) count
// too; the event variant has neither, so they never differ there.
export function fieldsChanged(a, b) {
  if (!a || !b) return false;
  return a.event_date !== b.event_date
    || fmtTime24(a.event_start_time) !== fmtTime24(b.event_start_time)
    || Number(a.event_duration_hours) !== Number(b.event_duration_hours)
    || Number(a.guest_count) !== Number(b.guest_count)
    || Number(a.extra_bartenders || 0) !== Number(b.extra_bartenders || 0)
    || countsDiffer(a.addon_counts, b.addon_counts);
}

function countsDiffer(x, y) {
  const a = x || {};
  const b = y || {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].some((k) => Number(a[k] || 0) !== Number(b[k] || 0));
}

// ---- The proposal variant (spec section 3, Plan decisions of 2026-11-05) ----
//
// Bartenders is the package's bartenders (editorCore.js packageBartendersFor: a
// standing override, else the guest ratio) plus the Additional Bartender
// add-on's count, the desktop's one control for an extra bartender, so the
// money path is the desktop's: the engine charges the add-on at its rate on
// hosted and BYOB packages and at $0 on a class (law 10). Its stepper moves
// only the add-on, 0 to 10. The add-on rows are the count-taking add-ons
// already on the proposal (barback, banquet server, pre-batched mocktail), 1 to
// 10 as on the desktop. Adding or removing an add-on is desktop view. The set of
// rows is fixed when the sheet opens.
export const BARTENDER_ADDON_SLUG = 'additional-bartender';
export const EXTRA_BARTENDERS_MAX = 10;
export const ADDON_COUNT_MIN = 1;
export const ADDON_COUNT_MAX = 10;

// A count on the form: an add-on not on it is 0; one on it with no recovered
// count is 1, as the desktop stepper shows it and the server prices it
// (safeAddonQty).
export function addonCountOf(form, addonId) {
  const ids = ((form && form.addon_ids) || []).map(Number);
  if (!ids.includes(Number(addonId))) return 0;
  const q = Number(((form && form.addon_quantities) || {})[addonId]);
  return Number.isFinite(q) && q >= 1 ? q : 1;
}

// Which extra rows the sheet draws, from its opening read. bartender is null
// when the active catalog has no Additional Bartender or the proposal's package
// is retired (absent from the active catalog); addons are the proposal's own
// count-taking add-ons in catalog order, each with the desktop's rate words.
export function proposalRowsOf(form, packages, catalog) {
  const list = catalog || [];
  const pkg = (packages || []).find((p) => p.id === Number(form && form.package_id));
  const extra = list.find((a) => a && a.slug === BARTENDER_ADDON_SLUG);
  const ids = ((form && form.addon_ids) || []).map(Number);
  return {
    bartender: pkg && extra ? { addonId: extra.id } : null,
    addons: list
      .filter((a) => a && a.slug !== BARTENDER_ADDON_SLUG && isQuantityCapable(a) && ids.includes(Number(a.id)))
      .map((a) => ({ id: a.id, name: a.name, rate: addonRateWords(a) })),
  };
}

// The values the proposal variant opens with: the event variant's four, the
// extra bartenders and each add-on row's count.
export function proposalSheetValuesOf(form, rows) {
  const counts = {};
  ((rows && rows.addons) || []).forEach((a) => { counts[a.id] = addonCountOf(form, a.id); });
  return {
    ...sheetValuesOf(form),
    extra_bartenders: rows && rows.bartender ? addonCountOf(form, rows.bartender.addonId) : 0,
    addon_counts: counts,
  };
}

// The desktop form with the sheet's values in it, for the preview and the
// save: the four fields, each add-on row's count, and the Additional Bartender
// add-on added from the catalog at its first extra and dropped at none. Every
// other add-on, its variant and its count ride as read.
export function proposalFormOf(form, values, rows) {
  const v = values || {};
  const quantities = { ...(form.addon_quantities || {}) };
  let ids = (form.addon_ids || []).slice();
  Object.entries(v.addon_counts || {}).forEach(([id, n]) => {
    if (ids.map(Number).includes(Number(id))) quantities[id] = Number(n);
  });
  if (rows && rows.bartender) {
    const id = rows.bartender.addonId;
    const n = Math.min(EXTRA_BARTENDERS_MAX, Math.max(0, Math.round(Number(v.extra_bartenders) || 0)));
    const present = ids.map(Number).includes(Number(id));
    if (n > 0) {
      if (!present) ids = [...ids, id];
      quantities[id] = n;
    } else if (present) {
      ids = ids.filter((x) => Number(x) !== Number(id));
      delete quantities[id];
    }
  }
  return {
    ...form,
    event_date: v.event_date,
    event_start_time: v.event_start_time,
    event_duration_hours: v.event_duration_hours,
    guest_count: v.guest_count,
    addon_ids: ids,
    addon_quantities: quantities,
  };
}

// A count stepper within its bounds.
export function stepCount(value, dir, min, max) {
  const v = Math.round(Number(value) || 0);
  return Math.min(max, Math.max(min, v + (dir > 0 ? 1 : -1)));
}

// The Bartenders row: the package's count plus the extras; minus stops at the
// package's count (no extras), plus at ten extras.
export function bartenderStepView(packageCount, extra) {
  const base = Number(packageCount) || 0;
  const n = Number(extra) || 0;
  return { shown: base + n, canLess: n > 0, canMore: n < EXTRA_BARTENDERS_MAX };
}

// "was 3" under a count that moved since the sheet opened.
export function countWasLine(was, now) {
  return Number(was) !== Number(now) ? `was ${Number(was)}` : null;
}

// The proposal variant's fresh read: locked unless the detail would open the
// sheet on it (proposalEditable), with the hold said in the detail's words.
export function proposalLockedReason(proposal, todayYmd) {
  if (!proposal || proposal.legal_hold !== false) return HOLD_NOTE;
  return proposalEditable(proposal, todayYmd) ? null : PROPOSAL_LOCKED_NOTE;
}

// What the sheet's save rests on, from one read. The sheet re-reads before every
// save and refuses when this moved since it opened. Never updated_at: every
// UPDATE of the row moves it, a client page view included, so it refused the
// sheet at random (spec 2026-10-16 decision 8, fix round 1). Instead:
//  - `payload`, the PATCH body a sheet opened on this read would send
//    (useEditSheet builds it with the desktop's builders): the event fields,
//    the package, the add-on rows (a Lab session rewrites them), the syrups,
//    the lines and their token, glassware, class options and setup, all of
//    which the save writes back from its open read;
//  - what the readout priced against: total, paid, the netted overpayment and
//    off-contract money, the stored gratuity, the mandate, booked or not;
//  - the extension hours and the lock (archived, completed, legal hold).
// A page view, an admin note, the autopay claim and the like move none of it.
// Fails closed: a read missing what every admin GET carries is null.
const BASIS_REQUIRED = ['status', 'total_price', 'amount_paid', 'guest_count', 'event_duration_hours', 'package_id'];
const basisCents = (n) => (n === null || n === undefined || n === '' ? null : Math.round(Number(n) * 100));
// lockOf: the variant's lock (editLockedReason for an event,
// proposalLockedReason for a proposal), so a proposal that joined an options
// group or left the open statuses since the sheet opened refuses too.
export function sheetBasis(proposal, payload, { lockOf = editLockedReason } = {}) {
  if (!proposal || !payload || BASIS_REQUIRED.some((k) => proposal[k] === undefined)) return null;
  const p = proposal;
  const g = (p.pricing_snapshot && p.pricing_snapshot.gratuity) || {};
  return JSON.stringify({
    payload,
    booked: BOOKED_STATUSES.includes(p.status),
    locked: lockOf(p),
    total: basisCents(p.total_price),
    paid: basisCents(p.amount_paid),
    overpaid: p.overpayment_cents ?? null,
    offContract: p.off_contract_paid_cents ?? null,
    gratuity: [basisCents(g.total), g.rate ?? null, g.tip_jar ?? null],
    floor: p.gratuity_floor_rate ?? null,
    origin: p.gratuity_rate_change_origin ?? null,
    extension: [p.settled_extension_hours ?? null, p.contract_floor_hours ?? null],
  });
}

// True when the save cannot prove nothing it rests on moved.
export function basisMoved(opened, fresh) {
  return !opened || !fresh || opened !== fresh;
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
// The server's two refusals of the lines (spec 2026-10-16 sections 5.1 and
// 5.3) read in the sheet's own words.
// copy: the variant's words (SHEET_COPY), the event's by default.
export function saveErrorText(err, sent = false, copy = SHEET_COPY.event) {
  if (!err || err.status === 0 || err.code === 'NETWORK_ERROR') return sent ? copy.unconfirmed : NO_CONNECTION;
  if (err.code === 'STALE_EDIT') return copy.stale;
  if (err.code === 'LEGAL_HOLD') return copy.hold;
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
