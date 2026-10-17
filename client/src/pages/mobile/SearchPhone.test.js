import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import SearchPhone from './SearchPhone';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
const mockMobileView = { isPhone: true, setDesktopView: jest.fn(), setDesktopForVisit: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockMobileView }));

const client = (over = {}) => ({ type: 'client', id: 3, name: 'Marcus Keller', detail: 'mkeller@example.test', cc_id: null, ...over });
const proposal = (over = {}) => ({
  type: 'proposal', id: 40, name: 'Alexis Henderson', detail: 'Wedding Reception · Oct 24, 2026',
  status: 'sent', event_date: '2026-10-24', kind: 'Wedding Reception', ...over,
});
const event = (over = {}) => ({
  type: 'event', id: 41, name: 'Nautilus Group', detail: 'Corporate Event · Oct 3, 2026',
  status: 'confirmed', event_date: '2026-10-03', kind: 'Corporate Event', ...over,
});
const staff = (over = {}) => ({ type: 'staff', id: 12, name: 'Jordan Lee', detail: 'Active bartender', cc_id: null, ...over });
const NONE = { clients: [], proposals: [], events: [], staff: [] };
const RESULTS = { clients: [client(), client({ id: 4, name: 'Marrow Gallery', detail: '' })], proposals: [proposal()], events: [event()], staff: [staff()] };
const answer = (results) => ({ data: { results } });
const many = (make, n) => Array.from({ length: n }, (_, i) => make({ id: 100 + i, name: `Name ${i}` }));

function LocationProbe() {
  const l = useLocation();
  return <div data-testid="loc" data-state={JSON.stringify(l.state)}>{l.pathname + l.search}</div>;
}
function mount(entry = '/search') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/search" element={<><SearchPhone /><LocationProbe /></>} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}
const field = () => screen.getByRole('searchbox', { name: 'Global search' });
const type = (v) => fireEvent.change(field(), { target: { value: v } });
// The polite status line repeats the note's title (plan decision 12), so a
// note is found by its visible title element.
const NOTE = { selector: '.m-empty-title' };
const wait = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));
const loc = () => screen.getByTestId('loc');
function setOnline(v) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => v });
}
function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mockMobileView.isPhone = true;
  setOnline(true);
  // CRA's jest runs resetMocks, which wipes every mock's implementation
  // before each test: an unscripted search answers nothing, never undefined.
  api.get.mockResolvedValue(answer(NONE));
});
// The BrowserRouter tests write jsdom's real history; the MemoryRouter tests
// expect window.history.state to be null, as it is in a fresh jsdom.
afterEach(() => { window.history.replaceState(null, '', '/'); });

test('opens on the empty field: focused, the note, no request, no Clear', async () => {
  mount();
  expect(field()).toHaveFocus();
  expect(field()).toHaveAttribute('placeholder', 'Search clients, proposals, events, staff…');
  expect(screen.getByRole('heading', { level: 1, name: 'Search' })).toBeInTheDocument();
  expect(screen.getByText('Search every record', NOTE)).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Search every record');
  expect(screen.getByText('Clients, proposals, events and staff, by name, email, or phone number.')).toBeInTheDocument();
  expect(screen.getByText('phone match needs 3+ digits')).toHaveClass('m-snote-micro');
  expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  await wait(300);
  expect(api.get).not.toHaveBeenCalled();
});

