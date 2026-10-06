import React from 'react';
import fs from 'fs';
import path from 'path';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet, useLocation, useNavigate } from 'react-router-dom';
import EventDetailPhone from './EventDetailPhone';
import api from '../../utils/api';
import { ctDay } from '../../components/adminos/format';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));
const mockMobileView = { isPhone: true, desktopView: jest.fn(() => false), setDesktopView: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockMobileView }));
// The sheet has its own suite; here it is a stub that exposes its props.
jest.mock('../../components/mobile/AssignmentSheet', () => ({
  __esModule: true,
  default: ({ shiftId, focusUserId, assignable, onClose, onChanged, onDead }) => (
    <div data-testid="sheet">
      <span data-testid="sheet-shift">{String(shiftId)}</span>
      <span data-testid="sheet-focus">{String(focusUserId)}</span>
      <span data-testid="sheet-assignable">{String(assignable)}</span>
      <button type="button" onClick={onClose}>stub close</button>
      <button type="button" onClick={onChanged}>stub changed</button>
      <button type="button" onClick={onDead}>stub dead</button>
    </div>
  ),
}));
// The edit and note sheets have their own suites too. Each stub also keeps the
// props it was last drawn with, for a call made after the sheet has gone (a
// save that settles after Back closed it).
const mockSheets = {};
jest.mock('../../components/mobile/EditSheet', () => ({
  __esModule: true,
  default: (props) => {
    mockSheets.edit = props;
    const { proposalId, shiftCount, onClose, onSaved } = props;
    return (
      <div data-testid="edit-sheet">
        <span data-testid="edit-id">{String(proposalId)}</span>
        <span data-testid="edit-shifts">{String(shiftCount)}</span>
        <button type="button" onClick={onClose}>stub edit close</button>
        <button type="button" onClick={onSaved}>stub edit saved</button>
      </div>
    );
  },
}));
jest.mock('../../components/mobile/NoteSheet', () => ({
  __esModule: true,
  default: (props) => {
    mockSheets.note = props;
    const { draft, onDraft, onSaved, onClose } = props;
    return (
      <div data-testid="note-sheet">
        <span data-testid="note-draft">{String(draft)}</span>
        <button type="button" onClick={() => onDraft('half written')}>stub note keep</button>
        <button type="button" onClick={() => onSaved('New note line')}>stub note saved</button>
        <button type="button" onClick={onClose}>stub note close</button>
      </div>
    );
  },
}));

const PROPOSAL = {
  id: 13, status: 'deposit_paid', client_name: 'Alexis Henderson', client_phone: '3125550184',
  client_email: 'alexis.hend@gmail.com', event_type: 'wedding-reception', event_type_custom: null,
  event_date: '2999-08-15T00:00:00.000Z', event_start_time: '18:00', event_duration_hours: '5',
  event_location: 'Grove on the River, 12 River Rd, Rockford, Illinois 61101',
  venue_street: '12 River Rd', venue_city: 'Rockford', venue_state: 'Illinois', venue_zip: '61101',
  guest_count: 140, setup_time_display: '17:15', total_price: '3650.00', amount_paid: '1900.00',
  balance_due_date: '2999-08-08', package_name: 'Signature bar',
  pricing_snapshot: { total: 3650, breakdown: [{ label: 'Signature bar', amount: 3200 }, { label: 'Mobile bar rental', amount: 450 }] },
};
const person = (id, over = {}) => ({
  request_id: id, user_id: 100 + id, name: `Person ${id}`, status: 'approved', position: 'Bartender',
  dropped_at: null, requested_positions: '["Bartender"]', home_distance_miles: 2.4, events_worked: 87, ...over,
});
const shift = (id, over = {}) => ({
  id, status: 'open', finished: false, event_date: '2999-08-15', start_time: '18:00',
  positions_needed: '["Bartender","Bartender"]', requesters: [person(1), person(2, { status: 'pending', position: null })], ...over,
});
// The day-of-contact projection, never the full drink plan.
const PLAN = { day_of_contact: { name: 'Marcus Keller', phone: '3125550142' } };
const OFFLINE_OK = { headers: { 'X-Offline-Ok': '1' } };
const INVOICES = { invoices: [{ id: 1, invoice_number: 'INV-01', label: 'Deposit', amount_due: 10000, amount_paid: 10000, status: 'paid' }], pending_payments: [] };
const NETWORK = { status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' };

// Each value is a payload, or { reject }, or { data, staleAt }. A function is called per request.
function serve(over = {}) {
  const table = {
    '/proposals/13': { data: PROPOSAL },
    '/shifts/by-proposal/13': { data: [shift(1)] },
    '/drink-plans/by-proposal/13': { data: PLAN },
    '/invoices/proposal/13': { data: INVOICES },
    ...over,
  };
  api.get.mockImplementation((url) => {
    const entry = typeof table[url] === 'function' ? table[url]() : table[url];
    if (!entry) return Promise.reject({ status: 404, message: 'Not found' });
    return entry.reject ? Promise.reject(entry.reject) : Promise.resolve(entry);
  });
}

function Shell({ ctx }) { return <Outlet context={ctx} />; }
function Probe() {
  const l = useLocation(); const n = useNavigate();
  return (
    <>
      <div data-testid="loc">{l.pathname + l.search}</div>
      {/* The history entry itself: any navigation, a replace included, changes it. */}
      <div data-testid="key">{l.key}</div>
      <button type="button" onClick={() => n(-1)}>back</button>
      <button type="button" onClick={() => n('/events/14')}>go to 14</button>
      <button type="button" onClick={() => n('/events/14?drawer=shift&drawerId=18')}>go to 14 with its sheet</button>
    </>
  );
}
function mount({ initial = '/events/13', entries } = {}) {
  const ctx = { badges: {}, refreshBadges: jest.fn(), setHeaderDetail: jest.fn() };
  const list = entries || ['/events', initial];
  const utils = render(
    <MemoryRouter initialEntries={list} initialIndex={list.length - 1}>
      <Routes>
        <Route element={<Shell ctx={ctx} />}>
          <Route path="/events/:id" element={<><EventDetailPhone /><Probe /></>} />
        </Route>
        <Route path="/events" element={<div data-testid="loc">/events</div>} />
      </Routes>
    </MemoryRouter>
  );
  return { ctx, ...utils };
}
const tap = (el) => fireEvent.click(el);
// A read the test answers by hand, to make an answer land late.
function held() {
  const box = {};
  box.entry = new Promise((resolve, reject) => { box.release = resolve; box.refuse = reject; });
  return box;
}
const section = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

test('makes its four reads and hands the chrome the rich header', async () => {
  serve();
  const { ctx } = mount();
  await screen.findByText('Person 1');
  // Every read asks for the offline fallback: this screen renders the staleness line.
  for (const url of ['/proposals/13', '/shifts/by-proposal/13', '/invoices/proposal/13']) {
    expect(api.get).toHaveBeenCalledWith(url, OFFLINE_OK);
  }
  // The drink plan is read as its projection, and only as that.
  expect(api.get).toHaveBeenCalledWith('/drink-plans/by-proposal/13', { params: { fields: 'day_of_contact' }, ...OFFLINE_OK });
  expect(api.get.mock.calls.filter((c) => c[0] === '/drink-plans/by-proposal/13' && !(c[1] && c[1].params))).toHaveLength(0);
  // The header is handed over in an effect, one tick after the rows paint.
  await waitFor(() => expect(ctx.setHeaderDetail).toHaveBeenLastCalledWith(expect.objectContaining({
    title: 'Alexis Henderson', kind: 'Wedding Reception', guests: 140,
    mapHref: expect.stringContaining('query=12%20River%20Rd'),
  })));
});

test('the header is cleared when the screen goes away', async () => {
  serve();
  const { ctx, unmount } = mount();
  await screen.findByText('Person 1');
  unmount();
  expect(ctx.setHeaderDetail).toHaveBeenLastCalledWith(null);
});

test('the when and setup lines, and Staffing open by default with the other two closed', async () => {
  serve();
  mount();
  await screen.findByText('Person 1');
  expect(screen.getByText(/· 18:00–23:00 · 5h$/)).toHaveClass('m-detail-whenline');
  expect(screen.getByText('setup from 17:15 · 45 min before')).toHaveClass('m-detail-setup');
  expect(section('Staffing')).toHaveAttribute('aria-expanded', 'true');
  expect(section('Contacts')).toHaveAttribute('aria-expanded', 'false');
  expect(section('Financials')).toHaveAttribute('aria-expanded', 'false');
  expect(within(section('Staffing')).getByText('1/2')).toBeInTheDocument();
  expect(within(section('Contacts')).getByText('day-of set')).toBeInTheDocument();
  expect(within(section('Financials')).getByText('$3,650.00')).toBeInTheDocument();
  expect(within(section('Financials')).getByText('Balance due')).toBeInTheDocument();
  expect(screen.queryByText('Client')).toBeNull();
});

test('a live read shows no staleness line; a cache-served read shows the offline copy line with the dot', async () => {
  serve();
  const first = mount();
  await screen.findByText('Person 1');
  expect(screen.queryByText(/as of/)).toBeNull();
  // The dot is decoration (aria-hidden): it has no role and no text to ask for.
  // eslint-disable-next-line testing-library/no-node-access
  expect(document.querySelector('.m-stale-dot')).toBeNull();
  first.unmount();

  serve({ '/shifts/by-proposal/13': { data: [shift(1)], staleAt: '2026-09-29T17:00:00.000Z' } });
  mount();
  await screen.findByText('Person 1');
  expect(screen.getByText(/^offline copy · as of/)).toBeInTheDocument();
  // eslint-disable-next-line testing-library/no-node-access
  expect(document.querySelector('.m-stale-dot')).not.toBeNull();
});

test('Contacts: every number and address is a tap target', async () => {
  serve();
  mount();
  await screen.findByText('Person 1');
  tap(section('Contacts'));
  expect(screen.getByRole('link', { name: '(312) 555-0184' })).toHaveAttribute('href', 'tel:3125550184');
  expect(screen.getByRole('link', { name: 'Text Alexis Henderson' })).toHaveAttribute('href', 'sms:3125550184');
  expect(screen.getByRole('link', { name: 'alexis.hend@gmail.com' })).toHaveAttribute('href', 'mailto:alexis.hend@gmail.com');
  expect(screen.getByText('Marcus Keller')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '(312) 555-0142' })).toHaveAttribute('href', 'tel:3125550142');
  expect(screen.getByRole('link', { name: 'Text Marcus Keller' })).toHaveAttribute('href', 'sms:3125550142');
});

