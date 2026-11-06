import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet, useLocation, useNavigate } from 'react-router-dom';
import ProposalDetailPhone from './ProposalDetailPhone';
import ProposalDetail from '../admin/ProposalDetail';
import api from '../../utils/api';
import { PUBLIC_SITE_URL } from '../../utils/constants';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn() } }));
const mockMobileView = { isPhone: true, desktopView: jest.fn(() => false), setDesktopView: jest.fn(), setDesktopForVisit: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockMobileView }));
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));
const mockAuth = { user: { id: 1, role: 'admin' } };
jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }));

const TOKEN = '3f9a1c55-6b7d-4e8f-a012-3456789abcde';
const PROPOSAL = {
  id: 41, status: 'sent', token: TOKEN, client_name: 'Test Client', client_phone: '3125550100',
  client_email: 'client41@example.test', event_type: 'wedding-reception', event_type_custom: null,
  event_date: '2999-08-15T00:00:00.000Z', event_start_time: '18:00', event_duration_hours: '5',
  event_location: 'Test Hall, 12 River Rd, Rockford, Illinois 61101', venue_street: '12 River Rd',
  venue_city: 'Rockford', venue_state: 'Illinois', venue_zip: '61101', guest_count: 120,
  total_price: '4900.00', amount_paid: '0.00', legal_hold: false, group_id: null,
  sent_at: new Date(Date.now() - 2 * 86400000).toISOString(), last_viewed_at: null, view_count: 0,
  pricing_snapshot: { total: 4900, breakdown: [{ label: 'Signature bar', amount: 4270 }, { label: 'Mobile bar rental', amount: 450 }, { label: 'Glassware', amount: 180 }] },
};
const OFFLINE_OK = { headers: { 'X-Offline-Ok': '1' } };

// Each value is a payload entry ({ data } or { data, staleAt }, with an
// optional delay in ms before it answers), or { reject }, or { hang: true }: a
// read on a stalled connection, which never answers and gives up only at the
// timeout the caller set, as axios does.
function serve(over = {}) {
  const table = { '/proposals/41': { data: PROPOSAL }, '/proposals/41/change-requests': { data: { requests: [] } }, ...over };
  api.get.mockImplementation((url, config) => {
    const entry = typeof table[url] === 'function' ? table[url]() : table[url];
    if (!entry) return Promise.reject({ status: 404, message: 'Not found' });
    if (entry.hang) {
      return new Promise((resolve, reject) => {
        if (config && config.timeout) setTimeout(() => reject({ status: 0, code: 'ECONNABORTED', message: 'timeout' }), config.timeout);
      });
    }
    if (entry.delay) {
      // A caller's timeout shorter than the answer aborts it, as axios does.
      return new Promise((resolve, reject) => {
        if (config && config.timeout && config.timeout < entry.delay) {
          setTimeout(() => reject({ status: 0, code: 'ECONNABORTED', message: 'timeout' }), config.timeout);
        } else {
          setTimeout(() => resolve(entry), entry.delay);
        }
      });
    }
    return entry.reject ? Promise.reject(entry.reject) : Promise.resolve(entry);
  });
}

function Shell({ ctx }) { return <Outlet context={ctx} />; }
// Every history entry the route has shown, in order: a replace adds one.
let seenKeys = [];
function Loc() {
  const l = useLocation();
  if (!seenKeys.includes(l.key)) seenKeys.push(l.key);
  return <><div data-testid="loc">{l.pathname}</div><div data-testid="search">{l.search}</div></>;
}
function mount(path = '/proposals/41', element = <ProposalDetailPhone />) {
  const ctx = { badges: {}, refreshBadges: jest.fn(), setHeaderDetail: jest.fn() };
  const utils = render(
    <MemoryRouter initialEntries={['/proposals', path]} initialIndex={1}>
      <Routes>
        <Route element={<Shell ctx={ctx} />}>
          <Route path="/proposals/:id" element={<>{element}<Loc /></>} />
        </Route>
        <Route path="/proposals" element={<Loc />} />
        <Route path="/events/:id" element={<Loc />} />
      </Routes>
    </MemoryRouter>
  );
  return { ctx, ...utils };
}
const row = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

