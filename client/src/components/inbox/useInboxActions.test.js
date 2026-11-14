import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import api from '../../utils/api';
import { ToastProvider } from '../../context/ToastContext';
import useInboxActions from './useInboxActions';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { post: jest.fn(), delete: jest.fn(), get: jest.fn() } }));

// The real ToastProvider, so the Undo button is the one the page shows.
let actions;
function Harness({ refresh, openKey }) {
  actions = useInboxActions({ refresh, openKey });
  return null;
}
function mount(refresh = jest.fn()) {
  render(<ToastProvider><Harness refresh={refresh} /></ToastProvider>);
  return refresh;
}

// The item read back after a Done, as GET /admin/inbox/:personKey answers:
// its status, and state.has_task, which the server sets for a snoozed person
// a task holds as well as a waiting one (payload.js).
const handledItem = { status: 200, data: { status: 'handled', waiting: false, state: { has_task: false, tasks_only: false } } };
const taskItem = { status: 200, data: { status: 'waiting', waiting: true, state: { has_task: true, tasks_only: true } } };
const waitingItem = { status: 200, data: { status: 'waiting', waiting: true, state: { has_task: false, tasks_only: false } } };
const snoozedTaskItem = { status: 200, data: { status: 'snoozed', waiting: false, state: { has_task: true, tasks_only: true } } };

test('Done toasts "Done. <Name> moved to Handled." with Undo, and Undo marks the action undone', async () => {
  api.post.mockResolvedValue({ data: { id: 314 } });
  api.delete.mockResolvedValue({ status: 204 });
  api.get.mockResolvedValue(handledItem);
  const refresh = mount();
  await act(async () => { await actions.act('c-1', 'done', { name: 'Avery Example' }); });
  expect(api.post).toHaveBeenCalledWith('/admin/inbox/c-1/actions', { action: 'done' });
  expect(await screen.findByText('Done. Avery Example moved to Handled.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/inbox/actions/314'));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('Done. Avery Example moved to Handled.')).toBeNull();
});

