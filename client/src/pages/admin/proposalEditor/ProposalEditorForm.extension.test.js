import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// After a settled on-site extension the editor shows worked hours in the
// duration field but must PRICE the contract's hours: the preview sends the
// proposal id so the server subtracts the settled hours, and the field
// explains the difference. Spec 2026-09-30-extension-contract-duration-design.md.

jest.mock('../../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn() },
}));

const api = require('../../../utils/api').default;
const ProposalEditorForm = require('./ProposalEditorForm').default;
const { ToastProvider } = require('../../../context/ToastContext');

const mount = (proposal) => render(
  <ToastProvider>
    <ProposalEditorForm proposal={proposal} onSaved={() => {}} onCancel={() => {}} />
  </ToastProvider>
);

const corePkg = {
  id: 1, slug: 'the-core-reaction', name: 'The Core Reaction', category: 'byob', pricing_type: 'flat',
  bar_type: 'service_only', base_rate_4hr: 350, extra_hour_rate: 100, bartenders_included: 1,
  guests_per_bartender: 100, extra_bartender_hourly: 40, is_active: true,
};

function proposalWith(extra) {
  return {
    id: 4242, package_id: 1, status: 'confirmed', guest_count: 100, event_duration_hours: '5.0',
    num_bars: 0, num_bartenders: 1, event_date: '2027-06-12', event_start_time: '6:00 PM',
    addons: [], adjustments: [], total_price: '350.00', amount_paid: '0', client_signed_at: null,
    pricing_snapshot: { total: 350, inputs: { durationHours: 4 } },
    ...extra,
  };
}

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation((url) => {
    if (url === '/proposals/packages') return Promise.resolve({ data: [corePkg] });
    if (url === '/proposals/addons') return Promise.resolve({ data: [] });
    return Promise.resolve({ data: [] });
  });
  api.post.mockResolvedValue({ data: { total: 350, breakdown: [], staffing: { actual: 1 } } });
});

test('the preview carries proposal_id when editing an existing booking', async () => {
  mount(proposalWith({ settled_extension_hours: 1 }));
  await waitFor(() => expect(api.post).toHaveBeenCalled());
  const calculateCalls = api.post.mock.calls.filter(([url]) => url === '/proposals/calculate');
  expect(calculateCalls.length).toBeGreaterThan(0);
  const body = calculateCalls[calculateCalls.length - 1][1];
  expect(body.proposal_id).toBe(4242);
  expect(body.duration_hours).toBe(5);
});

test('an extended booking explains the split under the duration field', async () => {
  mount(proposalWith({ settled_extension_hours: 1 }));
  const hint = await screen.findByText(/Includes 1h of on-site extension, billed on its own invoice\. The contract prices 4h\./);
  expect(hint).toBeTruthy();
});

test('a booking with no extension shows no such line', async () => {
  mount(proposalWith({ settled_extension_hours: 0 }));
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(screen.queryByText(/on-site extension/)).toBeNull();
});

// Pinned before lane ma-e3a moved the preview body into editorCore.js: the
// whole /calculate body, field for field, so the move cannot change a key.
test('the preview body, every field (characterization)', async () => {
  mount(proposalWith({ settled_extension_hours: 0 }));
  await waitFor(() => expect(api.post).toHaveBeenCalled());
  const body = api.post.mock.calls.filter(([url]) => url === '/proposals/calculate').pop()[1];
  expect(body).toEqual({
    proposal_id: 4242, package_id: 1, guest_count: 100, duration_hours: 5, num_bars: 0,
    addon_ids: [], addon_variants: {}, addon_quantities: {}, syrup_selections: [], adjustments: [],
    total_price_override: null, tip_jar: true, gratuity_rate: 0,
  });
});

test('an override and a stored gratuity ride the preview; the mandate key stays off at mount (characterization)', async () => {
  mount(proposalWith({
    num_bartenders: 3, amount_paid: '100', client_signed_at: '2027-01-01T00:00:00.000Z', gratuity_floor_rate: 12,
    pricing_snapshot: { total: 350, gratuity: { rate: 12, tip_jar: false, staff_count: 3, hours: 5 } },
  }));
  await waitFor(() => expect(api.post).toHaveBeenCalled());
  const body = api.post.mock.calls.filter(([url]) => url === '/proposals/calculate').pop()[1];
  expect(body).toMatchObject({ num_bartenders: 3, tip_jar: false, gratuity_rate: 12 });
  expect(body).not.toHaveProperty('gratuity_mandate_total');
});

