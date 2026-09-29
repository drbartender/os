import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import useDrawerParam from './useDrawerParam';

// Back is navigate(-1): the same history pop Android's hardware Back fires.
function Probe({ push }) {
  const drawer = useDrawerParam(push ? { push: true, kinds: ['shift'] } : undefined);
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <div data-testid="loc">{location.pathname + location.search}</div>
      <div data-testid="kind">{drawer.kind || 'none'}</div>
      <div data-testid="id">{drawer.id || 'none'}</div>
      <div data-testid="focus">{drawer.focus || 'none'}</div>
      <button type="button" onClick={() => drawer.open('shift', 17)}>open</button>
      <button type="button" onClick={() => drawer.open('shift', 17, { focus: 42 })}>open-focused</button>
      <button type="button" onClick={() => drawer.open('invoices', 13)}>open-invoices</button>
      <button type="button" onClick={() => drawer.close()}>close</button>
      <button type="button" onClick={() => navigate(-1)}>back</button>
      <button type="button" onClick={() => navigate(1)}>forward</button>
    </div>
  );
}
function Before() { return <div data-testid="loc">/before</div>; }

function mount({ push, entries = ['/before', '/events?scope=past'], index = entries.length - 1 }) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <Routes>
        <Route path="/before" element={<Before />} />
        <Route path="/events" element={<Probe push={push} />} />
      </Routes>
    </MemoryRouter>
  );
}
const loc = () => screen.getByTestId('loc').textContent;
const tap = (name) => fireEvent.click(screen.getByRole('button', { name }));