test('an address that gets no link is drawn as text, not as a link that does nothing', async () => {
  serve({ '/proposals/13': { data: { ...PROPOSAL, client_email: 'a@b.co;c@d.co' } } });
  mount();
  await screen.findByText('Person 1');
  tap(section('Contacts'));
  expect(screen.getByText('a@b.co;c@d.co')).toHaveClass('m-contact-plain');
  expect(screen.queryByRole('link', { name: 'a@b.co;c@d.co' })).toBeNull();
  expect(screen.getByText('a@b.co;c@d.co').tagName).toBe('SPAN');
});

test('a drink-plan 404 is "no day-of contact yet", not an error', async () => {
  serve({ '/drink-plans/by-proposal/13': { reject: { status: 404, message: 'No drink plan found for this proposal.' } } });
  mount();
  await screen.findByText('Person 1');
  expect(within(section('Contacts')).getByText('day-of pending')).toBeInTheDocument();
  tap(section('Contacts'));
  expect(screen.getByText('Not received yet. Collected with the drink plan; often the client themselves.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a drink-plan read that failed says it needs a connection, and does not claim the contact is missing', async () => {
  serve({ '/drink-plans/by-proposal/13': { reject: NETWORK } });
  mount();
  await screen.findByText('Person 1');
  // The head says nothing about the day-of contact when it could not be read.
  expect(within(section('Contacts')).queryByText(/day-of/)).toBeNull();
  tap(section('Contacts'));
  expect(screen.getByText('The day-of contact needs a connection.')).toBeInTheDocument();
  expect(screen.queryByText(/Not received yet/)).toBeNull();
});

test('Financials: lines, total, payments and the balance', async () => {
  serve();
  mount();
  await screen.findByText('Person 1');
  tap(section('Financials'));
  expect(screen.getByText('Package & extras')).toBeInTheDocument();
  expect(screen.getByText('Signature bar')).toBeInTheDocument();
  expect(screen.getByText('$3,200.00')).toBeInTheDocument();
  expect(screen.getByText('Total')).toBeInTheDocument();
  expect(screen.queryByText('Updated total')).toBeNull();
  expect(screen.getByText('Payments')).toBeInTheDocument();
  expect(screen.getByText('Deposit')).toBeInTheDocument();
  expect(screen.getByText('$100.00')).toBeInTheDocument();
  expect(screen.getByText('$1,750.00')).toBeInTheDocument();
  expect(screen.getByText('due AUG 8')).toBeInTheDocument();
});

test('a bank payment in flight shows on the chip, as a row, and on the balance', async () => {
  serve({ '/invoices/proposal/13': { data: { ...INVOICES, pending_payments: [{ amount_cents: 175000, started_at: '2999-08-05T15:00:00.000Z', invoice_id: 2, invoice_number: 'INV-0363' }] } } });
  mount();
  await screen.findByText('Person 1');
  await waitFor(() => expect(within(section('Financials')).getByText('Processing')).toBeInTheDocument());
  tap(section('Financials'));
  expect(screen.getByText('Bank payment processing')).toBeInTheDocument();
  expect(screen.getByText(/^started .* · INV-0363$/)).toBeInTheDocument();
  expect(screen.getByText('due AUG 8 · bank payment in flight')).toBeInTheDocument();
  // The row is the styled element; the text sits two levels inside it.
  // eslint-disable-next-line testing-library/no-node-access
  expect(screen.getByText('due AUG 8 · bank payment in flight').closest('.m-money-row')).toHaveClass('m-money-bal', 'm-money-flight');
});

test('paid in full', async () => {
  serve({ '/proposals/13': { data: { ...PROPOSAL, status: 'balance_paid', amount_paid: '3650.00' } } });
  mount();
  await screen.findByText('Person 1');
  expect(within(section('Financials')).getByText('Paid')).toBeInTheDocument();
  tap(section('Financials'));
  expect(screen.getByText('Paid in full')).toBeInTheDocument();
  expect(screen.queryByText('Balance due')).toBeNull();
});

test('a failed invoices read says the payment detail needs a connection and still shows what was paid', async () => {
  serve({ '/invoices/proposal/13': { reject: NETWORK } });
  mount();
  await screen.findByText('Person 1');
  tap(section('Financials'));
  expect(screen.getByText('Payment detail needs a connection.')).toBeInTheDocument();
  expect(screen.getByText('Paid to date')).toBeInTheDocument();
  expect(screen.getByText('$1,900.00')).toBeInTheDocument();
  // Whether a bank debit is in flight is unknown, so nothing on screen says "due" as a verdict.
  expect(screen.queryByText('Balance due')).toBeNull();
  expect(screen.getByText('Balance')).toHaveClass('m-money-label');
  expect(screen.getByText('due AUG 8 · payment detail not loaded')).toBeInTheDocument();
});

test('money collected off-platform is a payment row, never "No payments yet."', async () => {
  serve({
    '/proposals/13': { data: { ...PROPOSAL, amount_paid: '100.00', external_paid: '100.00' } },
    '/invoices/proposal/13': { data: { invoices: [], pending_payments: [] } },
  });
  mount();
  await screen.findByText('Person 1');
  await waitFor(() => expect(within(section('Financials')).getByText('Balance due')).toBeInTheDocument());
  tap(section('Financials'));
  expect(screen.getByText('Off-platform')).toBeInTheDocument();
  expect(screen.getByText('collected in CheckCherry')).toBeInTheDocument();
  expect(screen.getByText('$100.00')).toBeInTheDocument();
  expect(screen.queryByText('No payments yet.')).toBeNull();
});

test('money that sits on no row is stated as paid to date, never as "No payments yet."', async () => {
  serve({
    '/proposals/13': { data: { ...PROPOSAL, status: 'completed', amount_paid: '3650.00' } },
    '/invoices/proposal/13': { data: { invoices: [], pending_payments: [] } },
  });
  mount();
  await screen.findByText('Person 1');
  await waitFor(() => expect(within(section('Financials')).getByText('Paid')).toBeInTheDocument());
  tap(section('Financials'));
  expect(screen.queryByText('No payments yet.')).toBeNull();
  expect(screen.getByText('Paid to date')).toBeInTheDocument();
  expect(screen.getByText('Paid in full')).toBeInTheDocument();
});

test('nothing paid says so', async () => {
  serve({
    '/proposals/13': { data: { ...PROPOSAL, amount_paid: '0.00' } },
    '/invoices/proposal/13': { data: { invoices: [], pending_payments: [] } },
  });
  mount();
  await screen.findByText('Person 1');
  await waitFor(() => expect(within(section('Financials')).getByText('Balance due')).toBeInTheDocument());
  tap(section('Financials'));
  expect(screen.getByText('No payments yet.')).toBeInTheDocument();
  expect(screen.queryByText('Paid to date')).toBeNull();
});

test('a number no phone can dial is plain text with no Text button', async () => {
  serve({ '/proposals/13': { data: { ...PROPOSAL, client_phone: '312-555-0142 ext 5' } } });
  mount();
  await screen.findByText('Person 1');
  tap(section('Contacts'));
  expect(screen.getByText('312-555-0142 ext 5')).toHaveClass('m-contact-plain');
  expect(screen.queryByRole('link', { name: '312-555-0142 ext 5' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Text Alexis Henderson' })).toBeNull();
});

test('an overpaid event says so on the chip and as a row', async () => {
  serve({ '/proposals/13': { data: { ...PROPOSAL, status: 'balance_paid', amount_paid: '3700.00', overpayment_cents: 5000, max_overpayment_refundable_cents: 5000 } } });
  mount();
  await screen.findByText('Person 1');
  await waitFor(() => expect(within(section('Financials')).getByText('Overpaid')).toBeInTheDocument());
  tap(section('Financials'));
  expect(screen.getByText('refund it from desktop view')).toBeInTheDocument();
  expect(screen.getByText('$50.00')).toBeInTheDocument();
  // Overpaid says it all: not "Paid in full" beside it.
  expect(screen.queryByText('Paid in full')).toBeNull();
  expect(screen.queryByText('Balance due')).toBeNull();
});

test('a cancelled event shows its money and claims no balance due', async () => {
  serve({ '/proposals/13': { data: { ...PROPOSAL, status: 'archived' } } });
  mount();
  await screen.findByText('Person 1');
  expect(within(section('Financials')).getByText('Cancelled')).toBeInTheDocument();
  tap(section('Financials'));
  expect(screen.getByText('Deposit')).toBeInTheDocument();
  expect(screen.queryByText('Balance due')).toBeNull();
  expect(screen.queryByText(/^due /)).toBeNull();
});

test('a staffing row opens the sheet on that person and pushes one history entry', async () => {
  serve();
  mount();
  tap(await screen.findByRole('button', { name: /Person 2/ }));
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/events/13?drawer=shift&drawerId=1&drawerFocus=102'));
  expect(screen.getByTestId('sheet-shift')).toHaveTextContent('1');
  expect(screen.getByTestId('sheet-focus')).toHaveTextContent('102');
  tap(screen.getByRole('button', { name: 'back' }));
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/));
  expect(screen.queryByTestId('sheet')).toBeNull();
});

test('"Assign staff · 1 open" opens the sheet with nobody focused', async () => {
  serve();
  mount();
  tap(await screen.findByRole('button', { name: 'Assign staff · 1 open' }));
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/events/13?drawer=shift&drawerId=1'));
  expect(screen.getByTestId('sheet-focus')).toHaveTextContent('null');
});

// The app keys this page by event id, so this cannot happen there. The page
// holds the rule itself all the same: a roster is judged only for the event it
// was read for.
test('a sheet link for the NEXT event is not judged against the previous event\'s roster', async () => {
  const next = held();
  serve({
    '/proposals/14': { data: { ...PROPOSAL, id: 14, client_name: 'June Marrow' } },
    '/shifts/by-proposal/14': () => next.entry,
    '/drink-plans/by-proposal/14': { reject: { status: 404, message: 'none' } },
    '/invoices/proposal/14': { data: { invoices: [], pending_payments: [] } },
  });
  mount();
  await screen.findByText('Person 1');
  tap(screen.getByRole('button', { name: 'go to 14 with its sheet' }));
  expect(await screen.findByText('Loading the roster')).toBeInTheDocument();
  // Shift 18 is not on event 13's roster, and that is not the question.
  expect(screen.getByTestId('loc')).toHaveTextContent('/events/14?drawer=shift&drawerId=18');
  await act(async () => { next.release({ data: [shift(18)] }); });
  expect(screen.getByTestId('sheet-shift')).toHaveTextContent('18');
  expect(screen.getByTestId('loc')).toHaveTextContent('/events/14?drawer=shift&drawerId=18');
});

test('the sheet is told whether its shift can take an assignment', async () => {
  // One slot open: it can.
  serve();
  const first = mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  expect(await screen.findByTestId('sheet-assignable')).toHaveTextContent('true');
  first.unmount();
  // Full, finished, no declared roles, cancelled: it cannot.
  for (const over of [
    { requesters: [person(1), person(2)] },
    { finished: true },
    { positions_needed: '[]', requesters: [] },
    { status: 'cancelled' },
  ]) {
    serve({ '/shifts/by-proposal/13': { data: [shift(1, over)] } });
    const view = mount({ initial: '/events/13?drawer=shift&drawerId=1' });
    expect(await screen.findByTestId('sheet-assignable')).toHaveTextContent('false');
    view.unmount();
  }
});

test('applicant and waitlisted rows carry their chips and their meta', async () => {
  serve({ '/shifts/by-proposal/13': { data: [shift(1, { positions_needed: '["Bartender"]', requesters: [
    person(1), person(2, { status: 'pending', position: null, events_worked: 14, home_distance_miles: null }),
  ] })] } });
  mount();
  const waiting = await screen.findByRole('button', { name: /Person 2/ });
  expect(within(waiting).getByText('Waitlisted')).toBeInTheDocument();
  expect(within(waiting).getByText('Bartender · 14 events')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Assign staff/ })).toBeNull();
});

test('two shifts get a head each; one shift gets none', async () => {
  serve({ '/shifts/by-proposal/13': { data: [
    shift(1, { start_time: '16:00' }),
    shift(2, { start_time: '17:00', positions_needed: '["Banquet Server"]', requesters: [] }),
  ] } });
  mount();
  expect(await screen.findByText('16:00 · Bartenders')).toHaveClass('m-shift-label');
  expect(screen.getByText('17:00 · Banquet Servers')).toBeInTheDocument();
  // One "Assign staff" row per shift, each opening its own sheet.
  const rows = screen.getAllByRole('button', { name: 'Assign staff · 1 open' });
  expect(rows).toHaveLength(2);
  tap(rows[1]);
  await waitFor(() => expect(screen.getByTestId('sheet-shift')).toHaveTextContent('2'));
});

test('after the sheet changes something the staffing card and the tab badge refresh', async () => {
  let reads = 0;
  serve({ '/shifts/by-proposal/13': () => { reads += 1; return { data: [shift(1, reads > 1 ? { requesters: [person(1), person(2)] } : {})] }; } });
  const { ctx } = mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  await screen.findByText('Person 1');
  expect(within(section('Staffing')).getByText('1/2')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'stub changed' }));
  await waitFor(() => expect(within(section('Staffing')).getByText('2/2')).toBeInTheDocument());
  expect(ctx.refreshBadges).toHaveBeenCalledTimes(1);
});

