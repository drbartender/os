import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn() },
}));
jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
  useOutletContext: () => ({}),
}));
jest.mock('../context/ToastContext', () => ({
  useToast: () => ({ success: jest.fn(), error: jest.fn() }),
}));

import FieldGuide from './FieldGuide';

// A collapsed section's text is not in the DOM at all ({open[i] ? content :
// null}), so before 2026-08-20 a keyboard user could not reach ANY of the guide
// -- while the acknowledgment checkbox below it was a real <input> they could
// check, and Continue was a real <button> they could press. Sign what you cannot
// read. index.css gives the header full button chrome, and `aria-expanded` on an
// implicit generic role is dropped, so the author's intent was silently failing.

test('every section header is a keyboard stop that reports its state', () => {
  render(<FieldGuide />);
  const headers = screen.getAllByRole('button', { expanded: false });
  expect(headers.length).toBeGreaterThan(1);
  for (const h of headers) {
    expect(h).toHaveAttribute('tabindex', '0');
  }
});

test('Enter and Space open a section, so its text reaches the DOM', () => {
  render(<FieldGuide />);
  const [first, second] = screen.getAllByRole('button', { expanded: false });

  fireEvent.keyDown(first, { key: 'Enter' });
  expect(first).toHaveAttribute('aria-expanded', 'true');

  fireEvent.keyDown(second, { key: ' ' });
  expect(second).toHaveAttribute('aria-expanded', 'true');
});

test('an unrelated key does nothing, so typing cannot toggle the guide', () => {
  render(<FieldGuide />);
  const [first] = screen.getAllByRole('button', { expanded: false });
  fireEvent.keyDown(first, { key: 'a' });
  expect(first).toHaveAttribute('aria-expanded', 'false');
});

test('the attestation is reachable, which is why the sections had to be', () => {
  // Pins the asymmetry that made this worth fixing rather than logging: the
  // thing you SIGN was always keyboard-reachable, the thing you are attesting to
  // was not.
  render(<FieldGuide />);
  expect(screen.getByRole('checkbox')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Continue to Contractor Agreement/i })).toBeInTheDocument();
});
