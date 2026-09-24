import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import useUrlListState from '../../hooks/useUrlListState';
import useDrawerParam from '../../hooks/useDrawerParam';
import { groupShiftRows, railParts } from '../../utils/eventCards';
import { formatStaleTime } from '../../utils/staleTime';
import StatusChip from '../../components/adminos/StatusChip';
import Icon from '../../components/adminos/Icon';
import ShiftDrawer from '../../components/adminos/drawers/ShiftDrawer';

// Phone Events list (spec 2026-08-13-mobile-admin section 4 List; benchmark
// docs/design-artifacts/2026-09-15-mobile-admin-shell.dc.html, Events tab).
// Renders INSIDE AdminLayout's scrolling .m-main; the header and tab bar are
// the chrome's. Reads the scoped, event-paged admin feed (GET /shifts?scope=)
// and groups the per-shift rows into one card per event.
//
// Manual shifts (no proposal, so no detail page) open the desktop ShiftDrawer
// here as the no-dead-end interim; lane ma-e2 swaps in the phone sheet and
// owns the push-history Back behavior. This drawer keeps replace semantics.
const PAGE = 60;
const LIST_DEFAULTS = { scope: 'upcoming', needs: '' };
const SCROLL_KEY = (scope, needs) => `m-events-scroll:${scope}:${needs ? 1 : 0}`;
const SKELETONS = [['62%', '44%'], ['70%', '38%'], ['55%', '46%'], ['66%', '40%']];

function scrollHost() { return document.getElementById('main-content'); }

// The restore clamp, pulled out as a pure helper: never scroll past what the
// freshly rendered list can actually show.
function canRestore(host, saved) {
  return saved > 0 && host.scrollHeight - host.clientHeight >= saved;
}

