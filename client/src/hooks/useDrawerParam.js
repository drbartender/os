import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

// location.state flag on a history entry this hook pushed. close() reads it to
// know whether going back one entry is safe.
const SHEET_STATE = 'mSheet';
const KEYS = ['drawer', 'drawerId', 'drawerFocus'];

function withoutDrawer(params) {
  const next = new URLSearchParams(params);
  KEYS.forEach((k) => next.delete(k));
  return next;
}

// Is there an entry behind this one? BrowserRouter keeps its position in
// window.history.state.idx. Where that is unknown (MemoryRouter in tests) the
// answer is yes, because the flag on the entry is then the only evidence.
function canGoBack() {
  const state = typeof window !== 'undefined' && window.history ? window.history.state : null;
  if (!state || typeof state.idx !== 'number') return true;
  return state.idx > 0;
}

/**
 * URL-synced drawer state. Reads/writes `?drawer=<kind>&drawerId=<id>` and the
 * optional `&drawerFocus=<id>`. Layered on top of whatever other query params
 * the page uses, never touching them.
 *
 * Usage:
 *   const drawer = useDrawerParam();
 *   drawer.kind  === 'event' when a drawer is open
 *   drawer.id    === '<id>' when a drawer is open
 *   drawer.open('event', e.id)
 *   drawer.close()
 *
 * Two history behaviours:
 *
 * DEFAULT (every desktop caller): open and close REPLACE the current entry. A
 * drawer is page state, not a navigation. Pushing made every open and every
 * close stack a history entry, so the Back button walked through drawer-toggle
 * states (re-opening drawers in a loop) instead of returning to the previous
 * page. Keep both `replace: true`.
 *
 * `{ push: true, kinds: ['shift'] }` (phone bottom sheets, spec
 * 2026-08-13-mobile-admin section 3): for the listed kinds, open PUSHES one
 * entry, so Android's hardware Back closes the sheet and stays on the page.
 * close() pops that same entry, so opening and closing a sheet any number of
 * times leaves history exactly as it found it. A sheet that arrives by deep
 * link or cold route restore has no entry behind it, so one is seeded: the
 * current entry is replaced by the bare page and the sheet is pushed on top.
 * A kind that is not listed keeps the default, so a desktop drawer link opened
 * on the phone never gains an entry for a sheet that does not exist. Omitting
 * `kinds` pushes for every kind.
 *
 * close() acts ONCE per history entry. A pop lands a moment after it is asked
 * for, and a second close() in that moment (a second tap on the scrim) popped
 * a second entry and walked the user off the page.
 */
export default function useDrawerParam({ push = false, kinds = null } = {}) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const kind = params.get('drawer');
  const id = params.get('drawerId');
  const focus = params.get('drawerFocus');
  const pushed = !!(location.state && location.state[SHEET_STATE]);
  // A string, so an inline array from the caller cannot churn the callbacks.
  const kindList = Array.isArray(kinds) ? kinds.join(',') : null;
  const pushes = useCallback(
    (k) => push && (kindList === null || kindList.split(',').includes(k)),
    [push, kindList]
  );

  const open = useCallback((newKind, newId, { focus: newFocus } = {}) => {
    const next = new URLSearchParams(params);
    next.set('drawer', newKind);
    next.set('drawerId', String(newId));
    if (newFocus === undefined || newFocus === null) next.delete('drawerFocus');
    else next.set('drawerFocus', String(newFocus));
    if (pushes(newKind)) setParams(next, { state: { [SHEET_STATE]: true } });
    else setParams(next, { replace: true });
  }, [params, setParams, pushes]);

  // Set by close(), cleared when the location changes: by the close landing,
  // or by anything else that moved the page. Cleared on a CHANGE and not
  // compared by key, because Forward brings the same entry back with the same
  // key, and the sheet it reopens must close again.
  const closing = useRef(false);
  useEffect(() => { closing.current = false; }, [location.key]);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    // Pop only an entry this hook pushed AND that has something behind it. An
    // entry that carries the flag with nothing behind it (a duplicated tab, a
    // history the browser trimmed) would otherwise never close.
    if (pushed && pushes(kind) && canGoBack()) { navigate(-1); return; }
    setParams(withoutDrawer(params), { replace: true });
  }, [params, setParams, pushes, pushed, kind, navigate]);

  // Seed an entry behind a sheet that has none. The ref latch is what makes
  // this safe under StrictMode, which runs an effect twice with the same
  // closure: the second run sees the same location.key and stops.
  const seededFor = useRef(null);
  useEffect(() => {
    // Digits only: every sheet is addressed by a numeric id, and the owners
    // mount a sheet only for one. A malformed id gets no entry seeded for a
    // sheet that will never show.
    if (!kind || !id || !/^\d+$/.test(id) || pushed || !pushes(kind)) return;
    if (seededFor.current === location.key) return;
    seededFor.current = location.key;
    const bare = withoutDrawer(params).toString();
    navigate({ pathname: location.pathname, search: bare ? `?${bare}` : '' }, { replace: true });
    navigate({ pathname: location.pathname, search: location.search }, { state: { [SHEET_STATE]: true } });
    // params is derived from location.search, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushes, kind, id, pushed, location.key, location.pathname, location.search, navigate]);

  return { kind, id, focus, open, close };
}

// Builds a same-page href that opens a drawer, preserving all other query
// params. For real links (cmd-click new tab) instead of onClick drawer.open.
export function drawerHref(searchParams, kind, id) {
  const next = new URLSearchParams(searchParams);
  next.set('drawer', kind);
  next.set('drawerId', String(id));
  return `?${next.toString()}`;
}