test('a dead sheet closes itself and stays on the event', async () => {
  serve();
  mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  await screen.findByText('Person 1');
  tap(screen.getByRole('button', { name: 'stub dead' }));
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/));
  expect(screen.queryByTestId('sheet')).toBeNull();
});

test('a sheet link for a shift of ANOTHER event opens nothing and drops the parameter', async () => {
  serve();
  mount({ initial: '/events/13?drawer=shift&drawerId=999' });
  await screen.findByText('Person 1');
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/));
  expect(screen.queryByTestId('sheet')).toBeNull();
  // One Back from here leaves the event: the parameter left no entry behind.
  tap(screen.getByRole('button', { name: 'back' }));
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events$/));
});

test('the sheet waits for the roster, and opens once its shift is on it', async () => {
  const first = held();
  serve({ '/shifts/by-proposal/13': () => first.entry });
  mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  expect(await screen.findByText('Loading the roster')).toBeInTheDocument();
  expect(screen.queryByTestId('sheet')).toBeNull();
  expect(screen.getByTestId('loc')).toHaveTextContent('/events/13?drawer=shift&drawerId=1');
  await act(async () => { first.release({ data: [shift(1)] }); });
  expect(screen.getByTestId('sheet-shift')).toHaveTextContent('1');
});

test('a roster read that failed keeps the sheet link for the Retry', async () => {
  let reads = 0;
  serve({ '/shifts/by-proposal/13': () => { reads += 1; return reads === 1 ? { reject: NETWORK } : { data: [shift(1)] }; } });
  mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  expect(await screen.findByText("Couldn't load staffing.")).toBeInTheDocument();
  expect(screen.queryByTestId('sheet')).toBeNull();
  expect(screen.getByTestId('loc')).toHaveTextContent('/events/13?drawer=shift&drawerId=1');
  tap(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByTestId('sheet-shift')).toHaveTextContent('1');
});

test('a user with no staffing access gets no sheet, and the link is dropped', async () => {
  serve({ '/shifts/by-proposal/13': { reject: { status: 403, message: 'Staffing access required.' } } });
  mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  expect(await screen.findByText('Staffing needs staffing access.')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/));
  expect(screen.queryByTestId('sheet')).toBeNull();
});

test('an id that is not a number is a dead route: nothing is fetched and no Retry is offered', async () => {
  const heard = jest.fn();
  window.addEventListener('mobile-route-dead', heard);
  serve();
  mount({ entries: ['/events/abc'] });
  await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
  expect(api.get).not.toHaveBeenCalled();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('Loading the event')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  window.removeEventListener('mobile-route-dead', heard);
});

// The chrome listens for mobile-route-dead and leaves. When nobody is
// listening (here; in the app, while a suspended boundary hides the chrome)
// the screen must not be blank.
test('a dead route nobody heard still offers a way back to the list', async () => {
  serve({ '/proposals/13': { reject: { status: 404, message: 'nope' } } });
  mount({ entries: ['/events/13'] });
  expect(await screen.findByText("This event isn't available")).toBeInTheDocument();
  expect(screen.getByText('It may have been removed, or your access may have changed.')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Back to Events' }));
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events$/));
});

test('a dead event is forgotten when the screen moves to a live one', async () => {
  serve({
    '/proposals/13': { reject: { status: 404, message: 'nope' } },
    '/proposals/14': { data: { ...PROPOSAL, id: 14, client_name: 'June Marrow' } },
    '/shifts/by-proposal/14': { data: [shift(1)] },
    '/drink-plans/by-proposal/14': { reject: { status: 404, message: 'none' } },
    '/invoices/proposal/14': { data: { invoices: [], pending_payments: [] } },
  });
  mount();
  expect(await screen.findByText("This event isn't available")).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'go to 14' }));
  expect(await screen.findByText('Person 1')).toBeInTheDocument();
  expect(screen.queryByText("This event isn't available")).toBeNull();
});

test('a drawerId that is not a number mounts no sheet', async () => {
  serve();
  mount({ initial: '/events/13?drawer=shift&drawerId=abc' });
  await screen.findByText('Person 1');
  expect(screen.queryByTestId('sheet')).toBeNull();
});

test('a proposal that is gone or denied dispatches mobile-route-dead and renders no error screen', async () => {
  for (const status of [404, 403]) {
    const heard = jest.fn();
    window.addEventListener('mobile-route-dead', heard);
    serve({ '/proposals/13': { reject: { status, message: 'nope' } } });
    const { unmount } = mount();
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
    window.removeEventListener('mobile-route-dead', heard);
    unmount();
  }
});

test('a manager without staffing access gets the event without its roster, not thrown back to the list', async () => {
  const heard = jest.fn();
  window.addEventListener('mobile-route-dead', heard);
  serve({ '/shifts/by-proposal/13': { reject: { status: 403, message: 'Staffing access required.' } } });
  mount();
  expect(await screen.findByText('Staffing needs staffing access.')).toBeInTheDocument();
  expect(screen.getByText('setup from 17:15 · 45 min before')).toBeInTheDocument();
  expect(heard).not.toHaveBeenCalled();
  window.removeEventListener('mobile-route-dead', heard);
});

