// Stale-desk nudge + auto-flip sweep, every 15 min (spec: Nudge and auto-flip
// scheduler). nudged_at stamps ONLY on a confirmed send; an ignored nudge
// flips the user to away with the interval closed AT the nudge time.
const Sentry = require('@sentry/node');
const sms = require('./sms');
const telegram = require('./telegram');
const store = require('./presenceStore');
const presenceActivity = require('./presenceActivity');
const presenceNotify = require('./presenceNotify');
const { isNudgeDue, isFlipDue } = require('./presence');

let _deps = {
  now: () => new Date(),
  findSweepRows: store.findSweepRows,
  stampNudged: store.stampNudged,
  applyAutoFlip: store.applyAutoFlip,
  lastActivityMs: presenceActivity.lastActivityMs,
  sendTelegramMessage: telegram.sendTelegramMessage,
  sendSMS: sms.sendSMS,
  getStripPayload: store.getStripPayload,
  notifyDibsEdge: presenceNotify.notifyDibsEdge,
};
function __setPresenceSchedulerDeps(d) { _deps = { ..._deps, ...d }; }

const NUDGE_COPY =
  'You\'ve been on desk for 6+ hours. Still working? Reply "yes" or touch the app ' +
  'within 30 minutes and I\'ll keep you clocked in. Otherwise I\'ll flip you to away.';

function reportUndelivered(row, why) {
  console.warn(`[presence] nudge not delivered for ${row.name} (${why}); will retry next sweep`);
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage('presence nudge undelivered', {
      level: 'warning',
      tags: { scheduler: 'presence' },
      extra: { user_id: row.user_id, channel: row.presence_nudge_channel, why },
    });
  }
}

async function nudge(row) {
  let confirmed = false;
  let why = 'unknown';
  if (row.presence_nudge_channel === 'telegram') {
    if (!process.env.TELEGRAM_ALLOWED_USER_ID) {
      why = 'TELEGRAM_ALLOWED_USER_ID unset';
    } else {
      const r = await _deps.sendTelegramMessage(process.env.TELEGRAM_ALLOWED_USER_ID, NUDGE_COPY);
      confirmed = !!(r && r.ok === true);
      if (!confirmed) why = r && r.skipped ? 'gated off' : 'telegram send failed';
    }
  } else if (row.presence_nudge_channel === 'sms') {
    if (!row.presence_nudge_phone) {
      why = 'presence_nudge_phone unset';
    } else {
      try {
        const m = await _deps.sendSMS({
          to: row.presence_nudge_phone,
          body: NUDGE_COPY,
          meta: { type: 'presence_nudge', user_id: row.user_id },
        });
        confirmed = !!(m && m.sid && !String(m.sid).startsWith('dev-skipped'));
        if (!confirmed) why = 'gated off';
      } catch (err) {
        why = `sms send failed: ${err.message}`;
      }
    }
  } else {
    why = 'no nudge channel';
  }
  if (confirmed) await _deps.stampNudged(row.id);
  else reportUndelivered(row, why);
}

async function sweepPresence() {
  const now = _deps.now();
  const rows = await _deps.findSweepRows();
  for (const row of rows) {
    if (isNudgeDue(row, now)) {
      await nudge(row);
      continue; // never nudge and flip in the same sweep
    }
    const mem = _deps.lastActivityMs(row.user_id);
    const db = row.presence_last_seen_at ? new Date(row.presence_last_seen_at).getTime() : null;
    const lastSeenMs = mem === null && db === null ? null : Math.max(mem || 0, db || 0);
    if (isFlipDue(row, lastSeenMs, now)) {
      // Failure-isolated dibs-edge captures: a capture error must never abort
      // the sweep or the flip. Unconditional (findSweepRows has no rank);
      // notifyDibsEdge rule 2 filters non-owner flips. Spec 2026-07-06.
      const before = await _deps.getStripPayload().catch(() => null);
      const flipped = await _deps.applyAutoFlip({ intervalId: row.id, userId: row.user_id });
      if (flipped) {
        console.log(`[presence] auto-flipped ${row.name} to away (nudged ${new Date(row.nudged_at).toISOString()}, no sign of life)`);
        const after = await _deps.getStripPayload().catch(() => null);
        await _deps.notifyDibsEdge({ actorId: row.user_id, before, after }).catch(() => {});
      }
    }
  }
}

module.exports = { sweepPresence, __setPresenceSchedulerDeps };