beforeEach(() => {
  jest.clearAllMocks();
  seenKeys = [];
  mockMobileView.desktopView.mockImplementation(() => false);
  mockMobileView.isPhone = true;
});

describe('the fork in ProposalDetail', () => {
  test('at phone width /proposals/:id renders the phone detail', async () => {
    serve();
    mount('/proposals/41', <ProposalDetail />);
    await screen.findByText('Contacts');
    expect(api.get).toHaveBeenCalledWith('/proposals/41', OFFLINE_OK);
    expect(screen.queryByText(/Loading proposal…/)).not.toBeInTheDocument();
  });
  test('under the Desktop-view override it renders the desktop body', async () => {
    mockMobileView.desktopView.mockImplementation((key) => key === 'proposal-detail');
    api.get.mockImplementation(() => new Promise(() => {}));
    mount('/proposals/41', <ProposalDetail />);
    expect(await screen.findByText(/Loading proposal…/)).toBeInTheDocument();
    expect(screen.queryByText('Contacts')).not.toBeInTheDocument();
    // The desktop body never asks the phone's store.
    expect(api.get.mock.calls.filter((c) => c[1] && c[1].headers)).toHaveLength(0);
  });
  test.each([['a change request', '/proposals/41?change_request_id=7', '?change_request_id=7'], ['the editor', '/proposals/41?edit=1', '?edit=1']])(
    'a link into %s opens the desktop page for this visit, keeping its link, and reads nothing',
    async (_name, path, search) => {
      api.get.mockImplementation(() => new Promise(() => {}));
      mount(path, <ProposalDetail />);
      await waitFor(() => expect(mockMobileView.setDesktopForVisit).toHaveBeenCalledWith('proposal-detail'));
      // The entry is replaced with itself, its query kept, so the visit starts on it.
      await waitFor(() => expect(seenKeys).toHaveLength(2));
      expect(screen.getByTestId('loc')).toHaveTextContent(/^\/proposals\/41$/);
      expect(screen.getByTestId('search')).toHaveTextContent(search);
      expect(api.get).not.toHaveBeenCalled();
    }
  );
  test('at desktop width it renders the desktop body', async () => {
    mockMobileView.isPhone = false;
    api.get.mockImplementation(() => new Promise(() => {}));
    mount('/proposals/41', <ProposalDetail />);
    expect(await screen.findByText(/Loading proposal…/)).toBeInTheDocument();
  });
});

test('one read through the phone store, the rich header handed over and cleared', async () => {
  serve();
  const { ctx, unmount } = mount();
  await screen.findByText('Contacts');
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(api.get).toHaveBeenCalledWith('/proposals/41', OFFLINE_OK);
  // The change requests are read live and never stored: no offline header.
  expect(api.get).toHaveBeenCalledWith('/proposals/41/change-requests');
  await waitFor(() => expect(ctx.setHeaderDetail).toHaveBeenLastCalledWith(expect.objectContaining({
    title: 'Test Client', kind: 'Wedding Reception', guests: 120, mapHref: expect.stringContaining('query=12%20River%20Rd'),
  })));
  unmount();
  expect(ctx.setHeaderDetail).toHaveBeenLastCalledWith(null);
});

test('the when line with its chip, the status line, and the closed sections', async () => {
  serve();
  mount();
  await screen.findByText('Contacts');
  expect(screen.getByText('Sent')).toBeInTheDocument();
  expect(screen.getByText('sent 2d ago · not opened yet')).toBeInTheDocument();
  expect(row('Contacts')).toHaveAttribute('aria-expanded', 'false');
  expect(row('Package & extras')).toHaveAttribute('aria-expanded', 'false');
  expect(row('Package & extras')).toHaveTextContent('$4,900.00');
});

