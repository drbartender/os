import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
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

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  // Monotonic id: a response whose id is stale (input changed since) is dropped.
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (open) {
      setQ('');
      setResults(null);
      setLoading(false);
      setSearchError(false);
    }
  }, [open]);

  useDebounce(() => {
    // A debounce tick can land after the palette closed; don't search then.
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) {
      reqIdRef.current += 1; // invalidate any in-flight request
      setResults(null);
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
        setLoading(false);
      })
      .catch(() => {
        if (reqId !== reqIdRef.current) return;
        setSearchError(true);
        setLoading(false);
      });
  }, 200, [q]);

  if (!open) return null;

  const go = (path) => () => { navigate(path); onClose(); };

  const navGroups = [
    { group: 'Jump to', items: [
      { label: 'Dashboard',   icon: 'home',      onClick: go('/dashboard') },
      { label: 'Events',      icon: 'calendar',  onClick: go('/events') },
      { label: 'Proposals',   icon: 'clipboard', onClick: go('/proposals') },
      { label: 'Clients',     icon: 'users',     onClick: go('/clients') },
      { label: 'Staff',       icon: 'userplus',  onClick: go('/staffing') },
      { label: 'Hiring',      icon: 'pen',       onClick: go('/hiring') },
      { label: 'Financials',  icon: 'dollar',    onClick: go('/financials') },
      { label: 'Marketing',   icon: 'mail',      onClick: go('/email-marketing') },
      { label: 'Drink Plans', icon: 'flask',     onClick: go('/drink-plans') },
      { label: 'Cocktail Menu', icon: 'book',    onClick: go('/cocktail-menu') },
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

  const term = q.trim();
  const showNoMatches = !loading && !searchError && results && !recordGroups.length && term.length >= 2;
  const showNoResults = !recordGroups.length && !filteredNav.length && !loading && !searchError && !showNoMatches;

  return (
    <div className="palette-scrim open" onClick={onClose} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            placeholder="Search clients, proposals, events, staff…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Command search"
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette-list scroll-thin">
          {recordGroups.map(g => (
            <div key={g.key}>
              <div className="palette-group-label">{g.group}</div>
              {g.items.map(it => {
                const path = `${PATH_BY_TYPE[it.type]}/${it.id}`;
                return (
                  <div key={`${it.type}-${it.id}`} className="palette-item" onClick={go(path)}
                    role="button" tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') go(path)(); }}>
                    <Icon name={g.icon} />
                    <div>
                      <div>{it.name}</div>
                      {it.detail && <div className="palette-item-sub">{it.detail}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {loading && <div className="palette-item muted">Searching…</div>}
          {searchError && <div className="palette-item muted">Search unavailable.</div>}
          {showNoMatches && <div className="palette-item muted">No matches for “{term}”.</div>}

          {filteredNav.map(g => (
            <div key={g.group}>
              <div className="palette-group-label">{g.group}</div>
              {g.items.map(it => (
                <div key={it.label} className="palette-item" onClick={it.onClick} role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') it.onClick(); }}>
                  <Icon name={it.icon} />
                  <div>
                    <div>{it.label}</div>
                  </div>
                  <div className="shortcut"><span className="kbd">↵</span></div>
                </div>
              ))}
            </div>
          ))}

          {showNoResults && <div className="palette-item muted">No results.</div>}
        </div>
      </div>
    </div>
  );
}
