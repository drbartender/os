'use strict';

// Reader: proposal sends from proposal_activity_log (spec 5.4): status_changed
// or status_force_changed to 'sent', 'resent', and 'group_sent'. Whether one
// counts (an admin or manager sent it, and a delivery went out) is decided by
// the rules after normalize.js absorbs its message_log deliveries. The website
// wizard never writes these rows, so a site-born proposal is never a reply.

const PAL_HEADERS_SQL = `
  SELECT a.id, a.proposal_id, a.action, a.actor_id, a.created_at, p.client_id, u.role AS actor_role
    FROM proposal_activity_log a
    JOIN proposals p ON p.id = a.proposal_id
    LEFT JOIN users u ON u.id = a.actor_id
   WHERE a.created_at >= $1 AND p.client_id IS NOT NULL
     AND (a.action IN ('resent', 'group_sent')
          OR (a.action IN ('status_changed', 'status_force_changed') AND a.details->>'to' = 'sent'))`;

function mapProposalSendHeader(row) {
  return {
    ref: `pal:${row.id}`, personKey: `c-${row.client_id}`, channel: null, line: null, direction: 'out',
    at: new Date(row.created_at), author: row.actor_id ? Number(row.actor_id) : 'auto', kind: 'proposal_sent', text: null,
    meta: { source: 'pal', id: Number(row.id), proposalId: Number(row.proposal_id), action: row.action, actorRole: row.actor_role || null },
  };
}

module.exports = { PAL_HEADERS_SQL, mapProposalSendHeader };