export default function EventsListPhone() {
  const navigate = useNavigate();
  const drawer = useDrawerParam();
  const [listState, setListState] = useUrlListState(LIST_DEFAULTS);
  const scope = listState.scope === 'past' ? 'past' : 'upcoming';
  const needs = scope === 'upcoming' && listState.needs === '1';

  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);      // last envelope minus rows
  const [staleAt, setStaleAt] = useState(null); // x-sw-cached-at when the SW served it
  const [fetchedAt, setFetchedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  // An append that fails must never take the loaded list down with it: the
  // page-level error owns the empty screen, moreError owns the line under
  // Show more, so 60 rendered cards and the scroll offset survive a flaky tap.
  const [moreError, setMoreError] = useState(null);
  // Which list the rows on screen belong to, stamped by the response. The scroll
  // effects below key off this rather than off scope/needs, which change on the
  // tap, one whole round trip before the matching rows arrive.
  const [loadedKey, setLoadedKey] = useState(null);
  const reqSeq = useRef(0);
  const restoredRef = useRef(null);

  const params = useCallback((offset) => {
    const p = { scope, limit: PAGE, offset };
    if (needs) p.needs_staff = 1;
    return p;
  }, [scope, needs]);

  const load = useCallback(async (offset, append) => {
    const seq = ++reqSeq.current;
    // A fresh load clears the page first, so the skeleton is what a scope
    // switch, a chip toggle and Retry all show, and the previous scope's
    // cards never sit under the new toggle. Appends keep the list in place
    // and move the Show more button to its Loading label instead.
    setMoreError(null);
    if (append) setLoadingMore(true); else { setLoading(true); setError(null); setRows([]); restoredRef.current = null; }
    try {
      const res = await api.get('/shifts', { params: params(offset) });
      if (seq !== reqSeq.current) return;                 // a newer request superseded this one
      const { rows: page = [], ...rest } = res.data || {};
      setRows(prev => (append ? prev.concat(page) : page));
      setMeta(rest);
      // An append must never rewrite the staleness label. Page 1 came from the
      // service worker's cache and page 2 off the network is still an append to
      // a mostly-cached list, so a bare assign would quietly drop the
      // "offline copy" line and the amber dot the user is entitled to.
      if (append) { if (res.staleAt) setStaleAt(res.staleAt); } else setStaleAt(res.staleAt || null);
      setFetchedAt(new Date().toISOString());
      if (!append) setLoadedKey(SCROLL_KEY(scope, needs));
    } catch (err) {
      if (seq !== reqSeq.current) return;
      const msg = err && err.message ? err.message : 'Network error. Check your connection.';
      if (append) setMoreError(msg); else setError(msg);
    } finally {
      if (seq === reqSeq.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [params, scope, needs]);

  useEffect(() => { load(0, false); }, [load]);

  // List scroll restore (spec section 9): the scroll container is the chrome's
  // .m-main, keyed per scope + chip so Past does not inherit Upcoming's offset.
  // sessionStorage lives for one launch: Back from a detail restores, a cold
  // launch of the installed app lands at the top on purpose.
  useEffect(() => {
    const host = scrollHost();
    if (!host) return undefined;
    const key = SCROLL_KEY(scope, needs);
    let raf = 0;
    const onScroll = () => {
      // Never write before this list has been restored. On a fresh load the page
      // collapses to the skeleton, the browser clamps scrollTop and fires a
      // scroll, and that clamped value would bury the offset about to be
      // restored. The ref is read live, so it needs no effect dependency.
      if (restoredRef.current !== key || raf) return;
      raf = window.requestAnimationFrame(() => { raf = 0; try { window.sessionStorage.setItem(key, String(host.scrollTop)); } catch { /* storage may be unavailable */ } });
    };
    host.addEventListener('scroll', onScroll, { passive: true });
    return () => { host.removeEventListener('scroll', onScroll); if (raf) window.cancelAnimationFrame(raf); };
  }, [scope, needs]);
  useEffect(() => {
    const key = SCROLL_KEY(scope, needs);
    // loadedKey is what makes this safe across a scope switch: it is stamped by
    // the response, so while the new page is in flight the old rows are still on
    // screen and this must not move them. restoredRef makes it once per load.
    if (loading || !rows.length || loadedKey !== key || restoredRef.current === key) return;
    const host = scrollHost();
    if (!host) return;
    let saved = 0;
    try { saved = Number(window.sessionStorage.getItem(key) || 0); } catch { saved = 0; }
    if (canRestore(host, saved)) host.scrollTop = saved;
    restoredRef.current = key;
    // rows is deliberately absent: an append must not re-scroll, and loadedKey
    // already identifies the fresh load this restore belongs to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, loadedKey, scope, needs]);

  const cards = useMemo(() => groupShiftRows(rows), [rows]);
  const cachedTime = formatStaleTime(staleAt);
  const liveTime = formatStaleTime(fetchedAt);
  const totalEvents = meta ? Number(meta.total_events || 0) : 0;
  const scopeEvents = meta ? Number(meta.scope_events || 0) : 0;
  const hasMore = !!(meta && meta.has_more);
  const needsCount = meta ? Number(meta.needs_staff_events || 0) : 0;

  const onTap = (card) => {
    if (card.tapTarget.kind === 'shift') drawer.open('shift', card.tapTarget.id);
    else navigate(`/events/${card.tapTarget.id}`);
  };

  // Benchmark renderVals: the chip's empty state is "Fully staffed" only when
  // the scope has events at all; an empty calendar says so even with the chip on.
  let empty = null;
  if (!loading && !error && cards.length === 0) {
    if (needs && scopeEvents > 0) empty = { ok: true, icon: 'check', title: 'Fully staffed', body: 'Every upcoming shift is covered. New applications will show up here.' };
    else if (scope === 'past') empty = { icon: 'calendar', title: 'No past events', body: 'Finished events will land here.' };
    else empty = { icon: 'calendar', title: 'Nothing on the calendar', body: 'Booked proposals land here on their event date.' };
  }

  return (
    <div>
      <div className="m-listbar">
        <div className="m-seg" role="radiogroup" aria-label="Scope">
          <button type="button" role="radio" aria-checked={scope === 'upcoming'} className={`m-seg-btn${scope === 'upcoming' ? ' active' : ''}`}
            onClick={() => scope !== 'upcoming' && setListState({ scope: '' })}>Upcoming</button>
          <button type="button" role="radio" aria-checked={scope === 'past'} className={`m-seg-btn${scope === 'past' ? ' active' : ''}`}
            onClick={() => scope !== 'past' && setListState({ scope: 'past', needs: '' })}>Past</button>
        </div>
        {scope === 'upcoming' && (
          <button type="button" className={`m-chip-toggle${needs ? ' on' : ''}`} aria-pressed={needs}
            onClick={() => setListState({ needs: needs ? '' : '1' })}>
            {/* The count waits for the envelope: rendering 0 during the first
                load makes the chip read "Needs staff 0" and then jump. */}
            Needs staff{meta && <span className="m-chip-count">{needsCount}</span>}
          </button>
        )}
      </div>

      {loading && cards.length === 0 && !error && (
        <>
          {/* "first sync" is literal: the note retires once any response has landed. */}
          {!fetchedAt && <div className="m-skel-note">first sync · fetching events</div>}
          {SKELETONS.map(([w1, w2], i) => (
            <div key={i} className="m-card m-card-skel" aria-hidden="true">
              <span className="m-skel-rail" />
              <span className="m-card-body" style={{ gap: 9 }}>
                <span className="m-skel-bar" style={{ width: w1 }} />
                <span className="m-skel-bar thin" style={{ width: w2 }} />
              </span>
            </div>
          ))}
        </>
      )}

      {error && rows.length === 0 && (
        <div className="m-empty" role="alert">
          <div className="m-empty-title">Couldn't load events</div>
          <div className="m-empty-body">{error}</div>
          <button type="button" className="m-retry-btn" onClick={() => load(0, false)}>Retry</button>
        </div>
      )}

      {!loading && (!error || rows.length > 0) && (
        <>
          {(cachedTime || liveTime) && (
            <div className="m-stale">
              {cachedTime && <span className="m-stale-dot" aria-hidden="true" />}
              <span>{cachedTime ? 'offline copy · as of' : 'as of'} <span className="m-stale-time">{cachedTime || liveTime}</span></span>
            </div>
          )}
          {cards.map(card => <EventCard key={card.key} card={card} past={scope === 'past'} onTap={onTap} />)}
          {empty && (
            <div className={`m-empty${empty.ok ? ' ok' : ''}`}>
              <Icon name={empty.icon} size={28} />
              <div className="m-empty-title">{empty.title}</div>
              <div className="m-empty-body">{empty.body}</div>
            </div>
          )}
          {hasMore && (
            <button type="button" className="m-card m-card-more" onClick={() => load(meta.next_offset, true)} disabled={loadingMore}>
              <span className="m-showmore">{loadingMore ? 'Loading' : 'Show more'}</span>
              <span className="m-shownof">{cards.length} of {totalEvents}</span>
            </button>
          )}
          {moreError && (
            <div className="m-more-error" role="alert">
              <span>Couldn't load more. {moreError}</span>
              <button type="button" className="m-retry-btn" onClick={() => meta && load(meta.next_offset, true)}>Retry</button>
            </div>
          )}
          {!hasMore && !needs && cards.length > 0 && (
            <div className="m-end"><span>{scope === 'past' ? 'End of history' : 'End of upcoming'} · {totalEvents} {totalEvents === 1 ? 'event' : 'events'}</span></div>
          )}
        </>
      )}

      {/* Mounted only while open: the closed desktop drawer is position: fixed at
          translateX(100%), which parks a full drawer's width off the right edge
          and trips the phone-viewport overflow probe on every Events page. */}
      {drawer.kind === 'shift' && drawer.id ? (
        <ShiftDrawer
          open
          shiftId={Number(drawer.id)}
          onClose={drawer.close}
          onUpdate={() => load(0, false)}
        />
      ) : null}
    </div>
  );
}

function EventCard({ card, past, onTap }) {
  const rail = card.ymd ? railParts(card.ymd) : { dow: '', day: '', mon: '' };
  const fracClass = past ? 'm-frac past' : card.full ? 'm-frac full' : 'm-frac';
  // No aria-label: the accessible name is the card's own content (rail, title,
  // meta, fraction, chips). A label string would have hidden the fraction and
  // the chips from a screen reader, which is most of what the card says.
  return (
    <button type="button" className={`m-card${card.cancelled ? ' m-card-cancelled' : ''}`} onClick={() => onTap(card)}>
      <span className={`m-rail${card.isToday && !past ? ' today' : ''}`}>
        <span className="m-rail-dow">{rail.dow}</span>
        <span className="m-rail-day">{rail.day}</span>
        <span className="m-rail-mon">{card.isToday && !past ? 'TODAY' : rail.mon}</span>
      </span>
      <span className="m-card-body">
        <span className="m-card-head">
          <span className="m-card-title">{card.clientName}</span>
          {card.guests != null && <span className="m-card-guests">{card.guests} <small>GUESTS</small></span>}
        </span>
        {/* The kind gets its own line (Dallas, 2026-09-24): beside the name it
            was ellipsised on nearly every card. The meta line names the town
            (card.place); the full address is the detail page's job. A manual
            shift has no structured venue and keeps its free-text location. */}
        {card.kind ? <span className="m-card-kind">{card.kind}</span> : null}
        <span className="m-card-meta">{[card.timeRange, card.place || card.venue].filter(Boolean).join(' · ')}</span>
        <span className="m-card-foot">
          {card.cancelled ? (
            <StatusChip kind="neutral">Cancelled</StatusChip>
          ) : (
            <>
              <span className={fracClass}>{card.filled}/{card.slots}</span>
              {card.shiftCount > 1 && <span className="m-shiftnote">{card.shiftCount} shifts</span>}
              {card.pending > 0 && !past && <StatusChip kind="warn">{card.pending} {card.pending === 1 ? 'request' : 'requests'}</StatusChip>}
            </>
          )}
          <span className="m-tags">
            {card.manual && <span className="m-tag">Manual · tap to staff</span>}
            {card.barRental && <span className="m-tag m-tag-bar">Bar</span>}
            {card.supplies && <span className="m-tag m-tag-supplies">Supplies</span>}
          </span>
        </span>
      </span>
    </button>
  );
}
