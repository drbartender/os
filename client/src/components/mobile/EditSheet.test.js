import React from 'react';
import fs from 'fs';
import path from 'path';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import EditSheet from './EditSheet';
import api from '../../utils/api';
import { READ_TIMEOUT_MS } from '../../utils/editSheetView';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));

const PKG = { id: 1, slug: 'the-core-reaction', name: 'The Core Reaction', pricing_type: 'flat', bar_type: 'service_only', guests_per_bartender: 100 };
const BARBACK = { id: 7, slug: 'barback', billing_type: 'per_hour', minimum_hours: 0 };
// 140 guests at 100 per bartender needs 2; 3 stored is a charged override.
// The barback row was priced at 4 hours, 2 barbacks: quantity 8.
const PROPOSAL = {
  id: 13, status: 'deposit_paid', client_name: 'Alexis Henderson', event_type: 'wedding-reception',
  event_date: '2999-08-15T00:00:00.000Z', event_start_time: '7:00 PM', event_duration_hours: '4',
  guest_count: 140, package_id: 1, num_bars: 0, num_bartenders: 3,
  venue_name: 'Grove', venue_street: '12 River Rd', venue_city: 'Rockford', venue_state: 'Illinois', venue_zip: '61101',
  total_price: '3650.00', amount_paid: '1900.00', off_contract_paid_cents: 0, client_signed_at: '2999-01-01T00:00:00.000Z',
  setup_time_display: '18:15', setup_minutes_before: null, settled_extension_hours: 0, contract_floor_hours: null,
  adjustments: [], total_price_override: null, client_provides_glassware: false, class_options: null,
  addons: [{ addon_id: 7, quantity: 8, rate: 25, line_total: 200, variant: null }],
  pricing_snapshot: { total: 3650, gratuity: { rate: 10, tip_jar: true, total: 120 }, syrups: { selections: [] } },
  gratuity_rate_change_origin: null, updated_at: '2999-07-01T10:00:00.000Z',
};
const NETWORK = { status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' };

function serve({ proposal = PROPOSAL, reread = null, calculate = { total: 3650, gratuity: { total: 120 } }, notices = [], patch } = {}) {
  let proposalReads = 0;
  api.get.mockImplementation((url) => {
    if (url === '/proposals/13') {
      proposalReads += 1;
      const p = proposalReads > 1 && reread ? reread : proposal;
      return p.reject ? Promise.reject(p.reject) : Promise.resolve({ data: p });
    }
    if (url === '/proposals/packages') return Promise.resolve({ data: [PKG] });
    if (url === '/proposals/addons') return Promise.resolve({ data: [BARBACK] });
    return Promise.reject({ status: 404, message: 'Not found' });
  });
  api.post.mockImplementation((url) => {
    if (url === '/proposals/calculate') {
      const c = typeof calculate === 'function' ? calculate() : calculate;
      return c && c.reject ? Promise.reject(c.reject) : Promise.resolve({ data: c });
    }
    if (url === '/proposals/13/notify-preflight') return Promise.resolve({ data: { notices } });
    return Promise.reject({ status: 404 });
  });
  api.patch.mockImplementation(patch || (() => Promise.resolve({ data: { ...PROPOSAL, notifications: [] } })));
}

function mount(props = {}) {
  const onClose = jest.fn();
  const onSaved = jest.fn();
  render(<EditSheet proposalId={13} clientName="Alexis Henderson" kind="Wedding Reception" onClose={onClose} onSaved={onSaved} previewDelayMs={0} armDelayMs={0} {...props} />);
  return { onClose, onSaved };
}
const ready = () => screen.findByText('Duration');
const more = (name) => fireEvent.click(screen.getByRole('button', { name }));
const confirmBtn = () => screen.getByRole('button', { name: /^(Confirm new total|Done)$/ });
const LOST = 'No connection. It may not have saved; reopen the event to check.';

// What jsdom lacks: a record of what was scrolled into view.
const scrolled = [];
beforeAll(() => { Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this); }; });
afterAll(() => { delete Element.prototype.scrollIntoView; });
beforeEach(() => { scrolled.length = 0; mockToast.success.mockReset(); mockToast.error.mockReset(); mockToast.info.mockReset(); });
afterEach(() => { jest.useRealTimers(); });

// Every read is a plain fresh read: the read timeout and nothing else, so no
// header (the stored-copy X-Offline-Ok above all) can ride. The preview and the
// preflight are read-only and carry the same; the PATCH carries no config at all.
function expectPlainReads() {
  expect(api.get.mock.calls.length).toBeGreaterThan(0);
  for (const call of api.get.mock.calls) {
    expect(call).toHaveLength(2);
    expect(call[1]).toStrictEqual({ timeout: READ_TIMEOUT_MS });
  }
  for (const call of api.post.mock.calls) {
    expect(call).toHaveLength(3);
    expect(call[2]).toStrictEqual({ timeout: READ_TIMEOUT_MS });
  }
  for (const call of api.patch.mock.calls) expect(call).toHaveLength(2);
}

test('reads the event and both catalogs fresh, never from the stored copy', async () => {
  serve();
  mount();
  await ready();
  await waitFor(() => expect(api.post.mock.calls.filter(([u]) => u === '/proposals/calculate')).toHaveLength(1));
  expect(api.get.mock.calls.map(([u]) => u).sort()).toEqual(['/proposals/13', '/proposals/addons', '/proposals/packages']);
  expect(READ_TIMEOUT_MS).toBe(10000);
  expectPlainReads();
});

test('the head, the rows as drawn, the stored values, and Setup with no arrow', async () => {
  serve();
  mount();
  await ready();
  expect(screen.getByRole('dialog', { name: 'Edit details' })).toBeInTheDocument();
  expect(screen.getByText('event edit · reprices the booking')).toBeInTheDocument();
  expect(screen.getByText('THU AUG 15 2999')).toBeInTheDocument();
  expect(screen.getByLabelText('Start')).toHaveValue('19:00');
  expect(screen.getByText('4 hr')).toBeInTheDocument();
  expect(screen.getByText('140')).toBeInTheDocument();
  expect(screen.getByText('45 min before')).toBeInTheDocument();
  // eslint-disable-next-line testing-library/no-node-access, testing-library/prefer-presence-queries
  expect(screen.getByText('Setup').closest('.m-sheet-row').querySelector('.m-edit-caret')).toBeNull();
});

test('duration steps in half hours and guests in fives, and the floors hold', async () => {
  serve();
  mount();
  await ready();
  more('Longer');
  expect(screen.getByText('4.5 hr')).toBeInTheDocument();
  more('More guests');
  expect(screen.getByText('145')).toBeInTheDocument();
  for (let i = 0; i < 12; i += 1) more('Shorter');
  expect(screen.getByText('1 hr')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Shorter' })).toBeDisabled();
});

test('an untouched sheet says Done and closes without a request', async () => {
  serve({ calculate: { total: 3700, gratuity: { total: 120 } } });
  const { onClose } = mount();
  await ready();
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/proposals/calculate', expect.any(Object), { timeout: READ_TIMEOUT_MS }));
  expect(screen.queryByText('New total')).toBeNull();
  fireEvent.click(confirmBtn());
  expect(onClose).toHaveBeenCalled();
  expect(api.patch).not.toHaveBeenCalled();
});

test('a change asks the server for the new total and shows the booked lines', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }) });
  mount();
  await ready();
  more('More guests');
  // The block shows at once (the stored total and an ellipsis), then the figure lands in it.
  expect(await screen.findByText('$3,800.00')).toBeInTheDocument();
  expect(screen.getByText('New total')).toBeInTheDocument();
  expect(screen.getByText('$3,650.00')).toBeInTheDocument();
  expect(screen.getByText('balance due becomes $1,900.00')).toBeInTheDocument();
  expect(screen.getByText('Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.')).toBeInTheDocument();
  expect(confirmBtn()).toHaveTextContent('Confirm new total');
  const body = api.post.mock.calls.filter(([u]) => u === '/proposals/calculate').pop()[1];
  expect(body).toMatchObject({ proposal_id: 13, guest_count: 145, duration_hours: 4, num_bartenders: 3, addon_quantities: { 7: 2 } });
  expect(body).not.toHaveProperty('gratuity_mandate_total');
});

