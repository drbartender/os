import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import AssignmentSheet from './AssignmentSheet';
import api from '../../utils/api';
import { railParts } from '../../utils/eventCards';
import { chicagoDay } from '../../utils/chicagoDay';

jest.mock('../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() },
}));

const shiftRow = (over = {}) => ({
  id: 17, proposal_id: 10, client_name: 'Henderson', event_type: 'wedding-reception', event_type_custom: null,
  event_date: '2999-08-15', start_time: '18:00', end_time: '23:00', location: 'Grove on the River',
  positions_needed: '["Bartender","Bartender","Bartender"]', status: 'open', proposal_status: 'deposit_paid',
  finished: false, approved_count: 2, ...over,
});
const reqRow = (id, over = {}) => ({
  id, user_id: 100 + id, staff_name: `Person ${id}`, status: 'pending', position: null, dropped_at: null,
  requested_positions: '["Bartender"]', home_distance_miles: 6.8, events_worked: 14, ...over,
});
const onShift = (id, role = 'Bartender', over = {}) => reqRow(id, { status: 'approved', position: role, ...over });
const STAFF = [
  { id: 9, display_name: 'Tess Marsh', events_worked: 9, home_distance_miles: 8 },
  { id: 5, display_name: 'Ana Flores', events_worked: 33, home_distance_miles: null },
  { id: 101, display_name: 'Person 1', events_worked: 1, home_distance_miles: 1 },
];
const TWO_ROLES = '["Bartender","Barback"]';
const NETWORK = { status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' };
const OFFLINE_OK = { headers: { 'X-Offline-Ok': '1' } };
// The reads that may come from the phone's cache carry the header; the re-read
// before a write never does.
const detailReads = () => api.get.mock.calls.filter((c) => c[0] === '/shifts/detail/17');
const offlineReads = () => detailReads().filter((c) => c[1] && c[1].headers && c[1].headers['X-Offline-Ok'] === '1');
const liveReads = () => detailReads().filter((c) => !c[1]);

// detail may be one payload, or a list served in order (the last one repeats).
function serve({ detail, staff = STAFF, staffFails = false, staffStaleAt = null, staffHeld = null } = {}) {
  const queue = Array.isArray(detail) ? detail.slice() : [detail];
  api.get.mockImplementation((url) => {
    if (url === '/shifts/detail/17') {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return next instanceof Error || next.reject ? Promise.reject(next.reject || next) : Promise.resolve(next);
    }
    if (url === '/admin/active-staff') {
      if (staffHeld) return staffHeld;
      if (staffFails) return Promise.reject(NETWORK);
      return Promise.resolve(staffStaleAt ? { data: { staff }, staleAt: staffStaleAt } : { data: { staff } });
    }
    return Promise.reject({ status: 404, message: 'Not found' });
  });
}
const payload = (requests, shiftOver = {}, extra = {}) => ({ data: { shift: shiftRow(shiftOver), requests }, ...extra });

const handlers = () => ({ onClose: jest.fn(), onChanged: jest.fn(), onDead: jest.fn() });
function mount(props = {}) {
  const h = handlers();
  render(<AssignmentSheet shiftId={17} {...h} {...props} />);
  return h;
}
// The sheet reads the roster and then, when a role is open, the picker. Both
// have landed and rendered when this resolves. A test that acts before that
// races the picker's read: it passed alone and failed beside other suites.
async function opened(props = {}) {
  const h = mount(props);
  await screen.findByRole('dialog');
  await waitFor(() => expect(screen.queryByText('Loading the roster')).toBeNull());
  await waitFor(() => expect(screen.queryByText('Loading the staff list')).toBeNull());
  return h;
}
const row = (name) => screen.getByRole('button', { name: new RegExp(name) });
const tap = (el) => fireEvent.click(el);
const person = (name) => screen.getByRole('group', { name });
const staffReads = () => api.get.mock.calls.filter((c) => c[0] === '/admin/active-staff');
// A read or a write the test answers by hand.
function held() {
  const box = {};
  box.entry = new Promise((resolve, reject) => { box.release = resolve; box.refuse = reject; });
  return box;
}
const PERSON_MOVED = 'This person’s place on the shift changed. Check the roster and try again.';
const ROSTER_MOVED = 'The roster changed. Check the open roles and try again.';
const NO_SAVE = "No connection, didn't save.";
const PICKER_STORED = 'No connection. Assigning needs the server; the staff list below is the cached copy.';
const SAVED_BEHIND = 'Saved. The roster below could not be refreshed and may be out of date.';
const STAMP = '2026-09-29T17:00:00Z';

beforeEach(() => {
  api.post.mockResolvedValue({ data: {} });
  api.put.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: { success: true } });
});

test('reads the shift and the picker for THIS shift, and renders the head and the roster', async () => {
  serve({ detail: payload([onShift(1, 'Bartender', { staff_name: 'Lena Park' }), onShift(2, 'Bartender', { staff_name: 'Sam Ortiz' }), reqRow(3)]) });
  await opened();
  const dialog = await screen.findByRole('dialog');
  expect(api.get).toHaveBeenCalledWith('/shifts/detail/17', OFFLINE_OK);
  await within(dialog).findByText('Lena Park');
  // The picker is read once the roster says a role is open.
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/active-staff', { params: { limit: 100, shift_id: 17 }, ...OFFLINE_OK }));
  await within(dialog).findByText('Tess Marsh');
  const rail = railParts('2999-08-15');
  expect(within(dialog).getByRole('heading')).toHaveTextContent('Henderson · Wedding Reception');
  expect(within(dialog).getByText(`${rail.dow} ${rail.mon} ${rail.day} 2999 · 18:00–23:00 · 5h`)).toBeInTheDocument();
  expect(within(dialog).getByText('2/3')).toHaveClass('m-pill-count');
  expect(within(dialog).getByText('Bartender 2/3')).toHaveClass('m-sheet-mix');
  expect(within(dialog).getByText('On this shift')).toBeInTheDocument();
  expect(within(row('Person 3')).getByText('Pending')).toBeInTheDocument();
  expect(within(row('Person 3')).getByText('Bartender · 14 events · 7 mi')).toHaveClass('m-person-meta');
  expect(within(dialog).getByText('Assign · Bartender × 1')).toBeInTheDocument();
  // A booked event does not repeat its venue in the sheet head.
  expect(within(dialog).queryByText('Grove on the River')).toBeNull();
});

test('an event in the current year shows no year in the head', async () => {
  const ymd = `${chicagoDay(new Date().toISOString()).slice(0, 4)}-08-15`;
  serve({ detail: payload([], { event_date: ymd }) });
  await opened();
  const dialog = await screen.findByRole('dialog');
  const rail = railParts(ymd);
  expect(await within(dialog).findByText(`${rail.dow} ${rail.mon} ${rail.day} · 18:00–23:00 · 5h`)).toBeInTheDocument();
});

test('a manual shift names its venue in the head', async () => {
  serve({ detail: payload([], { proposal_id: null, client_name: 'Night Market pop-up', event_type: null, location: 'Wicker Park' }) });
  await opened();
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('Wicker Park')).toHaveClass('m-sheet-venue');
  expect(within(dialog).getByRole('heading')).toHaveTextContent('Night Market pop-up · Manual shift');
});

