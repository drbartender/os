// Nav groups for the Admin OS sidebar.
// `badgeKey` maps to the /api/admin/badge-counts response shape.
const NAV = [
  { section: 'Workspace', items: [
    { id: 'dashboard',   label: 'Dashboard', icon: 'home',      path: '/dashboard' },
    { id: 'events',      label: 'Events',    icon: 'calendar',  path: '/events',    badgeKey: 'unstaffed_events' },
    { id: 'proposals',   label: 'Proposals', icon: 'clipboard', path: '/proposals', badgeKey: 'pending_proposals' },
    { id: 'clients',     label: 'Clients',   icon: 'users',     path: '/clients' },
    { id: 'staff',       label: 'Staff',     icon: 'userplus',  path: '/staffing' },
    { id: 'hiring',      label: 'Hiring',    icon: 'pen',       path: '/hiring',    badgeKey: 'new_applications' },
  ]},
  { section: 'Revenue', items: [
    { id: 'financials',  label: 'Financials', icon: 'dollar',   path: '/financials' },
    { id: 'marketing',   label: 'Marketing',  icon: 'mail',     path: '/email-marketing' },
  ]},
  { section: 'Content', items: [
    { id: 'drink-plans', label: 'Drink Plans',   icon: 'flask', path: '/drink-plans', badgeKey: 'pending_shopping_lists' },
    { id: 'menu',        label: 'Cocktail Menu', icon: 'book',  path: '/cocktail-menu' },
    { id: 'blog',        label: 'Lab Notes',     icon: 'pen',   path: '/blog' },
    { id: 'settings',    label: 'Settings',      icon: 'gear',  path: '/settings' },
  ]},
];

export default NAV;
