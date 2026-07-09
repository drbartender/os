import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Icon from './Icon';
import api from '../../utils/api';
import useDebounce from '../../hooks/useDebounce';

// Result groups, in display order. `key` matches the endpoint response;
// `type` matches each result's `type` field and keys into PATH_BY_TYPE.
const RECORD_GROUPS = [
  { key: 'clients',   group: 'Clients',   type: 'client',   icon: 'users' },
  { key: 'proposals', group: 'Proposals', type: 'proposal', icon: 'clipboard' },
  { key: 'events',    group: 'Events',    type: 'event',    icon: 'calendar' },
  { key: 'staff',     group: 'Staff',     type: 'staff',    icon: 'userplus' },
];

const PATH_BY_TYPE = {
  client: '/clients',
  proposal: '/proposals',
  event: '/events',
  staff: '/staffing/users',
};

// Walk the groups in display order; the first record is the "top hit" the
// pending-Enter latch activates when results land.
function firstRecord(results) {
  for (const g of RECORD_GROUPS) {
    const items = (results && results[g.key]) || [];
    if (items.length) return items[0];
  }
  return null;
}

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  // Keyboard position in the flat item list; 0 = the top hit, pre-selected.
  const [activeIndex, setActiveIndex] = useState(0);
  // While true, CSS suppresses :hover paint (.palette-list.kbd-nav) so a mouse
  // resting on one row and the keyboard on another don't double-highlight.
  // Cleared by the next real mousemove.
  const [kbdNav, setKbdNav] = useState(false);
  // Monotonic id: a response whose id is stale (input changed since) is dropped.
  const reqIdRef = useRef(0);
  // Enter pressed while results were still loading: remember it and activate
  // the top record the moment they land (spec: pending-Enter latch). Cleared
  // by any keystroke, arrow key, error, or empty result — and it dies with the
  // palette: any dismissal kills it so a late response can't navigate.
  const pendingEnterRef = useRef(false);
  // The user arrow-moved during this query: their explicit selection beats the
  // latch/top-hit default. Cleared on keystroke and on open.
  const movedRef = useRef(false);
  // The term the current `results` answered. Enter only activates directly when
  // results are FRESH for the typed term; otherwise it latches. Covers all three
  // fast-typist windows: debounce not yet fired, request in flight, and stale
  // rows from the previous query still on screen.
  const resultsForRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setResults(null);
      setLoading(false);
      setSearchError(false);
      setActiveIndex(0);
      setKbdNav(false);
      pendingEnterRef.current = false;
      movedRef.current = false;
      resultsForRef.current = null;
    } else {
      // Dismissal (Esc, scrim, row click, ⌘K toggle) must kill a pending latch
      // and invalidate any in-flight request: a response landing after close
      // can neither navigate nor write state.
      pendingEnterRef.current = false;
      reqIdRef.current += 1;
    }
  }, [open]);

  // Keep the active row visible as ↑/↓ move past the fold of the 340px list.
  // scrollIntoView is feature-guarded: jsdom (tests) doesn't implement it.
  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(`palette-opt-${activeIndex}`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  useDebounce(() => {
    // A debounce tick can land after the palette closed; don't search then.
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) {
      reqIdRef.current += 1; // invalidate any in-flight request
      setResults(null);
      resultsForRef.current = null;
      setLoading(false);
      setSearchError(false);
      return;
    }
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setSearchError(false);
    api.get('/admin/search', { params: { q: term } })
      .then((res) => {
        if (reqId !== reqIdRef.current) return;
        setResults(res.data.results);
        resultsForRef.current = term; // these results answer THIS term
        setLoading(false);
        if (pendingEnterRef.current) {
          pendingEnterRef.current = false;
          const top = firstRecord(res.data.results);
          if (top) {
            navigate(`${PATH_BY_TYPE[top.type]}/${top.id}`);
            onClose();
          }
        }
      })
      .catch(() => {
        if (reqId !== reqIdRef.current) return;
        setSearchError(true);
        setLoading(false);
        pendingEnterRef.current = false;
      });
  }, 200, [q]);

  if (!open) return null;

  // Every in-component close goes through dismiss so a pending latch and any
  // in-flight request die synchronously with the close. (Parent-initiated
  // closes — Esc, ⌘K toggle — are covered by the open-effect's else branch.)
  const dismiss = () => {
    pendingEnterRef.current = false;
    reqIdRef.current += 1;
    onClose();
  };
  const go = (path) => () => { navigate(path); dismiss(); };

  const navGroups = [
    { group: 'Jump to', items: [
      { label: 'Overview',    icon: 'home',      onClick: go('/dashboard') },
      { label: 'Events',      icon: 'calendar',  onClick: go('/events') },
      { label: 'Proposals',   icon: 'clipboard', onClick: go('/proposals') },
      { label: 'Clients',     icon: 'users',     onClick: go('/clients') },
      { label: 'Staff',       icon: 'userplus',  onClick: go('/staffing') },
      { label: 'Hiring',      icon: 'pen',       onClick: go('/hiring') },
      { label: 'Payouts',     icon: 'dollar',    onClick: go('/dashboard?tab=payouts') },
      { label: 'Marketing',   icon: 'mail',      onClick: go('/email-marketing') },
      { label: 'Potions',     icon: 'flask',     onClick: go('/potions') },
      { label: 'Lab Notes',   icon: 'pen',       onClick: go('/blog') },
      { label: 'Settings',    icon: 'gear',      onClick: go('/settings') },
    ]},
    { group: 'Create', items: [
      { label: 'New proposal', icon: 'plus', onClick: go('/proposals/new') },
      { label: 'New campaign', icon: 'plus', onClick: go('/email-marketing/campaigns/new') },
    ]},
  ];

  const filteredNav = navGroups
    .map(g => ({ ...g, items: g.items.filter(it => !q || it.label.toLowerCase().includes(q.toLowerCase())) }))
    .filter(g => g.items.length);

  const recordGroups = results
    ? RECORD_GROUPS
        .map(g => ({ ...g, items: results[g.key] || [] }))
        .filter(g => g.items.length)
    : [];

  // Flat, display-ordered actionable list. The index into this list IS the
  // keyboard position; `start` offsets let grouped rendering compute each
  // row's flat index without a second pass.
  let cursor = 0;
  const recordGroupsIdx = recordGroups.map((g) => {
    const start = cursor;
    cursor += g.items.length;
    return { ...g, start };
  });
  const navGroupsIdx = filteredNav.map((g) => {
    const start = cursor;
    cursor += g.items.length;
    return { ...g, start };
  });
  const flatItems = [];
  recordGroupsIdx.forEach((g) => g.items.forEach((it) => {
    flatItems.push({ kind: 'record', path: `${PATH_BY_TYPE[it.type]}/${it.id}` });
  }));
  navGroupsIdx.forEach((g) => g.items.forEach((it) => {
    flatItems.push({ kind: 'nav', onClick: it.onClick });
  }));

  // Clamp instead of resetting when async results shrink/grow the list — a
  // reset here would yank a selection made while records were still loading.
  const activeIdx = flatItems.length ? Math.min(activeIndex, flatItems.length - 1) : -1;

  const activate = (item) => {
    if (!item) return;
    if (item.kind === 'record') {
      navigate(item.path);
      dismiss();
    } else {
      item.onClick();
    }
  };

  const onInputKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); // keep the caret still
      if (!flatItems.length) return;
      movedRef.current = true;
      pendingEnterRef.current = false; // manual control cancels the latch
      setKbdNav(true);
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(((activeIdx + delta) % flatItems.length + flatItems.length) % flatItems.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const term = q.trim();
      // Fast-typist path: the user hasn't picked anything and fresh results
      // for this exact term aren't on screen yet (debounce pending, request in
      // flight, or only stale rows from the previous query showing) — latch,
      // and land on the top record when they arrive. Never misfire onto a nav
      // item or a stale row. On a search error there is nothing to wait for,
      // so Enter falls through to the visible selection.
      const fresh = !!results && resultsForRef.current === term;
      if (term.length >= 2 && !movedRef.current && !fresh && !searchError) {
        pendingEnterRef.current = true;
        return;
      }
      activate(flatItems[activeIdx]);
    }
  };

  const onQChange = (e) => {
    setQ(e.target.value);
    setActiveIndex(0); // reset ONLY on keystroke, never on async arrival
    pendingEnterRef.current = false;
    movedRef.current = false;
  };

  const term = q.trim();
  const showNoMatches = !loading && !searchError && results && !recordGroupsIdx.length && term.length >= 2;
  const showNoResults = !recordGroupsIdx.length && !filteredNav.length && !loading && !searchError && !showNoMatches;

  const rowProps = (idx) => ({
    id: `palette-opt-${idx}`,
    role: 'option',
    'aria-selected': idx === activeIdx,
    className: `palette-item${idx === activeIdx ? ' active' : ''}`,
    onMouseEnter: () => { if (!kbdNav) setActiveIndex(idx); },
  });

  return (
    <div className="palette-scrim open" onClick={dismiss} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            role="combobox"
            aria-expanded={flatItems.length > 0}
            aria-controls="palette-listbox"
            aria-activedescendant={activeIdx >= 0 ? `palette-opt-${activeIdx}` : undefined}
            aria-autocomplete="list"
            placeholder="Search clients, proposals, events, staff…"
            value={q}
            onChange={onQChange}
            onKeyDown={onInputKeyDown}
            aria-label="Command search"
          />
          <span className="kbd">Esc</span>
        </div>
        <div
          id="palette-listbox"
          role="listbox"
          aria-label="Search results"
          className={`palette-list scroll-thin${kbdNav ? ' kbd-nav' : ''}`}
          onMouseMove={() => { if (kbdNav) setKbdNav(false); }}
        >
          {recordGroupsIdx.map(g => (
            <div key={g.key} role="group" aria-label={g.group}>
              <div className="palette-group-label" aria-hidden="true">{g.group}</div>
              {g.items.map((it, i) => {
                const idx = g.start + i;
                const path = `${PATH_BY_TYPE[it.type]}/${it.id}`;
                // Real anchor: cmd/ctrl/middle-click open a new tab natively
                // (palette stays open for those); plain click closes it.
                return (
                  <Link key={`${it.type}-${it.id}`} to={path} {...rowProps(idx)}
                    onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) dismiss(); }}>
                    <Icon name={g.icon} />
                    <div>
                      <div>{it.name}</div>
                      {it.detail && <div className="palette-item-sub">{it.detail}</div>}
                    </div>
                  </Link>
                );
              })}
            </div>
          ))}

          {loading && <div className="palette-item muted">Searching…</div>}
          {searchError && <div className="palette-item muted">Search unavailable.</div>}
          {showNoMatches && <div className="palette-item muted">No matches for “{term}”.</div>}

          {navGroupsIdx.map(g => (
            <div key={g.group} role="group" aria-label={g.group}>
              <div className="palette-group-label" aria-hidden="true">{g.group}</div>
              {g.items.map((it, i) => {
                const idx = g.start + i;
                return (
                  <div key={it.label} {...rowProps(idx)} onClick={it.onClick}>
                    <Icon name={it.icon} />
                    <div>
                      <div>{it.label}</div>
                    </div>
                    <div className="shortcut"><span className="kbd">↵</span></div>
                  </div>
                );
              })}
            </div>
          ))}

          {showNoResults && <div className="palette-item muted">No results.</div>}
        </div>
      </div>
    </div>
  );
}
