import '@testing-library/jest-dom';
import { renderHook, act } from '@testing-library/react';
import useInboxDrafts from './useInboxDrafts';
import { newSendId } from './sendId';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('drafts are kept per person and survive any number of re-renders', () => {
  const { result, rerender } = renderHook(() => useInboxDrafts());
  act(() => { result.current.setText('c-1', 'See you at six'); });
  act(() => { result.current.setText('s-2', 'Can you cover?'); });
  act(() => { result.current.setLine('c-1', '1922'); });
  rerender();
  rerender();
  expect(result.current.draftOf('c-1')).toMatchObject({ text: 'See you at six', line: '1922' });
  expect(result.current.draftOf('s-2').text).toBe('Can you cover?');
  expect(result.current.draftOf('c-9')).toEqual({ text: '', line: null, sendId: null });
});

test('a send id is minted once per attempt and reused until the server answers', () => {
  const { result } = renderHook(() => useInboxDrafts());
  let first;
  let again;
  act(() => { first = result.current.sendIdFor('c-1'); });
  act(() => { again = result.current.sendIdFor('c-1'); });
  expect(first).toMatch(UUID_V4);
  expect(again).toBe(first);
  // The server answered: that id is spent, the next tap is a new attempt.
  let next;
  act(() => { result.current.spend('c-1'); });
  act(() => { next = result.current.sendIdFor('c-1'); });
  expect(next).toMatch(UUID_V4);
  expect(next).not.toBe(first);
});

test('clear empties the text and spends the id, and leaves other people alone', () => {
  const { result } = renderHook(() => useInboxDrafts());
  act(() => { result.current.setText('c-1', 'Sent this'); result.current.setText('c-2', 'Still typing'); });
  let id;
  act(() => { id = result.current.sendIdFor('c-1'); });
  act(() => { result.current.clear('c-1'); });
  expect(result.current.draftOf('c-1')).toMatchObject({ text: '', sendId: null });
  expect(result.current.draftOf('c-2').text).toBe('Still typing');
  let fresh;
  act(() => { fresh = result.current.sendIdFor('c-1'); });
  expect(fresh).not.toBe(id);
});

test('the send id is a v4 UUID with or without crypto.randomUUID', () => {
  const saved = window.crypto;
  try {
    Object.defineProperty(window, 'crypto', { value: undefined, configurable: true });
    const ids = new Set(Array.from({ length: 50 }, () => newSendId()));
    ids.forEach((id) => expect(id).toMatch(UUID_V4));
    expect(ids.size).toBe(50);
    Object.defineProperty(window, 'crypto', { value: { randomUUID: () => '11111111-2222-4333-8444-555555555555' }, configurable: true });
    expect(newSendId()).toBe('11111111-2222-4333-8444-555555555555');
  } finally {
    Object.defineProperty(window, 'crypto', { value: saved, configurable: true });
  }
});
