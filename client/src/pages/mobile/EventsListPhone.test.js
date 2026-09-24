import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import EventsListPhone from './EventsListPhone';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../../context/ToastContext', () => ({ useToast: () => ({ success: jest.fn(), error: jest.fn(), info: jest.fn() }) }));
// The interim drawer is the desktop one; stub it so this test stays about the list.
jest.mock('../../components/adminos/drawers/ShiftDrawer', () => ({ __esModule: true, default: ({ open, shiftId }) => (open ? <div data-testid="shift-drawer">drawer {shiftId}</div> : null) }));

const row = (over = {}) => ({
  id: 1, proposal_id: 10, event_key: 'p10', client_name: 'Henderson', event_type: 'wedding-reception',
  event_date: '2999-08-15', start_time: '18:00', end_time: '23:00', location: 'Grove on the River',
  venue_city: 'Rockford', venue_state: 'Illinois',
  proposal_guest_count: 140, positions_needed: '["Bartender","Bartender","Bartender"]',
  approved_count: 2, pending_count: 2, status: 'open', proposal_status: 'deposit_paid',
  bar_required: true, supply_run_required: true, ...over,
});
const env = (rows, over = {}) => ({
  data: { scope: 'upcoming', offset: 0, limit: 60, total_events: rows.length, scope_events: rows.length, needs_staff_events: 1, has_more: false, next_offset: 60, rows, ...over },
});

function LocationProbe() { const l = useLocation(); return <div data-testid="loc">{l.pathname + l.search}</div>; }
function mount(initial = '/events') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/events" element={<><EventsListPhone /><LocationProbe /></>} />
        <Route path="/events/:id" element={<div data-testid="detail">detail</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => { jest.clearAllMocks(); window.sessionStorage.clear(); });

test('fetches scope=upcoming by default and renders one card per event with the benchmark facts', async () => {
  api.get.mockResolvedValue(env([row(), row({ id: 2, positions_needed: '["Banquet Server"]', approved_count: 1, pending_count: 0 })]));
  mount();
  expect(await screen.findByText('Henderson')).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledWith('/shifts', { params: { scope: 'upcoming', limit: 60, offset: 0 } });
  const card = screen.getByRole('button', { name: /Henderson/ });
  expect(within(card).getByText('3/4')).toHaveClass('m-frac');
  expect(within(card).getByText('2 requests')).toBeInTheDocument();
  expect(within(card).getByText('2 shifts')).toBeInTheDocument();
  expect(within(card).getByText('Bar')).toHaveClass('m-tag', 'm-tag-bar');
  expect(within(card).getByText('Supplies')).toHaveClass('m-tag', 'm-tag-supplies');
  expect(screen.getByText(/End of upcoming/)).toBeInTheDocument();
});

