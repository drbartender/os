import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import ReviewsPage from './ReviewsPage';
import api from '../../../../utils/api';

jest.mock('../../../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
}));

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../../../context/ToastContext', () => ({ useToast: () => mockToast }));

const STAFF = [{ id: 7, display_name: 'Shea Corrigan' }, { id: 8, display_name: 'Marcus Webb' }];

const PENDING = {
  id: 11,
  status: 'pending',
  stars: 5,
  source: 'thumbtack',
  review_date: '2026-08-17',
  excerpt: 'Shea was so professional and prompt!',
  credits: [{ user_id: 7, name: 'Shea Corrigan' }],
};
const CONFIRMED = { ...PENDING, status: 'confirmed' };

// The envelope carries the money (spec §5/§7): the page renders bounty_cents
// and never a literal, so the test asserts on numbers only this fixture sets.
const ENVELOPE = (reviews) => ({
  data: { reviews, bounty_cents: 1000, bounties_paid_cents: 4000, total_logged: 6 },
});

const LEADERBOARD = {
  data: {
    rows: [], shares: [], pot_cents: 0, min_events_worked: 4,
    min_named_five_stars: 2, in_progress: true,
    start_date: '2026-07-01', end_date: '2026-09-30',
  },
};

// Award is disabled by a half-typed quarter, a load in flight, an empty split
// or a closed period. This fixture clears the first three so a test about the
// period state cannot pass for one of the other reasons.
const AWARDABLE = {
  data: {
    ...LEADERBOARD.data,
    rows: [{ user_id: 7, name: 'Shea Corrigan', named_five_stars: 3, events_worked: 6, eligible: true }],
    shares: [{ user_id: 7, name: 'Shea Corrigan', amount_cents: 5000 }],
    pot_cents: 5000,
  },
};

// Stands in for StaffHubLayout: it owns the header, so whatever the child
// registers through setActions has to land in the page-actions slot.
function HubStandIn({ summary, refresh }) {
  const [actions, setActions] = useState(null);
  return (
    <div>
      <div data-testid="page-actions">{actions}</div>
      <Outlet context={{ summary, refresh, setActions }} />
    </div>
  );
}

