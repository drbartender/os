// Inject the staff-scoped PWA metadata at runtime.
//
// Why a runtime injection instead of edits to client/public/index.html: the
// same built bundle (and the same index.html) serves admin, public marketing,
// hiring, AND staff — only the React tree differs based on the host (see
// getSiteContext in App.js). A static <link rel="manifest"> in index.html
// would point admin and public users at the staff manifest too, which would
// claim the wrong start_url ('/' resolves differently per host) and pollute
// the "Add to Home Screen" install prompt on every surface.
//
// iOS web push (16.4+) requires the site to be installed as a PWA running in
// standalone mode, which in turn requires `apple-mobile-web-app-capable` +
// a Web App Manifest. So this runs ONLY on the staff host. The function is
// idempotent — calling it multiple times (e.g. on re-mounts after navigation)
// is a safe no-op after the first call.

const MARKER_ATTR = 'data-staff-pwa';

/**
 * Append the staff PWA manifest link + the iOS standalone-mode meta tags to
 * <head>. Runs only when the current hostname starts with `staff.` and only
 * once per document (guarded by a [data-staff-pwa] marker so React-strict
 * double-mounts and route re-renders are no-ops).
 */
export function installStaffPwaMeta() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // This host check is the ONLY barrier stopping admin / public / hiring (which
  // share this same built bundle and StaffShellWithThemeWiring mount) from
  // getting the staff manifest + "Add to Home Screen" prompt. Do not loosen it
  // without re-checking every site-context in App.js getSiteContext().
  const host = window.location && window.location.hostname;
  if (!host || !host.startsWith('staff.')) return;

  // Idempotency guard. We tag every node we inject with this attribute and
  // check for any prior tag before doing the work again.
  if (document.head.querySelector(`[${MARKER_ATTR}]`)) return;

  const head = document.head;

  // <link rel="manifest"> — points iOS Safari at the staff manifest. Note
  // that the apple-touch-icon link is already declared globally in
  // index.html, so we do NOT re-add it here.
  const manifestLink = document.createElement('link');
  manifestLink.rel = 'manifest';
  manifestLink.href = '/staff-manifest.json';
  manifestLink.setAttribute(MARKER_ATTR, '');
  head.appendChild(manifestLink);

  // iOS standalone-mode meta tags. Without these, "Add to Home Screen" opens
  // in Safari (which can't receive web push) instead of as a standalone PWA.
  const metas = [
    { name: 'apple-mobile-web-app-capable', content: 'yes' },
    // mobile-web-app-capable is the spec-aligned replacement; iOS still
    // requires the apple-prefixed one, and Chrome/Android prefers this.
    { name: 'mobile-web-app-capable', content: 'yes' },
    { name: 'apple-mobile-web-app-title', content: 'DrB Staff' },
    // black-translucent gives the staff app a full-bleed dark status bar,
    // matching the After Hours skin's #0b0d10 background.
    { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
  ];

  for (const { name, content } of metas) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', name);
    meta.setAttribute('content', content);
    meta.setAttribute(MARKER_ATTR, '');
    head.appendChild(meta);
  }
}
