import fs from 'fs';
import path from 'path';
import {
  scrubText, beforeSend, beforeSendTransaction, beforeBreadcrumb, SENTRY_SCRUB_HOOKS,
} from './sentryScrub';

// A ten-digit fixture in the reserved fiction range (exchange 555, line 0100
// to 0199). Never a real number: the repo is public.
const DIGITS = '7735550142';
const KEY = `p-${DIGITS}`;

test('the fixture is ten digits in the fiction range', () => {
  expect(DIGITS).toMatch(/^\d{3}55501\d{2}$/);
});

test('the server rule: /inbox/p-<digits> in any case, in a page path or an API path', () => {
  expect(scrubText(`https://admin.example.com/inbox/${KEY}`)).toBe('https://admin.example.com/inbox/p-[redacted]');
  expect(scrubText(`/api/admin/inbox/${KEY}/seen`)).toBe('/api/admin/inbox/p-[redacted]/seen');
  expect(scrubText(`/INBOX/P-${DIGITS}?x=1#y`)).toBe('/inbox/p-[redacted]?x=1#y');
});

test('a percent-encoded path is redacted too (a next= or redirect parameter carries one)', () => {
  expect(scrubText(`https://admin.example.com/login?next=%2Finbox%2Fp-${DIGITS}`))
    .toBe('https://admin.example.com/login?next=/inbox/p-[redacted]');
  expect(scrubText(`/x?r=%2finbox%2fp-${DIGITS}&y=1`)).toBe('/x?r=/inbox/p-[redacted]&y=1');
  expect(scrubText(`/x?r=/inbox%2Fp-${DIGITS}`)).toBe('/x?r=/inbox/p-[redacted]');
});

// The client menu proof page (spec 2026-10-19 section 18): the UUID in
// /menu-proof/<token> is the page's only credential, and it rides in the page
// URL, the Referer and all three API calls.
const PROOF_TOKEN = '11111111-2222-4333-8444-555555555555';

test('the menu proof token is redacted in the page path, the API paths and an encoded redirect, in either case', () => {
  expect(scrubText(`https://drbartender.com/menu-proof/${PROOF_TOKEN}`)).toBe('https://drbartender.com/menu-proof/[redacted]');
  expect(scrubText(`/api/menu-proof/${PROOF_TOKEN}`)).toBe('/api/menu-proof/[redacted]');
  expect(scrubText(`/api/menu-proof/${PROOF_TOKEN}/image`)).toBe('/api/menu-proof/[redacted]/image');
  expect(scrubText(`/api/menu-proof/${PROOF_TOKEN}/answer?x=1#y`)).toBe('/api/menu-proof/[redacted]/answer?x=1#y');
  expect(scrubText(`/login?next=%2Fmenu-proof%2F${PROOF_TOKEN}&y=1`)).toBe('/login?next=/menu-proof/[redacted]&y=1');
  expect(scrubText(`/MENU-PROOF/${PROOF_TOKEN.toUpperCase()}`)).toBe('/menu-proof/[redacted]');
});

test('the menu proof token leaves no hook: an error event, a transaction and a navigation crumb', () => {
  const page = `https://drbartender.com/menu-proof/${PROOF_TOKEN}`;
  const api = `https://api.drbartender.com/api/menu-proof/${PROOF_TOKEN}/image`;
  const sent = [
    beforeSend({ request: { url: page, headers: { Referer: page } }, exception: { values: [{ value: `GET ${api} failed` }] } }),
    beforeSendTransaction({ transaction: `/menu-proof/${PROOF_TOKEN}`, spans: [{ description: `GET ${api}`, data: { url: api } }] }),
    beforeBreadcrumb({ category: 'navigation', data: { from: '/', to: `/menu-proof/${PROOF_TOKEN}` } }),
    beforeBreadcrumb({ category: 'xhr', data: { url: api, method: 'GET' } }),
  ];
  for (const item of sent) expect(JSON.stringify(item)).not.toContain(PROOF_TOKEN);
});

