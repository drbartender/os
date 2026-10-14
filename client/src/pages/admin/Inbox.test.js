import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { ToastProvider } from '../../context/ToastContext';
import { resetLastGood } from '../../components/inbox/lastGood';
import Inbox from './Inbox';

// The page against a fake server (lane inbox-engine's routes, spec section 8).
// `mock` prefix: babel-plugin-jest-hoist only lets a jest.mock factory close
// over variables named mock*.
const mockView = { isPhone: false, desktopView: () => false, setDesktopView: () => {} };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockView }));
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), delete: jest.fn() } }));

const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
const REPLY = {
  mode: 'text', lines: ['888'], default_line: '888', last_line: '888', recipient_display: '(312) 555-0100',
  opted_out: null, bad_number: false, proxy: false, staff: false, first_text_prefix: {}, app: null,
};
function itemOf(key, name, hours, o = {}) {
  return {
    person: { person_key: key, name, kind: 'client' }, waiting: true, waiting_since: hoursAgo(hours),
    status: 'waiting', need: `Question from ${name}`, state: { type: null }, legal_hold: false, closed: null, snooze: null,
    context: {
      kind: 'client', status_chip: 'Booked', event_type_label: 'Wedding', guests: 120,
      when_text: 'Sat Oct 24', where_text: 'Example Hall', proposal: { id: 4, status_label: 'Signed', chip: 'Signed' },
      money: null, links: { client_id: 4, proposal_id: 4, event_id: 4 },
    },
    thread: [{ ref: `sms:${key}`, direction: 'in', channel: 'text', line: '888', at: hoursAgo(hours), text: `Hello from ${name}`, media: [] }],
    reply: REPLY,
    ...o,
  };
}
const rowOf = (it, o = {}) => ({
  person_key: it.person.person_key, name: it.person.name, kind: 'client', need: it.need,
  waiting_since: it.waiting_since, hot: false, channels: ['text_888'], state: it.state, ...o,
});
const OLD = itemOf('c-1', 'Avery Example', 46);
const NEW = itemOf('c-2', 'Jo Test', 2, { state: { type: 'unseen' } });
const LIST = { generated_at: hoursAgo(0), ai: { status: 'on' }, waiting: [rowOf(NEW), rowOf(OLD)], snoozed: [], handled: [], feeds: [] };

