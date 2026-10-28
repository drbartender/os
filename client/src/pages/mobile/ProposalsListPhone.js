// ProposalsListPhone (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { offlineGet } from '../../utils/offlineRead';
import useUrlListState from '../../hooks/useUrlListState';
import { proposalCard } from '../../utils/proposalCards';
import { formatStaleTime } from '../../utils/staleTime';
import StatusChip from '../../components/adminos/StatusChip';
import Icon from '../../components/adminos/Icon';

// Phone Proposals list (spec 2026-08-13-mobile-admin section 5 List; benchmark
// docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html, Proposals tab).
// Renders INSIDE AdminLayout's scrolling .m-main; the header and tab bar are
// the chrome's. Reads the desktop Active bucket through GET /proposals with
// envelope=1 (lane ma-f1): newest lead or event date, the server-side Unviewed
// predicate, 50 a page. A card opens /proposals/:id (the desktop proposal page
// inside the phone chrome until lane ma-f2 draws the phone detail).
const PAGE = 50;
const LIST_DEFAULTS = { order: 'lead', unviewed: '' };
// No m- prefix on purpose: utils/mobileClassContract.test.js reads every m-*
// token in this file as a CSS class.
const SCROLL_KEY = (order, unviewed) => `proposals-scroll:${order}:${unviewed ? 1 : 0}`;
const SKELETONS = [['62%', '44%'], ['70%', '38%'], ['55%', '46%'], ['66%', '40%']];

function scrollHost() { return document.getElementById('main-content'); }

// Never scroll past what the freshly rendered list can actually show.
function canRestore(host, saved) {
  return saved > 0 && host.scrollHeight - host.clientHeight >= saved;
}

