import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import HiringDashboard, { splitOnboarding, FOLD_DAYS } from './HiringDashboard';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), put: jest.fn() } }));
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));

const DAY = 86400000;
const now = Date.parse('2026-08-19T12:00:00Z');
const row = (over) => ({ id: 1, onboarding_status: 'in_progress', onboarding_progress: 0, created_at: new Date(now - 10 * DAY).toISOString(), ...over });

test('a fresh 0% signup is live; an old 0% account folds; an old account with progress stays live', () => {
  const fresh = row({ id: 1 });
  const oldZero = row({ id: 2, created_at: new Date(now - (FOLD_DAYS + 1) * DAY).toISOString() });
  const oldStarted = row({ id: 3, created_at: new Date(now - 200 * DAY).toISOString(), onboarding_progress: 1 / 6 });
  const { live, folded } = splitOnboarding([fresh, oldZero, oldStarted], now);
  expect(live.map(r => r.id)).toEqual([1, 3]);
  expect(folded.map(r => r.id)).toEqual([2]);
});

test('the fold never keys on status: a day-one pre-hired recruit (hired, 0%) is live', () => {
  const { live, folded } = splitOnboarding([row({ id: 9, onboarding_status: 'hired', created_at: new Date(now - 1 * DAY).toISOString() })], now);
  expect(live).toHaveLength(1);
  expect(folded).toHaveLength(0);
});

test('exactly FOLD_DAYS old is still live; one day more folds', () => {
  const edge = row({ id: 4, created_at: new Date(now - FOLD_DAYS * DAY).toISOString() });
  const past = row({ id: 5, created_at: new Date(now - (FOLD_DAYS + 1) * DAY).toISOString() });
  const { live, folded } = splitOnboarding([edge, past], now);
  expect(live.map(r => r.id)).toEqual([4]);
  expect(folded.map(r => r.id)).toEqual([5]);
});

// --- Render, inside a stand-in for the hub layout ----------------------------
// The dev-server walk the plan asks for is not available to this lane (the dev
// server serves main, not the worktree), so the board is asserted here instead:
// the hub owns the header, the column count reads the live list, and the fold
// expands into rows that link to the staffer page.
function HubStandIn() {
  const [actions, setActions] = useState(null);
  return (
    <div>
      <div data-testid="page-actions">{actions}</div>
      <Outlet context={{ summary: null, setActions }} />
    </div>
  );
}

const SUMMARY = { new_apps_7d: 1, need_to_schedule: 0, stalled: 0, in_pipeline: 4 };
// Fixed dates stay older than FOLD_DAYS forever; the live row is relative so it
// stays fresh whenever this suite runs.
const APPLIED = { id: 11, full_name: 'Danielle Okoye', email: 'd@example.com', onboarding_status: 'applied', applied_at: new Date(Date.now() - 2 * DAY).toISOString(), created_at: new Date(Date.now() - 2 * DAY).toISOString() };
const LIVE = { id: 12, full_name: 'Owen Mercer', email: 'o@example.com', onboarding_status: 'in_progress', onboarding_progress: 0.5, created_at: new Date(Date.now() - 5 * DAY).toISOString() };
const STALE_HIRED = { id: 42, full_name: 'Aaron Blake', email: 'a@example.com', onboarding_status: 'hired', onboarding_progress: 0, created_at: '2026-05-27T12:00:00Z' };
const STALE_SIGNUP = { id: 43, full_name: 'Bianca Reyes', email: 'b@example.com', onboarding_status: 'in_progress', onboarding_progress: 0, created_at: '2026-06-10T12:00:00Z' };

function renderHiring({ applications, entry = '/staffing/hiring' } = {}) {
  api.get.mockImplementation((url) => {
    if (url.startsWith('/admin/applications')) return Promise.resolve({ data: { applications } });
    if (url.startsWith('/admin/hiring/summary')) return Promise.resolve({ data: SUMMARY });
    return Promise.resolve({ data: {} });
  });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/staffing" element={<HubStandIn />}>
          <Route path="hiring" element={<HiringDashboard />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => { jest.clearAllMocks(); });

test('the page renders no header of its own: the pipeline line and the search sit in a toolbar row', async () => {
  const { container } = renderHiring({ applications: [APPLIED, LIVE] });
  expect(await screen.findByText('Danielle Okoye')).toBeInTheDocument();
  expect(container.querySelector('.page-header')).toBeNull();
  expect(container.querySelector('.page-title')).toBeNull();
  expect(screen.getByText('4 in pipeline · 1 new this week')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Search all applicants…')).toBeInTheDocument();
});

test('stale records leave the column for a collapsed fold; the count reads the live list', async () => {
  const { container } = renderHiring({ applications: [APPLIED, LIVE, STALE_HIRED, STALE_SIGNUP] });
  expect(await screen.findByText('Owen Mercer')).toBeInTheDocument();

  // Onboarding is the third column; its count badge is the live number, 1.
  const counts = [...container.querySelectorAll('.k')].map(el => el.textContent);
  expect(counts).toEqual(['1', '0', '1']);

  // Collapsed by default: the stale names are not on the board.
  expect(screen.queryByText('Aaron Blake')).not.toBeInTheDocument();
  const fold = screen.getByRole('button', { name: /Not started/ });
  expect(fold).toHaveAttribute('aria-expanded', 'false');
  expect(fold).toHaveTextContent('Not started · 2 · oldest May 27, 2026 · not pipeline');

  fireEvent.click(fold);
  expect(fold).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText(/Accounts older than 60 days that never began onboarding/)).toBeInTheDocument();
  // Rows link to the staffer page, where the deactivate action lives.
  expect(screen.getByRole('link', { name: /Aaron Blake/ })).toHaveAttribute('href', '/staffing/users/42');
  expect(screen.getByRole('link', { name: /Bianca Reyes/ })).toHaveAttribute('href', '/staffing/users/43');
  // The status word, not the raw status.
  expect(screen.getByText('pre-hired')).toBeInTheDocument();
  expect(screen.getByText('signed up')).toBeInTheDocument();
});

test('an Onboarding column that is only stale records shows the fold instead of the empty tile', async () => {
  renderHiring({ applications: [STALE_HIRED] });
  expect(await screen.findByRole('button', { name: /Not started/ })).toBeInTheDocument();
  // Applied and Interview are genuinely empty; Onboarding is not.
  expect(screen.getAllByText('Empty.')).toHaveLength(2);
});

test('the ?schedule= deep link still opens the interview modal', async () => {
  renderHiring({ applications: [APPLIED, LIVE], entry: '/staffing/hiring?schedule=11' });
  const dialog = await screen.findByRole('dialog', { name: 'Schedule interview' });
  expect(dialog).toBeInTheDocument();
});

test('search still queries the hiring search endpoint and lists matches', async () => {
  renderHiring({ applications: [APPLIED] });
  await screen.findByText('Danielle Okoye');
  api.get.mockImplementation((url) => {
    if (url.startsWith('/admin/hiring/search')) {
      return Promise.resolve({ data: { results: [{ id: 77, full_name: 'Rosa Ibarra', email: 'r@example.com', state: 'rejected' }] } });
    }
    return Promise.resolve({ data: { applications: [APPLIED] } });
  });
  fireEvent.change(screen.getByPlaceholderText('Search all applicants…'), { target: { value: 'Rosa' } });
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/hiring/search?q=Rosa'));
  expect(await screen.findByText('Rosa Ibarra')).toBeInTheDocument();
});