test('Approve with one open role sends that role, after re-reading the shift', async () => {
  serve({ detail: payload([onShift(1), onShift(2), reqRow(3)]) });
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(api.post).toHaveBeenCalledWith('/shifts/17/assign', { user_id: 103, position: 'Bartender' });
  // open read, pre-flight read, post-write read
  await waitFor(() => expect(detailReads().length).toBe(3));
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  // The re-read before the write is the network or an error, never a stored
  // copy: it is the one read that does not ask for the offline fallback.
  expect(liveReads()).toHaveLength(1);
  expect(offlineReads()).toHaveLength(2);
  expect(api.get.mock.invocationCallOrder[api.get.mock.calls.indexOf(liveReads()[0])])
    .toBeLessThan(api.post.mock.invocationCallOrder[0]);
});

test('with two open roles Approve sends nothing until a role row is tapped', async () => {
  serve({ detail: payload([reqRow(3, { requested_positions: '["Barback","Bartender"]' })], { positions_needed: TWO_ROLES }) });
  await opened();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('Approve as')).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: /^Barback\s*1 open$/ }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/shifts/17/assign', { user_id: 103, position: 'Barback' }));
});

test('a waitlisted applicant picks the role even when only one is open', async () => {
  serve({ detail: payload([onShift(1, 'Bartender'), reqRow(2, { requested_positions: '["Bartender"]' })], { positions_needed: TWO_ROLES }) });
  await opened();
  const r = await screen.findByRole('button', { name: /Person 2/ });
  expect(within(r).getByText('Waitlisted')).toBeInTheDocument();
  tap(r);
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('Approve as')).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: /^Barback\s*1 open$/ }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/shifts/17/assign', { user_id: 102, position: 'Barback' }));
});

test('with no open role Approve is disabled, the picker is absent, and Deny still works', async () => {
  serve({ detail: payload([onShift(1), reqRow(2)], { positions_needed: '["Bartender"]' }) });
  await opened();
  tap(await screen.findByRole('button', { name: /Person 2/ }));
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
  expect(screen.queryByPlaceholderText('Search active staff')).toBeNull();
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(api.post).not.toHaveBeenCalled();
});

test('Deny asks first, Keep backs out, and the confirm does not promise a notification', async () => {
  serve({ detail: payload([reqRow(3, { staff_name: 'Jo Ellis' })]) });
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  expect(screen.getByText('Deny Jo Ellis’s application? The request closes. They are not notified.')).toBeInTheDocument();
  expect(api.put).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: 'Keep' }));
  expect(screen.queryByText(/The request closes/)).toBeNull();
  expect(api.put).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/shifts/requests/3', { status: 'denied' }));
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
});

test('a failed Deny or Remove stays inline with Retry, and Retry repeats that same write', async () => {
  serve({ detail: payload([onShift(1, 'Bartender', { staff_name: 'Lena Park' }), reqRow(3, { staff_name: 'Jo Ellis' })]) });
  api.put.mockRejectedValueOnce(NETWORK);
  api.delete.mockRejectedValueOnce({ status: 404, message: 'Request not found.' });
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  expect(await screen.findByText("No connection, didn't save.")).toBeInTheDocument();
  expect(h.onChanged).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
  expect(api.put).toHaveBeenLastCalledWith('/shifts/requests/3', { status: 'denied' });
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));

  tap(screen.getByRole('button', { name: /Lena Park/ }));
  tap(screen.getByRole('button', { name: 'Remove from shift' }));
  tap(screen.getByRole('button', { name: 'Remove' }));
  expect(await screen.findByText('Request not found.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  await waitFor(() => expect(detailReads().length).toBeGreaterThanOrEqual(3));
});

// A failed save leaves the screen in three ways: its Retry, a new WRITE on the
// same row, or Dismiss. The next six tests are the taps that must NOT remove
// it, and the three that do.
test('a confirm opened and backed out of leaves the row\'s failed save where it is', async () => {
  serve({ detail: payload([reqRow(3, { staff_name: 'Jo Ellis' })]) });
  api.put.mockRejectedValueOnce(NETWORK);
  await opened();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  expect(await within(person('Jo Ellis')).findByText(NO_SAVE)).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Deny' }));          // asks again
  expect(within(person('Jo Ellis')).getByText('Jo Ellis · Deny')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Keep' }));
  expect(within(person('Jo Ellis')).getByText(NO_SAVE)).toBeInTheDocument();
  expect(within(person('Jo Ellis')).getByRole('button', { name: 'Retry' })).toBeEnabled();
  expect(api.put).toHaveBeenCalledTimes(1);
});

test('one tap on a picker row that holds a failed save closes its role rows and keeps the save', async () => {
  serve({ detail: payload([]) });
  api.post.mockRejectedValueOnce(NETWORK);
  await opened();
  tap(screen.getByRole('button', { name: /Tess Marsh/ }));
  tap(await screen.findByRole('button', { name: /^Bartender\s*3 open$/ }));
  expect(await within(person('Tess Marsh')).findByText(NO_SAVE)).toBeInTheDocument();
  expect(screen.getByText('Assign as')).toBeInTheDocument();   // the role rows are still open
  tap(screen.getByRole('button', { name: /Tess Marsh/ }));
  expect(screen.queryByText('Assign as')).toBeNull();
  expect(within(person('Tess Marsh')).getByText('Tess Marsh · Assign as Bartender')).toBeInTheDocument();
  expect(within(person('Tess Marsh')).getByRole('button', { name: 'Retry' })).toBeEnabled();
  expect(within(person('Tess Marsh')).getByRole('button', { name: 'Dismiss' })).toBeEnabled();
});

test('under a narrowed search, a tap on the person a failed save keeps in the list keeps both', async () => {
  serve({ detail: payload([]) });
  api.post.mockRejectedValueOnce(NETWORK);
  await opened();
  tap(screen.getByRole('button', { name: /Tess Marsh/ }));
  tap(await screen.findByRole('button', { name: /^Bartender\s*3 open$/ }));
  expect(await within(person('Tess Marsh')).findByText(NO_SAVE)).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('Search active staff'), { target: { value: 'ana' } });
  tap(screen.getByRole('button', { name: /Tess Marsh/ }));
  tap(screen.getByRole('button', { name: /Tess Marsh/ }));
  expect(within(person('Tess Marsh')).getByText(NO_SAVE)).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Ana Flores' })).toBeInTheDocument();
});

