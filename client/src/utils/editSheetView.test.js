import '@testing-library/jest-dom';
import {
  stepHours, stepGuests, canStep, fmtHours, clampStart, startInputValue, nextStartValue, nextDateValue,
  sheetDateText, setupMinutesText, extensionHint, multiShiftNote, editableEvent, editLockedReason,
  sheetValuesOf, fieldsChanged, changedSinceOpen, confirmView, saveErrorText, curfewReason, noteFirstLine,
  confirmViewNow, curfewRidesLine, NO_CONNECTION, SAVE_UNCONFIRMED, LOCKED_NOTE, READ_TIMEOUT_MS,
  readoutView, wasLine, startSubLine, PENDING_FIGURE,
} from './editSheetView';
import { buildRepriceSummary } from '../pages/admin/proposalEditor/repriceSummary';

// The shared summary runs for real everywhere here; one test swaps in its own
// figure to prove the balance line reads the summary instead of a copy.
jest.mock('../pages/admin/proposalEditor/repriceSummary', () => {
  const actual = jest.requireActual('../pages/admin/proposalEditor/repriceSummary');
  return { ...actual, buildRepriceSummary: jest.fn() };
});
const realSummary = jest.requireActual('../pages/admin/proposalEditor/repriceSummary').buildRepriceSummary;
beforeEach(() => { buildRepriceSummary.mockImplementation(realSummary); });

describe('steppers', () => {
  test('duration moves in half hours, snapping an off-grid value, from 1 to 12', () => {
    expect(stepHours(4, 1)).toBe(4.5);
    expect(stepHours(4, -1)).toBe(3.5);
    expect(stepHours(4.25, 1)).toBe(4.5);
    expect(stepHours(4.25, -1)).toBe(4);
    expect(stepHours(1, -1)).toBe(1);
    expect(stepHours(12, 1)).toBe(12);
    expect(stepHours('5.5', 1)).toBe(6);
  });
  test('guests move in fives, landing on multiples of five, from 1 to 1000', () => {
    expect(stepGuests(140, 1)).toBe(145);
    expect(stepGuests(140, -1)).toBe(135);
    expect(stepGuests(137, 1)).toBe(140);
    expect(stepGuests(137, -1)).toBe(135);
    expect(stepGuests(1, 1)).toBe(5);
    expect(stepGuests(5, -1)).toBe(1);
    expect(stepGuests(1, -1)).toBe(1);
    expect(stepGuests(1000, 1)).toBe(1000);
  });
  test('canStep is false at a floor or a ceiling', () => {
    expect(canStep(1, -1, stepHours)).toBe(false);
    expect(canStep(12, 1, stepHours)).toBe(false);
    expect(canStep(4, 1, stepHours)).toBe(true);
    expect(canStep(1, -1, stepGuests)).toBe(false);
  });
  test('canStep never lets a button move the value the wrong way from outside the range', () => {
    expect(canStep(13, 1, stepHours)).toBe(false);
    expect(canStep(13, -1, stepHours)).toBe(true);
    expect(stepHours(13, -1)).toBe(12);
    expect(canStep(1200, 1, stepGuests)).toBe(false);
    expect(canStep(1200, -1, stepGuests)).toBe(true);
    expect(stepGuests(1200, -1)).toBe(1000);
    expect(canStep(0, -1, stepGuests)).toBe(false);
    expect(canStep(0, 1, stepGuests)).toBe(true);
  });
  test('fmtHours shows the half hour', () => {
    expect(fmtHours(4)).toBe('4 hr');
    expect(fmtHours(4.5)).toBe('4.5 hr');
    expect(fmtHours('5.0')).toBe('5 hr');
  });
});

describe('start time', () => {
  test('clampStart holds 06:00 to 23:30, as the desktop picker does', () => {
    expect(clampStart('05:15')).toBe('06:00');
    expect(clampStart('23:45')).toBe('23:30');
    expect(clampStart('19:05')).toBe('19:05');
    expect(clampStart('19:05:00')).toBe('19:05');
    expect(clampStart('nonsense')).toBeNull();
  });
  test('startInputValue reads any stored shape as HH:MM, or blank', () => {
    expect(startInputValue('7:00 PM')).toBe('19:00');
    expect(startInputValue('7:00 AM')).toBe('07:00');
    expect(startInputValue('18:00')).toBe('18:00');
    expect(startInputValue('')).toBe('');
    expect(startInputValue('evening')).toBe('');
  });
  test('nextStartValue keeps the stored value for the same time', () => {
    expect(nextStartValue('19:00', '7:00 PM')).toBe('7:00 PM');
    expect(nextStartValue('19:30', '7:00 PM')).toBe('19:30');
    expect(nextStartValue('04:00', '7:00 PM')).toBe('06:00');
    expect(nextStartValue('', '7:00 PM')).toBeNull();
  });
});

