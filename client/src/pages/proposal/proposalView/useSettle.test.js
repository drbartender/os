import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSettle } from './useSettle';

const paidRow = { id: 774, status: 'balance_paid', amount_paid: '550', total_price: '550' };
const staleRow = { id: 774, status: 'accepted', amount_paid: '0', total_price: '350' };
const flush = () => new Promise((r) => setTimeout(r, 0));

// settlePoll sleeps 1.5s between attempts; the hook must accept an injected
// poll interval so these tests stay fast. 0ms is enough to yield the event loop.
const fast = { intervalMs: 0 };

test('a row already in a paid state goes straight to paid without polling or refetching', async () => {
  const fetchState = jest.fn();
  const fetchProposal = jest.fn();
  const onSettled = jest.fn();
  const { result } = renderHook(() => useSettle({ active: true, proposal: paidRow, fetchState, fetchProposal, onSettled, onFallback: jest.fn(), ...fast }));
  await waitFor(() => expect(result.current).toBe('paid'));
  expect(fetchState).not.toHaveBeenCalled();
  expect(fetchProposal).not.toHaveBeenCalled();
  expect(onSettled).not.toHaveBeenCalled();
});

test('inactive (no redirect) stays idle', async () => {
  const { result } = renderHook(() => useSettle({ active: false, proposal: staleRow, fetchState: jest.fn(), fetchProposal: jest.fn(), onSettled: jest.fn(), onFallback: jest.fn(), ...fast }));
  await flush();
  expect(result.current).toBe('idle');
});

test('a stale row settles on the third poll, refetches once, and survives its own state changes', async () => {
  const states = [{ status: 'accepted' }, { status: 'accepted' }, { status: 'balance_paid' }];
  let i = 0;
  const fetchState = jest.fn(async () => states[i++]);
  const fetchProposal = jest.fn(async () => paidRow);
  const onSettled = jest.fn();
  const { result } = renderHook(() => useSettle({ active: true, proposal: staleRow, fetchState, fetchProposal, onSettled, onFallback: jest.fn(), ...fast }));
  await waitFor(() => expect(result.current).toBe('settling'));
  await waitFor(() => expect(result.current).toBe('paid'));
  expect(fetchState).toHaveBeenCalledTimes(3);
  expect(fetchProposal).toHaveBeenCalledTimes(1);
  expect(onSettled).toHaveBeenCalledWith(paidRow);
});

test('an exhausted poll reaches fallback with the reason', async () => {
  const fetchState = jest.fn(async () => ({ status: 'accepted' }));
  const onFallback = jest.fn();
  const { result } = renderHook(() => useSettle({ active: true, proposal: staleRow, fetchState, fetchProposal: jest.fn(), onSettled: jest.fn(), onFallback, attempts: 3, ...fast }));
  await waitFor(() => expect(result.current).toBe('fallback'));
  expect(fetchState).toHaveBeenCalledTimes(3);
  expect(onFallback).toHaveBeenCalledWith('exhausted');
});

test('a blocked poll (4xx) reaches fallback at once', async () => {
  const fetchState = jest.fn(async () => { throw Object.assign(new Error('429'), { response: { status: 429 } }); });
  const onFallback = jest.fn();
  const { result } = renderHook(() => useSettle({ active: true, proposal: staleRow, fetchState, fetchProposal: jest.fn(), onSettled: jest.fn(), onFallback, ...fast }));
  await waitFor(() => expect(result.current).toBe('fallback'));
  expect(fetchState).toHaveBeenCalledTimes(1);
  expect(onFallback).toHaveBeenCalledWith('blocked');
});

test('a settled poll whose refetch fails reaches fallback, never renders the stale row as paid', async () => {
  const fetchState = jest.fn(async () => ({ status: 'balance_paid' }));
  const fetchProposal = jest.fn(async () => { throw new Error('network'); });
  const onFallback = jest.fn();
  const onSettled = jest.fn();
  const { result } = renderHook(() => useSettle({ active: true, proposal: staleRow, fetchState, fetchProposal, onSettled, onFallback, ...fast }));
  await waitFor(() => expect(result.current).toBe('fallback'));
  expect(onSettled).not.toHaveBeenCalled();
  expect(onFallback).toHaveBeenCalledWith('refetch_failed');
});

test('the parent re-rendering with a fresh proposal object does not restart the settle', async () => {
  const fetchState = jest.fn(async () => ({ status: 'balance_paid' }));
  const fetchProposal = jest.fn(async () => paidRow);
  const { result, rerender } = renderHook((props) => useSettle(props), {
    initialProps: { active: true, proposal: staleRow, fetchState, fetchProposal, onSettled: jest.fn(), onFallback: jest.fn(), ...fast },
  });
  await waitFor(() => expect(result.current).toBe('paid'));
  await act(async () => { rerender({ active: true, proposal: { ...paidRow }, fetchState, fetchProposal, onSettled: jest.fn(), onFallback: jest.fn(), ...fast }); });
  await flush();
  expect(fetchState).toHaveBeenCalledTimes(1);
  expect(fetchProposal).toHaveBeenCalledTimes(1);
  expect(result.current).toBe('paid');
});