test('a tap on Approve that only closes the role rows keeps the row\'s failed save', async () => {
  serve({ detail: payload([reqRow(3, { staff_name: 'Jo Ellis', requested_positions: '["Bartender","Barback"]' })], { positions_needed: TWO_ROLES }) });
  api.post.mockRejectedValueOnce(NETWORK);
  await opened();
  tap(screen.getByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  tap(await screen.findByRole('button', { name: /^Barback\s*1 open$/ }));
  expect(await within(person('Jo Ellis')).findByText('Jo Ellis · Approve as Barback')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Approve' }));         // closes the role rows
  expect(screen.queryByText('Approve as')).toBeNull();
  expect(within(person('Jo Ellis')).getByText(NO_SAVE)).toBeInTheDocument();
  tap(screen.getByRole('button', { name: /Jo Ellis/ }));        // collapses the row
  expect(within(person('Jo Ellis')).getByText(NO_SAVE)).toBeInTheDocument();
});

test('Dismiss removes a failed save from a row that is on screen, and sends nothing', async () => {
  serve({ detail: payload([reqRow(3, { staff_name: 'Jo Ellis' })]) });
  api.put.mockRejectedValueOnce(NETWORK);
  const h = await opened();
  tap(screen.getByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  const box = await screen.findByRole('alert');
  // Dismiss is the quiet one of the two.
  expect(within(box).getByRole('button', { name: 'Dismiss' })).toHaveClass('m-fail-retry', 'm-fail-quiet');
  expect(within(box).getByRole('button', { name: 'Retry' })).not.toHaveClass('m-fail-quiet');
  tap(within(box).getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(api.put).toHaveBeenCalledTimes(1);
  expect(h.onChanged).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /Jo Ellis/ })).toBeInTheDocument();
});

test('a save that fails while another row is being opened is still shown, under the row it came from', async () => {
  let fail;
  serve({ detail: payload([reqRow(3, { staff_name: 'Jo Ellis' }), reqRow(4, { staff_name: 'Kim Vale' })]) });
  api.put.mockImplementationOnce(() => new Promise((resolve, reject) => { fail = reject; }));
  await opened();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
  tap(screen.getByRole('button', { name: /Kim Vale/ }));      // moves on while the write is in flight
  await act(async () => { fail(NETWORK); });
  const jo = screen.getByRole('group', { name: 'Jo Ellis' });
  expect(await within(jo).findByText("No connection, didn't save.")).toBeInTheDocument();
  expect(within(jo).getByRole('button', { name: 'Retry' })).toBeEnabled();
  expect(within(screen.getByRole('group', { name: 'Kim Vale' })).queryByRole('alert')).toBeNull();
  tap(screen.getByRole('button', { name: /Jo Ellis/ }));      // opening the row again keeps the box
  expect(within(jo).getByText("No connection, didn't save.")).toBeInTheDocument();
});

test('a failed save stays under its row, with its own Retry, while someone else is assigned', async () => {
  serve({ detail: payload([reqRow(3, { staff_name: 'Jo Ellis' })]) });
  api.post.mockRejectedValueOnce(NETWORK);
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  const jo = screen.getByRole('group', { name: 'Jo Ellis' });
  expect(await within(jo).findByText("No connection, didn't save.")).toBeInTheDocument();
  // Another person is opened, and assigned, and it lands.
  tap(screen.getByRole('button', { name: /Tess Marsh/ }));
  expect(within(jo).getByText("No connection, didn't save.")).toBeInTheDocument();
  tap(await screen.findByRole('button', { name: /^Bartender\s*3 open$/ }));
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  expect(api.post).toHaveBeenLastCalledWith('/shifts/17/assign', { user_id: 9, position: 'Bartender' });
  // Jo's failure is still there, and its Retry still sends JO'S write.
  expect(within(jo).getByText("No connection, didn't save.")).toBeInTheDocument();
  tap(within(jo).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(3));
  expect(api.post).toHaveBeenLastCalledWith('/shifts/17/assign', { user_id: 103, position: 'Bartender' });
  await waitFor(() => expect(within(jo).queryByText("No connection, didn't save.")).toBeNull());
});

test('opening Approve on one row leaves another row\'s failed save where it is', async () => {
  const both = '["Bartender","Barback"]';
  serve({ detail: payload([
    reqRow(3, { staff_name: 'Jo Ellis', requested_positions: both }),
    reqRow(4, { staff_name: 'Kim Vale', requested_positions: both }),
  ], { positions_needed: TWO_ROLES }) });
  api.put.mockRejectedValueOnce(NETWORK);
  await opened();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  const jo = screen.getByRole('group', { name: 'Jo Ellis' });
  expect(await within(jo).findByText("No connection, didn't save.")).toBeInTheDocument();
  tap(screen.getByRole('button', { name: /Kim Vale/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(screen.getByText('Approve as')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Deny' }));          // and Deny asks, on Kim
  expect(within(jo).getByText("No connection, didn't save.")).toBeInTheDocument();
  expect(within(jo).getByRole('button', { name: 'Retry' })).toBeEnabled();
});

test('two rows can each hold a failed save, and each Retry repeats its own', async () => {
  serve({ detail: payload([reqRow(3, { staff_name: 'Jo Ellis' }), reqRow(4, { staff_name: 'Kim Vale' })]) });
  api.put.mockRejectedValueOnce(NETWORK).mockRejectedValueOnce({ status: 502, message: 'Bad gateway.' });
  await opened();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  const jo = screen.getByRole('group', { name: 'Jo Ellis' });
  expect(await within(jo).findByText("No connection, didn't save.")).toBeInTheDocument();
  tap(screen.getByRole('button', { name: /Kim Vale/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  const kim = screen.getByRole('group', { name: 'Kim Vale' });
  expect(await within(kim).findByText('Bad gateway.')).toBeInTheDocument();
  expect(within(jo).getByText("No connection, didn't save.")).toBeInTheDocument();
  expect(screen.getAllByRole('alert')).toHaveLength(2);
  tap(within(jo).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(3));
  expect(api.put).toHaveBeenLastCalledWith('/shifts/requests/3', { status: 'denied' });
});

test('a failed Deny stays, named, while "Approve as" is open; the Approve that is WRITTEN replaces it', async () => {
  serve({ detail: payload([reqRow(3, { staff_name: 'Jo Ellis', requested_positions: '["Bartender","Barback"]' })], { positions_needed: TWO_ROLES }) });
  api.put.mockRejectedValueOnce(NETWORK);
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  expect(await within(person('Jo Ellis')).findByText('Jo Ellis · Deny')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(screen.getByText('Approve as')).toBeInTheDocument();
  // Still there, and it still says what its Retry would send.
  expect(within(person('Jo Ellis')).getByText('Jo Ellis · Deny')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: /^Bartender\s*1 open$/ }));
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  expect(api.post).toHaveBeenCalledWith('/shifts/17/assign', { user_id: 103, position: 'Bartender' });
  expect(screen.queryByText('Jo Ellis · Deny')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(api.put).toHaveBeenCalledTimes(1);
});

test('Deny re-reads first and is never sent to a person who was approved in the meantime', async () => {
  serve({ detail: [payload([reqRow(3, { staff_name: 'Jo Ellis' })]), payload([onShift(3, 'Bartender', { staff_name: 'Jo Ellis' })])] });
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  expect(await screen.findByText('This person’s place on the shift changed. Check the roster and try again.')).toBeInTheDocument();
  expect(api.put).not.toHaveBeenCalled();
  // Nothing was written, and the owner is told all the same: the roster moved.
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  expect(liveReads().length).toBeGreaterThanOrEqual(1);
});

test('a request that is gone but whose person is back under a new one is a roster change, not a success', async () => {
  // Request 3 was withdrawn and re-made as request 9 by the same person.
  serve({ detail: [payload([reqRow(3, { staff_name: 'Jo Ellis' })]), payload([reqRow(9, { user_id: 103, staff_name: 'Jo Ellis' })])] });
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  expect(await screen.findByText('This person’s place on the shift changed. Check the roster and try again.')).toBeInTheDocument();
  expect(api.put).not.toHaveBeenCalled();
  // Nothing was written, and the owner is told all the same: the roster moved.
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: /Jo Ellis/ })).toBeInTheDocument();
});

test('a Deny whose answer was lost is not sent again once the request is closed', async () => {
  serve({ detail: [payload([reqRow(3, { staff_name: 'Jo Ellis' })]), payload([reqRow(3, { staff_name: 'Jo Ellis' })]), payload([])] });
  api.put.mockRejectedValueOnce(NETWORK);
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  expect(await screen.findByText("No connection, didn't save.")).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  expect(api.put).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Jo Ellis')).toBeNull();
});

test('Remove re-reads first and is never sent for a person who already dropped', async () => {
  serve({ detail: [
    payload([onShift(1, 'Bartender', { staff_name: 'Lena Park' })]),
    payload([onShift(1, 'Bartender', { staff_name: 'Lena Park', dropped_at: '2026-09-28T12:00:00Z' })]),
  ] });
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Lena Park/ }));
  tap(screen.getByRole('button', { name: 'Remove from shift' }));
  tap(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  expect(api.delete).not.toHaveBeenCalled();
  expect(screen.queryByText('Lena Park')).toBeNull();
});

test('in a sheet that became read-only a failed save offers no Retry, and can still be dismissed', async () => {
  const jo = reqRow(3, { staff_name: 'Jo Ellis' });
  // The roster, the re-read before the Deny, then the read after the refusal: the shift has finished.
  serve({ detail: [payload([jo]), payload([jo]), payload([jo], { finished: true })] });
  api.put.mockRejectedValueOnce({ status: 502, message: 'Bad gateway.' });
  await opened();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  expect(await within(person('Jo Ellis')).findByText('Bad gateway.')).toBeInTheDocument();
  expect(await screen.findByText('Past event · roster is read-only')).toBeInTheDocument();
  expect(within(person('Jo Ellis')).getByRole('button', { name: 'Retry' })).toBeDisabled();
  tap(within(person('Jo Ellis')).getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(api.put).toHaveBeenCalledTimes(1);
});

test('Remove asks first and names payroll and the out-of-area lock', async () => {
  serve({ detail: payload([onShift(1, 'Bartender', { staff_name: 'Lena Park' })]) });
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Lena Park/ }));
  tap(screen.getByRole('button', { name: 'Remove from shift' }));
  expect(screen.getByText('Remove Lena Park from this shift? Payroll re-accrues and any out-of-area lock is released. They are not notified.')).toBeInTheDocument();
  expect(api.delete).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/shifts/requests/1'));
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
});

test('the picker is alphabetical, skips people already on the shift, and a tap on a person never assigns by itself', async () => {
  serve({ detail: payload([onShift(1)]) });
  await opened();
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('Ana Flores');
  const names = within(dialog).getAllByText(/Ana Flores|Tess Marsh/).map((n) => n.textContent);
  expect(names).toEqual(['Ana Flores', 'Tess Marsh']);
  expect(within(dialog).getAllByText('Person 1').length).toBe(1);   // on the roster, not in the picker
  expect(within(row('Ana Flores')).getByText('33 events')).toBeInTheDocument();
  expect(within(row('Tess Marsh')).getByText('9 events · 8 mi')).toBeInTheDocument();
  tap(row('Tess Marsh'));
  expect(await screen.findByText('Assign as')).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: /^Bartender\s*2 open$/ }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/shifts/17/assign', { user_id: 9, position: 'Bartender' }));
});

