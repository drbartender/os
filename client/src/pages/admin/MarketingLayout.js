import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import api from '../../utils/api';

/**
 * The redesigned Marketing section, on the Admin OS layer (spec §10).
 *
 * Overview is the landing tab: the section answers "what should I do today"
 * before it offers a list of contacts to sort through.
 *
 * The layout owns the ONE GET /marketing/overview and shares it with every
 * tab via Outlet context ({overview, error, refresh, update}). The shell's
 * live subtitle and budget meter read it; OverviewTab renders from it and
 * writes moment edits back through `update` so the subtitle never goes
 * stale. Rendering is never gated on the fetch: tabs mount immediately and
 * the chrome that needs the data appears when it arrives.
 *
 * This is a NEW layout mounted at /marketing. EmailMarketingDashboard.js
 * keeps its own tabs at /email-marketing untouched: its TABS array is the
 * only navigation to Leads, Campaigns, Analytics and Conversations, and the
 * lead extraction still needs that surface.
 */
const TABS = [
  { label: 'Overview', path: '/marketing/overview' },
  { label: 'Audiences', path: '/marketing/audiences' },
  { label: 'Compose', path: '/marketing/compose' },
  { label: 'Sent', path: '/marketing/sent' },
];

export default function MarketingLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const isRoot = location.pathname === '/marketing';

  const [overview, setOverview] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get('/marketing/overview');
      setOverview(res.data);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  /** Functional update over the shared payload (moment edit / dismiss). */
  const update = useCallback((fn) => setOverview(d => (d ? fn(d) : d)), []);

  const ctx = useMemo(
    () => ({ overview, error, refresh, update }),
    [overview, error, refresh, update]
  );

  const budget = overview?.send_budget;
  const usedPct = budget && budget.cap > 0
    ? Math.min(100, Math.round((budget.used / budget.cap) * 100))
    : 0;
  const subtitle = overview && budget
    ? [
      new Date(overview.today).toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric',
      }),
      `${overview.open_moment_count} ${overview.open_moment_count === 1 ? 'moment' : 'moments'} open`,
      `${budget.remaining} sends left today`,
    ].join(' · ')
    : null;

  return (
    <div className="page" data-app="admin-os">
      <div className="page-header">
        <div>
          <div className="page-title">Marketing</div>
          {subtitle && <div className="page-subtitle">{subtitle}</div>}
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-secondary"
            onClick={() => navigate('/marketing/audiences')}>
            Audiences
          </button>
          <button type="button" className="btn btn-primary"
            onClick={() => navigate('/marketing/compose')}>
            New send
          </button>
        </div>
      </div>

      <div className="mkt-tabrow">
        <nav className="seg" aria-label="Marketing sections">
          {TABS.map(tab => (
            <NavLink
              key={tab.path}
              to={tab.path}
              className={({ isActive }) =>
                (isActive || (isRoot && tab.path.endsWith('/overview')) ? 'active' : undefined)
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        {budget && (
          <div className="mkt-budget" title="Campaign sends only; proposals, invoices and lifecycle mail share the real allowance.">
            <span className="mkt-budget-label">Today&apos;s send budget</span>
            <span className="mkt-budget-track">
              <span className="mkt-hue-info" style={{ width: `${usedPct}%` }} />
            </span>
            <span className="mkt-budget-num">
              {budget.remaining}<span> / {budget.cap} left</span>
            </span>
          </div>
        )}
      </div>

      <Outlet context={ctx} />
    </div>
  );
}
