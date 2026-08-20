import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useOutletContext } from 'react-router-dom';
import api from '../../../utils/api';
import { useAuth } from '../../../context/AuthContext';
import { hubSubtitle } from './hubSubtitle';

/**
 * The Staff hub (spec 2026-08-19-admin-staff-hub-design.md §4). One sidebar
 * entry, four children, Roster lands. Follows MarketingLayout: the layout owns
 * ONE fetch (GET /admin/staff-hub/summary) and shares it through Outlet
 * context. Rendering is never gated on the fetch: children mount at once and
 * the chrome fills in when the data arrives.
 *
 * Two-vocabulary rule (§3): hub sections are header-fused underline tabs
 * (.hub-tabs, routes not state); views inside a child stay .seg pills in the
 * toolbar. Never two .segs stacked; never a third level.
 */
const TABS = [
  { id: 'roster', label: 'Roster', path: '/staffing', end: true, countKey: 'active_count' },
  { id: 'hiring', label: 'Hiring', path: '/staffing/hiring', adminOnly: true, badgeKey: 'new_applications' },
  { id: 'payroll', label: 'Payroll', path: '/staffing/payroll', adminOnly: true },
  { id: 'reviews', label: 'Reviews', path: '/staffing/reviews', adminOnly: true, badgeKey: 'pending_reviews' },
];

export default function StaffHubLayout() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  // AdminLayout hands both of its shells the same context object; outside one
  // (a bare render in a test) there is none, so tolerate null.
  const shell = useOutletContext() || {};
  const refreshBadges = shell.refreshBadges;

  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState(null);
  const [actions, setActions] = useState(null);

  const loadSummary = useCallback(async () => {
    setSummaryError(null);
    try {
      const res = await api.get('/admin/staff-hub/summary');
      setSummary(res.data || null);
    } catch (err) {
      setSummaryError(err);
    }
  }, []);
  useEffect(() => { loadSummary(); }, [loadSummary]);

  /** Children call this after a mutation that moves a count or a badge. */
  const refresh = useCallback(() => {
    loadSummary();
    if (typeof refreshBadges === 'function') refreshBadges();
  }, [loadSummary, refreshBadges]);

  const ctx = useMemo(
    () => ({ summary, summaryError, refresh, setActions }),
    [summary, summaryError, refresh]
  );

  const visibleTabs = TABS.filter(t => !t.adminOnly || isAdmin);
  const subtitle = hubSubtitle(summary, { isAdmin });

  // data-app lives on <html>, set by AdminLayout, so the page div does not repeat it.
  return (
    <div className="page">
      <div className="hub-head">
        <div className="page-header">
          <div>
            <div className="page-title">Staff</div>
            {subtitle && <div className="page-subtitle">{subtitle}</div>}
            {summaryError && (
              <div className="page-subtitle">
                <span className="muted">Counts unavailable.</span>{' '}
                <button type="button" className="btn btn-ghost btn-sm" onClick={loadSummary}>Retry</button>
              </div>
            )}
          </div>
          {actions && <div className="page-actions">{actions}</div>}
        </div>
        {visibleTabs.length > 1 && (
          <nav className="hub-tabs" aria-label="Staff sections">
            {visibleTabs.map(t => {
              const count = t.countKey && summary ? summary[t.countKey] : null;
              const badge = t.badgeKey && summary ? summary[t.badgeKey] : null;
              return (
                <NavLink
                  key={t.id}
                  to={t.path}
                  end={!!t.end}
                  className={({ isActive }) => `hub-tab${isActive ? ' active' : ''}`}
                >
                  {t.label}
                  {count !== null && count !== undefined && <span className="hub-tab-count">{count}</span>}
                  {badge > 0 && <span className="hub-tab-badge">{badge}</span>}
                </NavLink>
              );
            })}
          </nav>
        )}
      </div>
      <Outlet context={ctx} />
    </div>
  );
}
