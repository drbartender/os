import React, { useState } from 'react';
import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import StaffDashboard, { isImportedRecord } from './StaffDashboard';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { role: 'admin' } }) }));
// GlobalSearchButton (inside Toolbar) throws outside AdminLayout's provider.
jest.mock('../../context/PaletteContext', () => ({
  __esModule: true,
  usePalette: () => ({ openPalette: jest.fn() }),
  default: {},
}));

// The Deactivated/All groups split "former staff" from "imported records"
// (spec section 6). The predicate is status-scoped so it matches the server's
// imported_count exactly: an ACTIVE account that happens to carry an import
// marker is a real staffer, not a placeholder.
test('legacy CC stubs and deactivated payment-history imports are imported records; active imports are not', () => {
  expect(isImportedRecord({ cc_id: 'legacy_cc:9', onboarding_status: 'deactivated' })).toBe(true);
  expect(isImportedRecord({ import_source: 'payment_history_import', onboarding_status: 'deactivated' })).toBe(true);
  expect(isImportedRecord({ import_source: 'payment_history_import', onboarding_status: 'approved' })).toBe(false);
  expect(isImportedRecord({ onboarding_status: 'deactivated' })).toBe(false);
});

test('an approved legacy_cc account is not an imported record, and a missing row is safe', () => {
  expect(isImportedRecord({ cc_id: 'legacy_cc:9', onboarding_status: 'approved' })).toBe(false);
  expect(isImportedRecord(null)).toBe(false);
  expect(isImportedRecord({})).toBe(false);
});

// --- Render, inside a stand-in for the hub layout ----------------------------
// The hub owns the page header and hands the child { summary, setActions }
// through Outlet context; the stand-in below renders whatever the child
// registers, which is how the Send SMS action is asserted end to end.
function HubStandIn({ summary }) {
  const [actions, setActions] = useState(null);
  return (
    <div>
      <div data-testid="page-actions">{actions}</div>
      <Outlet context={{ summary, setActions }} />
    </div>
  );
}

function renderRoster({ staff = [], summary = null, entry = '/staffing' } = {}) {
  api.get.mockResolvedValue({ data: { staff, total: staff.length, page: 1, pages: 1 } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/staffing" element={<HubStandIn summary={summary} />}>
          <Route index element={<StaffDashboard />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

const FORMER = { id: 2, display_name: 'Erin Walsh', email: 'erin@example.com', onboarding_status: 'deactivated', role: 'staff' };
const IMPORTED = { id: 3, display_name: 'P. Novak', email: 'p.novak@imported.invalid', onboarding_status: 'deactivated', import_source: 'payment_history_import', role: 'staff' };
const ACTIVE = { id: 1, display_name: 'Ada Bar', email: 'ada@example.com', onboarding_status: 'approved', role: 'staff' };
// GET /admin/active-staff returns approved, reviewed, submitted and (with
// include_stubs) deactivated. A 'submitted' staffer has FINISHED onboarding
// and is waiting on admin approval, so they are neither Active nor
// Deactivated and need a bucket of their own.
const AWAITING = { id: 4, display_name: 'Sam Pending', email: 'sam@example.com', onboarding_status: 'submitted', role: 'staff' };

beforeEach(() => { jest.clearAllMocks(); });

test('the Deactivated view groups former staff above imported records and never shows the placeholder address', async () => {
  renderRoster({ staff: [ACTIVE, FORMER, IMPORTED], entry: '/staffing?tab=deactivated' });

  expect(await screen.findByText('Former staff · 1')).toBeInTheDocument();
  expect(screen.getByText('Imported records · 1')).toBeInTheDocument();
  expect(screen.getByText('erin@example.com')).toBeInTheDocument();
  expect(screen.getByText('no email on file')).toBeInTheDocument();
  expect(screen.queryByText('p.novak@imported.invalid')).toBeNull();
  // Active rows stay out of the Deactivated view.
  expect(screen.queryByText('Ada Bar')).toBeNull();
  expect(screen.getByText('2 deactivated · 1 former staff, 1 imported records')).toBeInTheDocument();
  // Send SMS registers into the hub's actions slot, not into a page header.
  expect(screen.getByRole('button', { name: /Send SMS/ })).toBeInTheDocument();
});

test('an empty Active roster shows the hub empty state with the waiting-application line and no footer count', async () => {
  renderRoster({ staff: [], summary: { active_count: 0, deactivated_count: 0, new_applications: 1 } });

  expect(await screen.findByText('No active staff yet')).toBeInTheDocument();
  expect(screen.getByText(/One application is waiting for a first look right now\./)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open Hiring' })).toBeInTheDocument();
  expect(screen.queryByText('0 active')).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
});

// The old roster shipped an "all" tab, so /staffing?tab=all links live in the
// wild (and in saved bookmarks). The URL value has to keep landing on a real
// view, now the three-group one, rather than falling back to Active.
test('a legacy ?tab=all link lands on the All view: Active group first, then former staff, then imported records', async () => {
  const { container } = renderRoster({ staff: [ACTIVE, FORMER, IMPORTED], entry: '/staffing?tab=all' });

  expect(await screen.findByText('Active · 1')).toBeInTheDocument();
  const sections = Array.from(container.querySelectorAll('tr.roster-sect td')).map(td => td.textContent);
  expect(sections).toEqual(['Active · 1', 'Former staff · 1', 'Imported records · 1']);
  expect(screen.getByText('Ada Bar')).toBeInTheDocument();
  expect(screen.getByText('3 team members')).toBeInTheDocument();
});

test('the All view renders awaiting-approval staffers instead of silently dropping them', async () => {
  const { container } = renderRoster({ staff: [ACTIVE, AWAITING, FORMER, IMPORTED], entry: '/staffing?tab=all' });

  expect(await screen.findByText('Active · 1')).toBeInTheDocument();
  const sections = Array.from(container.querySelectorAll('tr.roster-sect td')).map(td => td.textContent);
  expect(sections).toEqual(['Active · 1', 'Awaiting approval · 1', 'Former staff · 1', 'Imported records · 1']);
  // The row itself renders, and the footer count matches what is on screen.
  expect(screen.getByText('Sam Pending')).toBeInTheDocument();
  expect(screen.getByText('4 team members')).toBeInTheDocument();
  // A staffer who completed onboarding is not chipped as still onboarding.
  expect(screen.getByText('Awaiting approval')).toBeInTheDocument();
  expect(screen.queryByText('Onboarding')).toBeNull();
});

test('a group with no members renders no header row', async () => {
  const { container } = renderRoster({ staff: [ACTIVE, FORMER], entry: '/staffing?tab=all' });

  await screen.findByText('Active · 1');
  const sections = Array.from(container.querySelectorAll('tr.roster-sect td')).map(td => td.textContent);
  expect(sections).toEqual(['Active · 1', 'Former staff · 1']);
  expect(sections).not.toContain('Imported records · 0');
});
