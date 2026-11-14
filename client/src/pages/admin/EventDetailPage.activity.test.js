import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import api from '../../utils/api';
import EventDetailPage from './EventDetailPage';

// The event page's Activity card names the menu review's actions (lane
// menu-approve-send, fix round 1) from the label map the proposal page uses
// (utils/menuActivityLabels.js); every other row prints its action as before.
// The mocks follow EventDetailPage.fork.test.js: the heavy cards render nothing.

const mockMobileView = { isPhone: false, desktopView: jest.fn(() => false), setDesktopView: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockMobileView }));
jest.mock('../mobile/EventDetailPhone', () => ({ __esModule: true, default: () => null }));
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));
const mockAuth = { user: { id: 1, role: 'admin' } };
jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('./proposalEditor/ProposalEditorForm', () => ({ __esModule: true, default: () => null }));
jest.mock('../../components/PricingBreakdown', () => ({ __esModule: true, default: () => null, matchCancelTargets: () => ({ unmatched: [] }) }));
jest.mock('../../components/SendModal', () => ({ __esModule: true, default: () => null, describeSendResult: () => '' }));
jest.mock('../../components/DrinkPlanCard', () => ({ __esModule: true, default: () => null }));
jest.mock('./eventDetail/MessageLogCard', () => ({ __esModule: true, default: () => null }));
jest.mock('./menuDesigner/MenuDesignerCard', () => ({ __esModule: true, default: () => null }));
jest.mock('./menuDesigner/MenuEditor', () => ({ __esModule: true, default: () => null }));
jest.mock('./menuDesigner/useMenuDraft', () => ({ __esModule: true, default: () => ({}) }));
jest.mock('./menuDesigner/useMenuEditorOpen', () => ({ __esModule: true, default: () => ({ open: false, openEditor: () => {} }) }));
jest.mock('../../components/adminos/ServiceExtensionPanel', () => ({ __esModule: true, default: () => null }));
jest.mock('../../components/adminos/drawers/ShiftDrawer', () => ({ __esModule: true, default: () => null }));
jest.mock('./ProposalDetailPaymentPanel', () => ({ __esModule: true, default: () => null }));
jest.mock('./proposalEditor/useCancelTargets', () => ({ __esModule: true, default: () => ({ targets: [], reload: () => {} }) }));
jest.mock('./CancelEventDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('./CancelLineDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('./OutOfAreaKnob', () => ({ __esModule: true, default: () => null }));
jest.mock('./PackageDetails', () => ({ __esModule: true, default: () => null }));

const AT = '2026-11-12T17:00:00Z';
const row = (action) => ({ action, actor_type: 'admin', created_at: AT, details: {} });
const event = {
  id: 13, token: 'tok-13', status: 'confirmed', client_id: 113, client_name: 'Client 13', client_email: 'client13@example.com',
  event_type: 'birthday', guest_count: 50, total_price: '1000.00', amount_paid: '100.00',
  activity: [row('menu_proof_sent'), row('menu_proof_changes'), row('menu_released'), row('payment'), row('proposal_viewed')],
};

beforeEach(() => {
  api.get.mockImplementation((url) => {
    if (url === '/proposals/13') return Promise.resolve({ data: event });
    if (url.startsWith('/shifts/by-proposal/')) return Promise.resolve({ data: [] });
    return Promise.reject(Object.assign(new Error('not found'), { status: 404 }));
  });
});

test("the Activity card names the menu review's actions and prints every other row as it did", async () => {
  render(
    <MemoryRouter initialEntries={['/events/13']}>
      <Routes><Route path="/events/:id" element={<EventDetailPage />} /></Routes>
    </MemoryRouter>
  );
  const heading = await screen.findByRole('heading', { name: 'Activity' });
  const card = within(heading.closest('.card'));
  for (const label of ['Menu proof sent', 'Client asked for menu changes', 'Menu released for printing', 'payment', 'proposal_viewed']) {
    expect(card.getByText(label)).toBeInTheDocument();
  }
  expect(card.queryByText('menu_proof_sent')).toBeNull();
});
