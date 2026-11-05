import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import api from '../../utils/api';
import ProposalDetail from './ProposalDetail';

// The desktop archive modal reads its reasons from utils/archiveReasons.js:
// the four options in the desktop's order and words, no_hire when it opens
// from the Archive button, client_cancelled when a full refund opens it.

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn() } }));
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));
const mockAuth = { user: { id: 1, role: 'admin' } };
jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('./proposalEditor/ProposalEditorForm', () => ({ __esModule: true, default: () => null }));
jest.mock('../../components/PricingBreakdown', () => ({ __esModule: true, default: () => null, matchCancelTargets: () => ({ unmatched: [] }) }));
jest.mock('../../components/DrinkPlanCard', () => ({ __esModule: true, default: () => null }));
jest.mock('./ProposalChangeRequestCard', () => ({ __esModule: true, default: () => null }));
jest.mock('./AlternativesPanel', () => ({ __esModule: true, default: () => null }));
jest.mock('./PackageDetails', () => ({ __esModule: true, default: () => null }));
// The payment panel calls onFullyRefunded when a refund zeroes the balance; the
// stand-in offers that as a button.
jest.mock('./ProposalDetailPaymentPanel', () => ({
  __esModule: true,
  default: ({ onFullyRefunded }) => <button type="button" onClick={onFullyRefunded}>refund in full</button>,
}));
jest.mock('./ProposalDetailStopDrip', () => ({ __esModule: true, default: () => null }));
jest.mock('./CancelEventDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('./CancelLineDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('./RemoteStaffingFeePrompt', () => ({ __esModule: true, default: () => null }));
jest.mock('../../components/SendModal', () => ({ __esModule: true, default: () => null, describeSendResult: () => '' }));
jest.mock('./proposalEditor/useCancelTargets', () => ({ __esModule: true, default: () => ({ targets: [], reload: () => {} }) }));

const RECORD = {
  id: 7, token: 'tok-7', status: 'accepted', client_id: 107, client_name: 'Client Seven',
  client_email: 'client7@example.test', event_type: 'birthday', guest_count: 50,
  total_price: '1000.00', amount_paid: '0.00', legal_hold: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockImplementation((url) => {
    if (url === '/proposals/7') return Promise.resolve({ data: RECORD });
    if (url === '/clients/107') return Promise.resolve({ data: { proposals: [] } });
    if (url.endsWith('/group')) return Promise.resolve({ data: { grouped: false } });
    if (url.endsWith('/change-requests')) return Promise.resolve({ data: { requests: [] } });
    return Promise.reject(Object.assign(new Error('not found'), { status: 404 }));
  });
});

const mount = async () => {
  render(
    <MemoryRouter initialEntries={['/proposals/7']}>
      <Routes><Route path="/proposals/:id" element={<ProposalDetail />} /></Routes>
    </MemoryRouter>
  );
  await screen.findByRole('button', { name: 'refund in full' });
};
const reasonSelect = () => screen.getByLabelText('Reason');

test("the modal offers the four reasons in the desktop's order and words, no_hire on open", async () => {
  await mount();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive' })); });
  const select = reasonSelect();
  expect(within(select).getAllByRole('option').map((o) => [o.value, o.textContent])).toEqual([
    ['no_hire', 'No hire'], ['client_cancelled', 'Client cancelled'], ['we_cancelled', 'We cancelled'], ['other', 'Other'],
  ]);
  expect(select).toHaveValue('no_hire');
});

test('a full refund opens it on client_cancelled, and the archive posts the picked reason', async () => {
  api.post.mockResolvedValue({ data: { archived_ids: [7] } });
  await mount();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'refund in full' })); });
  expect(reasonSelect()).toHaveValue('client_cancelled');
  fireEvent.change(reasonSelect(), { target: { value: 'we_cancelled' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive proposal' })); });
  expect(api.post).toHaveBeenCalledWith('/proposals/7/archive', { scope: 'one', archive_reason: 'we_cancelled' });
});

test('a proposal holding money offers no Archive, since the server refuses it', async () => {
  api.get.mockImplementation((url) => {
    if (url === '/proposals/7') return Promise.resolve({ data: { ...RECORD, status: 'sent', amount_paid: '100.00' } });
    if (url.endsWith('/group')) return Promise.resolve({ data: { grouped: false } });
    if (url.endsWith('/change-requests')) return Promise.resolve({ data: { requests: [] } });
    return Promise.reject(Object.assign(new Error('not found'), { status: 404 }));
  });
  await mount();
  expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
});
