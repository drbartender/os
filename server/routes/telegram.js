const express = require('express');
const rateLimit = require('express-rate-limit');
const Sentry = require('@sentry/node');

const telegram = require('../utils/telegram');
const pendingCall = require('../utils/pendingCall');
const sms = require('../utils/sms');
const usPhone = require('../utils/usPhone');
const presenceStore = require('../utils/presenceStore');
const presenceActivity = require('../utils/presenceActivity');

const router = express.Router();

// Dependency seam for tests (mirror server/utils/sms.js:57-58 __setSmsDeps).
// Every external effect goes through `deps` so the whole flow is unit-tested
// with stubs and a dev server never dials the live Twilio account.
let deps = {
  verifyTelegramSecret: telegram.verifyTelegramSecret,
  isNewUpdate: telegram.isNewUpdate,
  sendTelegramMessage: telegram.sendTelegramMessage,
  upsertPending: pendingCall.upsertPending,
  claimForDial: pendingCall.claimForDial,
  attachCallSid: pendingCall.attachCallSid,
  countPlacedSince: pendingCall.countPlacedSince,
  recordAudit: pendingCall.recordAudit,
  placeBridgedCall: sms.placeBridgedCall,
  toUsE164: usPhone.toUsE164,
  getTelegramTrackedUserId: presenceStore.getTelegramTrackedUserId,
  hasPendingNudge: presenceStore.hasPendingNudge,
  presenceTouch: (userId) => presenceActivity.touch(userId, { immediate: true }),
};
function __setDeps(d) { deps = { ...deps, ...d }; }

// Defense-in-depth CPU / DB-write-amplification cap (mirror
// server/routes/sms.js:19-23 inboundLimiter). NOT the toll-fraud daily cap:
// every Telegram trigger shares one source IP, so per-IP rate-limiting is
// useless as a spend cap (spec §Security 6). The real cap is DB-backed below.
const telegramLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: 'ok' });

const YES_RE = /^y(es)?$/i;

// PII redaction to last-4 (match server/utils/smsInbound.js:572 slice(-4)).
function last4(x) { return '...' + String(x === null || x === undefined ? '' : x).slice(-4); }

function prettyUsE164(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : String(e164 || '');
}

// Callback base URL (see CLAUDE.md API_URL): prod uses API_URL /
// RENDER_EXTERNAL_URL; dev falls back to localhost:5000.
function webhookBase() {
  return process.env.API_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:5000';
}

// Bot-API reply that never turns a handled outcome into a non-200 (a non-2xx
// would make Telegram retry the whole update).
async function reply(chatId, text) {
  try { if (chatId !== null && chatId !== undefined) await deps.sendTelegramMessage(chatId, text); }
  catch (err) { console.warn('[telegram] reply send failed:', err.message); }
}

/**
 * POST /api/telegram/:secret — Zul's outbound-call trigger. This webhook dials
 * billed international calls on an auto-refill account from external input, so
 * it is a toll-fraud target; the ordered guards below are load-bearing
 * (spec §"Security & correctness"). Always 200 on a handled outcome so Telegram
 * does not retry-storm; hard 403 only on failed authenticity.
 */