test('the staffing Retry shows that it is reading, touches no badge, and says so when access is refused', async () => {
  const retry = held();
  let reads = 0;
  serve({ '/shifts/by-proposal/13': () => { reads += 1; return reads === 1 ? { reject: NETWORK } : retry.entry; } });
  const { ctx } = mount();
  expect(await screen.findByText("Couldn't load staffing.")).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Retry' }));
  expect(screen.getByText('Loading the roster')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  await act(async () => { retry.refuse({ status: 403, message: 'Staffing access required.' }); });
  expect(screen.getByText('Staffing needs staffing access.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  expect(ctx.refreshBadges).not.toHaveBeenCalled();
});

test('a failed staffing read offers Retry and recovers without reloading the event', async () => {
  let reads = 0;
  serve({ '/shifts/by-proposal/13': () => { reads += 1; return reads === 1 ? { reject: NETWORK } : { data: [shift(1)] }; } });
  mount();
  expect(await screen.findByText("Couldn't load staffing.")).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Person 1')).toBeInTheDocument();
  expect(api.get.mock.calls.filter((c) => c[0] === '/proposals/13')).toHaveLength(1);
});

test('an event with no shifts says so', async () => {
  serve({ '/shifts/by-proposal/13': { data: [] } });
  mount();
  expect(await screen.findByText('No shifts created for this event yet.')).toBeInTheDocument();
});

test('a lost connection with nothing cached shows the error with Retry, and recovers', async () => {
  let reads = 0;
  serve({ '/proposals/13': () => { reads += 1; return reads === 1 ? { reject: NETWORK } : { data: PROPOSAL }; } });
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this event");
  expect(screen.getByRole('alert')).toHaveTextContent('Network error. Check your connection.');
  tap(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Person 1')).toBeInTheDocument();
});

test('on a cache-served read Edit details needs a connection and does nothing', async () => {
  serve({ '/proposals/13': { data: PROPOSAL, staleAt: '2026-09-29T17:00:00.000Z' } });
  mount();
  await screen.findByText('Person 1');
  const edit = screen.getByRole('button', { name: /^Edit details/ });
  expect(within(edit).getByText('needs connection')).toBeInTheDocument();
  expect(edit).toBeDisabled();
  tap(edit);
  expect(mockMobileView.setDesktopView).not.toHaveBeenCalled();
});

test('an archived event that was never cancelled says Archived, on the when line and on the money', async () => {
  serve({ '/proposals/13': { data: { ...PROPOSAL, status: 'archived', archive_reason: 'event_passed' } } });
  mount();
  await screen.findByText('Person 1');
  expect(within(screen.getByText(/· 18:00–23:00 · 5h$/)).getByText('Archived')).toBeInTheDocument();
  expect(within(section('Financials')).getByText('Archived')).toBeInTheDocument();
  expect(screen.queryByText('Cancelled')).toBeNull();
  expect(screen.queryByRole('button', { name: /^Edit details/ })).toBeNull();
});

test('a cancelled event: the chip says so, the roster offers nothing, Edit is absent', async () => {
  serve({
    '/proposals/13': { data: { ...PROPOSAL, status: 'archived' } },
    '/shifts/by-proposal/13': { data: [shift(1, { status: 'cancelled' })] },
  });
  mount();
  await screen.findByText('Person 1');
  expect(within(screen.getByText(/· 18:00–23:00 · 5h$/)).getByText('Cancelled')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Assign staff/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Edit details/ })).toBeNull();
  expect(screen.queryByText('Today')).toBeNull();
});

test('an event today says Today; a cancelled one today does not', async () => {
  const today = ctDay(new Date());
  serve({ '/proposals/13': { data: { ...PROPOSAL, event_date: today } } });
  const first = mount();
  await screen.findByText('Person 1');
  expect(screen.getByText('Today')).toBeInTheDocument();
  first.unmount();
  serve({ '/proposals/13': { data: { ...PROPOSAL, event_date: today, status: 'archived' } } });
  mount();
  await screen.findByText('Person 1');
  expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);
  expect(screen.queryByText('Today')).toBeNull();
});

// The desktop's no-tip-jar badge, on the day-of device (Dallas, 2026-09-30).
// The last-minute staffing badge stays desktop only.
test('a client who paid to skip the tip jar shows No tip jar, unless the event is cancelled', async () => {
  serve({ '/proposals/13': { data: { ...PROPOSAL, tip_jar: false, last_minute_hold: true } } });
  const first = mount();
  await screen.findByText('Person 1');
  expect(screen.getByText('No tip jar')).toBeInTheDocument();
  expect(screen.queryByText(/verify staffing/i)).toBeNull();
  first.unmount();
  serve({ '/proposals/13': { data: { ...PROPOSAL, tip_jar: false, status: 'archived' } } });
  const second = mount();
  await screen.findByText('Person 1');
  expect(screen.queryByText('No tip jar')).toBeNull();
  second.unmount();
  serve({ '/proposals/13': { data: { ...PROPOSAL, tip_jar: true } } });
  mount();
  await screen.findByText('Person 1');
  expect(screen.queryByText('No tip jar')).toBeNull();
});

test('changing the event id reloads and never shows the previous event', async () => {
  serve({ '/proposals/14': { data: { ...PROPOSAL, id: 14, client_name: 'June Marrow' } }, '/shifts/by-proposal/14': { data: [] },
    '/drink-plans/by-proposal/14': { reject: { status: 404, message: 'none' } }, '/invoices/proposal/14': { data: { invoices: [], pending_payments: [] } } });
  const { ctx } = mount();
  await screen.findByText('Person 1');
  tap(screen.getByRole('button', { name: 'go to 14' }));
  // The previous event leaves the screen at once, before the new one lands:
  // its roster, and everything read off its proposal.
  expect(screen.queryByText('Person 1')).toBeNull();
  expect(screen.queryByText('setup from 17:15 · 45 min before')).toBeNull();
  expect(screen.getByText('Loading the event')).toBeInTheDocument();
  expect(await screen.findByText('No shifts created for this event yet.')).toBeInTheDocument();
  await waitFor(() => expect(ctx.setHeaderDetail).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'June Marrow' })));
  expect(screen.getByText('setup from 17:15 · 45 min before')).toBeInTheDocument();
});

test('a reload of the staffing card that lands after the screen moved to another event is dropped', async () => {
  let release;
  let reads13 = 0;
  serve({
    '/shifts/by-proposal/13': () => {
      reads13 += 1;
      if (reads13 === 1) return { data: [shift(1)] };
      return { then: (resolve) => { release = () => resolve({ data: [shift(1, { requesters: [person(9, { name: 'Late Arrival' })] })] }); } };
    },
    '/proposals/14': { data: { ...PROPOSAL, id: 14, client_name: 'June Marrow' } },
    '/shifts/by-proposal/14': { data: [] },
    '/drink-plans/by-proposal/14': { reject: { status: 404, message: 'none' } },
    '/invoices/proposal/14': { data: { invoices: [], pending_payments: [] } },
  });
  mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  await screen.findByText('Person 1');
  tap(screen.getByRole('button', { name: 'stub changed' }));   // starts the slow reload for 13
  tap(screen.getByRole('button', { name: 'go to 14' }));
  expect(await screen.findByText('No shifts created for this event yet.')).toBeInTheDocument();
  await waitFor(() => expect(typeof release).toBe('function'));
  // Inside act, so the late answer has rendered (or been dropped) before the
  // assertion runs. Without it the check ran before the answer landed and
  // passed with the guard deleted.
  await act(async () => { release(); });
  expect(api.get.mock.calls.filter((c) => c[0] === '/shifts/by-proposal/13')).toHaveLength(2);
  expect(screen.queryByText('Late Arrival')).toBeNull();
  expect(screen.getByText('No shifts created for this event yet.')).toBeInTheDocument();
});

test('answers for the previous event that land late never reach the next event', async () => {
  const proposal13 = held();
  const money13 = held();
  const plan13 = held();
  const shifts13 = held();
  serve({
    '/proposals/13': proposal13.entry,
    '/invoices/proposal/13': money13.entry,
    '/drink-plans/by-proposal/13': plan13.entry,
    '/shifts/by-proposal/13': shifts13.entry,
    '/proposals/14': { data: { ...PROPOSAL, id: 14, client_name: 'June Marrow', total_price: '900.00', amount_paid: '900.00', status: 'balance_paid' } },
    '/shifts/by-proposal/14': { data: [] },
    '/drink-plans/by-proposal/14': { reject: { status: 404, message: 'none' } },
    '/invoices/proposal/14': { data: { invoices: [], pending_payments: [] } },
  });
  const { ctx } = mount();
  expect(screen.getByText('Loading the event')).toBeInTheDocument();
  // All four of 13's reads are out before the screen moves, or releasing them proves nothing.
  for (const url of ['/proposals/13', '/shifts/by-proposal/13', '/drink-plans/by-proposal/13', '/invoices/proposal/13']) {
    expect(api.get.mock.calls.filter((c) => c[0] === url)).toHaveLength(1);
  }
  tap(screen.getByRole('button', { name: 'go to 14' }));
  expect(await screen.findByText('No shifts created for this event yet.')).toBeInTheDocument();
  await act(async () => {
    proposal13.release({ data: PROPOSAL });
    shifts13.release({ data: [shift(1)] });
    plan13.release({ data: PLAN });
    money13.release({ data: { ...INVOICES, pending_payments: [{ amount_cents: 175000, started_at: '2999-08-05T15:00:00.000Z', invoice_id: 2, invoice_number: 'INV-0363' }] } });
  });
  // Nothing of 13: not its roster, not its header, not its day-of contact, not its money.
  expect(screen.queryByText('Person 1')).toBeNull();
  // The header is handed over in an effect, one tick after the rows paint.
  await waitFor(() => expect(ctx.setHeaderDetail).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'June Marrow' })));
  expect(ctx.setHeaderDetail).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Alexis Henderson' }));
  expect(within(section('Contacts')).getByText('day-of pending')).toBeInTheDocument();
  expect(within(section('Financials')).getByText('Paid')).toBeInTheDocument();
  expect(within(section('Financials')).queryByText('Processing')).toBeNull();
  expect(within(section('Financials')).getByText('$900.00')).toBeInTheDocument();
});

