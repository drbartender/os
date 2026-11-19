'use strict';

// The identity rule (spec docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md,
// law 1): may this proposal's text be posted through Google Voice, and into
// which Thumbtack lead's conversation? A token link is bearer access to the
// client's details and to sign-and-pay, so any mismatch or ambiguity answers
// no, and the caller sends today's toll-free text instead.
//
// The number is always the proposal client's stored clients.phone, never a
// request value. Since 2026-06-08 every Thumbtack lead stores a per-lead relay
// number as customer_phone (THUMBTACK_PROXY_ROLLOUT), and each customer is one
// GV conversation under that number. Reads only, on the passed db; the router
// and the lease call it, and the lease re-checks it.
//
// A sibling of smsInbound.js findThumbtackProxyLead rather than a change to it:
// that helper's return shape feeds routes/sms.js, routes/proposals/publicToken.js
// and smsInbound.js itself.

const { pool } = require('../../db');
const { THUMBTACK_PROXY_ROLLOUT } = require('../inbox/constants');
const { last10 } = require('../phone');
const { normalizePhone } = require('../sms');
const { GV_WINDOWS } = require('./rules');

const fail = (reason) => ({ ok: false, reason });
const blank = (v) => v === null || v === undefined || String(v).trim() === '';

/**
 * Resolve the GV target for a proposal (law 1). Rule order:
 *   1. the proposal client's clients.phone (no client: no_client; none or
 *      unparseable: no_phone);
 *   2. the post-rollout leads whose customer_phone matches it on the last 10
 *      digits (none: not_relay);
 *   3. every such lead belongs to the proposal's client, a NULL client_id
 *      counting as foreign (else foreign_lead);
 *   4. they all carry one non-blank Thumbtack customer_id (else
 *      customer_mismatch);
 *   5. the chosen lead is the one linked to this proposal; otherwise the one
 *      lead from step 2, and more than one is ambiguous_lead (two leads linked
 *      to one proposal, which the auto-draft never writes, are ambiguous too);
 *   6. the chosen lead carries the client's number (else lead_not_on_phone);
 *   7. the chosen lead itself belongs to the proposal's client (else
 *      foreign_lead) and carries the one customer_id the leads of step 2
 *      share (else customer_mismatch). A linked lead from before the rollout
 *      is not among step 2's leads, so steps 3 and 4 never saw it;
 *   8. it is under 180 days old (else lead_too_old).
 *
 * @param {number} proposalId
 * @param {Object} [db] pg pool or client
 * @returns {Promise<{ok:true, clientId:number, leadId:number, negotiationId:string, phone:string}
 *   | {ok:false, reason:'no_client'|'no_phone'|'not_relay'|'foreign_lead'|'customer_mismatch'
 *     |'ambiguous_lead'|'lead_not_on_phone'|'lead_too_old'}>}
 */
async function resolveGvTarget(proposalId, db = pool) {
  const pc = await db.query(
    `SELECT c.id AS client_id, c.phone
       FROM proposals p
       JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );
  const client = pc.rows[0];
  if (!client) return fail('no_client');
  const phone = normalizePhone(client.phone);
  const key = last10(client.phone);
  if (!phone || !key) return fail('no_phone');
  const clientId = Number(client.client_id);

  // One read covers both the leads on the number (step 2) and the lead linked
  // to the proposal (step 5), which may carry another number (step 6).
  const { rows } = await db.query(
    `SELECT id, negotiation_id, client_id, customer_id, proposal_id,
            RIGHT(REGEXP_REPLACE(COALESCE(customer_phone, ''), '\\D', '', 'g'), 10) AS phone_last10,
            created_at >= $2::timestamptz AS post_rollout,
            created_at >= now() - make_interval(days => $4) AS fresh
       FROM thumbtack_leads
      WHERE (RIGHT(REGEXP_REPLACE(customer_phone, '\\D', '', 'g'), 10) = $1 AND created_at >= $2::timestamptz)
         OR proposal_id = $3`,
    // leadMaxAgeDays: the chosen lead must be younger, a backstop against a
    // recycled relay number (law 1).
    [key, THUMBTACK_PROXY_ROLLOUT, proposalId, GV_WINDOWS.leadMaxAgeDays]
  );

  const onNumber = rows.filter((r) => r.phone_last10 === key && r.post_rollout);
  if (onNumber.length === 0) return fail('not_relay');
  if (onNumber.some((r) => r.client_id === null || Number(r.client_id) !== clientId)) {
    return fail('foreign_lead');
  }
  const customerIds = new Set(onNumber.map((r) => (blank(r.customer_id) ? null : String(r.customer_id))));
  if (customerIds.has(null) || customerIds.size > 1) return fail('customer_mismatch');

  const linked = rows.filter((r) => r.proposal_id !== null && Number(r.proposal_id) === Number(proposalId));
  let chosen;
  if (linked.length > 1) return fail('ambiguous_lead');
  if (linked.length === 1) {
    [chosen] = linked;
  } else {
    if (onNumber.length > 1) return fail('ambiguous_lead');
    [chosen] = onNumber;
  }
  if (chosen.phone_last10 !== key) return fail('lead_not_on_phone');
  // Step 7. A post-rollout chosen lead passes trivially (steps 3 and 4 held
  // it already); a pre-rollout linked one on the same number is held to the
  // same client and the same Thumbtack customer id here. onNumber is never
  // empty past step 2, and step 4 left exactly one non-blank id in it.
  if (chosen.client_id === null || Number(chosen.client_id) !== clientId) return fail('foreign_lead');
  const [sharedCustomerId] = customerIds;
  if (blank(chosen.customer_id) || String(chosen.customer_id) !== sharedCustomerId) {
    return fail('customer_mismatch');
  }
  if (!chosen.fresh) return fail('lead_too_old');

  return {
    ok: true,
    clientId,
    leadId: chosen.id,
    negotiationId: chosen.negotiation_id,
    phone,
  };
}

module.exports = { resolveGvTarget };
