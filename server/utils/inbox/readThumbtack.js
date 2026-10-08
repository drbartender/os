'use strict';

// Reader: thumbtack_messages (spec 5.1). Both sides land here: Customer rows
// are them writing, Business rows are a reply whose author the OS cannot know.
// A message reaches a person only through thumbtack_leads.negotiation_id.

const { personKey } = require('./personKey');

const TT_HEADERS_SQL = `
  SELECT t.id, t.message_id, t.negotiation_id, t.from_type,
         COALESCE(t.sent_at, t.created_at) AS at,
         (btrim(COALESCE(t.text, '')) = '') AS empty_body
    FROM thumbtack_messages t
   WHERE COALESCE(t.sent_at, t.created_at) >= $1
     AND t.from_type IN ('Customer', 'Business')`;

const TT_DETAILS_SQL = `
  SELECT message_id, text, sender_name
    FROM thumbtack_messages
   WHERE message_id = ANY($1::text[])`;

function mapThumbtackHeader(row, index) {
  const negotiationId = row.negotiation_id === null || row.negotiation_id === undefined ? null : String(row.negotiation_id);
  const lead = negotiationId ? index.leadsByNegotiation.get(negotiationId) : null;
  const key = lead ? index.leadKey(lead) : (negotiationId ? personKey('t', negotiationId) : null);
  if (!key) return null;
  return {
    ref: `tt:${row.message_id}`, personKey: key, channel: 'thumbtack', line: null,
    direction: row.from_type === 'Customer' ? 'in' : 'out', at: new Date(row.at), author: null,
    kind: 'message', text: undefined,
    meta: {
      source: 'tt', id: Number(row.id), negotiationId, empty: Boolean(row.empty_body),
      firstReplySentAt: lead && lead.first_reply_sent_at ? new Date(lead.first_reply_sent_at) : null,
    },
  };
}

async function loadThumbtackDetails(messageIds, db) {
  if (!messageIds.length) return new Map();
  const { rows } = await db.query(TT_DETAILS_SQL, [messageIds]);
  return new Map(rows.map((r) => [`tt:${r.message_id}`, { text: r.text, senderName: r.sender_name || null }]));
}

module.exports = { TT_HEADERS_SQL, TT_DETAILS_SQL, mapThumbtackHeader, loadThumbtackDetails };
