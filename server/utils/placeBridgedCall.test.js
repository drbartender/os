require('dotenv').config();
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { placeBridgedCall, __setSmsDeps } = require('./sms');
const { notificationsEnabled } = require('./notificationsEnabled');

// After every test restore the deps to a safe, production-shaped state.
// In dev/test env the real module-level Twilio client is null (no creds), so
// restoring client:null matches reality; notificationsEnabled is the real import.
afterEach(() => {
  __setSmsDeps({ client: null, notificationsEnabled });
});

test('placeBridgedCall > returns a dev-skipped sid and does NOT call Twilio when notifications are gated off', async () => {
  let created = false;
  __setSmsDeps({
    client: { calls: { create: async () => { created = true; throw new Error('must not dial'); } } },
    notificationsEnabled: () => false,
  });

  const result = await placeBridgedCall({
    to: '+639171234567',
    callerId: '+12242220082',
    url: 'https://example.test/api/voice/bridge',
    statusCallback: 'https://example.test/api/voice/status',
    timeLimit: 1800,
  });

  assert.strictEqual(created, false, 'Twilio calls.create must not be reached when gated off');
  assert.match(result.sid, /^dev-skipped-/);
});

test('placeBridgedCall > returns a dev-skipped sid when the Twilio client is absent', async () => {
  __setSmsDeps({ client: null, notificationsEnabled: () => true });

  const result = await placeBridgedCall({
    to: '+639171234567',
    callerId: '+12242220082',
    url: 'https://example.test/api/voice/bridge',
    statusCallback: 'https://example.test/api/voice/status',
    timeLimit: 1800,
  });

  assert.match(result.sid, /^dev-skipped-/);
});

test('placeBridgedCall > with a stubbed client and notifications on, passes through the right params and returns the sid', async () => {
  let captured = null;
  __setSmsDeps({
    client: { calls: { create: async (opts) => { captured = opts; return { sid: 'CA_test_123' }; } } },
    notificationsEnabled: () => true,
  });

  const result = await placeBridgedCall({
    to: '+639171234567',
    callerId: '+12242220082',
    url: 'https://example.test/api/voice/bridge',
    statusCallback: 'https://example.test/api/voice/status',
    timeLimit: 1800,
  });

  assert.strictEqual(result.sid, 'CA_test_123');
  assert.deepStrictEqual(captured, {
    from: '+12242220082',           // callerId → Twilio `from` (the 224 shown to Zul)
    to: '+639171234567',            // VA_CELL, passed straight through (never normalized)
    url: 'https://example.test/api/voice/bridge',
    statusCallback: 'https://example.test/api/voice/status',
    timeLimit: 1800,
  });
});

test('placeBridgedCall > optional timeout reaches calls.create; omitted timeout stays omitted', async () => {
  let captured = null;
  __setSmsDeps({
    client: { calls: { create: async (opts) => { captured = opts; return { sid: 'CA_test_456' }; } } },
    notificationsEnabled: () => true,
  });

  await placeBridgedCall({
    to: '+15551234567',
    callerId: '+18885550000',
    url: 'https://example.test/api/voice/lead/answer',
    statusCallback: 'https://example.test/api/voice/lead/status',
    timeLimit: 1800,
    timeout: 25,
  });
  assert.strictEqual(captured.timeout, 25);

  await placeBridgedCall({
    to: '+15551234567',
    callerId: '+18885550000',
    url: 'u',
    statusCallback: 's',
    timeLimit: 1800,
  });
  assert.strictEqual('timeout' in captured, false, 'omitted timeout must not appear in calls.create opts');
});

test('placeBridgedCall > throws when `to` is missing (mirrors sendSMS)', async () => {
  await assert.rejects(
    () => placeBridgedCall({ callerId: '+12242220082', url: 'u', statusCallback: 's', timeLimit: 1800 }),
    /required/
  );
});
