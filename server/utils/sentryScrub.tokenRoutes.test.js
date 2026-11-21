// server/utils/sentryScrub.tokenRoutes.test.js
//
// The guard on server/utils/sentryScrub.js: every route under server/routes
// with a path parameter named like a token or a secret is listed here with
// the shape of its token, and no part of a token of that shape survives scrubUrl or either
// Sentry pipeline. A new token route fails the first test until it is listed,
// because naming the token paths by hand is how nine of them reached Sentry
// raw (2026-11-16).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { scrubUrl, scrubErrorEvent, scrubTransactionEvent } = require('./sentryScrub');

const ROUTES_DIR = path.join(__dirname, '..', 'routes');

// The mount of each file that declares a token route (server/index.js, and the
// composition routers under it). Only used to make a sample look like the real
// URL: the value rules redact a UUID or a JWT wherever it sits.
const MOUNTS = {
  'calendar.js': '/api/calendar',
  'clientPortal.js': '/api/client-portal',
  'clientPortal/changeRequests.js': '/api/client-portal',
  'drinkPlans.js': '/api/drink-plans',
  'drinkPlans/lab.js': '/api/drink-plans',
  'drinkPlans/shoppingList.js': '/api/drink-plans',
  'invoices.js': '/api/invoices',
  'menuProof.js': '/api/menu-proof',
  'proposals/compareGroup.js': '/api/proposals',
  'proposals/public.js': '/api/proposals',
  'proposals/publicOptions.js': '/api/proposals',
  'proposals/publicSwitch.js': '/api/proposals',
  'proposals/publicToken.js': '/api/proposals',
  'publicFeedback.js': '/api/public/feedback',
  'publicTip.js': '/api/public/tip',
  'serviceExtensions/publicAccept.js': '/api/service-extensions',
  'stripe.js': '/api/stripe',
  'stripeCreateIntent.js': '/api/stripe',
  'telegram.js': '/api/telegram',
  'voicemailListen.js': '/api/voice/vm',
};

// Every token route, by file and path, with the shape of the token the
// system mints for it. A new token route goes here; if its token is neither
// a UUID nor a JWT, it also needs a path rule in scrubUrl and a shape below.
const TOKEN_ROUTES = {
  'calendar.js /feed/:token': 'uuid',
  'clientPortal.js /proposals/:token': 'uuid',
  'clientPortal/changeRequests.js /proposals/:token/calculate': 'uuid',
  'clientPortal/changeRequests.js /proposals/:token/change-requests': 'uuid',
  'clientPortal/changeRequests.js /proposals/:token/change-requests/:id/cancel': 'uuid',
  'drinkPlans.js /t/:token': 'uuid',
  'drinkPlans.js /t/:token/lab-cta': 'uuid',
  'drinkPlans.js /t/:token/logo': 'uuid',
  'drinkPlans/lab.js /t/:token/lab': 'uuid',
  'drinkPlans/shoppingList.js /t/:token/shopping-list': 'uuid',
  'invoices.js /client/:proposalToken': 'uuid',
  'invoices.js /t/:token': 'uuid',
  'menuProof.js /:token': 'uuid',
  'menuProof.js /:token/answer': 'uuid',
  'menuProof.js /:token/image': 'uuid',
  'proposals/compareGroup.js /group/:token': 'uuid',
  'proposals/compareGroup.js /group/:token/preview': 'uuid',
  'proposals/public.js /public/quote-draft/:token': 'uuid',
  'proposals/publicOptions.js /t/:token/options': 'uuid',
  'proposals/publicSwitch.js /t/:token/switch': 'uuid',
  'proposals/publicToken.js /t/:token': 'uuid',
  'proposals/publicToken.js /t/:token/payment-state': 'uuid',
  'proposals/publicToken.js /t/:token/resolve': 'uuid',
  'proposals/publicToken.js /t/:token/sign': 'uuid',
  'publicFeedback.js /:token': 'uuid',
  'publicTip.js /:token': 'uuid',
  'publicTip.js /:token/feedback': 'uuid',
  'serviceExtensions/publicAccept.js /t/:token/accept': 'uuid',
  'stripe.js /create-drink-plan-intent/:token': 'uuid',
  'stripe.js /create-intent-for-invoice/:token': 'uuid',
  'stripeCreateIntent.js /create-intent/:token': 'uuid',
  // 24 random bytes as hex (.env.example, TELEGRAM_WEBHOOK_SECRET).
  'telegram.js /:secret': 'hex48',
  'voicemailListen.js /:token': 'uuid',
};

// Made-up tokens of each shape (none is a real one). The UUIDs open with
// letters so no digit run reads as a phone number to the PII scan.
const SAMPLES = {
  uuid: ['abcdef12-3456-4789-8abc-def012345678', 'FEDCBA98-7654-4321-ABCD-EF0123456789'],
  jwt: ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzd2FwIjoiY292ZXIifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ'],
  hex48: ['cd'.repeat(24)],
};

// A path parameter that carries a credential: named like a token or a secret.
const CREDENTIAL_PARAM = /:[A-Za-z0-9_]*(?:token|secret)/i;

function routeFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...routeFiles(p));
    else if (p.endsWith('.js') && !p.endsWith('.test.js')) out.push(p);
  }
  return out;
}

// Every router.<method>('<path>') call, router.use and router.route included
// (the path may sit on the next line, behind a comment), whose path has a
// parameter that carries a credential.
const ROUTE_CALL = /router\.(?:get|post|put|patch|delete|all|use|route)\(\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*(['"`])([^'"`]+)\1/g;

function tokenRoutes() {
  const found = new Set();
  for (const file of routeFiles(ROUTES_DIR)) {
    const rel = path.relative(ROUTES_DIR, file).split(path.sep).join('/');
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(ROUTE_CALL)) {
      if (CREDENTIAL_PARAM.test(m[2])) found.add(`${rel} ${m[2]}`);
    }
  }
  return [...found].sort();
}

// The sample URL for one route: the token parameter gets the token, any other
// parameter a small row id.
function sampleUrl(key, token) {
  const [file, routePath] = key.split(' ');
  const filled = routePath.replace(/:([A-Za-z0-9_]+)/g, (m, name) => (/token|secret/i.test(name) ? token : '42'));
  return { path: `${MOUNTS[file]}${filled}`, full: `https://api.drbartender.com${MOUNTS[file]}${filled}?x=1` };
}

function leaks(text, token) {
  const s = String(text).toLowerCase();
  const t = token.toLowerCase();
  return s.includes(t) || s.includes(t.slice(0, 8)) || s.includes(t.slice(-12));
}

test('every server route with a token or secret parameter is listed with its token shape', () => {
  const found = tokenRoutes();
  const missing = found.filter((k) => !TOKEN_ROUTES[k]);
  assert.deepEqual(missing, [], `token routes with no entry in TOKEN_ROUTES: ${missing.join('; ')}. `
    + 'Add each with the shape of its token (uuid or jwt); a token of any other shape also needs a path rule in sentryScrub.js scrubUrl and a shape in SAMPLES.');
  const stale = Object.keys(TOKEN_ROUTES).filter((k) => !found.includes(k));
  assert.deepEqual(stale, [], `TOKEN_ROUTES entries that match no route any more: ${stale.join('; ')}`);
  for (const k of found) assert.ok(MOUNTS[k.split(' ')[0]], `no mount listed for ${k.split(' ')[0]}`);
  for (const k of found) assert.ok(SAMPLES[TOKEN_ROUTES[k]], `${k}: no sample for the shape ${TOKEN_ROUTES[k]}`);
});

test('the discovery reads every route shape the codebase could use, and every credential param name', () => {
  const src = [
    "router.get('/a/:token', h);",
    'router.post(\n  "/b/:secret",\n  h);',
    "router.route('/c/:token').get(h);",
    "router.use(`/d/:token`, h);",
    "router.put(/* why */ '/e/:token', h);",
    "router.patch(\n  // why\n  '/f/:token', h);",
  ].join('\n');
  assert.deepEqual([...src.matchAll(ROUTE_CALL)].map((m) => m[2]),
    ['/a/:token', '/b/:secret', '/c/:token', '/d/:token', '/e/:token', '/f/:token']);
  for (const p of ['/x/:token', '/x/:proposalToken', '/x/:oauth2Token', '/:secret', '/x/:swapToken/y']) {
    assert.ok(CREDENTIAL_PARAM.test(p), p);
  }
  for (const p of ['/x/:id', '/inbox/:personKey', '/draft/:formKey']) assert.equal(CREDENTIAL_PARAM.test(p), false, p);
});

test('scrubUrl leaves no part of any listed route\'s token, in the path, the full URL or an encoded redirect', () => {
  for (const [key, shape] of Object.entries(TOKEN_ROUTES)) {
    for (const token of SAMPLES[shape]) {
      const { path: p, full } = sampleUrl(key, token);
      assert.equal(leaks(scrubUrl(p), token), false, `${key}: ${scrubUrl(p)}`);
      assert.equal(leaks(scrubUrl(full), token), false, `${key}: ${scrubUrl(full)}`);
      const encoded = `https://admin.drbartender.com/login?next=${encodeURIComponent(p)}`;
      assert.equal(leaks(scrubUrl(encoded), token), false, `${key}: ${scrubUrl(encoded)}`);
    }
  }
});

test('no listed route\'s token leaves either Sentry pipeline', () => {
  for (const [key, shape] of Object.entries(TOKEN_ROUTES)) {
    for (const token of SAMPLES[shape]) {
      const { path: p, full } = sampleUrl(key, token);
      const txn = scrubTransactionEvent({
        transaction: `GET ${p}`,
        request: { url: full },
        tags: { route: p },
        contexts: { trace: { data: { url: full, 'http.url': full, 'url.full': full, 'http.target': p } } },
        spans: [{ description: `GET ${full}`, data: { url: full, 'url.path': p } }],
        breadcrumbs: [{ message: `GET ${full}`, data: { url: full } }],
      });
      assert.equal(leaks(JSON.stringify(txn), token), false, `${key}: a transaction`);
      // Redacted, not dropped: a fail-closed marker would also hide the token.
      assert.equal(txn.tags.scrub_failed, undefined, `${key}: the transaction failed closed`);
      assert.match(txn.request.url, /\[redacted/, `${key}: the transaction kept its URL`);
      const err = scrubErrorEvent({
        transaction: p,
        request: { url: full },
        tags: { route: p },
        breadcrumbs: [{ message: `GET ${full}`, data: { url: full } }],
      });
      assert.equal(leaks(JSON.stringify(err), token), false, `${key}: an error event`);
      assert.equal(err.tags.scrub_failed, undefined, `${key}: the error event failed closed`);
      assert.match(err.request.url, /\[redacted/, `${key}: the error event kept its URL`);
    }
  }
});

// The Claude connector (spec 2026-11-19 law 8). Its credentials ride in no
// path parameter, so the discovery above never sees them: a sign-in code goes
// back to Claude in the return address's query (the approve route's
// redirect_url), an access token rides in the Authorization header of POST
// /mcp, and the token route's form body carries a code, a verifier or a
// refresh token. Every one of them carries the fixed prefix of
// server/utils/connector/tokens.js and is redacted by it. Each connector
// route is listed here with where its credential rides, so a new connector
// route fails until it says.
const CONNECTOR_ROUTE_FILES = ['connectorMcp.js', 'connectorOauth.js', 'admin/connector.js'];
const CONNECTOR_ROUTES = {
  'admin/connector.js /connector': 'none',
  'admin/connector.js /connector/assert-options': 'none',
  'admin/connector.js /connector/calls': 'none',
  'admin/connector.js /connector/disconnect': 'none',
  'admin/connector.js /connector/requests/:id': 'none',
  'admin/connector.js /connector/requests/:id/approve': 'query',
  'admin/connector.js /connector/requests/:id/cancel': 'none',
  'admin/connector.js /connector/status': 'none',
  'connectorMcp.js /': 'header',
  'connectorOauth.js /.well-known': 'none',
  'connectorOauth.js /.well-known/oauth-authorization-server': 'none',
  'connectorOauth.js /.well-known/oauth-protected-resource': 'none',
  'connectorOauth.js /.well-known/oauth-protected-resource/mcp': 'none',
  'connectorOauth.js /oauth': 'none',
  'connectorOauth.js /oauth/authorize': 'none',
  'connectorOauth.js /oauth/token': 'body',
};

test('every Claude connector route is listed with where its credential rides', () => {
  const found = new Set();
  for (const rel of CONNECTOR_ROUTE_FILES) {
    const src = fs.readFileSync(path.join(ROUTES_DIR, rel), 'utf8');
    for (const m of src.matchAll(ROUTE_CALL)) found.add(`${rel} ${m[2]}`);
  }
  const missing = [...found].filter((k) => !CONNECTOR_ROUTES[k]).sort();
  assert.deepEqual(missing, [], `connector routes with no entry in CONNECTOR_ROUTES: ${missing.join('; ')}`);
  const stale = Object.keys(CONNECTOR_ROUTES).filter((k) => !found.has(k));
  assert.deepEqual(stale, [], `CONNECTOR_ROUTES entries that match no route any more: ${stale.join('; ')}`);
});

test('no Claude connector token or code leaves scrubUrl or either Sentry pipeline, wherever it rides', () => {
  const tokens = require('./connector/tokens');
  for (const prefix of [tokens.ACCESS_PREFIX, tokens.REFRESH_PREFIX, tokens.CODE_PREFIX]) {
    for (let i = 0; i < 20; i += 1) {
      const token = tokens.mint(prefix);
      const back = `https://claude.ai/api/mcp/auth_callback?code=${token}&state=abc`;
      const form = `grant_type=refresh_token&refresh_token=${token}&client_id=x`;
      const bearer = `Authorization: Bearer ${token}`;
      for (const text of [back, encodeURIComponent(back), form, bearer, `failed for ${token}.`]) {
        assert.equal(leaks(scrubUrl(text), token), false, scrubUrl(text));
      }
      const err = scrubErrorEvent({
        message: `token route failed: ${token}`,
        request: { url: 'https://api.drbartender.com/oauth/token', query_string: `code=${token}`, data: form },
        tags: { route: '/oauth/token' },
        extra: { body: form, header: bearer },
        breadcrumbs: [{ message: `GET ${back}`, data: { url: back } }],
      });
      assert.equal(leaks(JSON.stringify(err), token), false, 'an error event');
      assert.equal(err.tags.scrub_failed, undefined, 'the error event failed closed');
      const txn = scrubTransactionEvent({
        transaction: 'POST /mcp',
        request: { url: back },
        contexts: { trace: { data: { url: back, 'http.request.body': form } } },
        spans: [{ description: `GET ${back}`, data: { url: back } }],
        breadcrumbs: [{ message: bearer }],
      });
      assert.equal(leaks(JSON.stringify(txn), token), false, 'a transaction');
      assert.match(txn.request.url, /\[redacted-connector-token\]/, 'the transaction kept its URL');
    }
  }
});
