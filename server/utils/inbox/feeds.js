'use strict';

// Feed health (spec 4.6): when each source last delivered anything, by
// created_at. Inbound only for the lines; a row with no metadata.to, or a To
// that is not a registry line, is the 888 (spec 9). A source quiet for 48
// hours or more gets the dot. Information, not an alarm: the 224 lines are
// quiet by nature.
// Gmail and Zola (spec 2026-10-14 section 4.6): Gmail is the time of the last
// GOOD sync, not the last mail (a quiet mailbox is healthy, a stuck sync is
// not), with a status: off with no key or with the sync switched off (the
// aiStatus.js rule), failing after GMAIL_FAILING_TICKS failed ticks in a row,
// catching_up while the backfill pages, else on. Zola is the time of its last
// stored notice of any kind, quiet by nature: every Zola row, and only a Zola
// row, carries its lead (the sync links one in the insert's transaction), so
// the lead column finds them through idx_gmail_messages_zola_at.

const { pool } = require('../../db');
const { last10 } = require('../phone');
const { lineE164 } = require('../smsLines');
const { isConfigured: gmailIsConfigured } = require('../gmailClient');
const { QUIET_HOURS, GMAIL_FAILING_TICKS } = require('./constants');

const HOUR = 3600 * 1000;
const FEEDS_SQL = `
  SELECT (SELECT MAX(created_at) FROM thumbtack_messages) AS thumbtack,
         (SELECT MAX(created_at) FROM sms_messages
           WHERE direction = 'inbound'
             AND RIGHT(REGEXP_REPLACE(COALESCE(metadata->>'to', ''), '\\D', '', 'g'), 10) <> ALL($1::text[])) AS line_888,
         (SELECT MAX(created_at) FROM sms_messages
           WHERE direction = 'inbound'
             AND RIGHT(REGEXP_REPLACE(COALESCE(metadata->>'to', ''), '\\D', '', 'g'), 10) = $2) AS line_1922,
         (SELECT MAX(created_at) FROM sms_messages
           WHERE direction = 'inbound'
             AND RIGHT(REGEXP_REPLACE(COALESCE(metadata->>'to', ''), '\\D', '', 'g'), 10) = $3) AS line_0082,
         (SELECT MAX(at) FROM gmail_messages WHERE zola_lead_id IS NOT NULL) AS zola,
         (SELECT last_ok_at FROM gmail_sync_state WHERE id = 1) AS gmail_last_ok_at,
         (SELECT backfill_done FROM gmail_sync_state WHERE id = 1) AS gmail_backfill_done,
         (SELECT consecutive_errors FROM gmail_sync_state WHERE id = 1) AS gmail_errors`;

// The same rule as enabled('RUN_GMAIL_SYNC_SCHEDULER') in server/index.js
// (aiStatus.readSchedulerEnabled's twin): schedulers run only in production
// unless RUN_SCHEDULERS=true, never with RUN_SCHEDULERS=false, and this one
// not with its own flag at 'false'.
function gmailSchedulerEnabled(env = process.env) {
  if (env.RUN_SCHEDULERS === 'false') return false;
  if (env.NODE_ENV !== 'production' && env.RUN_SCHEDULERS !== 'true') return false;
  return env.RUN_GMAIL_SYNC_SCHEDULER !== 'false';
}

// With no state row yet (the first tick has not run), a running feed is
// catching up.
function gmailStatus({ configured, schedulerEnabled, backfillDone, errors }) {
  if (!configured || !schedulerEnabled) return 'off';
  if (Number(errors) >= GMAIL_FAILING_TICKS) return 'failing';
  if (backfillDone !== true) return 'catching_up';
  return 'on';
}

// gmailConfigured and gmailSyncOn: whether the Gmail key is set and the sync
// switched on (test seams; the defaults ask the client and the environment).
async function loadFeeds({
  now = new Date(), gmailConfigured = gmailIsConfigured(), gmailSyncOn = gmailSchedulerEnabled(),
} = {}, db = pool) {
  const k1922 = last10(lineE164('1922'));
  const k0082 = last10(lineE164('0082'));
  const { rows } = await db.query(FEEDS_SQL, [[k1922, k0082].filter(Boolean), k1922, k0082]);
  const r = rows[0] || {};
  const nowMs = new Date(now).getTime();
  const feed = (source, at) => ({
    source,
    last_at: at ? new Date(at).toISOString() : null,
    quiet: !at || nowMs - new Date(at).getTime() >= QUIET_HOURS * HOUR,
  });
  const gmail = {
    ...feed('gmail', r.gmail_last_ok_at),
    status: gmailStatus({
      configured: gmailConfigured, schedulerEnabled: gmailSyncOn, backfillDone: r.gmail_backfill_done, errors: r.gmail_errors,
    }),
  };
  return [
    feed('thumbtack', r.thumbtack), feed('888', r.line_888), feed('1922', r.line_1922), feed('0082', r.line_0082),
    gmail, feed('zola', r.zola),
  ];
}

module.exports = { loadFeeds, FEEDS_SQL, gmailStatus, gmailSchedulerEnabled };