// Phone shapes by value (security review C1, 2026-10-09): a click crumb can
// carry a label with a formatted number in it, and an error's extra can carry
// a number. These fixtures are built from parts in code, never typed whole
// (the repo is public): a fiction-range number, exchange 555, line 0100 to 0199.
const AREA = '773';
const EXCH = '555';
const LINE = ['01', '57'].join('');
const SHOWN = `(${AREA}) ${EXCH}-${LINE}`;
const E164 = `+1${AREA}${EXCH}${LINE}`;

test('a display-shaped number is redacted inside a ui.click crumb message and inside an error extra', () => {
  const crumb = { category: 'ui.click', message: `div.m-sheet[aria-label="Snooze ${SHOWN}"] > button.m-sheet-row` };
  expect(beforeBreadcrumb(crumb, {}).message).toBe('div.m-sheet[aria-label="Snooze [number]"] > button.m-sheet-row');
  const out = beforeSend({ event_id: 'e2', extra: { name: SHOWN, to: E164, note: `texted ${E164} at noon` } }, {});
  expect(out.extra).toEqual({ name: '[number]', to: '[number]', note: 'texted [number] at noon' });
  expect(JSON.stringify(out)).not.toContain(`${EXCH}-${LINE}`);
});

test('an E.164 number is redacted on its own, US or not; a run past 15 digits is not a phone and stays', () => {
  expect(scrubText(`from ${E164}.`)).toBe('from [number].');
  // The server names a non-US texter by its raw E.164 string (a plus and 7 to
  // 15 digits); a fiction number built from the fixture's own parts.
  expect(scrubText(`from +44${AREA}${EXCH}${LINE} too`)).toBe('from [number] too');
  // Thirteen digits after the plus is a valid E.164 length, so it is redacted.
  expect(scrubText(`${E164}9`)).toBe('[number]');
  expect(scrubText(`+${'9'.repeat(16)}`)).toBe(`+${'9'.repeat(16)}`);
});

test('a bare ten-digit run is left alone: an epoch second or a row id has that shape too, so only the two phone shapes are redacted', () => {
  const run = `${AREA}${EXCH}${LINE}`;
  expect(scrubText(`id ${run} at 1760000000`)).toBe(`id ${run} at 1760000000`);
});

test('a bare key outside a path is redacted; c-, s- and t- keys stay readable', () => {
  expect(scrubText(`moved to ${KEY} just now`)).toBe('moved to p-[redacted] just now');
  expect(scrubText(KEY)).toBe('p-[redacted]');
  expect(scrubText('/inbox/c-12 /inbox/s-7 /inbox/t-neg_123')).toBe('/inbox/c-12 /inbox/s-7 /inbox/t-neg_123');
  expect(scrubText(`top-${DIGITS}`)).toBe(`top-${DIGITS}`);
});

const errorEvent = () => ({
  event_id: 'e1',
  level: 'error',
  message: `Request failed for ${KEY}`,
  request: {
    url: `https://admin.example.com/inbox/${KEY}`,
    headers: { Referer: `https://admin.example.com/inbox/${KEY}`, 'User-Agent': 'jest' },
  },
  exception: {
    values: [{
      type: 'Error',
      value: `GET /api/admin/inbox/${KEY} failed`,
      stacktrace: { frames: [{ filename: 'https://admin.example.com/static/js/main.js', lineno: 1 }] },
    }],
  },
  breadcrumbs: [
    { category: 'navigation', data: { from: '/inbox', to: `/inbox/${KEY}` } },
    { category: 'xhr', data: { method: 'GET', url: `https://api.example.com/api/admin/inbox/${KEY}`, status_code: 200 } },
    { category: 'console', message: `opened ${KEY}`, data: { arguments: ['opened', KEY], logger: 'console' } },
  ],
  tags: { route: `/inbox/${KEY}` },
  extra: { __serialized__: { message: `bad /inbox/${KEY}`, code: 'X', status: 500 }, [`seen:${KEY}`]: true },
  contexts: { trace: { data: { 'http.url': `/api/admin/inbox/${KEY}` } } },
  timestamp: 1760000000,
});