test('a failed figure keeps Confirm disabled and Retry asks again', async () => {
  let fail = true;
  serve({ calculate: () => (fail ? { reject: NETWORK } : { total: 3800, gratuity: { total: 120 } }) });
  mount();
  await ready();
  more('More guests');
  expect(await screen.findByText("Couldn't price the change.")).toBeInTheDocument();
  expect(confirmBtn()).toBeDisabled();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  expect(screen.getByText('$3,800.00')).toBeInTheDocument();
});

test('a late figure for an older form never replaces the newer one', async () => {
  serve();
  // Each /calculate answer waits until the test resolves it, found by the guest count it priced.
  const asks = [];
  const served = api.post.getMockImplementation();
  api.post.mockImplementation((url, body) => (url === '/proposals/calculate'
    ? new Promise((resolve) => { asks.push({ guests: body.guest_count, resolve }); })
    : served(url, body)));
  const ask = (guests) => asks.find((a) => a.guests === guests);
  mount();
  await ready();
  more('More guests');
  await waitFor(() => expect(ask(145)).toBeDefined());
  more('More guests');
  await waitFor(() => expect(ask(150)).toBeDefined());
  await act(async () => { ask(150).resolve({ data: { total: 3900, gratuity: { total: 120 } } }); });
  expect(screen.getByText('$3,900.00')).toBeInTheDocument();
  expect(screen.queryByText('$3,800.00')).toBeNull();
  await act(async () => { ask(145).resolve({ data: { total: 3800, gratuity: { total: 120 } } }); });
  expect(screen.getByText('$3,900.00')).toBeInTheDocument();
  expect(screen.queryByText('$3,800.00')).toBeNull();
});

test('the save sends the desktop\'s complete payload, without the venue keys', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }) });
  const { onSaved } = mount();
  await ready();
  more('More guests');
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await waitFor(() => expect(api.patch).toHaveBeenCalled());
  const [url, body] = api.patch.mock.calls[0];
  expect(url).toBe('/proposals/13');
  expect(body).toMatchObject({
    event_date: '2999-08-15', event_start_time: '7:00 PM', event_duration_hours: 4.5, guest_count: 145,
    package_id: 1, num_bars: 0, num_bartenders: 3, addon_ids: [7], addon_quantities: { 7: 2 },
    syrup_selections: [], adjustments: [], total_price_override: null, setup_minutes_before: null,
    class_options: null, client_provides_glassware: false, notify: [],
  });
  for (const k of ['venue_name', 'venue_street', 'venue_city', 'venue_state', 'venue_zip', 'gratuity_mandate_total', 'notify_assigned_staff']) {
    expect(body).not.toHaveProperty(k);
  }
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(mockToast.success).toHaveBeenCalledWith('Event updated.');
});

test('an untouched start time is sent as stored', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }) });
  mount();
  await ready();
  fireEvent.change(screen.getByLabelText('Start'), { target: { value: '19:00' } });
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await waitFor(() => expect(api.patch).toHaveBeenCalled());
  expect(api.patch.mock.calls[0][1].event_start_time).toBe('7:00 PM');
});

test('a changed start time goes out as HH:MM, clamped to the desktop picker', async () => {
  serve();
  mount();
  await ready();
  fireEvent.change(screen.getByLabelText('Start'), { target: { value: '23:50' } });
  expect(screen.getByLabelText('Start')).toHaveValue('23:30');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await waitFor(() => expect(api.patch).toHaveBeenCalled());
  expect(api.patch.mock.calls[0][1].event_start_time).toBe('23:30');
});

test('the date picker starts at today and ignores an earlier date', async () => {
  serve();
  mount();
  await ready();
  const input = screen.getByLabelText('Date');
  expect(input).toHaveAttribute('min', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  fireEvent.change(input, { target: { value: '2000-01-01' } });
  expect(input).toHaveValue('2999-08-15');
  fireEvent.change(input, { target: { value: '2999-08-22' } });
  expect(screen.getByText('THU AUG 22 2999')).toBeInTheDocument();
});

test('a second tap while a save is in flight sends nothing', async () => {
  let release;
  serve({
    calculate: () => ({ total: 3800, gratuity: { total: 120 } }),
    patch: () => new Promise((resolve) => { release = () => resolve({ data: { notifications: [] } }); }),
  });
  mount();
  await ready();
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByText('Saving');
  fireEvent.click(screen.getByRole('button', { name: 'Saving' }));
  fireEvent.click(screen.getByRole('button', { name: 'Saving' }));
  release();
  await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
  expect(api.patch).toHaveBeenCalledTimes(1);
});

test('two taps in one tick still send one save', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }) });
  const { onSaved } = mount();
  await ready();
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  // One act: React cannot re-render, so it cannot disable the button, between the taps.
  act(() => { confirmBtn().click(); confirmBtn().click(); });
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.patch).toHaveBeenCalledTimes(1);
  expect(api.post.mock.calls.filter(([u]) => u === '/proposals/13/notify-preflight')).toHaveLength(1);
});

test('an event that moved since the sheet opened is not saved', async () => {
  serve({
    calculate: () => ({ total: 3800, gratuity: { total: 120 } }),
    reread: { ...PROPOSAL, updated_at: '2999-07-01T10:05:00.000Z', event_duration_hours: '5' },
  });
  mount();
  await ready();
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  expect(await screen.findByText('This event changed since you opened it.')).toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();
  expect(confirmBtn()).toBeDisabled();
  // The re-read behind the refusal was a plain fresh read too.
  expect(api.get.mock.calls.filter(([u]) => u === '/proposals/13')).toHaveLength(2);
  expectPlainReads();
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(await screen.findByText('5 hr')).toBeInTheDocument();
  expect(screen.getByText('140')).toBeInTheDocument();
});

