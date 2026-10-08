import React from 'react';
import fs from 'fs';
import path from 'path';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import EditSheet from './EditSheet';
import api from '../../utils/api';
import { READ_TIMEOUT_MS, PENDING_FIGURE } from '../../utils/editSheetView';

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
// A sheet mounted with an arm holds the screen's taps as it unmounts: its guard
// lands on document.body one tick after RTL's cleanup (which runs first) and
// stays for armDelayMs. Wait that tick and take it down, so no test starts
// under the last one's guard.
afterEach(async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  // eslint-disable-next-line testing-library/no-node-access
  document.body.querySelectorAll('.m-tap-guard').forEach((g) => g.remove());
});

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

test('the head, the readout, its notices, then Date, Start, Duration and Guests, then the footer; Setup is the line under Start', async () => {
  serve();
  mount();
  await ready();
  const dialog = screen.getByRole('dialog', { name: 'Edit details' });
  // eslint-disable-next-line testing-library/no-node-access
  expect([...dialog.children].map((el) => el.className)).toEqual(['m-sheet-handle', 'm-sheet-head', 'm-edit-readout', 'm-edit-notices', 'm-edit-rows', 'm-acts m-edit-acts']);
  // eslint-disable-next-line testing-library/no-node-access
  expect(dialog.querySelector('.m-edit-notices').children).toHaveLength(0);
  // eslint-disable-next-line testing-library/no-node-access
  const names = [...dialog.querySelector('.m-edit-rows').children].map((row) => row.querySelector('.m-edit-label').firstChild.textContent);
  expect(names).toEqual(['Date', 'Start', 'Duration', 'Guests']);
  expect(screen.getByText('event edit · reprices the booking')).toBeInTheDocument();
  expect(screen.getByText('THU AUG 15 2999')).toBeInTheDocument();
  expect(screen.getByLabelText('Start')).toHaveValue('19:00');
  expect(screen.getByText('setup 45 min before')).toBeInTheDocument();
  expect(screen.queryByText('Setup')).toBeNull();
  expect(screen.getByText('4 hr')).toBeInTheDocument();
  expect(screen.getByText('140')).toBeInTheDocument();
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
  expect(screen.getByText('Total')).toBeInTheDocument();
  expect(screen.getByText('$3,650.00')).toBeInTheDocument();
  expect(screen.getByText('paid $1,900.00 · balance due $1,750.00')).toBeInTheDocument();
  fireEvent.click(confirmBtn());
  expect(onClose).toHaveBeenCalled();
  expect(api.patch).not.toHaveBeenCalled();
});

