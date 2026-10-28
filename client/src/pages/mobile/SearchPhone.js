// SearchPhone (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, parsePath, useLocation, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import useDebounce from '../../hooks/useDebounce';
import { useMobileView } from '../../context/MobileViewContext';
import { routeScreenKey } from '../../utils/screenKey';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import {
  GROUP_LIMIT, termState, searchGroups, searchNote, errorKind, flightLabel, liveSummary,
} from '../../utils/searchView';

// Phone global search (spec 2026-08-13-mobile-admin section 6; benchmark
// docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html, Global search;
// lane ma-f3). A full-screen takeover at /search: AdminLayout renders no
// header and no tab bar for this route, so the screen draws its own header
// (Back and the field) and its own scrolling <main>.
//
// Nothing from search is ever stored on the phone: the read is api.get, never
// offlineGet, so the admin service worker sends it to the network untouched
// (the rows carry client emails and phones). Offline, the field keeps its
// text, disabled, and the note says search needs the server.
//
// Once a search answers, its term rides in this history entry's state, so
// Back from a result lands here with the term and runs it again. The term
// never enters the URL, and the route restore never records /search
// (utils/routeRestore.js).

// The palette's debounce (CommandPalette.js), as spec section 6 asks.
const DEBOUNCE_MS = 200;
// api.js sets no timeout; without one a search on a dead link pulses forever.
const TIMEOUT_MS = 10000;

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
// The browser's current history entry, keyed as react-router keys it; null
// when the router's history is not the browser's (the tests' MemoryRouter).
function liveKey() {
  const s = window.history.state;
  return s ? s.key || 'default' : null;
}

function Lead({ lead }) {
  if (lead.kind === 'rail') {
    const hide = lead.noDate ? 'true' : undefined;
    return (
      <span className="m-rail">
        {/* No date: the glyphs (an en dash) are hidden, so "no date" is the
            rail's whole spoken content (the Proposals list's rule). */}
        <span className="m-rail-dow" aria-hidden={hide}>{lead.rail.dow}</span>
        <span className="m-rail-day" aria-hidden={hide}>{lead.rail.day}</span>
        <span className="m-rail-mon" aria-hidden={hide}>{lead.rail.mon}</span>
        {lead.noDate && <span className="sr-only">no date</span>}
      </span>
    );
  }
  if (lead.kind === 'initials') {
    return <span className="m-srow-tile m-srow-initials" aria-hidden="true">{lead.initials}</span>;
  }
  return <span className="m-srow-tile" aria-hidden="true"><Icon name={lead.icon} size={18} /></span>;
}

// The spaces between pieces are for the button's accessible name; inside the
// flex row they render as nothing. The kind has its own line in the UI face
// (.m-card-kind, the card family's), the meta its own in the numeric face.
function SearchRow({ row, onOpen }) {
  return (
    <button type="button" className="m-card m-srow" onClick={() => onOpen(row.target)}>
      <Lead lead={row.lead} />{' '}
      <span className="m-srow-body">
        <span className="m-srow-title">{row.title}</span>
        {row.kind ? <>{' '}<span className="m-card-kind">{row.kind}</span></> : null}
        {row.meta ? <>{' '}<span className="m-card-meta">{row.meta}</span></> : null}
      </span>
      {row.chip ? <>{' '}<StatusChip kind={row.chip.kind}>{row.chip.label}</StatusChip></> : null}
      {row.desktop ? <>{' '}<span className="tag">Desktop</span></> : null}
    </button>
  );
}

