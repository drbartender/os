const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldSendImmediate, suppressionMessage } = require('./messageSuppression');

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

// ── suppressionMessage: the admin-facing copy layer ──────────────────────────
// The whole point of this helper is that a raw enum token can never reach an
// admin toast again, so every case asserts the absence of the tokens as well as
// the presence of the copy.
// 'archived' is deliberately absent: it is a real English word the copy uses on
// purpose. The length + sentence checks below are what catch a bare token there.
const RAW_TOKENS = /channel_disabled|bad_contact|undefined/;

test('suppressionMessage > every reason shouldSendImmediate can return has copy', () => {
  for (const reason of ['archived', 'channel_disabled', 'bad_contact']) {
    for (const channel of ['email', 'sms', undefined]) {
      const msg = suppressionMessage(reason, channel);
      assert.equal(typeof msg, 'string');
      assert.ok(msg.length > 20, `${reason}/${channel} copy is too short to be a sentence`);
      assert.ok(/\.$/.test(msg), `${reason}/${channel} copy should end in a period`);
      assert.doesNotMatch(msg, RAW_TOKENS, `${reason}/${channel} leaked a raw token`);
      // Copy law: no em dashes in user-facing copy.
      assert.doesNotMatch(msg, /—/, `${reason}/${channel} contains an em dash`);
    }
  }
});

test('suppressionMessage > channel sharpens the wording', () => {
  assert.match(suppressionMessage('channel_disabled', 'sms'), /text messages/i);
  assert.match(suppressionMessage('channel_disabled', 'email'), /email is switched off/i);
  assert.match(suppressionMessage('bad_contact', 'sms'), /phone number/i);
  assert.match(suppressionMessage('bad_contact', 'email'), /email address/i);
  assert.match(suppressionMessage('archived'), /archived/i);
});

test('suppressionMessage > unknown or missing reason falls back, never prints the token', () => {
  for (const bad of ['who_knows', '', null, undefined, 'toString']) {
    const msg = suppressionMessage(bad, 'email');
    assert.equal(typeof msg, 'string');
    assert.ok(msg.length > 20);
    assert.doesNotMatch(msg, /who_knows|undefined|null|function/i);
  }
});