test('a change asks the server for the new total and shows the booked lines', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }) });
  mount();
  await ready();
  more('More guests');
  // The readout says New total at once (three dots), then the figure lands in it.
  expect(await screen.findByText('$3,800.00')).toBeInTheDocument();
  expect(screen.getByText('New total')).toBeInTheDocument();
  expect(screen.getByText('$3,650.00')).toBeInTheDocument();
  expect(screen.getByText('balance due becomes $1,900.00')).toBeInTheDocument();
  expect(screen.getByText('Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.')).toBeInTheDocument();
  // Plain lines, no bullet indent (design pass 2026-10-06).
  expect(screen.getByText('Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.').tagName).toBe('P');
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
test('while the next figure loads the last one stays, dimmed under PRICING, and Confirm waits for the new one', async () => {
  serve();
  const asks = [];
  const served = api.post.getMockImplementation();
  api.post.mockImplementation((url, body, config) => (url === '/proposals/calculate'
    ? new Promise((resolve) => { asks.push({ guests: body.guest_count, resolve }); })
    : served(url, body, config)));
  const ask = (guests) => asks.filter((a) => a.guests === guests).pop();
  // eslint-disable-next-line testing-library/no-node-access
  const figure = () => screen.getByRole('dialog', { name: 'Edit details' }).querySelector('.m-edit-figure');
  mount();
  await ready();
  // Untouched: the stored booking at once, before the figure asked at open has landed.
  expect(screen.getByText('Total')).toBeInTheDocument();
  expect(screen.getByText('paid $1,900.00 · balance due $1,750.00')).toBeInTheDocument();
  await waitFor(() => expect(ask(140)).toBeDefined());
  await act(async () => { ask(140).resolve({ data: { total: 3650, gratuity: { total: 120 } } }); });
  // The first change, before any figure describes it: three dots under PRICING, nothing dimmed.
  more('More guests');
  expect(screen.getByText('New total')).toBeInTheDocument();
  expect(screen.getAllByText(PENDING_FIGURE)).toHaveLength(2);   // the figure and the balance line
  expect(screen.getByText('balance due becomes')).toBeInTheDocument();
  expect(screen.getByText('pricing')).toBeInTheDocument();
  expect(figure()).not.toHaveClass('m-edit-dim');
  expect(figure()).toHaveAttribute('aria-busy', 'true');
  expect(confirmBtn()).toHaveTextContent('Confirm new total');
  expect(confirmBtn()).toBeDisabled();
  await waitFor(() => expect(ask(145)).toBeDefined());
  await act(async () => { ask(145).resolve({ data: { total: 3800, gratuity: { total: 120 } } }); });
  expect(screen.getByText('$3,800.00')).toBeInTheDocument();
  expect(screen.queryByText('pricing')).toBeNull();
  expect(figure()).not.toHaveClass('m-edit-dim');
  expect(figure()).not.toHaveAttribute('aria-busy');
  expect(confirmBtn()).toBeEnabled();
  // A further step: the figure that landed stays, with its balance line, dimmed under PRICING.
  more('More guests');
  expect(screen.getByText('$3,800.00')).toBeInTheDocument();
  expect(screen.getByText('balance due becomes $1,900.00')).toBeInTheDocument();
  expect(screen.getByText('pricing')).toBeInTheDocument();
  expect(figure()).toHaveClass('m-edit-dim');
  expect(confirmBtn()).toBeDisabled();
  await waitFor(() => expect(ask(150)).toBeDefined());
  await act(async () => { ask(150).resolve({ data: { total: 3900, gratuity: { total: 120 } } }); });
  expect(screen.getByText('$3,900.00')).toBeInTheDocument();
  expect(figure()).not.toHaveClass('m-edit-dim');
  expect(confirmBtn()).toBeEnabled();
  // Back to the stored values: the readout reads Total again, and Done closes.
  more('Fewer guests');
  more('Fewer guests');
  expect(screen.getByText('Total')).toBeInTheDocument();
  expect(screen.queryByText('New total')).toBeNull();
  expect(confirmBtn()).toHaveTextContent('Done');
  expect(confirmBtn()).toBeEnabled();
});

// The spec's declared state for a first figure that fails: no figure has
// described the change, so the readout keeps its three dots, with no PRICING
// (nothing is on its way) and nothing dimmed (no figure to dim), and the
// failure with its Retry sits in the notices.
test('a first change whose figure fails before any figure lands: New total and its balance line keep three dots, no PRICING, nothing dimmed, and the failure with Retry in the notices', async () => {
  let failing = false;
  serve({ calculate: () => (failing ? { reject: NETWORK } : { total: 3650, gratuity: { total: 120 } }) });
  mount();
  await ready();
  // The figure asked at open, for the stored values, lands; the change's own fails.
  await waitFor(() => expect(api.post.mock.calls.filter(([u]) => u === '/proposals/calculate')).toHaveLength(1));
  failing = true;
  more('More guests');
  await screen.findByText("Couldn't price the change.");
  const dialog = screen.getByRole('dialog', { name: 'Edit details' });
  expect(screen.getByText('New total')).toBeInTheDocument();
  expect(screen.getAllByText(PENDING_FIGURE)).toHaveLength(2);   // the figure and the balance line
  expect(screen.getByText('balance due becomes')).toBeInTheDocument();
  expect(screen.queryByText('pricing')).toBeNull();
  // eslint-disable-next-line testing-library/no-node-access
  expect(dialog.querySelector('.m-edit-figure')).not.toHaveClass('m-edit-dim');
  // eslint-disable-next-line testing-library/no-node-access
  const notices = dialog.querySelector('.m-edit-notices');
  expect(notices).toContainElement(screen.getByText("Couldn't price the change."));
  expect(notices).toContainElement(screen.getByRole('button', { name: 'Retry' }));
});

