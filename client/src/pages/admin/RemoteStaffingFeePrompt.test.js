import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RemoteStaffingFeePrompt from './RemoteStaffingFeePrompt';
import api from '../../utils/api';

// The Remote Staffing Fee rides the editor's own PATCH payload (plan
// 2026-10-16 Task E4 item 7): its fresh GET's adjustments_token goes with the
// lines, so the save that appends the surcharge is one save the stale-lines
// guard accepts. Fixtures are synthetic.

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));

const CHECK = {
  should_prompt: true, venue_distance_miles: 72.4, staff_within_40: 1, staff_uncounted: 0, suggested_fee_cents: 15000,
};
const LINE = { type: 'discount', label: 'Test discount A', amount: 10, visible: true };
const PROPOSAL = {
  id: 21, package_id: 1, guest_count: 80, event_duration_hours: '4.0', num_bars: 0, num_bartenders: 1,
  event_date: '2027-06-12', event_start_time: '6:00 PM', addons: [], adjustments: [LINE],
  adjustments_token: 'tok-21', total_price_override: null, settled_extension_hours: 0,
  class_options: null, client_provides_glassware: false, pricing_snapshot: { total: 340 },
};
const PKG = { id: 1, slug: 'the-core-reaction', bar_type: 'service_only', guests_per_bartender: 100 };

function serve({ patch } = {}) {
  api.get.mockImplementation((url) => {
    if (url === '/proposals/21/remote-staffing-check') return Promise.resolve({ data: CHECK });
    if (url === '/proposals/21') return Promise.resolve({ data: PROPOSAL });
    if (url === '/proposals/packages') return Promise.resolve({ data: [PKG] });
    if (url === '/proposals/addons') return Promise.resolve({ data: [] });
    return Promise.reject({ status: 404 });
  });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockImplementation(patch || (() => Promise.resolve({ data: { id: 21 } })));
}

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.patch.mockReset();
  mockToast.success.mockReset();
});

test('the fee rides one save: the GET\'s token, the lines plus the surcharge, never the override', async () => {
  serve();
  const onProceed = jest.fn();
  render(<RemoteStaffingFeePrompt proposalId={21} onProceed={onProceed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add $150.00 and send' }));
  await waitFor(() => expect(onProceed).toHaveBeenCalledTimes(1));
  expect(api.patch).toHaveBeenCalledTimes(1);
  const [url, body] = api.patch.mock.calls[0];
  expect(url).toBe('/proposals/21');
  expect(body.adjustments_token).toBe('tok-21');
  expect(body.adjustments).toEqual([LINE, { type: 'surcharge', label: 'Remote Staffing Fee', amount: 150, visible: true }]);
  expect(body).not.toHaveProperty('total_price_override');
  expect(api.post).toHaveBeenCalledWith('/proposals/21/remote-fee-prompt-answered', {});
  expect(mockToast.success).toHaveBeenCalledWith('Remote Staffing Fee added: $150.00.');
});

test('a refused line says why, from its field, and the prompt stays open', async () => {
  serve({
    patch: () => Promise.reject({
      status: 400, message: 'Please fix the errors below',
      fieldErrors: { adjustments: 'A price adjustment amount must be in whole cents.' },
    }),
  });
  const onProceed = jest.fn();
  render(<RemoteStaffingFeePrompt proposalId={21} onProceed={onProceed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Custom amount' }));
  fireEvent.change(screen.getByLabelText('Remote Staffing Fee in dollars'), { target: { value: '12.345' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add and send' }));
  expect(await screen.findByText('A price adjustment amount must be in whole cents.')).toBeInTheDocument();
  expect(onProceed).not.toHaveBeenCalled();
  expect(api.patch).toHaveBeenCalledTimes(1);
});

// Fix round 1 (consistency NIT-1): the prompt has no Reload. Each try re-reads
// the booking before it saves, so a stale refusal says try again, and the next
// try saves with the fresh read's token.
test('a stale refusal says try again, and the next try re-reads and saves', async () => {
  let calls = 0;
  serve({
    patch: () => {
      calls += 1;
      return calls === 1
        ? Promise.reject({ status: 409, code: 'STALE_EDIT', message: 'This booking changed since you opened it. Reload to see the latest.' })
        : Promise.resolve({ data: { id: 21 } });
    },
  });
  const onProceed = jest.fn();
  render(<RemoteStaffingFeePrompt proposalId={21} onProceed={onProceed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add $150.00 and send' }));
  expect(await screen.findByText('This booking changed a moment ago. Try again.')).toBeInTheDocument();
  expect(screen.queryByText(/Reload/)).toBeNull();
  expect(onProceed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Add $150.00 and send' }));
  await waitFor(() => expect(onProceed).toHaveBeenCalledTimes(1));
  expect(api.patch).toHaveBeenCalledTimes(2);
  expect(api.get.mock.calls.filter(([u]) => u === '/proposals/21')).toHaveLength(2);
});
