require('dotenv').config();
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  verifyTelegramSecret,
  sendTelegramMessage,
  sendTelegramAudio,
  setTelegramWebhook,
  isNewUpdate,
  __setTelegramDeps,
} = require('./telegram');

// telegram.js requires ../db at load, which constructs a pg Pool (no connection
// until a query runs). We inject a stub pool below so the real pool is never
// queried; end it in teardown so the process exits cleanly.
const { pool } = require('../db');
after(async () => { await pool.end(); });

// Snapshot the env keys these tests mutate so a real .env can't leak in.
const ENV_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'SEND_NOTIFICATIONS', 'NODE_ENV', 'API_URL', 'RENDER_EXTERNAL_URL'];
let saved;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

// A minimal Express-like req exposing .header() (the only method we call).
function fakeReq(headerValue) {
  return { header: (name) => (name.toLowerCase() === 'x-telegram-bot-api-secret-token' ? headerValue : undefined) };
}

test('verifyTelegramSecret > true when header matches the configured secret', () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = 's3cr3t-abc-XYZ';
  try {
    assert.strictEqual(verifyTelegramSecret(fakeReq('s3cr3t-abc-XYZ')), true);
  } finally { restoreEnv(); }
});

test('verifyTelegramSecret > false when header mismatches', () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = 's3cr3t-abc-XYZ';
  try {
    assert.strictEqual(verifyTelegramSecret(fakeReq('wrong')), false);
    // Different length must also be false (and must not throw).
    assert.strictEqual(verifyTelegramSecret(fakeReq('s3cr3t-abc-XYZ-longer')), false);
  } finally { restoreEnv(); }
});

test('verifyTelegramSecret > false when secret unset or header missing', () => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  try {
    assert.strictEqual(verifyTelegramSecret(fakeReq('anything')), false);
  } finally { restoreEnv(); }
  process.env.TELEGRAM_WEBHOOK_SECRET = 's3cr3t-abc-XYZ';
  try {
    assert.strictEqual(verifyTelegramSecret(fakeReq(undefined)), false);
    assert.strictEqual(verifyTelegramSecret(fakeReq('')), false);
  } finally { restoreEnv(); }
});

test('sendTelegramMessage > skips (no fetch) when gated off', async () => {
  // Gate OFF: token unset AND notifications gated (non-prod, no SEND_NOTIFICATIONS).
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.SEND_NOTIFICATIONS;
  process.env.NODE_ENV = 'test';
  let called = 0;
  __setTelegramDeps({ fetch: async () => { called += 1; return { json: async () => ({ ok: true }) }; } });
  try {
    const res = await sendTelegramMessage(123456789, 'hello');
    assert.deepStrictEqual(res, { ok: false, skipped: true });
    assert.strictEqual(called, 0, 'fetch must not be called when gated off');
  } finally {
    __setTelegramDeps({ fetch: (...a) => globalThis.fetch(...a) });
    restoreEnv();
  }
});

test('sendTelegramMessage > skips (no fetch) when token IS set but notifications gated off', async () => {
  // The dev-safety gate must also hold with a real token present: force
  // notificationsEnabled() false via the injected dep and assert no send.
  process.env.TELEGRAM_BOT_TOKEN = 'BOTTOK123';
  process.env.SEND_NOTIFICATIONS = 'true'; // env says on; the dep override forces off
  let called = 0;
  __setTelegramDeps({
    fetch: async () => { called += 1; return { json: async () => ({ ok: true }) }; },
    notificationsEnabled: () => false,
  });
  try {
    const res = await sendTelegramMessage(123456789, 'hello');
    assert.deepStrictEqual(res, { ok: false, skipped: true });
    assert.strictEqual(called, 0, 'fetch must not be called when notifications gated off');
  } finally {
    __setTelegramDeps({
      fetch: (...a) => globalThis.fetch(...a),
      notificationsEnabled: require('./notificationsEnabled').notificationsEnabled,
    });
    restoreEnv();
  }
});

test('sendTelegramMessage > POSTs to sendMessage when ungated', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'BOTTOK123';
  process.env.SEND_NOTIFICATIONS = 'true';
  let captured = null;
  __setTelegramDeps({
    fetch: async (url, opts) => {
      captured = { url, opts };
      return { json: async () => ({ ok: true, result: { message_id: 42 } }) };
    },
  });
  try {
    const res = await sendTelegramMessage(999, 'Calling …1234');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result.message_id, 42);
    assert.strictEqual(captured.url, 'https://api.telegram.org/botBOTTOK123/sendMessage');
    assert.strictEqual(captured.opts.method, 'POST');
    const body = JSON.parse(captured.opts.body);
    assert.strictEqual(body.chat_id, 999);
    assert.strictEqual(body.text, 'Calling …1234');
  } finally {
    __setTelegramDeps({ fetch: (...a) => globalThis.fetch(...a) });
    restoreEnv();
  }
});

