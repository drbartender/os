import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CurrentWeekCard from './CurrentWeekCard';

const P = { start_date: '2026-08-18', end_date: '2026-08-24', payday: '2026-08-25', exists: false, status: null, payouts_accrued: 0 };
const r = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

test('no row yet: names the derived window, $0.00 owed, nothing accrued yet', () => {
  const { container } = r(<CurrentWeekCard openPeriod={P} pendingReviews={0} bountyCents={1000} />);
  expect(screen.getByText(/Aug 18 to 24/)).toBeInTheDocument();
  expect(screen.getByText(/payday Tue Aug 25/)).toBeInTheDocument();
  // The owed figure sits in the period-card head shape ($ in its own <strong>),
  // so assert on the rendered text, not on one text node.
  expect(container.textContent).toContain('$0.00 owed');
  expect(screen.getByText(/Nothing accrued yet/)).toBeInTheDocument();
  expect(screen.queryByText(/pending review/)).toBeNull();
});

test('a pending review adds the pointer with the bounty from the envelope', () => {
  const { container } = r(<CurrentWeekCard openPeriod={P} pendingReviews={1} bountyCents={1000} />);
  expect(container.textContent).toContain('1 pending review. A confirmed five-star review with a name adds $10.00 to the next open run.');
  expect(screen.getByRole('link', { name: /Confirm under Reviews/ })).toHaveAttribute('href', '/staffing/reviews');
});

test('two pending reviews pluralize', () => {
  const { container } = r(<CurrentWeekCard openPeriod={P} pendingReviews={2} bountyCents={1000} />);
  expect(container.textContent).toContain('2 pending reviews. A confirmed five-star review with a name adds $10.00 to the next open run.');
});

test('a bounty the envelope never delivered drops the figure instead of promising $0.00', () => {
  const { container } = r(<CurrentWeekCard openPeriod={P} pendingReviews={1} bountyCents={0} />);
  expect(container.textContent).toContain('1 pending review. A confirmed five-star review with a name adds the review bounty to the next open run.');
  expect(container.textContent).not.toContain('$0.00 to the next open run');
});

test('renders nothing when the week already has payouts, or is not open, or there is no window', () => {
  const { container: a } = r(<CurrentWeekCard openPeriod={{ ...P, exists: true, status: 'open', payouts_accrued: 3 }} pendingReviews={0} bountyCents={1000} />);
  expect(a).toBeEmptyDOMElement();
  const { container: b } = r(<CurrentWeekCard openPeriod={{ ...P, exists: true, status: 'processing', payouts_accrued: 0 }} pendingReviews={0} bountyCents={1000} />);
  expect(b).toBeEmptyDOMElement();
  const { container: c } = r(<CurrentWeekCard openPeriod={null} pendingReviews={0} bountyCents={1000} />);
  expect(c).toBeEmptyDOMElement();
});

test('an existing open row is the QUEUE\'s to draw: the card stands down', () => {
  // Corrected 2026-08-20. This test used to assert the opposite. A browser pass
  // against the live hub found that when the row exists, GET /admin/payroll/periods
  // returns it and PayRunView renders it right below this card, so the same week
  // appeared twice in two date formats, and this copy had no Process action. The
  // card is for the gap BEFORE accrual mints the row, nothing else.
  const { container } = r(<CurrentWeekCard openPeriod={{ ...P, exists: true, status: 'open', payouts_accrued: 0 }} pendingReviews={1} bountyCents={1000} />);
  expect(container).toBeEmptyDOMElement();
});
