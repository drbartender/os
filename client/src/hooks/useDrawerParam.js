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

  const open = useCallback((newKind, newId) => {
    const next = new URLSearchParams(params);
    next.set('drawer', newKind);
    next.set('drawerId', String(newId));
    setParams(next, { replace: false });
  }, [params, setParams]);

  const close = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete('drawer');
    next.delete('drawerId');
    setParams(next, { replace: false });
  }, [params, setParams]);

  return { kind, id, open, close };
}