test('the stylesheet: as tall as its content up to the screen less 12px (scrolling whole only when even that is too short, its overscroll contained), the notify step at the max, the copy scrolls but keeps its two top lines, the notices hold up to their cap and then scroll inside their strip, the rows and footer hold, a 68px value, a square light stepper, PRICING still under reduced motion', () => {
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-sheet\.m-edit-sheet \{ max-height: calc\(100dvh - 12px\); overflow-y: auto; overscroll-behavior: contain; \}/);
  expect(css).not.toMatch(/\.m-edit-sheet \{[^}]*(^|[^-])height:/m);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-sheet\.m-edit-sheet\.m-edit-notifying \{ height: calc\(100dvh - 12px\); \}/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-edit-readout \{[^}]*flex: 0 1 auto;[^}]*min-height: 58px;[^}]*overflow-y: auto;/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-edit-notices \{[^}]*flex: none; padding: 0 16px;[^}]*max-height: max\(104px, calc\(100dvh - 410px - env\(safe-area-inset-bottom, 0px\)\)\);[^}]*overflow-y: auto;\s*\}/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-edit-rows \{ flex: none; \}/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-acts\.m-edit-acts \{ flex: none; padding: 10px 16px 14px; border-top: 1px solid var\(--line-1\); \}/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-stepper-value \{[^}]*width: 68px;/);
  expect(css).toMatch(/\[data-skin="light"\] \.m-stepper-ctl \{ border-radius: 0; \}/);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.m-edit-pricing \{ animation: none; \}/);
  expect(css).not.toMatch(/m-edit-content|m-edit-total-stale|m-edit-static/);
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
test('the curfew confirm\'s button row is brought into view, its safe button takes focus, and Book it anyway is the danger-outlined confirm', async () => {
  serve({ patch: () => Promise.reject(CURFEW_NO) });
  mount();
  await ready();
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  const keep = await screen.findByRole('button', { name: 'Keep editing' });
  await waitFor(() => expect(keep).toHaveFocus());
  // eslint-disable-next-line testing-library/no-node-access
  expect(scrolled).toContain(keep.closest('.m-confirm-btns'));
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

test('the stylesheet: the staff channels dim while off, the autopay notice is tinted as a warning', () => {
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-notify-sub\.m-notify-sub-off \{ opacity: 0\.45; \}/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-notify-sub\.m-notify-sub-off \.m-notify-check \{ cursor: default; \}/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-notify-autopay \{[^}]*background: hsl\(var\(--warn-h\) var\(--warn-s\)/);
  expect(css).toMatch(/html\[data-app="admin-os"\]\[data-skin="light"\] \.m-notify-autopay \{[^}]*background: hsl\(var\(--warn-h\) var\(--warn-s\)/);
});

const MOVED = { ...PROPOSAL, updated_at: '2999-07-01T10:05:00.000Z', guest_count: 150 };

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
// The curfew confirm's button row or the stale notice is scrolled into view
// once, as it appears; its safe button takes focus once the view is armed, and
// a scroll made inside the arm stays where the finger left it.
const settle = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50); }); });

test('after a curfew refusal from the notify step, the confirm\'s button row is scrolled into view once, and the arm\'s end only moves focus to Keep editing', async () => {
  let calls = 0;
  await toNotifyStep({ patch: () => { calls += 1; return calls === 1 ? Promise.reject(CURFEW_NO) : Promise.resolve({ data: { notifications: [] } }); } }, { armDelayMs: 300 });
  await waitFor(() => expect(screen.getByRole('button', { name: "Don't send" })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  const keep = await screen.findByRole('button', { name: 'Keep editing' });
  expect(keep).toBeDisabled();
  const focusing = jest.spyOn(keep, 'focus');
  // eslint-disable-next-line testing-library/no-node-access
  const row = keep.closest('.m-confirm-btns');
  await waitFor(() => expect(scrolled).toContain(row));
  await waitFor(() => expect(keep).toHaveFocus());
  expect(keep).toBeEnabled();
  await settle();
  expect(scrolled.filter((el) => el === row)).toHaveLength(1);
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

// ma-e3b (design pass 2026-10-06): the sheet is as tall as its content, so a
// phase change moves its top edge, and the second tap of a double tap can land
// on the scrim. The sheet opening and every phase change arm too.
function serveStale(reloadRead) {
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
}
const pastTheArm = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 350); }); });
const aTick = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });

