'use strict';

// The connector's address check (spec 2026-11-19 section 7.5): the range, its
// default, the explicit-empty off switch, production-only enforcement, IPv4
// mapped into IPv6, a malformed range failing closed, and the caller read from
// the Cloudflare edge's CF-Connecting-IP rather than req.ip. Pure: no database.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_RANGES, addressCheckEnforced, isAllowedAddress, addressAllowed, callerAddress, addressBucket, callerBucket,
  addressCheckState, reportUnreadableRangeOnce, __resetBootReport,
} = require('./addressCheck');

const saved = { NODE_ENV: process.env.NODE_ENV, CIDRS: process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS };
afterEach(() => {
  if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.NODE_ENV;
  if (saved.CIDRS === undefined) delete process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS;
  else process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS = saved.CIDRS;
});

test('the default is Anthropic\'s published range, inclusive of both ends', () => {
  assert.equal(DEFAULT_RANGES, '160.79.104.0/21');
  assert.equal(isAllowedAddress('160.79.104.0'), true);
  assert.equal(isAllowedAddress('160.79.111.255'), true);
  assert.equal(isAllowedAddress('160.79.112.0'), false);
  assert.equal(isAllowedAddress('160.79.103.255'), false);
  assert.equal(isAllowedAddress('127.0.0.1'), false);
});

test('an IPv4 address mapped into IPv6 is checked as itself; junk is refused', () => {
  assert.equal(isAllowedAddress('::ffff:160.79.105.9'), true);
  assert.equal(isAllowedAddress('::ffff:10.0.0.1'), false);
  assert.equal(isAllowedAddress(''), false);
  assert.equal(isAllowedAddress(undefined), false);
  assert.equal(isAllowedAddress('not-an-ip'), false);
});

test('a list of ranges, IPv6 included, and a malformed range fails closed', () => {
  assert.equal(isAllowedAddress('10.1.2.3', '160.79.104.0/21, 10.0.0.0/8'), true);
  assert.equal(isAllowedAddress('2001:db8::5', '2001:db8::/32'), true);
  assert.equal(isAllowedAddress('160.79.104.1', '160.79.104.0/21,garbage'), false, 'one bad entry refuses all');
  assert.equal(isAllowedAddress('160.79.104.1', '160.79.104.0/40'), false);
});

// A request as it reaches the OS in production: req.ip is the Cloudflare edge,
// the caller is in CF-Connecting-IP (measured on prod 2026-11-24).
const viaEdge = (caller, edge = '172.71.146.134') => ({ ip: edge, headers: { 'cf-connecting-ip': caller } });

test('enforced only in production, and an explicitly empty range switches it off', () => {
  const req = viaEdge('127.0.0.1');
  delete process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS;
  process.env.NODE_ENV = 'development';
  assert.equal(addressCheckEnforced(), false);
  assert.equal(addressAllowed(req), true, 'not enforced outside production');
  process.env.NODE_ENV = 'production';
  assert.equal(addressCheckEnforced(), true);
  assert.equal(addressAllowed(req), false, 'outside the default range in production');
  assert.equal(addressAllowed(viaEdge('160.79.104.20')), true);
  process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS = '';
  assert.equal(addressCheckEnforced(), false, 'the owner\'s off switch');
  assert.equal(addressAllowed(req), true);
  process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS = '127.0.0.0/8';
  assert.equal(addressAllowed(req), true);
});

test('the state the settings block shows: on, off when empty or outside production, unreadable', () => {
  delete process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS;
  process.env.NODE_ENV = 'production';
  assert.equal(addressCheckState(), 'on');
  process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS = '';
  assert.equal(addressCheckState(), 'off');
  process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS = '160.79.104.0/21 10.0.0.0/8';
  assert.equal(addressCheckState(), 'unreadable', 'a space-separated list does not parse');
  assert.equal(addressAllowed({ ip: '160.79.104.9' }), false, 'and still fails closed');
  process.env.NODE_ENV = 'development';
  assert.equal(addressCheckState(), 'unreadable', 'unreadable is shown even where it is not enforced');
  delete process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS;
  assert.equal(addressCheckState(), 'off');
});

