'use strict';

// The first-text prefix (spec 4.3): the first text EVER sent from a 224 line to
// a number starts with "Dr. Bartender: ", so the person knows who the new
// number is. The server adds it and the reply box shows it before sending.
// Shared by the Inbox text route and the Messages reply, which lane sms-lines
// lets default to the sender's own 224 line. A failed send never counts as
// the first one: the person never saw it. Neither does one whose failure the
// status callback reported before its row existed (sms_status_orphans, lane
// sms-lines) and that no fold has marked failed yet.

const { pool } = require('../../db');
const { last10 } = require('../phone');
const { ValidationError } = require('../errors');
const { FIRST_TEXT_PREFIX, TEXT_BODY_MAX } = require('./constants');

const PREFIX_LINES = new Set(['1922', '0082']);
const SENT_FROM_LINE_SQL = `
  SELECT 1 FROM sms_messages
   WHERE direction = 'outbound' AND status <> 'failed' AND metadata->>'line' = $2
     AND RIGHT(REGEXP_REPLACE(recipient_phone, '\\D', '', 'g'), 10) = $1
     AND NOT EXISTS (SELECT 1 FROM sms_status_orphans o WHERE o.twilio_sid = sms_messages.twilio_sid)
   LIMIT 1`;

async function firstTextPrefixFor({ line, to }, db = pool) {
  const key = last10(to);
  if (!PREFIX_LINES.has(line) || !key) return null;
  const { rowCount } = await db.query(SENT_FROM_LINE_SQL, [key, line]);
  return rowCount ? null : FIRST_TEXT_PREFIX;
}

async function withFirstTextPrefix({ body, line, to }, db = pool) {
  const prefix = await firstTextPrefixFor({ line, to }, db);
  const text = String(body);
  if (!prefix || text.toLowerCase().startsWith(prefix.trim().toLowerCase())) return text;
  const out = `${prefix}${text}`;
  if (out.length > TEXT_BODY_MAX) {
    const message = `With the "${prefix.trim()}" introduction this text runs past ${TEXT_BODY_MAX} characters.`;
    throw new ValidationError({ body: message }, message);
  }
  return out;
}

module.exports = { firstTextPrefixFor, withFirstTextPrefix, PREFIX_LINES, SENT_FROM_LINE_SQL };