function renderReviews({ summary = null, refresh = jest.fn() } = {}) {
  render(
    <MemoryRouter initialEntries={['/staffing/reviews']}>
      <Routes>
        <Route path="/staffing" element={<HubStandIn summary={summary} refresh={refresh} />}>
          <Route path="reviews" element={<ReviewsPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
  return refresh;
}

// Reviews list, roster and leaderboard all come through api.get; route by URL
// so the rail and the workbench can be driven independently.
function mockGets({ reviews, leaderboard = LEADERBOARD }) {
  api.get.mockImplementation((url) => {
    if (url.startsWith('/admin/staff-reviews/leaderboard')) return Promise.resolve(leaderboard);
    if (url.startsWith('/admin/staff-reviews')) return Promise.resolve(ENVELOPE(reviews()));
    if (url.startsWith('/admin/active-staff')) return Promise.resolve({ data: { staff: STAFF } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

beforeEach(() => { jest.clearAllMocks(); });

// The page and the rail fetch independently; wait on a marker from each so no
// state update lands after the test ends.
async function settled() {
  await screen.findByText(/6 logged/);
  await screen.findByText(/Qualifying takes at least 4 events worked/);
}

test('the header action registers into the hub slot and opens the log form', async () => {
  mockGets({ reviews: () => [CONFIRMED] });
  renderReviews();

  await settled();
  const slot = screen.getByTestId('page-actions');
  const action = within(slot).getByRole('button', { name: 'Log a Google review' });
  // The child renders no page-header of its own; the hub owns the title.
  expect(document.querySelector('.page-header')).toBeNull();

  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(action);
  expect(await screen.findByRole('dialog', { name: 'Log a Google review' })).toBeInTheDocument();
});

test('resolved rows and the all-time footer render from the envelope', async () => {
  mockGets({ reviews: () => [CONFIRMED] });
  renderReviews();

  await settled();
  // bounty_cents x one credit, and the all-time line, both from the payload.
  expect(screen.getByText('$10.00')).toBeInTheDocument();
  expect(screen.getByText(/6 logged/)).toBeInTheDocument();
  expect(screen.getByText(/\$40\.00 in bounties paid/)).toBeInTheDocument();
  // Resolved, so no pending card: the Confirm button is gone.
  expect(screen.queryByRole('button', { name: /^Confirm/ })).toBeNull();
});

test('a confirm that materializes nothing marks the row waiting and refreshes the hub', async () => {
  let rows = [PENDING];
  mockGets({ reviews: () => rows });
  api.post.mockImplementation(() => {
    rows = [CONFIRMED];               // the reload sees the row resolved
    return Promise.resolve({ data: { materialized: 0, restored: 0 } });
  });
  const refresh = renderReviews({ summary: { open_period: { exists: false, status: null } } });

  await settled();
  const confirm = screen.getByRole('button', { name: /^Confirm/ });
  // No open period, so the label promises a wait rather than a payment.
  expect(confirm).toHaveTextContent('Confirm, $10.00 waits for the next open run');
  fireEvent.click(confirm);

  // Wait on the DOM outcome first: the third state (spec §7) shows on the
  // resolved row until a reload proves otherwise, since the server carries no
  // flag for it. Everything the click set off has settled by then.
  expect(await screen.findByText(/waiting for an open period/)).toBeInTheDocument();
  expect(api.post).toHaveBeenCalledWith('/admin/staff-reviews/11/confirm');
  expect(mockToast.success).toHaveBeenCalledWith('Confirmed. The bounty waits for the next open pay run.');
  expect(refresh).toHaveBeenCalled();
  await settled();
});

test('the award button is disabled with the no-open-period reason', async () => {
  mockGets({ reviews: () => [CONFIRMED], leaderboard: AWARDABLE });
  renderReviews({ summary: { open_period: { exists: true, status: 'processing' } } });

  await settled();
  const award = screen.getByRole('button', { name: 'Award the quarter' });
  expect(award).toBeDisabled();
  expect(screen.getByText('No open pay period. Open one before awarding.')).toBeInTheDocument();
});

// The hub summary is null while its fetch is in flight and stays null if that
// fetch fails, so a null open_period is UNKNOWN, not closed. Stating "no open
// pay period" there is a claim the page cannot support, and hard-disabling on
// it locks out an award the server would accept. The 409 is the backstop.
test('an unknown pay period neither claims there is none nor blocks the award', async () => {
  mockGets({ reviews: () => [CONFIRMED], leaderboard: AWARDABLE });
  renderReviews({ summary: null });

  await settled();
  expect(screen.queryByText('No open pay period. Open one before awarding.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Award the quarter' })).toBeEnabled();
});

test('the list error state offers Retry and keeps the header action alive', async () => {
  api.get.mockRejectedValue(Object.assign(new Error('Server unavailable.'), { status: 500 }));
  renderReviews();

  expect(await screen.findByText('Server unavailable.')).toBeInTheDocument();
  const slot = screen.getByTestId('page-actions');
  fireEvent.click(within(slot).getByRole('button', { name: 'Log a Google review' }));
  expect(await screen.findByRole('dialog', { name: 'Log a Google review' })).toBeInTheDocument();

  mockGets({ reviews: () => [CONFIRMED] });
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await settled();
});

// Manual Google rows carry no external key, so the server flags a same-date
// Thumbtack row rather than refusing. The page has to surface that flag.
test('the duplicate warning from a manual log surfaces as a card', async () => {
  mockGets({ reviews: () => [CONFIRMED] });
  api.post.mockResolvedValue({ data: { review: { id: 12 }, duplicate_warning: true } });
  renderReviews();

  await settled();
  fireEvent.click(within(screen.getByTestId('page-actions')).getByRole('button', { name: 'Log a Google review' }));
  fireEvent.change(await screen.findByLabelText('Review date'), { target: { value: '2026-08-17' } });
  fireEvent.click(screen.getByRole('button', { name: 'Log review' }));

  expect(await screen.findByText(/Possible duplicate/)).toBeInTheDocument();
  expect(api.post).toHaveBeenCalledWith('/admin/staff-reviews', {
    review_date: '2026-08-17', stars: 5, excerpt: null,
  });
  // The form closes on success so the warning is not hidden behind the scrim.
  expect(screen.queryByRole('dialog')).toBeNull();
  await settled();
});

// The leaderboard endpoint requires ?quarter=; a half-typed value is not a
// request, so the rail holds the fetch and says what it wants instead.
test('a half-typed quarter shows the hint and fires no leaderboard fetch', async () => {
  mockGets({ reviews: () => [CONFIRMED] });
  renderReviews();

  await settled();
  const before = api.get.mock.calls.filter(([u]) => u.startsWith('/admin/staff-reviews/leaderboard')).length;
  fireEvent.change(screen.getByLabelText('Quarter'), { target: { value: '2026-Q' } });

  expect(await screen.findByText('Enter a quarter like 2026-Q3.')).toBeInTheDocument();
  const after = api.get.mock.calls.filter(([u]) => u.startsWith('/admin/staff-reviews/leaderboard')).length;
  expect(after).toBe(before);
});

// Spec §7 requires that dismiss survives the rewrite, including the server's
// refusal while a bounty is paid or frozen. Dismiss on the pending card alone
// cannot reach it: a confirmed review lives in the resolved table, and a paid
// bounty only exists once a review is confirmed.
test('a confirmed review can still be dismissed from the resolved table', async () => {
  let rows = [CONFIRMED];
  mockGets({ reviews: () => rows });
  api.post.mockImplementation(() => {
    rows = [{ ...CONFIRMED, status: 'dismissed' }];   // the reload sees it dismissed
    return Promise.resolve({ data: { review: { id: 11, status: 'dismissed' }, removed_lines: 1 } });
  });
  const refresh = renderReviews();

  await settled();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/staff-reviews/11/dismiss'));
  expect(await screen.findByText('dismissed')).toBeInTheDocument();
  expect(refresh).toHaveBeenCalled();
  await settled();
});

// The list payload carries no per-review paid flag, so the refusal is the
// server's to make. The row has to survive it unchanged.
test('the server refusal on a paid bounty surfaces as the error toast', async () => {
  mockGets({ reviews: () => [CONFIRMED] });
  api.post.mockRejectedValue(Object.assign(
    new Error('a review bounty for this review is already paid; dismiss is refused'),
    { status: 409 }
  ));
  renderReviews();

  await settled();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

  await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(
    'a review bounty for this review is already paid; dismiss is refused'
  ));
  expect(screen.getByText('confirmed')).toBeInTheDocument();
  await settled();
});
