// Route -> screen-key mapping for the Desktop-view override store and the
// mobile header title. Detail screens get their own key so "desktop for this
// event page" does not drag the list along with it. Titles come from the nav
// LABELS, not the URL segment: /staffing is "Staff", /blog is "Lab Notes",
// and /email-marketing must never render as "Email-marketing".
import NAV from '../components/adminos/nav';
export function routeScreenKey(pathname) {
  const segs = (pathname || '/').split('/').filter(Boolean);
  if (segs.length === 0) return 'dashboard';
  if (segs[0] === 'events') return segs.length > 1 ? 'event-detail' : 'events-list';
  if (segs[0] === 'proposals') return segs.length > 1 ? 'proposal-detail' : 'proposals-list';
  return segs[0];
}

const TITLES = {
  'events-list': 'Events',
  'event-detail': 'Event',
  'proposals-list': 'Proposals',
  'proposal-detail': 'Proposal',
  more: 'More',
  dashboard: 'Overview',
};

// First-URL-segment -> nav label ("staffing" -> "Staff"). Every Staff hub child
// shares the "staffing" key (one Desktop-view override for the hub).
const SEGMENT_LABELS = (() => {
  const map = {};
  NAV.forEach((section) => section.items.forEach((item) => {
    const seg = (item.path || '').split('/')[1];
    if (seg) map[seg] = item.label;
  }));
  return map;
})();

export function screenTitle(screenKey) {
  if (TITLES[screenKey]) return TITLES[screenKey];
  if (SEGMENT_LABELS[screenKey]) return SEGMENT_LABELS[screenKey];
  return screenKey.charAt(0).toUpperCase() + screenKey.slice(1);
}
