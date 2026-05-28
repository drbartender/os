require('dotenv').config();
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const {
  pickChannelsForUserAndCategory,
  CRITICAL_CATEGORIES,
  DEFAULT_CHANNELS,
} = require('./notificationChannelResolver');

// Test scaffolding: one test user, mutate its prefs columns per test.
let testUserId;

before(async () => {
  const passwordHash = await bcrypt.hash('test', 4);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, notifications_opt_in)
     VALUES ($1, $2, 'staff', 'approved', true) RETURNING id`,
    [`channel-resolver-test-${Date.now()}@example.com`, passwordHash]
  );
  testUserId = rows[0].id;
});

after(async () => {
  if (testUserId) {
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
  }
  await pool.end();
});

async function setPrefs(channelsObj, commsOverride = {}) {
  const prefs = {
    channels: channelsObj,
    push_subscriptions: [],
    quiet_hours: null,
  };
  await pool.query(
    `UPDATE users SET staff_notification_preferences = $1::jsonb,
                      communication_preferences = (
                        SELECT (COALESCE(communication_preferences, '{}'::jsonb)
                              || $2::jsonb)::jsonb
                      )
       WHERE id = $3`,
    [JSON.stringify(prefs), JSON.stringify(commsOverride), testUserId]
  );
}

async function setPushSubs(subs) {
  await pool.query(
    `UPDATE users
        SET staff_notification_preferences = jsonb_set(
              staff_notification_preferences, '{push_subscriptions}', $1::jsonb, true)
      WHERE id = $2`,
    [JSON.stringify(subs), testUserId]
  );
}

test('resolver > returns deduped opted-in channels', async () => {
  await setPrefs({ shift_offered: ['push', 'sms', 'email', 'sms'] });
  const out = await pickChannelsForUserAndCategory(testUserId, 'shift_offered');
  assert.deepEqual(out, { kind: 'channels', channels: ['push', 'sms', 'email'] });
});

test('resolver > sms_enabled=false filters SMS from every result', async () => {
  await setPrefs({ shift_offered: ['push', 'sms', 'email'] }, { sms_enabled: false });
  const out = await pickChannelsForUserAndCategory(testUserId, 'shift_offered');
  assert.deepEqual(out, { kind: 'channels', channels: ['push', 'email'] });
});

test('resolver > email_enabled=false filters email', async () => {
  await setPrefs({ shift_offered: ['sms', 'email'] }, { email_enabled: false, sms_enabled: true });
  const out = await pickChannelsForUserAndCategory(testUserId, 'shift_offered');
  assert.deepEqual(out, { kind: 'channels', channels: ['sms'] });
});

test('resolver > missing category key falls back to DEFAULT_CHANNELS', async () => {
  // shift_offered key is omitted; resolver should use DEFAULT_CHANNELS.shift_offered
  await setPrefs({ payday: ['email'] }, { sms_enabled: true, email_enabled: true });
  const out = await pickChannelsForUserAndCategory(testUserId, 'shift_offered');
  assert.deepEqual(out.channels.sort(), DEFAULT_CHANNELS.shift_offered.slice().sort());
});

test('resolver > critical-path override prefers SMS when all channels muted', async () => {
  await setPrefs({ beo_finalized: [] }, { sms_enabled: true, email_enabled: true });
  const out = await pickChannelsForUserAndCategory(testUserId, 'beo_finalized');
  assert.deepEqual(out, { kind: 'channels', channels: ['sms'] });
});

test('resolver > critical-path override degrades to email when SMS globally off', async () => {
  await setPrefs({ beo_finalized: [] }, { sms_enabled: false, email_enabled: true });
  const out = await pickChannelsForUserAndCategory(testUserId, 'beo_finalized');
  assert.deepEqual(out, { kind: 'channels', channels: ['email'] });
});

test('resolver > critical-path override degrades to push when SMS+email both off AND push subs exist', async () => {
  await setPrefs({ beo_finalized: [] }, { sms_enabled: false, email_enabled: false });
  await setPushSubs([{ endpoint: 'https://example.test/sub', keys: { p256dh: 'x', auth: 'y' }, subscribed_at: new Date().toISOString() }]);
  const out = await pickChannelsForUserAndCategory(testUserId, 'beo_finalized');
  assert.deepEqual(out, { kind: 'channels', channels: ['push'] });
});

test('resolver > critical-path override returns dead_letter when SMS+email+push all blocked', async () => {
  await setPrefs({ beo_finalized: [] }, { sms_enabled: false, email_enabled: false });
  await setPushSubs([]);
  const out = await pickChannelsForUserAndCategory(testUserId, 'beo_finalized');
  assert.deepEqual(out, { kind: 'dead_letter', reason: 'all_channels_blocked' });
});

test('resolver > non-critical category with all channels muted returns empty channels (NOT dead_letter)', async () => {
  await setPrefs({ tip_received: [] }, { sms_enabled: true, email_enabled: true });
  const out = await pickChannelsForUserAndCategory(testUserId, 'tip_received');
  assert.deepEqual(out, { kind: 'channels', channels: [] });
});

test('resolver > unknown user returns empty channels', async () => {
  const out = await pickChannelsForUserAndCategory(-99999, 'shift_offered');
  assert.deepEqual(out, { kind: 'channels', channels: [] });
});

test('resolver > CRITICAL_CATEGORIES is exactly beo_finalized + schedule_change + payday', () => {
  assert.deepEqual(
    Array.from(CRITICAL_CATEGORIES).sort(),
    ['beo_finalized', 'payday', 'schedule_change']
  );
});