test('past the curfew: the server reason, then Book it anyway resends acknowledged', async () => {
  let calls = 0;
  serve({
    patch: () => {
      calls += 1;
      return calls === 1
        ? Promise.reject({ status: 400, message: 'Please fix the errors below', fieldErrors: { past_curfew: 'true', event_duration_hours: 'This booking ends at 2:30 AM, past the 2:00 AM curfew.' } })
        : Promise.resolve({ data: { notifications: [] } });
    },
  });
  const { onSaved } = mount();
  await ready();
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  expect(await screen.findByText('This booking ends at 2:30 AM, past the 2:00 AM curfew. Book it anyway? This will be recorded.')).toBeInTheDocument();
  // Nothing rides along on a save with no notice, so no line says it does.
  expect(screen.queryByText(/goes out with it\.$/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Book it anyway' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.patch.mock.calls[1][1].acknowledge_past_curfew).toBe(true);
  expect(api.get.mock.calls.filter(([u]) => u === '/proposals/13')).toHaveLength(3);
  // Both re-reads, the one before the acknowledged PATCH included, were plain fresh reads.
  expectPlainReads();
});

test('Keep editing at the curfew leaves the desktop line and saves nothing', async () => {
  serve({ patch: () => Promise.reject({ status: 400, fieldErrors: { past_curfew: 'true' } }) });
  mount();
  await ready();
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
  expect(screen.getByText('Not saved. The end time is past our 2:00 AM service curfew.')).toBeInTheDocument();
  expect(api.patch).toHaveBeenCalledTimes(1);
});

test('an edit while the curfew confirm is open withdraws it, and the next save carries the edit', async () => {
  let calls = 0;
  serve({
    patch: () => {
      calls += 1;
      return calls === 1
        ? Promise.reject({ status: 400, message: 'Please fix the errors below', fieldErrors: { past_curfew: 'true', event_duration_hours: 'This booking ends at 2:30 AM, past the 2:00 AM curfew.' } })
        : Promise.resolve({ data: { notifications: [] } });
    },
  });
  const { onSaved } = mount();
  await ready();
  more('Longer');
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByRole('button', { name: 'Book it anyway' });
  const sentence = 'This booking ends at 2:30 AM, past the 2:00 AM curfew. Book it anyway? This will be recorded.';
  expect(screen.getByText(sentence)).toBeInTheDocument();
  more('Shorter');
  expect(screen.queryByText(sentence)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Book it anyway' })).toBeNull();
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.patch).toHaveBeenCalledTimes(2);
  const second = api.patch.mock.calls[1][1];
  expect(second.event_duration_hours).toBe(Number(PROPOSAL.event_duration_hours) + 0.5);
  expect(second).not.toHaveProperty('acknowledge_past_curfew');
});

test('a refusal shows the server\'s text and the sheet stays open', async () => {
  serve({ patch: () => Promise.reject({ status: 400, message: 'Please fix the errors below', fieldErrors: { guest_count: 'Hosted packages require at least 25 guests' } }) });
  const { onSaved, onClose } = mount();
  await ready();
  more('Fewer guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  expect(await screen.findByText('Hosted packages require at least 25 guests')).toBeInTheDocument();
  expect(onSaved).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

// S-M4: the PATCH went out and no answer came back, so it may have landed.
test('a save whose answer never came says it may not have saved', async () => {
  serve({ patch: () => Promise.reject(NETWORK) });
  mount();
  await ready();
  more('Fewer guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  expect(await screen.findByText(LOST)).toBeInTheDocument();
  expect(screen.queryByText("No connection, didn't save.")).toBeNull();
  expect(api.patch).toHaveBeenCalledTimes(1);
});

test('a re-read that fails before the PATCH is a definite "didn\'t save", and nothing is written', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }), reread: { reject: NETWORK } });
  mount();
  await ready();
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  expect(await screen.findByText("No connection, didn't save.")).toBeInTheDocument();
  expect(screen.queryByText(LOST)).toBeNull();
  expect(api.patch).not.toHaveBeenCalled();
});

test('a notify preflight that fails is a definite "didn\'t save", and nothing is written', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }) });
  const served = api.post.getMockImplementation();
  api.post.mockImplementation((url, body, config) => (url === '/proposals/13/notify-preflight'
    ? Promise.reject(NETWORK) : served(url, body, config)));
  mount();
  await ready();
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  expect(await screen.findByText("No connection, didn't save.")).toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();
});

test('the reads failing say so, with Retry', async () => {
  serve({ proposal: { reject: NETWORK } });
  mount();
  expect(await screen.findByText("Couldn't load this event. Editing needs a connection.")).toBeInTheDocument();
  serve();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await ready();
});

test('an event closed since the row was drawn is not editable here', async () => {
  serve({ proposal: { ...PROPOSAL, status: 'completed' } });
  mount();
  expect(await screen.findByText('This event can no longer be edited here. Use desktop view.')).toBeInTheDocument();
  expect(screen.queryByText('Duration')).toBeNull();
});

test('the extension hint and the multi-shift note', async () => {
  serve({ proposal: { ...PROPOSAL, settled_extension_hours: 1, contract_floor_hours: 3 } });
  mount({ shiftCount: 2 });
  await ready();
  expect(screen.getByText('Includes 1h of on-site extension, billed on its own invoice. The contract prices 3h.')).toBeInTheDocument();
  expect(screen.getByText('This event has 2 shifts. Changing the date or time here does not move them; each shift is edited from desktop view.')).toBeInTheDocument();
});

test('Cancel closes, and the scrim does nothing while a save is in flight', async () => {
  let release;
  serve({ patch: () => new Promise((resolve) => { release = () => resolve({ data: { notifications: [] } }); }) });
  const { onClose } = mount();
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByText('Saving');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(onClose).toHaveBeenCalledTimes(1);
  release();
  await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
});

const NOTICE = {
  type: 'event_details_changed', composable: true, reasons: ['event_date changed'],
  recipient: { name: 'Alexis Henderson', email: 'alexis.hend@gmail.com', phone: '+13125550184' },
  channels: { email: { available: true, default: true }, sms: { available: true, default: true } },
  autopay_notice: null,
  draft: { email: { subject: 'Your event date changed', body_text: 'Hi Alexis, your event is now on Aug 22.' }, sms: { body: 'Your event moved to Aug 22.' } },
};

async function toNotifyStep(over = {}, props = {}) {
  serve({ notices: [NOTICE], ...over });
  const handles = mount(props);
  await ready();
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2999-08-22' } });
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByText('Notify the client?');
  return handles;
}

test('a booked date change opens the desktop notify step: channels ticked as the desktop ticks them, the message read-only', async () => {
  await toNotifyStep();
  expect(screen.getByText('Date changed. Current contact on file: Alexis Henderson (alexis.hend@gmail.com).')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Email' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Text' })).toBeChecked();
  expect(screen.getByText('Your event date changed')).toBeInTheDocument();
  expect(screen.getByText('Hi Alexis, your event is now on Aug 22.')).toBeInTheDocument();
  expect(screen.getByText('Your event moved to Aug 22.')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('checkbox', { name: 'Notify assigned staff' })).not.toBeChecked();
  expect(screen.getByText('Staff are notified only when the date, time, or location actually changes.')).toBeInTheDocument();
  const buttons = screen.getAllByRole('button').map((b) => b.textContent);
  expect(buttons.slice(-3)).toEqual(['Cancel', 'Send the update', "Don't send"]);
  expect(screen.getByRole('button', { name: "Don't send" })).toHaveClass('m-act-primary');
});

test('Don\'t send saves with no notice and the staff choice off', async () => {
  const { onSaved } = await toNotifyStep();
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.patch.mock.calls[0][1]).toMatchObject({
    event_date: '2999-08-22', notify: [], notify_assigned_staff: false, notify_staff_sms: false, notify_staff_email: false,
  });
});

test('Send the update sends the standard text on the ticked channels, and the staff choice', async () => {
  const { onSaved } = await toNotifyStep();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Text' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Notify assigned staff' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Text (SMS), assigned staff' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send the update' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.patch.mock.calls[0][1]).toMatchObject({
    notify: [{ type: 'event_details_changed', channels: ['email'], email: { subject: 'Your event date changed', body_text: 'Hi Alexis, your event is now on Aug 22.' } }],
    notify_assigned_staff: true, notify_staff_sms: true, notify_staff_email: false,
  });
  // The preflight and the re-read behind the send were plain fresh reads; the PATCH carried no config.
  expectPlainReads();
});

test('a second tap on Send the update sends one PATCH', async () => {
  let release;
  await toNotifyStep({ patch: () => new Promise((resolve) => { release = () => resolve({ data: { notifications: [] } }); }) });
  fireEvent.click(screen.getByRole('button', { name: 'Send the update' }));
  await screen.findByText('Saving');
  fireEvent.click(screen.getByRole('button', { name: 'Saving' }));
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  release();
  await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
  expect(api.patch).toHaveBeenCalledTimes(1);
});