test('nextDateValue takes a real date from today on, and nothing earlier', () => {
  expect(nextDateValue('2026-10-06', '2026-10-05')).toBe('2026-10-06');
  expect(nextDateValue('2026-10-05', '2026-10-05')).toBe('2026-10-05');
  expect(nextDateValue('2026-10-04', '2026-10-05')).toBeNull();
  expect(nextDateValue('', '2026-10-05')).toBeNull();
});

test('sheetDateText is the rail date, with the year outside the current one', () => {
  expect(sheetDateText('2026-08-15', '2026-03-01')).toBe('SAT AUG 15');
  expect(sheetDateText('2027-01-09', '2026-03-01')).toBe('SAT JAN 09 2027');
  expect(sheetDateText('', '2026-03-01')).toBe('');
});

test('setupMinutesText keeps the minutes before, from the detail setup line', () => {
  expect(setupMinutesText({ setup_time_display: '17:15', event_start_time: '18:00' })).toBe('45 min before');
  expect(setupMinutesText({ setup_time_display: '17:15', event_start_time: 'later' })).toBe('from 17:15');
  expect(setupMinutesText({})).toBe('');
});

test('extensionHint is the desktop line, only after a settled extension', () => {
  expect(extensionHint({ settled_extension_hours: 1, contract_floor_hours: 3 }, 5))
    .toBe('Includes 1h of on-site extension, billed on its own invoice. The contract prices 4h.');
  expect(extensionHint({ settled_extension_hours: 1, contract_floor_hours: 4 }, 4.5))
    .toBe('Includes 1h of on-site extension, billed on its own invoice. The contract prices 4h.');
  expect(extensionHint({ settled_extension_hours: 0 }, 5)).toBeNull();
});

test('multiShiftNote speaks only for more than one shift', () => {
  expect(multiShiftNote(2)).toBe('This event has 2 shifts. Changing the date or time here does not move them; each shift is edited from desktop view.');
  expect(multiShiftNote(1)).toBeNull();
  expect(multiShiftNote(0)).toBeNull();
});

describe('which events the phone edits', () => {
  const live = { status: 'deposit_paid', event_date: '2026-10-10T00:00:00.000Z' };
  test('archived and completed never', () => {
    expect(editableEvent({ ...live, status: 'archived' }, null, '2026-10-05')).toBe(false);
    expect(editableEvent({ ...live, status: 'completed' }, null, '2026-10-05')).toBe(false);
  });
  test('with a roster, a shift not yet finished decides', () => {
    expect(editableEvent(live, { state: 'ready', rows: [{ status: 'open', finished: true }] }, '2026-10-05')).toBe(false);
    expect(editableEvent(live, { state: 'ready', rows: [{ status: 'open', finished: true }, { status: 'open', finished: false }] }, '2026-10-05')).toBe(true);
    expect(editableEvent(live, { state: 'ready', rows: [{ status: 'cancelled', finished: false }] }, '2026-10-05')).toBe(false);
  });
  test('without a roster, the Chicago date decides', () => {
    expect(editableEvent(live, { state: 'loading', rows: [] }, '2026-10-05')).toBe(true);
    expect(editableEvent(live, { state: 'ready', rows: [] }, '2026-10-11')).toBe(false);
    expect(editableEvent({ ...live, event_date: null }, null, '2026-10-05')).toBe(false);
  });
  test('editLockedReason: a fresh read that went archived or completed', () => {
    expect(editLockedReason({ status: 'archived' })).toBe(LOCKED_NOTE);
    expect(editLockedReason({ status: 'completed' })).toBe(LOCKED_NOTE);
    expect(editLockedReason({ status: 'balance_paid' })).toBeNull();
  });
});

