'use strict';

// The rows the one "last human-involved line" rule reads for a client, over
// their WHOLE history (decision 9 has no date window; spec section 17 item 20
// asks for one rule). The Messages reply (routes/sms.js) and the Inbox reply
// area (reply.js) both read them, so a client whose newest human-involved
// text predates the Inbox history floor keeps the same line on both surfaces.
// The WHERE clause mirrors lastHumanLineFromRows (smsLines.js: their texts,
// relay texts included, and our human replies that did not fail) only so the
// newest candidate is the one row fetched; that function still decides.

const { pool } = require('../../db');

const LAST_HUMAN_ROW_SQL = `
  SELECT id, direction, sender_id, status, metadata, created_at
    FROM sms_messages
   WHERE client_id = $1
     AND (direction = 'inbound' OR (sender_id IS NOT NULL AND status IS DISTINCT FROM 'failed'))
   ORDER BY created_at DESC NULLS LAST, id DESC
   LIMIT 1`;

async function lastHumanRowsForClient(clientId, db = pool) {
  const { rows } = await db.query(LAST_HUMAN_ROW_SQL, [clientId]);
  return rows;
}

module.exports = { lastHumanRowsForClient, LAST_HUMAN_ROW_SQL };