export default function ProposalsListPhone() {
  const navigate = useNavigate();
  const [listState, setListState] = useUrlListState(LIST_DEFAULTS);
  const order = listState.order === 'date' ? 'date' : 'lead';
  const unviewed = listState.unviewed === '1';

  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);      // the last envelope minus rows
  const [staleAt, setStaleAt] = useState(null); // x-sw-cached-at when the SW served it
  const [fetchedAt, setFetchedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  // An append that fails must never take the loaded list down with it: the
  // page-level error owns the empty screen, moreError owns the line under
  // Show more, so the rendered cards and the scroll offset survive a flaky tap.
  const [moreError, setMoreError] = useState(null);
  // Which list the rows on screen belong to, stamped by the response. The scroll
  // effects key off this rather than off order/unviewed, which change on the
  // tap, one whole round trip before the matching rows arrive.
  const [loadedKey, setLoadedKey] = useState(null);
  const reqSeq = useRef(0);
  const restoredRef = useRef(null);
  const rootRef = useRef(null);

  const params = useCallback((page) => {
    const p = { envelope: 1, limit: PAGE, page, sort: order === 'date' ? 'event_date' : 'created_at', dir: order === 'date' ? 'asc' : 'desc' };
    if (unviewed) p.unviewed = 1;
    return p;
  }, [order, unviewed]);

  const load = useCallback(async (page, append) => {
    const seq = ++reqSeq.current;
    // A fresh load clears the page first, so the skeleton is what an order
    // switch, a chip toggle and Retry all show, and the previous order's cards
    // never sit under the new toggle. Appends keep the list in place and move
    // the Show more button to its Loading label instead.
    setMoreError(null);
    if (append) setLoadingMore(true); else { setLoading(true); setError(null); setRows([]); restoredRef.current = null; }
    try {
      const res = await offlineGet('/proposals', { params: params(page) });
      if (seq !== reqSeq.current) return;                 // a newer request superseded this one
      const { rows: pageRows = [], ...rest } = res.data || {};
      // Paging is positional under an order that can move between taps, so
      // page 2 can repeat page 1's tail at its top; drop what is already shown.
      setRows(prev => (append ? prev.concat(pageRows.filter((r) => !prev.some((p) => p.id === r.id))) : pageRows));
      setMeta(rest);
      // An append must never rewrite the staleness label: page 1 from the
      // worker's cache plus page 2 off the network is still a mostly-cached list.
      if (append) { if (res.staleAt) setStaleAt(res.staleAt); } else setStaleAt(res.staleAt || null);
      setFetchedAt(new Date().toISOString());
      if (!append) setLoadedKey(SCROLL_KEY(order, unviewed));
    } catch (err) {
      if (seq !== reqSeq.current) return;
      const msg = err && err.message ? err.message : 'Network error. Check your connection.';
      if (append) setMoreError(msg); else setError(msg);
    } finally {
      if (seq === reqSeq.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [params, order, unviewed]);

  useEffect(() => { load(1, false); }, [load]);

  // List scroll restore (spec section 9): the scroll container is the chrome's
  // .m-main, keyed per order + chip. sessionStorage lives for one launch: Back
  // from a detail restores, a cold launch of the installed app lands at the top.
  useEffect(() => {
    const host = scrollHost();
    if (!host) return undefined;
    const key = SCROLL_KEY(order, unviewed);
    let raf = 0;
    const onScroll = () => {
      // The clamp race on the way out: a scroll that arrives while this root
      // is detached (the Outlet swapped to a shorter page and the browser
      // clamped the container) is not the user's, so it is never saved; saving
      // it would put 0 over the offset Back is about to restore.
      if (!rootRef.current || !rootRef.current.isConnected) return;
      // Never write before this list has been restored: on a fresh load the page
      // collapses to the skeleton, the browser clamps scrollTop and fires a
      // scroll, and that clamped value would bury the offset about to be restored.
      if (restoredRef.current !== key || raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        if (!rootRef.current || !rootRef.current.isConnected) return;   // the same clamp race, a frame later
        try { window.sessionStorage.setItem(key, String(host.scrollTop)); } catch { /* storage may be unavailable */ }
      });
    };
    host.addEventListener('scroll', onScroll, { passive: true });
    return () => { host.removeEventListener('scroll', onScroll); if (raf) window.cancelAnimationFrame(raf); };
  }, [order, unviewed]);
  useEffect(() => {
    const key = SCROLL_KEY(order, unviewed);
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
  }, [loading, loadedKey, order, unviewed]);

  const cards = useMemo(() => rows.map((r) => proposalCard(r)), [rows]);
  const cachedTime = formatStaleTime(staleAt);
  const total = meta ? Number(meta.total || 0) : 0;
  const bucketTotal = meta ? Number(meta.bucket_total || 0) : 0;
  const unviewedTotal = meta ? Number(meta.unviewed_total || 0) : 0;
  const hasMore = !!(meta && meta.has_more);
  const nextPage = meta ? Number(meta.page || 1) + 1 : 2;

  // Benchmark: the chip's empty state is "Everything opened" only when the
  // bucket has proposals at all; an empty bucket says so even with the chip on.
  let empty = null;
  if (!loading && !error && cards.length === 0) {
    if (unviewed && bucketTotal > 0) empty = { ok: true, icon: 'check', title: 'Everything opened', body: 'No sent proposal is waiting to be seen.' };
    else empty = { icon: 'clipboard', title: 'No active proposals', body: 'Drafts and sent quotes land here. Booked ones move to Events.' };
  }

  return (
    <div ref={rootRef} aria-busy={loading || loadingMore}>
      <div className="m-listbar">
        <div className="m-seg" role="radiogroup" aria-label="Order">
          <button type="button" role="radio" aria-checked={order === 'lead'} className={`m-seg-btn${order === 'lead' ? ' active' : ''}`}
            onClick={() => order !== 'lead' && setListState({ order: '' })}>Newest lead</button>
          <button type="button" role="radio" aria-checked={order === 'date'} className={`m-seg-btn${order === 'date' ? ' active' : ''}`}
            onClick={() => order !== 'date' && setListState({ order: 'date' })}>Event date</button>
        </div>
        <button type="button" className={`m-chip-toggle${unviewed ? ' on' : ''}`} aria-pressed={unviewed}
          onClick={() => setListState({ unviewed: unviewed ? '' : '1' })}>
          {/* The count waits for the envelope: rendering 0 during the first
              load makes the chip read "Unviewed 0" and then jump. The space
              before it makes the accessible name "Unviewed 30"; the flex gap
              still sets the visual spacing. */}
          Unviewed{meta && <> <span className="m-chip-count">{unviewedTotal}</span></>}
        </button>
      </div>

      {loading && cards.length === 0 && !error && (
        <>
          {/* "first sync" is literal: the note retires once any response has landed. */}
          {!fetchedAt && <div className="m-skel-note">first sync · fetching proposals</div>}
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
          <div className="m-empty-title">Couldn't load proposals</div>
          <div className="m-empty-body">{error}</div>
          <button type="button" className="m-retry-btn" onClick={() => load(1, false)}>Retry</button>
        </div>
      )}

      {!loading && (!error || rows.length > 0) && (
        <>
          {/* Only an offline copy says how old it is (Dallas, 2026-09-30). */}
          {cachedTime && (
            <div className="m-stale">
              <span className="m-stale-dot" aria-hidden="true" />
              <span>offline copy · as of <span className="m-stale-time">{cachedTime}</span></span>
            </div>
          )}
          {cards.map(card => <ProposalCard key={card.key} card={card} onTap={() => navigate(`/proposals/${card.id}`)} />)}
          {empty && (
            <div className={`m-empty${empty.ok ? ' ok' : ''}`}>
              <Icon name={empty.icon} size={28} />
              <div className="m-empty-title">{empty.title}</div>
              <div className="m-empty-body">{empty.body}</div>
            </div>
          )}
          {hasMore && (
            <button type="button" className="m-card m-card-more" onClick={() => load(nextPage, true)} disabled={loadingMore}>
              <span className="m-showmore">{loadingMore ? 'Loading' : 'Show more'}</span>
              <span className="m-shownof">{cards.length} of {total}</span>
            </button>
          )}
          {moreError && (
            <div className="m-more-error" role="alert">
              <span>Couldn't load more. {moreError}</span>
              <button type="button" className="m-retry-btn" onClick={() => load(nextPage, true)}>Retry</button>
            </div>
          )}
          {!hasMore && !unviewed && cards.length > 0 && (
            <div className="m-end"><span>End of active · {total} {total === 1 ? 'proposal' : 'proposals'}</span></div>
          )}
        </>
      )}
    </div>
  );
}

function ProposalCard({ card, onTap }) {
  // No aria-label: the accessible name is the card's own content (rail, name,
  // kind, meta, total, chip), which is most of what the card says.
  return (
    <button type="button" className="m-card" onClick={onTap}>
      <span className="m-rail">
        {/* No date: the glyphs (an en dash) are hidden, so "no date" is the
            rail's whole spoken content. */}
        <span className="m-rail-dow" aria-hidden={card.noDate ? 'true' : undefined}>{card.rail.dow}</span>
        <span className="m-rail-day" aria-hidden={card.noDate ? 'true' : undefined}>{card.rail.day}</span>
        <span className="m-rail-mon" aria-hidden={card.noDate ? 'true' : undefined}>{card.rail.mon}</span>
        {card.noDate && <span className="sr-only">no date</span>}
      </span>
      <span className="m-card-body">
        <span className="m-card-head">
          <span className="m-card-title">{card.clientName}</span>
          {card.guests != null && <span className="m-card-guests">{card.guests} <small>GUESTS</small></span>}
        </span>
        {/* The kind gets its own line (Dallas, 2026-09-24, on the Events card;
            the same ellipsis bit here). */}
        {card.kind ? <span className="m-card-kind">{card.kind}</span> : null}
        <span className="m-card-meta">{card.meta}</span>
        <span className="m-card-foot">
          {card.total && <span className="m-card-total">{card.total}</span>}
          <span className="m-chip-end"><StatusChip kind={card.chipKind}>{card.chipLabel}</StatusChip></span>
        </span>
      </span>
    </button>
  );
}
