// Nav groups for the Admin OS sidebar.
// `badgeKey` maps to the /api/admin/badge-counts response shape.
const NAV = [
  { section: 'Workspace', items: [
    { id: 'dashboard',   label: 'Dashboard', icon: 'home',      path: '/admin/dashboard' },
    { id: 'events',      label: 'Events',    icon: 'calendar',  path: '/admin/events',    badgeKey: 'unstaffed_events' },
    { id: 'proposals',   label: 'Proposals', icon: 'clipboard', path: '/admin/proposals', badgeKey: 'pending_proposals' },
    { id: 'clients',     label: 'Clients',   icon: 'users',     path: '/admin/clients' },
    { id: 'staff',       label: 'Staff',     icon: 'userplus',  path: '/admin/staffing' },
    { id: 'hiring',      label: 'Hiring',    icon: 'pen',       path: '/admin/hiring',    badgeKey: 'new_applications' },
  ]},
  { section: 'Revenue', items: [
    { id: 'financials',  label: 'Financials', icon: 'dollar',   path: '/admin/financials' },
    { id: 'marketing',   label: 'Marketing',  icon: 'mail',     path: '/admin/email-marketing' },
  ]},
  { section: 'Content', items: [
    { id: 'drink-plans', label: 'Drink Plans',   icon: 'flask', path: '/admin/drink-plans', badgeKey: 'pending_shopping_lists' },
    { id: 'menu',        label: 'Cocktail Menu', icon: 'book',  path: '/admin/cocktail-menu' },
    { id: 'blog',        label: 'Lab Notes',     icon: 'pen',   path: '/admin/blog' },
    { id: 'settings',    label: 'Settings',      icon: 'gear',  path: '/admin/settings' },
  ]},
];

export default NAV;