test('an unreadable range is reported to Sentry once at boot, a readable one never', () => {
  __resetBootReport();
  const sent = [];
  const capture = (msg, ctx) => sent.push({ msg, ctx });
  delete process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS;
  assert.equal(reportUnreadableRangeOnce(capture), false);
  process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS = 'garbage';
  assert.equal(reportUnreadableRangeOnce(capture), true);
  assert.equal(reportUnreadableRangeOnce(capture), false, 'once');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].ctx.level, 'error');
  assert.doesNotMatch(sent[0].msg, /garbage/, 'the value itself is not sent');
  __resetBootReport();
});

test('production reads the caller from CF-Connecting-IP: Anthropic behind an edge passes, the edge itself never does', () => {
  delete process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS;
  process.env.NODE_ENV = 'production';
  assert.equal(addressAllowed(viaEdge('160.79.104.20')), true, 'Anthropic\'s caller behind a Cloudflare edge');
  assert.equal(addressAllowed(viaEdge('203.0.113.9')), false, 'a caller outside the range behind the same edge');
  assert.equal(addressAllowed({ ip: '160.79.104.20' }), false,
    'no CF-Connecting-IP in production: refused even when req.ip falls in the range');
  assert.equal(addressAllowed({ ip: '160.79.104.20', headers: { 'cf-connecting-ip': 'not-an-ip' } }), false);
  assert.equal(addressAllowed({ ip: '160.79.104.20', headers: { 'cf-connecting-ip': ['160.79.104.20'] } }), false,
    'only a single string header is read');
  assert.equal(addressAllowed(viaEdge('::ffff:160.79.104.20')), true, 'IPv4 mapped into IPv6');
});

test('callerAddress: the edge\'s caller, else req.ip, else null', () => {
  assert.equal(callerAddress(viaEdge('160.79.104.20')), '160.79.104.20');
  assert.equal(callerAddress(viaEdge(' 160.79.104.20 ')), '160.79.104.20', 'trimmed');
  assert.equal(callerAddress(viaEdge('::ffff:24.0.0.1')), '24.0.0.1');
  assert.equal(callerAddress({ ip: '127.0.0.1', headers: {} }), '127.0.0.1', 'a dev server or a test: req.ip');
  assert.equal(callerAddress({ ip: '127.0.0.1', headers: { 'cf-connecting-ip': 'junk' } }), '127.0.0.1');
  assert.equal(callerAddress({}), null);
});

test('addressBucket: IPv4 as itself, IPv6 by its /64 in every spelling', () => {
  assert.equal(addressBucket('160.79.104.20'), '160.79.104.20');
  assert.equal(addressBucket('::ffff:160.79.104.20'), '::ffff:160.79.104.20', 'mapped IPv4 is not grouped');
  assert.equal(addressBucket('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(addressBucket('2001:0DB8:0001:0002:ffff:eeee:dddd:cccc'), '2001:db8:1:2::/64', 'case and leading zeros');
  assert.equal(addressBucket('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(addressBucket('::1'), '0:0:0:0::/64');
  assert.equal(addressBucket('2001:db8:1:2::'), '2001:db8:1:2::/64');
  assert.equal(addressBucket('2001:db8:1:2:3:4:1.2.3.4'), '2001:db8:1:2::/64', 'dotted tail');
  assert.equal(addressBucket('fe80::1%eth0'), 'fe80:0:0:0::/64', 'zone id dropped');
  assert.equal(addressBucket('junk'), 'junk');
  assert.equal(addressBucket(null), null);
  assert.equal(callerBucket(viaEdge('2001:db8:1:2:aaaa::9')), '2001:db8:1:2::/64');
  assert.equal(callerBucket(viaEdge('160.79.104.20')), '160.79.104.20');
});
