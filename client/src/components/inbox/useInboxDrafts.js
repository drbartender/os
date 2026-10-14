import { useCallback, useMemo, useRef, useState } from 'react';
import { newSendId } from './sendId';

const EMPTY = { text: '', line: null, sendId: null };

// Drafts, keyed by person (spec 4.3 and 10): the text, the chosen FROM line,
// and the send id. The page holds them ABOVE its phone/desktop fork, so a
// poll, a refetch, or opening someone else never touches a draft.
//
// The send id: minted on the first tap of an attempt and reused by every
// retry until the server settles that attempt (ReplyBar decides: only the
// text route's own answers settle it), so a double tap or a retry can never
// text twice. Once the server has settled an attempt it answers that id the
// same way forever, so spend() drops it and the next tap is a new attempt.
export default function useInboxDrafts() {
  const store = useRef({});
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const put = useCallback((key, patch) => {
    store.current = { ...store.current, [key]: { ...EMPTY, ...store.current[key], ...patch } };
    bump();
  }, [bump]);

  const draftOf = useCallback((key) => store.current[key] || EMPTY, []);
  const setText = useCallback((key, text) => put(key, { text }), [put]);
  const setLine = useCallback((key, line) => put(key, { line }), [put]);
  const sendIdFor = useCallback((key) => {
    const cur = store.current[key];
    if (cur && cur.sendId) return cur.sendId;
    const id = newSendId();
    put(key, { sendId: id });
    return id;
  }, [put]);
  const spend = useCallback((key) => put(key, { sendId: null }), [put]);
  const clear = useCallback((key) => put(key, { text: '', sendId: null }), [put]);

  // One stable object: the owner re-renders on every change (the version
  // bump) and passes it down, so effects that take it never re-run per key.
  return useMemo(
    () => ({ draftOf, setText, setLine, sendIdFor, spend, clear }),
    [draftOf, setText, setLine, sendIdFor, spend, clear]
  );
}
