// Dr. Bartender staff portal service worker.
//
// Plain static JS — NOT webpack-bundled, NOT imported by any module. Lives in
// /client/public so it's served at the origin root (`/staff-sw.js`), which is
// required for a service worker to control top-level navigations.
//
// Responsibilities (Phase 11):
//   1. Receive `push` events and surface them as native OS notifications.
//   2. On `notificationclick`, focus an already-open staff window pointing at
//      the target URL, or open a new one.
//
// Cache-bust marker: bump SW_VERSION on every meaningful change so browsers
// pick up the new file on the next `register()` (spec §6.17). Comment-only
// changes do not require a bump.
const SW_VERSION = 'sw-2026-06-03-v1';

self.addEventListener('install', () => {
  // Activate immediately on first install / on every update — no waiting on
  // the old SW to drop its clients. Push-only worker, no cached assets to
  // protect, so skipWaiting is safe.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim all open clients so the freshly-activated worker handles their
  // push events without waiting for a reload.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  // Defensive: the spec allows push events with no payload (a "wake-up"),
  // and event.data.json() throws on non-JSON payloads. Fall back to a generic
  // notification in every failure mode so the browser still surfaces SOMETHING
  // and we don't drop the message silently.
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json() || {};
    } catch (e) {
      payload = {};
    }
  }

  const title = payload.title || 'Dr. Bartender';
  const body = payload.body || '';
  const tag = payload.tag;
  const icon = payload.icon;
  const url = payload.url || '/';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon,
      data: { url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Prefer focusing an already-open staff window pointing at the target
      // path. `URL.pathname` comparison keeps us host-agnostic (the worker
      // only ever runs on the staff origin, but matching by pathname avoids
      // surprises when query strings differ).
      let targetPath = targetUrl;
      try {
        targetPath = new URL(targetUrl, self.location.origin).pathname;
      } catch (e) {
        // targetUrl wasn't a parseable URL — fall through to substring check.
      }

      // A bare default ('/') means "just focus the app" — match any open staff
      // window. A real targetPath focuses the window already on that path.
      const isRootDefault = targetPath === '/';
      for (const client of allClients) {
        if (!('focus' in client)) continue;
        if (isRootDefault || client.url.includes(targetPath)) {
          return client.focus();
        }
      }

      // No matching window — open a new one. `openWindow` can be undefined in
      // some embedded contexts, so guard the call.
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return null;
    })()
  );
});