test('sheetValuesOf and fieldsChanged compare what the sheet edits', () => {
  const v = sheetValuesOf({ event_date: '2026-10-10', event_start_time: '7:00 PM', event_duration_hours: '5', guest_count: '140', venue_name: 'x' });
  expect(v).toEqual({ event_date: '2026-10-10', event_start_time: '7:00 PM', event_duration_hours: 5, guest_count: 140 });
  expect(fieldsChanged(v, { ...v })).toBe(false);
  expect(fieldsChanged(v, { ...v, event_start_time: '19:00' })).toBe(false);
  expect(fieldsChanged(v, { ...v, event_start_time: '19:30' })).toBe(true);
  expect(fieldsChanged(v, { ...v, event_duration_hours: 5.5 })).toBe(true);
  expect(fieldsChanged(v, { ...v, guest_count: 145 })).toBe(true);
  expect(fieldsChanged(v, { ...v, event_date: '2026-10-11' })).toBe(true);
});

test('changedSinceOpen compares updated_at as stored', () => {
  expect(changedSinceOpen('2026-10-01T10:00:00.000Z', { updated_at: '2026-10-01T10:00:00.000Z' })).toBe(false);
  expect(changedSinceOpen('2026-10-01T10:00:00.000Z', { updated_at: '2026-10-01T10:05:00.000Z' })).toBe(true);
});

// S-M2: a read that lacks updated_at on either side cannot prove nothing moved.
test('changedSinceOpen fails closed when either side has no updated_at', () => {
  expect(changedSinceOpen(undefined, {})).toBe(true);
  expect(changedSinceOpen(null, { updated_at: null })).toBe(true);
  expect(changedSinceOpen('', { updated_at: '' })).toBe(true);
  expect(changedSinceOpen('2026-10-01T10:00:00.000Z', {})).toBe(true);
  expect(changedSinceOpen('2026-10-01T10:00:00.000Z', null)).toBe(true);
  expect(changedSinceOpen(undefined, { updated_at: '2026-10-01T10:00:00.000Z' })).toBe(true);
});

describe('confirmView', () => {
  const booked = {
    status: 'deposit_paid', total_price: '3650.00', amount_paid: '1900.00', off_contract_paid_cents: 0,
    gratuity_rate_change_origin: null, pricing_snapshot: { gratuity: { total: 120 } },
  };
  test('nothing changed: Done, no total, whatever today’s catalog says', () => {
    const v = confirmView({ proposal: booked, preview: { total: 3700, gratuityTotal: 120 }, changed: false });
    expect(v).toMatchObject({ repriced: false, button: 'Done', balanceLine: null, lines: [] });
  });
  test('changed but the total held: Done, no lines', () => {
    const v = confirmView({ proposal: booked, preview: { total: 3650, gratuityTotal: 120 }, changed: true });
    expect(v).toMatchObject({ repriced: false, button: 'Done', lines: [] });
  });
  test('a booked reprice: the totals, the balance line and the desktop lines', () => {
    const v = confirmView({ proposal: booked, preview: { total: 3800, gratuityTotal: 120 }, changed: true });
    expect(v.repriced).toBe(true);
    expect(v.button).toBe('Confirm new total');
    expect(v.oldTotal).toBe('$3,650.00');
    expect(v.newTotal).toBe('$3,800.00');
    expect(v.balanceLine).toBe('balance due becomes $1,900.00');
    expect(v.lines[v.lines.length - 1]).toBe('Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.');
  });
  test('the balance never reads below $0', () => {
    const v = confirmView({ proposal: { ...booked, amount_paid: '3700.00' }, preview: { total: 3500, gratuityTotal: 120 }, changed: true });
    expect(v.balanceLine).toBe('balance due becomes $0.00');
  });
  test('an unbooked reprice shows the totals and nothing else', () => {
    const v = confirmView({ proposal: { ...booked, status: 'accepted', amount_paid: '0' }, preview: { total: 3800, gratuityTotal: 120 }, changed: true });
    expect(v).toMatchObject({ repriced: true, balanceLine: null, lines: [] });
  });
  test('the gratuity line arrives through the shared summary', () => {
    const v = confirmView({ proposal: booked, preview: { total: 3700, gratuityTotal: 160 }, changed: true });
    expect(v.lines).toContain('The gratuity rises to $160.00, so the client is emailed the new amount automatically, unless their email address is missing or has bounced.');
  });
  // C-M1 item 5: one copy of the balance rule, the summary's newBalance, clamped at $0.
  test('the balance line is the shared summary\'s newBalance, clamped at $0', () => {
    buildRepriceSummary.mockReturnValueOnce({ unknown: false, newBalance: 12.5, lines: ['From the summary.'] });
    const v = confirmView({ proposal: booked, preview: { total: 3800, gratuityTotal: 120 }, changed: true });
    expect(v.balanceLine).toBe('balance due becomes $12.50');
    expect(v.lines).toEqual(['From the summary.']);
    buildRepriceSummary.mockReturnValueOnce({ unknown: false, newBalance: -40, lines: [] });
    expect(confirmView({ proposal: booked, preview: { total: 3800, gratuityTotal: 120 }, changed: true }).balanceLine)
      .toBe('balance due becomes $0.00');
  });
});