test('a person just assigned says so on the roster', async () => {
  serve({ detail: [payload([]), payload([]), payload([onShift(9, 'Bartender', { user_id: 9, staff_name: 'Tess Marsh' })])] });
  await opened();
  tap(await screen.findByRole('button', { name: /Tess Marsh/ }));
  tap(await screen.findByRole('button', { name: /^Bartender\s*3 open$/ }));
  expect(await screen.findByText('Bartender · just assigned')).toBeInTheDocument();
});

test('search narrows the picker and says when nothing matches', async () => {
  serve({ detail: payload([]) });
  await opened();
  await screen.findByText('Ana Flores');
  const field = screen.getByPlaceholderText('Search active staff');
  expect(field).toHaveAttribute('type', 'search');
  fireEvent.change(field, { target: { value: 'tess' } });
  expect(screen.queryByText('Ana Flores')).toBeNull();
  expect(screen.getByText('Tess Marsh')).toBeInTheDocument();
  fireEvent.change(field, { target: { value: 'zzz' } });
  expect(screen.getByText('No active staff matches “zzz”.')).toBeInTheDocument();
});

test('a second tap while a write is in flight sends nothing', async () => {
  serve({ detail: payload([]) });
  api.post.mockReturnValue(new Promise(() => {}));   // the write never lands
  await opened();
  tap(await screen.findByRole('button', { name: /Tess Marsh/ }));
  const role = await screen.findByRole('button', { name: /^Bartender\s*3 open$/ });
  tap(role);
  tap(role);
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  tap(role);
  tap(screen.getByRole('button', { name: /Ana Flores/ }));
  expect(api.post).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(role).toBeDisabled());
});

test('two taps in the same frame send one write', async () => {
  serve({ detail: payload([reqRow(3)]) });
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  const approve = screen.getByRole('button', { name: 'Approve' });
  // Two clicks with no render between them: the DOM's own click, inside one
  // act, so the second lands before `disabled` can.
  act(() => { approve.click(); approve.click(); });
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(liveReads()).toHaveLength(1);
});

test('a shift that finished since the sheet opened refuses the write', async () => {
  serve({ detail: [payload([reqRow(3)]), payload([reqRow(3)], { finished: true })] });
  await opened();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  // The reason given is the real one, and the sheet is read-only from here.
  expect(await within(person('Person 3')).findByText('Past event · roster is read-only')).toBeInTheDocument();
  expect(screen.queryByText(ROSTER_MOVED)).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.getByText('Past event · roster is read-only', { selector: '.m-sheet-mix' })).toBeInTheDocument();
  expect(within(person('Person 3')).getByRole('button', { name: 'Retry' })).toBeDisabled();
});

test('a role that filled since the sheet opened is refused before the write', async () => {
  serve({ detail: [
    payload([onShift(1), onShift(2), reqRow(3)]),
    payload([onShift(1), onShift(2), onShift(4, 'Bartender', { staff_name: 'Someone Else' }), reqRow(3)]),
  ] });
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('The roster changed. Check the open roles and try again.')).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
  // Nothing was written, and the owner is told all the same: the roster moved.
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('Someone Else')).toBeInTheDocument();
  expect(screen.getByText('3/3')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
});

test('a lost connection on the write keeps the row open and Retry repeats the same write', async () => {
  serve({ detail: payload([reqRow(3)]) });
  api.post.mockRejectedValueOnce(NETWORK);
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText("No connection, didn't save.")).toBeInTheDocument();
  expect(h.onChanged).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(api.post).toHaveBeenLastCalledWith('/shifts/17/assign', { user_id: 103, position: 'Bartender' });
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("No connection, didn't save.")).toBeNull();
});

