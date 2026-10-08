'use strict';

// Feed health (spec 4.6): when each source last delivered anything, by
// created_at. Inbound only for the lines; a row with no metadata.to, or a To
// that is not a registry line, is the 888 (spec 9). A source quiet for 48
// hours or more gets the dot. Information, not an alarm: the 224 lines are
// quiet by nature.

const { pool } = require('../../db');
const { last10 } = require('../phone');
const { lineE164 } = require('../smsLines');
const { QUIET_HOURS } = require('./constants');

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
             AND RIGHT(REGEXP_REPLACE(COALESCE(metadata->>'to', ''), '\\D', '', 'g'), 10) = $3) AS line_0082`;

async function loadFeeds({ now = new Date() } = {}, db = pool) {
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
  return [feed('thumbtack', r.thumbtack), feed('888', r.line_888), feed('1922', r.line_1922), feed('0082', r.line_0082)];
}

module.exports = { loadFeeds, FEEDS_SQL };