test('one character keeps typing and searches nothing', async () => {
  mount();
  type('k');
  expect(screen.getByText('Keep typing', NOTE)).toBeInTheDocument();
  expect(screen.getByText('Nothing is searched until two characters.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
  await wait(300);
  expect(api.get).not.toHaveBeenCalled();
});

test('two characters search the live endpoint, never the offline store, and group in the palette order', async () => {
  api.get.mockResolvedValue(answer(RESULTS));
  mount();
  type('ma');
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/search', { params: { q: 'ma' }, timeout: 10000 }));
  expect(api.get.mock.calls[0][1].headers).toBeUndefined();
  await screen.findByText('Marcus Keller');
  expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Clients 2', 'Proposals 1', 'Events 1', 'Staff 1']);
  expect(screen.getByRole('status')).toHaveTextContent('5 results');
  expect(JSON.parse(loc().dataset.state)).toEqual({ q: 'ma' });
});

test('each group draws its row anatomy', async () => {
  api.get.mockResolvedValue(answer(RESULTS));
  mount();
  type('ma');
  const c = (await screen.findByText('Marcus Keller')).closest('button');
  expect(c).toHaveClass('m-card', 'm-srow');
  expect(within(c).getByText('mkeller@example.test')).toHaveClass('m-card-meta');
  expect(within(c).getByText('Desktop')).toHaveClass('tag');
  expect(c.querySelector('.m-srow-tile svg')).not.toBeNull();
  // No email or phone: no blank second line.
  expect(screen.getByText('Marrow Gallery').closest('button').querySelector('.m-card-meta')).toBeNull();
  const p = screen.getByText('Alexis Henderson').closest('button');
  expect(within(p).getByText('Wedding Reception')).toHaveClass('m-card-kind');
  expect(within(p).getByText('Oct 24, 2026')).toHaveClass('m-card-meta');
  expect(within(p).getByText('Sent').closest('.chip')).toHaveClass('info');
  expect(within(p).queryByText('Desktop')).toBeNull();
  const e = screen.getByText('Nautilus Group').closest('button');
  expect(within(e).getByText('SAT')).toHaveClass('m-rail-dow');
  expect(within(e).getByText('03')).toHaveClass('m-rail-day');
  expect(within(e).getByText('OCT')).toHaveClass('m-rail-mon');
  expect(within(e).getByText('Corporate Event')).toHaveClass('m-card-kind');
  const s = screen.getByText('Jordan Lee').closest('button');
  expect(within(s).getByText('JL')).toHaveClass('m-srow-tile', 'm-srow-initials');
  expect(within(s).getByText('Active bartender')).toHaveClass('m-card-meta');
  expect(within(s).getByText('Desktop')).toBeInTheDocument();
  expect(c).toHaveAccessibleName('Marcus Keller mkeller@example.test Desktop');
});

test('typing fast sends one request, for the settled term', async () => {
  api.get.mockResolvedValue(answer(NONE));
  mount();
  type('m'); type('ma'); type('mar'); type('mars');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
  await wait(300);
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(api.get).toHaveBeenCalledWith('/admin/search', { params: { q: 'mars' }, timeout: 10000 });
});

test.each([
  ['Marcus Keller', '/clients/3', 'clients'],
  ['Jordan Lee', '/staffing/users/12', 'staffing'],
  ['Alexis Henderson', '/proposals/40', null],
  ['Nautilus Group', '/events/41', null],
])('tapping %s opens %s', async (name, path, screenKey) => {
  api.get.mockResolvedValue(answer(RESULTS));
  mount();
  type('ma');
  fireEvent.click((await screen.findByText(name)).closest('button'));
  expect(loc()).toHaveTextContent(path);
  // Desktop for this visit only; search never arms the sticky override.
  if (screenKey) expect(mockMobileView.setDesktopForVisit).toHaveBeenCalledWith(screenKey);
  else expect(mockMobileView.setDesktopForVisit).not.toHaveBeenCalled();
  expect(mockMobileView.setDesktopView).not.toHaveBeenCalled();
});

test('a full group says 6+ and ends in its More row, which opens the desktop list', async () => {
  api.get.mockResolvedValue(answer({ ...NONE, clients: many(client, 6), proposals: many(proposal, 6) }));
  mount();
  type('ma');
  await screen.findByText('More clients on desktop');
  expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Clients 6+', 'Proposals 6+']);
  expect(screen.getAllByText('6 shown')).toHaveLength(2);
  fireEvent.click(screen.getByText('More proposals on desktop').closest('button'));
  expect(mockMobileView.setDesktopForVisit).toHaveBeenCalledWith('proposals-list');
  expect(mockMobileView.setDesktopView).not.toHaveBeenCalled();
  expect(loc()).toHaveTextContent('/proposals?q=ma');
});

test('nothing matched quotes the term', async () => {
  api.get.mockResolvedValue(answer(NONE));
  mount();
  type('zephyr');
  expect(await screen.findByText('No matches for “zephyr”', NOTE)).toBeInTheDocument();
  expect(screen.getByText('Try a last name, an email address, or the last four digits of a phone.')).toBeInTheDocument();
});

test('past a hundred characters: no request, the note counts them', async () => {
  mount();
  type('x'.repeat(101));
  expect(screen.getByText('Too long to search', NOTE)).toBeInTheDocument();
  expect(screen.getByText('101 characters')).toBeInTheDocument();
  await wait(300);
  expect(api.get).not.toHaveBeenCalled();
});

test('an older answer that lands last never paints', async () => {
  const first = deferred(); const second = deferred();
  api.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  mount();
  type('ma');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
  type('mar');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  await act(async () => { second.resolve(answer({ ...NONE, clients: [client({ name: 'Second Answer' })] })); });
  expect(await screen.findByText('Second Answer')).toBeInTheDocument();
  await act(async () => { first.resolve(answer({ ...NONE, clients: [client({ name: 'First Answer' })] })); });
  await wait(50);
  expect(screen.queryByText('First Answer')).toBeNull();
  expect(screen.getByText('Second Answer')).toBeInTheDocument();
});

test('the in-flight line: searching… first, then the old term while the new one runs', async () => {
  const next = deferred();
  api.get.mockResolvedValueOnce(answer(RESULTS)).mockReturnValueOnce(next.promise);
  mount();
  type('ma');
  expect(screen.getByText('searching…')).toHaveClass('m-sflight');
  expect(screen.getByRole('status')).toHaveTextContent('Searching');
  await screen.findByText('Marcus Keller');
  expect(screen.queryByText('searching…')).toBeNull();
  type('mar');
  expect(screen.getByText('searching · showing “ma”')).toBeInTheDocument();
  expect(screen.getByText('Marcus Keller')).toBeInTheDocument();
  expect(screen.queryByText(/No matches/)).toBeNull();
});

test('a search that answers after the user left never pulls them back', async () => {
  const late = deferred();
  api.get.mockResolvedValueOnce(answer(RESULTS)).mockReturnValueOnce(late.promise);
  mount();
  type('ma');
  await screen.findByText('Nautilus Group');
  type('mar');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByText('Nautilus Group').closest('button'));
  expect(loc()).toHaveTextContent('/events/41');
  await act(async () => { late.resolve(answer(RESULTS)); });
  await wait(50);
  expect(loc()).toHaveTextContent('/events/41');
});

test('offline: the field keeps its text, disabled, the rows go, the note; back online searches again', async () => {
  api.get.mockResolvedValue(answer(RESULTS));
  mount();
  type('ma');
  await screen.findByText('Marcus Keller');
  setOnline(false);
  act(() => { window.dispatchEvent(new Event('offline')); });
  expect(field()).toBeDisabled();
  expect(field()).toHaveValue('ma');
  expect(screen.getByText('Search needs the server', NOTE)).toBeInTheDocument();
  expect(screen.getByText('offline · field kept, results off')).toBeInTheDocument();
  expect(screen.queryByText('Marcus Keller')).toBeNull();
  setOnline(true);
  act(() => { window.dispatchEvent(new Event('online')); });
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('Marcus Keller')).toBeInTheDocument();
  expect(field()).not.toBeDisabled();
});

