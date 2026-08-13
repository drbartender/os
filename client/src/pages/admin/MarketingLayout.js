import React from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

/**
 * The redesigned Marketing section.
 *
 * This is a NEW layout mounted at /marketing. EmailMarketingDashboard.js keeps
 * its own tabs at /email-marketing untouched: its TABS array is the only
 * navigation to Leads, Campaigns, Analytics and Conversations, and the phase 2
 * lead extraction still needs that surface. Replacing it in place would break
 * the thing the next phase depends on.
 */
const TABS = [
  { label: 'Overview', path: '/marketing/overview' },
  { label: 'Audiences', path: '/marketing/audiences' },
  { label: 'Compose', path: '/marketing/compose' },
  { label: 'Sent', path: '/marketing/sent' },
];

export default function MarketingLayout() {
  const location = useLocation();
  const isRoot = location.pathname === '/marketing';

  return (
    <div className="em-dashboard card">
      <div className="em-header">
        <h1>Marketing</h1>
      </div>
      <nav className="em-tabs">
        {TABS.map(tab => (
          <NavLink
            key={tab.path}
            to={tab.path}
            className={({ isActive }) =>
              `em-tab${isActive || (isRoot && tab.path.endsWith('/audiences')) ? ' em-tab-active' : ''}`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