test('Contacts holds the client alone, phone and email as tap targets', async () => {
  serve();
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /^Contacts/ }));
  expect(screen.getByRole('link', { name: '(312) 555-0100' })).toHaveAttribute('href', 'tel:3125550100');
  expect(screen.getByRole('link', { name: 'client41@example.test' })).toHaveAttribute('href', 'mailto:client41@example.test');
  expect(screen.queryByText(/Day-of contact/i)).not.toBeInTheDocument();
  // No Text link: an sms: link would send from the phone's own number.
  expect(screen.queryByRole('link', { name: /^Text/ })).not.toBeInTheDocument();
  expect(document.querySelector('a[href^="sms:"]')).toBeNull();
});

test("Package & extras lists the stored snapshot's lines and the total", async () => {
  serve();
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /^Package & extras/ }));
  for (const [label, amount] of [['Signature bar', '$4,270.00'], ['Mobile bar rental', '$450.00'], ['Glassware', '$180.00']]) {
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(amount)).toBeInTheDocument();
  }
  expect(screen.getByText('Total')).toBeInTheDocument();
});

// The resend sheet's preview, for the tests that open it.
const PREVIEW = {
  recipient: { name: 'Test Client', email: 'client41@example.test', phone: null, source: 'client' },
  warnings: [],
  channels: { email: { available: true, default: true }, sms: { available: false, default: false, unavailable_reason: 'Client has opted out of SMS.' } },
  email: { subject: 'Your proposal', bodyText: 'Here it is.' },
  sms: { body: '' },
};
function BackButton() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>history back</button>;
}
const withBack = <><ProposalDetailPhone /><BackButton /></>;
const sheet = (name) => screen.queryByRole('dialog', { name });