// Item 1 (P-I1, D-I1): the block while a figure is on its way.
describe('confirmViewNow', () => {
  const booked = {
    status: 'deposit_paid', total_price: '3650.00', amount_paid: '1900.00', off_contract_paid_cents: 0,
    gratuity_rate_change_origin: null, pricing_snapshot: { gratuity: { total: 120 } },
  };
  const landed = { state: 'ready', total: 3800, gratuityTotal: 120 };
  test('a figure that landed is shown as it is', () => {
    const v = confirmViewNow({ proposal: booked, preview: landed, shown: landed, changed: true });
    expect(v).toMatchObject({ repriced: true, newTotal: '$3,800.00', button: 'Confirm new total' });
    expect(v.stale).toBeFalsy();
  });
  test('while the next one loads, the last one stays, marked stale, with its balance and lines', () => {
    const v = confirmViewNow({ proposal: booked, preview: { state: 'loading' }, shown: landed, changed: true });
    expect(v).toMatchObject({ repriced: true, stale: true, oldTotal: '$3,650.00', newTotal: '$3,800.00', balanceLine: 'balance due becomes $1,900.00', button: 'Confirm new total' });
    expect(v.lines.length).toBeGreaterThan(0);
  });
  test('a failed figure keeps the last one too, marked stale', () => {
    expect(confirmViewNow({ proposal: booked, preview: { state: 'failed' }, shown: landed, changed: true }))
      .toMatchObject({ repriced: true, stale: true, newTotal: '$3,800.00' });
  });
  test('before any figure describes a change: the stored total and three dots, and no lines', () => {
    const atOpen = { state: 'ready', total: 3650, gratuityTotal: 120 };
    for (const shown of [null, atOpen]) {
      expect(confirmViewNow({ proposal: booked, preview: { state: 'loading' }, shown, changed: true })).toMatchObject({
        repriced: true, stale: true, pending: true, oldTotal: '$3,650.00', newTotal: PENDING_FIGURE, balanceLine: null, lines: [], button: 'Confirm new total',
      });
    }
  });
  test('an untouched sheet shows nothing, whatever is loading', () => {
    const v = confirmViewNow({ proposal: booked, preview: { state: 'loading' }, shown: landed, changed: false });
    expect(v).toMatchObject({ repriced: false, button: 'Done', lines: [] });
    expect(v.stale).toBeFalsy();
  });
});

