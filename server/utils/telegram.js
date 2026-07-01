const crypto = require('crypto');
const { pool } = require('../db');
const { notificationsEnabled } = require('./notificationsEnabled');

const TELEGRAM_API = 'https://api.telegram.org';

// Dependency seam for tests (mirror server/utils/sms.js:57-58). Inject `fetch`,
// `pool`, and/or `notificationsEnabled`; the arrow wrapper keeps global fetch
// callable without `this`.
let _deps = { fetch: (...args) => globalThis.fetch(...args), pool, notificationsEnabled };
function __setTelegramDeps(d) { _deps = { ..._deps, ...d }; }

// Public HTTPS origin Telegram calls back into. Matches CLAUDE.md API_URL:
// API_URL || RENDER_EXTERNAL_URL in prod, localhost in dev.
function webhookBase() {
  return process.env.API_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:5000';
}

// last-4 redaction so chat ids never sit in logs in full (PII discipline, spec §10).
function last4(x) { return '…' + String(x === null || x === undefined ? '' : x).slice(-4); }

/**
 * Send a Telegram message to a chat. Gated identically to sendSMS: if the bot
 * token is absent OR notifications are gated off, log and skip (never hits the
 * network). Never throws — a failed reply must not 500 a webhook handler.
 * @returns {Promise<object>} Bot API JSON, or { ok:false, skipped:true } when gated.
 */
async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !_deps.notificationsEnabled()) {
    const why = !token ? 'TELEGRAM_BOT_TOKEN not set' : 'notifications gated off';
    console.log(`[DEV] Telegram message skipped (${why}) → chat ${last4(chatId)} | ${text}`);
    return { ok: false, skipped: true };
  }
  try {
    const res = await _deps.fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!data.ok) {
      console.error(`[telegram] sendMessage failed → chat ${last4(chatId)}: ${data.description || res.status}`);
    }
    return data;
  } catch (err) {
    console.error(`[telegram] sendMessage error → chat ${last4(chatId)}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Register (or re-register) the webhook. Points Telegram at the secret-path URL
 * and sets the secret_token header value (both layers of webhook authenticity,
 * spec §1). Requires the bot token + secret; returns the Bot API result.
 */
async function setTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) {
    console.warn('[telegram] setWebhook skipped — TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET unset');
    return { ok: false, skipped: true };
  }
  const url = `${webhookBase()}/api/telegram/${secret}`;
  const res = await _deps.fetch(`${TELEGRAM_API}/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // allowed_updates trimmed to 'message' — we only ever act on text messages.
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message'] }),
  });
  return res.json();
}

/**
 * Fetch current webhook registration state (url, last_error_date, etc.) for the
 * heartbeat scheduler (spec §9). Returns the raw Bot API JSON.
 */
async function getTelegramWebhookInfo() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('[telegram] getWebhookInfo skipped — TELEGRAM_BOT_TOKEN unset');
    return { ok: false, skipped: true };
  }
  const res = await _deps.fetch(`${TELEGRAM_API}/bot${token}/getWebhookInfo`, { method: 'POST' });
  return res.json();
}

/**
 * Constant-time verify of the X-Telegram-Bot-Api-Secret-Token header against
 * TELEGRAM_WEBHOOK_SECRET. Hashing both sides to fixed-length SHA-256 digests
 * makes timingSafeEqual safe regardless of input length (raw compare throws on
 * length mismatch) and avoids leaking the secret's length. False if the secret
 * is unset (fail closed) or the header is missing/empty.
 */
function verifyTelegramSecret(req) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return false;
  const provided = req && typeof req.header === 'function'
    ? req.header('x-telegram-bot-api-secret-token')
    : undefined;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Idempotency de-dupe layer (spec §5). INSERT the update_id; a fresh row means
 * this update is new, a conflict means it is a Telegram retry we already saw.
 * @returns {Promise<boolean>} true iff a row was inserted.
 */
async function isNewUpdate(updateId) {
  const result = await _deps.pool.query(
    'INSERT INTO telegram_update (update_id) VALUES ($1) ON CONFLICT (update_id) DO NOTHING',
    [updateId]
  );
  return result.rowCount === 1;
}

module.exports = {
  sendTelegramMessage,
  setTelegramWebhook,
  getTelegramWebhookInfo,
  verifyTelegramSecret,
  isNewUpdate,
  __setTelegramDeps,
};
