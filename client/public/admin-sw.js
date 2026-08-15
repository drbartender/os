// Dr. Bartender admin OS service worker (mobile-admin spec section 7).
// Plain static JS, NOT webpack-bundled; served at the origin root so it can
// control top-level navigations. Three jobs:
//   1. push events -> OS notifications (pattern copied from staff-sw.js).
//   2. notificationclick -> focus or open the deep link.
//   3. Offline shell + stamped read cache:
//      - navigations: network-first, fall back to cached index.html
//      - content-HASHED /static/ assets: cache-first (immutable by name);
//        the dev server's stable bundle names are deliberately excluded
//      - allowlisted GET */api/*: network-first; good responses are cached
//        stamped with x-sw-cached-at; on transport failure (never on a
//        server-answered non-2xx) the stamped copy is served so the UI shows
//        staleness instead of a spinner. Non-GET is NEVER touched: writes
//        fail loudly and are never queued (spec: no offline writes).
// Bump SW_VERSION on every meaningful change (staff-sw.js convention).
//
// ---- Rollback recipe (a registered SW outlives a git revert) --------------
// To KILL a shipped admin SW: replace this file's body with the stub below,
// bump SW_VERSION, deploy. Browsers pick it up on their next update check,
// it unregisters itself and drops every admin cache. The kill path is
// verified once in the lane's browser pass via registration.unregister().
//   self.addEventListener('install', () => self.skipWaiting());
//   self.addEventListener('activate', (e) => e.waitUntil((async () => {
//     const names = await caches.keys();
//     await Promise.all(names
//       .filter((n) => n.startsWith('admin-'))
//       .map((n) => caches.delete(n)));
//     await self.registration.unregister();
//   })()));
const SW_VERSION = 'admin-sw-2026-08-14-v8';
const SHELL_CACHE = `admin-shell-${SW_VERSION}`;
const API_CACHE = `admin-api-${SW_VERSION}`;

