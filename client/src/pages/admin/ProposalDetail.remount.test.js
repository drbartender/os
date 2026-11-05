import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import ProposalDetail from './ProposalDetail';

// The route keeps its element when only :id changes. These tests move the page
// from one proposal to another the way global search does and check that
// nothing of the first proposal acts on the second: an open editor, and a
// record request for the first that answers late.

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn() } }));
// Stable identities: the page's load callback depends on toast.
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));
const mockAuth = { user: { id: 1, role: 'admin' } };
jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }));

// The editor seeds its form once, at mount, from the proposal it is handed
// (ProposalEditorForm's useState initializer); the stub keeps that and shows
// both the record it was seeded from and the record its save would target.
jest.mock('./proposalEditor/ProposalEditorForm', () => {
  const { useState } = require('react');
  function MockEditor({ proposal }) {
    const [seededFrom] = useState(proposal.id);
    return <div data-testid="editor">seeded from {seededFrom}, saves to {proposal.id}</div>;
  }
  return { __esModule: true, default: MockEditor };
});
// The heavy cards and dialogs are not what these tests are about.
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

const record = (id, clientName, notes) => ({
  id,
  token: `tok-${id}`,
  status: 'sent',
  client_id: 100 + id,
  client_name: clientName,
  client_email: `client${id}@example.com`,
  event_type: 'birthday',
  guest_count: 50,
  total_price: '1000.00',
  amount_paid: '0.00',
  admin_notes: notes,
});

// The record GET for each id is a promise the test settles, so it can answer
// out of order; the side reads answer at once.
let pending;
beforeEach(() => {
  jest.clearAllMocks();
  pending = {};
  api.get.mockImplementation((url) => {
    const m = url.match(/^\/proposals\/(\d+)$/);
    if (m) return new Promise((resolve) => { pending[m[1]] = resolve; });
    if (url.endsWith('/group')) return Promise.resolve({ data: { grouped: false } });
    if (url.endsWith('/change-requests')) return Promise.resolve({ data: { requests: [] } });
    return Promise.reject(Object.assign(new Error('not found'), { status: 404 }));
  });
});

function Go() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/proposals/2')}>go to 2</button>;
}

const mount = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/proposals/:id" element={<><ProposalDetail /><Go /></>} /></Routes>
  </MemoryRouter>
);

const answer = async (id, name, notes) => {
  await act(async () => { pending[id]({ data: record(Number(id), name, notes) }); });
};

test('an editor open on one proposal is not open on the next', async () => {
  mount('/proposals/1?edit=1');
  await answer('1', 'Client One', 'notes for one');
  expect(screen.getByTestId('editor')).toHaveTextContent('seeded from 1, saves to 1');

  fireEvent.click(screen.getByRole('button', { name: 'go to 2' }));
  await answer('2', 'Client Two', 'notes for two');

  expect(screen.getAllByText('Client Two').length).toBeGreaterThan(0);
  expect(screen.queryByTestId('editor')).toBeNull();
});

test('the first proposal answering late never replaces the second', async () => {
  mount('/proposals/1');
  fireEvent.click(screen.getByRole('button', { name: 'go to 2' }));
  await answer('2', 'Client Two', 'notes for two');
  await answer('1', 'Client One', 'notes for one');

  expect(screen.getAllByText('Client Two').length).toBeGreaterThan(0);
  expect(screen.queryByText('Client One')).toBeNull();
  expect(screen.getByDisplayValue('notes for two')).toBeInTheDocument();
});