describe('the action card and its sheets', () => {
  beforeEach(() => {
    api.post.mockImplementation((url) => (url === '/comms/preview' ? Promise.resolve({ data: PREVIEW }) : new Promise(() => {})));
  });
  test('Resend proposal then Archive, no Send reminder; each opens its sheet as a history entry, and Back closes it', async () => {
    serve();
    mount('/proposals/41', withBack);
    await screen.findByText('Contacts');
    expect(row('Resend proposal')).not.toHaveTextContent(/desktop view/i);
    expect(row('Archive')).not.toHaveTextContent(/desktop view/i);
    expect(screen.queryByText(/reminder/i)).not.toBeInTheDocument();

    await act(async () => { fireEvent.click(row('Resend proposal')); });
    expect(sheet('Resend proposal')).toBeInTheDocument();
    expect(screen.getByTestId('search')).toHaveTextContent('?drawer=resend&drawerId=41');
    expect(api.post).toHaveBeenCalledWith('/comms/preview', { action: 'proposal_resend', entity_id: 41 }, { timeout: 10000 });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'history back' })); });
    expect(sheet('Resend proposal')).not.toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/proposals\/41$/);
    expect(screen.getByTestId('search')).toBeEmptyDOMElement();

    await act(async () => { fireEvent.click(row('Archive')); });
    expect(sheet('Archive proposal')).toBeInTheDocument();
    expect(screen.getByTestId('search')).toHaveTextContent('?drawer=archive&drawerId=41');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'history back' })); });
    expect(sheet('Archive proposal')).not.toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/proposals\/41$/);

    // Edit details opens desktop view until the phone's edit sheet lands.
    fireEvent.click(row('Edit details'));
    expect(mockMobileView.setDesktopView).toHaveBeenCalledTimes(1);
    expect(mockMobileView.setDesktopView).toHaveBeenLastCalledWith('proposal-detail', true);
  });
  test('a draft and a modified proposal keep Send proposal on desktop view; their Archive opens its sheet', async () => {
    for (const status of ['draft', 'modified']) {
      serve({ '/proposals/41': { data: { ...PROPOSAL, status, sent_at: status === 'draft' ? null : PROPOSAL.sent_at } } });
      const { unmount } = mount();
      // eslint-disable-next-line no-await-in-loop
      await screen.findByText('Contacts');
      expect(row('Send proposal')).toHaveTextContent(/desktop view/i);
      fireEvent.click(row('Send proposal'));
      expect(mockMobileView.setDesktopView).toHaveBeenLastCalledWith('proposal-detail', true);
      expect(sheet('Resend proposal')).not.toBeInTheDocument();
      // eslint-disable-next-line no-await-in-loop
      await act(async () => { fireEvent.click(row('Archive')); });
      expect(sheet('Archive proposal')).toBeInTheDocument();
      unmount();
    }
  });
  test('an options group keeps Resend on desktop view, and its Archive (this proposal only) opens the sheet', async () => {
    serve({ '/proposals/41': { data: { ...PROPOSAL, group_id: 9 } } });
    mount();
    await screen.findByText('Contacts');
    expect(row('Resend proposal')).toHaveTextContent(/desktop view/i);
    fireEvent.click(row('Resend proposal'));
    expect(sheet('Resend proposal')).not.toBeInTheDocument();
    expect(mockMobileView.setDesktopView).toHaveBeenLastCalledWith('proposal-detail', true);
    await act(async () => { fireEvent.click(row('Archive')); });
    expect(sheet('Archive proposal')).toBeInTheDocument();
  });
  test('a sheet parameter that can open nothing here is dropped once the read settles', async () => {
    const cases = [
      ['a stored copy', '/proposals/41?drawer=resend&drawerId=41', { '/proposals/41': { data: PROPOSAL, staleAt: '2026-11-05T15:00:00Z' } }],
      ['an options group', '/proposals/41?drawer=resend&drawerId=41', { '/proposals/41': { data: { ...PROPOSAL, group_id: 9 } } }],
      ['money on the row', '/proposals/41?drawer=archive&drawerId=41', { '/proposals/41': { data: { ...PROPOSAL, status: 'accepted', amount_paid: '100.00' } } }],
      ['legal hold', '/proposals/41?drawer=archive&drawerId=41', { '/proposals/41': { data: { ...PROPOSAL, legal_hold: true } } }],
      ['another proposal', '/proposals/41?drawer=archive&drawerId=42', {}],
    ];
    for (const [, path, over] of cases) {
      serve(over);
      const { unmount } = mount(path);
      // eslint-disable-next-line no-await-in-loop
      await screen.findByText('Contacts');
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(screen.getByTestId('search')).toBeEmptyDOMElement());
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      unmount();
    }
    expect(api.post).not.toHaveBeenCalled();
  });
  test('when the remote staffing fee comes first, Desktop view closes the sheet and opens the desktop page', async () => {
    serve({ '/proposals/41/remote-staffing-check': { data: { should_prompt: true } } });
    mount('/proposals/41', withBack);
    await screen.findByText('Contacts');
    await act(async () => { fireEvent.click(row('Resend proposal')); });
    expect(sheet('Resend proposal')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Desktop view' })); });
    expect(mockMobileView.setDesktopView).toHaveBeenLastCalledWith('proposal-detail', true);
    expect(sheet('Resend proposal')).not.toBeInTheDocument();
    expect(screen.getByTestId('search')).toBeEmptyDOMElement();
    expect(api.post.mock.calls.filter((c) => c[0] === '/comms/send')).toHaveLength(0);
  });
  test('an archive that lands after Back closed its sheet has the page read the proposal again', async () => {
    let reads = 0;
    serve({
      '/proposals/41': () => {
        reads += 1;
        return { data: reads <= 2 ? PROPOSAL : { ...PROPOSAL, status: 'archived', archive_reason: 'no_hire' } };
      },
    });
    let land;
    api.post.mockImplementation((url) => (url.endsWith('/archive') ? new Promise((resolve) => { land = resolve; }) : Promise.reject({ status: 404 })));
    mount('/proposals/41', withBack);
    await screen.findByText('Contacts');
    await act(async () => { fireEvent.click(row('Archive')); });
    fireEvent.click(screen.getByRole('button', { name: 'No hire' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive proposal' })); });
    expect(reads).toBe(2);   // the page's read, then the sheet's fresh read
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'history back' })); });
    expect(sheet('Archive proposal')).not.toBeInTheDocument();
    await act(async () => { land({ data: { archived_ids: [41] } }); });
    expect(await screen.findByText('archived · No hire')).toBeInTheDocument();
    expect(reads).toBe(3);
    expect(screen.queryByRole('button', { name: /^Archive/ })).not.toBeInTheDocument();
  });
  test('a sheet that refused because the proposal changed has the page read it again as it closes', async () => {
    let reads = 0;
    serve({
      '/proposals/41': () => {
        reads += 1;
        return { data: reads === 1 ? PROPOSAL : { ...PROPOSAL, status: 'deposit_paid', amount_paid: '0.00' } };
      },
    });
    mount();
    await screen.findByText('Contacts');
    await act(async () => { fireEvent.click(row('Archive')); });
    fireEvent.click(screen.getByRole('button', { name: 'No hire' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive proposal' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('This proposal changed since you opened it. Nothing was archived.');
    expect(api.post).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByText('Close')); });
    // The page's read again finds a booking, which belongs to the event detail.
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/41$/));
    expect(reads).toBe(3);
  });
});