export default function SearchPhone() {
  const { isPhone, setDesktopForVisit } = useMobileView();
  const navigate = useNavigate();
  const location = useLocation();
  const [initialTerm] = useState(() => {
    const s = location.state;
    return s && typeof s.q === 'string' ? s.q : '';
  });
  const [q, setQ] = useState(initialTerm);
  const [results, setResults] = useState(null);       // the last answer's groups, raw
  const [resultsFor, setResultsFor] = useState(null); // the term that answer is for
  const [error, setError] = useState(null);           // { term, kind: 'network' | 'rate' | 'server' }
  const [offline, setOffline] = useState(() => !isOnline());
  const [resumed, setResumed] = useState(0);          // times the screen came back to its entry, still mounted
  const reqId = useRef(0);
  const inputRef = useRef(null);
  const entryKey = useRef(location.key);              // the history entry the screen is on
  const drawn = useRef(location);                     // the location it last drew
  const term = q.trim();
  const state = termState(term);

  // Leaving for a page whose lazy chunk has not loaded keeps this screen
  // mounted, hidden, until the chunk lands. React holds its effect cleanups
  // that long (the unmount cancel below, the debounce's clear), and navigate
  // still works. The hidden screen never draws again, so entryKey keeps the
  // entry the user left while the browser's has moved on. Away from its
  // entry the screen sends nothing, writes no history and ignores Escape, so
  // a late answer can never put the user back on the search.
  const isHere = useCallback(() => {
    const live = liveKey();
    return live === null || live === entryKey.current;
  }, []);

  // A new location the screen draws is the entry it is on. The same entry
  // drawn again means the user came back before the page they left for
  // loaded: a search skipped or dropped while away left the term
  // unanswered, so the screen searches it again.
  useEffect(() => {
    const before = drawn.current;
    drawn.current = location;
    entryKey.current = location.key;
    if (before !== location && before.key === location.key) setResumed((n) => n + 1);
  }, [location]);

  // Any answer still on its way is dropped when it lands.
  const cancel = useCallback(() => { reqId.current += 1; }, []);
  const forget = useCallback(() => {
    cancel();
    setResults(null);
    setResultsFor(null);
    setError(null);
  }, [cancel]);

  const run = useCallback((t) => {
    const id = ++reqId.current;
    setError(null);
    api.get('/admin/search', { params: { q: t }, timeout: TIMEOUT_MS })
      .then((res) => {
        if (id !== reqId.current) return;
        setResults((res && res.data && res.data.results) || {});
        setResultsFor(t);
        if (!isHere()) return;
        navigate('/search', { replace: true, state: { q: t } });
        // The replace gave this entry a new key and the screen is still on
        // it; the debounce must not read its own write as the user leaving.
        const live = liveKey();
        if (live !== null) entryKey.current = live;
      })
      .catch((err) => {
        if (id !== reqId.current) return;
        setResults(null);
        setResultsFor(null);
        setError({ term: t, kind: errorKind(err) });
      });
  }, [navigate, isHere]);

  useDebounce(() => {
    if (!isPhone || offline || state !== 'ok' || !isHere()) return;
    run(term);
  }, DEBOUNCE_MS, [term, offline, resumed]);

  const close = useCallback(() => {
    cancel();
    if (window.history.state && window.history.state.idx > 0) navigate(-1);
    else navigate('/events', { replace: true });
  }, [cancel, navigate]);

  // Leaving: an answer that lands later must not write this screen's history
  // entry over the page the user went to (isHere covers the time React keeps
  // the screen hidden first). Its own effect, so re-subscribing the listeners
  // below can never drop a search in flight.
  useEffect(() => cancel, [cancel]);

  useEffect(() => {
    const goOffline = () => { forget(); setOffline(true); };
    const goOnline = () => setOffline(false);
    // Escape closes from anywhere on the screen, as the benchmark listens,
    // including offline, when the field is disabled.
    const onKey = (e) => {
      if (e.key === 'Escape' && isHere()) { e.preventDefault(); close(); }
    };
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('keydown', onKey);
    };
  }, [forget, close, isHere]);

  if (!isPhone) return <Navigate to="/dashboard" replace />;

  // A desktop page from search is for this visit only (MobileViewContext's
  // setDesktopForVisit): backing out of it returns the phone to how it was.
  // Search never sets the sticky override. The key is the one routeScreenKey
  // gives the page's pathname, the key the context steps the visit by, so the
  // visit always starts on the page the row opens.
  const open = (target) => {
    if (!target) return;
    cancel();
    if (target.screenKey) setDesktopForVisit(routeScreenKey(parsePath(target.path).pathname));
    navigate(target.path);
  };
  const onChange = (e) => {
    const v = e.target.value;
    setQ(v);
    // Below two characters or past a hundred nothing is searched: the rows on
    // screen go at once, as the benchmark draws it, not at the debounce.
    if (termState(v) !== 'ok') forget();
  };
  const clear = () => {
    setQ('');
    forget();
    if (inputRef.current) inputRef.current.focus();
  };
  const retry = () => { if (state === 'ok' && !offline) run(term); };
  // The keyboard's Search key: put the keyboard away so the rows show.
  const onSubmit = (e) => {
    e.preventDefault();
    if (inputRef.current) inputRef.current.blur();
  };

  const pending = state === 'ok' && !offline && term !== resultsFor && !(error && error.term === term);
  const groups = state === 'ok' && !offline ? searchGroups(results, resultsFor) : [];
  const note = searchNote({ raw: term, offline, error, pending, resultsFor, groups });

  return (
    <>
      <header className="m-header m-search-head">
        <button type="button" className="m-iconbtn" onClick={close} aria-label="Close search">
          <Icon name="left" size={20} />
        </button>
        <form className="m-search-field" role="search" onSubmit={onSubmit}>
          <span className="m-search-icon" aria-hidden="true"><Icon name="search" size={16} /></span>
          <input
            ref={inputRef}
            type="search"
            className="m-search-input"
            value={q}
            onChange={onChange}
            disabled={offline}
            autoFocus={!initialTerm}
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="Search clients, proposals, events, staff…"
            aria-label="Global search"
          />
          {term.length > 0 && (
            <button type="button" className="m-search-clear" onClick={clear} aria-label="Clear search">
              <Icon name="x" size={16} />
            </button>
          )}
        </form>
      </header>
      <main className="m-main m-search-main" id="main-content">
        <h1 className="sr-only">Search</h1>
        <div className="sr-only" role="status" aria-live="polite">{liveSummary({ pending, note, groups })}</div>
        {pending && <div className="m-sflight" aria-hidden="true">{flightLabel(resultsFor)}</div>}
        {groups.map((g) => (
          <section key={g.key}>
            <h2 className="m-sgroup-head">
              <span className="m-sgroup-label">{g.label}</span>{' '}
              <span className="m-sgroup-count">{g.count}</span>
            </h2>
            {g.rows.map((row) => <SearchRow key={row.key} row={row} onOpen={open} />)}
            {g.more && (
              <button type="button" className="m-card m-srow-more" onClick={() => open(g.more)}>
                <span className="m-srow-more-icon" aria-hidden="true"><Icon name="external" size={16} /></span>
                <span className="m-srow-more-label">{g.moreLabel}</span>{' '}
                <span className="m-srow-more-count">{GROUP_LIMIT} shown</span>
              </button>
            )}
          </section>
        ))}
        {note && (
          <div className="m-empty m-snote">
            <Icon name={note.icon} size={28} />
            <div className="m-empty-title">{note.title}</div>
            <div className="m-empty-body">{note.body}</div>
            {note.micro ? <div className="m-snote-micro">{note.micro}</div> : null}
            {note.retry ? <button type="button" className="m-retry-btn" onClick={retry}>Retry</button> : null}
          </div>
        )}
      </main>
    </>
  );
}
