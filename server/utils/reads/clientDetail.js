// One client with their proposals, open Thumbtack lead and consult calls: the read behind GET /api/clients/:id.
//
// Moved out of server/routes/clients.js (lane connector-shared-reads, spec
// 2026-11-19 law 4) so the admin clients page and the Claude connector's
// client lookup share one copy. The route calls it with no exclusion and gets
// exactly the body it always sent; clients.detail.test.js pins that answer and
// was committed before the move.
//
// With `exclude` (legalHold.holdExclusion()), a client in exclude.clientIds,
// or an id that does not read as a positive integer, answers null, the same
// not-found a missing id gets, before any query runs; the proposals list also
// leaves out any id in exclude.proposalIds. Without it the id is handed to
// SQL as given, as the route always did.
//
// The body selects the whole clients row (SELECT *) and each proposal's link
// token: a caller outside the admin screen builds its own field allowlist
// from it (spec law 2).

const { pool } = require('../../db');
const { consultCallsForClient } = require('../consultCallLookups');
const { readExclusion, readLookupId } = require('./exclusion');

const CLIENT_SQL = 'SELECT * FROM clients WHERE id = $1';
// Explicit column allowlist on proposals excludes the pricing_snapshot blob.
const PROPOSALS_SELECT = `
      SELECT p.id, p.token, p.client_id, p.event_type, p.event_type_custom,
             p.event_date, p.status, p.total_price, p.amount_paid, p.created_at, p.cc_id,
             p.group_id, sp.name AS package_name, sp.slug AS package_slug
      FROM proposals p
      LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.client_id = $1`;
const PROPOSALS_SQL = `${PROPOSALS_SELECT}
      ORDER BY p.created_at DESC
    `;
const PROPOSALS_EXCLUDING_SQL = `${PROPOSALS_SELECT}
        AND NOT (p.id = ANY($2::int[]))
      ORDER BY p.created_at DESC
    `;
// Latest non-terminal Thumbtack lead: drives the manual email-harvest affordance.
const OPEN_LEAD_SQL = `SELECT negotiation_id FROM thumbtack_leads
        WHERE client_id = $1 AND status NOT IN ('converted','lost')
        ORDER BY created_at DESC LIMIT 1`;

/**
 * The client detail, or null when there is no such client (or it is held).
 * @param {number|string} clientId - the id as the route got it
 * @param {{exclude?: {proposalIds: number[], clientIds: number[]}}} [opts]
 * @returns {Promise<object|null>} every clients column, plus `proposals`
 *   (id, token, client_id, event_type, event_type_custom, event_date, status,
 *   total_price, amount_paid, created_at, cc_id, group_id, package_name,
 *   package_slug; newest first), `thumbtack_negotiation_id` (or null) and
 *   `consult_calls` (consultCallLookups.consultCallsForClient)
 */
async function getClientDetail(clientId, { exclude } = {}) {
  const hold = readExclusion(exclude);
  let id = clientId;
  if (hold) {
    id = readLookupId(clientId);
    if (id === null || hold.clientIds.includes(id)) return null;
  }
  // Client and proposals are independent lookups: Promise.all saves round trips.
  const [client, proposals, lead, consultCalls] = await Promise.all([
    pool.query(CLIENT_SQL, [id]),
    hold ? pool.query(PROPOSALS_EXCLUDING_SQL, [id, hold.proposalIds]) : pool.query(PROPOSALS_SQL, [id]),
    pool.query(OPEN_LEAD_SQL, [id]),
    // Consult call bridge outcomes (spec 2026-08-25 section 5.3): the latest ring
    // chain per consult this client has booked, newest slot first. Empty for a
    // client who never booked one. What keeps it cheap on that common case is
    // idx_consults_client_id, not the shape of the join: see the header of
    // consultCallLookups.js.
    consultCallsForClient(id),
  ]);
  if (!client.rows[0]) return null;
  return {
    ...client.rows[0],
    proposals: proposals.rows,
    thumbtack_negotiation_id: lead.rows[0]?.negotiation_id || null,
    consult_calls: consultCalls,
  };
}

module.exports = { getClientDetail };