test('Cancel goes back to the edit with the change kept and nothing saved', async () => {
  await toNotifyStep();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(await screen.findByText('THU AUG 22 2999')).toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();
});

test('a client with no email and no phone: both unavailable, Send disabled, Don\'t send still saves', async () => {
  const bare = {
    ...NOTICE,
    recipient: { name: 'Alexis Henderson', email: null, phone: null },
    channels: {
      email: { available: false, default: false, unavailable_reason: 'No email on file.' },
      sms: { available: false, default: false, unavailable_reason: 'No usable phone on file.' },
    },
  };
  const { onSaved } = await toNotifyStep({ notices: [bare] });
  expect(screen.getByText('Email unavailable: No email on file.')).toBeInTheDocument();
  expect(screen.getByText('Text unavailable: No usable phone on file.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send the update' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.patch.mock.calls[0][1].notify).toEqual([]);
});

test('unticking every channel disables Send the update', async () => {
  await toNotifyStep();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Email' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Text' }));
  expect(screen.getByRole('button', { name: 'Send the update' })).toBeDisabled();
});

test('the outcome toasts the desktop shows', async () => {
  const { onSaved } = await toNotifyStep({
    patch: () => Promise.resolve({ data: { notifications: [{ email: 'failed', email_error: 'bounced', sms: 'sent' }] } }),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send the update' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(mockToast.success).toHaveBeenCalledWith('Event updated.');
  expect(mockToast.error).toHaveBeenCalledWith('Saved, but the email failed: bounced');
});

test('the event moving while the notify step was open is caught at the send', async () => {
  await toNotifyStep({ reread: { ...PROPOSAL, updated_at: '2999-07-01T10:09:00.000Z' } });
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  expect(await screen.findByText('This event changed since you opened it.')).toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();
});

test('a failed send keeps the notify step open and says why', async () => {
  const { onSaved } = await toNotifyStep({ patch: () => Promise.reject(NETWORK) });
  fireEvent.click(screen.getByRole('button', { name: 'Send the update' }));
  expect(await screen.findByText(LOST)).toBeInTheDocument();
  expect(screen.getByText('Notify the client?')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send the update' })).toBeEnabled();
  expect(onSaved).not.toHaveBeenCalled();
});

test('the button that was tapped is the one that reads Saving: Don\'t send', async () => {
  let release;
  await toNotifyStep({ patch: () => new Promise((resolve) => { release = () => resolve({ data: { notifications: [] } }); }) });
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  expect(await screen.findByRole('button', { name: 'Saving' })).toHaveClass('m-act-primary');
  expect(screen.getByRole('button', { name: 'Send the update' })).toBeDisabled();
  release();
  await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
});

test('the notify buttons arm a moment after the step opens, so a double tap on Confirm sends nothing', async () => {
  const { onSaved } = await toNotifyStep({}, { armDelayMs: 100 });
  // The second tap of a double tap on Confirm, landing as the step opens.
  fireEvent.click(screen.getByRole('button', { name: 'Send the update' }));
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 20); }); });
  expect(api.patch).not.toHaveBeenCalled();
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 150); }); });
  fireEvent.click(screen.getByRole('button', { name: 'Send the update' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.patch).toHaveBeenCalledTimes(1);
});

test('the notify buttons arm again each time the step opens', async () => {
  await toNotifyStep({}, { armDelayMs: 100 });
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 150); }); });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByText('Notify the client?');
  fireEvent.click(screen.getByRole('button', { name: 'Send the update' }));
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 20); }); });
  expect(api.patch).not.toHaveBeenCalled();
});

test('the server\'s autopay notice shows in the step', async () => {
  const autopay = 'Your card will auto-charge the remaining balance on Thursday, August 8, 2999.';
  await toNotifyStep({ notices: [{ ...NOTICE, autopay_notice: autopay }] });
  expect(screen.getByText(autopay)).toBeInTheDocument();
});

test('staff only: Don\'t send with the staff ticked carries the staff choice and no client notice', async () => {
  const { onSaved } = await toNotifyStep();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Notify assigned staff' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Text (SMS), assigned staff' }));
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.patch.mock.calls[0][1]).toMatchObject({
    notify: [], notify_assigned_staff: true, notify_staff_sms: true, notify_staff_email: false,
  });
});

test('with no delay passed in, the notify buttons start held (the 500ms default the detail page gets)', async () => {
  await toNotifyStep({}, { armDelayMs: undefined });
  expect(screen.getByRole('button', { name: 'Send the update' })).toBeDisabled();
  expect(screen.getByRole('button', { name: "Don't send" })).toBeDisabled();
});

// ---- Fleet fold (lane ma-e3, 2026-10-06) ----
const CURFEW_NO = { status: 400, message: 'Please fix the errors below', fieldErrors: { past_curfew: 'true', event_duration_hours: 'This booking ends at 2:30 AM, past the 2:00 AM curfew.' } };
const CURFEW_SENTENCE = 'This booking ends at 2:30 AM, past the 2:00 AM curfew. Book it anyway? This will be recorded.';
const css = fs.readFileSync(path.resolve(__dirname, '../../index.css'), 'utf8');

// Item 1 (P-I1, D-I1): the total block never leaves while a figure is on its way.
test('while the next figure loads the last one stays, dimmed, and Confirm waits for the new one', async () => {
  serve();
  const asks = [];
  const served = api.post.getMockImplementation();
  api.post.mockImplementation((url, body, config) => (url === '/proposals/calculate'
    ? new Promise((resolve) => { asks.push({ guests: body.guest_count, resolve }); })
    : served(url, body, config)));
  const ask = (guests) => asks.filter((a) => a.guests === guests).pop();
  // eslint-disable-next-line testing-library/no-node-access
  const block = () => screen.getByText('New total').closest('.m-edit-total').parentElement;
  mount();
  await ready();
  await waitFor(() => expect(ask(140)).toBeDefined());
  await act(async () => { ask(140).resolve({ data: { total: 3650, gratuity: { total: 120 } } }); });
  expect(screen.queryByText('New total')).toBeNull();
  // The first change, before any figure describes it: the stored total and an ellipsis, dimmed.
  more('More guests');
  expect(screen.getByText('New total')).toBeInTheDocument();
  expect(screen.getByText(String.fromCharCode(0x2026))).toBeInTheDocument();
  expect(block()).toHaveClass('m-edit-total-stale');
  expect(block()).toHaveAttribute('aria-busy', 'true');
  expect(confirmBtn()).toHaveTextContent('Confirm new total');
  expect(confirmBtn()).toBeDisabled();
  await waitFor(() => expect(ask(145)).toBeDefined());
  await act(async () => { ask(145).resolve({ data: { total: 3800, gratuity: { total: 120 } } }); });
  expect(screen.getByText('$3,800.00')).toBeInTheDocument();
  expect(block()).not.toHaveClass('m-edit-total-stale');
  expect(confirmBtn()).toBeEnabled();
  // A further step: the figure that landed stays, with its balance line, dimmed, until the next lands.
  more('More guests');
  expect(screen.getByText('$3,800.00')).toBeInTheDocument();
  expect(screen.getByText('balance due becomes $1,900.00')).toBeInTheDocument();
  expect(block()).toHaveClass('m-edit-total-stale');
  expect(confirmBtn()).toHaveTextContent('Confirm new total');
  expect(confirmBtn()).toBeDisabled();
  await waitFor(() => expect(ask(150)).toBeDefined());
  await act(async () => { ask(150).resolve({ data: { total: 3900, gratuity: { total: 120 } } }); });
  expect(screen.getByText('$3,900.00')).toBeInTheDocument();
  expect(screen.queryByText('$3,800.00')).toBeNull();
  expect(block()).not.toHaveClass('m-edit-total-stale');
  expect(confirmBtn()).toBeEnabled();
  // Back to the stored values: nothing changed, so no block, and Done closes.
  more('Fewer guests');
  more('Fewer guests');
  expect(screen.queryByText('New total')).toBeNull();
  expect(confirmBtn()).toHaveTextContent('Done');
  expect(confirmBtn()).toBeEnabled();
});

