import '@testing-library/jest-dom';
import { renderHook, act, waitFor } from '@testing-library/react';
import api from '../../utils/api';
import useInboxList, { POLL_MS } from './useInboxList';
import useInboxItem from './useInboxItem';
import { readLastGood, resetLastGood } from './lastGood';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));

const LIST = {
  generated_at: '2026-10-06T19:40:00.000Z', ai: { status: 'on' },
  waiting: [{ person_key: 'c-1', name: 'Avery Example', waiting_since: '2026-10-06T10:00:00.000Z', channels: ['text_888'], state: { type: null } }],
  snoozed: [], handled: [], feeds: [],
};
const fail = () => Promise.reject({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' });

beforeEach(() => {
  resetLastGood();
  window.localStorage.clear();
});

describe('useInboxList', () => {
  test('loads, then remembers the last good load in memory and storage', async () => {
    api.get.mockResolvedValue({ data: LIST });
    const { result } = renderHook(() => useInboxList());
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data.waiting).toHaveLength(1);
    expect(api.get).toHaveBeenCalledWith('/admin/inbox');
    expect(readLastGood()).toMatchObject({ waiting: 1 });
    expect(JSON.parse(window.localStorage.getItem('drb.inbox.lastGood'))).toMatchObject({ waiting: 1 });
  });

  test('an error is never an empty list: a failed poll drops the data and offers the last good load', async () => {
    api.get.mockResolvedValueOnce({ data: LIST }).mockImplementation(fail);
    const { result } = renderHook(() => useInboxList());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.status).toBe('error');
    expect(result.current.data).toBeNull();
    expect(result.current.lastGood).toMatchObject({ waiting: 1 });
  });

  test('a first load that fails reads the last good load from storage', async () => {
    window.localStorage.setItem('drb.inbox.lastGood', JSON.stringify({ at: '2026-10-06T19:12:00.000Z', waiting: 8 }));
    api.get.mockImplementation(fail);
    const { result } = renderHook(() => useInboxList());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.lastGood).toEqual({ at: '2026-10-06T19:12:00.000Z', waiting: 8 });
  });

  test('blocked storage still keeps the last good load in memory', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    api.get.mockResolvedValueOnce({ data: LIST }).mockImplementation(fail);
    const { result } = renderHook(() => useInboxList());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.lastGood).toMatchObject({ waiting: 1 });
    setItem.mockRestore();
  });

  test('polls every 60 s while visible and refreshes when the tab comes back', async () => {
    jest.useFakeTimers();
    api.get.mockResolvedValue({ data: LIST });
    const { result } = renderHook(() => useInboxList());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(api.get).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(POLL_MS); });
    expect(api.get).toHaveBeenCalledTimes(2);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(api.get).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });
});

describe('useInboxItem', () => {
  const ITEM = { person: { person_key: 'c-1', name: 'Avery Example', kind: 'client' }, waiting: true, thread: [], reply: { mode: 'none' } };

  test('no key is idle and asks for nothing; a key that is not a person key is gone without a request', async () => {
    const { result, rerender } = renderHook(({ k }) => useInboxItem(k), { initialProps: { k: undefined } });
    expect(result.current.status).toBe('idle');
    rerender({ k: 'zz-9' });
    await waitFor(() => expect(result.current.status).toBe('gone'));
    expect(api.get).not.toHaveBeenCalled();
  });

  test('a valid key loads the item through a 404-tolerant read', async () => {
    api.get.mockResolvedValue({ status: 200, data: ITEM });
    const { result } = renderHook(() => useInboxItem('c-1'));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data.person.name).toBe('Avery Example');
    const [url, config] = api.get.mock.calls[0];
    expect(url).toBe('/admin/inbox/c-1');
    expect(config.validateStatus(404)).toBe(true);
    expect(config.validateStatus(500)).toBe(false);
  });

  test('404 INBOX_MOVED with a hint is moved; a bare 404 is gone', async () => {
    api.get.mockResolvedValue({ status: 404, data: { code: 'INBOX_MOVED', moved_to: 'c-77' } });
    const { result: moved } = renderHook(() => useInboxItem('p-3125550100'));
    await waitFor(() => expect(moved.current.status).toBe('moved'));
    expect(moved.current.movedTo).toBe('c-77');
    api.get.mockResolvedValue({ status: 404, data: { code: 'NOT_FOUND' } });
    const { result: gone } = renderHook(() => useInboxItem('c-404'));
    await waitFor(() => expect(gone.current.status).toBe('gone'));
  });

  test('a key the server refuses (400) is gone, never an error whose Retry cannot succeed', async () => {
    api.get.mockRejectedValue({ status: 400, code: 'VALIDATION_ERROR', message: 'That is not an Inbox person.' });
    const { result } = renderHook(() => useInboxItem('c-12'));
    await waitFor(() => expect(result.current.status).toBe('gone'));
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  test('a failed first read is an error; a failed poll keeps the item on screen', async () => {
    api.get.mockImplementation(fail);
    const { result: first } = renderHook(() => useInboxItem('c-2'));
    await waitFor(() => expect(first.current.status).toBe('error'));

    api.get.mockResolvedValueOnce({ status: 200, data: ITEM }).mockImplementation(fail);
    const { result } = renderHook(() => useInboxItem('c-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.status).toBe('ready');
    expect(result.current.refreshFailed).toBe(true);
    expect(result.current.data.person.name).toBe('Avery Example');
  });

  test('another key never shows the previous person, not even for one render', async () => {
    api.get.mockResolvedValue({ status: 200, data: ITEM });
    // Every render is recorded with the key it was asked for. rerender runs
    // inside act, so result.current only shows the state after the effects
    // flushed, never the render in between. A stale render answers with the
    // previous key, so the pairing is checked against the key it was asked for.
    const renders = [];
    const { result, rerender } = renderHook(({ k }) => {
      const r = useInboxItem(k);
      renders.push({ asked: k, key: r.key, status: r.status, data: r.data });
      return r;
    }, { initialProps: { k: 'c-1' } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    api.get.mockReturnValue(new Promise(() => {}));
    const from = renders.length;
    rerender({ k: 'c-2' });
    const after = renders.slice(from);
    expect(after.length).toBeGreaterThan(0);
    // No render asked for c-2 may carry c-1's person.
    expect(after.filter((r) => r.data && r.data.person.person_key === 'c-1')).toEqual([]);
    after.forEach((r) => expect(r).toEqual({ asked: 'c-2', key: 'c-2', status: 'loading', data: null }));
  });
});