test('Snooze sends until and toasts the Chicago time with Undo; Wake and Reopen say who is back', async () => {
  api.post.mockResolvedValue({ data: { id: 7 } });
  mount();
  await act(async () => { await actions.act('c-1', 'snooze', { until: '2026-10-07T13:00:00.000Z', name: 'Avery Example' }); });
  expect(api.post).toHaveBeenLastCalledWith('/admin/inbox/c-1/actions', { action: 'snooze', until: '2026-10-07T13:00:00.000Z' });
  expect(screen.getByText(/^Snoozed until .*8:00 AM\.$/)).toBeInTheDocument();
  await act(async () => { await actions.act('c-1', 'wake', { name: 'Avery Example' }); });
  expect(screen.getByText('Avery Example is back in Waiting.')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(2);
});

test('claim, take over and release toast without Undo', async () => {
  api.post.mockResolvedValue({ data: { id: 9 } });
  mount();
  await act(async () => { await actions.act('c-1', 'claim', {}); });
  await act(async () => { await actions.act('c-2', 'claim', { takeoverFrom: 'Zul' }); });
  await act(async () => { await actions.act('c-2', 'release', {}); });
  expect(screen.getByText("You're on it.")).toBeInTheDocument();
  expect(screen.getByText('Taken over from Zul.')).toBeInTheDocument();
  expect(screen.getByText('Released. Back to unclaimed.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
});

test('a failed action says so and still refreshes', async () => {
  api.post.mockRejectedValue({ status: 409, code: 'CONFLICT', message: 'That item changed. Try again.' });
  const refresh = mount();
  let ok;
  await act(async () => { ok = await actions.act('c-1', 'done', {}); });
  expect(ok).toBe(false);
  expect(screen.getByText('That item changed. Try again.')).toBeInTheDocument();
  expect(refresh).toHaveBeenCalledTimes(1);
});

// Done and Snooze move the page off the item, so its answer would be thrown
// away; a Wake or Reopen from a list row touches the open item only when it
// is that row's person. The list and the badges refetch every time.
test('after Done or Snooze the item is not re-read; a Wake or Reopen re-reads it only when it is the open one', async () => {
  api.post.mockResolvedValue({ data: { id: 5 } });
  const refresh = jest.fn();
  render(<ToastProvider><Harness refresh={refresh} openKey={() => 'c-1'} /></ToastProvider>);
  await act(async () => { await actions.act('c-1', 'done', { name: 'Avery Example' }); });
  expect(refresh).toHaveBeenLastCalledWith({ item: false });
  await act(async () => { await actions.act('c-1', 'snooze', { until: '2026-10-07T13:00:00.000Z', name: 'Avery Example' }); });
  expect(refresh).toHaveBeenLastCalledWith({ item: false });
  await act(async () => { await actions.act('c-9', 'wake', { name: 'Jo Test' }); });
  expect(refresh).toHaveBeenLastCalledWith({ item: false });
  await act(async () => { await actions.act('c-9', 'reopen', { name: 'Jo Test' }); });
  expect(refresh).toHaveBeenLastCalledWith({ item: false });
  await act(async () => { await actions.act('c-1', 'reopen', { name: 'Avery Example' }); });
  expect(refresh).toHaveBeenLastCalledWith({ item: true });
  await act(async () => { await actions.act('c-1', 'wake', { name: 'Avery Example' }); });
  expect(refresh).toHaveBeenLastCalledWith({ item: true });
  await act(async () => { await actions.act('c-1', 'claim', {}); });
  expect(refresh).toHaveBeenLastCalledWith({ item: true });
  expect(refresh).toHaveBeenCalledTimes(7);
});

test('markSeen posts seen and refreshes the list, not the item', async () => {
  api.post.mockResolvedValue({ status: 204 });
  const refresh = mount();
  await act(async () => { await actions.markSeen('c-1'); });
  expect(api.post).toHaveBeenCalledWith('/admin/inbox/c-1/seen');
  expect(refresh).toHaveBeenCalledWith({ item: false });
});

// Spec 2026-10-19 section 13.2: Done closes the conversation and never a menu
// task, so when an open task still holds the person waiting (the item read
// back after the Done lands has status waiting and state.has_task) the toast
// says so, with the same Undo. Each line names its person, so two Dones in a row never read
// alike; "moved to Handled" is said only when the read-back's own status is
// handled, and a read that fails says a plain "Done.", which is true either way.
test('Done on a person an open menu task still holds says so, with the same Undo; with no task it is unchanged; a failed read says only Done', async () => {
  api.post.mockResolvedValue({ data: { id: 41 } });
  api.delete.mockResolvedValue({ status: 204 });
  api.get.mockResolvedValueOnce(taskItem);
  mount();
  await act(async () => { await actions.act('c-1', 'done', { name: 'Avery Example' }); });
  expect(api.get).toHaveBeenLastCalledWith('/admin/inbox/c-1', expect.any(Object));
  expect(await screen.findByText('Done. Avery Example is still waiting on the menu.')).toBeInTheDocument();
  expect(screen.queryByText(/moved to Handled\.$/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/inbox/actions/41'));
  api.get.mockResolvedValueOnce(handledItem);
  await act(async () => { await actions.act('c-2', 'done', { name: 'Jo Test' }); });
  expect(await screen.findByText('Done. Jo Test moved to Handled.')).toBeInTheDocument();
  api.get.mockRejectedValueOnce({ status: 500, message: 'down' });
  await act(async () => { await actions.act('c-3', 'done', { name: 'Kim Test' }); });
  expect(await screen.findByText('Done.')).toBeInTheDocument();
  expect(screen.getAllByText(/moved to Handled\.$/)).toHaveLength(1);
  expect(screen.queryAllByText(/still waiting on the menu\.$/)).toHaveLength(0);
});

// Two Dones in a row (lane menu-inbox-followups, item 3): each toast names the
// person it closed, so the second never reads as the first, and each toast's
// Undo undoes its own Done.
test('two Dones in a row each name their person, and each Undo undoes its own Done', async () => {
  api.post.mockResolvedValueOnce({ data: { id: 51 } }).mockResolvedValueOnce({ data: { id: 52 } });
  api.delete.mockResolvedValue({ status: 204 });
  api.get.mockReset();
  api.get.mockResolvedValueOnce(taskItem).mockResolvedValueOnce(handledItem);
  mount();
  await act(async () => { await actions.act('c-1', 'done', { name: 'Avery Example' }); });
  await act(async () => { await actions.act('c-2', 'done', { name: 'Jo Test' }); });
  const first = (await screen.findByText('Done. Avery Example is still waiting on the menu.')).closest('.toast');
  const second = (await screen.findByText('Done. Jo Test moved to Handled.')).closest('.toast');
  expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(2);
  fireEvent.click(within(second).getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(1));
  expect(api.delete).toHaveBeenLastCalledWith('/admin/inbox/actions/52');
  fireEvent.click(within(first).getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(2));
  expect(api.delete).toHaveBeenLastCalledWith('/admin/inbox/actions/51');
});

// has_task alone is not "still waiting": the server sets it for a snoozed
// person a task holds too, so a Done whose read-back shows them snoozed says
// a plain "Done.", with its Undo.
test('a Done whose read-back shows the person snoozed under a task says a plain Done, with its Undo', async () => {
  api.post.mockResolvedValue({ data: { id: 81 } });
  api.delete.mockResolvedValue({ status: 204 });
  api.get.mockResolvedValueOnce(snoozedTaskItem);
  mount();
  await act(async () => { await actions.act('c-1', 'done', { name: 'Avery Example' }); });
  expect(await screen.findByText('Done.')).toBeInTheDocument();
  expect(screen.queryAllByText(/waiting on the menu\.$/)).toHaveLength(0);
  expect(screen.queryAllByText(/moved to Handled\.$/i)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/inbox/actions/81'));
});

// "Moved to Handled" only when the read-back says handled: a person waiting
// again (a new message landed between the Done and the read), a quiet one and
// a key that answers 404 each get the plain "Done.", never a guess.
test('a read-back that shows the person waiting again, quiet, or a 404 says a plain Done', async () => {
  api.post.mockResolvedValue({ data: { id: 61 } });
  api.get.mockReset();
  api.get
    .mockResolvedValueOnce(waitingItem)
    .mockResolvedValueOnce({ status: 200, data: { status: 'quiet', waiting: false, state: { has_task: false, tasks_only: false } } })
    .mockResolvedValueOnce({ status: 404, data: { code: 'INBOX_MOVED', moved_to: 'c-9' } });
  mount();
  await act(async () => { await actions.act('c-1', 'done', { name: 'Avery Example' }); });
  await act(async () => { await actions.act('c-2', 'done', { name: 'Jo Test' }); });
  await act(async () => { await actions.act('c-3', 'done', { name: 'Kim Test' }); });
  await waitFor(() => expect(screen.getAllByText('Done.')).toHaveLength(3));
  expect(screen.queryAllByText(/moved to Handled\.$/i)).toHaveLength(0);
  expect(screen.queryAllByText(/waiting on the menu\.$/)).toHaveLength(0);
});

// With no name passed the lines say only what is known, unnamed.
test('with no name the Done lines read unnamed: still waiting on the menu, moved to Handled, or a plain Done', async () => {
  api.post.mockResolvedValue({ data: { id: 71 } });
  api.get.mockReset();
  api.get.mockResolvedValueOnce(taskItem).mockResolvedValueOnce(handledItem).mockResolvedValueOnce(waitingItem);
  mount();
  await act(async () => { await actions.act('c-1', 'done', {}); });
  await act(async () => { await actions.act('c-2', 'done', { name: '' }); });
  await act(async () => { await actions.act('c-3', 'done'); });
  expect(await screen.findByText('Done. Still waiting on the menu.')).toBeInTheDocument();
  expect(await screen.findByText('Done. Moved to Handled.')).toBeInTheDocument();
  expect(await screen.findByText('Done.')).toBeInTheDocument();
});

// The read-back runs a full Inbox load on the server, so nothing waits on it:
// the action resolves and the page refreshes as soon as the Done lands, and a
// read that never answers gives way to a plain "Done." with the same Undo.
test('Done never waits on the read-back: the refresh fires at once, and a read that never answers toasts a plain Done with Undo', async () => {
  jest.useFakeTimers();
  try {
    api.post.mockResolvedValue({ data: { id: 43 } });
    api.get.mockReturnValue(new Promise(() => {}));
    const refresh = mount();
    let ok;
    await act(async () => { ok = await actions.act('c-1', 'done', { name: 'Avery Example' }); });
    expect(ok).toBe(true);
    expect(refresh).toHaveBeenCalledWith({ item: false });
    expect(screen.queryByText(/^Done/)).toBeNull();
    await act(async () => { jest.advanceTimersByTime(4000); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText('Done.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  } finally {
    jest.useRealTimers();
  }
});

test('only Done reads the item back: Snooze, Wake, Reopen and the claims never do', async () => {
  api.post.mockResolvedValue({ data: { id: 42 } });
  api.get.mockClear();
  mount();
  await act(async () => { await actions.act('c-1', 'snooze', { until: '2026-10-07T13:00:00.000Z' }); });
  await act(async () => { await actions.act('c-1', 'wake', { name: 'Avery Example' }); });
  await act(async () => { await actions.act('c-1', 'claim', {}); });
  expect(api.get).not.toHaveBeenCalled();
});