test('the edit sheet keeps one height, so a figure that loads, lands or leaves never moves the steppers', async () => {
  serve();
  mount();
  await ready();
  expect(screen.getByRole('dialog', { name: 'Edit details' })).toHaveClass('m-sheet', 'm-edit-sheet');
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-sheet\.m-edit-sheet \{ height: 80dvh; \}/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-edit-total-stale \{ opacity: 0\.5; \}/);
});

// Item 2 (P-I2): a read that hangs fails visibly.
test('a preview that never answers becomes the failure line with Retry once the read timeout passes', async () => {
  jest.useFakeTimers();
  serve();
  // As axios does: no answer within the timeout fails with no response (api.js
  // maps that to status 0). A request sent without a timeout hangs for ever.
  const served = api.post.getMockImplementation();
  api.post.mockImplementation((url, body, config) => {
    if (url !== '/proposals/calculate') return served(url, body, config);
    return new Promise((resolve, reject) => {
      if (config && config.timeout) setTimeout(() => reject(NETWORK), config.timeout);
    });
  });
  mount();
  await ready();
  more('More guests');
  await act(async () => { jest.advanceTimersByTime(READ_TIMEOUT_MS - 50); });
  expect(screen.queryByText("Couldn't price the change.")).toBeNull();
  await act(async () => { jest.advanceTimersByTime(100); });
  expect(screen.getByText("Couldn't price the change.")).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  expect(confirmBtn()).toBeDisabled();
});

// Item 3 (U-I1, U-M5): what goes wrong after Confirm is brought into view, and takes focus.
test('the curfew confirm is brought into view, its safe button takes focus, and Book it anyway is the danger-outlined confirm', async () => {
  serve({ patch: () => Promise.reject(CURFEW_NO) });
  mount();
  await ready();
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  const keep = await screen.findByRole('button', { name: 'Keep editing' });
  await waitFor(() => expect(keep).toHaveFocus());
  // eslint-disable-next-line testing-library/no-node-access
  expect(scrolled).toContain(keep.closest('.m-confirm'));
  // U-M12: the house inline confirm (AssignmentSheet), quiet safe button beside a danger-outlined one.
  expect(keep).toHaveClass('m-act', 'm-act-quiet');
  expect(screen.getByRole('button', { name: 'Book it anyway' })).toHaveClass('m-act', 'm-act-confirm');
  expect(screen.getByRole('button', { name: 'Book it anyway' })).not.toHaveClass('m-act-primary');
});

test('the stale notice is brought into view, and Reload takes focus', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }), reread: { ...PROPOSAL, updated_at: '2999-07-01T10:05:00.000Z' } });
  mount();
  await ready();
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  const reload = await screen.findByRole('button', { name: 'Reload' });
  await waitFor(() => expect(reload).toHaveFocus());
  // eslint-disable-next-line testing-library/no-node-access
  expect(scrolled).toContain(reload.closest('.m-sheet-note'));
});

test('a failed save in the notify step is said above "Notify the client?", brought into view and focused', async () => {
  await toNotifyStep({ patch: () => Promise.reject({ status: 400, message: 'Please fix the errors below', fieldErrors: { notify: 'The text message is too long.' } }) });
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  const line = await screen.findByText('The text message is too long.');
  // eslint-disable-next-line testing-library/no-node-access
  const box = line.closest('.m-fail');
  const head = screen.getByRole('heading', { name: 'Notify the client?' });
  // eslint-disable-next-line no-bitwise
  expect(box.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The scroll runs in an effect after the line renders: wait for it.
  await waitFor(() => expect(scrolled).toContain(box));
  await waitFor(() => expect(box).toHaveFocus());
});

test('a failed save in the edit view is brought into view and focused', async () => {
  serve({ patch: () => Promise.reject({ status: 400, message: 'Please fix the errors below', fieldErrors: { guest_count: 'Hosted packages require at least 25 guests' } }) });
  mount();
  await ready();
  more('Fewer guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  // eslint-disable-next-line testing-library/no-node-access
  const box = (await screen.findByText('Hosted packages require at least 25 guests')).closest('.m-fail');
  // The scroll runs in an effect after the line renders: wait for it.
  await waitFor(() => expect(scrolled).toContain(box));
  await waitFor(() => expect(box).toHaveFocus());
});

test('the notify step takes focus on its heading as it opens, and Cancel returns focus to Confirm', async () => {
  await toNotifyStep();
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Notify the client?' })).toHaveFocus());
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(confirmBtn()).toHaveFocus());
});

// Item 4 (U-M6): Escape in the notify step steps back, as the desktop popup's does.
test('Escape in the notify step steps back to the edit view with the change kept; Escape in the edit view closes', async () => {
  const { onClose } = await toNotifyStep();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByText('Notify the client?')).toBeNull();
  expect(screen.getByText('THU AUG 22 2999')).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
  expect(api.patch).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Escape and the scrim do nothing in the notify step while a save is in flight', async () => {
  let release;
  const { onClose } = await toNotifyStep({ patch: () => new Promise((resolve) => { release = () => resolve({ data: { notifications: [] } }); }) });
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  await screen.findByRole('button', { name: 'Saving' });
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.getByText('Notify the client?')).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { release(); });
});

// Fold follow-up (concern 3, accepted): the scrim does what Escape does. In the
// notify step a stray tap outside steps back and keeps the edits, as the
// desktop popup's backdrop does; in the edit view it still closes the sheet.
test('the scrim in the notify step steps back to the edit view with the change kept and nothing sent; in the edit view it closes the sheet', async () => {
  const { onClose } = await toNotifyStep();
  const asked = { get: api.get.mock.calls.length, post: api.post.mock.calls.length };
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByText('Notify the client?')).toBeNull();
  expect(screen.getByText('THU AUG 22 2999')).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
  expect(api.get.mock.calls).toHaveLength(asked.get);
  expect(api.post.mock.calls).toHaveLength(asked.post);
  expect(api.patch).not.toHaveBeenCalled();
  await waitFor(() => expect(confirmBtn()).toHaveFocus());
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(api.patch).not.toHaveBeenCalled();
});

test('Escape does nothing in the edit view while a save is in flight', async () => {
  let release;
  serve({
    calculate: () => ({ total: 3800, gratuity: { total: 120 } }),
    patch: () => new Promise((resolve) => { release = () => resolve({ data: { notifications: [] } }); }),
  });
  const { onClose } = mount();
  await ready();
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByRole('button', { name: 'Saving' });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { release(); });
});

