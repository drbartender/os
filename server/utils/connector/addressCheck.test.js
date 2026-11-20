'use strict';

// The connector's address check (spec 2026-11-19 section 7.5): the range, its
// default, the explicit-empty off switch, production-only enforcement, IPv4
// mapped into IPv6, and a malformed range failing closed. Pure: no database.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_RANGES, addressCheckEnforced, isAllowedAddress, addressAllowed,
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

test('enforced only in production, and an explicitly empty range switches it off', () => {
  const req = { ip: '127.0.0.1' };
  delete process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS;
  process.env.NODE_ENV = 'development';
  assert.equal(addressCheckEnforced(), false);
  assert.equal(addressAllowed(req), true, 'not enforced outside production');
  process.env.NODE_ENV = 'production';
  assert.equal(addressCheckEnforced(), true);
  assert.equal(addressAllowed(req), false, 'outside the default range in production');
  assert.equal(addressAllowed({ ip: '160.79.104.20' }), true);
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
