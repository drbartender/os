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


describe('custom menu logo', () => {
  beforeEach(() => {
    api.get.mockImplementation((url) => {
      if (url === '/cocktails') return Promise.resolve({ data: { cocktails: [] } });
      if (url === '/mocktails') return Promise.resolve({ data: { mocktails: [] } });
      const m = url.match(/^\/shifts\/(\d+)\/event-details$/);
      if (m) return Promise.resolve({ data: detailsFor(parseInt(m[1], 10)) });
      if (url === '/beo/55/logo') return Promise.resolve({ data: LOGO_BLOB });
      return Promise.reject(new Error(`unexpected ${url}`));
    });
  });

  // A browser <img src> request carries no Authorization header and
  // GET /beo/:id/logo is behind auth, so a bare URL 401s and renders blank.
  test('is fetched through api as a blob and reaches the img as an object URL', async () => {
    renderAt(11);
    const img = await screen.findByAltText('Custom menu logo');
    expect(api.get).toHaveBeenCalledWith('/beo/55/logo', { responseType: 'blob' });
    expect(URL.createObjectURL).toHaveBeenCalledWith(LOGO_BLOB);
    expect(img.getAttribute('src')).toBe('blob:shift-detail-logo');
    expect(img.getAttribute('src')).not.toMatch(/\/beo\/55\/logo/);
  });

  test('the object URL is revoked on unmount so navigation does not leak one per view', async () => {
    const view = renderAt(12);
    await screen.findByAltText('Custom menu logo');
    view.unmount();
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:shift-detail-logo'));
  });

  test('a plan with no logo neither fetches nor throws', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/cocktails') return Promise.resolve({ data: { cocktails: [] } });
      if (url === '/mocktails') return Promise.resolve({ data: { mocktails: [] } });
      const m = url.match(/^\/shifts\/(\d+)\/event-details$/);
      if (m) {
        const d = detailsFor(parseInt(m[1], 10));
        return Promise.resolve({ data: { ...d, drink_plan: { ...d.drink_plan, has_logo: false } } });
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    renderAt(13);
    expect(await screen.findByText('Test Client')).toBeInTheDocument();
    expect(screen.queryByAltText('Custom menu logo')).not.toBeInTheDocument();
    expect(callsTo('/beo/55/logo')).toBe(0);
  });
});
