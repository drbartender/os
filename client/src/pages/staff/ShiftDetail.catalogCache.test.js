import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ShiftDetail from './ShiftDetail';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), defaults: { baseURL: 'http://api.test/api' } },
}));
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 12, role: 'staff' } }) }));
jest.mock('../../context/ToastContext', () => ({
  useToast: () => ({ success: jest.fn(), error: jest.fn(), info: jest.fn() }),
}));

const detailsFor = (shiftId) => ({
  proposal: { id: 55, event_type: 'wedding', tip_jar: true },
  client: { name: 'Test Client' },
  package: { name: 'Standard' },
  drink_plan: {
    id: 3,
    has_logo: true,
    finalized_at: '2026-08-01T00:00:00.000Z',
    selections: { menuStyle: 'custom', signatureDrinks: [1] },
  },
  addons: [],
  team_roster: [],
  shifts: [{
    id: shiftId,
    start_time: '2026-09-01T22:00:00.000Z',
    positions_needed: [],
    approved_by_role: {},
    my_request_status: 'approved',
  }],
  viewer: { is_admin: false, is_assigned: true, is_acknowledged: false },
});

const LOGO_BLOB = new Blob(['png-bytes'], { type: 'image/png' });

function renderAt(shiftId) {
  return render(
    <MemoryRouter initialEntries={[`/shifts/${shiftId}`]}>
      <Routes><Route path="/shifts/:shiftId" element={<ShiftDetail />} /></Routes>
    </MemoryRouter>
  );
}

const callsTo = (url) => api.get.mock.calls.filter((c) => c[0] === url).length;

beforeEach(() => {
  jest.clearAllMocks();
  global.URL.createObjectURL = jest.fn(() => 'blob:shift-detail-logo');
  global.URL.revokeObjectURL = jest.fn();
});

/**
 * THIS TEST OWNS ITS OWN FILE, deliberately. The catalog memo lives at module
 * scope and Jest gives one module registry per test FILE, so any other mount in
 * the same file fills the memo before this runs and every count below reads
 * zero. It lived in ShiftDetail.test.js as a must-run-first test; a future test
 * inserted above it would have broken it. Isolation removes the ordering
 * constraint entirely rather than documenting it.
 */
test('drink catalogs are fetched once across mounts, a failed fetch is retried, event-details never cached', async () => {
  let catalogsFail = true;
  api.get.mockImplementation((url) => {
    if (url === '/cocktails') {
      return catalogsFail
        ? Promise.reject(new Error('catalog down'))
        : Promise.resolve({ data: { cocktails: [{ id: 1, name: 'Old Fashioned' }] } });
    }
    if (url === '/mocktails') {
      return catalogsFail
        ? Promise.reject(new Error('catalog down'))
        : Promise.resolve({ data: { mocktails: [] } });
    }
    const m = url.match(/^\/shifts\/(\d+)\/event-details$/);
    if (m) return Promise.resolve({ data: detailsFor(parseInt(m[1], 10)) });
    if (url === '/beo/55/logo') return Promise.resolve({ data: LOGO_BLOB });
    return Promise.reject(new Error(`unexpected ${url}`));
  });

  // Cold load with the catalog endpoints down: non-fatal, the brief still renders.
  const first = renderAt(7);
  expect(await screen.findByText('Test Client')).toBeInTheDocument();
  expect(callsTo('/cocktails')).toBe(1);
  first.unmount();

  // A rejected catalog must NOT be memoized, or one blip would serve an empty
  // drink menu for the rest of the session.
  catalogsFail = false;
  const second = renderAt(8);
  expect(await screen.findByText('Old Fashioned')).toBeInTheDocument();
  expect(callsTo('/cocktails')).toBe(2);
  expect(callsTo('/mocktails')).toBe(2);
  second.unmount();

  // Third mount rides the memoized success.
  const third = renderAt(9);
  expect(await screen.findByText('Old Fashioned')).toBeInTheDocument();
  expect(callsTo('/cocktails')).toBe(2);
  expect(callsTo('/mocktails')).toBe(2);

  // Per-shift data stays uncached: one fetch per shift opened.
  expect(callsTo('/shifts/7/event-details')).toBe(1);
  expect(callsTo('/shifts/8/event-details')).toBe(1);
  expect(callsTo('/shifts/9/event-details')).toBe(1);
  third.unmount();
});