test('failures for the previous event that land late change nothing, and never declare the route dead', async () => {
  const heard = jest.fn();
  window.addEventListener('mobile-route-dead', heard);
  const proposal13 = held();
  const money13 = held();
  const plan13 = held();
  const shifts13 = held();
  serve({
    '/proposals/13': proposal13.entry,
    '/invoices/proposal/13': money13.entry,
    '/drink-plans/by-proposal/13': plan13.entry,
    '/shifts/by-proposal/13': shifts13.entry,
    '/proposals/14': { data: { ...PROPOSAL, id: 14, client_name: 'June Marrow', total_price: '900.00', amount_paid: '900.00', status: 'balance_paid' } },
    '/shifts/by-proposal/14': { data: [shift(2, { requesters: [person(7, { name: 'On Fourteen' })] })] },
    '/drink-plans/by-proposal/14': { data: PLAN },
    '/invoices/proposal/14': { data: INVOICES },
  });
  mount();
  for (const url of ['/proposals/13', '/shifts/by-proposal/13', '/drink-plans/by-proposal/13', '/invoices/proposal/13']) {
    expect(api.get.mock.calls.filter((c) => c[0] === url)).toHaveLength(1);
  }
  tap(screen.getByRole('button', { name: 'go to 14' }));
  expect(await screen.findByText('On Fourteen')).toBeInTheDocument();
  await act(async () => {
    proposal13.refuse({ status: 404, message: 'Proposal not found.' });
    shifts13.refuse({ status: 403, message: 'Staffing access required.' });
    plan13.refuse(NETWORK);
    money13.refuse(NETWORK);
  });
  // Still on 14, whole: not thrown to the list, its roster, its contact and its money intact.
  expect(heard).not.toHaveBeenCalled();
  expect(screen.getByTestId('loc')).toHaveTextContent('/events/14');
  expect(screen.getByText('On Fourteen')).toBeInTheDocument();
  expect(screen.queryByText('Staffing needs staffing access.')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(within(section('Contacts')).getByText('day-of set')).toBeInTheDocument();
  expect(within(section('Financials')).getByText('Paid')).toBeInTheDocument();
  tap(section('Financials'));
  expect(screen.getByText('Deposit')).toBeInTheDocument();
  expect(screen.queryByText('Payment detail needs a connection.')).toBeNull();
  window.removeEventListener('mobile-route-dead', heard);
});

test('an answer for the previous event that lands while the next is still loading changes nothing', async () => {
  const proposal13 = held();
  const shifts13 = held();
  const proposal14 = held();
  const shifts14 = held();
  serve({
    '/proposals/13': proposal13.entry,
    '/shifts/by-proposal/13': shifts13.entry,
    // Never answered: this test is about the proposal and the roster.
    '/drink-plans/by-proposal/13': held().entry,
    '/invoices/proposal/13': held().entry,
    '/proposals/14': proposal14.entry,
    '/shifts/by-proposal/14': shifts14.entry,
    '/drink-plans/by-proposal/14': { reject: { status: 404, message: 'none' } },
    '/invoices/proposal/14': { data: { invoices: [], pending_payments: [] } },
  });
  mount();
  expect(api.get.mock.calls.filter((c) => c[0] === '/proposals/13')).toHaveLength(1);
  await act(async () => { tap(screen.getByRole('button', { name: 'go to 14' })); });
  expect(api.get.mock.calls.filter((c) => c[0] === '/proposals/14')).toHaveLength(1);
  // 13's proposal lands first. 14 is still loading, and says so.
  await act(async () => { proposal13.release({ data: PROPOSAL }); });
  expect(screen.getByText('Loading the event')).toBeInTheDocument();
  expect(screen.queryByText('setup from 17:15 · 45 min before')).toBeNull();
  await act(async () => { proposal14.release({ data: { ...PROPOSAL, id: 14, client_name: 'June Marrow' } }); });
  expect(screen.getByText('Loading the roster')).toBeInTheDocument();
  // 13's roster lands before 14's has: it is not 14's roster.
  await act(async () => { shifts13.release({ data: [shift(1)] }); });
  expect(screen.queryByText('Person 1')).toBeNull();
  expect(screen.getByText('Loading the roster')).toBeInTheDocument();
  await act(async () => { shifts14.release({ data: [shift(2, { requesters: [person(7, { name: 'On Fourteen' })] })] }); });
  expect(screen.getByText('On Fourteen')).toBeInTheDocument();
});

const STAMP = '2026-09-29T17:00:00.000Z';

test('a reload that fails while a fresh read is out leaves the loading line to that read', async () => {
  const reload = held();
  const again = held();
  let reads = 0;
  serve({ '/shifts/by-proposal/13': () => {
    reads += 1;
    if (reads <= 2) return { data: [shift(1)], staleAt: STAMP };   // the first read, and the reload after a save
    return reads === 3 ? reload.entry : again.entry;
  } });
  mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  await screen.findByText('Person 1');
  tap(screen.getByRole('button', { name: 'stub changed' }));
  expect(await screen.findByText(/may be out of date/)).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'stub close' }));
  tap(screen.getByRole('button', { name: 'Retry' }));              // read 3, not fresh
  await waitFor(() => expect(reads).toBe(3));
  tap(screen.getByRole('button', { name: 'Refresh' }));            // read 4, fresh
  expect(await screen.findByText('Loading the roster')).toBeInTheDocument();
  await act(async () => { reload.refuse(NETWORK); });
  expect(screen.getByText('Loading the roster')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => { again.release({ data: [shift(1)] }); });
  expect(screen.getByText('Person 1')).toBeInTheDocument();
  expect(screen.queryByText('Loading the roster')).toBeNull();
});

test('the reload after a save refuses the stored copy: the roster stays and says it may be behind', async () => {
  let reads = 0;
  serve({ '/shifts/by-proposal/13': () => {
    reads += 1;
    if (reads === 1) return { data: [shift(1)] };
    if (reads === 2) return { data: [shift(1, { requesters: [person(1, { name: 'Stored Before The Save' })] })], staleAt: STAMP };
    return { data: [shift(1, { requesters: [person(1), person(2)] })] };
  } });
  mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  await screen.findByText('Person 1');
  tap(screen.getByRole('button', { name: 'stub changed' }));
  expect(await screen.findByText("Couldn't refresh staffing. The roster below may be out of date.")).toBeInTheDocument();
  expect(screen.queryByText('Stored Before The Save')).toBeNull();
  // The page is not marked as an offline copy by an answer it refused.
  expect(screen.queryByText(/offline copy/)).toBeNull();
  tap(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(within(section('Staffing')).getByText('2/2')).toBeInTheDocument());
  expect(screen.queryByText(/may be out of date/)).toBeNull();
});

test('Retry on the notice keeps the roster on screen and shows that it is reading', async () => {
  const reload = held();
  const retry = held();
  let reads = 0;
  serve({ '/shifts/by-proposal/13': () => { reads += 1; if (reads === 1) return { data: [shift(1)] }; return reads === 2 ? reload.entry : retry.entry; } });
  mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  await screen.findByText('Person 1');
  tap(screen.getByRole('button', { name: 'stub changed' }));
  await waitFor(() => expect(reads).toBe(2));
  await act(async () => { reload.refuse(NETWORK); });
  tap(screen.getByRole('button', { name: 'Retry' }));
  expect(screen.getByRole('button', { name: 'Retrying' })).toBeDisabled();
  expect(screen.getByText('Person 1')).toBeInTheDocument();
  expect(screen.queryByText('Loading the roster')).toBeNull();
  await act(async () => { retry.refuse(NETWORK); });
  expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  expect(screen.getByText('Person 1')).toBeInTheDocument();
});

test('an offline copy offers Refresh, which reads the event again; a live one offers none', async () => {
  let reads = 0;
  serve({ '/proposals/13': () => { reads += 1; return reads === 1 ? { data: PROPOSAL, staleAt: STAMP } : { data: { ...PROPOSAL, guest_count: 150 } }; } });
  const { ctx } = mount();
  await screen.findByText('Person 1');
  expect(screen.getByText(/^offline copy · as of/)).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.queryByText(/offline copy/)).toBeNull());
  expect(screen.queryByText(/as of/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  expect(reads).toBe(2);
  await waitFor(() => expect(ctx.setHeaderDetail).toHaveBeenLastCalledWith(expect.objectContaining({ guests: 150 })));
  // Again once the live read has landed: the gap before it proves nothing.
  expect(screen.queryByText(/as of/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
});

test('an older reload that succeeded is kept when a newer one fails', async () => {
  const older = held();
  const newest = held();
  let reads = 0;
  serve({ '/shifts/by-proposal/13': () => { reads += 1; if (reads === 1) return { data: [shift(1)] }; return reads === 2 ? older.entry : newest.entry; } });
  mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  await screen.findByText('Person 1');
  tap(screen.getByRole('button', { name: 'stub changed' }));
  tap(screen.getByRole('button', { name: 'stub changed' }));
  await waitFor(() => expect(reads).toBe(3));
  await act(async () => { newest.refuse(NETWORK); });
  expect(screen.getByText("Couldn't refresh staffing. The roster below may be out of date.")).toBeInTheDocument();
  await act(async () => { older.release({ data: [shift(1, { requesters: [person(1), person(2, { name: 'After Write One' })] })] }); });
  expect(screen.getByText('After Write One')).toBeInTheDocument();
  // It is newer than what was on screen, so it shows. It was asked for BEFORE
  // the second save, so it can still be behind, and the notice stays.
  expect(screen.getByText("Couldn't refresh staffing. The roster below may be out of date.")).toBeInTheDocument();
});

test('a roster read that lands live clears the offline line a cached one set', async () => {
  let reads = 0;
  serve({ '/shifts/by-proposal/13': () => { reads += 1; return reads === 1 ? { data: [shift(1)], staleAt: '2026-09-29T17:00:00.000Z' } : { data: [shift(1)] }; } });
  mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  await screen.findByText('Person 1');
  expect(screen.getByText(/offline copy/)).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'stub changed' }));
  await waitFor(() => expect(screen.queryByText(/offline copy/)).toBeNull());
  expect(screen.queryByText(/as of/)).toBeNull();
});

