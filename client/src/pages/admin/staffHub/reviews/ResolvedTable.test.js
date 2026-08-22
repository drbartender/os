import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ResolvedTable from './ResolvedTable';

jest.mock('../../../../utils/api', () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
}));

// Spec §7 promised "dismiss refused AND the button disabled with a reason".
// Only the refusal existed: the list payload carried no per-review flag, so the
// button could not state the reason before the click and an admin learned it
// from a 409 afterwards. The server now sends `bounty_lock`, derived from the
// same lockReasonOf() the refusal uses, so the two cannot tell different
// stories about the same row.

const row = (over = {}) => ({
  id: 1, status: 'confirmed', stars: 5, review_date: '2026-08-01',
  source: 'google', excerpt: 'great bar', credits: [{ user_id: 9, name: 'Amy' }],
  bounty_lock: null, ...over,
});

const dismissBtn = () => screen.getByRole('button', { name: /dismiss/i });

// MemoryRouter because the credited-staffer cell renders an EntityLink, which
// is a react-router Link and needs a router in context.
const paint = (r) => render(
  <MemoryRouter>
    <ResolvedTable reviews={[r]} bountyCents={1000} waitingIds={new Set()}
      onChanged={() => {}} onError={() => {}} />
  </MemoryRouter>
);

test('an unlocked bounty leaves Dismiss live and says nothing extra', () => {
  paint(row());
  expect(dismissBtn()).toBeEnabled();
  expect(dismissBtn()).not.toHaveAttribute('title');
  expect(screen.queryByText(/bounty paid|pay run processing/i)).not.toBeInTheDocument();
});

test('a PAID bounty disables Dismiss and says why, in text not just a tooltip', () => {
  paint(row({ bounty_lock: 'paid' }));
  expect(dismissBtn()).toBeDisabled();
  expect(dismissBtn()).toHaveAttribute('title', expect.stringMatching(/already paid/i));
  // Readable, not merely hoverable: a title is invisible on touch and to a
  // keyboard user, which is the whole point of disabling the button.
  expect(screen.getByText(/bounty paid/i)).toBeInTheDocument();
});

test('a PROCESSING run disables Dismiss and does NOT claim the money moved', () => {
  paint(row({ bounty_lock: 'processing' }));
  expect(dismissBtn()).toBeDisabled();
  const title = dismissBtn().getAttribute('title');
  expect(title).toMatch(/processing/i);
  expect(title).not.toMatch(/already paid/i);
  expect(screen.getByText(/pay run processing/i)).toBeInTheDocument();
});

test('a dismissed row has no Dismiss button to lock in the first place', () => {
  paint(row({ status: 'dismissed', bounty_lock: 'paid' }));
  expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
});
