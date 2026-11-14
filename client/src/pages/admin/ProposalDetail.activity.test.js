import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import api from '../../utils/api';
import ProposalDetail from './ProposalDetail';

// The activity rail and its full log (lane menu-approve-send, carried item f):
// the menu review's rows read by name, and the two the client writes from the
// menu proof page (and the release a Looks great makes) name that page as
// their source, never the proposal page. The page's mocks follow
// ProposalDetail.remount.test.js.

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
jest.mock('./ProposalDetailPaymentPanel', () => ({ __esModule: true, default: () => null }));
jest.mock('./ProposalDetailStopDrip', () => ({ __esModule: true, default: () => null }));
jest.mock('./CancelEventDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('./CancelLineDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('./RemoteStaffingFeePrompt', () => ({ __esModule: true, default: () => null }));
jest.mock('../../components/SendModal', () => ({ __esModule: true, default: () => null, describeSendResult: () => '' }));
jest.mock('./proposalEditor/useCancelTargets', () => ({ __esModule: true, default: () => ({ targets: [], reload: () => {} }) }));

const AT = '2026-11-12T17:00:00Z';
const row = (action, actorType) => ({ action, actor_type: actorType, created_at: AT, details: {} });
const ACTIVITY = [
  row('menu_proof_closed', 'admin'),
  row('menu_released', 'client'),
  row('menu_proof_approved', 'client'),
  row('menu_proof_changes', 'client'),
  row('menu_proof_sent', 'admin'),
  row('menu_approved', 'admin'),
  row('menu_released', 'admin'),
  row('proposal_viewed', 'client'),
];
const record = {
  id: 7, token: 'tok-7', status: 'confirmed', client_id: 107, client_name: 'Avery Example', client_email: 'avery@example.com',
  event_type: 'birthday', guest_count: 50, total_price: '1000.00', amount_paid: '0.00', admin_notes: '', activity: ACTIVITY,
};

beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockImplementation((url) => {
    if (url === '/proposals/7') return Promise.resolve({ data: record });
    if (url.endsWith('/group')) return Promise.resolve({ data: { grouped: false } });
    if (url.endsWith('/change-requests')) return Promise.resolve({ data: { requests: [] } });
    return Promise.reject(Object.assign(new Error('not found'), { status: 404 }));
  });
});

const mount = () => render(
  <MemoryRouter initialEntries={['/proposals/7']}>
    <Routes><Route path="/proposals/:id" element={<ProposalDetail />} /></Routes>
  </MemoryRouter>,
);

test('the full log names each menu review row and its source: the client rows come from the menu proof page', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: `View all (${ACTIVITY.length})` }));
  const log = screen.getByRole('heading', { name: 'Activity log' }).closest('.card');
  const entries = [...log.querySelectorAll('.card-body .vstack > div')].map((el) => {
    const lines = el.querySelectorAll('.hstack > div:first-child > div');
    return [lines[0].textContent, lines[1].textContent];
  });
  expect(entries).toEqual([
    ['Menu change request closed', 'admin · Admin panel'],
    ['Menu released for printing', 'client · Menu proof page'],
    ['Client said the menu looks great', 'client · Menu proof page'],
    ['Client asked for menu changes', 'client · Menu proof page'],
    ['Menu proof sent', 'admin · Admin panel'],
    ['Menu approved', 'admin · Admin panel'],
    ['Menu released for printing', 'admin · Admin panel'],
    ['proposal_viewed', 'client · Proposal page'],
  ]);
});

test('the rail shows the same names', async () => {
  mount();
  await screen.findByRole('button', { name: `View all (${ACTIVITY.length})` });
  const rail = screen.getByRole('heading', { name: 'Activity' }).closest('.card');
  expect(within(rail).getByText('Menu change request closed')).toBeInTheDocument();
  expect(within(rail).getByText('Client said the menu looks great')).toBeInTheDocument();
  expect(within(rail).queryByText('menu_proof_approved')).toBeNull();
});
