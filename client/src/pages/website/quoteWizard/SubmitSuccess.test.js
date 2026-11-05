import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import SubmitSuccess from './SubmitSuccess';

// The 201 from POST /api/proposals/public/submit comes in two shapes (audit
// 2026-11-05 AUTH-12): with the proposal token when the submit created the
// client row, and with token: null plus a masked delivered_to when it matched
// an existing client, whose link was mailed to the address on file instead.

test('with a token: the ready heading, the total and the View button, which calls onView', () => {
  const onView = jest.fn();
  render(<SubmitSuccess success={{ token: 'abc', total: 400 }} onView={onView} />);
  expect(screen.getByRole('heading', { name: 'Your proposal is ready!' })).toBeInTheDocument();
  expect(screen.getByText('$400.00')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'View Your Proposal' }));
  expect(onView).toHaveBeenCalledTimes(1);
});

test('without a token: the check-your-email state names the masked address and offers no link', () => {
  render(<SubmitSuccess success={{ token: null, delivered_to: 'v***@example.com', total: 400 }} onView={() => {}} />);
  expect(screen.getByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
  expect(screen.getByText(/v\*\*\*@example\.com/)).toBeInTheDocument();
  expect(screen.getByText('$400.00')).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
});

test('without a token and without delivered_to: falls back to "the email address on file"', () => {
  render(<SubmitSuccess success={{ token: null, total: 0 }} onView={() => {}} />);
  expect(screen.getByText(/the email address on file/)).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
});

test('top shelf without a token: the follow-up goes to the masked address, no link', () => {
  render(<SubmitSuccess success={{ token: null, delivered_to: 'v***@example.com', total: 0, top_shelf: true }} topShelf onView={() => {}} />);
  expect(screen.getByRole('heading', { name: 'Request submitted!' })).toBeInTheDocument();
  expect(screen.getByText(/custom Top Shelf pricing at v\*\*\*@example\.com/)).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
});

test('top shelf with a token keeps the existing copy and the link', () => {
  render(<SubmitSuccess success={{ token: 'abc', total: 0, top_shelf: true }} topShelf onView={() => {}} />);
  expect(screen.getByText(/Check your email for details/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'View Your Proposal' })).toBeInTheDocument();
});

test('the class wizard\'s ready heading is honoured', () => {
  render(<SubmitSuccess success={{ token: 'abc', total: 150 }} readyHeading="Your quote is ready!" onView={() => {}} />);
  expect(screen.getByRole('heading', { name: 'Your quote is ready!' })).toBeInTheDocument();
});