test('roster reloads are applied in the order they were asked for, not the order they land', async () => {
  const slow = held();
  let reads = 0;
  serve({
    '/shifts/by-proposal/13': () => {
      reads += 1;
      if (reads === 1) return { data: [shift(1)] };
      if (reads === 2) return slow.entry;                       // asked first, lands last
      return { data: [shift(1, { requesters: [person(1), person(2, { name: 'Newest Hire' })] })] };
    },
  });
  mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  await screen.findByText('Person 1');
  tap(screen.getByRole('button', { name: 'stub changed' }));
  tap(screen.getByRole('button', { name: 'stub changed' }));
  expect(await screen.findByText('Newest Hire')).toBeInTheDocument();
  await act(async () => { slow.release({ data: [shift(1, { requesters: [person(1), person(3, { name: 'Stale Answer' })] })] }); });
  expect(screen.getByText('Newest Hire')).toBeInTheDocument();
  expect(screen.queryByText('Stale Answer')).toBeNull();
});

test('a roster reload that fails keeps the roster already on screen', async () => {
  const reload = held();
  let reads = 0;
  serve({ '/shifts/by-proposal/13': () => {
    reads += 1;
    if (reads === 1) return { data: [shift(1)] };
    return reads === 2 ? reload.entry : { data: [shift(1, { requesters: [person(1, { name: 'Back Again' })] })] };
  } });
  mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  await screen.findByText('Person 1');
  tap(screen.getByRole('button', { name: 'stub changed' }));
  await waitFor(() => expect(reads).toBe(2));
  await act(async () => { reload.refuse(NETWORK); });
  expect(screen.getByText('Person 1')).toBeInTheDocument();
  expect(screen.queryByText("Couldn't load staffing.")).toBeNull();
  // It stays, and says it may be behind; Retry reads again and the notice goes.
  expect(screen.getByText("Couldn't refresh staffing. The roster below may be out of date.")).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Back Again')).toBeInTheDocument();
  expect(screen.queryByText(/may be out of date/)).toBeNull();
  expect(reads).toBe(3);
});

test('an all-digit id the database cannot hold is a dead route too', async () => {
  const heard = jest.fn();
  window.addEventListener('mobile-route-dead', heard);
  for (const path of ['/events/99999999999', '/events/2147483648', '/events/0']) {
    const view = render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Shell ctx={{ badges: {}, refreshBadges: jest.fn(), setHeaderDetail: jest.fn() }} />}>
            <Route path="/events/:id" element={<EventDetailPhone />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    view.unmount();
  }
  expect(heard).toHaveBeenCalledTimes(3);
  expect(api.get).not.toHaveBeenCalled();
  window.removeEventListener('mobile-route-dead', heard);
});

test('a shift with no declared roles shows the note on the card instead of an Assign row', async () => {
  serve({ '/shifts/by-proposal/13': { data: [shift(1, { positions_needed: '[]', requesters: [] })] } });
  mount();
  expect(await screen.findByText('No roles are declared on this shift. Staff it from desktop view.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Assign staff/ })).toBeNull();
});

test('an upcoming event: Edit details reads date · time · guests and opens the edit sheet', async () => {
  serve();
  mount();
  await screen.findByText('Person 1');
  const row = screen.getByRole('button', { name: /^Edit details/ });
  expect(row).toHaveTextContent('date · time · guests');
  tap(row);
  expect(await screen.findByTestId('edit-sheet')).toBeInTheDocument();
  expect(screen.getByTestId('edit-id')).toHaveTextContent('13');
  expect(screen.getByTestId('edit-shifts')).toHaveTextContent('1');
  expect(screen.getByTestId('loc')).toHaveTextContent('/events/13?drawer=edit&drawerId=13');
  expect(mockMobileView.setDesktopView).not.toHaveBeenCalled();
});

test('a past event keeps desktop view', async () => {
  serve({ '/shifts/by-proposal/13': { data: [shift(1, { finished: true })] } });
  mount();
  await screen.findByText('Person 1');
  const row = screen.getByRole('button', { name: /^Edit details/ });
  expect(row).toHaveTextContent('desktop view');
  tap(row);
  expect(mockMobileView.setDesktopView).toHaveBeenCalledWith('event-detail', true);
  expect(screen.queryByTestId('edit-sheet')).toBeNull();
});

test('a stored copy: both rows read needs connection and open nothing', async () => {
  serve({ '/proposals/13': { data: PROPOSAL, staleAt: '2026-10-05T12:00:00.000Z' } });
  mount();
  await screen.findByText('Person 1');
  const edit = screen.getByRole('button', { name: /^Edit details/ });
  const note = screen.getByRole('button', { name: /^Note/ });
  expect(edit).toBeDisabled();
  expect(note).toBeDisabled();
  expect(edit).toHaveTextContent('needs connection');
  expect(note).toHaveTextContent('needs connection');
});

test('the Note row shows the first line or Add a note, and opens on a cancelled event too', async () => {
  serve({ '/proposals/13': { data: { ...PROPOSAL, status: 'archived', archive_reason: 'client_cancelled', admin_notes: '\nGate code 4412\nmore' } } });
  mount();
  await screen.findByText('Person 1');
  expect(screen.queryByRole('button', { name: /^Edit details/ })).toBeNull();
  const note = screen.getByRole('button', { name: /^Note/ });
  expect(note).toHaveTextContent('Gate code 4412');
  tap(note);
  expect(await screen.findByTestId('note-sheet')).toBeInTheDocument();
});

test('a note draft is kept between openings, and a save shows the new first line', async () => {
  serve();
  mount();
  await screen.findByText('Person 1');
  expect(screen.getByRole('button', { name: /^Note/ })).toHaveTextContent('Add a note');
  tap(screen.getByRole('button', { name: /^Note/ }));
  tap(await screen.findByText('stub note keep'));
  tap(screen.getByText('stub note close'));
  await waitFor(() => expect(screen.queryByTestId('note-sheet')).toBeNull());
  tap(screen.getByRole('button', { name: /^Note/ }));
  expect(await screen.findByTestId('note-draft')).toHaveTextContent('half written');
  tap(screen.getByText('stub note saved'));
  await waitFor(() => expect(screen.getByRole('button', { name: /^Note/ })).toHaveTextContent('New note line'));
});

test('after an edit save the sheet closes and the detail re-reads fresh, never a stored copy', async () => {
  let reads = 0;
  serve({ '/proposals/13': () => { reads += 1; return { data: reads === 1 ? PROPOSAL : { ...PROPOSAL, total_price: '3900.00' } }; } });
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  tap(await screen.findByText('stub edit saved'));
  // The first wait is for the re-read to land and show. A wait that passes at
  // once ends before the re-read answers, and the answer then lands outside act.
  await waitFor(() => expect(within(section('Financials')).getByText('$3,900.00')).toBeInTheDocument());
  expect(screen.queryByTestId('edit-sheet')).toBeNull();
  expect(api.get).toHaveBeenCalledWith('/proposals/13');
  expect(api.get).toHaveBeenCalledWith('/invoices/proposal/13');
});

test('a re-read after a save that fails says so, with Retry', async () => {
  let fail = false;
  let reads = 0;
  serve({
    '/proposals/13': () => { reads += 1; return fail ? { reject: NETWORK } : { data: reads === 1 ? PROPOSAL : { ...PROPOSAL, total_price: '3900.00' } }; },
  });
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  await screen.findByText('stub edit saved');
  fail = true;
  tap(screen.getByText('stub edit saved'));
  expect(await screen.findByText('Saved. The event below could not be refreshed and may be out of date.')).toBeInTheDocument();
  fail = false;
  tap(screen.getByRole('button', { name: 'Retry' }));
  // The first wait is for the Retry's re-read to land (see the test above).
  await waitFor(() => expect(within(section('Financials')).getByText('$3,900.00')).toBeInTheDocument());
  expect(screen.queryByText('Saved. The event below could not be refreshed and may be out of date.')).toBeNull();
});

test('an edit param for another event is dropped', async () => {
  serve();
  mount({ initial: '/events/13?drawer=edit&drawerId=99' });
  await screen.findByText('Person 1');
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/));
  expect(screen.queryByTestId('edit-sheet')).toBeNull();
});

// Plan fleet, 2026-10-05: the stored-copy case is spec section 7's money law
// (no money sheet opens from a cache-served read), and the held-roster case is
// mutation-checked: without the roster gate the sheet opens on the date alone.
test('an edit param on a past event, or on a stored copy, opens nothing and is dropped', async () => {
  serve({ '/shifts/by-proposal/13': { data: [shift(1, { finished: true })] } });
  const first = mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  await screen.findByText('Person 1');
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/));
  expect(screen.queryByTestId('edit-sheet')).toBeNull();
  first.unmount();
  serve({ '/proposals/13': { data: PROPOSAL, staleAt: '2026-10-05T12:00:00.000Z' } });
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  await screen.findByText('Person 1');
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/));
  expect(screen.queryByTestId('edit-sheet')).toBeNull();
});

test('the edit sheet waits for the roster: a deep link to an event that finished today never opens it', async () => {
  const roster = held();
  serve({ '/shifts/by-proposal/13': () => roster.entry });
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  await screen.findByRole('button', { name: /^Edit details/ });
  expect(screen.queryByTestId('edit-sheet')).toBeNull();
  roster.release({ data: [shift(1, { finished: true })] });
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/));
  expect(screen.queryByTestId('edit-sheet')).toBeNull();
});