test('the sheet opening holds the scrim and Escape for the arm, while the event still loads', async () => {
  api.get.mockImplementation(() => new Promise(() => {}));   // the reads have not answered
  const { onClose } = mount({ armDelayMs: 300 });
  expect(screen.getByText('Loading the event')).toBeInTheDocument();
  // The second tap of a double tap on Edit details, on the scrim above a short sheet.
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  await pastTheArm();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Reload holds the scrim and Escape while the event reloads, so a double tap on Reload leaves the sheet open', async () => {
  serveStale(() => new Promise(() => {}));   // the reload has not answered
  const { onClose } = mount({ armDelayMs: 300 });
  await ready();
  await waitFor(() => expect(screen.getByRole('button', { name: 'More guests' })).toBeEnabled());
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  fireEvent.click(await screen.findByRole('button', { name: 'Reload' }));
  expect(screen.getByText('Loading the event')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  await pastTheArm();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('a failed load\'s Retry is held for the arm, then takes a tap', async () => {
  serve({ proposal: { reject: NETWORK } });
  mount({ armDelayMs: 300 });
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeDisabled();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled());
  serve();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await ready();
});

test('after a reload the fresh sheet takes focus, since the button that had it is gone', async () => {
  serveStale(() => Promise.resolve({ data: MOVED }));
  mount();
  await ready();
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  fireEvent.click(await screen.findByRole('button', { name: 'Reload' }));
  expect(await screen.findByText('150')).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Edit details' })).toHaveFocus();
});

test('as the sheet closes, however it closes, the screen\'s taps are held for the arm, then let go', async () => {
  // eslint-disable-next-line testing-library/no-node-access
  document.body.querySelectorAll('.m-tap-guard').forEach((g) => g.remove());
  serve();
  mount({ armDelayMs: 300 });
  await ready();
  cleanup();   // the page unmounts the sheet: Done, Cancel, the scrim, Escape, Back or a save
  await aTick();   // the hold waits one tick (see the StrictMode test below)
  // eslint-disable-next-line testing-library/no-node-access
  expect(document.body.querySelector('.m-tap-guard')).not.toBeNull();
  await pastTheArm();
  // eslint-disable-next-line testing-library/no-node-access
  expect(document.body.querySelector('.m-tap-guard')).toBeNull();
});

test('at its max height the sheet\'s thin strip of scrim does nothing in the edit view; Escape still closes; in the notify step it still steps back', async () => {
  const realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.getAttribute && this.getAttribute('role') === 'dialog') {
      const height = window.innerHeight - 12;
      return { x: 0, y: 12, top: 12, left: 0, right: 0, bottom: window.innerHeight, width: 0, height };
    }
    return realRect.call(this);
  };
  try {
    const { onClose } = await toNotifyStep();
    // The notify step at its max height: the strip steps back, which discards nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Notify the client?')).toBeNull();
    // The edit view at its max height: the strip does nothing; Escape closes.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    Element.prototype.getBoundingClientRect = realRect;
  }
});

test('a strip of scrim as tall as a thumb closes the sheet from the edit view; a sheet just short of its cap leaves one too thin, which does nothing', async () => {
  const realRect = Element.prototype.getBoundingClientRect;
  let top = 30;   // a sheet just short of its cap: a 30px strip above it
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.getAttribute && this.getAttribute('role') === 'dialog') {
      const height = window.innerHeight - top;
      return { x: 0, y: top, top, left: 0, right: 0, bottom: window.innerHeight, width: 0, height };
    }
    return realRect.call(this);
  };
  try {
    serve();
    const { onClose } = mount();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    top = 100;   // a 100px strip: a deliberate dismiss
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    Element.prototype.getBoundingClientRect = realRect;
  }
});

test('a failed load\'s Retry that fails again leaves focus on the dialog, since the Retry that had it is gone', async () => {
  serve({ proposal: { reject: NETWORK } });
  mount();
  const retry = await screen.findByRole('button', { name: 'Retry' });
  retry.focus();   // the button has focus as it is pressed (a keyboard, or a tap on Android)
  expect(retry).toHaveFocus();
  fireEvent.click(retry);
  expect(screen.getByText('Loading the event')).toBeInTheDocument();
  expect(await screen.findByText("Couldn't load this event. Editing needs a connection.")).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Edit details' })).toHaveFocus();
});

