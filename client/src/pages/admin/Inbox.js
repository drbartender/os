// Inbox (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { useMobileView } from '../../context/MobileViewContext';
import { useToast } from '../../context/ToastContext';
import InboxPhone from '../mobile/InboxPhone';
import useInboxList from '../../components/inbox/useInboxList';
import useInboxItem from '../../components/inbox/useInboxItem';
import useInboxDrafts from '../../components/inbox/useInboxDrafts';
import useInboxActions from '../../components/inbox/useInboxActions';
import useNow from '../../components/inbox/useNow';
import { ListPane, ThreadPane } from '../../components/inbox/DesktopPanes';
import { ContextPane } from '../../components/inbox/ContextViews';
import { contextModel } from '../../components/inbox/inboxContext';
import { firstWaitingKey, isPersonKey, sortWaiting } from '../../components/inbox/inboxFormat';

// Inbox (spec docs/superpowers/specs/2026-10-06-inbox-design.md; design
// docs/design-artifacts/2026-10-06-inbox/). One route, /inbox/:personKey?, so
// this component stays mounted between the list and an opened item: the list
// keeps polling, and the drafts held here survive every refetch, every
// person switch and the phone's list and item screens.
//
// The fork lives here (spec 10): at phone width InboxPhone renders unless the
// screen is pinned to Desktop view (screen keys inbox and inbox-item); the
// desktop is three panes. Seen (spec 4.2): only a DELIBERATE open marks a
// person seen, meaning the URL names them (a tap, a link, Back to them). The
// desktop's own pick of the longest wait never writes the URL, so it never
// marks anyone seen, on the first load or after Done.
//
// That pick holds still: it is made when there is none (the first load, or a
// list that was empty) and again after a Done or Snooze, and a click opens
// someone through the URL instead. A poll never moves it, not even when that
// person leaves Waiting (their item still loads, with its banner), and a
// failed poll never clears it, so the thread and the composer stay put while
// the list pane shows its error card.

export default function Inbox() {
  const { personKey } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { isPhone, desktopView } = useMobileView();
  const phone = isPhone && !desktopView(personKey ? 'inbox-item' : 'inbox');
  const { refreshBadges } = useOutletContext() || {};
  const nowMs = useNow();
  const drafts = useInboxDrafts();
  const list = useInboxList();
  // The person just closed on the desktop, skipped by a new pick until the
  // list reload that no longer has them lands.
  const [skipKey, setSkipKey] = useState(null);
  const [pick, setPick] = useState(null);
  const waiting = list.data ? sortWaiting(list.data.waiting) : [];
  const autoKey = !phone && !personKey ? pick || firstWaitingKey(waiting, skipKey) : null;
  // A new pick is held from the render that made it.
  useEffect(() => { if (autoKey && autoKey !== pick) setPick(autoKey); }, [autoKey, pick]);
  const itemKey = personKey || autoKey;
  const item = useInboxItem(itemKey);
  const [busy, setBusy] = useState(false);

  // After any tap or send: the list, the item and the badges (spec 10).
  const live = useRef({});
  live.current = { list, item, itemKey, refreshBadges };
  const refresh = useCallback(({ list: doList = true, item: doItem = true } = {}) => {
    const cur = live.current;
    if (doList) cur.list.refresh();
    if (doItem) cur.item.refresh();
    if (cur.refreshBadges) cur.refreshBadges();
  }, []);
  const openKey = useCallback(() => live.current.itemKey, []);
  const actions = useInboxActions({ refresh, openKey });

  const seenFor = useRef(null);
  useEffect(() => {
    if (!personKey) { seenFor.current = null; return; }
    if (!isPersonKey(personKey) || seenFor.current === personKey) return;
    seenFor.current = personKey;
    actions.markSeen(personKey);
  }, [personKey, actions]);

  // An unknown number that became a client: follow the server's hint. The
  // desktop's own pick follows it in place (no URL, so no seen), and the list
  // catches up.
  useEffect(() => {
    if (item.status !== 'moved') return;
    if (personKey && item.key === personKey) {
      toast.info('This conversation moved.');
      navigate(`/inbox/${item.movedTo}`, { replace: true });
    } else {
      setPick(item.movedTo);
      refresh({ item: false });
    }
  }, [item.status, item.key, item.movedTo, personKey, navigate, toast, refresh]);

  useEffect(() => { setSkipKey(null); }, [list.data]);

  const open = useCallback((key) => navigate(`/inbox/${key}`), [navigate]);
  const backToList = useCallback(() => navigate('/inbox', { replace: true }), [navigate]);

  // The person the URL names right now, and whether the page is still up. A
  // tap's answer reads both when it lands, never the key from when the tap
  // was made: by then the user may have opened someone else, or left the
  // Inbox (navigate still works after this page unmounts).
  const urlKey = useRef(personKey);
  urlKey.current = personKey;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Done and Snooze leave the item: the phone goes back to the list, the
  // desktop moves to the next person on its own (no seen write). Only while
  // that item is still the one open: an answer that lands after the user
  // opened someone else, or left the Inbox, still refreshes and toasts, and
  // leaves them where they are. The desktop picks again when the person who
  // left was its pick, or the URL's (which it is about to drop).
  const run = useCallback(async (key, action, opts) => {
    setBusy(true);
    const ok = await actions.act(key, action, opts);
    setBusy(false);
    if (ok && (action === 'done' || action === 'snooze')) {
      const wasOpen = urlKey.current === key;
      setSkipKey(key);
      setPick((p) => (p === key || wasOpen ? null : p));
      if (mounted.current && wasOpen) backToList();
    }
    return ok;
  }, [actions, backToList]);

  const shared = { list, waiting, item, itemKey, deliberate: Boolean(personKey), drafts, nowMs, busy, run, open, refresh, backToList };
  if (phone) return <InboxPhone {...shared} />;

  const model = item.status === 'ready' && item.data
    ? contextModel(item.data.context, { legalHold: item.data.legal_hold })
    : null;
  return (
    <div className="ib-page">
      <div className="page-header">
        <div>
          <div className="page-title">Inbox</div>
          <div className="page-subtitle">Everyone waiting on a reply from Dallas or Zul. Longest wait first, one row per person.</div>
        </div>
      </div>
      <div className="ib-grid">
        <ListPane {...shared} />
        <ThreadPane {...shared} />
        <ContextPane model={model} />
      </div>
    </div>
  );
}
