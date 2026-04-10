import React from 'react';
import { Link, useLocation } from 'react-router-dom';

/**
 * Maps URL path segments to human-readable labels.
 * Dynamic segments (IDs) are handled separately.
 */
const SEGMENT_LABELS = {
  admin: 'Home',
  dashboard: 'Dashboard',
  staffing: 'Staff',
  users: 'User',
  applications: 'Application',
  hiring: 'Hiring',
  'drink-plans': 'Drink Plans',
  proposals: 'Proposals',
  new: 'New',
  events: 'Events',
  shift: 'Shift',
  clients: 'Clients',
  financials: 'Financials',
  settings: 'Settings',
  blog: 'Blog',
  'email-marketing': 'Marketing',
  leads: 'Leads',
  campaigns: 'Campaigns',
  analytics: 'Analytics',
  conversations: 'Conversations',
};

/** Returns true if segment looks like a dynamic ID (number or UUID-ish) */
function isDynamicSegment(segment) {
  return /^\d+$/.test(segment) || /^[0-9a-f-]{8,}$/i.test(segment);
}

export default function AdminBreadcrumbs() {
  const { pathname } = useLocation();

  // Split path into segments, filter empties
  const segments = pathname.split('/').filter(Boolean);

  // Don't show breadcrumbs on the main dashboard (just "Home")
  if (segments.length <= 2 && segments[1] === 'dashboard') return null;

  // Build crumbs: each is { label, path }
  const crumbs = [];
  let currentPath = '';

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    currentPath += '/' + segment;

    if (i === 0 && segment === 'admin') {
      crumbs.push({ label: 'Home', path: '/admin/dashboard' });
      continue;
    }

    if (isDynamicSegment(segment)) {
      // For IDs, use a contextual label based on the previous segment
      const prev = segments[i - 1];
      const contextLabels = {
        users: 'Details',
        applications: 'Details',
        'drink-plans': 'Details',
        proposals: 'Details',
        events: 'Details',
        clients: 'Details',
        shift: 'Details',
        leads: 'Details',
        campaigns: 'Details',
      };
      crumbs.push({ label: contextLabels[prev] || 'Details', path: currentPath });
      continue;
    }

    const label = SEGMENT_LABELS[segment] || segment.charAt(0).toUpperCase() + segment.slice(1);
    crumbs.push({ label, path: currentPath });
  }

  // Don't render if only 1 crumb (just "Home")
  if (crumbs.length <= 1) return null;

  return (
    <nav className="admin-breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <li key={crumb.path}>
              {isLast ? (
                <span aria-current="page">{crumb.label}</span>
              ) : (
                <>
                  <Link to={crumb.path}>{crumb.label}</Link>
                  <span className="breadcrumb-sep" aria-hidden="true">/</span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
