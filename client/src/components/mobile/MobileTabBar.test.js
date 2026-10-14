import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MobileTabBar from './MobileTabBar';

test('renders four tabs with Inbox first, the needs-you badges, and the neutral More aggregate', () => {
  render(
    <MemoryRouter initialEntries={['/events']}>
      <MobileTabBar badges={{
        inbox_waiting: 4,
        unstaffed_events: 3, pending_proposals: 0,
        unread_sms: 2, new_applications: 1, pending_shopping_lists: 1,
        pending_reviews: 1,
      }} />
    </MemoryRouter>
  );
  const labels = screen.getAllByRole('link').map((a) => a.querySelector('.m-tab-label').textContent);
  expect(labels).toEqual(['Inbox', 'Events', 'Proposals', 'More']);
  expect(screen.getByText('4')).toHaveClass('m-tab-badge');
  expect(screen.getByText('4')).not.toHaveClass('neutral');
  expect(screen.getByText('3')).toBeInTheDocument();
  // More aggregates 2+1+1+1 into the NEUTRAL badge variant (benchmark). The
  // Staff nav item sums new_applications and pending_reviews, so the hub's
  // pending review counts here too. The Inbox count (4) is a tab of its own
  // and never joins the More total.
  const moreBadge = screen.getByText('5');
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

test('a null Inbox count draws "!" and says so, and More is unaffected', () => {
  render(
    <MemoryRouter initialEntries={['/inbox']}>
      <MobileTabBar badges={{ inbox_waiting: null, unread_sms: 2 }} />
    </MemoryRouter>
  );
  const inbox = screen.getByText('Inbox').closest('a');
  expect(inbox.querySelector('.m-tab-badge')).toHaveTextContent('!');
  expect(inbox).toHaveAttribute('aria-label', 'Inbox, count unavailable');
  expect(screen.getByText('More').closest('a').querySelector('.m-tab-badge')).toHaveTextContent('2');
});

test('the Inbox tab is active on the list and on an opened item', () => {
  for (const path of ['/inbox', '/inbox/c-12']) {
    const { unmount } = render(
      <MemoryRouter initialEntries={[path]}>
        <MobileTabBar badges={{}} />
      </MemoryRouter>
    );
    const inbox = screen.getByText('Inbox').closest('a');
    expect(inbox).toHaveAttribute('aria-current', 'page');
    expect(inbox.querySelector('.m-tab-stripe')).not.toBe(null);
    expect(screen.getByText('More').closest('a')).not.toHaveAttribute('aria-current');
    unmount();
  }
});
