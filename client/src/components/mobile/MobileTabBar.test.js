import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MobileTabBar from './MobileTabBar';

test('renders three tabs, the needs-you badge, and the neutral More aggregate', () => {
  render(
    <MemoryRouter initialEntries={['/events']}>
      <MobileTabBar badges={{
        unstaffed_events: 3, pending_proposals: 0,
        unread_sms: 2, new_applications: 1, pending_shopping_lists: 1,
      }} />
    </MemoryRouter>
  );
  expect(screen.getByText('Events')).toBeInTheDocument();
  expect(screen.getByText('Proposals')).toBeInTheDocument();
  expect(screen.getByText('More')).toBeInTheDocument();
  expect(screen.getByText('3')).toBeInTheDocument();
  // More aggregates 2+1+1 into the NEUTRAL badge variant (benchmark).
  const moreBadge = screen.getByText('4');
  expect(moreBadge).toHaveClass('m-tab-badge', 'neutral');
  // A zero count renders no badge node at all.
  expect(screen.queryByText('0')).toBe(null);
});

test('active tab carries the accent stripe', () => {
  render(
    <MemoryRouter initialEntries={['/events']}>
      <MobileTabBar badges={{}} />
    </MemoryRouter>
  );
  const active = screen.getByText('Events').closest('a');
  expect(active.querySelector('.m-tab-stripe')).not.toBe(null);
  expect(screen.getByText('More').closest('a').querySelector('.m-tab-stripe')).toBe(null);
});

test('More is active with aria-current on a More-reached surface', () => {
  render(
    <MemoryRouter initialEntries={['/clients']}>
      <MobileTabBar badges={{}} />
    </MemoryRouter>
  );
  const more = screen.getByText('More').closest('a');
  expect(more).toHaveClass('active');
  expect(more).toHaveAttribute('aria-current', 'page');
  expect(more.querySelector('.m-tab-stripe')).not.toBe(null);
  expect(screen.getByText('Events').closest('a')).not.toHaveAttribute('aria-current');
});