describe('a read the sheets ask for', () => {
  test('an archive answer that comes while a resend sheet shows its result waits: the sheet stays, with no second Send', async () => {
    let reads = 0;
    serve({ '/proposals/41': () => { reads += 1; return { data: PROPOSAL }; } });
    let failArchive;
    api.post.mockImplementation((url) => {
      if (url === '/comms/preview') return Promise.resolve({ data: PREVIEW });
      if (url === '/comms/send') return Promise.resolve({ data: { ok: true, email: 'sent', skip_reasons: {}, recipient_email: 'client41@example.test' } });
      if (url.endsWith('/archive')) return new Promise((resolve, reject) => { failArchive = reject; });
      return Promise.reject({ status: 404 });
    });
    mount('/proposals/41', withBack);
    await screen.findByText('Contacts');
    // An archive goes out, and Back closes its sheet while it says Archiving.
    await act(async () => { fireEvent.click(row('Archive')); });
    fireEvent.click(screen.getByRole('button', { name: 'No hire' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive proposal' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'history back' })); });
    expect(sheet('Archive proposal')).not.toBeInTheDocument();
    // A resend goes out and its sheet shows the answer.
    await act(async () => { fireEvent.click(row('Resend proposal')); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    const readsBefore = reads;
    // The archive then fails at the payment check, nothing archived.
    await act(async () => { failArchive({ status: 502, code: 'EXTERNAL_SERVICE_ERROR', message: "Couldn't check this proposal's payments with Stripe, so nothing was archived. Try again." }); });
    expect(sheet('Resend proposal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(api.post.mock.calls.filter((c) => c[0] === '/comms/preview')).toHaveLength(1);
    expect(reads).toBe(readsBefore);
    // The read runs as the sheet closes.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    await waitFor(() => expect(reads).toBe(readsBefore + 1));
    expect(sheet('Resend proposal')).not.toBeInTheDocument();
    expect(api.post.mock.calls.filter((c) => c[0] === '/comms/send')).toHaveLength(1);
  });
  test('Back after an archive whose answer never came, while its sheet was open, has the page read again', async () => {
    let reads = 0;
    serve({
      '/proposals/41': () => {
        reads += 1;
        return { data: reads <= 2 ? PROPOSAL : { ...PROPOSAL, status: 'archived', archive_reason: 'no_hire' } };
      },
    });
    api.post.mockImplementation((url) => (url.endsWith('/archive') ? Promise.reject({ status: 0, code: 'NETWORK_ERROR' }) : Promise.reject({ status: 404 })));
    mount('/proposals/41', withBack);
    await screen.findByText('Contacts');
    await act(async () => { fireEvent.click(row('Archive')); });
    fireEvent.click(screen.getByRole('button', { name: 'No hire' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive proposal' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('It may have been archived.');
    expect(reads).toBe(2);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'history back' })); });
    expect(await screen.findByText('archived · No hire')).toBeInTheDocument();
    expect(reads).toBe(3);
  });
});

test('a draft reads Send proposal on desktop view, and its Client link is not sent yet', async () => {
  serve({ '/proposals/41': { data: { ...PROPOSAL, status: 'draft', sent_at: null } } });
  mount();
  await screen.findByText('draft · never sent');
  expect(row('Send proposal')).toHaveTextContent(/desktop view/i);
  expect(row('Client link')).toHaveTextContent('not sent yet');
  expect(row('Client link')).toBeDisabled();
});

test('a booked proposal opens the event detail, replacing the entry', async () => {
  serve({ '/proposals/41': { data: { ...PROPOSAL, status: 'deposit_paid', amount_paid: '500.00' } } });
  mount();
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/events/41'));
  expect(mockMobileView.setDesktopForVisit).not.toHaveBeenCalled();
});

test('with the event detail in Desktop view, a booked proposal opens its desktop page for this visit, never the event', async () => {
  mockMobileView.desktopView.mockImplementation((key) => key === 'event-detail');
  serve({ '/proposals/41': { data: { ...PROPOSAL, status: 'confirmed', amount_paid: '500.00' } } });
  mount();
  await waitFor(() => expect(mockMobileView.setDesktopForVisit).toHaveBeenCalledWith('proposal-detail'));
  expect(screen.getByTestId('loc')).toHaveTextContent(/^\/proposals\/41$/);
});

describe('a route that can never load', () => {
  const cases = [
    ['a 404', '/proposals/41', { '/proposals/41': { reject: { status: 404, message: 'Not found' } } }],
    ['a 403', '/proposals/41', { '/proposals/41': { reject: { status: 403, message: 'Forbidden' } } }],
    ['a malformed id', '/proposals/abc', {}],
  ];
  test.each(cases)('%s with an in-app page behind: the screen says so itself and the chrome is not told', async (_name, path, over) => {
    serve(over);
    const heard = jest.fn();
    window.addEventListener('mobile-route-dead', heard);
    window.history.replaceState({ idx: 2 }, '');
    try {
      mount(path);
      expect(await screen.findByText("This proposal isn't available")).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Back to Proposals' })).toBeInTheDocument();
      expect(heard).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, '');
      window.removeEventListener('mobile-route-dead', heard);
    }
  });
  test.each(cases)('%s with nothing behind (a cold launch, a resume): unavailable, and mobile-route-dead once', async (_name, path, over) => {
    serve(over);
    const heard = jest.fn();
    window.addEventListener('mobile-route-dead', heard);
    try {
      mount(path);
      expect(await screen.findByText("This proposal isn't available")).toBeInTheDocument();
      expect(heard).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'Back to Proposals' }));
      expect(screen.getByTestId('loc')).toHaveTextContent(/^\/proposals$/);
    } finally {
      window.removeEventListener('mobile-route-dead', heard);
    }
  });
});

test('a failed read says so with Retry, and Retry reads again', async () => {
  let n = 0;
  serve({ '/proposals/41': () => (++n === 1 ? { reject: { status: 0, message: 'Network error. Check your connection.' } } : { data: PROPOSAL }) });
  mount();
  expect(await screen.findByText("Couldn't load this proposal")).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('Contacts');
});

test('a stored copy: the stale line, needs connection on every acting row, the Client link still works, Refresh reads again', async () => {
  const share = jest.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'share', { value: share, configurable: true });
  try {
    let n = 0;
    serve({ '/proposals/41': () => (++n === 1 ? { data: PROPOSAL, staleAt: '2026-11-05T15:00:00Z' } : { data: PROPOSAL }) });
    mount();
    expect(await screen.findByText(/offline copy/)).toBeInTheDocument();
    for (const name of ['Edit details', 'Resend proposal', 'Archive']) {
      expect(row(name)).toBeDisabled();
      expect(row(name)).toHaveTextContent(/needs connection/i);
    }
    fireEvent.click(row('Client link'));
    expect(share).toHaveBeenCalledWith({ url: `${PUBLIC_SITE_URL}/proposal/${TOKEN}` });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('button', { name: /^Resend proposal/ })).not.toBeDisabled();
    expect(screen.queryByText(/offline copy/)).not.toBeInTheDocument();
    expect(n).toBe(2);
  } finally {
    delete navigator.share;
  }
});

