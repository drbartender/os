'use strict';

// Reader: message_log (spec 5.1 and 5.4), with the bounce join: a Resend
// email.bounced event keyed by the row's provider_id makes the send failed.
// Rows with no client are skipped (5.2). There is no body column; an email
// shows its subject, an SMS row its 140-character preview.
//
// A proposal SMS written within 2 minutes after a GV post's fallback claim
// (fallback_status 'sent', fallback_at) for its proposal is that post's 888
// fallback (plan 2026-10-17 Task 12); a proposal text the router sent
// directly has no such claim. The window is a literal: the engine binds only
// the floor.

const ML_HEADERS_SQL = `
  SELECT l.id, l.client_id, l.proposal_id, l.channel, l.message_type, l.status, l.provider_id, l.sent_by, l.created_at,
         (l.channel = 'email' AND l.provider_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM email_webhook_events w
             WHERE w.resend_id = l.provider_id AND w.event_type = 'email.bounced')) AS bounced,
         gf.proposal_id AS gv_fallback_proposal_id, gf.created_at AS gv_post_created_at
    FROM message_log l
    LEFT JOIN LATERAL (
      SELECT p.proposal_id, p.created_at
        FROM gv_posts p
       WHERE l.channel = 'sms'
         AND l.message_type IN ('initial_proposal', 'proposal_sent_sms')
         AND p.proposal_id = l.proposal_id
         AND p.fallback_status = 'sent'
         AND p.fallback_at <= l.created_at
         AND l.created_at <= p.fallback_at + interval '2 minutes'
       ORDER BY p.fallback_at DESC, p.id DESC
       LIMIT 1
    ) gf ON true
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
      gvFallback: row.gv_fallback_proposal_id === null || row.gv_fallback_proposal_id === undefined ? null
        : { proposalId: Number(row.gv_fallback_proposal_id), postCreatedAt: new Date(row.gv_post_created_at) },
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