router.post('/:secret', telegramLimiter, async (req, res) => {
  const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

  // Guard 1 — webhook authenticity: secret_token header AND unguessable path.
  // Hard 403 in EVERY environment. A privileged, call-initiating endpoint has
  // no dev signature-skip path (contrast the SMS webhook's dev warn-and-allow).
  if (!deps.verifyTelegramSecret(req) || !SECRET || req.params.secret !== SECRET) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage('Telegram webhook auth failure', {
        level: 'warning', tags: { webhook: 'telegram', reason: 'bad_secret' },
      });
    }
    return res.status(403).send('Forbidden');
  }

  try {
    const update = req.body || {};
    const message = update.message || {};
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const chatId = message.chat && message.chat.id;
    const fromId = message.from && message.from.id;
    const updateId = update.update_id;

    // Ignore non-message updates (edits, callbacks, my_chat_member, etc.).
    if (updateId === null || updateId === undefined || fromId === null || fromId === undefined) return res.sendStatus(200);

    // Guard 5 (second layer) — de-dupe Telegram retries by update_id.
    const fresh = await deps.isNewUpdate(updateId);
    if (!fresh) return res.sendStatus(200);

    // Bootstrap: with the allowlist unset, echo the sender's numeric id so
    // Dallas captures it once, sets TELEGRAM_ALLOWED_USER_ID, and redeploys.
    // Nothing else happens; never dials (spec Component 8).
    const ALLOWED = process.env.TELEGRAM_ALLOWED_USER_ID;
    if (!ALLOWED) {
      await reply(chatId, `Your Telegram id is ${fromId}`);
      return res.sendStatus(200);
    }

    // Guard 2 — sender allowlist, layered on top of #1 (never instead of it).
    // Silent no-op for anyone else.
    if (String(fromId) !== String(ALLOWED)) return res.sendStatus(200);

    // Presence sign of life (spec 2026-07-02): any message from Zul proves
    // she is alive. Best-effort; must never block or fail call handling.
    let presenceUserId = null;
    try {
      presenceUserId = await deps.getTelegramTrackedUserId();
      if (presenceUserId) deps.presenceTouch(presenceUserId);
    } catch (err) {
      console.warn('[telegram] presence touch failed:', err.message);
    }

    const userId = fromId;

    if (YES_RE.test(text)) {
      // Guard 6 — DB-backed spend caps, checked BEFORE the claim.
      const perMinCap = Number(process.env.VA_CALL_PER_MIN_CAP) || 5;
      const dailyCap = Number(process.env.VA_CALL_DAILY_CAP) || 40;
      const [lastMin, lastDay] = await Promise.all([
        deps.countPlacedSince('1 minute'),
        deps.countPlacedSince('24 hours'),
      ]);
      if (lastMin >= perMinCap || lastDay >= dailyCap) {
        await deps.recordAudit({ triggeredBy: userId, targetE164: null, callSid: null, status: 'rejected_cap' });
        await reply(chatId, 'Call limit reached. Please try again in a bit.');
        return res.sendStatus(200);
      }

      // Guard 5 — claim-then-call. The conditional UPDATE commits first; only
      // the winning row dials, so a Telegram retry / crash-retry finds nothing
      // claimable and is a no-op. calls.create cannot live in a DB transaction.
      const claimed = await deps.claimForDial(userId);
      if (!claimed) {
        // A bare "yes" with no pending call is the natural nudge ack
        // (spec: Sign of life, precedence rule c).
        let ack = false;
        try { ack = presenceUserId ? await deps.hasPendingNudge(presenceUserId) : false; }
        catch (err) { console.warn('[telegram] nudge check failed:', err.message); }
        await reply(chatId, ack
          ? 'Got it, keeping you on desk.'
          : 'That request expired or there is nothing to confirm. Send the number again.');
        return res.sendStatus(200);
      }

      const timeLimit = Number(process.env.VA_CALL_TIME_LIMIT_SEC) || 1800;
      const base = webhookBase();
      let result;
      try {
        result = await deps.placeBridgedCall({
          to: process.env.VA_CELL,                 // strict E.164, never normalized
          callerId: process.env.VOICE_CALLER_ID,   // the 224
          url: `${base}/api/voice/bridge`,
          statusCallback: `${base}/api/voice/status`,
          timeLimit,
        });
      } catch (err) {
        await deps.recordAudit({ triggeredBy: userId, targetE164: claimed.targetE164, callSid: null, status: 'failed' });
        console.error('[telegram] placeBridgedCall failed:', err.message);
        await reply(chatId, 'That call could not be placed. Send the number again to retry.');
        return res.sendStatus(200);
      }

      const callSid = result && result.sid ? result.sid : null;
      // Audit + count the billed call FIRST, immediately after placeBridgedCall
      // resolves. A call Twilio has accepted is already billed, so it MUST be
      // audited and counted against the spend cap no matter what happens next.
      await deps.recordAudit({ triggeredBy: userId, targetE164: claimed.targetE164, callSid, status: 'placed' });
      // attachCallSid is best-effort: it lets the /bridge webhook resolve the
      // target, but a failure here must never skip the audit above or the reply
      // below (the call is already placed + counted). Log loudly, do not rethrow.
      try {
        await deps.attachCallSid(claimed.id, callSid);
      } catch (err) {
        console.error(`[telegram] attachCallSid failed (call already placed + audited) sid=${last4(callSid)}:`, err.message);
      }
      console.log(`[telegram] call placed sid=${last4(callSid)} target=${last4(claimed.targetE164)}`);
      await reply(chatId, `Calling ${last4(claimed.targetE164)} now.`);
      return res.sendStatus(200);
    }

    // Otherwise treat the message as a target number.
    // Guard 3 — US-only NANP validation (primary toll-fraud control).
    const targetE164 = deps.toUsE164(text);
    if (!targetE164) {
      // Unparseable text while a nudge is pending is a nudge ack, not a bad
      // call attempt: ack it and skip the rejected_validation audit.
      let ack = false;
      try { ack = presenceUserId ? await deps.hasPendingNudge(presenceUserId) : false; }
      catch (err) { console.warn('[telegram] nudge check failed:', err.message); }
      if (ack) {
        await reply(chatId, 'Got it, keeping you on desk.');
        return res.sendStatus(200);
      }
      await deps.recordAudit({ triggeredBy: userId, targetE164: null, callSid: null, status: 'rejected_validation' });
      await reply(chatId, 'That does not look like a US number. Send a 10-digit US number (no 900 or 976).');
      return res.sendStatus(200);
    }

    // Guard 4 — confirm-before-dial. upsertPending replaces any prior pending
    // row for this user (ON CONFLICT (user_id) DO UPDATE, per Task 5).
    const ttlSeconds = Number(process.env.PENDING_CALL_TTL_SEC) || 120;
    await deps.upsertPending({ userId, targetE164, ttlSeconds });
    await reply(chatId, `Reply YES to call ${prettyUsE164(targetE164)}`);
    return res.sendStatus(200);
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { webhook: 'telegram' } });
    }
    console.error('[telegram] handler error:', err.message);
    // Return 200 so Telegram does not retry-storm. The update_id de-dupe plus
    // claim-then-call idempotency make a dropped update safe (Zul resends).
    return res.sendStatus(200);
  }
});

router.__setDeps = __setDeps;
module.exports = router;