test('when the answer was lost but the write landed, Retry sends nothing more', async () => {
  // Reads in order: the roster, the re-read before the write, the re-read
  // before the Retry (the person is on the roster by then).
  serve({ detail: [payload([reqRow(3)]), payload([reqRow(3)]), payload([onShift(3)])] });
  api.post.mockRejectedValueOnce(NETWORK);
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText("No connection, didn't save.")).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('Bartender · just assigned')).toBeInTheDocument();
  expect(screen.queryByText("No connection, didn't save.")).toBeNull();
});

test('a person someone else already placed in another role is never written over', async () => {
  serve({ detail: [
    payload([reqRow(3)], { positions_needed: TWO_ROLES }),
    payload([onShift(3, 'Barback')], { positions_needed: TWO_ROLES }),
  ] });
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  tap(await screen.findByRole('button', { name: /^Bartender\s*1 open$/ }));
  expect(await screen.findByText(PERSON_MOVED)).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
  // Nothing was written, and the owner is told all the same: the roster moved.
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  expect(await within(row('Person 3')).findByText('Barback')).toBeInTheDocument();
});

test('a server refusal shows the server message, inline', async () => {
  serve({ detail: payload([]) });
  api.post.mockRejectedValueOnce({ status: 404, message: 'User not eligible for assignment.' });
  await opened();
  tap(await screen.findByRole('button', { name: /Tess Marsh/ }));
  tap(await screen.findByRole('button', { name: /^Bartender\s*3 open$/ }));
  expect(await screen.findByText('User not eligible for assignment.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
});

test('a re-read served from cache counts as no connection: nothing is written', async () => {
  serve({ detail: [payload([reqRow(3)]), payload([reqRow(3)], {}, { staleAt: '2026-09-29T17:00:00.000Z' })] });
  await opened();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText("No connection, didn't save.")).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
});

test('a cache-served roster is read-only: banner, no actions, picker offline, Retry re-reads', async () => {
  serve({ detail: [payload([onShift(1), reqRow(3)], {}, { staleAt: '2026-09-29T17:00:00.000Z' }), payload([onShift(1), reqRow(3)])] });
  await opened();
  expect(await screen.findByText('No connection. Staffing actions need the server; the roster below is the cached copy.')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: /Person 3/ }));
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
  tap(screen.getByRole('button', { name: /Person 1/ }));
  expect(screen.getByRole('button', { name: 'Remove from shift' })).toBeDisabled();
  expect(screen.getByPlaceholderText('Search active staff')).toBeDisabled();
  expect(within(row('Tess Marsh')).getByText('Offline')).toBeInTheDocument();
  expect(row('Tess Marsh')).toBeDisabled();
  tap(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByText(/the roster below is the cached copy/)).toBeNull());
  tap(screen.getByRole('button', { name: /Person 3/ }));
  expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
});

test('a finished shift is read-only and says so', async () => {
  serve({ detail: payload([onShift(1), reqRow(3)], { finished: true }) });
  await opened();
  expect(await screen.findByText('Past event · roster is read-only')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: /Person 1/ }));
  expect(screen.queryByRole('button', { name: 'Remove from shift' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.queryByPlaceholderText('Search active staff')).toBeNull();
  expect(screen.queryByText('Bartender 1/3')).toBeNull();
});

test('a cancelled shift is read-only and says so', async () => {
  serve({ detail: payload([onShift(1)], { status: 'cancelled' }) });
  await opened();
  expect(await screen.findByText('Cancelled · roster is read-only')).toBeInTheDocument();
  expect(screen.queryByPlaceholderText('Search active staff')).toBeNull();
});

test('a shift with no declared roles blocks approve and assign and points at the desktop view', async () => {
  serve({ detail: payload([onShift(1), reqRow(3)], { positions_needed: '[]' }) });
  await opened();
  expect(await screen.findByText('No roles are declared on this shift. Staff it from desktop view.')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: /Person 3/ }));
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
  expect(screen.queryByPlaceholderText('Search active staff')).toBeNull();
});

test('a dead shift read calls onDead, never onClose, and renders no roster', async () => {
  serve({ detail: { reject: { status: 404, message: 'Shift not found.' } } });
  const h = mount();
  await waitFor(() => expect(h.onDead).toHaveBeenCalledTimes(1));
  expect(h.onClose).not.toHaveBeenCalled();
});