test('offline at open sends nothing', async () => {
  setOnline(false);
  mount({ pathname: '/search', state: { q: 'ma' } });
  expect(field()).toBeDisabled();
  expect(screen.getByText('Search needs the server', NOTE)).toBeInTheDocument();
  await wait(300);
  expect(api.get).not.toHaveBeenCalled();
});

test('going offline mid-search drops the answer', async () => {
  const late = deferred();
  api.get.mockReturnValueOnce(late.promise);
  mount();
  type('ma');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
  setOnline(false);
  act(() => { window.dispatchEvent(new Event('offline')); });
  await act(async () => { late.resolve(answer(RESULTS)); });
  await wait(50);
  expect(screen.queryByText('Marcus Keller')).toBeNull();
  expect(screen.getByText('Search needs the server', NOTE)).toBeInTheDocument();
  // Dropped, not merely hidden: a kept answer writes its term into this
  // history entry's state.
  expect(loc().dataset.state).toBe('null');
});

test('a failed search offers Retry; a 429 says too many; any other server answer says it failed', async () => {
  api.get.mockRejectedValueOnce({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' });
  mount();
  type('ma');
  expect(await screen.findByText('Search didn’t answer', NOTE)).toBeInTheDocument();
  expect(screen.getByText('Check the signal, then try again.')).toBeInTheDocument();
  api.get.mockResolvedValueOnce(answer(RESULTS));
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Marcus Keller')).toBeInTheDocument();
  api.get.mockRejectedValueOnce({ status: 429, message: 'Too many searches. Please slow down.' });
  type('mar');
  expect(await screen.findByText('Too many searches', NOTE)).toBeInTheDocument();
  expect(screen.getByText('Wait a minute, then try again.')).toBeInTheDocument();
  expect(screen.queryByText('Marcus Keller')).toBeNull();
  api.get.mockRejectedValueOnce({ status: 500, message: 'Something went wrong.' });
  type('mars');
  expect(await screen.findByText('Search failed', NOTE)).toBeInTheDocument();
  expect(screen.getByText('The server couldn’t run this search. Try again in a moment.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
});

test('Back from a result: the term returns with the keyboard down and runs again', async () => {
  api.get.mockResolvedValue(answer(RESULTS));
  mount({ pathname: '/search', state: { q: 'ma' } });
  expect(field()).toHaveValue('ma');
  expect(field()).not.toHaveFocus();
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/search', { params: { q: 'ma' }, timeout: 10000 }));
  expect(await screen.findByText('Marcus Keller')).toBeInTheDocument();
});

test('Clear empties the field, drops the rows and puts focus back', async () => {
  api.get.mockResolvedValue(answer(RESULTS));
  mount();
  type('ma');
  await screen.findByText('Marcus Keller');
  field().blur();
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(field()).toHaveValue('');
  expect(field()).toHaveFocus();
  expect(screen.queryByText('Marcus Keller')).toBeNull();
  expect(screen.getByText('Search every record', NOTE)).toBeInTheDocument();
});

// Under MemoryRouter window.history.state is null, so these exercise the
// fallback to /events; the navigate(-1) branch is browser check S2.
test('the back arrow and Escape leave the screen; Escape works offline too', () => {
  const { unmount } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
  expect(loc()).toHaveTextContent('/events');
  unmount();
  const second = mount();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(loc()).toHaveTextContent('/events');
  second.unmount();
  setOnline(false);
  mount({ pathname: '/search', state: { q: 'ma' } });
  expect(field()).toBeDisabled();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(loc()).toHaveTextContent('/events');
});

test('the keyboard Search key puts the keyboard away', () => {
  mount();
  expect(field()).toHaveFocus();
  fireEvent.submit(field().closest('form'));
  expect(field()).not.toHaveFocus();
  expect(screen.getByRole('search')).toContainElement(field());
});

test('at desktop width the route goes to the dashboard', async () => {
  mockMobileView.isPhone = false;
  mount();
  expect(loc()).toHaveTextContent('/dashboard');
  await wait(300);
  expect(api.get).not.toHaveBeenCalled();
});

test('an event with no date keeps its rail with a dash and a spoken "no date"', async () => {
  api.get.mockResolvedValue(answer({ ...NONE, events: [event({ event_date: null })] }));
  mount();
  type('na');
  const e = (await screen.findByText('Nautilus Group')).closest('button');
  expect(within(e).getByText('–')).toHaveAttribute('aria-hidden', 'true');
  expect(within(e).getByText('no date')).toHaveClass('sr-only');
});

// The app as it runs: BrowserRouter over the window's history, one Suspense
// boundary, and pages that are lazy chunks. Until a page's chunk lands,
// React keeps the search mounted but hidden, its effect cleanups waiting,
// and its navigate still works. The location readout sits outside the
// boundary, so it shows where the user is while the page loads.
function lazyPage(text) {
  let land;
  const chunk = new Promise((r) => { land = () => r({ default: () => <div>{text}</div> }); });
  return { Page: React.lazy(() => chunk), land: () => act(async () => { land(); }) };
}
function mountApp(pages) {
  return render(
    <BrowserRouter>
      <LocationProbe />
      <React.Suspense fallback={<div>Loading the page</div>}>
        <Routes>
          <Route path="/search" element={<SearchPhone />} />
          <Route path="/events" element={<pages.tab.Page />} />
          <Route path="/events/:id" element={<pages.event.Page />} />
        </Routes>
      </React.Suspense>
    </BrowserRouter>
  );
}
// The magnifier's push: the tab at idx 0, the search at idx 1.
function startOnSearch() {
  window.history.replaceState({ usr: null, key: 'tab', idx: 0 }, '', '/events');
  window.history.pushState({ usr: null, key: 'search', idx: 1 }, '', '/search');
}
// jsdom runs history.back() as a task and fires popstate from it.
const historyBack = () => act(async () => {
  window.history.back();
  await new Promise((r) => setTimeout(r, 20));
});
// Every read after the first parks until the test answers it.
function parkReads() {
  const parked = [];
  api.get.mockResolvedValueOnce(answer(RESULTS));
  api.get.mockImplementation(() => { const d = deferred(); parked.push(d); return d.promise; });
  return parked;
}
const answerAll = (parked, results) => act(async () => { parked.forEach((d) => d.resolve(answer(results))); });

test('a row tapped while the next search is on its way: the page loads and the search never pulls the user back', async () => {
  const pages = { tab: lazyPage('Events tab'), event: lazyPage('Event page') };
  const parked = parkReads();
  startOnSearch();
  mountApp(pages);
  type('ma');
  await screen.findByText('Nautilus Group');
  // "mar" waits on the debounce; the row opens a page whose chunk is not loaded.
  type('mar');
  fireEvent.click(screen.getByText('Nautilus Group').closest('button'));
  expect(loc()).toHaveTextContent('/events/41');
  await wait(300);
  await answerAll(parked, RESULTS);
  expect(loc()).toHaveTextContent('/events/41');
  expect(window.location.pathname).toBe('/events/41');
  expect(loc().dataset.state).toBe('null');
  // The hidden screen asked nothing once the user had left.
  expect(api.get).toHaveBeenCalledTimes(1);
  await pages.event.land();
  expect(screen.getByText('Event page')).toBeInTheDocument();
  expect(screen.queryByRole('searchbox', { name: 'Global search' })).toBeNull();
});

test('history Back while a search is in flight: the late answer leaves the user on the tab', async () => {
  const pages = { tab: lazyPage('Events tab'), event: lazyPage('Event page') };
  const late = deferred();
  api.get.mockReturnValueOnce(late.promise);
  startOnSearch();
  mountApp(pages);
  type('ma');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
  // A cold launch or a reload on /search: the tab's chunk is not loaded.
  await historyBack();
  expect(loc()).toHaveTextContent('/events');
  await act(async () => { late.resolve(answer(RESULTS)); });
  await wait(50);
  expect(loc()).toHaveTextContent('/events');
  expect(window.location.pathname).toBe('/events');
  expect(window.history.state).toEqual({ usr: null, key: 'tab', idx: 0 });
  await pages.tab.land();
  expect(screen.getByText('Events tab')).toBeInTheDocument();
});

test('history Back inside the debounce: the hidden screen sends nothing and the user stays on the tab', async () => {
  const pages = { tab: lazyPage('Events tab'), event: lazyPage('Event page') };
  const parked = parkReads();
  startOnSearch();
  mountApp(pages);
  type('ma');
  await historyBack();
  await wait(300);
  await answerAll(parked, RESULTS);
  expect(loc()).toHaveTextContent('/events');
  expect(window.history.state).toEqual({ usr: null, key: 'tab', idx: 0 });
  expect(api.get).not.toHaveBeenCalled();
});

test('Escape on the hidden screen does nothing: the user stays on the page they opened', async () => {
  const pages = { tab: lazyPage('Events tab'), event: lazyPage('Event page') };
  api.get.mockResolvedValue(answer(RESULTS));
  startOnSearch();
  mountApp(pages);
  type('ma');
  await screen.findByText('Nautilus Group');
  fireEvent.click(screen.getByText('Nautilus Group').closest('button'));
  fireEvent.keyDown(window, { key: 'Escape' });
  await wait(50);
  expect(loc()).toHaveTextContent('/events/41');
  expect(window.location.pathname).toBe('/events/41');
});

test('Back to the search before the page loads: the screen searches its term again', async () => {
  const pages = { tab: lazyPage('Events tab'), event: lazyPage('Event page') };
  const parked = parkReads();
  startOnSearch();
  mountApp(pages);
  type('ma');
  await screen.findByText('Nautilus Group');
  // A read for "mar" is in flight at the tap; open() drops it.
  type('mar');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByText('Nautilus Group').closest('button'));
  await wait(300);
  await historyBack();
  // The same screen, still mounted, with the field as the user left it.
  expect(loc()).toHaveTextContent('/search');
  expect(field()).toHaveValue('mar');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
  expect(api.get).toHaveBeenLastCalledWith('/admin/search', { params: { q: 'mar' }, timeout: 10000 });
  await answerAll(parked, { ...NONE, clients: [client({ name: 'Mar Answer' })] });
  expect(await screen.findByText('Mar Answer')).toBeInTheDocument();
  expect(screen.queryByText(/searching/)).toBeNull();
  expect(JSON.parse(loc().dataset.state)).toEqual({ q: 'mar' });
});

test('on the real history every answer still writes its term, a first entry with no key included', async () => {
  const pages = { tab: lazyPage('Events tab'), event: lazyPage('Event page') };
  api.get.mockResolvedValueOnce(answer(RESULTS)).mockResolvedValueOnce(answer({ ...NONE, staff: [staff()] }));
  window.history.replaceState(null, '', '/search');
  mountApp(pages);
  type('ma');
  await screen.findByText('Marcus Keller');
  expect(JSON.parse(loc().dataset.state)).toEqual({ q: 'ma' });
  type('mar');
  await waitFor(() => expect(screen.queryByText('Marcus Keller')).toBeNull());
  expect(screen.getByText('Jordan Lee')).toBeInTheDocument();
  expect(JSON.parse(loc().dataset.state)).toEqual({ q: 'mar' });
  expect(window.history.state.usr).toEqual({ q: 'mar' });
  expect(window.location.pathname).toBe('/search');
});

test('an answer landing just before the next search fires: that search still goes out', async () => {
  const pages = { tab: lazyPage('Events tab'), event: lazyPage('Event page') };
  const first = deferred();
  api.get.mockReturnValueOnce(first.promise).mockResolvedValueOnce(answer({ ...NONE, staff: [staff()] }));
  startOnSearch();
  mountApp(pages);
  type('ma');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
  type('mar');
  // The answer's replace gives the entry a new key at once; React draws it
  // only after this scope. On a phone the debounce can fire in that gap.
  await act(async () => {
    first.resolve(answer(RESULTS));
    await new Promise((r) => setTimeout(r, 250));
  });
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(api.get).toHaveBeenLastCalledWith('/admin/search', { params: { q: 'mar' }, timeout: 10000 });
  await waitFor(() => expect(screen.queryByText('Marcus Keller')).toBeNull());
  expect(screen.getByText('Jordan Lee')).toBeInTheDocument();
  expect(JSON.parse(loc().dataset.state)).toEqual({ q: 'mar' });
});
