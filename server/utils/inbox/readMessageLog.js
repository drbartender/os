'use strict';

// Reader: message_log (spec 5.1 and 5.4), with the bounce join: a Resend
// email.bounced event keyed by the row's provider_id makes the send failed.
// Rows with no client are skipped (5.2). There is no body column; an email
// shows its subject, an SMS row its 140-character preview.

const ML_HEADERS_SQL = `
  SELECT l.id, l.client_id, l.proposal_id, l.channel, l.message_type, l.status, l.provider_id, l.sent_by, l.created_at,
         (l.channel = 'email' AND l.provider_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM email_webhook_events w
             WHERE w.resend_id = l.provider_id AND w.event_type = 'email.bounced')) AS bounced
    FROM message_log l
   WHERE l.created_at >= $1 AND l.client_id IS NOT NULL`;

const ML_DETAILS_SQL = `
  SELECT id, channel, subject, error_message
    FROM message_log
   WHERE id = ANY($1::int[])`;

function mapMessageLogHeader(row) {
  const sms = row.channel === 'sms';
  const bounced = Boolean(row.bounced) || row.status === 'bounced';
  return {
    ref: `ml:${row.id}`, personKey: `c-${row.client_id}`, channel: sms ? 'text' : 'email', line: sms ? '888' : null,
    direction: 'out', at: new Date(row.created_at), author: row.sent_by ? Number(row.sent_by) : 'auto',
    kind: 'message', text: undefined,
    meta: {
      source: 'ml', id: Number(row.id), messageType: row.message_type || 'other', proposalId: Number(row.proposal_id),
      providerId: row.provider_id || null, failed: row.status === 'failed' || bounced, bounced,
    },
  };
}

async function loadMessageLogDetails(ids, db) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(ML_DETAILS_SQL, [ids]);
  return new Map(rows.map((r) => [`ml:${r.id}`, {
    subject: r.subject || null,
    text: r.channel === 'sms' ? (r.subject || null) : null,
    failureReason: r.error_message || null,
  }]));
}

module.exports = { ML_HEADERS_SQL, ML_DETAILS_SQL, mapMessageLogHeader, loadMessageLogDetails };