test('beforeSend scrubs every string in an error event, keys included, and never edits its input', () => {
  const input = errorEvent();
  const before = JSON.stringify(input);
  const out = beforeSend(input, {});
  expect(JSON.stringify(out)).not.toContain(DIGITS);
  expect(JSON.stringify(input)).toBe(before);
  expect(out.request.url).toBe('https://admin.example.com/inbox/p-[redacted]');
  expect(out.request.headers['User-Agent']).toBe('jest');
  expect(out.breadcrumbs[0].data.to).toBe('/inbox/p-[redacted]');
  expect(out.extra['seen:p-[redacted]']).toBe(true);
  expect(out.timestamp).toBe(1760000000);
  expect(out.exception.values[0].stacktrace.frames[0].lineno).toBe(1);
});

test('beforeSendTransaction scrubs the name, the trace data and every span', () => {
  const tx = {
    type: 'transaction',
    transaction: `/inbox/${KEY}`,
    contexts: { trace: { op: 'pageload', data: { url: `https://admin.example.com/inbox/${KEY}` } } },
    spans: [{
      op: 'http.client',
      description: `GET /api/admin/inbox/${KEY}`,
      data: { 'http.url': `/api/admin/inbox/${KEY}`, 'url.full': `https://api.example.com/api/admin/inbox/${KEY}` },
    }],
  };
  const out = beforeSendTransaction(tx, {});
  expect(JSON.stringify(out)).not.toContain(DIGITS);
  expect(out.transaction).toBe('/inbox/p-[redacted]');
  expect(out.spans).toHaveLength(1);
});

test('beforeBreadcrumb scrubs navigation, xhr and console crumbs and passes other objects through untouched', () => {
  const node = document.createElement('div');
  const crumb = { category: 'console', message: `opened ${KEY}`, data: { arguments: ['opened', KEY, node], logger: 'console' } };
  const out = beforeBreadcrumb(crumb, {});
  expect(out.message).toBe('opened p-[redacted]');
  expect(out.data.arguments[1]).toBe('p-[redacted]');
  expect(out.data.arguments[2]).toBe(node);
  expect(crumb.message).toBe(`opened ${KEY}`);
  expect(beforeBreadcrumb({ category: 'navigation', data: { from: `/inbox/${KEY}`, to: '/inbox' } }, {}).data.from)
    .toBe('/inbox/p-[redacted]');
  expect(beforeBreadcrumb({ category: 'xhr', data: { method: 'POST', url: `/api/admin/inbox/${KEY}/text` } }, {}).data.url)
    .toBe('/api/admin/inbox/p-[redacted]/text');
});

test('fail closed: a throwing getter or a cycle drops the item instead of sending it', () => {
  const trap = { request: { get url() { throw new Error('no'); } } };
  expect(beforeSend(trap, {})).toBeNull();
  const loop = { category: 'console', data: {} };
  loop.data.self = loop;
  expect(beforeBreadcrumb(loop, {})).toBeNull();
});

test('the three hooks, and index.js spreads them into Sentry.init', () => {
  expect(Object.keys(SENTRY_SCRUB_HOOKS).sort()).toEqual(['beforeBreadcrumb', 'beforeSend', 'beforeSendTransaction']);
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  expect(src).toMatch(/import \{ SENTRY_SCRUB_HOOKS \} from '\.\/utils\/sentryScrub';/);
  const start = src.indexOf('Sentry.init({');
  expect(start).toBeGreaterThan(-1);
  const init = src.slice(start, src.indexOf('\n    });', start));
  expect(init).toContain('...SENTRY_SCRUB_HOOKS,');
  // The spread is the last property, and no hook is written literally after
  // it: a later beforeSend, beforeSendTransaction or beforeBreadcrumb key
  // would replace the scrub's hook without a sound.
  const spread = '...SENTRY_SCRUB_HOOKS,';
  const after = init.slice(init.indexOf(spread) + spread.length)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  expect(after).not.toMatch(/\b(?:beforeSend|beforeSendTransaction|beforeBreadcrumb)\b/);
  expect(after.trim()).toBe('');
});

