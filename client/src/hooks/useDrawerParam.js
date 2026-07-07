import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * URL-synced drawer state. Reads/writes `?drawer=<kind>&drawerId=<id>`.
 * Layered on top of whatever other query params the page uses — never touches them.
 *
 * Usage:
 *   const drawer = useDrawerParam();
 *   drawer.kind  === 'event' when a drawer is open
 *   drawer.id    === '<id>' when a drawer is open
 *   drawer.open('event', e.id)
 *   drawer.close()
 */
export default function useDrawerParam() {
  const [params, setParams] = useSearchParams();
  const kind = params.get('drawer');
  const id = params.get('drawerId');

  // Drawer open/close REPLACES the current history entry instead of pushing a
  // new one. A drawer is page state, not a navigation. Pushing made every open
  // and every close stack a history entry, so the Back button walked through
  // drawer-toggle states (re-opening drawers in a loop) instead of returning
  // to the previous page. Keep both `replace: true`.
  const open = useCallback((newKind, newId) => {
    const next = new URLSearchParams(params);
    next.set('drawer', newKind);
    next.set('drawerId', String(newId));
    setParams(next, { replace: true });
  }, [params, setParams]);

  const close = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete('drawer');
    next.delete('drawerId');
    setParams(next, { replace: true });
  }, [params, setParams]);

  return { kind, id, open, close };
}

// Builds a same-page href that opens a drawer, preserving all other query
// params. For real links (cmd-click new tab) instead of onClick drawer.open.
export function drawerHref(searchParams, kind, id) {
  const next = new URLSearchParams(searchParams);
  next.set('drawer', kind);
  next.set('drawerId', String(id));
  return `?${next.toString()}`;
}
