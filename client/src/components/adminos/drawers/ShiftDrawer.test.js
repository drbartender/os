import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ShiftDrawer from './ShiftDrawer';
import api from '../../../utils/api';

jest.mock('../../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() },
}));

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../../context/ToastContext', () => ({ useToast: () => mockToast }));

jest.mock('../../EntityLink', () => ({
  __esModule: true,
  default: ({ children }) => <span>{children}</span>,
}));

// Money seam: the manual-assign picker preselects the position that gets written
// to shift_requests.position, which payroll's tip split keys on. These tests pin
// WHICH role it preselects against the two inputs that decide it — the roster and
// who is currently filling it.

const STAFF = [{ id: 99, preferred_name: 'Casey Rivera', email: 'casey@example.com' }];

function mockShift(positionsNeeded, requests) {
  api.get.mockImplementation((url) => {
    if (url.startsWith('/admin/active-staff')) {
      return Promise.resolve({ data: { staff: STAFF } });
    }
    if (url.startsWith('/shifts/detail/')) {
      return Promise.resolve({
        data: {
          shift: {
            id: 1,
            event_date: '2026-08-01',
            positions_needed: positionsNeeded,
            equipment_required: '[]',
            supply_run_required: false,
          },
          requests,
        },
      });
    }
    return Promise.resolve({ data: {} });
  });
}

// Opens the picker and picks a staff member, which is what reveals the role
// select. Returns once the select is on screen.
async function openPickerAndSelectStaff() {
  fireEvent.click(await screen.findByText('Assign someone'));
  fireEvent.change(screen.getByPlaceholderText('Search staff by name…'), {
    target: { value: 'Casey' },
  });
  fireEvent.click(await screen.findByText('Casey Rivera'));
  return screen.findByRole('combobox');
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ShiftDrawer manual-assign position default', () => {
  test('open bartender slot preselects Bartender', async () => {
    mockShift('["Bartender","Barback"]', []);
    render(<ShiftDrawer shiftId={1} open onClose={() => {}} />);

    const select = await openPickerAndSelectStaff();
    expect(select).toHaveValue('Bartender');
    expect(screen.getByText('Assign as Bartender')).toBeInTheDocument();
  });

  test('bartender slot filled falls through to the open Barback slot', async () => {
    mockShift('["Bartender","Barback"]', [
      { id: 10, user_id: 5, status: 'approved', position: 'Bartender', dropped_at: null, staff_name: 'Alex Kim' },
    ]);
    render(<ShiftDrawer shiftId={1} open onClose={() => {}} />);

    const select = await openPickerAndSelectStaff();
    expect(select).toHaveValue('Barback');
  });

  // Regression: an EMERGENCY drop sets dropped_at but LEAVES status 'approved',
  // and GET /shifts/detail/:id returns every request row unfiltered. Counting
  // that row as filling its slot made the picker skip the role that actually
  // needs the replacement — in the <72h scramble the picker exists for.
  test('an emergency-dropped staffer does not hold their slot', async () => {
    mockShift('["Bartender","Barback"]', [
      { id: 10, user_id: 5, status: 'approved', position: 'Bartender', dropped_at: null, staff_name: 'Alex Kim' },
      { id: 11, user_id: 6, status: 'approved', position: 'Barback', dropped_at: '2026-07-30T18:00:00Z', staff_name: 'Jordan Poe' },
    ]);
    render(<ShiftDrawer shiftId={1} open onClose={() => {}} />);

    const select = await openPickerAndSelectStaff();
    expect(select).toHaveValue('Barback');

    // ...and they are no longer shown as Confirmed on the shift.
    await waitFor(() => expect(screen.queryByText('Jordan Poe')).not.toBeInTheDocument());
    expect(screen.getByText('Alex Kim')).toBeInTheDocument();
  });

  test('a hand-picked role wins over the default and is what gets POSTed', async () => {
    mockShift('["Bartender","Barback"]', []);
    api.post.mockResolvedValue({ data: {} });
    render(<ShiftDrawer shiftId={1} open onClose={() => {}} />);

    const select = await openPickerAndSelectStaff();
    fireEvent.change(select, { target: { value: 'Barback' } });
    expect(screen.getByText('Assign as Barback')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Assign as Barback'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/shifts/1/assign', { user_id: 99, position: 'Barback' })
    );
  });

  test('a roster of nothing but non-canonical labels still offers all three roles', async () => {
    mockShift('["Sous Chef"]', []);
    render(<ShiftDrawer shiftId={1} open onClose={() => {}} />);

    const select = await openPickerAndSelectStaff();
    expect(select).toHaveValue('Bartender');
    expect(Array.from(select.options).map(o => o.value))
      .toEqual(['Bartender', 'Banquet Server', 'Barback']);
  });
});
