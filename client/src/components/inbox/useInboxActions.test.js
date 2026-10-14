import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import api from '../../utils/api';
import { ToastProvider } from '../../context/ToastContext';
import useInboxActions from './useInboxActions';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { post: jest.fn(), delete: jest.fn() } }));

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
  const refresh = mount();
  await act(async () => { await actions.act('c-1', 'done', { name: 'Avery Example' }); });
  expect(api.post).toHaveBeenCalledWith('/admin/inbox/c-1/actions', { action: 'done' });
  expect(screen.getByText('Done. Moved to Handled.')).toBeInTheDocument();
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
