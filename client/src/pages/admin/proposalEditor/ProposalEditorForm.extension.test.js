import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

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