test('setTelegramWebhook > builds the secret-path URL + secret_token from env base', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'BOTTOK123';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'pathsecret';
  process.env.API_URL = 'https://api.example.com';
  let captured = null;
  __setTelegramDeps({
    fetch: async (url, opts) => { captured = { url, opts }; return { json: async () => ({ ok: true, result: true }) }; },
  });
  try {
    const res = await setTelegramWebhook();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(captured.url, 'https://api.telegram.org/botBOTTOK123/setWebhook');
    const body = JSON.parse(captured.opts.body);
    assert.strictEqual(body.url, 'https://api.example.com/api/telegram/pathsecret');
    assert.strictEqual(body.secret_token, 'pathsecret');
  } finally {
    __setTelegramDeps({ fetch: (...a) => globalThis.fetch(...a) });
    restoreEnv();
  }
});

test('isNewUpdate > true on first insert, false on conflict', async () => {
  const calls = [];
  __setTelegramDeps({
    pool: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        // First call inserts a row, second hits ON CONFLICT DO NOTHING.
        return { rowCount: calls.length === 1 ? 1 : 0 };
      },
    },
  });
  try {
    assert.strictEqual(await isNewUpdate(555), true);
    assert.strictEqual(await isNewUpdate(555), false);
    assert.match(calls[0].sql, /INSERT INTO telegram_update/i);
    assert.match(calls[0].sql, /ON CONFLICT \(update_id\) DO NOTHING/i);
    assert.deepStrictEqual(calls[0].params, [555]);
  } finally {
    __setTelegramDeps({ pool: require('../db').pool });
  }
});

// ── sendTelegramAudio (voicemail delivery, spec 2026-07-22) ─────────────────

test('sendTelegramAudio > skips (no fetch) when gated off', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'BOTTOK123';
  process.env.SEND_NOTIFICATIONS = 'false';
  let called = 0;
  __setTelegramDeps({
    notificationsEnabled: () => false,
    fetch: async () => { called += 1; return { json: async () => ({ ok: true }) }; },
  });
  try {
    const res = await sendTelegramAudio(123456789, Buffer.from('ID3'), { caption: 'c' });
    assert.deepStrictEqual(res, { ok: false, skipped: true });
    assert.strictEqual(called, 0, 'a gated send must never hit the network');
  } finally {
    __setTelegramDeps({
      fetch: (...a) => globalThis.fetch(...a),
      notificationsEnabled: require('./notificationsEnabled').notificationsEnabled,
    });
    restoreEnv();
  }
});

test('sendTelegramAudio > posts bounded multipart and returns the Bot API envelope', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'BOTTOK123';
  process.env.SEND_NOTIFICATIONS = 'true';
  let seen = null;
  __setTelegramDeps({
    notificationsEnabled: () => true,
    fetch: async (url, opts) => {
      seen = { url, body: opts.body, hasSignal: Boolean(opts.signal) };
      return { json: async () => ({ ok: true, result: { message_id: 9 } }) };
    },
  });
  try {
    const res = await sendTelegramAudio(123456789, Buffer.from('ID3'), { caption: 'Voicemail from +13125550147' });
    assert.strictEqual(res.ok, true);
    assert.match(seen.url, /\/botBOTTOK123\/sendAudio$/);
    assert.ok(seen.body instanceof FormData);
    assert.strictEqual(seen.body.get('chat_id'), '123456789');
    assert.strictEqual(seen.body.get('caption'), 'Voicemail from +13125550147');
    assert.ok(seen.hasSignal, 'the Bot API call must be bounded by a timeout');
  } finally {
    __setTelegramDeps({ fetch: (...a) => globalThis.fetch(...a) });
    restoreEnv();
  }
});

test('sendTelegramAudio > never throws on a network error', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'BOTTOK123';
  process.env.SEND_NOTIFICATIONS = 'true';
  __setTelegramDeps({
    notificationsEnabled: () => true,
    fetch: async () => { throw new Error('socket hang up'); },
  });
  try {
    const res = await sendTelegramAudio(123456789, Buffer.from('ID3'), {});
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /socket hang up/);
  } finally {
    __setTelegramDeps({ fetch: (...a) => globalThis.fetch(...a) });
    restoreEnv();
  }
});

test('sendTelegramMessage > bounds the Bot API call with an abort signal', async () => {
  // The ping fires AFTER the TwiML response, so no caller waits on this. The
  // bound is general hygiene: a hung Bot API must not pin a request or a
  // scheduler tick indefinitely.
  process.env.TELEGRAM_BOT_TOKEN = 'BOTTOK123';
  process.env.SEND_NOTIFICATIONS = 'true';
  let hasSignal = false;
  __setTelegramDeps({
    notificationsEnabled: () => true,
    fetch: async (url, opts) => { hasSignal = Boolean(opts.signal); return { json: async () => ({ ok: true }) }; },
  });
  try {
    await sendTelegramMessage(123456789, 'hi');
    assert.ok(hasSignal);
  } finally {
    __setTelegramDeps({ fetch: (...a) => globalThis.fetch(...a) });
    restoreEnv();
  }
});
