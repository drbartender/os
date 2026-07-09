// Nav groups for the Admin OS sidebar.
// `badgeKey` maps to the /api/admin/badge-counts response shape.
const NAV = [
  { section: 'Workspace', items: [
    { id: 'dashboard',   label: 'Dashboard', icon: 'home',      path: '/dashboard' },
    { id: 'events',      label: 'Events',    icon: 'calendar',  path: '/events',    badgeKey: 'unstaffed_events' },
    { id: 'proposals',   label: 'Proposals', icon: 'clipboard', path: '/proposals', badgeKey: 'pending_proposals' },
    { id: 'clients',     label: 'Clients',   icon: 'users',     path: '/clients' },
    { id: 'messages',    label: 'Messages',  icon: 'chat',      path: '/messages',  badgeKey: 'unread_sms' },
    { id: 'staff',       label: 'Staff',     icon: 'userplus',  path: '/staffing' },
    { id: 'hiring',      label: 'Hiring',    icon: 'pen',       path: '/hiring',    badgeKey: 'new_applications' },
  ]},
  { section: 'Revenue', items: [
    { id: 'financials',  label: 'Financials',      icon: 'dollar',   path: '/financials' },
    { id: 'tips',        label: 'Tips & Feedback', icon: 'dollar',   path: '/tips' },
    { id: 'marketing',   label: 'Marketing',       icon: 'mail',     path: '/email-marketing' },
  ]},
  { section: 'Content', items: [
    { id: 'potions',     label: 'Potions',       icon: 'flask',     path: '/potions', badgeKey: 'pending_shopping_lists' },
    { id: 'blog',        label: 'Lab Notes',     icon: 'pen',       path: '/blog' },
    { id: 'labrat-bugs', label: 'Lab Rat Bugs',  icon: 'clipboard', path: '/labrat-bugs', badgeKey: 'open_tester_bugs' },
    { id: 'settings',    label: 'Settings',      icon: 'gear',      path: '/settings' },
  ]},
];

export default NAV;