let mockItems;
let mockList;
function serve({ failList = false } = {}) {
  api.get.mockImplementation((url) => {
    if (url === '/admin/inbox') {
      return failList
        ? Promise.reject({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' })
        : Promise.resolve({ status: 200, data: mockList });
    }
    const key = decodeURIComponent(url.replace('/admin/inbox/', ''));
    const hit = mockItems[key];
    if (hit && hit.moved) return Promise.resolve({ status: 404, data: { code: 'INBOX_MOVED', moved_to: hit.moved } });
    return Promise.resolve(hit ? { status: 200, data: hit } : { status: 404, data: { code: 'NOT_FOUND' } });
  });
  api.post.mockImplementation((url) => {
    if (url.endsWith('/seen')) return Promise.resolve({ status: 204 });
    if (url.endsWith('/actions')) return Promise.resolve({ status: 200, data: { id: 11 } });
    return Promise.resolve({ status: 201, data: { message: { line: '888', failed: false } } });
  });
}
const seenPosts = () => api.post.mock.calls.filter(([u]) => u.endsWith('/seen')).map(([u]) => u);
const itemGets = () => api.get.mock.calls.map(([u]) => u).filter((u) => u !== '/admin/inbox');
const listGets = () => api.get.mock.calls.filter(([u]) => u === '/admin/inbox').length;
const actionPosts = () => api.post.mock.calls.filter(([u]) => u.endsWith('/actions')).map(([u]) => u);
// A list with one snoozed person (Wake) and one handled (Reopen).
const withRowTaps = () => ({
  ...LIST,
  snoozed: [{ person_key: 'c-5', name: 'Sam Sample', until: hoursAgo(-20), by_name: 'Zul' }],
  handled: [{ person_key: 'c-6', name: 'Robin Case', need: '', channel: 'text_888', closed_at: hoursAgo(1), reason_text: 'You marked it done', by: 'D' }],
});
// Taps Wake, then Reopen, twice each while the first tap's answer is held:
// each records one action. Lets each answer land before the next tap.
async function doubleTapRowButtons(held, openHandled) {
  const wake = screen.getByRole('button', { name: 'Wake' });
  fireEvent.click(wake);
  fireEvent.click(wake);
  expect(actionPosts()).toEqual(['/admin/inbox/c-5/actions']);
  await act(async () => { held.release(); await new Promise((r) => setTimeout(r, 0)); });
  openHandled();
  const reopen = await screen.findByRole('button', { name: 'Reopen' });
  fireEvent.click(reopen);
  fireEvent.click(reopen);
  expect(actionPosts()).toEqual(['/admin/inbox/c-5/actions', '/admin/inbox/c-6/actions']);
  await act(async () => { held.release(); await new Promise((r) => setTimeout(r, 0)); });
}

// Holds each tap's answer (POST .../actions) until the test lets it land: a
// Done or Snooze still on its way while the user moves on.
function holdActions() {
  const held = { release: null };
  api.post.mockImplementation((url) => {
    if (url.endsWith('/seen')) return Promise.resolve({ status: 204 });
    if (url.endsWith('/actions')) {
      return new Promise((resolve) => { held.release = () => resolve({ status: 200, data: { id: 11 } }); });
    }
    return Promise.resolve({ status: 201, data: { message: { line: '888', failed: false } } });
  });
  return held;
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}
function mount(path) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/inbox/:personKey?" element={<><Inbox /><Where /></>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}
const where = () => screen.getByTestId('where').textContent;

// The chrome around the page: the phone header's Back (one step back in
// history) and a tab to another page, which unmounts the Inbox.
function Chrome() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate(-1)}>Go back</button>
      <button type="button" onClick={() => navigate('/events')}>Go to Events</button>
    </>
  );
}
// Starts on the last entry, with the earlier ones behind it in history.
function mountShell(entries) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={entries}>
        <Routes>
          <Route path="/inbox/:personKey?" element={<><Inbox /><Where /><Chrome /></>} />
          <Route path="/events" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

beforeEach(() => {
  mockView.isPhone = false;
  mockItems = { 'c-1': OLD, 'c-2': NEW };
  mockList = LIST;
  resetLastGood();
  window.localStorage.clear();
});

