// Voids a proposal's client signature inside the caller's transaction (audit ESIG-02, ESIG-14):
// clears the client_signature_* columns, the signed total and the signed snapshot, puts a
// signable row back to 'sent' when asked, and writes a signature_voided activity row carrying
// the prior record (name, time, method, version, IP, signed total, signed snapshot). The rule
// the editor PATCH (crud.js) and the cancel-line writer (lineItemCancel.js) share is
// voidSignatureIfTermsMoved: a signature never stands against terms admin changed afterward,
// unless money sits on the row or is still settling; the status route (lifecycle.js) keys on
// the transition out of archived and uses the same money guard (rowHoldsMoney).
//
// Why money keeps a signature: a paid booking's edits go through the additional-services flow
// and its signed snapshot keeps the record; a debit still in flight or a card confirmation that
// may be landing (paymentInFlight.js, the one definition of each) credits the row at
// payment_intent.succeeded, so clearing the signature meanwhile would leave a paid row the
// client can never sign again; and a retainer a cancelled booking kept (money law 1) rests on
// the signature it was forfeited under.
//
// The caller holds the row FOR UPDATE and passes its transaction client (one pooled connection
// per request); everything here reads and writes through that client only. The pure decision
// (which terms moved) lives in patchGuards.js signatureVoidReason.

'use strict';

const { signatureVoidReason } = require('./patchGuards');
const { findInFlightPayments, findPendingPayments } = require('../../utils/paymentInFlight');

// The statuses a restore out of archived may land on that still precede money.
const PRE_PAYMENT_STATUSES = ['draft', 'sent', 'viewed', 'modified', 'accepted'];

/**
 * True when the row holds money or a payment may be landing on it:
 * amount_paid or external_paid above zero, a processing bank debit
 * (findInFlightPayments), or a pending card session inside the sign email's
 * window (findPendingPayments: the seconds before payment_intent.succeeded,
 * or a 3DS challenge), both read on the caller's client. A pending session
 * older than the window is a stale intent and keeps nothing. The row is the
 * one read under the caller's lock.
 */
async function rowHoldsMoney(db, row, proposalId) {
  if (Number(row.amount_paid || 0) > 0 || Number(row.external_paid || 0) > 0) return true;
  const inFlight = await findInFlightPayments(proposalId, db);
  if (inFlight.length > 0) return true;
  const pending = await findPendingPayments(proposalId, db);
  return pending.length > 0;
}

/**
 * The editor PATCH's and the cancel-line writer's rule in one call: when the
 * locked row is signed and its priced terms, acknowledged total or venue
 * moved (signatureVoidReason, pure) and no money sits on the row or in flight
 * (rowHoldsMoney), void it and send a signable row back to 'sent'; otherwise
 * leave the signature exactly as it is. The in-flight read runs only once a
 * reason exists, so a save that moves nothing costs no query.
 *
 * @param {import('pg').PoolClient} db  the caller's transaction client
 * @param {object} args
 * @param {number|string} args.proposalId
 * @param {object} args.old  the row as read under the lock, before the save's writes
 * @param {object} args.snapshot  the engine snapshot the save is writing
 * @param {object} [args.body]  the request body, for the venue compare (PATCH); omit for a cancel
 * @param {number|null} args.actorId
 * @param {string} [args.reason]  the caller's own word for the audit row ('line_item_cancelled')
 * @returns {Promise<{ voided: boolean, row: object|null, kept?: 'money' }>}
 */
async function voidSignatureIfTermsMoved(db, { proposalId, old, snapshot, body = {}, actorId, reason: callerReason = null }) {
  const moved = signatureVoidReason({ old, snapshot, body });
  if (!moved) return { voided: false, row: null };
  if (await rowHoldsMoney(db, old, proposalId)) return { voided: false, row: null, kept: 'money' };
  const reason = callerReason ? [...moved, callerReason] : moved;
  return voidClientSignature(db, { proposalId, row: old, actorId, reason, resetStatus: true });
}

/**
 * @param {import('pg').PoolClient} db  the caller's transaction client
 * @param {object} args
 * @param {number} args.proposalId  the locked row's id
 * @param {object} args.row  the row as read under the lock, before this write (the prior record)
 * @param {number|null} args.actorId  the admin whose action voided it
 * @param {string[]|string} args.reason  the moved terms, or the transition ('archived -> draft')
 * @param {boolean} [args.resetStatus=false]  send an accepted/viewed/modified row back to 'sent'
 *   so the public page shows Sign & Pay again; the status route sets its own status and passes false
 * @returns {Promise<{ voided: boolean, row: object|null }>}  the row after the write, or
 *   voided:false when it carried no signature
 */
async function voidClientSignature(db, { proposalId, row, actorId, reason, resetStatus = false }) {
  const upd = await db.query(
    `UPDATE proposals SET
       client_signed_name = NULL,
       client_signature_data = NULL,
       client_signed_at = NULL,
       client_signature_method = NULL,
       client_signature_ip = NULL,
       client_signature_user_agent = NULL,
       client_signature_document_version = NULL,
       client_signed_total = NULL,
       client_signed_snapshot = NULL,
       -- The sign stamps accepted_at and client_signed_at in one statement, so
       -- an equal pair is the sign's own stamp and goes with the signature; an
       -- admin's earlier acceptance stamp (PATCH /:id/status) stays.
       accepted_at = CASE WHEN accepted_at = client_signed_at THEN NULL ELSE accepted_at END,
       status = CASE WHEN $2::boolean AND status IN ('accepted', 'viewed', 'modified') THEN 'sent' ELSE status END
     WHERE id = $1 AND client_signed_at IS NOT NULL
     RETURNING *`,
    [proposalId, resetStatus === true]
  );
  if (!upd.rows[0]) return { voided: false, row: null };
  await db.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
     VALUES ($1, 'signature_voided', 'admin', $2, $3)`,
    [proposalId, actorId ?? null, JSON.stringify({
      reason,
      from_status: row ? row.status : null,
      to_status: upd.rows[0].status,
      previous: {
        signed_name: row ? row.client_signed_name : null,
        signed_at: row ? row.client_signed_at : null,
        signature_method: row ? row.client_signature_method : null,
        document_version: row ? row.client_signature_document_version : null,
        signature_ip: row ? row.client_signature_ip : null,
        signed_total: row ? row.client_signed_total : null,
        signed_snapshot: row ? row.client_signed_snapshot : null,
      },
    })]
  );
  return { voided: true, row: upd.rows[0] };
}

module.exports = { voidClientSignature, voidSignatureIfTermsMoved, rowHoldsMoney, PRE_PAYMENT_STATUSES };