// Controller ruling (fleet fold, 2026-10-06): the server's syncShiftsFromProposal
// counts every shift, cancelled included, and moves the shift only at exactly
// one, so the multi-shift note counts every shift too.
test('a cancelled shift beside the live one counts as a second shift, as the server\'s shift sync counts it', async () => {
  serve({ '/shifts/by-proposal/13': { data: [shift(1), shift(2, { status: 'cancelled', requesters: [] })] } });
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  expect(await screen.findByTestId('edit-shifts')).toHaveTextContent('2');
});

// Controller ruling, Task 5 review: a save holds the closers from the render
// where Save was tapped. When Back closes the sheet while the save is out,
// those closers must close nothing: a plain drawer.close from that render
// pops a second history entry and leaves the event, usually for the list.
// The edit sheet's late save still re-reads the event.
test('a save that settles after Back closed the edit sheet stays on the event, and still re-reads it fresh', async () => {
  let reads = 0;
  serve({ '/proposals/13': () => { reads += 1; return { data: reads === 1 ? PROPOSAL : { ...PROPOSAL, total_price: '3900.00' } }; } });
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  await screen.findByTestId('edit-sheet');
  const late = mockSheets.edit;
  tap(screen.getByRole('button', { name: 'back' }));
  await waitFor(() => expect(screen.queryByTestId('edit-sheet')).toBeNull());
  expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/);
  const entry = screen.getByTestId('key').textContent;
  await act(async () => { late.onSaved(); });
  expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/);
  expect(screen.getByTestId('key').textContent).toBe(entry);
  expect(api.get).toHaveBeenCalledWith('/proposals/13');
  expect(api.get).toHaveBeenCalledWith('/invoices/proposal/13');
  await waitFor(() => expect(within(section('Financials')).getByText('$3,900.00')).toBeInTheDocument());
  expect(screen.getByText('Person 1')).toBeInTheDocument();
});

test('a sheet closer that runs after Back closed its sheet closes nothing; a late note save still shows the note', async () => {
  serve();
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  await screen.findByTestId('edit-sheet');
  const edit = mockSheets.edit;
  tap(screen.getByRole('button', { name: 'back' }));
  await waitFor(() => expect(screen.queryByTestId('edit-sheet')).toBeNull());
  const entry = screen.getByTestId('key').textContent;
  await act(async () => { edit.onClose(); });
  expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/);
  expect(screen.getByTestId('key').textContent).toBe(entry);

  tap(screen.getByRole('button', { name: /^Note/ }));
  await screen.findByTestId('note-sheet');
  const note = mockSheets.note;
  tap(screen.getByRole('button', { name: 'back' }));
  await waitFor(() => expect(screen.queryByTestId('note-sheet')).toBeNull());
  expect(screen.getByTestId('key').textContent).toBe(entry);
  // The note sheet's save ends with onSaved, then onClose.
  await act(async () => { note.onSaved('Late note line'); });
  expect(screen.getByRole('button', { name: /^Note/ })).toHaveTextContent('Late note line');
  await act(async () => { note.onClose(); });
  expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/);
  expect(screen.getByTestId('key').textContent).toBe(entry);
  expect(screen.getByText('Person 1')).toBeInTheDocument();
});

// Pins the Task 6 implementer added: behaviours the brief names that no test
// above held, each shown to fail on its mutation (task-6-report.md).
test('an open edit sheet stays open when a roster read already out says the event finished', async () => {
  const reload = held();
  let reads = 0;
  serve({ '/shifts/by-proposal/13': () => { reads += 1; return reads === 1 ? { data: [shift(1)] } : reload.entry; } });
  mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  await screen.findByText('Person 1');
  tap(screen.getByRole('button', { name: 'stub changed' }));   // a roster reload goes out
  tap(screen.getByRole('button', { name: 'stub close' }));
  await waitFor(() => expect(screen.queryByTestId('sheet')).toBeNull());
  tap(screen.getByRole('button', { name: /^Edit details/ }));
  expect(await screen.findByTestId('edit-sheet')).toBeInTheDocument();
  await act(async () => { reload.release({ data: [shift(1, { finished: true })] }); });
  // The person's work in progress: the sheet stays, and so does its entry.
  expect(screen.getByTestId('edit-sheet')).toBeInTheDocument();
  expect(screen.getByTestId('loc')).toHaveTextContent('/events/13?drawer=edit&drawerId=13');
});

test('a note param on a stored copy, or for another event, opens nothing and is dropped', async () => {
  serve({ '/proposals/13': { data: PROPOSAL, staleAt: '2026-10-05T12:00:00.000Z' } });
  const first = mount({ initial: '/events/13?drawer=note&drawerId=13' });
  await screen.findByText('Person 1');
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/));
  expect(screen.queryByTestId('note-sheet')).toBeNull();
  first.unmount();
  serve();
  mount({ initial: '/events/13?drawer=note&drawerId=99' });
  await screen.findByText('Person 1');
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/));
  expect(screen.queryByTestId('note-sheet')).toBeNull();
});

test('after an edit save the roster, the tab badge and the payment detail are read again too', async () => {
  let rosterReads = 0;
  let invoiceReads = 0;
  const inFlight = { ...INVOICES, pending_payments: [{ amount_cents: 175000, started_at: '2999-08-05T15:00:00.000Z', invoice_id: 2, invoice_number: 'INV-0363' }] };
  serve({
    '/shifts/by-proposal/13': () => { rosterReads += 1; return { data: [shift(1, rosterReads > 1 ? { requesters: [person(1), person(2)] } : {})] }; },
    '/invoices/proposal/13': () => { invoiceReads += 1; return { data: invoiceReads > 1 ? inFlight : INVOICES }; },
  });
  const { ctx } = mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  tap(await screen.findByText('stub edit saved'));
  await waitFor(() => expect(within(section('Staffing')).getByText('2/2')).toBeInTheDocument());
  await waitFor(() => expect(within(section('Financials')).getByText('Processing')).toBeInTheDocument());
  expect(ctx.refreshBadges).toHaveBeenCalledTimes(1);
});

test('an edit param waits for a roster that lands after the event, then opens the sheet', async () => {
  const roster = held();
  serve({ '/shifts/by-proposal/13': () => roster.entry });
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  await screen.findByRole('button', { name: /^Edit details/ });
  expect(screen.queryByTestId('edit-sheet')).toBeNull();
  expect(screen.getByTestId('loc')).toHaveTextContent('/events/13?drawer=edit&drawerId=13');
  await act(async () => { roster.release({ data: [shift(1)] }); });
  expect(screen.getByTestId('edit-sheet')).toBeInTheDocument();
});

test('the Note row shows only the note\'s first line', async () => {
  serve({ '/proposals/13': { data: { ...PROPOSAL, admin_notes: 'Gate code 4412\nPark behind the barn' } } });
  mount();
  await screen.findByText('Person 1');
  const note = screen.getByRole('button', { name: /^Note/ });
  expect(note).toHaveTextContent('Gate code 4412');
  expect(note).not.toHaveTextContent('Park behind the barn');
});

// Review fix round 1 (controller ruling, 2026-10-06): the Edit details row and
// an edit param wait for every read the sheet's gate needs (the roster, the
// drink plan, the invoices), and the re-reads after saves keep their order.
test('Edit details takes no tap while the roster is loading, so held taps stack no history', async () => {
  const roster = held();
  serve({ '/shifts/by-proposal/13': () => roster.entry });
  mount();
  const row = await screen.findByRole('button', { name: /^Edit details/ });
  expect(row).toHaveTextContent('date · time · guests');   // the label stays as it is while held
  tap(row);
  tap(row);
  expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/);
  expect(row).toBeDisabled();
  await act(async () => { roster.release({ data: [shift(1)] }); });
  expect(screen.queryByTestId('edit-sheet')).toBeNull();
  // Now the row opens the sheet, and one close leaves the URL bare.
  tap(screen.getByRole('button', { name: /^Edit details/ }));
  expect(await screen.findByTestId('edit-sheet')).toBeInTheDocument();
  tap(screen.getByText('stub edit close'));
  await waitFor(() => expect(screen.queryByTestId('edit-sheet')).toBeNull());
  expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/);
});

test('an edit param waits for the drink-plan read, and opens once it lands fresh', async () => {
  const plan = held();
  serve({ '/drink-plans/by-proposal/13': () => plan.entry });
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  await screen.findByText('Person 1');
  expect(screen.queryByTestId('edit-sheet')).toBeNull();
  expect(screen.getByRole('button', { name: /^Edit details/ })).toBeDisabled();
  expect(screen.getByTestId('loc')).toHaveTextContent('/events/13?drawer=edit&drawerId=13');
  await act(async () => { plan.release({ data: PLAN }); });
  expect(screen.getByTestId('edit-sheet')).toBeInTheDocument();
});

test('a drink-plan read that settles stale keeps the edit sheet shut, and the row reads needs connection', async () => {
  const plan = held();
  serve({ '/drink-plans/by-proposal/13': () => plan.entry });
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  await screen.findByText('Person 1');
  expect(screen.queryByTestId('edit-sheet')).toBeNull();
  await act(async () => { plan.release({ data: PLAN, staleAt: '2026-10-05T12:00:00.000Z' }); });
  const row = screen.getByRole('button', { name: /^Edit details/ });
  expect(row).toHaveTextContent('needs connection');
  expect(row).toBeDisabled();
  expect(screen.queryByTestId('edit-sheet')).toBeNull();
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/));
});

test('two re-reads after saves that land out of order: the newer answer stays on screen', async () => {
  const first = held();
  const second = held();
  let reads = 0;
  serve({ '/proposals/13': () => { reads += 1; if (reads === 1) return { data: PROPOSAL }; return reads === 2 ? first.entry : second.entry; } });
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  tap(await screen.findByText('stub edit saved'));                 // re-read 1 goes out
  await waitFor(() => expect(screen.queryByTestId('edit-sheet')).toBeNull());
  tap(screen.getByRole('button', { name: /^Edit details/ }));
  tap(await screen.findByText('stub edit saved'));                 // re-read 2 goes out
  expect(reads).toBe(3);
  await act(async () => { second.release({ data: { ...PROPOSAL, total_price: '4100.00' } }); });
  expect(within(section('Financials')).getByText('$4,100.00')).toBeInTheDocument();
  await act(async () => { first.release({ data: { ...PROPOSAL, total_price: '3900.00' } }); });
  expect(within(section('Financials')).getByText('$4,100.00')).toBeInTheDocument();
});

