// Voids a proposal's client signature inside the caller's transaction (audit ESIG-02, ESIG-14):
// clears the client_signature_* columns, the signed total and the signed snapshot, puts a
// signable unpaid row back to 'sent' when asked, and writes a signature_voided activity row
// carrying the prior record (name, time, method, version, IP, signed total, signed snapshot).
// Called by the editor PATCH (crud.js) when a signed unpaid booking's terms move, and by the
// status route (lifecycle.js) on archived -> draft.
//
// The caller holds the row FOR UPDATE and passes its transaction client (one pooled connection
// per request); this writes through that client only. Nothing here decides whether to void:
// patchGuards.js signatureVoidReason does, and lifecycle.js keys on the transition.

'use strict';

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

module.exports = { voidClientSignature };
