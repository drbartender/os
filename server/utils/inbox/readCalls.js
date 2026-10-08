'use strict';

// Reader: connected bridge calls (spec 5.1 and decision 21), the lead call
// bridge and the consult call bridge. Shorter calls still show in the thread;
// the 60-second rule and the consult no-answer rule live in classify.js.

const { CALL_ANSWERED_BY_USER } = require('./constants');

// ids are BIGSERIAL, so node-postgres hands them back as strings.
const CALL_HEADERS_SQL = `
  SELECT 'lc' AS src, a.id, a.answered_by, a.bridge_duration_sec, NULL::timestamptz AS client_no_answer_at,
         COALESCE(a.bridge_started_at, a.updated_at) AS at, l.client_id, l.negotiation_id
    FROM lead_call_attempts a
    JOIN thumbtack_leads l ON l.id = a.lead_id
   WHERE a.status = 'connected' AND COALESCE(a.bridge_started_at, a.updated_at) >= $1
  UNION ALL
  SELECT 'cc' AS src, a.id, a.answered_by, a.bridge_duration_sec, a.client_no_answer_at,
         COALESCE(a.bridge_started_at, a.updated_at) AS at, c.client_id, NULL::varchar AS negotiation_id
    FROM consult_call_attempts a
    JOIN consults c ON c.id = a.consult_id
   WHERE a.status = 'connected' AND COALESCE(a.bridge_started_at, a.updated_at) >= $1`;

function answeredBy(value) {
  if (value === 'admin') return CALL_ANSWERED_BY_USER.admin;
  if (value === 'va') return CALL_ANSWERED_BY_USER.va;
  return null;
}

function mapCallHeader(row, index) {
  let key = null;
  if (row.src === 'lc') key = index.leadKey({ client_id: row.client_id, negotiation_id: row.negotiation_id });
  else if (row.client_id) key = `c-${row.client_id}`;
  if (!key) return null;
  return {
    ref: `${row.src}:${row.id}`, personKey: key, channel: 'voice', line: null, direction: 'out',
    at: new Date(row.at), author: answeredBy(row.answered_by), kind: 'call', text: null,
    meta: {
      source: row.src, id: Number(row.id), durationSec: Number(row.bridge_duration_sec) || 0,
      clientNoAnswer: Boolean(row.client_no_answer_at),
    },
  };
}

module.exports = { CALL_HEADERS_SQL, mapCallHeader };