test('the locked message holds the scrim for the arm too, then the scrim closes the sheet', async () => {
  serve({ proposal: { ...PROPOSAL, status: 'completed' } });
  const { onClose } = mount({ armDelayMs: 300 });
  expect(await screen.findByText('This event can no longer be edited here. Use desktop view.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).not.toHaveBeenCalled();
  await pastTheArm();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

// React.StrictMode (client/src/index.js) runs each effect's cleanup once right
// after mount in development, then the effect again: that is not a close.
test('under React.StrictMode, as in development, the sheet opening lays no tap guard; its closing still does', async () => {
  serve();
  render(
    <React.StrictMode>
      <EditSheet proposalId={13} clientName="Alexis Henderson" kind="Wedding Reception" onClose={jest.fn()} onSaved={jest.fn()} previewDelayMs={0} armDelayMs={300} />
    </React.StrictMode>,
  );
  await ready();
  await aTick();
  // eslint-disable-next-line testing-library/no-node-access
  expect(document.body.querySelector('.m-tap-guard')).toBeNull();
  cleanup();   // the page unmounts the sheet
  await aTick();
  // eslint-disable-next-line testing-library/no-node-access
  expect(document.body.querySelector('.m-tap-guard')).not.toBeNull();
});

// ma-e3b: readout above, controls pinned.
test('the copy holds what comes and goes in order, the notices sit in their own strip under it, and the rows hold only the four rows', async () => {
  let failing = false;
  let reads = 0;
  api.get.mockImplementation((url) => {
    if (url === '/proposals/13') {
      reads += 1;
      return Promise.resolve({ data: reads === 1 ? { ...PROPOSAL, settled_extension_hours: 1, contract_floor_hours: 3 } : MOVED });
    }
    if (url === '/proposals/packages') return Promise.resolve({ data: [PKG] });
    if (url === '/proposals/addons') return Promise.resolve({ data: [BARBACK] });
    return Promise.reject({ status: 404 });
  });
  api.post.mockImplementation((url) => (url === '/proposals/calculate'
    ? (failing ? Promise.reject(NETWORK) : Promise.resolve({ data: { total: 3800, gratuity: { total: 120 } } }))
    : Promise.resolve({ data: { notices: [] } })));
  mount({ shiftCount: 2 });
  await ready();
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByRole('button', { name: 'Reload' });   // changed since you opened it
  failing = true;
  more('More guests');   // a step while that notice shows; its figure fails
  await screen.findByText("Couldn't price the change.");
  const dialog = screen.getByRole('dialog', { name: 'Edit details' });
  // eslint-disable-next-line testing-library/no-node-access
  const copy = [...dialog.querySelector('.m-edit-readout').children].map((el) => el.textContent);
  expect(copy[0]).toMatch(/^New total/);
  expect(copy.slice(1)).toEqual([
    'Includes 1h of on-site extension, billed on its own invoice. The contract prices 3h.',
    'This event has 2 shifts. Changing the date or time here does not move them; each shift is edited from desktop view.',
  ]);
  // eslint-disable-next-line testing-library/no-node-access
  expect([...dialog.querySelector('.m-edit-notices').children].map((el) => el.textContent)).toEqual([
    "Couldn't price the change.Retry",
    'This event changed since you opened it.Reload',
  ]);
  // eslint-disable-next-line testing-library/no-node-access
  expect(dialog.querySelector('.m-edit-rows').children).toHaveLength(4);
});

test('the curfew confirm is the strip\'s last notice, right above the rows, and Keep editing leaves the save\'s line there', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }), patch: () => Promise.reject(CURFEW_NO) });
  mount({ shiftCount: 2 });
  await ready();
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  const keep = await screen.findByRole('button', { name: 'Keep editing' });
  // eslint-disable-next-line testing-library/no-node-access
  const notices = screen.getByRole('dialog', { name: 'Edit details' }).querySelector('.m-edit-notices');
  // eslint-disable-next-line testing-library/no-node-access
  expect(notices.lastElementChild).toHaveClass('m-confirm');
  // eslint-disable-next-line testing-library/no-node-access
  expect(notices.lastElementChild).toContainElement(keep);
  // eslint-disable-next-line testing-library/no-node-access
  expect(notices.nextElementSibling).toHaveClass('m-edit-rows');
  fireEvent.click(keep);
  // eslint-disable-next-line testing-library/no-node-access
  expect(notices.lastElementChild).toHaveTextContent('Not saved. The end time is past our 2:00 AM service curfew.');
});

test('a changed field says what it was, inside its row', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }) });
  mount();
  await ready();
  expect(screen.queryByText(/^was /)).toBeNull();
  more('Longer');
  more('More guests');
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2999-08-22' } });
  fireEvent.change(screen.getByLabelText('Start'), { target: { value: '20:00' } });
  // eslint-disable-next-line testing-library/no-node-access
  const rowOf = (text) => screen.getByText(text).closest('.m-sheet-row');
  expect(rowOf('was 4 hr')).toBe(rowOf('Duration'));
  expect(rowOf('was 140')).toBe(rowOf('Guests'));
  expect(rowOf('was THU AUG 15 2999')).toBe(rowOf('Date'));
  expect(rowOf('was 19:00 · setup 45 min before')).toBe(rowOf('Start'));
  more('Shorter');   // back to the stored hours, the line goes
  expect(screen.queryByText('was 4 hr')).toBeNull();
});