// Content-hash shape react-scripts build emits (main.a1b2c3d4.js). The dev
// server's stable names never match, which is deliberate: cache-first on
// /static/js/bundle.js would pin a frozen bundle on the dev box.
const CONTENT_HASHED = /\.[0-9a-f]{8}\./;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(SHELL_CACHE);
      await cache.add('/index.html').catch(() => {});
      // Precache ONLY the entrypoints CRA lists in asset-manifest.json.
      // Rationale: Chrome's memory cache sits above the SW, so the entry
      // bundle on a controlled reload can bypass the fetch handler and be
      // missing offline. That argument covers the ENTRYPOINTS; lazy route
      // chunks reach the SW on their first cold-session navigation and are
      // runtime-cached organically. A full manifest sweep was tried and
      // rejected by review: 22.6 MB per SW update (16 MB of source maps)
      // onto a phone, for chunks the admin surface may never load.
      const resp = await fetch('/asset-manifest.json');
      if (resp.ok) {
        const manifest = await resp.json();
        const entry = (manifest.entrypoints || [])
          .map((p) => (p.startsWith('/') ? p : `/${p}`))
          .filter((p) => p.startsWith('/static/') && CONTENT_HASHED.test(p) && !p.endsWith('.map'));
        await Promise.all(entry.map((p) => cache.add(p).catch(() => {})));
      }
    } catch (e) { /* no manifest (dev) or offline install: runtime caching still applies */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // Purge by VERSION with exact segment matching: per-user API caches are
    // named admin-api-<SW_VERSION>-u<id>. A substring test would let "-v3"
    // match "-v30" and a rollback would retain the newer caches.
    const isCurrent = (n) =>
      n === SHELL_CACHE || n === API_CACHE || n.startsWith(`${API_CACHE}-u`);
    await Promise.all(
      names
        .filter((n) =>
          (n.startsWith('admin-shell-') || n.startsWith('admin-api-')) && !isCurrent(n))
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

async function stampAndPut(cache, key, response) {
  try {
    const headers = new Headers(response.headers);
    headers.set('x-sw-cached-at', new Date().toISOString());
    const body = await response.clone().blob();
    await cache.put(
      key,
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    );
  } catch (e) {
    // Cache quota or opaque body: never let caching break the live response.
  }
}

// Per-user API cache namespace (spec section 7: managers share these routes;
// one device must never show another user's cached data). The client posts
// the authenticated user id after registration; it is persisted in a tiny
// meta cache so it survives SW restarts.
let userId = null;
let userIdLoad = null; // in-flight/settled load promise; a boolean raced
// Identity epoch: bumped by every announce/logout. In-flight closures that
// captured an older epoch must neither assign userId nor serve a cached
// Response they resolved under the previous identity (push-gate findings:
// a held Response stays valid after caches.delete, and a stale meta read
// could resurrect the old user after logout).
let epoch = 0;
let msgQueue = Promise.resolve(); // serializes announce/logout handling
const META_CACHE = 'admin-meta';
const apiCacheName = () => `${API_CACHE}-u${userId || 'anon'}`;

async function purgeApiCaches({ keepCurrent = false } = {}) {
  const names = await caches.keys();
  await Promise.all(names
    .filter((n) => n.startsWith('admin-api-') && !(keepCurrent && n === apiCacheName()))
    .map((n) => caches.delete(n)));
}

function loadUserId() {
  // Memoize the PROMISE, not a flag: with a boolean, concurrent cold-start
  // reads returned immediately while the first caller was still reading
  // admin-meta, and fell into the shared anon namespace (re-confirm round).
  if (!userIdLoad) {
    userIdLoad = (async () => {
      const startEpoch = epoch;
      try {
        // caches.open CREATES a missing cache, so a read racing the logout
        // purge would resurrect an empty admin-meta. Only the announce
        // creates it.
        if (!(await caches.keys()).includes(META_CACHE)) return;
        const meta = await caches.open(META_CACHE);
        const hit = await meta.match('/__admin-user');
        if (hit) {
          const id = (await hit.text()) || null;
          // A logout/announce that landed mid-read owns the identity now;
          // a stale read must never resurrect the previous user.
          if (epoch === startEpoch) userId = id;
        }
      } catch (e) { /* stay anon */ }
    })();
  }
  return userIdLoad;
}

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  const run = (fn) => {
    msgQueue = msgQueue.then(fn).catch(() => {});
    event.waitUntil(msgQueue);
  };
  if (msg.type === 'admin-user' && /^\d+$/.test(String(msg.id))) {
    run(async () => {
      epoch += 1;
      userId = String(msg.id);
      userIdLoad = Promise.resolve();
      const meta = await caches.open(META_CACHE);
      await meta.put('/__admin-user', new Response(userId));
      await purgeApiCaches({ keepCurrent: true }); // evict other users' data
    });
  } else if (msg.type === 'admin-logout') {
    run(async () => {
      epoch += 1;
      userId = null;
      userIdLoad = Promise.resolve();
      await caches.delete(META_CACHE);
      await purgeApiCaches(); // spec section 7: full purge on logout
    });
  }
});

// Only phone-surface reads are ever cached (spec section 7 allowlist),
// matched PRECISELY: a bare /api/proposals prefix would sweep in the
// metadata/financials routes AND the public token surfaces
// (/api/proposals/public|t|group), writing client PII into the at-rest
// footprint (security review M3). Desktop-view traffic through the escape
// hatch (payroll, users, paystubs) must never land in Cache Storage.
const API_EXACT = new Set([
  '/api/shifts',
  '/api/proposals',
  '/api/admin/badge-counts',
  '/api/admin/search',
  '/api/admin/active-staff',
  // Offline cold-launch hydration (spec section 8): AuthContext boots from
  // the cached /auth/me when the network is gone. Transport-failure-only
  // fallback still applies, and a server-answered 401 EVICTS the entry (late
  // 401 rule below), so a revoked session renders no data.
  '/api/auth/me',
]);
const isAllowlisted = (pathname) =>
  API_EXACT.has(pathname) ||
  /^\/api\/proposals\/\d+$/.test(pathname) ||
  pathname.startsWith('/api/shifts/by-proposal/');