// Item 5 (S-M1, D-M1): a curfew refusal after "Send the update" says the notice still rides.
test('a curfew refusal after Send the update says the notice still rides, and Book it anyway carries the held notice and staff choice', async () => {
  let calls = 0;
  const { onSaved } = await toNotifyStep({ patch: () => { calls += 1; return calls === 1 ? Promise.reject(CURFEW_NO) : Promise.resolve({ data: { notifications: [] } }); } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Notify assigned staff' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Email, assigned staff' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send the update' }));
  expect(await screen.findByText('Your update to the client and the assigned staff goes out with it.')).toBeInTheDocument();
  expect(screen.getByText(CURFEW_SENTENCE)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Book it anyway' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.patch).toHaveBeenCalledTimes(2);
  const [first, second] = api.patch.mock.calls.map((c) => c[1]);
  expect(second.acknowledge_past_curfew).toBe(true);
  expect(second.notify).toEqual(first.notify);
  expect(second.notify).toEqual([expect.objectContaining({ type: 'event_details_changed', channels: ['email', 'sms'] })]);
  expect(second).toMatchObject({ notify_assigned_staff: true, notify_staff_sms: false, notify_staff_email: true });
});

test('a curfew refusal after Don\'t send with the staff ticked says the staff update still rides', async () => {
  let calls = 0;
  const { onSaved } = await toNotifyStep({ patch: () => { calls += 1; return calls === 1 ? Promise.reject(CURFEW_NO) : Promise.resolve({ data: { notifications: [] } }); } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Notify assigned staff' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Text (SMS), assigned staff' }));
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  expect(await screen.findByText('Your update to the assigned staff goes out with it.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Book it anyway' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.patch.mock.calls[1][1]).toMatchObject({ acknowledge_past_curfew: true, notify: [], notify_assigned_staff: true, notify_staff_sms: true });
});

// Item 6 (S-M2): the changed-meanwhile guard fails closed.
test('an event read that carries no updated_at is treated as moved: nothing is saved', async () => {
  const bare = { ...PROPOSAL };
  delete bare.updated_at;
  serve({ proposal: bare, calculate: () => ({ total: 3800, gratuity: { total: 120 } }) });
  mount();
  await ready();
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  expect(await screen.findByText('This event changed since you opened it.')).toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();
});

// Item 9 (D-M2): four guards no test held, each shown to fail on its mutation.
test('an acknowledged retry refused for the curfew again shows the reason and never reopens the confirm', async () => {
  serve({ patch: () => Promise.reject(CURFEW_NO) });
  mount();
  await ready();
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  fireEvent.click(await screen.findByRole('button', { name: 'Book it anyway' }));
  expect(await screen.findByText('This booking ends at 2:30 AM, past the 2:00 AM curfew.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Book it anyway' })).toBeNull();
  expect(api.patch).toHaveBeenCalledTimes(2);
  expect(api.patch.mock.calls[1][1].acknowledge_past_curfew).toBe(true);
});

test('the staff channels stay disabled, and dimmed, until Notify assigned staff is ticked', async () => {
  await toNotifyStep();
  const text = screen.getByRole('checkbox', { name: 'Text (SMS), assigned staff' });
  const email = screen.getByRole('checkbox', { name: 'Email, assigned staff' });
  expect(text).toBeDisabled();
  expect(email).toBeDisabled();
  // eslint-disable-next-line testing-library/no-node-access
  expect(text.closest('.m-notify-sub')).toHaveClass('m-notify-sub-off');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Notify assigned staff' }));
  expect(text).toBeEnabled();
  expect(email).toBeEnabled();
  // eslint-disable-next-line testing-library/no-node-access
  expect(text.closest('.m-notify-sub')).not.toHaveClass('m-notify-sub-off');
});

test('the staff choice starts off again each time the notify step opens', async () => {
  await toNotifyStep();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Notify assigned staff' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Text (SMS), assigned staff' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByText('Notify the client?');
  expect(screen.getByRole('checkbox', { name: 'Notify assigned staff' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Text (SMS), assigned staff' })).not.toBeChecked();
});

test('Confirm stays disabled while the curfew confirm is open', async () => {
  serve({ patch: () => Promise.reject({ status: 400, fieldErrors: { past_curfew: 'true' } }) });
  mount();
  await ready();
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByRole('button', { name: 'Book it anyway' });
  expect(confirmBtn()).toBeDisabled();
});

// Item 11 (U-M1, U-M3, U-M4, U-M13).
test('a step announces the new value', async () => {
  serve();
  mount();
  await ready();
  expect(screen.getByText('4 hr')).toHaveAttribute('aria-live', 'polite');
  expect(screen.getByText('140')).toHaveAttribute('aria-live', 'polite');
});

test('the stylesheet: the light stepper keeps its corners, the staff channels dim while off, the autopay notice is tinted as a warning', () => {
  expect(css).not.toMatch(/\[data-skin="light"\][^{]*\.m-stepper-ctl[^{]*\{[^}]*border-radius: 0/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-notify-sub\.m-notify-sub-off \{ opacity: 0\.45; \}/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-notify-sub\.m-notify-sub-off \.m-notify-check \{ cursor: default; \}/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-notify-autopay \{[^}]*background: hsl\(var\(--warn-h\) var\(--warn-s\)/);
  expect(css).toMatch(/html\[data-app="admin-os"\]\[data-skin="light"\] \.m-notify-autopay \{[^}]*background: hsl\(var\(--warn-h\) var\(--warn-s\)/);
});

// Fold round D (re-review P1): with the body scrolled, a prompt that leaves or
// a total that returns to the stored values used to shorten the content, the
// scroll clamped, and the steppers slid under the finger. The content's floor
// (its min-height) is the tallest it has been since the sheet opened.
test('the body content never shrinks while the sheet is open: its floor only rises, and starts again when the sheet opens', async () => {
  // jsdom has no layout. Here the content's natural height is how many
  // elements it holds, so it grows and shrinks with what the sheet shows; as
  // in a browser, its box is never shorter than its min-height.
  const realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (!this.classList || !this.classList.contains('m-edit-content')) return realRect.call(this);
    // eslint-disable-next-line testing-library/no-node-access
    const height = Math.max(this.querySelectorAll('*').length, parseFloat(this.style.minHeight) || 0);
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height };
  };
  try {
    serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }), patch: () => Promise.reject(CURFEW_NO) });
    mount();
    await ready();
    // eslint-disable-next-line testing-library/no-node-access
    const content = () => screen.getByRole('dialog', { name: 'Edit details' }).querySelector('.m-edit-content');
    // eslint-disable-next-line testing-library/no-node-access
    const natural = () => content().querySelectorAll('*').length;
    const floor = () => parseFloat(content().style.minHeight) || 0;
    const floors = [floor()];
    more('Longer');
    await waitFor(() => expect(confirmBtn()).toBeEnabled());   // the block shows: taller
    floors.push(floor());
    fireEvent.click(confirmBtn());
    await screen.findByRole('button', { name: 'Keep editing' });   // the curfew confirm: taller still
    floors.push(floor());
    const tallest = floor();
    expect(tallest).toBe(natural());
    // One step back withdraws the confirm and returns to the stored values: the content shrinks.
    more('Shorter');
    expect(screen.queryByRole('button', { name: 'Keep editing' })).toBeNull();
    expect(screen.queryByText('New total')).toBeNull();
    floors.push(floor());
    expect(natural()).toBeLessThan(tallest);
    expect(floor()).toBe(tallest);
    for (let i = 1; i < floors.length; i += 1) expect(floors[i]).toBeGreaterThanOrEqual(floors[i - 1]);
    expect(floors[0]).toBeGreaterThan(0);
    expect(tallest).toBeGreaterThan(floors[0]);
    // A new opening measures afresh.
    cleanup();
    serve();
    mount();
    await ready();
    expect(floor()).toBe(natural());
    expect(floor()).toBeLessThan(tallest);
  } finally {
    Element.prototype.getBoundingClientRect = realRect;
  }
});

test('back from the notify step, the edit view is scrolled where it was, so the steppers come back where they were', async () => {
  serve({ notices: [NOTICE] });
  const { onClose } = mount();
  await ready();
  // jsdom keeps no scroll position: give the body one.
  // eslint-disable-next-line testing-library/no-node-access
  const body = screen.getByRole('dialog', { name: 'Edit details' }).querySelector('.m-sheet-body');
  let top = 0;
  Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => top, set: (v) => { top = v; } });
  top = 120;   // the admin scrolled the edit view down
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2999-08-22' } });
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByText('Notify the client?');
  top = 340;   // and scrolled the notify step down to its staff choices
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByText('THU AUG 22 2999')).toBeInTheDocument();
  expect(top).toBe(120);
  // The scrim and Escape step back the same way.
  fireEvent.click(confirmBtn());
  await screen.findByText('Notify the client?');
  top = 500;
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(top).toBe(120);
  expect(onClose).not.toHaveBeenCalled();
});

