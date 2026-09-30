// server/utils/consultCallLookups.js
//
// Consult call bridge, the READ side (spec 2026-08-25 section 5.3). Two lookups
// that put a consult call outcome on an admin detail page: the latest chain for
// one proposal, and the latest chain per consult for one client. Nothing here
// writes, and nothing here belongs to the ring chain: consultCallChain.js,
// consultCallSweep.js and voiceConsultCall.js own every state transition.
//
// WHAT KEEPS THESE CHEAP IS THE INDEX ON consults, NOT THE TEXTUAL FROM ORDER.
// Both queries are two-relation inner joins. Postgres collapses one of those
// and reorders it freely, so naming consults first or naming the attempts table
// first produces the same query tree: the FROM order constrains nothing, and an
// earlier version of this comment claiming otherwise was wrong.
//
// What actually keeps the common case off a backward whole-table walk of the
// attempts primary key is idx_consults_proposal_id plus the selectivity of the
// equality predicate on it. An ordinary proposal that never had a consult, which
// is most of them, resolves against that index to no rows and the join has
// nothing to probe. Where rows do match, the composite
// UNIQUE (consult_id, scheduled_at) serves the inner side.
// idx_consults_client_id does the same job for the client lookup.
//
// So the thing to protect is the pair of indexes on consults and the equality
// predicate that reaches them, NOT the word order of the FROM clause. The
// suite's join-order test pins the FORM these queries are written in, so the
// shape a reader sees stays the shape that was reviewed. It does not pin a
// plan, and no textual test could.
//
// SIX SHARED COLUMNS, AND client_no_answer_at IS ONE OF THEM. The client-no-answer
// latch is a COLUMN, never a detail string (detail === 'client_no_answer' is a
// value the writers never produce). The surface labels a connected call that
// the client never picked up on exactly that column, and an unselected column
// arrives as undefined, which reads as "the condition did not happen". A
// dropped column here disables a label silently: the absence of a label looks
// exactly like the absence of the condition. Anything added to these SELECT
// lists must stay in step with what the detail views read.
//
// THE CLIENT LOOKUP CARRIES A SEVENTH COLUMN, consult_id, AND THE PROPOSAL ONE
// DOES NOT. That asymmetry is deliberate. consult_id is a LIST KEY: the client
// surface renders one line per row and needs something stable to key them on,
// and a slot is not an identity, because two consults for one client can share
// one. The proposal lookup returns at most one row, already identified by the
// proposal it hangs off, so an identifier there would be a column nothing reads
// and an invitation to key on it later without the ordering guarantee that
// makes it meaningful. A row shape is a contract: widen it when a reader needs
// the field, not for symmetry.
//
// detail is DIAGNOSTIC FREE TEXT and never an enum: a failed calls.create
// writes a raw Twilio error code into it, and skipped_cap carries THREE distinct
// values, which mean three different operator events:
//   cap_tripped        openChain's chain-open daily cap. The DOMINANT one: what
//                      a stranger hammering the PUBLIC booking page hits first.
//   dial_cap_tripped   the ceiling on rings to Dallas.
//   va_leg_cap_tripped the ceiling on international legs to Zul.
// All three ride through verbatim. A surface that labels only the last two
// collapses the dominant case into a wrong label, which is worse than no label
// because it reads as a fact rather than as a gap.
//
// scheduled_at is read here for DISPLAY only and is never handed back into a
// write. Ruling R12 (a slot must not round-trip through JavaScript, because
// node-pg truncates TIMESTAMPTZ to milliseconds and a truncated microsecond
// slot matches neither the anti-join nor the (consult_id, scheduled_at) UNIQUE)
// binds the writers; keep it that way by never feeding these rows into one.

const { pool } = require('../db');

/**
 * The most recent consult call chain attached to a proposal, or null.
 *
 * Newest attempt wins across every consult on the proposal: a reschedule opens
 * a fresh chain at the new slot, and ORDER BY a.id DESC is what makes the live
 * one, rather than the abandoned one, the row that surfaces.
 *
 * Six columns, no consult_id: a single row needs no list key. See the header.
 *
 * @param {number|string} proposalId
 * @returns {Promise<object|null>} snake_case row carrying status, answered_by,
 *   bridge_duration_sec, scheduled_at, detail and client_no_answer_at, or null
 *   when the proposal never had a consult (the common case) or the consult was
 *   never rung.
 */
async function latestConsultCallForProposal(proposalId) {
  const { rows } = await pool.query(
    `SELECT a.status, a.answered_by, a.bridge_duration_sec, a.scheduled_at, a.detail,
            a.client_no_answer_at
       FROM consults c
       JOIN consult_call_attempts a ON a.consult_id = c.id
      WHERE c.proposal_id = $1
      ORDER BY a.id DESC
      LIMIT 1`,
    [proposalId]
  );
  return rows[0] || null;
}

/**
 * The latest consult call chain for each consult this client has had, newest
 * slot first, capped at ten.
 *
 * DISTINCT ON collapses to one row per consult INSIDE the subquery, before the
 * LIMIT applies, so a client whose consults were each rescheduled twice still
 * gets ten consults back rather than ten attempts collapsed into three or four.
 *
 * consult_id is the stable list key for the surface, and consult_id DESC is the
 * sort tiebreaker. Both exist for the same reason: two consults for one client
 * can share a scheduled_at, so a slot identifies neither the row nor its place
 * in the order. Without the tiebreaker, two rows sharing a slot could come back
 * in a different order between requests and the list would reshuffle under the
 * reader for no reason at all.
 *
 * @param {number|string} clientId
 * @returns {Promise<object[]>} snake_case rows carrying consult_id, status,
 *   answered_by, bridge_duration_sec, scheduled_at, detail and
 *   client_no_answer_at. Empty when the client never booked a consult.
 */
async function consultCallsForClient(clientId) {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (a.consult_id)
              a.consult_id, a.status, a.answered_by, a.bridge_duration_sec, a.scheduled_at,
              a.detail, a.client_no_answer_at
         FROM consults c
         JOIN consult_call_attempts a ON a.consult_id = c.id
        WHERE c.client_id = $1
        ORDER BY a.consult_id, a.id DESC
     ) t ORDER BY scheduled_at DESC, consult_id DESC LIMIT 10`,
    [clientId]
  );
  return rows;
}

module.exports = { latestConsultCallForProposal, consultCallsForClient };
