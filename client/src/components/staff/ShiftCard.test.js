import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import ShiftCard from './ShiftCard';

// `.sp-shift` carries `cursor: pointer` and a hover border UNCONDITIONALLY, and
// the light-skin override changes padding and radius without resetting either.
// ShiftCard already withheld role and tabIndex when it has no onClick, so the
// ARIA half was right and the VISUAL half still promised a tap. `is-static` is
// what withdraws the second promise, and it has to track onClick exactly or the
// two halves drift again. (2026-08-20 dead-affordance sweep.)

const shift = {
  id: 1,
  event_date: '2026-09-12',
  client_name: 'Test Client',
  positions_needed: '["Bartender"]',
};

const classesOf = () => screen.getByText('Test Client').closest('.sp-shift').className.split(/\s+/);

test('a card with no onClick is marked static, and carries no button role', () => {
  render(<ShiftCard shift={shift} />);
  const el = screen.getByText('Test Client').closest('.sp-shift');
  expect(classesOf()).toContain('is-static');
  expect(el).not.toHaveAttribute('role');
  expect(el).not.toHaveAttribute('tabindex');
});

test('a card WITH onClick is not static, and is a real button stop', () => {
  render(<ShiftCard shift={shift} onClick={() => {}} />);
  const el = screen.getByText('Test Client').closest('.sp-shift');
  expect(classesOf()).not.toContain('is-static');
  expect(el).toHaveAttribute('role', 'button');
  expect(el).toHaveAttribute('tabindex', '0');
});

test('the visual promise and the ARIA promise are the same promise', () => {
  // The invariant, stated as one assertion so neither half can be changed
  // alone: is-static is present exactly when role is absent.
  for (const onClick of [undefined, () => {}]) {
    const { unmount } = render(<ShiftCard shift={shift} onClick={onClick} />);
    const el = screen.getByText('Test Client').closest('.sp-shift');
    const isStatic = el.className.split(/\s+/).includes('is-static');
    expect(isStatic).toBe(el.getAttribute('role') === null);
    unmount();
  }
});
