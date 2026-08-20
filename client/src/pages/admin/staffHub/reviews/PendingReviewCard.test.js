import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PendingReviewCard from './PendingReviewCard';
import api from '../../../../utils/api';

jest.mock('../../../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
}));

const STAFF = [{ id: 7, display_name: 'Shea Corrigan' }, { id: 8, display_name: 'Marcus Webb' }];
const BOUNTY = 1000;

const PENDING = {
  id: 11,
  status: 'pending',
  stars: 5,
  source: 'thumbtack',
  review_date: '2026-08-17',
  excerpt: 'It was a wonderful experience! Shea was so professional and prompt!',
  credits: [],
};

// Stands in for ReviewsPage: the card never mutates its own review, it reports
// through onChanged and the page reloads. afterChange is the reloaded row.
function Harness({ review, openPeriod = null, afterChange, onChanged }) {
  const [current, setCurrent] = useState(review);
  return (
    <MemoryRouter>
      <PendingReviewCard
        review={current}
        staff={STAFF}
        bountyCents={BOUNTY}
        openPeriod={openPeriod}
        onChanged={(res) => {
          if (onChanged) onChanged(res);
          if (afterChange) setCurrent(afterChange);
        }}
        onError={() => {}}
      />
    </MemoryRouter>
  );
}

beforeEach(() => { jest.clearAllMocks(); });

// A suggested name is not a credit. Confirm writes payout_duty_lines, so it
// stays locked until the admin has actually saved the names it would pay.
test('Confirm is disabled while names are dirty, with the save-first hint', async () => {
  api.patch.mockResolvedValue({ data: {} });
  render(
    <Harness
      review={PENDING}
      afterChange={{ ...PENDING, credits: [{ user_id: 7, name: 'Shea Corrigan' }] }}
    />
  );

  // The excerpt names Shea, so the chip pre-fills as a suggestion.
  expect(screen.getByText('Shea Corrigan')).toBeInTheDocument();
  expect(screen.getByText(/Suggested from the excerpt/)).toBeInTheDocument();

  const confirmBtn = screen.getByRole('button', { name: /^Confirm/ });
  expect(confirmBtn).toBeDisabled();
  expect(confirmBtn).toHaveAttribute('title', 'Save names first');
  // Nothing is saved yet, so the label promises no money.
  expect(confirmBtn).toHaveTextContent('Confirm, no bounty');

  fireEvent.click(screen.getByRole('button', { name: 'Save names' }));

  await waitFor(() => expect(api.patch).toHaveBeenCalledWith(
    '/admin/staff-reviews/11',
    { credited_user_ids: [7] }
  ));
  await waitFor(() => expect(screen.getByRole('button', { name: /^Confirm/ })).toBeEnabled());
  const saved = screen.getByRole('button', { name: /^Confirm/ });
  expect(saved).not.toHaveAttribute('title');
  // No open period in this render, so the label says where the money waits.
  expect(saved).toHaveTextContent('Confirm, $10.00 waits for the next open run');
});

// The third state (spec §7): the confirm succeeded but no open pay period
// existed, so nothing materialized. The page needs that fact to mark the row.
// restored rides alongside materialized: a revived tombstone pays into the
// current run while reporting materialized 0, so the page needs both numbers.
test('confirm resolving materialized:0 reports it through onChanged', async () => {
  api.post.mockResolvedValue({ data: { materialized: 0, restored: 0 } });
  const onChanged = jest.fn();
  render(
    <Harness
      review={{ ...PENDING, credits: [{ user_id: 7, name: 'Shea Corrigan' }] }}
      onChanged={onChanged}
    />
  );

  const confirmBtn = screen.getByRole('button', { name: /^Confirm/ });
  expect(confirmBtn).toBeEnabled();
  fireEvent.click(confirmBtn);

  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/staff-reviews/11/confirm'));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith({
    reviewId: 11,
    materialized: 0,
    restored: 0,
    bountyEligible: true,
  }));
});

// With a period open the label commits to paying now, and the amount scales
// with the number of saved credits (bounty x names, from the envelope).
test('an open period pays now, and the amount follows the saved credit count', () => {
  render(
    <Harness
      review={{ ...PENDING, credits: [{ user_id: 7, name: 'Shea Corrigan' }, { user_id: 8, name: 'Marcus Webb' }] }}
      openPeriod={{ exists: true, status: 'open' }}
    />
  );
  expect(screen.getByRole('button', { name: /^Confirm/ })).toHaveTextContent('Confirm and pay $20.00');
  // Saved credits are not suggestions, so the caption stays off.
  expect(screen.queryByText(/Suggested from the excerpt/)).toBeNull();
});
