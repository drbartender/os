// The one input gate for a proposal's pricing inputs (guest_count, num_bars, num_bartenders and the
// duration), shared by the admin create, the editor PATCH, the /calculate preview, the quote wizard's
// submit and the portal change request: a value that is present must be a whole number inside sanity
// bounds, and the duration a tenth of an hour the contract column can hold, else a 400 naming the field (audit PRC-05).
'use strict';
// Before this gate the three admin routes read these four inputs raw into
// calculateProposal and the row: a negative guest count priced every per-guest
// line negative (Core Reaction, -100 guests, a champagne toast: -25000 cents
// on a 10000-cent total), a zero or blank guest count on the editor's PATCH
// stored a 0-guest contract with every per-guest line at $0 (the editor sends
// Number('') = 0), a fractional num_bartenders reached the INTEGER column and
// 500ed, and a negative num_bars was stored and carried onto the shifts.
//
// The client entrances run it too (review 2026-11-12): the public quote
// submit (public.js) and the portal change request's preview and create
// (clientPortal/changeRequests.js). Without them a client could store, or
// acknowledge, a value the admin PATCH then refuses (6000 guests typed into
// the wizard, 4.25 hours into the portal), and a client's change request
// could not be applied at all, since the editor PATCH is the only way in.
// The editor's /calculate preview judges against the stored row too, as the
// PATCH does, so a booking already past the bounds still previews.
//
// Pure: a function of the body (and, on the PATCH, the locked row), so on the
// create and the preview it runs before any connection is checked out and a
// malformed body never opens a transaction. It asserts and never coerces: each
// route keeps reading the values the way it did (a numeric string is accepted
// here, as every route's Number() reading accepts it), and an absent or null
// value keeps the route's own default or stored value (`guest_count || 50` on
// create, `?? old.guest_count` on the PATCH, the `/calculate` preview's
// defaults).
//
// On the PATCH the gate takes the locked row (`stored`) and judges only a
// CHANGED value: a body value equal to the stored column passes, the way the
// override guard lets a body repeat a stored value (patchGuards.js). The
// editor re-sends every stored value on every save, so without that a
// booking saved before these bounds (6000 guests, a 30-hour day) could not
// take a date or venue change at all (audit round 2, M2). The create and the
// preview have no stored row and judge every present value.
//
// Bounds: sanity bounds that stop garbage, never a business cap. The editor and
// the create form offer guests to 1000, bars to 5 and the duration to 12 hours
// in half-hour steps (ProposalEditorForm.js, EventSection.js), but a client's
// event can be larger than any form's input hint, and a real 1200-guest lead
// must still be able to send a quote from the wizard (review 2026-11-12: a
// 1000-guest ceiling refused it outright). So the guest bound is 5000, the
// count at which the 1:100 ratio needs MAX_BARTENDERS. The wizard's event step
// and the portal's inputs carry the same 5000 (hand-synced; QuoteWizard.js,
// EventDetailsStep.js, ChangeRequestForm.js). The rest have room for a
// hand-built event, never looser than sane: the duration
// column is NUMERIC(4,1), so a value off the tenths grid would be rounded
// silently on write; MIN_HOURS is contractDuration's own floor, below which a
// contract is corrupt data; the 2:00 AM curfew gate decides what is sellable
// above that and runs after this one.

const { ValidationError } = require('../../utils/errors');
const { MIN_HOURS } = require('../../utils/contractDuration');

const MAX_GUESTS = 5000;    // a sanity bound; mirrored in the wizard's event step and the portal input
const MAX_BARS = 10;        // the forms allow 5
const MAX_BARTENDERS = 50;  // a MAX_GUESTS event at the 1:100 ratio needs 50
const MAX_HOURS = 24;       // a calendar day; the curfew gate is the real ceiling

const present = (v) => v !== undefined && v !== null;
// A number, or a non-blank numeric string, the way the routes' Number() reads
// them; anything else (a boolean, an object, a blank) is NaN and refused.
const asNumber = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
};
const wholeInRange = (v, min, max) => {
  const n = asNumber(v);
  return Number.isInteger(n) && n >= min && n <= max;
};
const onTenths = (n) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-6;

// A body value that repeats the stored column (compared as numbers: the row
// holds NUMERIC strings) is not a change and is not judged.
const sameAsStored = (v, storedValue) => {
  if (storedValue === undefined || storedValue === null) return false;
  const n = asNumber(v);
  return Number.isFinite(n) && n === Number(storedValue);
};

/**
 * 400 naming every field whose present value is out of shape; absent and
 * null pass through to the route's own default or stored value, and on the
 * PATCH a value equal to the stored one passes unjudged.
 *
 * @param {object} body  the request body (the four fields are read by name)
 * @param {{ durationField?: 'event_duration_hours' | 'duration_hours', durationErrorField?: string, stored?: object|null }} [opts]
 *   durationField: which key the route reads the duration from (/calculate
 *   reads duration_hours); durationErrorField: the key its refusal is named
 *   under (default the same; /calculate names event_duration_hours, the field
 *   the editor renders an error on); stored: the proposals row (the locked
 *   one on the PATCH, the booking's own on the preview and the portal)
 */
function assertPricingInputs(body = {}, { durationField = 'event_duration_hours', durationErrorField = durationField, stored = null } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const row = stored && typeof stored === 'object' ? stored : {};
  const duration = durationField === 'duration_hours' ? b.duration_hours : b.event_duration_hours;
  const errors = {};
  if (present(b.guest_count) && !sameAsStored(b.guest_count, row.guest_count) && !wholeInRange(b.guest_count, 1, MAX_GUESTS)) {
    errors.guest_count = `Guest count must be a whole number from 1 to ${MAX_GUESTS}.`;
  }
  if (present(b.num_bars) && !sameAsStored(b.num_bars, row.num_bars) && !wholeInRange(b.num_bars, 0, MAX_BARS)) {
    errors.num_bars = `Bars must be a whole number from 0 to ${MAX_BARS}.`;
  }
  if (present(b.num_bartenders) && !sameAsStored(b.num_bartenders, row.num_bartenders)
      && !wholeInRange(b.num_bartenders, 0, MAX_BARTENDERS)) {
    errors.num_bartenders = `Bartenders must be a whole number from 0 to ${MAX_BARTENDERS}, or left blank to use the guest ratio.`;
  }
  if (present(duration) && !sameAsStored(duration, row.event_duration_hours)) {
    const h = asNumber(duration);
    if (!Number.isFinite(h) || h < MIN_HOURS || h > MAX_HOURS || !onTenths(h)) {
      errors[durationErrorField] = `Duration must be between ${MIN_HOURS} and ${MAX_HOURS} hours, in tenths of an hour.`;
    }
  }
  // The message names what was refused, so a surface that shows only the
  // message (a toast, the wizard's banner, the portal's preview alert) still
  // says what to change.
  if (Object.keys(errors).length > 0) throw new ValidationError(errors, Object.values(errors).join(' '));
}

module.exports = { assertPricingInputs, MAX_GUESTS, MAX_BARS, MAX_BARTENDERS, MAX_HOURS };