test('a denied shift read without an onDead handler closes the sheet', async () => {
  serve({ detail: { reject: { status: 403, message: 'Staffing access required.' } } });
  const onClose = jest.fn();
  render(<AssignmentSheet shiftId={17} onClose={onClose} />);
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

test('a shift id the server refuses (400) is a dead read too, with no Retry', async () => {
  serve({ detail: { reject: { status: 400, message: 'Invalid shift id.' } } });
  const h = mount();
  await waitFor(() => expect(h.onDead).toHaveBeenCalledTimes(1));
  expect(h.onClose).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});

test('a failed first read offers Retry and recovers', async () => {
  serve({ detail: [{ reject: NETWORK }, payload([onShift(1, 'Bartender', { staff_name: 'Lena Park' })])] });
  mount();
  expect(await screen.findByText('Network error. Check your connection.')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Lena Park')).toBeInTheDocument();
});

test('a refused assign from the picker is still shown after the picker has closed', async () => {
  serve({ detail: [
    payload([onShift(1), onShift(2)]),
    payload([onShift(1), onShift(2), onShift(4, 'Bartender', { staff_name: 'Someone Else' })]),
  ] });
  await opened();
  tap(await screen.findByRole('button', { name: /Tess Marsh/ }));
  tap(await screen.findByRole('button', { name: /^Bartender\s*1 open$/ }));
  // The slot filled: no role is open, so the picker is gone, and the refusal is NOT gone with it.
  const box = await screen.findByRole('alert');
  expect(within(box).getByText(ROSTER_MOVED)).toBeInTheDocument();
  expect(within(box).getByText('Tess Marsh · Assign as Bartender')).toHaveClass('m-fail-who');
  expect(screen.queryByPlaceholderText('Search active staff')).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
  tap(within(box).getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a failed save under its row says what it was', async () => {
  serve({ detail: payload([]) });
  api.post.mockRejectedValueOnce(NETWORK);
  await opened();
  tap(await screen.findByRole('button', { name: /Tess Marsh/ }));
  tap(await screen.findByRole('button', { name: /^Bartender\s*3 open$/ }));
  expect(await within(person('Tess Marsh')).findByText(NO_SAVE)).toBeInTheDocument();
  expect(within(person('Tess Marsh')).getByText('Tess Marsh · Assign as Bartender')).toBeInTheDocument();
});

test('typing in the search field never detaches a failed save from its person', async () => {
  serve({ detail: payload([]) });
  api.post.mockRejectedValueOnce(NETWORK);
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Tess Marsh/ }));
  tap(await screen.findByRole('button', { name: /^Bartender\s*3 open$/ }));
  expect(await within(person('Tess Marsh')).findByText(NO_SAVE)).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('Search active staff'), { target: { value: 'ana' } });
  // Ana matches; Tess does not, and stays because her save is still open.
  expect(screen.getByRole('group', { name: 'Ana Flores' })).toBeInTheDocument();
  expect(within(person('Tess Marsh')).getByText(NO_SAVE)).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Person 1' })).toBeNull();
  // Under her own row, not at the top of the sheet.
  expect(within(person('Tess Marsh')).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  // Ana is assigned; the one red box on screen is still Tess's, and its Retry writes Tess.
  tap(screen.getByRole('button', { name: /Ana Flores/ }));
  tap(await screen.findByRole('button', { name: /^Bartender\s*3 open$/ }));
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  expect(api.post).toHaveBeenLastCalledWith('/shifts/17/assign', { user_id: 5, position: 'Bartender' });
  tap(within(person('Tess Marsh')).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(3));
  expect(api.post).toHaveBeenLastCalledWith('/shifts/17/assign', { user_id: 9, position: 'Bartender' });
});

test('Approve is never sent for an applicant who withdrew, or was denied, since the sheet opened', async () => {
  for (const after of [[], [reqRow(3, { staff_name: 'Jo Ellis', status: 'denied' })]]) {
    serve({ detail: [payload([reqRow(3, { staff_name: 'Jo Ellis' })]), payload(after)] });
    const view = render(<AssignmentSheet shiftId={17} {...handlers()} />);
    tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
    tap(screen.getByRole('button', { name: 'Approve' }));
    const box = await screen.findByRole('alert');
    expect(within(box).getByText(PERSON_MOVED)).toBeInTheDocument();
    expect(within(box).getByText('Jo Ellis · Approve as Bartender')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    view.unmount();
  }
});

test('"Approve as" is not sent either for an applicant who withdrew since the sheet opened', async () => {
  const both = '["Bartender","Barback"]';
  serve({ detail: [
    payload([reqRow(3, { staff_name: 'Jo Ellis', requested_positions: both })], { positions_needed: TWO_ROLES }),
    payload([], { positions_needed: TWO_ROLES }),
  ] });
  await opened();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  tap(await screen.findByRole('button', { name: /^Barback\s*1 open$/ }));
  const box = await screen.findByRole('alert');
  expect(within(box).getByText(PERSON_MOVED)).toBeInTheDocument();
  expect(within(box).getByText('Jo Ellis · Approve as Barback')).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
});

test('a plain Approve is not sent once the applicant has re-ranked to another role', async () => {
  const asked = (roles) => reqRow(3, { staff_name: 'Jo Ellis', requested_positions: roles });
  serve({ detail: [
    payload([onShift(1, 'Barback'), asked('["Bartender"]')], { positions_needed: TWO_ROLES }),
    payload([onShift(1, 'Barback'), asked('["Barback"]')], { positions_needed: TWO_ROLES }),
  ] });
  await opened();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await within(person('Jo Ellis')).findByText(PERSON_MOVED)).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
  // The fresh roster is on screen: they now wait for Barback.
  expect(within(person('Jo Ellis')).getByText('Waitlisted')).toBeInTheDocument();
});

test('a person in the picker who has applied on their own since is not assigned over their request', async () => {
  serve({ detail: [
    payload([]),
    payload([reqRow(50, { user_id: 9, staff_name: 'Tess Marsh', requested_positions: '["Bartender"]' })]),
  ] });
  await opened();
  tap(await screen.findByRole('button', { name: /Tess Marsh/ }));
  tap(await screen.findByRole('button', { name: /^Bartender\s*3 open$/ }));
  const box = await screen.findByRole('alert');
  expect(within(box).getByText(PERSON_MOVED)).toBeInTheDocument();
  expect(within(box).getByText('Tess Marsh · Assign as Bartender')).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
  // She is an applicant now, on the roster list, and no longer in the picker.
  expect(within(person('Tess Marsh')).getByText('Pending')).toBeInTheDocument();
  expect(screen.getAllByRole('group', { name: 'Tess Marsh' })).toHaveLength(1);
});

test('a staff list answered from the cache locks the picker, says so, and leaves the roster live', async () => {
  serve({ detail: payload([onShift(1), reqRow(3)]), staffStaleAt: STAMP });
  const h = await opened();
  expect(screen.getByText(PICKER_STORED)).toBeInTheDocument();
  // The roster arrived live, and the sheet does not say otherwise.
  expect(screen.queryByText(/the roster below is the cached copy/)).toBeNull();
  expect(within(row('Tess Marsh')).getByText('Offline')).toBeInTheDocument();
  expect(row('Tess Marsh')).toBeDisabled();
  expect(screen.getByPlaceholderText('Search active staff')).toBeDisabled();
  // None of the roster's actions reads the staff list.
  tap(screen.getByRole('button', { name: /Person 1/ }));
  expect(screen.getByRole('button', { name: 'Remove from shift' })).toBeEnabled();
  tap(screen.getByRole('button', { name: /Person 3/ }));
  expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
  tap(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  expect(api.post).toHaveBeenCalledWith('/shifts/17/assign', { user_id: 103, position: 'Bartender' });
});

test('Retry on the stored staff list, answered live, unlocks the picker', async () => {
  serve({ detail: payload([reqRow(3)]), staffStaleAt: STAMP });
  await opened();
  expect(screen.getByText(PICKER_STORED)).toBeInTheDocument();
  serve({ detail: payload([reqRow(3)]) });
  tap(screen.getByRole('button', { name: 'Retry' }));   // the note's: nothing else offers one
  await waitFor(() => expect(screen.queryByText(PICKER_STORED)).toBeNull());
  expect(await screen.findByRole('button', { name: /Tess Marsh/ })).toBeEnabled();
  expect(within(row('Tess Marsh')).getByText('Assign')).toBeInTheDocument();
});

test('Retry on the stored staff list that then FAILS says so, and holds nothing else back', async () => {
  serve({ detail: payload([reqRow(3)]), staffStaleAt: STAMP });
  await opened();
  expect(screen.getByText(PICKER_STORED)).toBeInTheDocument();
  serve({ detail: payload([reqRow(3)]), staffFails: true });
  tap(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText("Couldn't load the staff list.")).toBeInTheDocument();
  // The stored copy is gone with the list: nothing is marked as one.
  expect(screen.queryByText(PICKER_STORED)).toBeNull();
  tap(screen.getByRole('button', { name: /Person 3/ }));
  expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
});

test('told by its owner that the shift is open, the sheet reads the staff list at once, beside the roster', async () => {
  const roster = held();
  api.get.mockImplementation((url) => (url === '/admin/active-staff'
    ? Promise.resolve({ data: { staff: STAFF } })
    : roster.entry));
  mount({ assignable: true });
  await waitFor(() => expect(staffReads()).toHaveLength(1));
  expect(screen.getByText('Loading the roster')).toBeInTheDocument();
  // The list is not drawn before the roster says a role is open.
  expect(screen.queryByRole('button', { name: /Tess Marsh/ })).toBeNull();
  await act(async () => { roster.release(payload([])); });
  expect(await screen.findByRole('button', { name: /Tess Marsh/ })).toBeInTheDocument();
  expect(staffReads()).toHaveLength(1);
});

test('an owner that says the shift is open is not believed over a roster that says it is full', async () => {
  serve({ detail: payload([onShift(1)], { positions_needed: '["Bartender"]' }) });
  await opened({ assignable: true });
  expect(screen.queryByPlaceholderText('Search active staff')).toBeNull();
  expect(screen.queryByRole('button', { name: /Tess Marsh/ })).toBeNull();
});

test('the picker says it is loading, never that everyone is already on the shift', async () => {
  const staff = held();
  serve({ detail: payload([]), staffHeld: staff.entry });
  mount();
  expect(await screen.findByText('Loading the staff list')).toBeInTheDocument();
  expect(screen.queryByText('Everyone active is already on this shift.')).toBeNull();
  await act(async () => { staff.release({ data: { staff: [] } }); });
  expect(screen.getByText('Everyone active is already on this shift.')).toBeInTheDocument();
  expect(screen.queryByText('Loading the staff list')).toBeNull();
});

test('a shift that can take nobody never reads the picker', async () => {
  for (const shiftOver of [{ positions_needed: '["Bartender"]' }, { finished: true }, { positions_needed: '[]' }, { status: 'cancelled' }]) {
    serve({ detail: payload([onShift(1)], shiftOver) });
    const view = render(<AssignmentSheet shiftId={17} {...handlers()} />);
    await screen.findByText('Person 1');
    view.unmount();
  }
  expect(staffReads()).toHaveLength(0);
});

test('a save tells the owner at once, and does not read the picker again', async () => {
  const after = held();
  let reads = 0;
  api.get.mockImplementation((url, config) => {
    if (url === '/admin/active-staff') return Promise.resolve({ data: { staff: STAFF } });
    reads += 1;
    // 1 the roster, 2 the re-read before the write, 3 the roster after it (held).
    return reads < 3 ? Promise.resolve(payload([reqRow(3)])) : after.entry;
  });
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  await screen.findByText('Tess Marsh');
  tap(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  expect(reads).toBe(3);                       // the owner heard before the roster came back
  // The save has landed, so the sheet is free: the read still out is for display.
  expect(screen.queryByRole('status')).toBeNull();
  tap(screen.getByRole('button', { name: 'Close' }));
  expect(h.onClose).toHaveBeenCalledTimes(1);
  await act(async () => { after.release(payload([onShift(3)])); });
  expect(await screen.findByText('Bartender · just assigned')).toBeInTheDocument();
  expect(staffReads()).toHaveLength(1);
});

test('a save that lands and cannot be re-read says so, and never shows a stored copy as the result', async () => {
  for (const answer of ['fails', 'stale']) {
    let reads = 0;
    api.get.mockImplementation((url) => {
      if (url === '/admin/active-staff') return Promise.resolve({ data: { staff: STAFF } });
      reads += 1;
      if (reads < 3) return Promise.resolve(payload([reqRow(3)]));
      if (reads === 3) return answer === 'fails' ? Promise.reject(NETWORK) : Promise.resolve(payload([reqRow(3)], {}, { staleAt: '2026-09-29T17:00:00Z' }));
      return Promise.resolve(payload([onShift(3)]));
    });
    const h = handlers();
    const view = render(<AssignmentSheet shiftId={17} {...h} />);
    tap(await screen.findByRole('button', { name: /Person 3/ }));
    tap(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Saved. The roster below could not be refreshed and may be out of date.')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(h.onChanged).toHaveBeenCalledTimes(1);
    // Not the offline banner, and not a failed save: the write landed.
    expect(screen.queryByText(/the roster below is the cached copy/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // The roster on screen is older than the save, so it still lists Person 3
    // as an applicant. It must not ALSO offer them in the picker.
    tap(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Bartender · just assigned')).toBeInTheDocument();
    expect(screen.queryByText(/could not be refreshed/)).toBeNull();
    expect(api.post).toHaveBeenCalledTimes(1);
    view.unmount();
    api.post.mockClear();
  }
});

test('a person just assigned leaves the picker even when the roster could not be read again, and is back once removed', async () => {
  let reads = 0;
  let tessOn = false;
  api.get.mockImplementation((url, config) => {
    if (url === '/admin/active-staff') return Promise.resolve({ data: { staff: STAFF } });
    reads += 1;
    // 3 is the read after the save: it fails, so the roster on screen predates the save.
    if (reads === 3) return Promise.reject(NETWORK);
    return Promise.resolve(payload(tessOn ? [onShift(9, 'Bartender', { user_id: 9, staff_name: 'Tess Marsh' })] : []));
  });
  api.post.mockImplementation(() => { tessOn = true; return Promise.resolve({ data: {} }); });
  api.delete.mockImplementation(() => { tessOn = false; return Promise.resolve({ data: { success: true } }); });
  const h = await opened();
  tap(screen.getByRole('button', { name: /Tess Marsh/ }));
  tap(await screen.findByRole('button', { name: /^Bartender\s*3 open$/ }));
  expect(await screen.findByText(SAVED_BEHIND)).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Tess Marsh' })).toBeNull();
  expect(screen.getByRole('group', { name: 'Ana Flores' })).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Retry' }));              // the note's: nothing else offers one
  tap(await screen.findByRole('button', { name: /Tess Marsh/ }));   // on the roster now
  tap(screen.getByRole('button', { name: 'Remove from shift' }));
  tap(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(within(row('Tess Marsh')).getByText('Assign')).toBeInTheDocument());
  expect(api.delete).toHaveBeenCalledWith('/shifts/requests/9');
});

// Reads, in order: 1 the roster, 2 the re-read before the save, 3 the read
// after it (fails, so the note goes up), 4 the re-read before the next write,
// 5 the read after that write's refusal.
const ONE_SLOT = { positions_needed: '["Bartender"]' };
function behindThen({ fourth, fifth }) {
  let reads = 0;
  api.get.mockImplementation((url) => {
    if (url === '/admin/active-staff') return Promise.resolve({ data: { staff: STAFF } });
    reads += 1;
    if (reads < 3) return Promise.resolve(payload([reqRow(3), reqRow(4)], ONE_SLOT));
    if (reads === 3) return Promise.reject(NETWORK);
    return reads === 4 ? fourth() : fifth();
  });
}
const truth = () => Promise.resolve(payload([onShift(3), reqRow(4)], ONE_SLOT));
const before = () => Promise.resolve(payload([reqRow(3), reqRow(4)], ONE_SLOT));

test('the saved-but-behind note goes when a refusal puts the fresh roster on screen, even if the read after it fails', async () => {
  behindThen({ fourth: truth, fifth: () => Promise.reject(NETWORK) });
  await opened();
  tap(screen.getByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText(SAVED_BEHIND)).toBeInTheDocument();
  // The roster on screen still shows the slot open, so Person 4 can be tapped.
  tap(screen.getByRole('button', { name: /Person 4/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await within(person('Person 4')).findByText(ROSTER_MOVED)).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText(SAVED_BEHIND)).toBeNull());
  expect(api.post).toHaveBeenCalledTimes(1);
});

test('the saved-but-behind note goes when the read after a SERVER refusal lands live', async () => {
  // The re-read still shows the slot open, so the write is sent, and the server refuses it.
  behindThen({ fourth: before, fifth: truth });
  api.post.mockResolvedValueOnce({ data: {} }).mockRejectedValueOnce({ status: 409, message: 'That role is full.' });
  await opened();
  tap(screen.getByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText(SAVED_BEHIND)).toBeInTheDocument();
  tap(screen.getByRole('button', { name: /Person 4/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await within(person('Person 4')).findByText('That role is full.')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText(SAVED_BEHIND)).toBeNull());
  expect(api.post).toHaveBeenCalledTimes(2);
});

test('a refusal whose own read fails does not claim a save that never happened', async () => {
  // No save has landed in this sheet: a server refusal, then a failed read, leaves no note.
  let reads = 0;
  api.get.mockImplementation((url) => {
    if (url === '/admin/active-staff') return Promise.resolve({ data: { staff: STAFF } });
    reads += 1;
    return reads < 3 ? before() : Promise.reject(NETWORK);
  });
  api.post.mockRejectedValueOnce({ status: 409, message: 'That role is full.' });
  const h = await opened();
  tap(screen.getByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await within(person('Person 3')).findByText('That role is full.')).toBeInTheDocument();
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(reads).toBe(3));
  expect(screen.queryByText(SAVED_BEHIND)).toBeNull();
});

test('the scrim and Escape do not close the sheet while a save is in flight', async () => {
  const write = held();
  serve({ detail: payload([reqRow(3)]) });
  api.post.mockImplementationOnce(() => write.entry);
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  tap(screen.getByRole('button', { name: 'Close' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(h.onClose).not.toHaveBeenCalled();
  await act(async () => { write.release({ data: {} }); });
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  tap(screen.getByRole('button', { name: 'Close' }));
  expect(h.onClose).toHaveBeenCalledTimes(1);
});

test('the row being written says Saving until the write settles, and no other row does', async () => {
  const write = held();
  serve({ detail: payload([reqRow(3), reqRow(4)]) });
  api.post.mockImplementationOnce(() => write.entry);
  const h = await opened();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  expect(screen.queryByRole('status')).toBeNull();
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await within(person('Person 3')).findByRole('status')).toHaveTextContent(/^Saving$/);
  expect(screen.getAllByRole('status')).toHaveLength(1);
  // The rows the write has disabled are dimmed by a class on the body, which has no role to ask for.
  // eslint-disable-next-line testing-library/no-node-access
  expect(screen.getByRole('dialog').querySelector('.m-sheet-body')).toHaveClass('m-sheet-busy');
  expect(within(person('Person 4')).queryByRole('status')).toBeNull();
  await act(async () => { write.release({ data: {} }); });
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
});

test('a save in the picker says Saving under the person, and a failed one replaces it with the failure', async () => {
  const write = held();
  serve({ detail: payload([]) });
  api.post.mockImplementationOnce(() => write.entry);
  await opened();
  tap(await screen.findByRole('button', { name: /Tess Marsh/ }));
  tap(await screen.findByRole('button', { name: /^Bartender\s*3 open$/ }));
  expect(await within(person('Tess Marsh')).findByRole('status')).toHaveTextContent('Saving');
  await act(async () => { write.refuse(NETWORK); });
  expect(within(person('Tess Marsh')).getByText(NO_SAVE)).toBeInTheDocument();
  expect(screen.queryByRole('status')).toBeNull();
});

test('Retry on a save whose row has left the screen says Saving at the top', async () => {
  const again = held();
  let reads = 0;
  // The sheet's own reads, then the re-read before each write.
  const full = payload([onShift(1), onShift(2), onShift(4, 'Bartender', { staff_name: 'Someone Else' })]);
  api.get.mockImplementation((url, opts) => {
    if (url === '/admin/active-staff') return Promise.resolve({ data: { staff: STAFF } });
    if (opts) return Promise.resolve(reads === 0 ? payload([onShift(1), onShift(2)]) : full);
    reads += 1;
    return reads === 1 ? Promise.resolve(full) : again.entry;
  });
  await opened();
  tap(await screen.findByRole('button', { name: /Tess Marsh/ }));
  tap(await screen.findByRole('button', { name: /^Bartender\s*1 open$/ }));
  const box = await screen.findByRole('alert');
  expect(within(box).getByText(ROSTER_MOVED)).toBeInTheDocument();
  tap(within(box).getByRole('button', { name: 'Retry' }));
  // With no row to sit under, the line says whose save it is.
  expect(await screen.findByRole('status')).toHaveTextContent('Saving · Tess Marsh · Assign as Bartender');
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => { again.release(full); });
  expect(await screen.findByRole('alert')).toHaveTextContent('Tess Marsh · Assign as Bartender');
  expect(screen.queryByRole('status')).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test('a picker that failed to load says so and the roster still works', async () => {
  serve({ detail: payload([onShift(1, 'Bartender', { staff_name: 'Lena Park' })]), staffFails: true });
  await opened();
  expect(await screen.findByText('Lena Park')).toBeInTheDocument();
  expect(await screen.findByText("Couldn't load the staff list.")).toBeInTheDocument();
  expect(screen.queryByText(/No active staff matches/)).toBeNull();
  tap(screen.getByRole('button', { name: /Lena Park/ }));
  expect(screen.getByRole('button', { name: 'Remove from shift' })).toBeEnabled();
});

test('focusUserId opens that person, once', async () => {
  serve({ detail: payload([onShift(1), reqRow(3)]) });
  await opened({ focusUserId: '103' });
  expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
  tap(screen.getByRole('button', { name: /Person 3/ }));   // collapse it
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull());
});

test('a dead read that lands after the sheet was closed calls nobody', async () => {
  let reject;
  api.get.mockImplementation((url) => (url === '/shifts/detail/17'
    ? new Promise((resolve, no) => { reject = no; })
    : Promise.resolve({ data: { staff: STAFF } })));
  const h = handlers();
  const { unmount } = render(<AssignmentSheet shiftId={17} {...h} />);
  await waitFor(() => expect(reject).toBeInstanceOf(Function));
  unmount();
  await act(async () => { reject({ status: 404, message: 'Shift not found.' }); });
  expect(h.onDead).not.toHaveBeenCalled();
  expect(h.onClose).not.toHaveBeenCalled();
});

test('Tab stays inside the sheet, in both directions', async () => {
  serve({ detail: payload([onShift(1, 'Bartender', { staff_name: 'Lena Park' })]) });
  await opened();
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('Ana Flores');
  const first = within(dialog).getByRole('button', { name: /Lena Park/ });
  const stops = within(dialog).getAllByRole('button');
  const last = stops[stops.length - 1];
  last.focus();
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
  expect(last).toHaveFocus();
  dialog.focus();
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
  expect(last).toHaveFocus();
});

test('Escape in the search field clears nothing of ours and closes only from an empty field', async () => {
  serve({ detail: payload([]) });
  const h = await opened();
  await screen.findByText('Ana Flores');
  const field = screen.getByPlaceholderText('Search active staff');
  fireEvent.change(field, { target: { value: 'te' } });
  fireEvent.keyDown(field, { key: 'Escape' });
  expect(h.onClose).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: '' } });
  fireEvent.keyDown(field, { key: 'Escape' });
  expect(h.onClose).toHaveBeenCalledTimes(1);
});

test('the scrim and Escape both close; the sheet itself does not', async () => {
  serve({ detail: payload([]) });
  const h = await opened();
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  tap(dialog);
  expect(h.onClose).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: 'Close' }));
  expect(h.onClose).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(h.onClose).toHaveBeenCalledTimes(2);
});