test('the Needs staff chip writes ?needs=1, refetches with needs_staff=1, hides the end divider; Past hides the chip and drops needs', async () => {
  api.get.mockResolvedValue(env([row()], { needs_staff_events: 1 }));
  mount();
  await screen.findByText('Henderson');
  expect(screen.getByRole('button', { name: /Needs staff/ })).toHaveTextContent('1');
  fireEvent.click(screen.getByRole('button', { name: /Needs staff/ }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/shifts', { params: { scope: 'upcoming', limit: 60, offset: 0, needs_staff: 1 } }));
  expect(screen.getByTestId('loc')).toHaveTextContent('/events?needs=1');
  await screen.findByText('Henderson');
  expect(screen.queryByText(/End of upcoming/)).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'Past' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/shifts', { params: { scope: 'past', limit: 60, offset: 0 } }));
  expect(screen.getByTestId('loc')).toHaveTextContent('/events?scope=past');
  expect(screen.queryByRole('button', { name: /Needs staff/ })).toBeNull();
  await screen.findByText('Henderson');   // let the past page settle inside act
});

test('switching scope shows the skeleton while the new page loads', async () => {
  api.get.mockResolvedValueOnce(env([row()]));
  mount();
  await screen.findByText('Henderson');
  api.get.mockReturnValue(new Promise(() => {}));   // the next page never lands
  fireEvent.click(screen.getByRole('radio', { name: 'Past' }));
  expect(document.querySelectorAll('.m-card-skel').length).toBeGreaterThan(0);
  expect(screen.queryByText('first sync · fetching events')).toBeNull();
  expect(screen.queryByText('Henderson')).toBeNull();
});

test('Show more appends the next page and the end divider counts events', async () => {
  api.get
    .mockResolvedValueOnce({ data: { scope: 'upcoming', offset: 0, limit: 1, total_events: 2, scope_events: 2, needs_staff_events: 0, has_more: true, next_offset: 1, rows: [row()] } })
    .mockResolvedValueOnce({ data: { scope: 'upcoming', offset: 1, limit: 1, total_events: 2, scope_events: 2, needs_staff_events: 0, has_more: false, next_offset: 2, rows: [row({ id: 3, proposal_id: 11, event_key: 'p11', client_name: 'Okafor' })] } });
  mount();
  await screen.findByText('Henderson');
  const more = screen.getByRole('button', { name: /Show more/ });
  expect(more).toHaveTextContent('1 of 2');
  fireEvent.click(more);
  expect(await screen.findByText('Okafor')).toBeInTheDocument();
  expect(api.get).toHaveBeenLastCalledWith('/shifts', { params: { scope: 'upcoming', limit: 60, offset: 1 } });
  expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
  expect(screen.getByText('End of upcoming · 2 events')).toBeInTheDocument();
});

test('a live response renders "as of <fetch time>" with no dot', async () => {
  api.get.mockResolvedValue(env([row()]));
  mount();
  await screen.findByText('Henderson');
  const stale = screen.getByText(/^as of/).closest('.m-stale');
  expect(stale.querySelector('.m-stale-dot')).toBeNull();
  expect(stale.querySelector('.m-stale-time').textContent).toMatch(/\d{1,2}:\d{2} (AM|PM)$/);
  expect(screen.queryByText(/offline copy/)).toBeNull();
});

test('a cache-served response renders "offline copy · as of <cached time>" with the dot (the call site)', async () => {
  // Built from the real clock, so the same-day branch is PINNED. A hardcoded
  // past date passes under either branch, since "Aug 13, 2:14 PM" contains
  // "2:14 PM"; these assert the exact string for that reason.
  const sameDay = new Date(); sameDay.setHours(14, 14, 0, 0);
  api.get.mockResolvedValue({ ...env([row()]), staleAt: sameDay.toISOString() });
  const view = mount();
  await screen.findByText('Henderson');
  const stale = screen.getByText(/offline copy · as of/).closest('.m-stale');
  expect(stale.querySelector('.m-stale-dot')).not.toBeNull();
  expect(stale.querySelector('.m-stale-time').textContent).toBe('2:14 PM');
  view.unmount();

  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(14, 14, 0, 0);
  const day = yesterday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  api.get.mockResolvedValue({ ...env([row()]), staleAt: yesterday.toISOString() });
  mount();
  await screen.findByText('Henderson');
  expect(screen.getByText(/offline copy · as of/).closest('.m-stale')
    .querySelector('.m-stale-time').textContent).toBe(`${day}, 2:14 PM`);
});

test('empty states: Upcoming, Past, Needs staff with nothing open, Needs staff on an empty calendar', async () => {
  api.get.mockResolvedValue(env([]));
  mount();
  expect(await screen.findByText('Nothing on the calendar')).toBeInTheDocument();
  api.get.mockResolvedValue({ data: { scope: 'past', offset: 0, limit: 60, total_events: 0, scope_events: 0, needs_staff_events: 0, has_more: false, next_offset: 60, rows: [] } });
  fireEvent.click(screen.getByRole('radio', { name: 'Past' }));
  expect(await screen.findByText('No past events')).toBeInTheDocument();
  api.get.mockResolvedValue({ data: { scope: 'upcoming', offset: 0, limit: 60, total_events: 0, scope_events: 3, needs_staff_events: 0, has_more: false, next_offset: 60, rows: [] } });
  fireEvent.click(screen.getByRole('radio', { name: 'Upcoming' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/shifts', { params: { scope: 'upcoming', limit: 60, offset: 0 } }));
  fireEvent.click(await screen.findByRole('button', { name: /Needs staff/ }));
  expect(await screen.findByText('Fully staffed')).toBeInTheDocument();
  api.get.mockResolvedValue({ data: { scope: 'upcoming', offset: 0, limit: 60, total_events: 0, scope_events: 0, needs_staff_events: 0, has_more: false, next_offset: 60, rows: [] } });
  fireEvent.click(screen.getByRole('button', { name: /Needs staff/ }));   // off
  fireEvent.click(screen.getByRole('button', { name: /Needs staff/ }));   // on again, empty calendar
  expect(await screen.findByText('Nothing on the calendar')).toBeInTheDocument();
});

test('a booked card navigates to the event detail; a manual card opens the shift drawer', async () => {
  api.get.mockResolvedValue(env([row(), row({ id: 7, proposal_id: null, event_key: 's7', client_name: 'Night Market pop-up', event_type: null, proposal_guest_count: null })]));
  mount();
  await screen.findByText('Henderson');
  fireEvent.click(screen.getByRole('button', { name: /Night Market/ }));
  expect(await screen.findByTestId('shift-drawer')).toHaveTextContent('drawer 7');
  fireEvent.click(screen.getByRole('button', { name: /Henderson/ }));
  expect(await screen.findByTestId('detail')).toBeInTheDocument();
});

test('a nameless manual card is titled by its venue, and by nothing else when there is none', async () => {
  const manual = (over) => env([row({ id: 7, proposal_id: null, event_key: 's7', client_name: null, event_type: null, proposal_guest_count: null, ...over })]);
  api.get.mockResolvedValue(manual({ location: 'Grant Park' }));
  const view = mount();
  expect((await screen.findByText('Grant Park')).textContent).toBe('Grant Park');
  expect(screen.getByText('Manual shift')).toHaveClass('m-card-kind');   // its own line, not part of the title
  view.unmount();

  api.get.mockResolvedValue(manual({ location: null }));
  mount();
  const bare = await screen.findByText('Manual shift');
  expect(bare).toHaveClass('m-card-title');
  expect(bare.textContent).toBe('Manual shift');   // no dangling separator
  expect(document.querySelector('.m-card-kind')).toBeNull();   // an empty kind renders no line at all
});

test('the kind sits on its own line and the meta line names the town, never the street address', async () => {
  api.get.mockResolvedValue(env([row()]));
  mount();
  await screen.findByText('Henderson');
  expect(screen.getByText('Henderson')).toHaveClass('m-card-title');
  expect(screen.getByText('Wedding Reception')).toHaveClass('m-card-kind');
  expect(screen.getByText(/· Rockford, IL$/)).toHaveClass('m-card-meta');
  expect(screen.queryByText(/Grove on the River/)).toBeNull();
});

test('a failed load shows an inline retry, never a silent empty list', async () => {
  api.get.mockRejectedValueOnce({ status: 0, message: 'Network error. Check your connection.' }).mockResolvedValueOnce(env([row()]));
  mount();
  expect(await screen.findByText(/Couldn't load events/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Henderson')).toBeInTheDocument();
});

test('a live append keeps the cache-served staleness line: page 2 never rewrites it', async () => {
  const sameDay = new Date(); sameDay.setHours(14, 14, 0, 0);
  api.get
    .mockResolvedValueOnce({ data: { scope: 'upcoming', offset: 0, limit: 1, total_events: 2, scope_events: 2, needs_staff_events: 0, has_more: true, next_offset: 1, rows: [row()] }, staleAt: sameDay.toISOString() })
    .mockResolvedValueOnce({ data: { scope: 'upcoming', offset: 1, limit: 1, total_events: 2, scope_events: 2, needs_staff_events: 0, has_more: false, next_offset: 2, rows: [row({ id: 3, proposal_id: 11, event_key: 'p11', client_name: 'Okafor' })] } });
  mount();
  await screen.findByText('Henderson');
  expect(screen.getByText(/offline copy . as of/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
  expect(await screen.findByText('Okafor')).toBeInTheDocument();
  const stale = screen.getByText(/offline copy . as of/).closest('.m-stale');
  expect(stale.querySelector('.m-stale-dot')).not.toBeNull();
  expect(stale.querySelector('.m-stale-time').textContent).toBe('2:14 PM');
});

test('a failed Show more keeps the loaded list and offers an inline retry', async () => {
  api.get
    .mockResolvedValueOnce({ data: { scope: 'upcoming', offset: 0, limit: 1, total_events: 2, scope_events: 2, needs_staff_events: 0, has_more: true, next_offset: 1, rows: [row()] } })
    .mockRejectedValueOnce({ status: 0, message: 'Network error. Check your connection.' })
    .mockResolvedValueOnce({ data: { scope: 'upcoming', offset: 1, limit: 1, total_events: 2, scope_events: 2, needs_staff_events: 0, has_more: false, next_offset: 2, rows: [row({ id: 3, proposal_id: 11, event_key: 'p11', client_name: 'Okafor' })] } });
  mount();
  await screen.findByText('Henderson');
  fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
  expect(await screen.findByText(/Couldn't load more/)).toBeInTheDocument();
  expect(screen.getByText('Henderson')).toBeInTheDocument();        // the page the user already has
  expect(screen.queryByText(/Couldn't load events/)).toBeNull();    // never the full-screen panel
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Okafor')).toBeInTheDocument();
  expect(api.get).toHaveBeenLastCalledWith('/shifts', { params: { scope: 'upcoming', limit: 60, offset: 1 } });
  expect(screen.queryByText(/Couldn't load more/)).toBeNull();
});

test('scroll offsets are saved only after the loaded list has been restored', async () => {
  const realRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => { cb(); return 1; };   // run the throttle inline
  window.sessionStorage.setItem('m-events-scroll:upcoming:0', '120');
  let resolve;
  api.get.mockReturnValue(new Promise(r => { resolve = r; }));

  render(
    <MemoryRouter initialEntries={['/events']}>
      <main id="main-content" style={{ overflow: 'auto', height: 300 }}>
        <Routes><Route path="/events" element={<EventsListPhone />} /></Routes>
      </main>
    </MemoryRouter>
  );
  const host = document.getElementById('main-content');
  Object.defineProperty(host, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(host, 'clientHeight', { value: 300, configurable: true });

  // The list is still the skeleton. A scroll here is the browser clamping, not
  // the user, and it must not bury the offset we are about to restore.
  host.scrollTop = 0;
  fireEvent.scroll(host);
  expect(window.sessionStorage.getItem('m-events-scroll:upcoming:0')).toBe('120');

  resolve(env([row()]));
  await screen.findByText('Henderson');
  expect(host.scrollTop).toBe(120);            // the loaded list was restored

  // Restored, so the user's own scrolling is saved again.
  host.scrollTop = 40;
  fireEvent.scroll(host);
  expect(window.sessionStorage.getItem('m-events-scroll:upcoming:0')).toBe('40');
  window.requestAnimationFrame = realRaf;
});
