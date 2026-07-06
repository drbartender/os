import React, { useEffect, useRef, useState } from 'react';
import api from '../../utils/api';
import Icon from './Icon';
import PresenceDrawer from './drawers/PresenceDrawer';

const STATES = [
  { key: 'desk', label: 'Desk' },
  { key: 'available', label: 'Available' },
  { key: 'away', label: 'Away' },
];

function fmtDur(sinceIso, nowMs) {
  if (!sinceIso) return '';
  const m = Math.max(0, Math.floor((nowMs - new Date(sinceIso).getTime()) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function PresenceStrip({ presence, onPresenceChange, rail, currentUser }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const rootRef = useRef(null);

  // Re-render the "time in state" labels each minute.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  // Dismiss the state popover on any click outside the strip.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  const users = presence?.users;
  const isAdmin = currentUser?.role === 'admin';

  const refetch = async () => {
    try { const r = await api.get('/admin/presence'); onPresenceChange(r.data); }
    catch { /* keep last known state */ }
  };
  // Never blind-optimistic: disable while in flight, apply the response
  // payload (server truth), and on failure re-fetch + show an error line.
  const mutate = async (path, body) => {
    setBusy(true); setError(null);
    try { const r = await api.post(path, body); onPresenceChange(r.data); }
    catch { setError('Update failed'); refetch(); }
    finally { setBusy(false); setMenuOpen(false); }
  };

  // First-paint / failed-block placeholder: fixed height, no invented state.
  if (!users || !users.length) {
    return (
      <div className={`presence-strip presence-strip--placeholder${rail ? ' presence-strip--rail' : ''}`} aria-hidden="true">
        <span className="presence-dot presence-dot--away" />
        <span className="presence-dot presence-dot--away" />
      </div>
    );
  }

  const maxRank = Math.max(...users.map(u => u.rank));
  const owner = users.find(u => u.id === presence.lead_owner_id);

  return (
    <div ref={rootRef} className={`presence-strip${rail ? ' presence-strip--rail' : ''}`}>
      {users.map(u => {
        const own = u.id === currentUser?.id;
        return (
          <div key={u.id} className={`presence-row${own ? ' own' : ''}`} title={rail ? `${u.name}: ${u.state}` : undefined}>
            <button
              type="button"
              className="presence-row-main"
              disabled={!own || busy}
              onClick={() => own && setMenuOpen(v => !v)}
              aria-haspopup={own ? 'menu' : undefined}
              aria-expanded={own ? menuOpen : undefined}
            >
              <span className={`presence-dot presence-dot--${u.state}`} />
              <span className="presence-name">{u.name}</span>
              <span className="presence-state">{u.state}</span>
              <span className="presence-dur">{fmtDur(u.since, nowMs)}</span>
            </button>
            <button
              type="button"
              className={`presence-leads-pill${u.taking_leads ? ' on' : ''}`}
              disabled={!own || u.state === 'away' || busy}
              onClick={() => own && mutate('/admin/presence/leads', { taking: !u.taking_leads })}
              title={
                u.rank === maxRank
                  ? (u.taking_leads ? 'Dibs on leads' : 'Not taking leads')
                  : (u.taking_leads ? 'Taking leads' : 'Not taking leads')
              }
            >{u.rank === maxRank && u.taking_leads ? 'dibs' : 'leads'}</button>
            {own && menuOpen && (
              <div className="presence-menu" role="menu">
                {STATES.map(s => (
                  <button
                    key={s.key}
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    className={`presence-menu-opt${u.state === s.key ? ' active' : ''}`}
                    onClick={() => mutate('/admin/presence/state', { state: s.key })}
                  >
                    <span className={`presence-dot presence-dot--${s.key}`} />{s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className="presence-pointer">
        <span className="presence-pointer-label">Leads</span>
        <Icon name="right" size={10} />
        <span className="presence-pointer-name">{owner?.name || ''}</span>
        <span className={`presence-pointer-initial presence-initial--${owner?.state || 'away'}`}>{(owner?.name || '?')[0]}</span>
        {isAdmin && (
          <button type="button" className="presence-history-btn" title="Time clock" onClick={() => setDrawerOpen(true)}>
            <Icon name="clock" size={11} />
          </button>
        )}
      </div>
      {error && <div className="presence-error">{error}</div>}
      {isAdmin && <PresenceDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />}
    </div>
  );
}