// ma-e3b (design pass 2026-10-06): the readout's two top lines.
describe('readoutView', () => {
  const booked = {
    status: 'deposit_paid', total_price: '3650.00', amount_paid: '1900.00', off_contract_paid_cents: 0,
    gratuity_rate_change_origin: null, pricing_snapshot: { gratuity: { total: 120 } },
  };
  const landed = { state: 'ready', total: 3800, gratuityTotal: 120 };
  test('untouched: the stored total, what is paid and the balance, and Done, before any figure lands', () => {
    expect(readoutView({ proposal: booked, preview: { state: 'loading' }, shown: null, changed: false })).toEqual({
      label: 'Total', old: null, now: '$3,650.00', sub: 'paid $1,900.00 · balance due $1,750.00',
      pricing: false, dim: false, pending: false, lines: [], button: 'Done',
    });
  });
  test('the balance is floored at $0.00 when nothing is netted as overpaid', () => {
    for (const [paid, shown] of [['3650.00', '$3,650.00'], ['4000.00', '$4,000.00']]) {
      expect(readoutView({ proposal: { ...booked, amount_paid: paid }, preview: null, shown: null, changed: false }).sub)
        .toBe(`paid ${shown} · balance due $0.00`);
    }
  });
  test('an overpaid row says so, from the server\'s netted figure, in place of a balance of $0.00', () => {
    expect(readoutView({ proposal: { ...booked, amount_paid: '4000.00', overpayment_cents: 35000 }, preview: null, shown: null, changed: false }).sub)
      .toBe('paid $4,000.00 · overpaid $350.00');
  });
  test('a bank payment in flight, which the detail passes in, is said ahead of a balance or an overpayment', () => {
    expect(readoutView({ proposal: booked, preview: null, shown: null, changed: false, inFlight: true }).sub)
      .toBe('paid $1,900.00 · bank payment in flight');
    expect(readoutView({ proposal: { ...booked, overpayment_cents: 35000 }, preview: null, shown: null, changed: false, inFlight: true }).sub)
      .toBe('paid $1,900.00 · bank payment in flight');
  });
  test('a change that leaves the total where it was reads as untouched', () => {
    const atOpen = { state: 'ready', total: 3650, gratuityTotal: 120 };
    expect(readoutView({ proposal: booked, preview: atOpen, shown: atOpen, changed: true }))
      .toMatchObject({ label: 'Total', now: '$3,650.00', sub: 'paid $1,900.00 · balance due $1,750.00', pending: false, button: 'Done' });
  });
  test('a landed figure: New total, old to new, the balance it becomes, the lines', () => {
    const r = readoutView({ proposal: booked, preview: landed, shown: landed, changed: true });
    expect(r).toMatchObject({
      label: 'New total', old: '$3,650.00', now: '$3,800.00', sub: 'balance due becomes $1,900.00',
      pricing: false, dim: false, pending: false, button: 'Confirm new total',
    });
    expect(r.lines[r.lines.length - 1]).toBe('Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.');
  });
  test('while the next figure loads, the last one stays, dimmed, under PRICING', () => {
    expect(readoutView({ proposal: booked, preview: { state: 'loading' }, shown: landed, changed: true }))
      .toMatchObject({ label: 'New total', now: '$3,800.00', sub: 'balance due becomes $1,900.00', pricing: true, dim: true, pending: false });
  });
  test('before any figure describes the change: three dots under PRICING, nothing dimmed', () => {
    expect(readoutView({ proposal: booked, preview: { state: 'loading' }, shown: null, changed: true })).toEqual({
      label: 'New total', old: '$3,650.00', now: PENDING_FIGURE, sub: `balance due becomes ${PENDING_FIGURE}`,
      pricing: true, dim: false, pending: true, lines: [], button: 'Confirm new total',
    });
  });
  test('a failed figure keeps the last one dimmed, with no PRICING', () => {
    expect(readoutView({ proposal: booked, preview: { state: 'failed' }, shown: landed, changed: true }))
      .toMatchObject({ now: '$3,800.00', pricing: false, dim: true, pending: false });
  });
  test('an unbooked row carries no balance line', () => {
    expect(readoutView({ proposal: { ...booked, status: 'accepted' }, preview: null, shown: null, changed: false }).sub).toBeNull();
  });
  test('a bank payment in flight is said on an unbooked row too, as the detail says it on any row it marks in flight', () => {
    expect(readoutView({ proposal: { ...booked, status: 'accepted', amount_paid: '0.00' }, preview: null, shown: null, changed: false, inFlight: true }).sub)
      .toBe('paid $0.00 · bank payment in flight');
  });
});