// Fold round E (re-review D, P1): leaving the ready phase (a reload, a failed
// load, a lock) drops the floor and puts the body back at its top, so what
// loads is in view; the floor then starts again from the new content.
const MOVED = { ...PROPOSAL, updated_at: '2999-07-01T10:05:00.000Z', guest_count: 150 };
async function toStaleNotice(reloadRead) {
  let reads = 0;
  api.get.mockImplementation((url) => {
    if (url === '/proposals/13') {
      reads += 1;
      if (reads === 1) return Promise.resolve({ data: PROPOSAL });
      if (reads === 2) return Promise.resolve({ data: MOVED });   // the re-read before the PATCH: moved
      return reloadRead();
    }
    if (url === '/proposals/packages') return Promise.resolve({ data: [PKG] });
    if (url === '/proposals/addons') return Promise.resolve({ data: [BARBACK] });
    return Promise.reject({ status: 404 });
  });
  api.post.mockImplementation((url) => (url === '/proposals/calculate'
    ? Promise.resolve({ data: { total: 3800, gratuity: { total: 120 } } })
    : Promise.resolve({ data: { notices: [] } })));
  mount();
  await ready();
  const dialog = screen.getByRole('dialog', { name: 'Edit details' });
  // eslint-disable-next-line testing-library/no-node-access
  const content = dialog.querySelector('.m-edit-content');
  // eslint-disable-next-line testing-library/no-node-access
  const body = dialog.querySelector('.m-sheet-body');
  // jsdom keeps no scroll position: give the body one.
  const scroll = { top: 0 };
  Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => scroll.top, set: (v) => { scroll.top = v; } });
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByRole('button', { name: 'Reload' });
  scroll.top = 337;   // the notice brought into view at the foot of a scrolled body
  return {
    scroll,
    floor: () => parseFloat(content.style.minHeight) || 0,
    // eslint-disable-next-line testing-library/no-node-access
    natural: () => content.querySelectorAll('*').length,
  };
}
// jsdom has no layout: the content's natural height is the number of elements
// it holds, and, as in a browser, its box is never shorter than its min-height.
function withCountedHeights(run) {
  const realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (!this.classList || !this.classList.contains('m-edit-content')) return realRect.call(this);
    // eslint-disable-next-line testing-library/no-node-access
    const height = Math.max(this.querySelectorAll('*').length, parseFloat(this.style.minHeight) || 0);
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height };
  };
  return Promise.resolve().then(run).finally(() => { Element.prototype.getBoundingClientRect = realRect; });
}

test('Reload from the stale notice drops the floor and puts the body back at its top; the floor starts again from what loads', () => withCountedHeights(async () => {
  let land;
  const s = await toStaleNotice(() => new Promise((resolve) => { land = () => resolve({ data: MOVED }); }));
  const tallest = s.floor();
  expect(tallest).toBe(s.natural());
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  // While it loads: back at the top, and the floor is the loading line's, not the old one.
  expect(screen.getByText('Loading the event')).toBeInTheDocument();
  expect(s.scroll.top).toBe(0);
  expect(s.floor()).toBe(s.natural());
  expect(s.floor()).toBeLessThan(tallest);
  // The fresh form: still at the top, its floor measured from itself.
  await act(async () => { land(); });
  expect(await screen.findByText('150')).toBeInTheDocument();
  expect(s.scroll.top).toBe(0);
  expect(s.floor()).toBe(s.natural());
  expect(s.floor()).toBeLessThan(tallest);
}));

test('a failed reload\'s line and Retry, and the locked message, are not left under a stale floor', () => withCountedHeights(async () => {
  for (const [reloadRead, says] of [
    [() => Promise.reject(NETWORK), "Couldn't load this event. Editing needs a connection."],
    [() => Promise.resolve({ data: { ...MOVED, status: 'completed' } }), 'This event can no longer be edited here. Use desktop view.'],
  ]) {
    const s = await toStaleNotice(reloadRead);
    const tallest = s.floor();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText(says)).toBeInTheDocument();
    expect(s.scroll.top).toBe(0);
    expect(s.floor()).toBe(s.natural());
    expect(s.floor()).toBeLessThan(tallest);
    cleanup();
  }
}));

// Fold round F (re-review E, P1): one arm for the whole sheet. Every time the
// sheet swaps the view under the finger, the new view's controls (and the scrim
// and Escape) wait armDelayMs, because the second tap of a double tap lands on
// whatever replaced the first tap's target.
test('a double tap on Reload: the reloaded form holds its controls, so the second tap changes nothing', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }), reread: { ...PROPOSAL, updated_at: '2999-07-01T10:05:00.000Z' } });
  mount({ armDelayMs: 300 });
  await ready();
  await waitFor(() => expect(screen.getByRole('button', { name: 'More guests' })).toBeEnabled());
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  fireEvent.click(await screen.findByRole('button', { name: 'Reload' }));
  expect(screen.getByText('Loading the event')).toBeInTheDocument();
  await screen.findByText('Duration');   // the reload landed at once
  // The second tap lands on More guests, where Reload was (320x568, the tallest form).
  expect(screen.getByRole('button', { name: 'More guests' })).toBeDisabled();
  more('More guests');
  expect(screen.getByText('140')).toBeInTheDocument();
  expect(confirmBtn()).toHaveTextContent('Done');
  // Armed, the form takes taps again.
  await waitFor(() => expect(screen.getByRole('button', { name: 'More guests' })).toBeEnabled());
  more('More guests');
  expect(screen.getByText('145')).toBeInTheDocument();
});

test('a double tap on the notify step\'s Cancel steps back once: the form\'s Cancel is held, the sheet stays open, and Confirm takes focus once armed', async () => {
  const { onClose } = await toNotifyStep({}, { armDelayMs: 300 });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));   // back to the form
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));   // the second tap: the form's Cancel
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByText('THU AUG 22 2999')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await waitFor(() => expect(confirmBtn()).toHaveFocus());
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('the form\'s first ready render holds its controls, the scrim and Escape for the arm, then takes taps', async () => {
  serve();
  const { onClose } = mount({ armDelayMs: 300 });
  await ready();
  const controls = () => [
    screen.getByLabelText('Date'), screen.getByLabelText('Start'),
    ...['Shorter', 'Longer', 'Fewer guests', 'More guests', 'Cancel'].map((name) => screen.getByRole('button', { name })),
    confirmBtn(),
  ];
  for (const el of controls()) expect(el).toBeDisabled();
  more('More guests');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByText('140')).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  for (const el of controls()) expect(el).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('a double tap on the scrim in the notify step steps back once, and the sheet stays open', async () => {
  const { onClose } = await toNotifyStep({}, { armDelayMs: 300 });
  await waitFor(() => expect(screen.getByRole('button', { name: "Don't send" })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByText('Notify the client?')).toBeNull();
  expect(screen.getByText('THU AUG 22 2999')).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});

test('a curfew refusal after a send swaps back to the form: its buttons are held, then Keep editing takes focus', async () => {
  let calls = 0;
  await toNotifyStep({ patch: () => { calls += 1; return calls === 1 ? Promise.reject(CURFEW_NO) : Promise.resolve({ data: { notifications: [] } }); } }, { armDelayMs: 300 });
  await waitFor(() => expect(screen.getByRole('button', { name: "Don't send" })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  const keep = await screen.findByRole('button', { name: 'Keep editing' });
  expect(keep).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Book it anyway' })).toBeDisabled();
  await waitFor(() => expect(keep).toHaveFocus());
  expect(keep).toBeEnabled();
});

// Fold round G (re-review F, P1): the arm's end moves focus, never the scroll.
// The curfew confirm or the stale notice is scrolled into view once, as it
// appears; its safe button takes focus once the view is armed, and a scroll
// made inside the arm stays where the finger left it.
const settle = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50); }); });

