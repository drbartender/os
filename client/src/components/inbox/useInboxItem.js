import { useCallback, useEffect, useRef, useState } from 'react';
import { getItem } from './inboxApi';
import { isPersonKey } from './inboxFormat';
import { POLL_MS } from './useInboxList';

const IDLE = { key: null, status: 'idle', data: null, movedTo: null, refreshFailed: false };

// One person's item (spec 4.2): GET /admin/inbox/:personKey when the key
// changes, every 60 s while visible, and when the tab comes back. Statuses:
//   idle      no key
//   loading   first read for this key (nothing of another person is kept)
//   ready     data for this key
//   moved     404 INBOX_MOVED with a valid moved_to: the caller follows it
//   gone      404 with no hint, a key that is not a person key at all, or a
//             400 (the server refused the key itself: no retry can fix it)
//   error     the first read failed (a later failed poll keeps the data on
//             screen and sets refreshFailed, so a flaky poll never yanks the
//             composer away mid-sentence)
export default function useInboxItem(personKey) {
  const [state, setState] = useState(IDLE);
  const seq = useRef(0);
  const keyRef = useRef(personKey);
  keyRef.current = personKey;

  const load = useCallback((key) => {
    if (!key) { setState(IDLE); return Promise.resolve(); }
    if (!isPersonKey(key)) { setState({ ...IDLE, key, status: 'gone' }); return Promise.resolve(); }
    seq.current += 1;
    const mine = seq.current;
    const current = () => mine === seq.current && keyRef.current === key;
    return getItem(key)
      .then((res) => {
        if (!current()) return;
        if (res.status === 404) {
          const body = res.data || {};
          const movedTo = body.code === 'INBOX_MOVED' && isPersonKey(body.moved_to) ? body.moved_to : null;
          setState({ ...IDLE, key, status: movedTo ? 'moved' : 'gone', movedTo });
          return;
        }
        setState({ key, status: 'ready', data: res.data, movedTo: null, refreshFailed: false });
      })
      .catch((err) => {
        if (!current()) return;
        if (err && err.status === 400) { setState({ ...IDLE, key, status: 'gone' }); return; }
        setState((prev) => (prev.key === key && prev.data
          ? { ...prev, refreshFailed: true }
          : { ...IDLE, key, status: 'error' }));
      });
  }, []);

  useEffect(() => {
    // A different person: clear first, so nothing of the last one renders.
    setState(personKey ? { ...IDLE, key: personKey, status: 'loading' } : IDLE);
    load(personKey);
    if (!personKey) return undefined;
    const tick = setInterval(() => { if (document.visibilityState === 'visible') load(personKey); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(personKey); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [personKey, load]);

  const refresh = useCallback(() => load(keyRef.current), [load]);
  // A render between the key changing and the effect clearing must not show
  // the previous person: only state for THIS key counts.
  const mineNow = state.key === personKey ? state : { ...IDLE, key: personKey, status: personKey ? 'loading' : 'idle' };
  return { ...mineNow, refresh };
}
