import { useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

// URL-backed view state for admin list/dashboard screens (admin cross-nav
// spec). Declared keys only; anything else in the query string (drawer,
// drawerId) passes through untouched. Defaults are omitted from the URL so
// /events stays /events, and every write replaces the history entry so
// typing and filter flips never create Back stops: Back always crosses
// pages, never filter states.
//
// `defaults` is captured on first render and treated as immutable, so an
// inline object literal is safe (no identity footgun for effect deps).
// Values are plain strings; enum clamping is caller-side:
//   const tab = TABS.includes(state.tab) ? state.tab : DEFAULTS.tab;
export default function useUrlListState(defaults) {
  const defaultsRef = useRef(defaults);
  const d = defaultsRef.current;
  const [searchParams, setSearchParams] = useSearchParams();

  const state = useMemo(() => {
    const out = {};
    for (const key of Object.keys(d)) {
      const raw = searchParams.get(key);
      out[key] = raw === null || raw === '' ? d[key] : raw;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const setState = useCallback((patch) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in d)) continue;
        if (value === undefined || value === null || value === '' || String(value) === String(d[key])) {
          next.delete(key);
        } else {
          next.set(key, String(value));
        }
      }
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSearchParams]);

  return [state, setState];
}