// By value (2026-11-16): this scrub named only the menu proof, so every other
// token page and token API call reached Sentry raw. Every UUID and every JWT
// is now redacted in any string; sentryScrub.tokenRoutes.test.js holds every
// token page, and these pin the value rules and the non-UUID path rules.
const UUID_A = 'abcdef12-3456-4789-8abc-def012345678';

test('a UUID is redacted by value in the API calls a token page makes, in either case', () => {
  expect(scrubText(`https://api.drbartender.com/api/proposals/t/${UUID_A}/sign`)).toBe('https://api.drbartender.com/api/proposals/t/[redacted]/sign');
  expect(scrubText(`/api/stripe/create-intent/${UUID_A}`)).toBe('/api/stripe/create-intent/[redacted-uuid]');
  expect(scrubText(`/api/stripe/create-intent-for-invoice/${UUID_A.toUpperCase()}`)).toBe('/api/stripe/create-intent-for-invoice/[redacted-uuid]');
  expect(scrubText(`/api/client-portal/proposals/${UUID_A}/change-requests`)).toBe('/api/client-portal/proposals/[redacted-uuid]/change-requests');
  expect(scrubText(`/api/invoices/client/${UUID_A}`)).toBe('/api/invoices/client/[redacted-uuid]');
  expect(scrubText(`/api/proposals/group/${UUID_A}?x=1`)).toBe('/api/proposals/group/[redacted-uuid]?x=1');
  expect(scrubText(`GET /x/${UUID_A} failed with 404`)).toBe('GET /x/[redacted-uuid] failed with 404');
});

test('a value that is not a UUID stays readable: a Sentry id, a row id', () => {
  const sentryId = 'abcdef0123456789abcdef0123456789';
  expect(scrubText(`/x?event=${sentryId}`)).toBe(`/x?event=${sentryId}`);
  expect(scrubText('/admin/proposals/42')).toBe('/admin/proposals/42');
});

test('a UUID glued to a letter, or behind the F of a percent-encoded slash, is still redacted', () => {
  expect(scrubText(`x${UUID_A}`)).toBe('x[redacted-uuid]');
  expect(scrubText(`/login?next=%2Fcompare%2F${UUID_A}`)).toBe('/login?next=%2Fcompare%2F[redacted-uuid]');
});

test('the non-UUID tokens are redacted by path, a query token by name, and a JWT by value', () => {
  expect(scrubText(`https://drbartender.com/reset-password/${'ab'.repeat(32)}`)).toBe('https://drbartender.com/reset-password/[redacted]');
  expect(scrubText('https://staff.drbartender.com/verify-email/Zm9vYmFyYmF6cXV4LXNlY3JldC10b2tlbg')).toBe('https://staff.drbartender.com/verify-email/[redacted]');
  expect(scrubText('/login?next=%2Freset-password%2Fabcdef&y=1')).toBe('/login?next=/reset-password/[redacted]&y=1');
  expect(scrubText('/unsubscribe?token=abc123&list=1')).toBe('/unsubscribe?token=[redacted]&list=1');
  expect(scrubText('/r?next=%3Ftoken%3Dabc123%26x%3D1')).toBe('/r?next=%3Ftoken%3D[redacted]%26x%3D1');
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzd2FwIjoiY292ZXIifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
  expect(scrubText(`/api/admin/cover-swaps/${jwt}`)).toBe('/api/admin/cover-swaps/[redacted]');
  expect(scrubText(`link ${jwt} here`)).toBe('link [redacted-jwt] here');
});

