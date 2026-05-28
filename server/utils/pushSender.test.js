require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sendPush } = require('./pushSender');

const STUB_SUBSCRIPTION = {
  endpoint: 'https://example.test/sub',
  keys: { p256dh: 'x', auth: 'y' },
};

test('pushSender > returns vapid_unset when VAPID_PRIVATE_KEY is empty', async () => {
  const original = process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  try {
    const result = await sendPush({
      subscription: STUB_SUBSCRIPTION,
      title: 'Test',
      body: 'body',
      url: '/',
    });
    assert.deepEqual(result, { ok: false, error: 'vapid_unset' });
  } finally {
    if (original !== undefined) process.env.VAPID_PRIVATE_KEY = original;
  }
});

test('pushSender > stub returns push_phase_b when VAPID is set', async () => {
  const original = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PRIVATE_KEY = 'stub-private-key-for-test';
  try {
    const result = await sendPush({
      subscription: STUB_SUBSCRIPTION,
      title: 'Test',
      body: 'body',
      url: '/',
    });
    assert.deepEqual(result, { ok: false, error: 'push_phase_b' });
  } finally {
    if (original === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = original;
  }
});
