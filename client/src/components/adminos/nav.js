// Nav groups for the Admin OS sidebar.
// `badgeKey` / `badgeKeys` map to the /api/admin/badge-counts response shape;
// read them ONLY through navBadgeCount so every consumer (Sidebar, the phone
// More list, the phone tab bar) sums the same way.
// `adminOnly` hides the item from managers. Set it whenever the destination's
// API is the server's adminOnly (which rejects managers), so the sidebar never
// offers a manager a link that bounces them straight back out.
const NAV = [
  { section: 'Workspace', items: [
    { id: 'dashboard',   label: 'Overview',  icon: 'home',      path: '/dashboard' },
    { id: 'events',      label: 'Events',    icon: 'calendar',  path: '/events',    badgeKey: 'unstaffed_events' },
    { id: 'proposals',   label: 'Proposals', icon: 'clipboard', path: '/proposals', badgeKey: 'pending_proposals' },
    { id: 'clients',     label: 'Clients',   icon: 'users',     path: '/clients' },
    { id: 'messages',    label: 'Messages',  icon: 'chat',      path: '/messages',  badgeKey: 'unread_sms' },
    // The Staff hub: Roster lands; Hiring, Payroll and Reviews are its tabs.
    // The badge is the sum of decisions waiting across the admin-only children
    // (both keys are zeroed server-side for managers).
    { id: 'staff',       label: 'Staff',     icon: 'userplus',  path: '/staffing',  badgeKeys: ['new_applications', 'pending_reviews'] },
  ]},
  { section: 'Revenue', items: [
    { id: 'marketing',   label: 'Marketing',       icon: 'mail',     path: '/marketing', adminOnly: true },
    // The legacy email surface. Still the only way into Leads, which the
    // marketing phase 2 extraction reads, so it keeps its own entry rather
    // than being swallowed by the redesign above.
    { id: 'emailleads',  label: 'Email leads',     icon: 'mail',     path: '/email-marketing' },
  ]},
  { section: 'Content', items: [
    { id: 'potions',     label: 'Potions',       icon: 'flask',     path: '/potions', badgeKey: 'pending_shopping_lists' },
    { id: 'blog',        label: 'Lab Notes',     icon: 'pen',       path: '/blog' },
    { id: 'settings',    label: 'Settings',      icon: 'gear',      path: '/settings' },
  ]},
];

/** One badge number per nav item. Sums `badgeKeys`, else reads `badgeKey`. */
export function navBadgeCount(item, badges) {
  const b = badges || {};
  if (Array.isArray(item?.badgeKeys)) return item.badgeKeys.reduce((n, k) => n + (Number(b[k]) || 0), 0);
  if (item?.badgeKey) return Number(b[item.badgeKey]) || 0;
  return 0;
}

export default NAV;
