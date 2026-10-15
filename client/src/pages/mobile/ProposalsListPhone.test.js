import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ProposalsListPhone from './ProposalsListPhone';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));

const H = { headers: { 'X-Offline-Ok': '1' } };
const NOW = Date.now();
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const row = (over = {}) => ({
  id: 7, status: 'sent', client_name: 'Ferreira', event_type: 'wedding-reception', event_type_custom: null,
  event_date: '2026-10-03T05:00:00.000Z', guest_count: 150, total_price: '5240.00', amount_paid: '0',
  sent_at: hoursAgo(48), last_viewed_at: null, view_count: 0, created_at: hoursAgo(50), updated_at: hoursAgo(48), ...over,
});
const env = (rows, over = {}) => ({
  data: { rows, total: rows.length, bucket_total: rows.length, unviewed_total: rows.filter((r) => r.status === 'sent' && !r.last_viewed_at).length, page: 1, limit: 50, has_more: false, ...over },
});
const base = { envelope: 1, limit: 50, page: 1, sort: 'created_at', dir: 'desc' };

function LocationProbe() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.search}</div>;
}
function mount(initial = '/proposals') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <div id="main-content">
        <Routes>
          <Route path="/proposals" element={<><ProposalsListPhone /><LocationProbe /></>} />
          <Route path="/proposals/:id" element={<><div data-testid="detail">detail</div><LocationProbe /></>} />
        </Routes>
      </div>
    </MemoryRouter>
  );
}

beforeEach(() => { jest.clearAllMocks(); window.sessionStorage.clear(); });

test('fetches the envelope newest-lead first and renders the benchmark card', async () => {
  api.get.mockResolvedValue(env([row(), row({ id: 8, status: 'viewed', client_name: 'Whitfield', event_type: 'corporate-event', last_viewed_at: hoursAgo(5), view_count: 3, guest_count: 120, total_price: '4270' })]));
  mount();
  expect(await screen.findByText('Ferreira')).toBeInTheDocument();
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();   // the load settled
  expect(api.get).toHaveBeenCalledWith('/proposals', { params: base, ...H });
  const card = screen.getByRole('button', { name: /Ferreira/ });
  expect(within(card).getByText('Wedding Reception')).toHaveClass('m-card-kind');
  expect(within(card).getByText(/150/)).toHaveClass('m-card-guests');
  expect(within(card).getByText('sent 2d ago · not opened')).toHaveClass('m-card-meta');
  expect(within(card).getByText('$5,240')).toHaveClass('m-card-total');
  expect(within(card).getByText('Sent').closest('.chip')).toHaveClass('info');
  expect(within(card).getByText('03')).toHaveClass('m-rail-day');
  const second = screen.getByRole('button', { name: /Whitfield/ });
  expect(within(second).getByText('viewed 5h ago · 3 views')).toBeInTheDocument();
  expect(within(second).getByText('Viewed').closest('.chip')).toHaveClass('accent');
  expect(screen.getByText('End of active · 2 proposals')).toBeInTheDocument();
  expect(screen.queryByText(/offline copy/)).toBeNull();
});