test('the default keeps replace semantics: Back after open leaves the page', async () => {
  mount({ push: false });
  tap('open');
  await waitFor(() => expect(loc()).toBe('/events?scope=past&drawer=shift&drawerId=17'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('push mode: Back closes the sheet and stays on the page', async () => {
  mount({ push: true });
  tap('open');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  expect(screen.getByTestId('id')).toHaveTextContent('17');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  expect(screen.getByTestId('kind')).toHaveTextContent('none');
});

test('push mode: close() pops the entry it pushed, so no entry piles up', async () => {
  mount({ push: true });
  tap('open');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('close');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('push mode: opening, closing and opening again still leaves one entry behind the sheet', async () => {
  mount({ push: true });
  tap('open');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('close');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('none'));
  tap('open');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('push mode: two close() calls before the pop lands go back ONE entry', async () => {
  mount({ push: true });
  tap('open');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  const close = screen.getByRole('button', { name: 'close' });
  // The DOM's own click, twice inside one act: no render happens between the
  // two, which is what a second tap on the scrim looks like to the hook.
  act(() => { close.click(); close.click(); });
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('none'));
  expect(loc()).toBe('/events?scope=past');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('push mode: a sheet that Forward brought back closes again', async () => {
  mount({ push: true });
  tap('open');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('close');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('none'));
  tap('forward');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('close');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('none'));
  expect(loc()).toBe('/events?scope=past');
});

test('push mode: a sheet entry this hook did not push is closed in place, never popped', async () => {
  // A malformed id is never seeded, so the entry carries no flag.
  mount({ push: true, entries: ['/before', '/events?scope=past&drawer=shift&drawerId=abc'] });
  tap('close');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('none'));
  expect(loc()).toBe('/events?scope=past');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('push mode: a flagged entry whose drawer is not a sheet is closed in place, never popped', async () => {
  const flagged = { pathname: '/events', search: '?scope=past&drawer=invoices&drawerId=13', state: { mSheet: true } };
  mount({ push: true, entries: ['/before', flagged] });
  expect(screen.getByTestId('kind')).toHaveTextContent('invoices');
  tap('close');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('none'));
  expect(loc()).toBe('/events?scope=past');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('the default close drops the focus with the drawer', async () => {
  mount({ push: false, entries: ['/before', '/events?scope=past&drawer=shift&drawerId=17&drawerFocus=42'] });
  expect(screen.getByTestId('focus')).toHaveTextContent('42');
  tap('close');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
});

test('a deep-linked sheet gets an entry seeded behind it', async () => {
  mount({ push: true, entries: ['/before', '/events?scope=past&drawer=shift&drawerId=17'] });
  expect(screen.getByTestId('kind')).toHaveTextContent('shift');
  await waitFor(() => expect(loc()).toBe('/events?scope=past&drawer=shift&drawerId=17'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  expect(screen.getByTestId('kind')).toHaveTextContent('none');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('a deep-linked sheet closed with close() lands on the bare page, one Back from where it came', async () => {
  mount({ push: true, entries: ['/before', '/events?drawer=shift&drawerId=17'] });
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('close');
  await waitFor(() => expect(loc()).toBe('/events'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('the default never seeds: a deep-linked desktop drawer keeps its single entry', async () => {
  mount({ push: false, entries: ['/before', '/events?drawer=shift&drawerId=17'] });
  expect(screen.getByTestId('kind')).toHaveTextContent('shift');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('focus rides the URL and clears with the sheet', async () => {
  mount({ push: true });
  tap('open-focused');
  await waitFor(() => expect(screen.getByTestId('focus')).toHaveTextContent('42'));
  expect(loc()).toBe('/events?scope=past&drawer=shift&drawerId=17&drawerFocus=42');
  tap('close');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  expect(screen.getByTestId('focus')).toHaveTextContent('none');
});

test('opening without a focus drops a focus left over from an earlier open', async () => {
  mount({ push: false, entries: ['/events?drawer=shift&drawerId=9&drawerFocus=42'] });
  tap('open');
  await waitFor(() => expect(loc()).toBe('/events?drawer=shift&drawerId=17'));
});

test('a kind that is not a sheet keeps replace semantics and is never seeded, even in push mode', async () => {
  mount({ push: true });
  tap('open-invoices');
  await waitFor(() => expect(loc()).toBe('/events?scope=past&drawer=invoices&drawerId=13'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('a deep link to a kind that is not a sheet gains no history entry', async () => {
  mount({ push: true, entries: ['/before', '/events?drawer=invoices&drawerId=13'] });
  expect(screen.getByTestId('kind')).toHaveTextContent('invoices');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('a malformed sheet id seeds nothing: no entry for a sheet that will never mount', async () => {
  mount({ push: true, entries: ['/before', '/events?drawer=shift&drawerId=abc'] });
  expect(screen.getByTestId('id')).toHaveTextContent('abc');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('under StrictMode the seed still runs once', async () => {
  render(
    <React.StrictMode>
      <MemoryRouter initialEntries={['/before', '/events?scope=past&drawer=shift&drawerId=17']} initialIndex={1}>
        <Routes>
          <Route path="/before" element={<Before />} />
          <Route path="/events" element={<Probe push />} />
        </Routes>
      </MemoryRouter>
    </React.StrictMode>
  );
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('the default close replaces, and keeps every other query param', async () => {
  mount({ push: false, entries: ['/before', '/events?scope=past&drawer=shift&drawerId=17'] });
  tap('close');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

describe('against the real browser history', () => {
  afterEach(() => { window.history.replaceState(null, '', '/'); });

  test('an entry that claims it was pushed but has nothing behind it still closes', async () => {
    // What a duplicated tab or a trimmed history leaves: the flag, at index 0.
    window.history.replaceState({ usr: { mSheet: true }, key: 'orphan', idx: 0 }, '', '/events?scope=past&drawer=shift&drawerId=17');
    render(
      <BrowserRouter>
        <Routes><Route path="/events" element={<Probe push />} /></Routes>
      </BrowserRouter>
    );
    expect(screen.getByTestId('kind')).toHaveTextContent('shift');
    tap('close');
    await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('none'));
    expect(window.location.pathname + window.location.search).toBe('/events?scope=past');
  });

  test('open pushes exactly one entry and close pops it', async () => {
    window.history.replaceState(null, '', '/events?scope=past');
    render(
      <BrowserRouter>
        <Routes><Route path="/events" element={<Probe push />} /></Routes>
      </BrowserRouter>
    );
    const before = window.history.length;
    const at = window.history.state.idx;
    tap('open');
    await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
    expect(window.history.length).toBe(before + 1);
    expect(window.history.state.idx).toBe(at + 1);
    tap('close');
    await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('none'));
    expect(window.location.pathname + window.location.search).toBe('/events?scope=past');
    // Popped, not replaced: a replace would leave the position where open put it.
    expect(window.history.state.idx).toBe(at);
  });
});
