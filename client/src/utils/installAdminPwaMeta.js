// Inject the ADMIN-scoped PWA metadata at runtime. Sibling of
// installStaffPwaMeta.js, which stays untouched: the same built bundle serves
// admin, staff, hiring, and public, so each surface injects its own manifest
// behind its own host gate and the installs never collide (spec section 7).
// The FILENAME is load-bearing: scripts/sensitive-paths.txt lists it.
const MARKER_ATTR = 'data-admin-pwa';

// Mirrors getSiteContext()'s admin mapping in App.js (admin.* or bare
// localhost). staff./hiring./public hosts must never match.
export function isAdminHost(hostname) {
  if (!hostname) return false;
  return (
    hostname.startsWith('admin.') ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1'
  );
}

export function installAdminPwaMeta() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (!isAdminHost(window.location && window.location.hostname)) return;
  if (document.head.querySelector(`[${MARKER_ATTR}]`)) return;

  const head = document.head;

  const manifestLink = document.createElement('link');
  manifestLink.rel = 'manifest';
  manifestLink.href = '/admin-manifest.json';
  manifestLink.setAttribute(MARKER_ATTR, '');
  head.appendChild(manifestLink);

  const metas = [
    { name: 'mobile-web-app-capable', content: 'yes' },
    { name: 'apple-mobile-web-app-capable', content: 'yes' },
    { name: 'apple-mobile-web-app-title', content: 'DrB OS' },
    // Full-bleed status bar in standalone; the staff injector sets the same.
    { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
  ];
  for (const { name, content } of metas) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', name);
    meta.setAttribute('content', content);
    meta.setAttribute(MARKER_ATTR, '');
    head.appendChild(meta);
  }

  // index.html already ships a theme-color meta (#2C1F0E, apothecary) and
  // browsers honor the FIRST match, so injecting a second one is dead code.
  // Mutate the existing one in place on the admin host instead.
  const themeMeta = head.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', '#196ac8');

  // Safe-area insets (the tab bar sits over the gesture bar) need
  // viewport-fit=cover. Amend the existing viewport meta in place.
  const viewport = head.querySelector('meta[name="viewport"]');
  if (viewport) {
    const content = viewport.getAttribute('content') || '';
    if (!/viewport-fit/.test(content)) {
      viewport.setAttribute('content', `${content}, viewport-fit=cover`);
    }
  }
}