test('the fade at the copy\'s foot shows whenever the copy overflows, as the export draws it', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }) });
  mount();
  await ready();
  // eslint-disable-next-line testing-library/no-node-access
  const readout = screen.getByRole('dialog', { name: 'Edit details' }).querySelector('.m-edit-readout');
  // eslint-disable-next-line testing-library/no-node-access
  const fade = () => readout.querySelector('.m-edit-fade');
  expect(fade()).toBeNull();
  // jsdom has no layout: 300px of copy in a 200px box; a step re-renders and re-measures.
  let height = 300;
  Object.defineProperty(readout, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(readout, 'clientHeight', { configurable: true, get: () => 200 });
  more('More guests');
  expect(fade()).not.toBeNull();
  height = 200;   // it fits again
  more('Fewer guests');
  expect(fade()).toBeNull();
});

test('the notify step fills the sheet\'s max height while it is open, so a channel\'s message showing or hiding moves nothing', async () => {
  await toNotifyStep();
  const dialog = screen.getByRole('dialog', { name: 'Edit details' });
  expect(dialog).toHaveClass('m-edit-notifying');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(dialog).not.toHaveClass('m-edit-notifying');
});

test('a screen reader hears the two top lines as one, and "pending" in place of the three dots', async () => {
  serve();
  api.post.mockImplementation(() => new Promise(() => {}));   // no figure ever lands
  mount();
  await ready();
  more('More guests');
  // eslint-disable-next-line testing-library/no-node-access
  const live = screen.getByText('New total').closest('[aria-live]');
  expect(live).toHaveAttribute('aria-live', 'polite');
  expect(live).toHaveAttribute('aria-atomic', 'true');
  expect(live).toHaveTextContent('balance due becomes');
  expect(screen.getAllByText('pending')).toHaveLength(2);
  for (const dots of screen.getAllByText(PENDING_FIGURE)) expect(dots).toHaveAttribute('aria-hidden', 'true');
});

test('a screen reader hears "to" between the old total and the new one, where the eye sees the arrow', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }) });
  mount();
  await ready();
  more('More guests');
  await screen.findByText('$3,800.00');
  // The live region as it is read: without the parts hidden from a screen reader.
  // eslint-disable-next-line testing-library/no-node-access
  const heard = screen.getByText('New total').closest('[aria-live]').cloneNode(true);
  // eslint-disable-next-line testing-library/no-node-access
  heard.querySelectorAll('[aria-hidden="true"]').forEach((el) => el.remove());
  expect(heard.textContent).toContain('$3,650.00 to $3,800.00');
});

test('a bank payment in flight that the detail passes in is said on the untouched readout', async () => {
  serve();
  mount({ inFlight: true });
  await ready();
  expect(screen.getByText('paid $1,900.00 · bank payment in flight')).toBeInTheDocument();
});

// The thin strip's rule holds only in the edit view, the one view with a
// Cancel: the loading line, a failed load and the locked message have none,
// so there the scrim stays a way out however thin its strip.
test('a thin strip of scrim still closes the sheet while it loads, after a failed load and on the locked message, which have no Cancel', async () => {
  const realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.getAttribute && this.getAttribute('role') === 'dialog') {
      const height = window.innerHeight - 12;
      return { x: 0, y: 12, top: 12, left: 0, right: 0, bottom: window.innerHeight, width: 0, height };
    }
    return realRect.call(this);
  };
  try {
    const views = [
      ['Loading the event', () => api.get.mockImplementation(() => new Promise(() => {}))],
      ["Couldn't load this event. Editing needs a connection.", () => serve({ proposal: { reject: NETWORK } })],
      ['This event can no longer be edited here. Use desktop view.', () => serve({ proposal: { ...PROPOSAL, status: 'completed' } })],
    ];
    for (const [says, setUp] of views) {
      setUp();
      const { onClose } = mount();
      expect(await screen.findByText(says)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(onClose).toHaveBeenCalledTimes(1);
      cleanup();
    }
  } finally {
    Element.prototype.getBoundingClientRect = realRect;
  }
});