describe('was lines', () => {
  const initial = { event_date: '2999-08-15', event_start_time: '7:00 PM', event_duration_hours: 4, guest_count: 140 };
  test('nothing for a field that has not changed', () => {
    for (const field of Object.keys(initial)) expect(wasLine(field, initial, initial, '2026-10-08')).toBeNull();
  });
  test('what a changed field held when the sheet opened', () => {
    expect(wasLine('event_duration_hours', initial, { ...initial, event_duration_hours: 4.5 })).toBe('was 4 hr');
    expect(wasLine('guest_count', initial, { ...initial, guest_count: 145 })).toBe('was 140');
    expect(wasLine('event_date', initial, { ...initial, event_date: '2999-08-22' }, '2026-10-08')).toBe('was THU AUG 15 2999');
    expect(wasLine('event_start_time', initial, { ...initial, event_start_time: '20:00' })).toBe('was 19:00');
  });
  test('the same start in another shape is not a change', () => {
    expect(wasLine('event_start_time', initial, { ...initial, event_start_time: '19:00' })).toBeNull();
  });
  test('a stored value that cannot be read says nothing', () => {
    expect(wasLine('event_start_time', { ...initial, event_start_time: 'later' }, { ...initial, event_start_time: '20:00' })).toBeNull();
  });
  test('the line under Start: what it was, once changed, then the setup', () => {
    const p = { setup_time_display: '18:15', event_start_time: '7:00 PM' };
    expect(startSubLine(p, initial, initial)).toBe('setup 45 min before');
    expect(startSubLine(p, initial, { ...initial, event_start_time: '20:00' })).toBe('was 19:00 · setup 45 min before');
    expect(startSubLine({}, initial, initial)).toBeNull();
  });
});

// Item 5 (S-M1, D-M1): what still rides on Book it anyway.
test('curfewRidesLine names the update the acknowledged retry still sends', () => {
  const notice = [{ type: 'event_details_changed', channels: ['email'] }];
  expect(curfewRidesLine(notice, null)).toBe('Your update to the client goes out with it.');
  expect(curfewRidesLine(notice, { enabled: false, sms: false, email: false })).toBe('Your update to the client goes out with it.');
  expect(curfewRidesLine(notice, { enabled: true, sms: true, email: false })).toBe('Your update to the client and the assigned staff goes out with it.');
  expect(curfewRidesLine([], { enabled: true, sms: false, email: true })).toBe('Your update to the assigned staff goes out with it.');
  // The server sends staff nothing without a ticked channel (runRescheduleStaffHooks).
  expect(curfewRidesLine([], { enabled: true, sms: false, email: false })).toBeNull();
  expect(curfewRidesLine([], { enabled: false, sms: true, email: true })).toBeNull();
  expect(curfewRidesLine([], null)).toBeNull();
});

// Item 2 (P-I2): one named constant for every read's timeout.
test('every read gives up after ten seconds', () => {
  expect(READ_TIMEOUT_MS).toBe(10000);
});

describe('errors', () => {
  test('a transport failure reads as no connection', () => {
    expect(saveErrorText({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' })).toBe(NO_CONNECTION);
  });
  // S-M4: a write that went out and got no answer may have landed.
  test('a transport failure after the write went out says it may not have saved', () => {
    const network = { status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' };
    expect(SAVE_UNCONFIRMED).toBe('No connection. It may not have saved; reopen the event to check.');
    expect(saveErrorText(network, true)).toBe(SAVE_UNCONFIRMED);
    expect(saveErrorText(network, false)).toBe(NO_CONNECTION);
    expect(saveErrorText({ status: 400, fieldErrors: { guest_count: 'Hosted packages require at least 25 guests' } }, true))
      .toBe('Hosted packages require at least 25 guests');
  });
  test('a refusal shows its field text, never the generic line', () => {
    expect(saveErrorText({ status: 400, message: 'Please fix the errors below', fieldErrors: { guest_count: 'Hosted packages require at least 25 guests' } }))
      .toBe('Hosted packages require at least 25 guests');
  });
  test('anything else shows the server message', () => {
    expect(saveErrorText({ status: 500, message: 'Something broke' })).toBe('Something broke');
    expect(saveErrorText({ status: 500 })).toBe('Something went wrong. Try again.');
  });
  test('curfewReason reads the past_curfew refusal, and nothing else', () => {
    expect(curfewReason({ fieldErrors: { past_curfew: 'true', event_duration_hours: 'Ends at 2:30 AM, past curfew.' } })).toBe('Ends at 2:30 AM, past curfew.');
    expect(curfewReason({ fieldErrors: { past_curfew: 'true' } })).toBe('This booking runs past our 2:00 AM service curfew.');
    expect(curfewReason({ fieldErrors: { guest_count: 'x' } })).toBeNull();
    expect(curfewReason(null)).toBeNull();
  });
});

test('noteFirstLine is the first line with text, trimmed', () => {
  expect(noteFirstLine('\n  Gate code at the barn  \nsecond')).toBe('Gate code at the barn');
  expect(noteFirstLine('')).toBe('');
  expect(noteFirstLine(null)).toBe('');
});
