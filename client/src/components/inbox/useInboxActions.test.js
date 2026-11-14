import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

test('Done toasts "Done. Moved to Handled." with Undo, and Undo marks the action undone', async () => {
  api.post.mockResolvedValue({ data: { id: 314 } });
  api.delete.mockResolvedValue({ status: 204 });
  api.get.mockResolvedValue({ status: 200, data: { waiting: false, state: { has_task: false, tasks_only: false } } });
  const refresh = mount();
  await act(async () => { await actions.act('c-1', 'done', { name: 'Avery Example' }); });
  expect(api.post).toHaveBeenCalledWith('/admin/inbox/c-1/actions', { action: 'done' });
  expect(await screen.findByText('Done. Moved to Handled.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/inbox/actions/314'));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('Done. Moved to Handled.')).toBeNull();
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
// task, so when an open task still holds the person (the item's
// state.has_task, read back after the Done lands) the toast says so, with the
// same Undo. With no task it is unchanged; when the read fails the toast is a
// plain "Done.", which is true either way.
test('Done on a person an open menu task still holds says so, with the same Undo; with no task it is unchanged; a failed read says only Done', async () => {
  api.post.mockResolvedValue({ data: { id: 41 } });
  api.delete.mockResolvedValue({ status: 204 });
  api.get.mockResolvedValueOnce({ status: 200, data: { waiting: true, state: { has_task: true, tasks_only: true } } });
  mount();
  await act(async () => { await actions.act('c-1', 'done', { name: 'Avery Example' }); });
  expect(api.get).toHaveBeenLastCalledWith('/admin/inbox/c-1', expect.any(Object));
  expect(await screen.findByText('Done. Still waiting on the menu.')).toBeInTheDocument();
  expect(screen.queryByText('Done. Moved to Handled.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/inbox/actions/41'));
  api.get.mockResolvedValueOnce({ status: 200, data: { waiting: false, state: { has_task: false, tasks_only: false } } });
  await act(async () => { await actions.act('c-2', 'done', { name: 'Jo Test' }); });
  expect(await screen.findByText('Done. Moved to Handled.')).toBeInTheDocument();
  api.get.mockRejectedValueOnce({ status: 500, message: 'down' });
  await act(async () => { await actions.act('c-3', 'done', { name: 'Kim Test' }); });
  expect(await screen.findByText('Done.')).toBeInTheDocument();
  expect(screen.getAllByText('Done. Moved to Handled.')).toHaveLength(1);
  expect(screen.queryAllByText('Done. Still waiting on the menu.')).toHaveLength(0);
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
