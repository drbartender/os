'use strict';

// GV post suppression (spec docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md,
// law 8; plan Task 3). A GV post needs everything today's proposal text needs
// (shouldSendImmediate: not archived, SMS not switched off, phone not bad),
// then no active per-number opt-out, then a proposal still in a sendable
// status. The router checks it at enqueue, the lease again before the box
// posts, and the fallback once more before the toll-free text.
//
// Never imports proposalResend.js: that module imports the router (queue.js),
// which imports this one, and the cycle would load its RESENDABLE as undefined.
// GV_SENDABLE_STATUSES (rules.js) carries the same values, pinned by a test.

const { pool } = require('../../db');
const { shouldSendImmediate } = require('../messageSuppression');
const { activeOptOut } = require('../smsOptOut');
const { GV_SENDABLE_STATUSES } = require('./rules');

/**
 * The proposal and its client in one read, in the shape gvSuppression takes.
 * The router and the lease receive only ids. null when the proposal is gone;
 * client is null when the proposal has none.
 *
 * @param {number} proposalId
 * @param {Object} [db] pg pool or client
 * @returns {Promise<null | {proposal:{id:number, status:string, token:string},
 *   client:null|{id:number, phone:string|null, communication_preferences:Object,
 *   email_status:string, phone_status:string}}>}
 */
async function loadGvContext(proposalId, db = pool) {
  const { rows } = await db.query(
    `SELECT p.id, p.status, p.token,
            c.id AS client_id, c.phone, c.communication_preferences, c.email_status, c.phone_status
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    proposal: { id: r.id, status: r.status, token: r.token },
    client: r.client_id === null ? null : {
      id: r.client_id,
      phone: r.phone,
      communication_preferences: r.communication_preferences,
      email_status: r.email_status,
      phone_status: r.phone_status,
    },
  };
}

/**
 * Law 8, in order: shouldSendImmediate (archived, channel_disabled,
 * bad_contact), then the number's active opt-out (opted_out), then the
 * proposal status (not_sendable).
 *
 * @param {Object} args
 * @param {{id:number, status:string}} args.proposal
 * @param {Object|null} args.client - communication_preferences, email_status, phone_status
 * @param {string} [args.phone] - the number that would be texted; defaults to the client's
 * @param {Object} [db] pg pool or client
 * @returns {Promise<{ok:true} | {ok:false, reason:'archived'|'channel_disabled'|'bad_contact'|'opted_out'|'not_sendable'}>}
 */
async function gvSuppression({ proposal, client, phone }, db = pool) {
  const check = await shouldSendImmediate({
    proposal: { id: proposal.id, status: proposal.status },
    client: client ? {
      communication_preferences: client.communication_preferences,
      email_status: client.email_status,
      phone_status: client.phone_status,
    } : null,
    channel: 'sms',
  });
  if (!check.ok) return { ok: false, reason: check.reason };
  const number = phone || (client && client.phone);
  if (number && await activeOptOut(number, db)) return { ok: false, reason: 'opted_out' };
  if (!GV_SENDABLE_STATUSES.includes(proposal.status)) return { ok: false, reason: 'not_sendable' };
  return { ok: true };
}

module.exports = { loadGvContext, gvSuppression };