describe('the Client link', () => {
  afterEach(() => { delete navigator.share; delete navigator.clipboard; });
  test("shows the host, the path and six characters, and hands the desktop's URL to the share sheet", async () => {
    const share = jest.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    serve();
    mount();
    await screen.findByText('Contacts');
    expect(row('Client link')).toHaveTextContent(`/proposal/${TOKEN.slice(0, 6)}`);
    expect(row('Client link')).not.toHaveTextContent(TOKEN);
    fireEvent.click(row('Client link'));
    expect(share).toHaveBeenCalledWith({ url: `${PUBLIC_SITE_URL}/proposal/${TOKEN}` });
    expect(mockToast.success).not.toHaveBeenCalled();
  });
  test('dismissing the share sheet does nothing more', async () => {
    const share = jest.fn(() => Promise.reject(Object.assign(new Error('dismissed'), { name: 'AbortError' })));
    const writeText = jest.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    serve();
    mount();
    await screen.findByText('Contacts');
    await act(async () => { fireEvent.click(row('Client link')); });
    expect(writeText).not.toHaveBeenCalled();
  });
  test('with no share sheet it copies the link and says "Link copied."', async () => {
    const writeText = jest.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    serve();
    mount();
    await screen.findByText('Contacts');
    fireEvent.click(row('Client link'));
    expect(writeText).toHaveBeenCalledWith(`${PUBLIC_SITE_URL}/proposal/${TOKEN}`);
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Link copied.'));
  });
});

