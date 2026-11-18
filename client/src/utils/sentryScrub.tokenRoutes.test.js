// client/src/utils/sentryScrub.tokenRoutes.test.js
//
// The guard on client/src/utils/sentryScrub.js: every Route in App.js with a
// path parameter named like a token is listed here with the shape of its
// token, and no part of a token of that shape survives scrubText or the three
// hooks, in the page URL, a Referer or a navigation breadcrumb. A new token
// page fails the first test until it is listed, because this scrub once named
// only the menu proof and every other token page reached Sentry raw
// (2026-11-16).
import fs from 'fs';
import path from 'path';
import { scrubText, beforeSend, beforeSendTransaction, beforeBreadcrumb } from './sentryScrub';

// Every token page, with the shape of the token the system mints for it. A new
// one goes here; a token that is neither a UUID nor a JWT also needs a path
// rule in sentryScrub.js (TOKEN_PATH) and a shape below.
const TOKEN_PAGES = {
  '/compare/:token': 'uuid',
  '/compare/:token/preview': 'uuid',
  '/feedback/:token': 'uuid',
  '/invoice/:token': 'uuid',
  '/menu-proof/:token': 'uuid',
  '/my-proposals/:token/:tab': 'uuid',
  '/plan/:token': 'uuid',
  '/plan/:token/lab': 'uuid',
  '/proposal/:token': 'uuid',
  // 32 random bytes as hex (server/routes/auth.js).
  '/reset-password/:token': 'hex64',
  '/shopping-list/:token': 'uuid',
  '/tip/:token': 'uuid',
  '/tip/:token/display': 'uuid',
  '/tip/:token/thanks': 'uuid',
  // 32 random bytes as base64url (server/routes/staffPortal.js).
  '/verify-email/:token': 'base64url43',
};

// Made-up tokens of each shape (none is a real one). The UUIDs open with
// letters so no digit run reads as a phone number to the PII scan.
const SAMPLES = {
  uuid: ['abcdef12-3456-4789-8abc-def012345678', 'FEDCBA98-7654-4321-ABCD-EF0123456789'],
  hex64: ['ab'.repeat(32)],
  base64url43: ['Zm9vYmFyYmF6cXV4LXNlY3JldC10b2tlbi1oZXJlXw'],
};

// A path attribute in double or single quotes, or a quoted string in braces.
const PATH_ATTR = /path=(?:"([^"]+)"|'([^']+)'|\{\s*['"`]([^'"`]+)['"`]\s*\})/g;
const CREDENTIAL_PARAM = /:[A-Za-z0-9_]*(?:token|secret)/i;

function tokenPages() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
  const found = new Set();
  for (const m of src.matchAll(PATH_ATTR)) {
    const p = m[1] || m[2] || m[3];
    if (CREDENTIAL_PARAM.test(p)) found.add(p);
  }
  return [...found].sort();
}

function pageUrl(routePath, token) {
  const filled = routePath.replace(/:([A-Za-z0-9_]+)/g, (m, name) => (/token|secret/i.test(name) ? token : 'details'));
  return { path: filled, full: `https://drbartender.com${filled}?from=email#top` };
}

function leaks(text, token) {
  const s = String(text).toLowerCase();
  const t = token.toLowerCase();
  return s.includes(t) || s.includes(t.slice(0, 8)) || s.includes(t.slice(-12));
}

test('every App.js route with a token parameter is listed with its token shape', () => {
  const found = tokenPages();
  const missing = found.filter((p) => !TOKEN_PAGES[p]);
  expect(missing).toEqual([]);
  const stale = Object.keys(TOKEN_PAGES).filter((p) => !found.includes(p));
  expect(stale).toEqual([]);
  for (const p of found) expect(SAMPLES[TOKEN_PAGES[p]]).toBeDefined();
});

test('the discovery reads double-quoted, single-quoted and braced paths, and every credential param name', () => {
  const src = '<Route path="/a/:token" />\n<Route path=\'/b/:token\' />\n<Route path={`/c/:token`} />\n<Route path={ "/d/:secret" } />';
  expect([...src.matchAll(PATH_ATTR)].map((m) => m[1] || m[2] || m[3])).toEqual(['/a/:token', '/b/:token', '/c/:token', '/d/:secret']);
  for (const p of ['/x/:token', '/x/:oauth2Token', '/:secret']) expect(CREDENTIAL_PARAM.test(p)).toBe(true);
  for (const p of ['/x/:id', '/inbox/:personKey?']) expect(CREDENTIAL_PARAM.test(p)).toBe(false);
});

test('scrubText leaves no part of any listed page\'s token, in the path, the full URL or an encoded redirect', () => {
  for (const [routePath, shape] of Object.entries(TOKEN_PAGES)) {
    for (const token of SAMPLES[shape]) {
      const { path: p, full } = pageUrl(routePath, token);
      const encoded = `https://admin.drbartender.com/login?next=${encodeURIComponent(p)}`;
      for (const s of [p, full, encoded]) {
        if (leaks(scrubText(s), token)) throw new Error(`${routePath}: ${scrubText(s)}`);
      }
    }
  }
});

test('no listed page\'s token leaves a hook: an error event, a transaction or a navigation crumb', () => {
  for (const [routePath, shape] of Object.entries(TOKEN_PAGES)) {
    for (const token of SAMPLES[shape]) {
      const { path: p, full } = pageUrl(routePath, token);
      const sent = [
        beforeSend({ request: { url: full, headers: { Referer: full } }, exception: { values: [{ value: `failed on ${full}` }] } }),
        beforeSendTransaction({ transaction: p, request: { url: full }, contexts: { trace: { data: { url: full } } } }),
        beforeBreadcrumb({ category: 'navigation', data: { from: '/', to: p } }),
      ];
      for (const item of sent) {
        // Redacted, not dropped: a hook that failed closed returns null, and
        // "null" would read as no leak.
        if (item === null) throw new Error(`${routePath}: a hook dropped the item`);
        if (leaks(JSON.stringify(item), token)) throw new Error(`${routePath}: ${JSON.stringify(item)}`);
      }
    }
  }
});
