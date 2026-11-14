import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

// Desktop Events list, two cells from Dallas's 2026-09-22 drop: the Supplies
// prep chip wears the info blue (Bar stays neutral), and an owed Status chip
// carries its due date underneath, red once the date has passed. Also the Plan
// cell's chips, each coloured by whose move its tag is (spec 2026-10-19
// section 14): Menu with client stays the client's grey on a row that is yours.

const mockMobileView = { isPhone: false, desktopView: jest.fn(() => false), setDesktopView: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockMobileView }));
jest.mock('../mobile/EventsListPhone', () => ({ __esModule: true, default: () => <div data-testid="phone-list" /> }));
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));
const mockPalette = { openPalette: jest.fn() };
jest.mock('../../context/PaletteContext', () => ({ ...jest.requireActual('../../context/PaletteContext'), usePalette: () => mockPalette }));
import { MemoryRouter } from 'react-router-dom';
import api from '../../utils/api';
import EventsDashboard from './EventsDashboard';

// Far-off dates so the suite never depends on the wall clock: a due date in
// 2000 is past due on any day this runs, and one in 2099 is not yet due. Both
// events sit in 2099 so they land on the default Upcoming tab.
const row = (over) => ({
  id: over.id, proposal_id: over.id, client_name: over.client_name,
  event_date: '2099-07-01T00:00:00.000Z', start_time: '18:00', end_time: '22:00',
  proposal_status: 'confirmed', status: 'open', guest_count: 80,
  proposal_total: 1200, proposal_amount_paid: 400,
  positions_needed: '[]', request_count: 0, approved_count: 0, pending_count: 0,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockImplementation((url) => Promise.resolve({ data: url === '/shifts' ? [
    row({ id: 1, client_name: 'Late Client', proposal_balance_due_date: '2000-01-01T00:00:00.000Z' }),
    row({ id: 2, client_name: 'Upcoming Client', proposal_balance_due_date: '2099-06-15T00:00:00.000Z', supply_run_required: true, bar_required: true }),
    row({ id: 3, client_name: 'Paid Client', proposal_amount_paid: 1200, proposal_balance_due_date: '2000-01-01T00:00:00.000Z' }),
    // Owes the Shopping List (yours) with the menu proof out (theirs). No due
    // date, so the due-line count below is unchanged.
    row({ id: 4, client_name: 'Proof Client', shopping_list_status: 'pending_review', menu_done: false, menu_with_client: true }),
  ] : [] }));
});

const mount = () => render(<MemoryRouter initialEntries={['/events']}><EventsDashboard /></MemoryRouter>);

test('a past due date reads "Past due" in the red style under the owed chip', async () => {
  mount();
  const line = await screen.findByText('Past due Jan 1, 2000');
  expect(line).toHaveClass('sub', 'pay-past-due');
});

test('a future due date reads "Due" in the plain sub style', async () => {
  mount();
  const line = await screen.findByText('Due Jun 15, 2099');
  expect(line).toHaveClass('sub');
  expect(line).not.toHaveClass('pay-past-due');
});

test('a paid event shows no due line, even with a stale due date', async () => {
  mount();
  await screen.findByText('Paid Client');
  expect(screen.getByText('Paid in Full')).toBeInTheDocument();
  // Only the two owed rows carry a due line.
  expect(screen.getAllByText(/^(Past due|Due) /)).toHaveLength(2);
});

test('Supplies wears the info chip and Bar stays neutral', async () => {
  mount();
  const supplies = await screen.findByText('Supplies');
  expect(supplies.closest('.chip')).toHaveClass('info');
  expect(screen.getByText('Bar').closest('.chip')).toHaveClass('neutral');
});

test('the Plan cell colours each tag by whose move it is: Menu with client grey beside an amber Shopping List', async () => {
  mount();
  const withClient = (await screen.findByText('Menu with client')).closest('.chip');
  const list = screen.getByText('Shopping List').closest('.chip');
  expect(list).toHaveClass('warn');
  expect(withClient).toHaveClass('neutral');
  expect(withClient).not.toHaveClass('warn');
});
