require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const webpush = require('web-push');

// Ensure VAPID is configured so the real-send path is exercised even when the
// environment has no keys (e.g. CI). Generated keys are valid for the
// setVapidDetails() that pushSender runs at require-time below.
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  const k = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || k.publicKey;
  process.env.VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || k.privateKey;
}

const { sendPush } = require('./pushSender');

const SUBSCRIPTION = {
  endpoint: 'https://example.test/sub',
  keys: { p256dh: 'x', auth: 'y' },
};
const MSG = {
  subscription: SUBSCRIPTION,
  title: 'BEO ready',
  body: 'Confirm your Saturday shift',
  url: '/shifts/42',
  tag: 'beo_finalized',
  icon: undefined,
};

test('pushSender > returns vapid_unset when VAPID_PRIVATE_KEY is unset', async () => {
  const original = process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  try {
    const result = await sendPush(MSG);
    assert.deepEqual(result, { ok: false, error: 'vapid_unset' });
  } finally {
    if (original !== undefined) process.env.VAPID_PRIVATE_KEY = original;
  }
});

test('pushSender > ok:true on success, and sends the JSON payload the SW expects', async (t) => {
  const sendMock = t.mock.method(webpush, 'sendNotification', async () => ({ statusCode: 201 }));
  const result = await sendPush(MSG);
  assert.deepEqual(result, { ok: true });
  assert.equal(sendMock.mock.calls.length, 1);
  const [subArg, payloadArg] = sendMock.mock.calls[0].arguments;
  assert.deepEqual(subArg, SUBSCRIPTION);
  // icon is undefined → JSON.stringify drops it; the SW reads title/body/url/tag.
  assert.deepEqual(JSON.parse(payloadArg), {
    title: 'BEO ready',
    body: 'Confirm your Saturday shift',
    url: '/shifts/42',
    tag: 'beo_finalized',
  });
});

test('pushSender > maps 410 Gone to { ok:false, gone:true } (dispatcher prunes)', async (t) => {
  t.mock.method(webpush, 'sendNotification', async () => {
    const e = new Error('Gone');
    e.statusCode = 410;
    throw e;
  });
  const result = await sendPush(MSG);
  assert.deepEqual(result, { ok: false, gone: true });
});

test('pushSender > maps 404 Not Found to { ok:false, gone:true }', async (t) => {
  t.mock.method(webpush, 'sendNotification', async () => {
    const e = new Error('Not Found');
    e.statusCode = 404;
    throw e;
  });
  const result = await sendPush(MSG);
  assert.deepEqual(result, { ok: false, gone: true });
});

test('pushSender > maps other errors to { ok:false, error } and keeps the sub', async (t) => {
  t.mock.method(webpush, 'sendNotification', async () => {
    const e = new Error('boom');
    e.statusCode = 500;
    throw e;
  });
  const result = await sendPush(MSG);
  assert.deepEqual(result, { ok: false, error: 'boom' });
});