test('after a curfew refusal from the notify step, the confirm is scrolled into view once, and the arm\'s end only moves focus to Keep editing', async () => {
  let calls = 0;
  await toNotifyStep({ patch: () => { calls += 1; return calls === 1 ? Promise.reject(CURFEW_NO) : Promise.resolve({ data: { notifications: [] } }); } }, { armDelayMs: 300 });
  await waitFor(() => expect(screen.getByRole('button', { name: "Don't send" })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  const keep = await screen.findByRole('button', { name: 'Keep editing' });
  expect(keep).toBeDisabled();
  const focusing = jest.spyOn(keep, 'focus');
  // eslint-disable-next-line testing-library/no-node-access
  const box = keep.closest('.m-confirm');
  await waitFor(() => expect(scrolled).toContain(box));
  await waitFor(() => expect(keep).toHaveFocus());
  expect(keep).toBeEnabled();
  await settle();
  expect(scrolled.filter((el) => el === box)).toHaveLength(1);
  // The focus itself scrolls nothing either.
  expect(focusing).toHaveBeenCalledTimes(1);
  expect(focusing).toHaveBeenCalledWith({ preventScroll: true });
});

test('after the event moved while the notify step was open, Reload is held, the notice is scrolled into view once, and Reload takes focus once armed', async () => {
  await toNotifyStep({ reread: { ...PROPOSAL, updated_at: '2999-07-01T10:09:00.000Z' } }, { armDelayMs: 300 });
  await waitFor(() => expect(screen.getByRole('button', { name: "Don't send" })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  const reload = await screen.findByRole('button', { name: 'Reload' });
  expect(reload).toBeDisabled();
  const focusing = jest.spyOn(reload, 'focus');
  // eslint-disable-next-line testing-library/no-node-access
  const box = reload.closest('.m-sheet-note');
  await waitFor(() => expect(scrolled).toContain(box));
  await waitFor(() => expect(reload).toHaveFocus());
  expect(reload).toBeEnabled();
  await settle();
  expect(scrolled.filter((el) => el === box)).toHaveLength(1);
  expect(focusing).toHaveBeenCalledTimes(1);
  expect(focusing).toHaveBeenCalledWith({ preventScroll: true });
  expect(api.patch).not.toHaveBeenCalled();
});

// Fold round G (re-review F, minor): nothing but a swap arms. With the arm on,
// at its 500ms default, a figure landing, an error line appearing, or a step
// that withdraws the curfew confirm leaves every control taking taps at once.
const ARMED = { timeout: 3000 };
const formControls = () => [
  screen.getByLabelText('Date'), screen.getByLabelText('Start'),
  ...['Shorter', 'Longer', 'Fewer guests', 'More guests', 'Cancel'].map((name) => screen.getByRole('button', { name })),
  confirmBtn(),
];

test('with the arm on, a figure landing leaves every control taking taps', async () => {
  serve();
  const asks = [];
  const served = api.post.getMockImplementation();
  api.post.mockImplementation((url, body, config) => (url === '/proposals/calculate'
    ? new Promise((resolve) => { asks.push({ guests: body.guest_count, resolve }); })
    : served(url, body, config)));
  const ask = (guests) => asks.filter((a) => a.guests === guests).pop();
  mount({ armDelayMs: undefined });
  await ready();
  await waitFor(() => expect(ask(140)).toBeDefined());
  await act(async () => { ask(140).resolve({ data: { total: 3650, gratuity: { total: 120 } } }); });
  await waitFor(() => expect(confirmBtn()).toBeEnabled(), ARMED);
  more('More guests');
  await waitFor(() => expect(ask(145)).toBeDefined());
  await act(async () => { ask(145).resolve({ data: { total: 3800, gratuity: { total: 120 } } }); });
  expect(screen.getByText('$3,800.00')).toBeInTheDocument();
  await settle();
  for (const el of formControls()) expect(el).toBeEnabled();
});

test('with the arm on, an error line appearing leaves every control taking taps', async () => {
  serve({ patch: () => Promise.reject({ status: 400, message: 'Please fix the errors below', fieldErrors: { guest_count: 'Hosted packages require at least 25 guests' } }) });
  mount({ armDelayMs: undefined });
  await ready();
  await waitFor(() => expect(confirmBtn()).toBeEnabled(), ARMED);
  more('Fewer guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByText('Hosted packages require at least 25 guests');
  await settle();
  for (const el of formControls()) expect(el).toBeEnabled();
});

test('with the arm on, a curfew refusal straight from Confirm, and a step that withdraws it, leave every control taking taps', async () => {
  serve({ patch: () => Promise.reject(CURFEW_NO) });
  mount({ armDelayMs: undefined });
  await ready();
  await waitFor(() => expect(confirmBtn()).toBeEnabled(), ARMED);
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  const keep = await screen.findByRole('button', { name: 'Keep editing' });
  await settle();
  // No swap brought it: its buttons take taps at once, and Keep editing has focus.
  expect(keep).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Book it anyway' })).toBeEnabled();
  expect(keep).toHaveFocus();
  more('Shorter');   // withdraws the confirm
  expect(screen.queryByRole('button', { name: 'Keep editing' })).toBeNull();
  await settle();
  for (const el of formControls()) expect(el).toBeEnabled();
});

// Fold round G (Dallas): the notify footer in two rows, so no label wraps.
// Cancel and "Send the update" share the first; "Don't send" spans the second
// and stays last in reading order. The edit view's footer keeps its one row.
test('the notify footer: Cancel and Send the update share the first row, Don\'t send spans the second, and no label wraps', async () => {
  await toNotifyStep();
  // eslint-disable-next-line testing-library/no-node-access
  const footer = screen.getByRole('button', { name: "Don't send" }).parentElement;
  expect(footer).toHaveClass('m-acts', 'm-acts-notify');
  // eslint-disable-next-line testing-library/no-node-access
  expect([...footer.children].map((b) => b.textContent)).toEqual(['Cancel', 'Send the update', "Don't send"]);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-acts\.m-acts-notify \{ display: grid; grid-template-columns: 1fr 1fr; \}/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-acts\.m-acts-notify \.m-act \{ white-space: nowrap; \}/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-acts\.m-acts-notify \.m-act-primary \{ grid-column: 1 \/ -1; \}/);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  // eslint-disable-next-line testing-library/no-node-access
  expect(confirmBtn().parentElement).toHaveClass('m-acts');
  // eslint-disable-next-line testing-library/no-node-access
  expect(confirmBtn().parentElement).not.toHaveClass('m-acts-notify');
});
