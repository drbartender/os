'use strict';

// The connector's grant rules that need no database (spec 2026-11-19 section
// 7.2): the lifetimes with an injected clock (30 days unused, 180 days from
// approval), the RFC 8707 resource comparison, and the fixed client. The
// grant's writes are exercised through the routes (server/routes/
// connector.flow.test.js and server/routes/admin/connector.test.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const grants = require('./grants');

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-11-01T12:00:00Z');
const grant = (over = {}) => ({
  revoked_at: null,
  activated_at: T0,
  role: 'admin',
  token_version: 3,
  user_token_version: 3,
  created_at: T0,
  last_used_at: T0,
  expires_at: new Date(T0.getTime() + grants.GRANT_MAX_MS),
  ...over,
});

test('a grant idle 30 days is dead, idle 29 days is live', () => {
  assert.equal(grants.grantIsLive(grant(), new Date(T0.getTime() + 29 * DAY)), true);
  assert.equal(grants.grantIsLive(grant(), new Date(T0.getTime() + 30 * DAY)), false);
  assert.equal(grants.grantState(grant(), new Date(T0.getTime() + 31 * DAY)), 'lapsed');
});

test('a grant 180 days old is dead even when used yesterday', () => {
  const now = new Date(T0.getTime() + 180 * DAY);
  const g = grant({ last_used_at: new Date(now.getTime() - DAY) });
  assert.equal(grants.grantIsLive(g, now), false);
  assert.equal(grants.grantState(g, now), 'expired');
  assert.equal(grants.grantIsLive(g, new Date(now.getTime() - 2 * DAY)), true, 'live the day before');
  // The age rule holds even if a row's expires_at were pushed out by hand.
  const pushed = grant({ last_used_at: new Date(now.getTime() - DAY), expires_at: new Date(T0.getTime() + 400 * DAY) });
  assert.equal(grants.grantIsLive(pushed, now), false);
});

test('a revoked grant is dead at once', () => {
  assert.equal(grants.grantIsLive(grant({ revoked_at: T0 }), T0), false);
  assert.equal(grants.grantState(grant({ revoked_at: T0 }), T0), 'revoked');
});

test('the resource comparison: scheme and host by case, a trailing slash ignored, a fragment or another path refused', () => {
  assert.equal(grants.sameResource('https://api.example.com/mcp', 'https://api.example.com/mcp'), true);
  assert.equal(grants.sameResource('HTTPS://API.EXAMPLE.COM/mcp', 'https://api.example.com/mcp'), true);
  assert.equal(grants.sameResource('https://api.example.com/mcp/', 'https://api.example.com/mcp'), true);
  assert.equal(grants.sameResource('https://api.example.com/mcp#x', 'https://api.example.com/mcp'), false);
  assert.equal(grants.sameResource('https://api.example.com/other', 'https://api.example.com/mcp'), false);
  assert.equal(grants.sameResource('https://evil.example.org/mcp', 'https://api.example.com/mcp'), false);
  assert.equal(grants.sameResource('not a url', 'https://api.example.com/mcp'), false);
});

test('the public URLs follow API_URL, and the client is fixed', () => {
  const prev = process.env.API_URL;
  process.env.API_URL = 'https://api.example.com/';
  try {
    assert.equal(grants.issuer(), 'https://api.example.com');
    assert.equal(grants.publicMcpUrl(), 'https://api.example.com/mcp');
    assert.equal(grants.resourceMetadataUrl(), 'https://api.example.com/.well-known/oauth-protected-resource/mcp');
  } finally {
    if (prev === undefined) delete process.env.API_URL; else process.env.API_URL = prev;
  }
  assert.equal(grants.REDIRECT_URI, 'https://claude.ai/api/mcp/auth_callback');
  assert.match(grants.consentUrl('abcdef12-3456-4789-8abc-def012345678'), /\/connect-claude\?request=abcdef12-3456-4789-8abc-def012345678$/);
  assert.equal(grants.isRequestId('abcdef12-3456-4789-8abc-def012345678'), true);
  assert.equal(grants.isRequestId('../etc'), false);
});

test('the one rule: pending, signed out and no longer admin are not live', () => {
  const now = new Date(T0.getTime() + DAY);
  assert.equal(grants.grantState(grant(), now), 'live');
  assert.equal(grants.grantState(grant({ activated_at: null }), now), 'pending', 'approved, code not exchanged');
  assert.equal(grants.grantState(grant({ activated_at: null }), now, { allowPending: true }), 'live', 'the exchange may make it live');
  assert.equal(grants.grantState(grant({ user_token_version: 4 }), now), 'signed_out', 'a password reset or passkey revoke');
  assert.equal(grants.grantState(grant({ role: 'manager' }), now), 'no_longer_admin');
  assert.equal(grants.grantState(grant({ user_token_version: 4, revoked_at: now }), now), 'revoked', 'revocation first');
});
