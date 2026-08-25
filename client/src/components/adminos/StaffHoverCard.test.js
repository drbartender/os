import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import StaffHoverCard from './StaffHoverCard';

const staff = [
  { user_id: 7, name: 'Reqi One', position: 'Bartender' },
  { user_id: 9, name: 'sam@example.com', position: 'Banquet Server' },
];

test('with nobody confirmed it renders the children bare: no anchor, no card', () => {
  const { container } = render(<StaffHoverCard staff={[]}><span>1/2</span></StaffHoverCard>);
  expect(container.textContent).toBe('1/2');
  expect(container.querySelector('.staff-hover-anchor')).toBeNull();
  expect(screen.queryByRole('tooltip')).toBeNull();
});

test('a non-array staff value is treated as nobody', () => {
  const { container } = render(<StaffHoverCard staff={null}><span>0/1</span></StaffHoverCard>);
  expect(container.querySelector('.staff-hover-anchor')).toBeNull();
});

test('hovering the anchor shows every confirmed person with their position; leaving hides it', () => {
  const { container } = render(<StaffHoverCard staff={staff}><span>2/2</span></StaffHoverCard>);
  expect(screen.queryByRole('tooltip')).toBeNull();

  fireEvent.mouseEnter(container.querySelector('.staff-hover-anchor'));
  const card = screen.getByRole('tooltip');
  expect(card.parentElement).toBe(document.body); // portaled out of the table's overflow clip
  const rows = card.querySelectorAll('.staff-hover-row');
  expect(rows).toHaveLength(2);
  expect(rows[0].querySelector('.staff-hover-name').textContent).toBe('Reqi One');
  expect(rows[0].querySelector('.staff-hover-pos').textContent).toBe('Bartender');
  expect(rows[1].querySelector('.staff-hover-name').textContent).toBe('sam@example.com');
  expect(rows[1].querySelector('.staff-hover-pos').textContent).toBe('Banquet Server');

  fireEvent.mouseLeave(container.querySelector('.staff-hover-anchor'));
  expect(screen.queryByRole('tooltip')).toBeNull();
});

test('a person without a position gets a name and no position span (live shape: 7 dev rows)', () => {
  const { container } = render(
    <StaffHoverCard staff={[{ user_id: 3, name: 'Legacy Row', position: null }]}><span>1/1</span></StaffHoverCard>
  );
  fireEvent.mouseEnter(container.querySelector('.staff-hover-anchor'));
  const row = screen.getByRole('tooltip').querySelector('.staff-hover-row');
  expect(row.querySelector('.staff-hover-name').textContent).toBe('Legacy Row');
  expect(row.querySelector('.staff-hover-pos')).toBeNull();
});

test('unmounting while hovered removes the portaled card', () => {
  const { container, unmount } = render(<StaffHoverCard staff={staff}><span>2/2</span></StaffHoverCard>);
  fireEvent.mouseEnter(container.querySelector('.staff-hover-anchor'));
  expect(screen.getByRole('tooltip')).toBeTruthy();
  unmount();
  expect(screen.queryByRole('tooltip')).toBeNull();
});

// Placement. jsdom reports an all-zero getBoundingClientRect, so the anchor's
// rect is stubbed: these assert the flip DECISION, which is the part that broke
// in a real browser (the card landed 42px below the fold on the last row of a
// long list, and reaching it meant leaving the anchor, which closes it).
const stubAnchorRect = (el, { top, bottom, left = 100 }) => {
  el.getBoundingClientRect = () => ({ top, bottom, left, right: left + 60, width: 60, height: bottom - top, x: left, y: top });
};

test('with room below, the card hangs under the cell', () => {
  const { container } = render(<StaffHoverCard staff={staff}><span>2/2</span></StaffHoverCard>);
  const anchor = container.querySelector('.staff-hover-anchor');
  stubAnchorRect(anchor, { top: 100, bottom: 120 });   // miles of room under it
  fireEvent.mouseEnter(anchor);
  const card = screen.getByRole('tooltip');
  expect(card.style.top).toBe('124px');                 // anchor bottom + 4
  expect(card.style.bottom).toBe('');
  expect(card.style.left).toBe('100px');
});

test('against the bottom of the viewport, the card flips above the cell', () => {
  const { container } = render(<StaffHoverCard staff={staff}><span>2/2</span></StaffHoverCard>);
  const anchor = container.querySelector('.staff-hover-anchor');
  // Flush with the fold: this is the case that shipped broken before the flip.
  stubAnchorRect(anchor, { top: window.innerHeight - 20, bottom: window.innerHeight });
  fireEvent.mouseEnter(anchor);
  const card = screen.getByRole('tooltip');
  expect(card.style.top).toBe('');
  expect(card.style.bottom).toBe('24px');               // innerHeight - anchor top + 4
});

test('the flip threshold scales with how many people are on the event', () => {
  // 60px of room: enough for a one-person card, not for a six-person one.
  const one = [{ user_id: 1, name: 'Solo', position: 'Bartender' }];
  const six = Array.from({ length: 6 }, (_, i) => ({ user_id: i + 1, name: `P${i}`, position: 'Bartender' }));

  const a = render(<StaffHoverCard staff={one}><span>1/1</span></StaffHoverCard>);
  const anchorA = a.container.querySelector('.staff-hover-anchor');
  stubAnchorRect(anchorA, { top: window.innerHeight - 80, bottom: window.innerHeight - 60 });
  fireEvent.mouseEnter(anchorA);
  expect(screen.getByRole('tooltip').style.top).not.toBe('');
  fireEvent.mouseLeave(anchorA);

  const b = render(<StaffHoverCard staff={six}><span>6/6</span></StaffHoverCard>);
  const anchorB = b.container.querySelector('.staff-hover-anchor');
  stubAnchorRect(anchorB, { top: window.innerHeight - 80, bottom: window.innerHeight - 60 });
  fireEvent.mouseEnter(anchorB);
  expect(screen.getByRole('tooltip').style.bottom).not.toBe('');
});

test('a non-canonically-cased position is displayed canonically, like the drawer', () => {
  // shift_requests_position_canonical is case-INSENSITIVE, so 'bartender' is a
  // legal stored value and one such row is live on dev. Rendering it raw made
  // the card say "bartender" where the drawer opened from the same row said
  // "Bartender".
  const { container } = render(
    <StaffHoverCard staff={[{ user_id: 4, name: 'Legacy Case', position: 'bartender' }]}><span>1/1</span></StaffHoverCard>
  );
  fireEvent.mouseEnter(container.querySelector('.staff-hover-anchor'));
  expect(screen.getByRole('tooltip').querySelector('.staff-hover-pos').textContent).toBe('Bartender');
});

test('an unrecognized position falls back to the raw string rather than vanishing', () => {
  const { container } = render(
    <StaffHoverCard staff={[{ user_id: 5, name: 'Odd Job', position: 'Sommelier' }]}><span>1/1</span></StaffHoverCard>
  );
  fireEvent.mouseEnter(container.querySelector('.staff-hover-anchor'));
  expect(screen.getByRole('tooltip').querySelector('.staff-hover-pos').textContent).toBe('Sommelier');
});