test('Event date writes ?order=date and refetches soonest first', async () => {
  api.get.mockResolvedValue(env([row()]));
  mount();
  await screen.findByText('Ferreira');
  fireEvent.click(screen.getByRole('radio', { name: 'Event date' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/proposals', { params: { ...base, sort: 'event_date', dir: 'asc' }, ...H }));
  expect(screen.getByTestId('loc')).toHaveTextContent('/proposals?order=date');
  await screen.findByText('Ferreira');
  expect(screen.getByRole('radio', { name: 'Event date' })).toHaveAttribute('aria-checked', 'true');
});

test('the Unviewed chip shows the bucket count only once the envelope lands, filters server-side, keeps its count, hides the end divider', async () => {
  let resolve;
  api.get.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  mount();
  expect(screen.getByRole('button', { name: /Unviewed/ })).toHaveTextContent(/^Unviewed$/);
  api.get.mockResolvedValue(env([row()], { total: 1, bucket_total: 3, unviewed_total: 1 }));
  await act(async () => { resolve(env([row(), row({ id: 9, status: 'draft', client_name: 'Tran' }), row({ id: 10, status: 'viewed', client_name: 'Whitfield', last_viewed_at: hoursAgo(1), view_count: 1 })], { unviewed_total: 1 })); });
  await screen.findByText('Ferreira');
  expect(screen.getByRole('button', { name: /Unviewed/ })).toHaveTextContent('1');
  fireEvent.click(screen.getByRole('button', { name: /Unviewed/ }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/proposals', { params: { ...base, unviewed: 1 }, ...H }));
  expect(screen.getByTestId('loc')).toHaveTextContent('/proposals?unviewed=1');
  await screen.findByText('Ferreira');
  expect(screen.getByRole('button', { name: /Unviewed/ })).toHaveTextContent('1');
  expect(screen.getByRole('button', { name: /Unviewed/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByText(/End of active/)).toBeNull();
});

test('empty states: Everything opened under the chip with a non-empty bucket; No active proposals otherwise', async () => {
  api.get.mockResolvedValue(env([], { total: 0, bucket_total: 4, unviewed_total: 0 }));
  mount('/proposals?unviewed=1');
  expect(await screen.findByText('Everything opened')).toBeInTheDocument();
  expect(screen.getByText('No sent proposal is waiting to be seen.')).toBeInTheDocument();
  expect(screen.getByText('Everything opened').closest('.m-empty')).toHaveClass('ok');
});

test('an empty bucket', async () => {
  api.get.mockResolvedValue(env([]));
  mount();
  expect(await screen.findByText('No active proposals')).toBeInTheDocument();
  expect(screen.getByText('Drafts and sent quotes land here. Booked ones move to Events.')).toBeInTheDocument();
  expect(screen.queryByText(/End of active/)).toBeNull();
});

test('a failed load shows the page error and Retry refetches', async () => {
  api.get.mockRejectedValueOnce(new Error('Network error. Check your connection.'));
  mount();
  expect(await screen.findByText("Couldn't load proposals")).toBeInTheDocument();
  api.get.mockResolvedValue(env([row()]));
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Ferreira')).toBeInTheDocument();
});

test('Show more appends page 2 and offers itself under the chip too; an append error stays inline', async () => {
  const first = Array.from({ length: 50 }, (_, i) => row({ id: 100 + i, client_name: `Client ${i}` }));
  api.get.mockResolvedValueOnce(env(first, { total: 51, bucket_total: 51, unviewed_total: 51, has_more: true }));
  mount('/proposals?unviewed=1');
  await screen.findByText('Client 0');
  // getByText, not getByRole: a role query computes every card's accessible
  // name, which is slow with 50 cards on screen.
  const more = screen.getByText('Show more').closest('button');
  expect(more).toHaveTextContent('50 of 51');
  api.get.mockRejectedValueOnce(new Error('boom'));
  fireEvent.click(more);
  expect(await screen.findByText(/Couldn't load more\. boom/)).toBeInTheDocument();
  expect(screen.getByText('Client 49')).toBeInTheDocument();
  api.get.mockResolvedValueOnce(env([row({ id: 999, client_name: 'Last one' })], { total: 51, bucket_total: 51, unviewed_total: 51, page: 2, has_more: false }));
  fireEvent.click(screen.getByText('Show more').closest('button'));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/proposals', { params: { ...base, page: 2, unviewed: 1 }, ...H }));
  expect(await screen.findByText('Last one')).toBeInTheDocument();
  expect(screen.getByText('Client 0')).toBeInTheDocument();
  expect(screen.queryByText('Show more')).toBeNull();
}, 15000);

test('Show more drops a row page 1 already shows: no repeat, no duplicate key', async () => {
  const errSpy = jest.spyOn(console, 'error');
  try {
    api.get.mockResolvedValueOnce(env([row({ id: 1, client_name: 'Alder' }), row({ id: 2, client_name: 'Birch' })], { total: 3, bucket_total: 3, has_more: true }));
    mount();
    await screen.findByText('Alder');
    // The order moved between taps, so page 2 opens with page 1's last row.
    api.get.mockResolvedValueOnce(env([row({ id: 2, client_name: 'Birch' }), row({ id: 3, client_name: 'Cedar' })], { total: 3, bucket_total: 3, page: 2, has_more: false }));
    fireEvent.click(screen.getByText('Show more').closest('button'));
    await screen.findByText('Cedar');
    expect(screen.getAllByRole('button', { name: /Alder|Birch|Cedar/ })).toHaveLength(3);
    expect(screen.getAllByText('Birch')).toHaveLength(1);
    expect(errSpy.mock.calls.filter((args) => String(args[0]).includes('same key'))).toEqual([]);
  } finally {
    errSpy.mockRestore();
  }
});

test('a cache-served list shows the offline copy line; an append never clears it', async () => {
  api.get.mockResolvedValueOnce({ ...env([row()], { total: 2, bucket_total: 2, has_more: true }), staleAt: '2026-10-14T14:14:00.000Z' });
  mount();
  await screen.findByText('Ferreira');
  expect(screen.getByText(/offline copy · as of/)).toBeInTheDocument();
  api.get.mockResolvedValueOnce(env([row({ id: 2, client_name: 'Tran' })], { total: 2, bucket_total: 2, page: 2, has_more: false }));
  fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
  await screen.findByText('Tran');
  expect(screen.getByText(/offline copy · as of/)).toBeInTheDocument();
});

test('a superseded response never paints: the first order resolves after the second', async () => {
  let resolveFirst;
  api.get.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));
  mount();
  api.get.mockResolvedValueOnce(env([row({ id: 2, client_name: 'By date' })]));
  fireEvent.click(screen.getByRole('radio', { name: 'Event date' }));
  await screen.findByText('By date');
  await act(async () => { resolveFirst(env([row({ id: 1, client_name: 'By lead' })])); });
  expect(screen.queryByText('By lead')).toBeNull();
  expect(screen.getByText('By date')).toBeInTheDocument();
});

test('a row with no event date renders a dash rail, hides the dash from a screen reader and says no date', async () => {
  api.get.mockResolvedValue(env([row({ event_date: null, status: 'draft', client_name: 'Okonkwo' })]));
  mount();
  const card = await screen.findByRole('button', { name: /Okonkwo/ });
  const day = within(card).getByText('–');
  expect(day).toHaveClass('m-rail-day');
  expect(day).toHaveAttribute('aria-hidden', 'true');
  expect(within(card).getByText('no date')).toHaveClass('sr-only');
});

test('tapping a card opens /proposals/:id', async () => {
  api.get.mockResolvedValue(env([row()]));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Ferreira/ }));
  expect(await screen.findByTestId('detail')).toBeInTheDocument();
  expect(screen.getByTestId('loc')).toHaveTextContent(/^\/proposals\/7$/);
});

test('the first load shows the skeleton with the first-sync note', async () => {
  api.get.mockReturnValueOnce(new Promise(() => {}));
  mount();
  expect(screen.getByText('first sync · fetching proposals')).toBeInTheDocument();
  expect(document.querySelectorAll('.m-card-skel').length).toBe(4);
  expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
});

test('an order switch shows the skeleton again, without the first-sync note', async () => {
  api.get.mockResolvedValueOnce(env([row()]));
  mount();
  await screen.findByText('Ferreira');
  api.get.mockReturnValue(new Promise(() => {}));   // the next page never lands
  fireEvent.click(screen.getByRole('radio', { name: 'Event date' }));
  await waitFor(() => expect(document.querySelectorAll('.m-card-skel').length).toBe(4));
  expect(screen.queryByText('Ferreira')).toBeNull();
  expect(screen.queryByText('first sync · fetching proposals')).toBeNull();
});

test('scroll offsets are saved only after the loaded list has been restored', async () => {
  const realRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => { cb(); return 1; };   // run the throttle inline
  window.sessionStorage.setItem('proposals-scroll:lead:0', '120');
  let resolve;
  api.get.mockReturnValue(new Promise(r => { resolve = r; }));
  render(
    <MemoryRouter initialEntries={['/proposals']}>
      <main id="main-content" style={{ overflow: 'auto', height: 300 }}>
        <Routes><Route path="/proposals" element={<ProposalsListPhone />} /></Routes>
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
  expect(window.sessionStorage.getItem('proposals-scroll:lead:0')).toBe('120');
  resolve(env([row()]));
  await screen.findByText('Ferreira');
  // The restore runs in an effect, which can land a tick after the card paints.
  await waitFor(() => expect(host.scrollTop).toBe(120));
  // Restored, so the user's own scrolling is saved again.
  host.scrollTop = 40;
  fireEvent.scroll(host);
  expect(window.sessionStorage.getItem('proposals-scroll:lead:0')).toBe('40');
  window.requestAnimationFrame = realRaf;
});

test('the clamp scroll on the way out never overwrites the saved offset', async () => {
  const realRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => { cb(); return 1; };   // run the throttle inline
  window.sessionStorage.setItem('proposals-scroll:lead:0', '120');
  let resolve;
  api.get.mockReturnValue(new Promise(r => { resolve = r; }));
  render(
    <MemoryRouter initialEntries={['/proposals']}>
      <main id="main-content" style={{ overflow: 'auto', height: 300 }}>
        <Routes><Route path="/proposals" element={<ProposalsListPhone />} /></Routes>
      </main>
    </MemoryRouter>
  );
  const host = document.getElementById('main-content');
  Object.defineProperty(host, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(host, 'clientHeight', { value: 300, configurable: true });
  resolve(env([row()]));
  await screen.findByText('Ferreira');
  await waitFor(() => expect(host.scrollTop).toBe(120));
  // Tapping a card swaps the Outlet: the list's root leaves the DOM at commit,
  // the shorter detail page makes the browser clamp the scroller to 0 and fire
  // a scroll, and React 18 runs the scroll effect's cleanup only after that.
  // Emptying the host by hand is that window: root gone, listener still on.
  document.getElementById('main-content').innerHTML = '';
  host.scrollTop = 0;
  fireEvent.scroll(host);
  expect(window.sessionStorage.getItem('proposals-scroll:lead:0')).toBe('120');
  window.requestAnimationFrame = realRaf;
});