test('legal hold: the note, and no action, no Edit details and no Client link', async () => {
  serve({ '/proposals/41': { data: { ...PROPOSAL, legal_hold: true } } });
  mount();
  expect(await screen.findByText('This proposal is on legal hold. Nothing is changed or sent from here.')).toBeInTheDocument();
  for (const name of ['Edit details', 'Client link', 'Resend proposal', 'Send proposal', 'Archive']) {
    expect(screen.queryByRole('button', { name: new RegExp(`^${name}`) })).not.toBeInTheDocument();
  }
});

test('archived: its chip and reason, and no action, no Edit details and no Client link', async () => {
  serve({ '/proposals/41': { data: { ...PROPOSAL, status: 'archived', archive_reason: 'we_cancelled' } } });
  mount();
  expect(await screen.findByText('archived · We cancelled')).toBeInTheDocument();
  expect(screen.getByText('Archived')).toBeInTheDocument();
  for (const name of ['Edit details', 'Client link', 'Resend proposal', 'Archive']) {
    expect(screen.queryByRole('button', { name: new RegExp(`^${name}`) })).not.toBeInTheDocument();
  }
});

describe('a change-request read on a stalled connection', () => {
  test('never holds back a stored copy: the copy shows with its stale line and no row', async () => {
    serve({
      '/proposals/41': { data: PROPOSAL, staleAt: '2026-11-05T15:00:00Z' },
      '/proposals/41/change-requests': { hang: true },
    });
    mount();
    expect(await screen.findByText(/offline copy/)).toBeInTheDocument();
    expect(screen.getByText('Contacts')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Change request/ })).not.toBeInTheDocument();
  });
  test('after a fresh answer it waits at most 4 more seconds, then shows the screen with no row', async () => {
    jest.useFakeTimers();
    try {
      serve({ '/proposals/41/change-requests': { hang: true } });
      mount();
      await act(async () => {});
      expect(screen.getByText('Loading the proposal')).toBeInTheDocument();
      await act(async () => { jest.advanceTimersByTime(3900); });
      expect(screen.getByText('Loading the proposal')).toBeInTheDocument();
      await act(async () => { jest.advanceTimersByTime(100); });
      expect(screen.getByText('Contacts')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Change request/ })).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
  test('a request answered before a slow fresh proposal still counts: a booked proposal stays to show it', async () => {
    jest.useFakeTimers();
    try {
      serve({
        '/proposals/41': { data: { ...PROPOSAL, status: 'deposit_paid', amount_paid: '500.00' }, delay: 6000 },
        '/proposals/41/change-requests': { data: { requests: [{ id: 4, status: 'pending' }] }, delay: 4500 },
      });
      mount();
      await act(async () => { jest.advanceTimersByTime(6000); });
      await act(async () => {});
      expect(screen.getByRole('button', { name: /^Change request/ })).toBeInTheDocument();
      expect(screen.getByTestId('loc')).toHaveTextContent(/^\/proposals\/41$/);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('a pending change request', () => {
  const PENDING = { data: { requests: [{ id: 3, status: 'applied' }, { id: 4, status: 'pending' }] } };
  test('shows a Change request row that opens desktop view', async () => {
    serve({ '/proposals/41/change-requests': PENDING });
    mount();
    expect(await screen.findByRole('button', { name: /^Change request/ })).toHaveTextContent(/desktop view/i);
    fireEvent.click(row('Change request'));
    expect(mockMobileView.setDesktopView).toHaveBeenLastCalledWith('proposal-detail', true);
  });
  test('keeps a booked proposal here to show it, instead of the event detail', async () => {
    serve({
      '/proposals/41': { data: { ...PROPOSAL, status: 'deposit_paid', amount_paid: '500.00' } },
      '/proposals/41/change-requests': PENDING,
    });
    mount();
    expect(await screen.findByRole('button', { name: /^Change request/ })).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/proposals\/41$/);
    expect(mockMobileView.setDesktopForVisit).not.toHaveBeenCalled();
    for (const name of ['Edit details', 'Client link', 'Resend proposal', 'Archive']) {
      expect(screen.queryByRole('button', { name: new RegExp(`^${name}`) })).not.toBeInTheDocument();
    }
  });
  test('shows no row when none is pending, when the read fails, on a stored copy, or on legal hold', async () => {
    const cases = [
      { '/proposals/41/change-requests': { data: { requests: [{ id: 3, status: 'declined' }] } } },
      { '/proposals/41/change-requests': { reject: { status: 0, message: 'Network error. Check your connection.' } } },
      { '/proposals/41': { data: PROPOSAL, staleAt: '2026-11-05T15:00:00Z' }, '/proposals/41/change-requests': PENDING },
      { '/proposals/41': { data: { ...PROPOSAL, legal_hold: true } }, '/proposals/41/change-requests': PENDING },
    ];
    for (const over of cases) {
      serve(over);
      const { unmount } = mount();
      await screen.findByText('Contacts');
      expect(screen.queryByRole('button', { name: /^Change request/ })).not.toBeInTheDocument();
      unmount();
    }
  });
});

test('a draft option in a group reads Send options on desktop view', async () => {
  serve({ '/proposals/41': { data: { ...PROPOSAL, status: 'draft', sent_at: null, group_id: 9 } } });
  mount();
  await screen.findByText('draft · never sent');
  expect(row('Send options')).toHaveTextContent(/desktop view/i);
  expect(screen.queryByRole('button', { name: /^Send proposal/ })).not.toBeInTheDocument();
});

test('an options group keeps its send on desktop view, and Archive leaves with money on the row', async () => {
  serve({ '/proposals/41': { data: { ...PROPOSAL, status: 'accepted', group_id: 9, amount_paid: '250.00', accepted_at: new Date().toISOString() } } });
  mount();
  await screen.findByText(/accepted .* · \$250\.00 paid/);
  expect(row('Resend proposal')).toHaveTextContent(/desktop view/i);
  expect(screen.queryByRole('button', { name: /^Archive/ })).not.toBeInTheDocument();
});