test('an older re-read that fails after a newer one landed raises no notice', async () => {
  const first = held();
  const second = held();
  let reads = 0;
  serve({ '/proposals/13': () => { reads += 1; if (reads === 1) return { data: PROPOSAL }; return reads === 2 ? first.entry : second.entry; } });
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  tap(await screen.findByText('stub edit saved'));
  await waitFor(() => expect(screen.queryByTestId('edit-sheet')).toBeNull());
  tap(screen.getByRole('button', { name: /^Edit details/ }));
  tap(await screen.findByText('stub edit saved'));
  expect(reads).toBe(3);
  await act(async () => { second.release({ data: { ...PROPOSAL, total_price: '4100.00' } }); });
  await act(async () => { first.refuse(NETWORK); });
  expect(screen.queryByText('Saved. The event below could not be refreshed and may be out of date.')).toBeNull();
  expect(within(section('Financials')).getByText('$4,100.00')).toBeInTheDocument();
});

test('an edit param waits for the invoices read too, and opens once it lands fresh', async () => {
  const invoices = held();
  serve({ '/invoices/proposal/13': () => invoices.entry });
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  await screen.findByText('Person 1');
  expect(screen.queryByTestId('edit-sheet')).toBeNull();
  expect(screen.getByRole('button', { name: /^Edit details/ })).toBeDisabled();
  expect(screen.getByTestId('loc')).toHaveTextContent('/events/13?drawer=edit&drawerId=13');
  await act(async () => { invoices.release({ data: INVOICES }); });
  expect(screen.getByTestId('edit-sheet')).toBeInTheDocument();
});

test('a newer re-read that fails keeps the notice up when an older one lands after it', async () => {
  const first = held();
  const second = held();
  let reads = 0;
  serve({ '/proposals/13': () => { reads += 1; if (reads === 1) return { data: PROPOSAL }; return reads === 2 ? first.entry : second.entry; } });
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  tap(await screen.findByText('stub edit saved'));
  await waitFor(() => expect(screen.queryByTestId('edit-sheet')).toBeNull());
  tap(screen.getByRole('button', { name: /^Edit details/ }));
  tap(await screen.findByText('stub edit saved'));
  expect(reads).toBe(3);
  await act(async () => { second.refuse(NETWORK); });
  expect(screen.getByText('Saved. The event below could not be refreshed and may be out of date.')).toBeInTheDocument();
  // Newer than the screen, so the older answer shows; asked before the second
  // save, so it can still be behind, and the notice stays.
  await act(async () => { first.release({ data: { ...PROPOSAL, total_price: '3900.00' } }); });
  expect(within(section('Financials')).getByText('$3,900.00')).toBeInTheDocument();
  expect(screen.getByText('Saved. The event below could not be refreshed and may be out of date.')).toBeInTheDocument();
});

// ---- Fleet fold (lane ma-e3, 2026-10-06) ----
const css = fs.readFileSync(path.resolve(__dirname, '../../index.css'), 'utf8');

// Item 12 (D-M3): the Note row has the Edit details row's hold, and the note sheet latches once open.
test('the Note row takes no tap while the roster is loading, so held taps stack no history', async () => {
  const roster = held();
  serve({ '/shifts/by-proposal/13': () => roster.entry });
  mount();
  const row = await screen.findByRole('button', { name: /^Note/ });
  expect(row).toHaveTextContent('Add a note');   // the label stays as it is while held
  tap(row);
  tap(row);
  expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/);
  expect(row).toBeDisabled();
  await act(async () => { roster.release({ data: [shift(1)] }); });
  expect(screen.queryByTestId('note-sheet')).toBeNull();
  tap(screen.getByRole('button', { name: /^Note/ }));
  expect(await screen.findByTestId('note-sheet')).toBeInTheDocument();
  tap(screen.getByText('stub note close'));
  await waitFor(() => expect(screen.queryByTestId('note-sheet')).toBeNull());
  expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/);
});

test('a note param waits for the drink-plan read, and opens once it lands fresh', async () => {
  const plan = held();
  serve({ '/drink-plans/by-proposal/13': () => plan.entry });
  mount({ initial: '/events/13?drawer=note&drawerId=13' });
  await screen.findByText('Person 1');
  expect(screen.queryByTestId('note-sheet')).toBeNull();
  expect(screen.getByRole('button', { name: /^Note/ })).toBeDisabled();
  expect(screen.getByTestId('loc')).toHaveTextContent('/events/13?drawer=note&drawerId=13');
  await act(async () => { plan.release({ data: PLAN }); });
  expect(screen.getByTestId('note-sheet')).toBeInTheDocument();
});

test('a note param waits for the invoices read too, and opens once it lands fresh', async () => {
  const invoices = held();
  serve({ '/invoices/proposal/13': () => invoices.entry });
  mount({ initial: '/events/13?drawer=note&drawerId=13' });
  await screen.findByText('Person 1');
  expect(screen.queryByTestId('note-sheet')).toBeNull();
  expect(screen.getByTestId('loc')).toHaveTextContent('/events/13?drawer=note&drawerId=13');
  await act(async () => { invoices.release({ data: INVOICES }); });
  expect(screen.getByTestId('note-sheet')).toBeInTheDocument();
});

test('a drink-plan read that settles stale keeps the note sheet shut, and the row reads needs connection', async () => {
  const plan = held();
  serve({ '/drink-plans/by-proposal/13': () => plan.entry });
  mount({ initial: '/events/13?drawer=note&drawerId=13' });
  await screen.findByText('Person 1');
  expect(screen.queryByTestId('note-sheet')).toBeNull();
  await act(async () => { plan.release({ data: PLAN, staleAt: '2026-10-05T12:00:00.000Z' }); });
  const row = screen.getByRole('button', { name: /^Note/ });
  expect(row).toHaveTextContent('needs connection');
  expect(row).toBeDisabled();
  expect(screen.queryByTestId('note-sheet')).toBeNull();
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/));
});

// D-M3's scenario: a read that turns stale after the note sheet opened must
// not shut it on the person's typing. (In the app the sheet's scrim covers this
// Retry; the rule holds whatever starts the read.)
test('an open note sheet stays open when a later read comes back from the stored copy', async () => {
  let reads = 0;
  serve({ '/shifts/by-proposal/13': () => { reads += 1; return reads === 1 ? { reject: NETWORK } : { data: [shift(1)], staleAt: STAMP }; } });
  mount();
  expect(await screen.findByText("Couldn't load staffing.")).toBeInTheDocument();
  tap(screen.getByRole('button', { name: /^Note/ }));
  expect(await screen.findByTestId('note-sheet')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(/^offline copy · as of/)).toBeInTheDocument();
  expect(screen.getByTestId('note-sheet')).toBeInTheDocument();
  expect(screen.getByTestId('loc')).toHaveTextContent('/events/13?drawer=note&drawerId=13');
});

// Item 14 (U-M8): the held rows give a cue, with no new words.
test('while held, Edit details and Note say they are busy and dim their notes; the cue leaves once the reads settle', async () => {
  const roster = held();
  serve({ '/shifts/by-proposal/13': () => roster.entry });
  mount();
  const edit = await screen.findByRole('button', { name: /^Edit details/ });
  const note = screen.getByRole('button', { name: /^Note/ });
  expect(edit).toHaveAttribute('aria-busy', 'true');
  expect(note).toHaveAttribute('aria-busy', 'true');
  expect(edit).toHaveTextContent('date · time · guests');
  await act(async () => { roster.release({ data: [shift(1)] }); });
  expect(screen.getByRole('button', { name: /^Edit details/ })).not.toHaveAttribute('aria-busy');
  expect(screen.getByRole('button', { name: /^Note/ })).not.toHaveAttribute('aria-busy');
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-section-row\[aria-busy="true"\] \.m-edit-note,[^{]*\.m-section-row\[aria-busy="true"\] \.m-note-preview,[^{]*\.m-section-row\[aria-busy="true"\] \.m-section-caret \{ opacity: 0\.45; \}/);
});

// Item 15 (U-M9): the behind notice takes the page's inset, not the sheet's.
test('the saved-but-behind notice lines up with the when line and the sections', async () => {
  let fail = false;
  serve({ '/proposals/13': () => (fail ? { reject: NETWORK } : { data: PROPOSAL }) });
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  await screen.findByText('stub edit saved');
  fail = true;
  tap(screen.getByText('stub edit saved'));
  const line = await screen.findByText('Saved. The event below could not be refreshed and may be out of date.');
  // eslint-disable-next-line testing-library/no-node-access
  expect(line.closest('.m-fail')).toHaveClass('m-saved-behind');
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-fail\.m-saved-behind \{ margin: 0 0 10px; \}/);
});

// Item 16 (U-M10): offline, the Note row's "needs connection" sits at the far end, like Edit details'.
test('offline, the Note row\'s needs connection follows the label and is pushed to the far end', async () => {
  serve({ '/proposals/13': { data: PROPOSAL, staleAt: '2026-10-05T12:00:00.000Z' } });
  mount();
  await screen.findByText('Person 1');
  const locked = within(screen.getByRole('button', { name: /^Note/ })).getByText('needs connection');
  // eslint-disable-next-line testing-library/no-node-access
  expect(locked.previousElementSibling).toHaveClass('m-section-name', 'm-note-name');
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-section-name\.m-note-name \+ \.m-edit-note \{ margin-left: auto; \}/);
});
