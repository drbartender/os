const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveChannelFallback } = require('./channelFallback');

const okClient = {
  phone: '5125551234',
  communication_preferences: { sms_enabled: true, marketing_enabled: true },
  email_status: 'ok',
  phone_status: 'ok',
};

test('resolveChannelFallback > proceeds when the primary channel is fine', () => {
  const r = resolveChannelFallback({ channel: 'email', client: okClient, category: 'operational' });
  assert.deepStrictEqual(r, { action: 'proceed', channel: 'email' });
});

test('resolveChannelFallback > substitutes email to sms when email is bad', () => {
  const client = { ...okClient, email_status: 'bad' };
  const r = resolveChannelFallback({ channel: 'email', client, category: 'operational' });
  assert.deepStrictEqual(r, { action: 'substitute', channel: 'sms' });
});

test('resolveChannelFallback > substitutes sms to email when sms is opted out', () => {
  const client = {
    ...okClient,
    communication_preferences: { sms_enabled: false, marketing_enabled: true },
  };
  const r = resolveChannelFallback({ channel: 'sms', client, category: 'operational' });
  assert.deepStrictEqual(r, { action: 'substitute', channel: 'email' });
});

test('resolveChannelFallback > suppresses when both channels are bad', () => {
  const client = { ...okClient, email_status: 'bad', phone_status: 'bad' };
  const r = resolveChannelFallback({ channel: 'email', client, category: 'operational' });
  assert.strictEqual(r.action, 'suppress');
});

test('resolveChannelFallback > does not substitute a marketing touch when marketing is off', () => {
  const client = {
    ...okClient,
    email_status: 'bad',
    communication_preferences: { sms_enabled: true, marketing_enabled: false },
  };
  const r = resolveChannelFallback({ channel: 'email', client, category: 'marketing' });
  assert.strictEqual(r.action, 'suppress');
});

test('resolveChannelFallback > substitutes a marketing touch when marketing is on but the primary channel is unusable', () => {
  // Was written against email_enabled=false, which was dropped 2026-08-14. The
  // behavior under test is the marketing branch, not the reason email is dead:
  // marketing_enabled=true means an unusable primary still falls back.
  const client = { ...okClient, email_status: 'bad' };
  const r = resolveChannelFallback({ channel: 'email', client, category: 'marketing' });
  assert.deepStrictEqual(r, { action: 'substitute', channel: 'sms' });
});

test('resolveChannelFallback > an orphaned email_enabled=false does not make email unusable', () => {
  const client = {
    ...okClient,
    communication_preferences: { email_enabled: false, sms_enabled: true, marketing_enabled: true },
  };
  const r = resolveChannelFallback({ channel: 'email', client, category: 'operational' });
  assert.deepStrictEqual(r, { action: 'proceed', channel: 'email' });
});

test('resolveChannelFallback > suppresses sms substitution when client has no phone number', () => {
  const client = { ...okClient, email_status: 'bad', phone: '' };
  const r = resolveChannelFallback({ channel: 'email', client, category: 'operational' });
  assert.strictEqual(r.action, 'suppress');
});