// Race a live fetch against a timeout. Weak signal hangs rather than failing
// (cross-origin API + CORS preflight); with a cached copy in hand we prefer
// stale-with-a-label over a spinner (spec section 7). Without one, wait it
// out. The in-flight request is NOT abandoned on timeout: when it eventually
// lands, the late response still refreshes the cache stamp, so a
// persistently slow link doesn't freeze "as of" forever.
const TIMEOUT_MS = 4000;
function raceWithTimeout(fetchPromise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sw-timeout')), TIMEOUT_MS);
    fetchPromise.then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // writes are never intercepted, never queued
  const url = new URL(req.url);

  // App-shell navigations (same-origin only).
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        // Only a GOOD HTML document may become the offline shell: a
        // transient 500 page, OR a direct address-bar navigation to a JSON
        // asset like /admin-manifest.json (a same-origin `navigate` with a
        // 200), cached here would be what every later offline launch boots.
        // The clone MUST happen synchronously before `return fresh` resolves
        // respondWith: once the browser drains the body, clone() throws and
        // the write silently dies (re-confirm round caught exactly that).
        // waitUntil keeps the SW alive for the deferred write.
        const contentType = fresh.headers.get('content-type') || '';
        if (fresh.ok && contentType.includes('text/html')) {
          const copy = fresh.clone();
          event.waitUntil(
            caches.open(SHELL_CACHE)
              .then((cache) => stampAndPut(cache, '/index.html', copy))
              .catch(() => {})
          );
        }
        return fresh;
      } catch (e) {
        const cached = await caches.match('/index.html');
        return cached || Response.error();
      }
    })());
    return;
  }

  // Bundle assets: cache-first ONLY for content-hashed filenames; see the
  // CONTENT_HASHED note at the top (dev bundle stays un-pinned).
  if (url.origin === self.location.origin && url.pathname.startsWith('/static/')
      && CONTENT_HASHED.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      if (fresh.ok) {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(req, fresh.clone());
      }
      return fresh;
    })());
    return;
  }

  // API reads. Matched by path, not origin: dev talks to localhost:5000/api,
  // prod to the api host on Render (REACT_APP_API_URL), and the SW sees both
  // because the page is the client. Cross-origin note for future readers:
  // this works BECAUSE the SW's fetch handler runs before the CORS preflight
  // (offline fallback fires even though a preflight would fail) and a
  // SW-synthesized Response is not CORS-filtered, so x-sw-cached-at is
  // readable by axios. Do not "fix" it with Access-Control-Expose-Headers.
  // Cache law (spec section 7): allowlisted paths only; fallback ONLY on
  // transport failure or timeout-with-cache. A server-answered non-2xx
  // (401/403 after expiry or revocation) is returned as-is, NEVER answered
  // from cache: a dead session renders no data.
  if (url.pathname.startsWith('/api/') && isAllowlisted(url.pathname)) {
    event.respondWith((async () => {
      // CacheStorage can be unavailable outright (storage denied, some
      // private modes). The read path must degrade to a plain fetch, never
      // fail a healthy network request over a cache error.
      let cache = null;
      let cached;
      let startEpoch;
      try {
        await loadUserId();
        startEpoch = epoch;
        cache = await caches.open(apiCacheName());
        cached = await cache.match(req);
      } catch (e) {
        return fetch(req);
      }
      const live = fetch(req.clone());
      // Late responses still refresh the stamp; a late 401/403 EVICTS the
      // entry instead, so a revoked session's cached copy dies as soon as
      // the server answers, even when the answer lost the timeout race.
      live.then((res) => {
        if (res.ok) stampAndPut(cache, req, res);
        else if (res.status === 401 || res.status === 403) cache.delete(req);
      }).catch(() => {});
      try {
        return cached ? await raceWithTimeout(live) : await live;
      } catch (e) {
        // Identity changed while this read was in flight: the held cached
        // Response may belong to the PREVIOUS user (it stays readable even
        // after its cache was purged). Refuse the stale serve.
        if (cached && epoch === startEpoch) return cached;
        throw e;
      }
    })());
  }
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

      // Prefer focusing an already-open admin window pointing at the target
      // path. `URL.pathname` comparison keeps us host-agnostic (the worker
      // only ever runs on the admin origin, but matching by pathname avoids
      // surprises when query strings differ).
      let targetPath = targetUrl;
      try {
        targetPath = new URL(targetUrl, self.location.origin).pathname;
      } catch (e) {
        // targetUrl was not a parseable URL; fall through to substring check.
      }

      // A bare default ('/') means "just focus the app": match any open
      // admin window. A real targetPath focuses the window already on it.
      // Exact pathname equality: a substring test would focus /shifts/10
      // when the notification targets /shifts/1 (push-gate finding; the
      // same latent bug ships in staff-sw.js and is tracked separately).
      const isRootDefault = targetPath === '/';
      for (const client of allClients) {
        if (!('focus' in client)) continue;
        let clientPath = null;
        try { clientPath = new URL(client.url).pathname; } catch (e) { clientPath = null; }
        if (isRootDefault || clientPath === targetPath) {
          return client.focus();
        }
      }

      // No matching window: open a new one. `openWindow` can be undefined in
      // some embedded contexts, so guard the call.
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return null;
    })()
  );
});
