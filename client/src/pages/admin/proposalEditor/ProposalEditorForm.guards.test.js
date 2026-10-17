import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The editor against the PATCH guards (spec 2026-10-16 sections 5, 5.1 and
// 5.3; plan Task E4 items 2, 4 and 5). Fixtures are synthetic.

jest.mock('../../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn() },
}));

const api = require('../../../utils/api').default;
const ProposalEditorForm = require('./ProposalEditorForm').default;
const { ToastProvider } = require('../../../context/ToastContext');

const corePkg = {
  id: 1, slug: 'the-core-reaction', name: 'The Core Reaction', category: 'byob', pricing_type: 'flat',
  bar_type: 'service_only', base_rate_4hr: 350, extra_hour_rate: 100, bartenders_included: 1,
  guests_per_bartender: 100, extra_bartender_hourly: 40, is_active: true,
};
const STALE = { status: 409, code: 'STALE_EDIT', message: 'This booking changed since you opened it. Reload to see the latest.' };
const TEST_LINE = { type: 'discount', label: 'Test discount A', amount: 10, visible: true };

function proposalWith(extra) {
  return {
    id: 4242, package_id: 1, status: 'sent', guest_count: 100, event_duration_hours: '4.0',
    num_bars: 0, num_bartenders: 1, event_date: '2027-06-12', event_start_time: '6:00 PM',
    addons: [], adjustments: [TEST_LINE], adjustments_token: 'tok-when-opened',
    total_price: '340.00', amount_paid: '0', client_signed_at: null,
    pricing_snapshot: { total: 340, inputs: { durationHours: 4 } },
    ...extra,
  };
}

function mount(proposal, props = {}) {
  const handlers = { onSaved: jest.fn(), onCancel: jest.fn(), onReload: jest.fn() };
  // A Router: with a client_id the editor links to the client profile.
  render(
    <MemoryRouter>
      <ToastProvider>
        <ProposalEditorForm proposal={proposal} {...handlers} {...props} />
      </ToastProvider>
    </MemoryRouter>
  );
  return handlers;
}

function routePosts({ notices = [] } = {}) {
  api.post.mockImplementation((url) => {
    if (url === '/proposals/calculate') return Promise.resolve({ data: { total: 340, breakdown: [], staffing: { actual: 1 }, gratuity: { total: 0 } } });
    if (url === '/proposals/4242/notify-preflight') return Promise.resolve({ data: { notices } });
    return Promise.resolve({ data: {} });
  });
}

const saveButton = () => screen.getByRole('button', { name: 'Save changes' });
async function ready() {
  await screen.findByText('Live preview');
  await waitFor(() => expect(saveButton()).toBeEnabled());
}

// jsdom has no scrollIntoView; FormBanner calls it when it shows.
beforeAll(() => { Element.prototype.scrollIntoView = function scrollIntoView() {}; });
afterAll(() => { delete Element.prototype.scrollIntoView; });

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.patch.mockReset();
  api.put.mockReset();
  api.get.mockImplementation((url) => {
    if (url === '/proposals/packages') return Promise.resolve({ data: [corePkg] });
    return Promise.resolve({ data: [] });
  });
  routePosts();
});

// Review Focus 1: both parents close the editor and refetch after a save, so an
// editor reopened before the refetch lands holds old lines and an old token.
test('an editor opened from a stale proposal: the line save is refused, Reload is offered, and nothing is sent twice', async () => {
  api.patch.mockRejectedValue(STALE);
  const { onReload, onSaved } = mount(proposalWith());
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Discount' }));
  fireEvent.change(within(screen.getByRole('group', { name: 'Discount' })).getByLabelText('Amount'), { target: { value: '25' } });
  await waitFor(() => expect(saveButton()).toBeEnabled());
  fireEvent.click(saveButton());

  expect(await screen.findByText(STALE.message)).toBeInTheDocument();
  expect(api.patch).toHaveBeenCalledTimes(1);
  const [url, body] = api.patch.mock.calls[0];
  expect(url).toBe('/proposals/4242');
  expect(body.adjustments_token).toBe('tok-when-opened');
  expect(body).not.toHaveProperty('total_price_override');
  expect(body.adjustments).toEqual([TEST_LINE, { type: 'discount', label: '', amount: '25', visible: true }]);
  expect(onSaved).not.toHaveBeenCalled();

  // Save stays shut: a second try with the same token is refused the same way.
  expect(saveButton()).toBeDisabled();
  fireEvent.click(saveButton());
  expect(api.patch).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(onReload).toHaveBeenCalledTimes(1);
});

