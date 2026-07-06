// Dibs-edge notifier (spec 2026-07-06-presence-dibs-design.md): when a
// mutation BY the fallback owner moves the lead pointer, ping the user it
// moved off/onto via their nudge channel. Fire-and-forget: never rejects,
// never blocks the mutation. Gated skips are silent; only genuine send
// failures warn + Sentry; confirmed sends log one audit line.
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const telegram = require('./telegram');
const sms = require('./sms');

let _deps = { pool, sendTelegramMessage: telegram.sendTelegramMessage, sendSMS: sms.sendSMS };
function __setPresenceNotifyDeps(d) { _deps = { ..._deps, ...d }; }

function reportFailure(recipientId, edge, why) {
  console.warn(`[presence] dibs ${edge} ping failed for user ${recipientId} (${why}); not retried`);
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage('presence dibs ping undelivered', {
      level: 'warning',
      tags: { feature: 'presence-dibs' },
      extra: { recipient_id: recipientId, edge, why },
    });
  }
}

async function notifyDibsEdge({ actorId, before, after }) {
  let edge = 'unknown';
  let recipientId = null;
  try {
    if (!before || !after) return;
    if (before.lead_owner_id === after.lead_owner_id) return;
    const users = after.users || [];
    if (!users.length) return;
    const maxRank = Math.max(...users.map((u) => u.rank));
    const actor = users.find((u) => u.id === actorId);
    if (!actor || actor.rank !== maxRank) return; // only the fallback owner's edges ping
    if (after.lead_owner_id === actorId) { edge = 'grab'; recipientId = before.lead_owner_id; }
    else if (before.lead_owner_id === actorId) { edge = 'release'; recipientId = after.lead_owner_id; }
    else return;
    if (recipientId === null || recipientId === undefined || recipientId === actorId) return;

    const first = String(actor.name || '').split(' ')[0] || 'The owner';
    const text = edge === 'grab'
      ? `${first} called dibs on leads.`
      : `${first} released leads. You're up.`;

    // Strip payloads exclude channel/phone by design (they go to the client).
    const r = await _deps.pool.query(
      'SELECT presence_nudge_channel, presence_nudge_phone FROM users WHERE id = $1',
      [recipientId]
    );
    const row = r.rows[0];
    if (!row || !row.presence_nudge_channel) return; // never-nudged user: silent

    let confirmed = false;
    let skipped = false;
    let why = 'unknown';
    if (row.presence_nudge_channel === 'telegram') {
      if (!process.env.TELEGRAM_ALLOWED_USER_ID) {
        why = 'TELEGRAM_ALLOWED_USER_ID unset';
      } else {
        const res = await _deps.sendTelegramMessage(process.env.TELEGRAM_ALLOWED_USER_ID, text);
        confirmed = !!(res && res.ok === true);
        skipped = !!(res && res.skipped);
        if (!confirmed && !skipped) why = 'telegram send failed';
      }
    } else if (row.presence_nudge_channel === 'sms') {
      if (!row.presence_nudge_phone) {
        why = 'presence_nudge_phone unset';
      } else {
        const m = await _deps.sendSMS({
          to: row.presence_nudge_phone,
          body: text,
          meta: { type: 'presence_dibs', user_id: recipientId },
        });
        if (m && m.sid && !String(m.sid).startsWith('dev-skipped')) confirmed = true;
        else if (m && m.sid) skipped = true; // dev-skipped: gated off
        else why = 'sms send failed';
      }
    } else {
      return; // unknown channel value: silent (CHECK constraint should prevent)
    }

    if (confirmed) {
      const recipient = users.find((u) => u.id === recipientId);
      console.log(`[presence] dibs ${edge} ping -> ${recipient ? recipient.name : `user ${recipientId}`}`);
    } else if (!skipped) reportFailure(recipientId, edge, why);
  } catch (err) {
    reportFailure(recipientId, edge, err.message);
  }
}

module.exports = { notifyDibsEdge, __setPresenceNotifyDeps };
