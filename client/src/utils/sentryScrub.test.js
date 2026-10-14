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