test('a stale refusal from the notify step closes the popup and offers Reload', async () => {
  routePosts({ notices: [{
    type: 'event_details_changed', composable: true, reasons: ['event_date changed'],
    recipient: { name: 'Test Client', email: 'client@example.test', phone: '+15555550100' },
    channels: { email: { available: true, default: true }, sms: { available: true, default: false } },
    autopay_notice: null,
    draft: { email: { subject: 'Test subject', body_text: 'Test body.' }, sms: { body: 'Test sms.' } },
  }] });
  api.patch.mockRejectedValue(STALE);
  const { onReload } = mount(proposalWith());
  await ready();
  fireEvent.click(saveButton());
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: "Don't send" }));
  expect(await screen.findByText(STALE.message)).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.patch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(onReload).toHaveBeenCalledTimes(1);
});

test('a booking on legal hold opens read-only: the note, no Save', async () => {
  const { onCancel } = mount(proposalWith({ legal_hold: true }));
  expect(screen.getByText("This booking is on legal hold and can't be edited here.")).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Set agreed price' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(api.patch).not.toHaveBeenCalled();
});

test('the override block is gone; a booking that still has one shows it read-only and still saves its other edits', async () => {
  api.patch.mockResolvedValue({ data: { id: 4242, notifications: [] } });
  mount(proposalWith({ total_price_override: '3373.00' }));
  await ready();
  expect(screen.queryByText('Override total')).toBeNull();
  expect(screen.getByText('Price override: $3,373.00. It converts to an Agreed price adjustment line soon.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Set agreed price' })).toBeDisabled();
  // The preview still prices the standing override (the server carries it forward).
  const calc = api.post.mock.calls.filter(([u]) => u === '/proposals/calculate').pop()[1];
  expect(calc.total_price_override).toBe('3373.00');
  fireEvent.click(saveButton());
  await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
  expect(api.patch.mock.calls[0][1]).not.toHaveProperty('total_price_override');
});

test('Set agreed price writes its line in the form before save, and the save carries it with the token', async () => {
  api.patch.mockResolvedValue({ data: { id: 4242, notifications: [] } });
  const { onSaved } = mount(proposalWith());
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Set agreed price' }));
  // Preview service total 340 already nets the -10 line; agree 300.
  fireEvent.change(screen.getByLabelText('Agreed price'), { target: { value: '300' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(screen.getByRole('group', { name: 'Agreed price adjustment' })).toBeInTheDocument();
  await waitFor(() => expect(saveButton()).toBeEnabled());
  fireEvent.click(saveButton());
  await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
  const body = api.patch.mock.calls[0][1];
  expect(body.adjustments_token).toBe('tok-when-opened');
  expect(body.adjustments).toEqual([TEST_LINE, {
    type: 'discount', label: 'Agreed price adjustment', amount: 40, visible: false, source: 'agreed_price',
  }]);
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
});

// The server validates every line (spec 2026-10-16 section 3) and keys the
// reason on `adjustments`; the banner alone would say only "Please fix the
// errors below", so the reason shows under the price adjustments.
test('a refused line shows the server\'s reason under the price adjustments', async () => {
  api.patch.mockRejectedValue({
    status: 400, code: 'VALIDATION_ERROR', message: 'Please fix the errors below',
    fieldErrors: { adjustments: 'A price adjustment amount must be $0 or more and under $1,000,000.' },
  });
  mount(proposalWith());
  await ready();
  fireEvent.click(saveButton());
  expect(await screen.findByText('A price adjustment amount must be $0 or more and under $1,000,000.')).toBeInTheDocument();
  expect(api.patch).toHaveBeenCalledTimes(1);
  expect(saveButton()).toBeEnabled();
});

// Fix round 1 (consistency NIT-3): the client contact is saved before the
// event (so a notice reaches a corrected address). When the event save is then
// refused, the editor says the contact went through, but only if it changed.
describe('a refused save after the contact went out', () => {
  const withClient = () => proposalWith({ client_id: 77, client_name: 'Test Client', client_email: 'client@example.test' });
  const NOTE = 'Contact details were saved; the event changes were not.';

  test('a stale refusal after a contact edit says the contact was saved', async () => {
    api.put.mockResolvedValue({ data: {} });
    api.patch.mockRejectedValue(STALE);
    mount(withClient());
    await ready();
    fireEvent.change(screen.getByDisplayValue('Test Client'), { target: { value: 'Test Client B' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(`${STALE.message} ${NOTE}`)).toBeInTheDocument();
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  test('any other refusal after a contact edit says so too', async () => {
    api.put.mockResolvedValue({ data: {} });
    api.patch.mockRejectedValue({ status: 500, message: 'Something broke' });
    mount(withClient());
    await ready();
    fireEvent.change(screen.getByDisplayValue('Test Client'), { target: { value: 'Test Client B' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(`Something broke ${NOTE}`)).toBeInTheDocument();
  });

  test('with no contact edit, the refusal says nothing about the contact', async () => {
    api.put.mockResolvedValue({ data: {} });
    api.patch.mockRejectedValue(STALE);
    mount(withClient());
    await ready();
    fireEvent.click(saveButton());
    expect(await screen.findByText(STALE.message)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(NOTE))).toBeNull();
  });
});
