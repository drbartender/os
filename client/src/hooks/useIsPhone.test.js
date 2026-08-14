import '@testing-library/jest-dom';
import { renderHook, act } from '@testing-library/react';
import useIsPhone, { PHONE_BREAKPOINT_PX } from './useIsPhone';

function mockMatchMedia(initialMatches) {
  const listeners = new Set();
  const mql = {
    matches: initialMatches,
    media: '',
    addEventListener: (_evt, fn) => listeners.add(fn),
    removeEventListener: (_evt, fn) => listeners.delete(fn),
  };
  window.matchMedia = jest.fn().mockReturnValue(mql);
  return {
    flip(matches) {
      mql.matches = matches;
      act(() => listeners.forEach((fn) => fn({ matches })));
    },
  };
}

test('reflects the media query and updates on change', () => {
  const m = mockMatchMedia(true);
  const { result } = renderHook(() => useIsPhone());
  expect(result.current).toBe(true);
  m.flip(false);
  expect(result.current).toBe(false);
});

test('queries the one breakpoint constant', () => {
  mockMatchMedia(false);
  renderHook(() => useIsPhone());
  expect(window.matchMedia).toHaveBeenCalledWith(
    `(max-width: ${PHONE_BREAKPOINT_PX - 1}px)`
  );
});