// The editor feeds the reprice confirm's gratuity line three keys
// (gratuityOrigin, oldGratuityTotal, newGratuityTotal). Pinned so a later edit
// cannot drop one and promise the client an email the server will not send
// (gratuityMandate.js: money paid, origin not admin, the total rises).
describe('the reprice confirm names the automatic gratuity email', () => {
  const paidBooking = (extra) => proposalWith({
    status: 'deposit_paid', amount_paid: '100', total_price: '350.00',
    pricing_snapshot: { total: 350, gratuity: { total: 60 } },
    ...extra,
  });

  beforeEach(() => {
    api.post.mockResolvedValue({
      data: { total: 450, breakdown: [], staffing: { actual: 1 }, gratuity: { total: 90 } },
    });
  });

  const openConfirm = async () => {
    await screen.findByText('Live preview');
    const save = screen.getByRole('button', { name: 'Save changes' });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    return screen.findByRole('dialog', { name: 'This changes the price of a booked event' });
  };

  test('shown when money is paid, the gratuity was not set by hand, and it rises', async () => {
    mount(paidBooking({ gratuity_rate_change_origin: null }));
    await openConfirm();
    expect(screen.getByText(/^The gratuity rises to \$90\.00, so the client is emailed the new amount automatically/)).toBeTruthy();
  });

  test('absent when an admin set the gratuity by hand', async () => {
    mount(paidBooking({ gratuity_rate_change_origin: 'admin' }));
    await openConfirm();
    expect(screen.queryByText(/The gratuity rises/)).toBeNull();
  });

  test('absent when the gratuity does not rise', async () => {
    mount(paidBooking({ pricing_snapshot: { total: 350, gratuity: { total: 90 } } }));
    await openConfirm();
    expect(screen.queryByText(/The gratuity rises/)).toBeNull();
  });
});

// The save's two rewired seams (lane ma-e3a), pinned on an unbooked proposal so
// no reprice confirm intervenes: Save runs notify-preflight, then the PATCH.
describe('the save path', () => {
  const routePosts = (preflightBody) => api.post.mockImplementation((url, body) => {
    if (url === '/proposals/calculate') return Promise.resolve({ data: { total: 350, breakdown: [], staffing: { actual: 1 } } });
    if (url === '/proposals/4242/notify-preflight') { preflightBody.push(body); return Promise.resolve({ data: { notices: [] } }); }
    return Promise.resolve({ data: {} });
  });

  const save = async () => {
    await screen.findByText('Live preview');
    const button = screen.getByRole('button', { name: 'Save changes' });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
  };

  test('a failed channel toasts as an error and a real skip as info', async () => {
    routePosts([]);
    api.patch.mockResolvedValue({ data: { id: 4242, notifications: [
      { type: 'event_details_changed', email: 'failed', email_error: 'bounced', sms: 'skipped', skip_reasons: { sms: 'opted out' } },
    ] } });
    const { container } = mount(proposalWith({ status: 'sent' }));
    await save();
    await screen.findByText('Saved, but the email failed: bounced');
    expect(container.ownerDocument.querySelector('.toast-error').textContent).toContain('Saved, but the email failed: bounced');
    expect(container.ownerDocument.querySelector('.toast-info').textContent).toContain('Saved. Text not sent: opted out');
  });

  test('a class booking whose package left the catalog still saves its class options', async () => {
    const preflightBody = [];
    routePosts(preflightBody);
    api.patch.mockResolvedValue({ data: { id: 4242, notifications: [] } });
    const classOptions = { spirit_category: 'whiskey_bourbon', top_shelf_requested: false };
    mount(proposalWith({ status: 'sent', package_id: 99, class_options: classOptions }));
    await save();
    await waitFor(() => expect(preflightBody).toHaveLength(1));
    expect(preflightBody[0].class_options).toEqual(classOptions);
  });
});