test('the scrub uses no lookbehind, which an older Safari cannot parse', () => {
  const src = fs.readFileSync(path.join(__dirname, 'sentryScrub.js'), 'utf8');
  expect(src).not.toMatch(/\(\?<[=!]/);
});

test('the JWT rule is linear on a crafted run of eyJ openings', () => {
  const crafted = `/x?q=${'eyJ'.repeat(20000)}`;
  const t0 = Date.now();
  beforeBreadcrumb({ category: 'console', message: crafted, data: { arguments: [crafted, crafted] } });
  expect(Date.now() - t0).toBeLessThan(1500);
});

test('the Stripe client secret on a paid return URL is redacted, with the page token', () => {
  const secret = `pi_3Abc${'D'.repeat(18)}_secret_${'e'.repeat(25)}`;
  const url = `https://drbartender.com/proposal/${UUID_A}?paid=true&payment_intent=pi_3Abc${'D'.repeat(18)}&payment_intent_client_secret=${secret}&redirect_status=succeeded`;
  const out = scrubText(url);
  expect(out).not.toContain(secret);
  expect(out).not.toContain(UUID_A);
  expect(out).toContain('payment_intent_client_secret=[redacted-client-secret]');
  const crumb = beforeBreadcrumb({ category: 'navigation', data: { from: url, to: '/' } });
  expect(JSON.stringify(crumb)).not.toContain('e'.repeat(25));
});

test('a UUID after a plus sign is redacted whole, not read as a phone number first', () => {
  const digitsFirst = `${'1234'}${'5678'}-3456-4789-8abc-def012345678`;
  expect(scrubText(`/x?q=see+${digitsFirst}`)).toBe('/x?q=see+[redacted-uuid]');
});

// The Claude connector (spec 2026-11-19 law 8): the consent page sends the
// browser to a return address carrying a single-use sign-in code and the
// state, and the navigation lands in a crumb. Made-up values throughout.
test('a connector token or code is redacted by its drbc_ prefix, wherever it sits', () => {
  const code = `drbc_ac_${'Zx9-'.repeat(8)}`;
  expect(scrubText(`code ${code} here`)).toBe('code [redacted-connector-token] here');
  expect(scrubText(`Bearer drbc_at_${'q'.repeat(40)}`)).toBe('Bearer [redacted-connector-token]');
  expect(scrubText(`refresh_token=drbc_rt_${'w'.repeat(40)}`)).not.toContain('w'.repeat(10));
});

test('the return address after Allow: the code and the state are gone from the URL and the navigation crumb', () => {
  const code = `drbc_ac_${'k'.repeat(43)}`;
  const state = `madeupstate${'S'.repeat(20)}`;
  const url = `https://claude.example.com/api/mcp/auth_callback?code=${code}&state=${state}`;
  const out = scrubText(url);
  expect(out).not.toContain('k'.repeat(10));
  expect(out).not.toContain(state);
  expect(out).toContain('code=[redacted-connector-token]');
  expect(out).toContain('&state=[redacted]');
  const crumb = beforeBreadcrumb({ category: 'navigation', data: { from: `/connect-claude?request=${UUID_A}`, to: url } });
  const text = JSON.stringify(crumb);
  expect(text).not.toContain('k'.repeat(10));
  expect(text).not.toContain(state);
  expect(text).not.toContain(UUID_A);
});

test('a cancel return keeps the error readable and drops the state', () => {
  const out = scrubText('https://claude.example.com/cb?error=access_denied&state=madeup-state-value');
  expect(out).toBe('https://claude.example.com/cb?error=access_denied&state=[redacted]');
});

test('code, state, code_challenge and code_verifier values are redacted by name, plain or percent-encoded, in a query or a bare form body', () => {
  expect(scrubText('/oauth/authorize?client_id=x&code_challenge=madeupchallenge123&state=abc')).toBe(
    '/oauth/authorize?client_id=x&code_challenge=[redacted]&state=[redacted]'
  );
  expect(scrubText('code=madeupcode&code_verifier=madeupverifier')).toBe('code=[redacted]&code_verifier=[redacted]');
  // A return address carried encoded in another URL: the value runs to the
  // encoded separator, and an encoded byte inside it does not end it early.
  const encoded = scrubText('/x?next=https%3A%2F%2Fc.example.com%2Fcb%3Fcode%3Dmadeup%2Bcode%26state%3Dmadeup%2Bstate%26z%3D1');
  expect(encoded).not.toContain('madeup');
  expect(encoded).toContain('%26z%3D1');
  // Not a parameter boundary: a name that only ends in "code" stays.
  expect(scrubText('/x?zip_code=60601&postcode=60601')).toBe('/x?zip_code=60601&postcode=60601');
});