test('unmount cancels an in-flight poll', async () => {
  let resolveFirst;
  const fetchState = jest.fn(() => new Promise((r) => { resolveFirst = r; }));
  const onFallback = jest.fn();
  const onSettled = jest.fn();
  const { result, unmount } = renderHook(() => useSettle({ active: true, proposal: staleRow, fetchState, fetchProposal: jest.fn(), onSettled, onFallback, ...fast }));
  await waitFor(() => expect(result.current).toBe('settling'));
  unmount();
  await act(async () => { resolveFirst({ status: 'balance_paid' }); await flush(); });
  expect(onSettled).not.toHaveBeenCalled();
  expect(onFallback).not.toHaveBeenCalled();
});

// The two properties the hook's own comment claims but the tests above never
// exercised: React 18 StrictMode's simulated mount/unmount/mount, and a
// re-render that changes the settle effect's OWN deps while the poll is still
// pending. Both are the shape of the first draft's bug (cancel on anything but
// unmount), so both are pinned with the poll deliberately held open.
test('survives a StrictMode remount while the poll is in flight', async () => {
  let resolveFirst;
  const fetchState = jest.fn(() => new Promise((r) => { resolveFirst = r; }));
  const fetchProposal = jest.fn(async () => paidRow);
  const onSettled = jest.fn();
  const { result } = renderHook(
    () => useSettle({ active: true, proposal: staleRow, fetchState, fetchProposal, onSettled, onFallback: jest.fn(), ...fast }),
    { wrapper: React.StrictMode },
  );
  await waitFor(() => expect(result.current).toBe('settling'));
  resolveFirst({ status: 'balance_paid' });
  await waitFor(() => expect(result.current).toBe('paid'));
  expect(fetchState).toHaveBeenCalledTimes(1);
  expect(fetchProposal).toHaveBeenCalledTimes(1);
  expect(onSettled).toHaveBeenCalledTimes(1);
});

test('a dep-changing re-render mid-poll does not restart or cancel the settle', async () => {
  let resolveFirst;
  const fetchState = jest.fn(() => new Promise((r) => { resolveFirst = r; }));
  const fetchProposal = jest.fn(async () => paidRow);
  const onSettled = jest.fn();
  const initialProps = { active: true, proposal: staleRow, fetchState, fetchProposal, onSettled, onFallback: jest.fn(), ...fast };
  const { result, rerender } = renderHook((props) => useSettle(props), { initialProps });
  await waitFor(() => expect(result.current).toBe('settling'));
  // status is in the settle effect's dependency array, so this re-runs it. The
  // latch must return and the pending poll must survive untouched.
  rerender({ ...initialProps, proposal: { ...staleRow, status: 'viewed' } });
  resolveFirst({ status: 'balance_paid' });
  await waitFor(() => expect(result.current).toBe('paid'));
  expect(fetchState).toHaveBeenCalledTimes(1);
  expect(fetchProposal).toHaveBeenCalledTimes(1);
  expect(onSettled).toHaveBeenCalledTimes(1);
});

test('a throwing onSettled still lands on paid: the refetch decides the phase, not the callback', async () => {
  const fetchState = jest.fn(async () => ({ status: 'balance_paid' }));
  const fetchProposal = jest.fn(async () => paidRow);
  const onSettled = jest.fn(() => { throw new Error('toast exploded'); });
  const onFallback = jest.fn();
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { result } = renderHook(() => useSettle({ active: true, proposal: staleRow, fetchState, fetchProposal, onSettled, onFallback, ...fast }));
    await waitFor(() => expect(result.current).toBe('paid'));
    expect(onSettled).toHaveBeenCalledWith(paidRow);
    expect(onFallback).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test('a settled poll whose refetch comes back unsettled reaches fallback, never renders the stale row as paid', async () => {
  const fetchState = jest.fn(async () => ({ status: 'balance_paid' }));
  const fetchProposal = jest.fn(async () => staleRow);
  const onFallback = jest.fn();
  const onSettled = jest.fn();
  const { result } = renderHook(() => useSettle({ active: true, proposal: staleRow, fetchState, fetchProposal, onSettled, onFallback, ...fast }));
  await waitFor(() => expect(result.current).toBe('fallback'));
  expect(onSettled).not.toHaveBeenCalled();
  expect(onFallback).toHaveBeenCalledWith('refetch_unsettled');
});