describe('desktop', () => {
  test('selects the longest wait on its own and never marks it seen', async () => {
    serve();
    mount('/inbox');
    expect(await screen.findByText('Hello from Avery Example')).toBeInTheDocument();
    expect(itemGets()).toEqual(['/admin/inbox/c-1']);
    expect(screen.getByText('Avery Example', { selector: '.ib-drow-name' }).closest('.ib-drow')).toHaveClass('is-selected');
    expect(where()).toBe('/inbox');
    expect(seenPosts()).toEqual([]);
  });

  test('a click is a deliberate open: the URL names the person and seen is written once', async () => {
    serve();
    mount('/inbox');
    await screen.findByText('Hello from Avery Example');
    fireEvent.click(screen.getByText('Jo Test', { selector: '.ib-drow-name' }));
    expect(await screen.findByText('Hello from Jo Test')).toBeInTheDocument();
    expect(where()).toBe('/inbox/c-2');
    await waitFor(() => expect(seenPosts()).toEqual(['/admin/inbox/c-2/seen']));
    // The header drops "Not read yet" on a deliberate open; the row keeps it
    // until the list reloads.
    expect(screen.queryByText('Not read yet', { selector: '.ib-thead .chip' })).toBeNull();
  });

  test('Done on an opened person moves to the next one on its own, without a seen write', async () => {
    serve();
    mount('/inbox/c-1');
    await screen.findByText('Hello from Avery Example');
    await waitFor(() => expect(seenPosts()).toEqual(['/admin/inbox/c-1/seen']));
    mockList = { ...LIST, waiting: [rowOf(NEW)] };
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Hello from Jo Test')).toBeInTheDocument();
    expect(where()).toBe('/inbox');
    expect(api.post).toHaveBeenCalledWith('/admin/inbox/c-1/actions', { action: 'done' });
    expect(screen.getByText('Done. Moved to Handled.')).toBeInTheDocument();
    expect(seenPosts()).toEqual(['/admin/inbox/c-1/seen']);
  });

  test('a draft survives the refetch that brings in their reply', async () => {
    serve();
    mount('/inbox/c-1');
    await screen.findByText('Hello from Avery Example');
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply' }), { target: { value: 'Half-written answer' } });
    mockItems = {
      ...mockItems,
      'c-1': { ...OLD, thread: [...OLD.thread, { ref: 'sms:new', direction: 'in', channel: 'text', line: '888', at: hoursAgo(0), text: 'One more thing', media: [] }] },
    };
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(await screen.findByText('One more thing')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reply' })).toHaveValue('Half-written answer');
  });

  test('a draft is kept per person: switch to someone else and back, it is still there', async () => {
    serve();
    mount('/inbox/c-1');
    await screen.findByText('Hello from Avery Example');
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply' }), { target: { value: 'For Avery' } });
    fireEvent.click(screen.getByText('Jo Test', { selector: '.ib-drow-name' }));
    await screen.findByText('Hello from Jo Test');
    expect(screen.getByRole('textbox', { name: 'Reply' })).toHaveValue('');
    fireEvent.click(screen.getByText('Avery Example', { selector: '.ib-drow-name' }));
    await screen.findByText('Hello from Avery Example');
    expect(screen.getByRole('textbox', { name: 'Reply' })).toHaveValue('For Avery');
  });

  test('a list that fails to load is the error card, never an empty inbox', async () => {
    serve({ failList: true });
    mount('/inbox');
    expect(await screen.findByText("Couldn't load the inbox")).toBeInTheDocument();
    expect(screen.queryByText("Nobody's waiting")).toBeNull();
    expect(screen.getByText('Feed status unknown until the inbox loads')).toBeInTheDocument();
  });

  test('a key that moved follows the hint and says so', async () => {
    serve();
    mockItems = { ...mockItems, 'p-3125550100': { moved: 'c-2' } };
    mount('/inbox/p-3125550100');
    await waitFor(() => expect(where()).toBe('/inbox/c-2'));
    expect(await screen.findByText('Hello from Jo Test')).toBeInTheDocument();
    expect(screen.getByText('This conversation moved.')).toBeInTheDocument();
  });

  test('a Done that lands after you opened someone else leaves you there, and still refreshes and toasts', async () => {
    serve();
    const held = holdActions();
    mount('/inbox/c-1');
    await screen.findByText('Hello from Avery Example');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    // While the Done is on its way, open Jo.
    fireEvent.click(screen.getByText('Jo Test', { selector: '.ib-drow-name' }));
    expect(await screen.findByText('Hello from Jo Test')).toBeInTheDocument();
    await waitFor(() => expect(seenPosts()).toEqual(['/admin/inbox/c-1/seen', '/admin/inbox/c-2/seen']));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const listReads = listGets();
    mockList = { ...LIST, waiting: [rowOf(NEW)] };
    await act(async () => { held.release(); await new Promise((r) => setTimeout(r, 0)); });
    expect(where()).toBe('/inbox/c-2');
    expect(screen.getByText('Hello from Jo Test')).toBeInTheDocument();
    expect(screen.getByText('Done. Moved to Handled.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(listGets()).toBeGreaterThan(listReads);
    await waitFor(() => expect(screen.queryByText('Avery Example', { selector: '.ib-drow-name' })).toBeNull());
  });

  // The desktop's own pick holds still (code-review 2026-10-09): a poll may
  // reorder Waiting, or fail, while the user reads and types to the person it
  // picked.
  test('a poll that puts someone else at the head of Waiting leaves the picked conversation and its draft where they are', async () => {
    serve();
    mount('/inbox');
    await screen.findByText('Hello from Avery Example');
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply' }), { target: { value: 'Half-written answer' } });
    const LONGER = itemOf('c-3', 'Sam Sample', 70);
    mockItems = { ...mockItems, 'c-3': LONGER };
    mockList = { ...LIST, waiting: [rowOf(NEW), rowOf(OLD), rowOf(LONGER)] };
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(await screen.findByText('Sam Sample', { selector: '.ib-drow-name' })).toBeInTheDocument();
    expect(screen.getByText('Hello from Avery Example')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reply' })).toHaveValue('Half-written answer');
    expect(screen.getByText('Avery Example', { selector: '.ib-drow-name' }).closest('.ib-drow')).toHaveClass('is-selected');
    expect(itemGets()).not.toContain('/admin/inbox/c-3');
    expect(where()).toBe('/inbox');
    expect(seenPosts()).toEqual([]);
  });

  test('Done on the desktop\'s own pick moves the pick to the next longest wait, with no seen write', async () => {
    serve();
    mount('/inbox');
    await screen.findByText('Hello from Avery Example');
    mockList = { ...LIST, waiting: [rowOf(NEW)] };
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Hello from Jo Test')).toBeInTheDocument();
    expect(where()).toBe('/inbox');
    expect(api.post).toHaveBeenCalledWith('/admin/inbox/c-1/actions', { action: 'done' });
    expect(screen.getByText('Jo Test', { selector: '.ib-drow-name' }).closest('.ib-drow')).toHaveClass('is-selected');
    expect(seenPosts()).toEqual([]);
  });

  test('a failed poll after a good load keeps the picked conversation and its composer; the list pane shows the error card', async () => {
    serve();
    mount('/inbox');
    await screen.findByText('Hello from Avery Example');
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply' }), { target: { value: 'Half-written answer' } });
    serve({ failList: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(await screen.findByText("Couldn't load the inbox")).toBeInTheDocument();
    expect(screen.queryByText('Avery Example', { selector: '.ib-drow-name' })).toBeNull();
    expect(screen.getByText('Hello from Avery Example')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reply' })).toHaveValue('Half-written answer');
    expect(where()).toBe('/inbox');
    expect(seenPosts()).toEqual([]);
  });

  // A pick held still must still follow a move, or it would sit on a key
  // that no longer resolves. The fixture key is built from parts (the repo
  // is public): a fiction-range number.
  test('a move of the desktop\'s own pick is followed in place: no URL write and no seen', async () => {
    const movedKey = ['p-', '312', '555', '0177'].join('');
    const UNKNOWN = itemOf(movedKey, 'Unknown number', 60);
    serve();
    mockItems = { ...mockItems, [movedKey]: { moved: 'c-1' } };
    mockList = { ...LIST, waiting: [rowOf(NEW), rowOf(OLD), rowOf(UNKNOWN)] };
    mount('/inbox');
    expect(await screen.findByText('Hello from Avery Example')).toBeInTheDocument();
    expect(itemGets()).toEqual([`/admin/inbox/${movedKey}`, '/admin/inbox/c-1']);
    expect(where()).toBe('/inbox');
    expect(seenPosts()).toEqual([]);
  });

  test('a Done re-reads the list but never the item it closed', async () => {
    serve();
    mount('/inbox/c-1');
    await screen.findByText('Hello from Avery Example');
    await waitFor(() => expect(seenPosts()).toEqual(['/admin/inbox/c-1/seen']));
    const listReads = listGets();
    mockList = { ...LIST, waiting: [rowOf(NEW)] };
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Hello from Jo Test')).toBeInTheDocument();
    expect(listGets()).toBeGreaterThan(listReads);
    expect(itemGets()).toEqual(['/admin/inbox/c-1', '/admin/inbox/c-2']);
  });

  // Wake and Reopen in the list take the page's in-flight state, as the
  // item's own buttons do (code-review 2026-10-09).
  test('Wake and Reopen in the list are off while a tap is on its way: a second tap records one action', async () => {
    serve();
    const held = holdActions();
    mockList = withRowTaps();
    mount('/inbox');
    await screen.findByText('Hello from Avery Example');
    await doubleTapRowButtons(held, () => fireEvent.click(screen.getByRole('button', { name: /Handled, last 7 days/ })));
  });

  // The app renders under React.StrictMode (index.js), which runs every effect
  // twice on mount in development: the seenFor guard is what keeps one
  // deliberate open to one seen write.
  test('under StrictMode a deep link still writes seen exactly once', async () => {
    serve();
    render(
      <React.StrictMode>
        <ToastProvider>
          <MemoryRouter initialEntries={['/inbox/c-1']}>
            <Routes>
              <Route path="/inbox/:personKey?" element={<><Inbox /><Where /></>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </React.StrictMode>
    );
    await screen.findByText('Hello from Avery Example');
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(seenPosts()).toEqual(['/admin/inbox/c-1/seen']);
  });
});

describe('phone', () => {
  beforeEach(() => { mockView.isPhone = true; });

  test('the list loads no item; tapping a card opens it and writes seen once', async () => {
    serve();
    mount('/inbox');
    const card = await screen.findByText('Avery Example', { selector: '.m-card-title' });
    expect(itemGets()).toEqual([]);
    expect(screen.getByText('2 waiting · oldest 46 hrs')).toBeInTheDocument();
    fireEvent.click(card);
    expect(await screen.findByText('Hello from Avery Example')).toBeInTheDocument();
    expect(where()).toBe('/inbox/c-1');
    expect(screen.getByText('46 hrs')).toHaveClass('ib-wait-long', 'ib-hot');
    await waitFor(() => expect(seenPosts()).toEqual(['/admin/inbox/c-1/seen']));
  });

  test('Done on the phone goes back to the list', async () => {
    serve();
    mount('/inbox/c-1');
    await screen.findByText('Hello from Avery Example');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(where()).toBe('/inbox'));
    expect(await screen.findByText('Jo Test', { selector: '.m-card-title' })).toBeInTheDocument();
  });

  test('a Snooze that lands after you went back and opened someone else leaves you there, and still refreshes and toasts', async () => {
    serve();
    const held = holdActions();
    mountShell(['/inbox', '/inbox/c-1']);
    await screen.findByText('Hello from Avery Example');
    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }));
    fireEvent.click(screen.getByRole('button', { name: /3 hours/ }));
    // While the Snooze is on its way: Back to the list, then open Jo.
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    fireEvent.click(await screen.findByText('Jo Test', { selector: '.m-card-title' }));
    expect(await screen.findByText('Hello from Jo Test')).toBeInTheDocument();
    await waitFor(() => expect(seenPosts()).toEqual(['/admin/inbox/c-1/seen', '/admin/inbox/c-2/seen']));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const listReads = listGets();
    await act(async () => { held.release(); await new Promise((r) => setTimeout(r, 0)); });
    expect(where()).toBe('/inbox/c-2');
    expect(screen.getByText('Hello from Jo Test')).toBeInTheDocument();
    expect(screen.getByText(/^Snoozed until /)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(listGets()).toBeGreaterThan(listReads);
    const [, body] = api.post.mock.calls.find(([u]) => u === '/admin/inbox/c-1/actions');
    expect(body.action).toBe('snooze');
  });

  test('a Done that lands after you left the Inbox leaves you on that page, and still toasts', async () => {
    serve();
    const held = holdActions();
    mountShell(['/inbox/c-1']);
    await screen.findByText('Hello from Avery Example');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    // While the Done is on its way, leave for Events: the Inbox unmounts.
    fireEvent.click(screen.getByRole('button', { name: 'Go to Events' }));
    expect(where()).toBe('/events');
    await act(async () => { held.release(); await new Promise((r) => setTimeout(r, 0)); });
    expect(where()).toBe('/events');
    expect(screen.getByText('Done. Moved to Handled.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  test('Wake and Reopen in the list are off while a tap is on its way: a second tap records one action', async () => {
    serve();
    const held = holdActions();
    mockList = withRowTaps();
    mount('/inbox');
    await screen.findByText('Avery Example', { selector: '.m-card-title' });
    await doubleTapRowButtons(held, () => fireEvent.click(screen.getByRole('radio', { name: /Handled/ })));
  });

  test('Snooze opens the sheet; a preset snoozes until 8:00 AM Chicago and returns to the list', async () => {
    serve();
    mount('/inbox/c-1');
    await screen.findByText('Hello from Avery Example');
    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }));
    expect(screen.getByRole('dialog', { name: 'Snooze Avery Example' })).toBeInTheDocument();
    expect(screen.getByText('Hidden until then. It comes back to Waiting with its full wait time.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Tomorrow morning/ }));
    await waitFor(() => expect(where()).toBe('/inbox'));
    const [, body] = api.post.mock.calls.find(([u]) => u.endsWith('/actions'));
    expect(body.action).toBe('snooze');
    expect(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(new Date(body.until)).replace(/\u202f/g, ' ')).toBe('8:00 AM');
  });
});
