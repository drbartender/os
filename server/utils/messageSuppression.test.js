const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldSendImmediate } = require('./messageSuppression');

const okProposal = { id: 1, status: 'deposit_paid' };
const okClient = {
  id: 99,
  email: 'ok@example.com',
  phone: '+15551234567',
  communication_preferences: { email_enabled: true, sms_enabled: true, marketing_enabled: true },
  email_status: 'ok',
  phone_status: 'ok',
};

test('shouldSendImmediate > returns ok when everything is fine (email)', async () => {
  const result = await shouldSendImmediate({ proposal: okProposal, client: okClient, channel: 'email' });
  assert.deepStrictEqual(result, { ok: true });
});

test('shouldSendImmediate > returns ok when everything is fine (sms)', async () => {
  const result = await shouldSendImmediate({ proposal: okProposal, client: okClient, channel: 'sms' });
  assert.deepStrictEqual(result, { ok: true });
});

test('shouldSendImmediate > archived proposal blocks everything', async () => {
  const result = await shouldSendImmediate({
    proposal: { ...okProposal, status: 'archived' },
    client: okClient,
    channel: 'email',
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'archived' });
});

test('shouldSendImmediate > email_enabled=false blocks email', async () => {
  const result = await shouldSendImmediate({
    proposal: okProposal,
    client: { ...okClient, communication_preferences: { ...okClient.communication_preferences, email_enabled: false } },
    channel: 'email',
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'channel_disabled' });
});

test('shouldSendImmediate > email_enabled=false does NOT block sms', async () => {
  const result = await shouldSendImmediate({
    proposal: okProposal,
    client: { ...okClient, communication_preferences: { ...okClient.communication_preferences, email_enabled: false } },
    channel: 'sms',
  });
  assert.deepStrictEqual(result, { ok: true });
});

test('shouldSendImmediate > sms_enabled=false blocks sms', async () => {
  const result = await shouldSendImmediate({
    proposal: okProposal,
    client: { ...okClient, communication_preferences: { ...okClient.communication_preferences, sms_enabled: false } },
    channel: 'sms',
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'channel_disabled' });
});

test('shouldSendImmediate > email_status=bad blocks email', async () => {
  const result = await shouldSendImmediate({
    proposal: okProposal,
    client: { ...okClient, email_status: 'bad' },
    channel: 'email',
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'bad_contact' });
});

test('shouldSendImmediate > phone_status=bad blocks sms', async () => {
  const result = await shouldSendImmediate({
    proposal: okProposal,
    client: { ...okClient, phone_status: 'bad' },
    channel: 'sms',
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'bad_contact' });
});

test('shouldSendImmediate > null client.communication_preferences treated as all-enabled', async () => {
  // Defensive default — if prefs JSON is null (legacy clients pre-Plan 1
  // migration), assume opt-in. Plan 1 backfilled defaults but the check
  // stays for safety.
  const result = await shouldSendImmediate({
    proposal: okProposal,
    client: { ...okClient, communication_preferences: null },
    channel: 'email',
  });
  assert.deepStrictEqual(result, { ok: true });
});

test('shouldSendImmediate > missing client returns ok:false with bad_contact', async () => {
  const result = await shouldSendImmediate({
    proposal: okProposal,
    client: null,
    channel: 'email',
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'bad_contact' });
});

test('shouldSendImmediate > unknown channel throws', async () => {
  await assert.rejects(
    () => shouldSendImmediate({ proposal: okProposal, client: okClient, channel: 'fax' }),
    /channel/i
  );
});
