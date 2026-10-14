import { useCallback, useEffect, useRef, useState } from 'react';
import { getInbox } from './inboxApi';
import { readLastGood, rememberLastGood } from './lastGood';

export const POLL_MS = 60000;

// The Inbox list (spec 4.1, 4.7 and 10): GET /admin/inbox on mount, every 60 s
// while the tab is visible, and the moment the tab comes back into view, like
// the badge counts. `status` is 'loading' only until the first answer. A
// failed load is 'error' with NO data, whatever was on screen before: an
// error never renders as an empty (or a stale) list. The page shows the error
// card with the last good load instead. Only the newest request may answer.
export default function useInboxList() {
  const [state, setState] = useState({ status: 'loading', data: null, pending: true });
  const seq = useRef(0);
  const alive = useRef(true);

  const load = useCallback(() => {
    seq.current += 1;
    const mine = seq.current;
    setState((prev) => ({ ...prev, pending: true }));
    return getInbox()
      .then((res) => {
        if (!alive.current || mine !== seq.current) return;
        const data = res.data || {};
        rememberLastGood((data.waiting || []).length, new Date().toISOString());
        setState({ status: 'ready', data, pending: false });
      })
      .catch(() => {
        if (!alive.current || mine !== seq.current) return;
        setState({ status: 'error', data: null, pending: false });
      });
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    const tick = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  return {
    status: state.status,
    data: state.data,
    pending: state.pending,
    lastGood: state.status === 'error' ? readLastGood() : null,
    refresh: load,
  };
}
