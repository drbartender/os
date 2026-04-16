import React from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

const TABS = [
  { label: 'Leads', path: '/admin/email-marketing/leads' },
  { label: 'Campaigns', path: '/admin/email-marketing/campaigns' },
  { label: 'Analytics', path: '/admin/email-marketing/analytics' },
  { label: 'Conversations', path: '/admin/email-marketing/conversations' },
];

export default function EmailMarketingDashboard() {
  const location = useLocation();
  // If we're at the root /admin/email-marketing, we render leads by default
  const isRoot = location.pathname === '/admin/email-marketing';

  return (
    <div className="em-dashboard card">
      <div className="em-header">
        <h1>Email Marketing</h1>
      </div>
      <nav className="em-tabs">
        {TABS.map(tab => (
          <NavLink
            key={tab.path}
            to={tab.path}
            className={({ isActive }) =>
              `em-tab${isActive || (isRoot && tab.path.endsWith('/leads')) ? ' em-tab-active' : ''}`
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
