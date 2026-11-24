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
// and its signed snapshot keeps the record; and a retainer a cancelled booking kept (money law 1)
// rests on the signature it was forfeited under. A booking paid once and refunded in full holds
// no money (the refund demotes it to 'accepted' with amount_paid 0, which law 13 keeps out of the
// stale sweep), so its signature is voided like any money-free row, but its status is left as it
// is: an edit never sends it back to 'sent' and into the sweep, and an unsigned 'accepted' row is
// signable (ESIG-14). The restore out of archived voids it too, the status it sets standing.
//
// A payment that is still landing is a different case (dev-box review 2026-11-22, money M1 and
// M2, concurrency M1): voiding then would leave a paid row the client can never sign again, and
// keeping the signature would let it stand over changed terms if the debit later fails. So a
// terms-moving edit on a signed, money-free row first reads the row's live intents from Stripe
// (the public switch's read, decide, cancel order, publicSwitch.js): a processing row, or an
// intent processing, succeeded or waiting on microdeposits, refuses the edit with 409
// PAYMENT_IN_FLIGHT until it lands or fails; a Stripe read it cannot make refuses too (fail
// closed); every other live intent (a minted, declined or 3DS-pending one an open tab could still
// confirm) is cancelled before the void writes, so no page can pay the old terms onto an unsigned
// row. A cancel-line preview decides and never cancels. The restore out of archived keeps the
// signature instead of refusing (moneyOnRow's hold, below).
//
// The caller holds the row FOR UPDATE and passes its transaction client (one pooled connection
// per request); everything here reads and writes through that client only. The pure decision
// (which terms moved) lives in patchGuards.js signatureVoidReason.

'use strict';

const { signatureVoidReason } = require('./patchGuards');
const { STRIPE_RETRIEVE_OPTS, IN_FLIGHT_MAX_AGE_DAYS } = require('../../utils/paymentInFlight');
const { ConflictError, ExternalServiceError } = require('../../utils/errors');

// The statuses a restore out of archived may land on that still precede money.
const PRE_PAYMENT_STATUSES = ['draft', 'sent', 'viewed', 'modified', 'accepted'];

const IN_FLIGHT_EDIT_MSG = 'A payment on this booking is still going through, so the client\'s signature cannot be cleared yet. '
  + 'Save this change after the payment lands or fails.';
const STRIPE_UNKNOWN_MSG = 'The payment state of this booking could not be checked. Please try the save again in a moment.';

function isLanding(intent) {
  return !!intent && (intent.status === 'processing' || intent.status === 'succeeded'
    || (intent.status === 'requires_action' && intent.next_action
      && intent.next_action.type === 'verify_with_microdeposits'));
}

/**
 * Whether the row holds money, and what is live at Stripe. Returns
 * { hold, paidBefore, cancelable }: hold is 'paid' (amount_paid or
 * external_paid above zero), 'in_flight' (a processing row inside the
 * in-flight backstop, or an intent processing, succeeded or awaiting
 * microdeposits), 'stripe_unknown' (an intent Stripe could not be asked
 * about) or null; paidBefore is a payment that once succeeded (the row was
 * refunded since); cancelable lists the live intent ids an open page could
 * still confirm. A processing row older than the backstop
 * (IN_FLIGHT_MAX_AGE_DAYS, the lost payment_failed case) is asked about at
 * Stripe like the rest, so it can never lock the row's edits for good.
 * Reads only through the caller's client; Stripe calls carry the checkout
 * rails' timeouts, since the caller holds the row lock.
 */
async function moneyOnRow(db, row, proposalId, { stripe = null } = {}) {
  if (Number(row.amount_paid || 0) > 0 || Number(row.external_paid || 0) > 0) {
    return { hold: 'paid', paidBefore: true, cancelable: [] };
  }
  const paid = await db.query(
    `SELECT 1 FROM proposal_payments WHERE proposal_id = $1 AND status = 'succeeded' LIMIT 1`, [proposalId]
  );
  const paidBefore = !!paid.rows[0];
  const { rows } = await db.query(
    `SELECT stripe_payment_intent_id, status,
            (status = 'processing' AND processing_at > NOW() - make_interval(days => $2::int)) AS settling
       FROM stripe_sessions
      WHERE proposal_id = $1 AND status IN ('pending', 'failed', 'processing')
        AND stripe_payment_intent_id IS NOT NULL`,
    [proposalId, IN_FLIGHT_MAX_AGE_DAYS]
  );
  if (rows.some((r) => r.settling)) return { hold: 'in_flight', paidBefore, cancelable: [] };
  if (!rows.length) return { hold: null, paidBefore, cancelable: [] };
  const client = stripe || require('../../utils/stripeClient').getStripe();
  if (!client) return { hold: 'stripe_unknown', paidBefore, cancelable: [] };
  const intents = [];
  try {
    await Promise.all(rows.map(async (r) => {
      try {
        intents.push(await client.paymentIntents.retrieve(r.stripe_payment_intent_id, STRIPE_RETRIEVE_OPTS));
      } catch (e) {
        if (!(e && (e.code === 'resource_missing' || e.statusCode === 404))) throw e;
      }
    }));
  } catch {
    return { hold: 'stripe_unknown', paidBefore, cancelable: [] };
  }
  if (intents.some(isLanding)) return { hold: 'in_flight', paidBefore, cancelable: [] };
  return { hold: null, paidBefore, cancelable: intents.filter((i) => i.status !== 'canceled').map((i) => i.id) };
}

// Marks the sessions of intents the void cancelled 'canceled', the way
// create-intent marks its own (stripeCreateIntent.js), on the caller's
// client: a later guard reads them from Stripe no more, and a stale pending
// row no longer reads as a payment starting.
async function markSessionsCanceled(db, proposalId, ids) {
  if (!ids.length) return;
  await db.query(
    `UPDATE stripe_sessions SET status = 'canceled'
      WHERE proposal_id = $1 AND stripe_payment_intent_id = ANY($2::text[]) AND status IN ('pending', 'failed')`,
    [proposalId, ids]
  );
}

// Cancels each live intent; true only when every one is cancelled (or was
// already). A cancel Stripe refuses because the intent moved on (a confirm
// that won the race) or any other failure answers false.
async function cancelLiveIntents(ids, { stripe = null } = {}) {
  if (!ids.length) return true;
  const client = stripe || require('../../utils/stripeClient').getStripe();
  if (!client) return false;
  const results = await Promise.all(ids.map(async (id) => {
    try {
      await client.paymentIntents.cancel(id, {}, STRIPE_RETRIEVE_OPTS);
      return true;
    } catch (e) {
      return !!(e && (e.code === 'resource_missing' || e.statusCode === 404));
    }
  }));
  return results.every(Boolean);
}

/** True when the row holds money or a payment is landing (or cannot be read). */
async function rowHoldsMoney(db, row, proposalId, opts) {
  const { hold } = await moneyOnRow(db, row, proposalId, opts);
  return hold !== null;
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
async function voidSignatureIfTermsMoved(db, {
  proposalId, old, snapshot, body = {}, actorId, reason: callerReason = null, preview = false, stripe = null,
}) {
  const moved = signatureVoidReason({ old, snapshot, body });
  if (!moved || !old.client_signed_at) return { voided: false, row: null };
  const money = await moneyOnRow(db, old, proposalId, { stripe });
  if (money.hold === 'paid') return { voided: false, row: null, kept: 'money' };
  if (money.hold === 'in_flight') throw new ConflictError(IN_FLIGHT_EDIT_MSG, 'PAYMENT_IN_FLIGHT');
  if (money.hold === 'stripe_unknown') throw new ExternalServiceError('Stripe', null, STRIPE_UNKNOWN_MSG);
  // A preview runs the same write inside its rolled-back transaction, so it
  // computes what the confirm will; only the Stripe cancel, which no
  // rollback can undo, waits for the confirm.
  if (!preview) {
    if (!(await cancelLiveIntents(money.cancelable, { stripe }))) {
      throw new ConflictError(IN_FLIGHT_EDIT_MSG, 'PAYMENT_IN_FLIGHT');
    }
    await markSessionsCanceled(db, proposalId, money.cancelable);
  }
  const reason = callerReason ? [...moved, callerReason] : moved;
  // A booking paid once and refunded keeps its status (out of the sweep).
  return voidClientSignature(db, {
    proposalId, row: old, actorId, reason, resetStatus: !money.paidBefore,
    cancelledIntents: preview ? [] : money.cancelable,
  });
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
async function voidClientSignature(db, { proposalId, row, actorId, reason, resetStatus = false, cancelledIntents = [] }) {
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
       -- admin's earlier acceptance stamp (PATCH /:id/status) stays. It goes
       -- only when the row ends up short of 'accepted' (this UPDATE sends it
       -- to 'sent', or the restore set a pre-acceptance status first): a row
       -- that stays 'accepted' (a booking refunded in full, voided with no
       -- status move) keeps the date the Money Board counts it by.
       accepted_at = CASE WHEN accepted_at = client_signed_at AND (status <> 'accepted' OR $2::boolean)
                          THEN NULL ELSE accepted_at END,
       -- Every SET reads the row as it was, so accepted_at = client_signed_at
       -- here is the sign's own stamp: only that acceptance goes back to 'sent'.
       status = CASE WHEN $2::boolean AND (status IN ('viewed', 'modified')
                                           OR (status = 'accepted' AND accepted_at = client_signed_at))
                     THEN 'sent' ELSE status END
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
      // The client's live payments this edit cancelled at Stripe (ids only),
      // so the record says why their open page could not pay.
      cancelled_intents: cancelledIntents.length ? cancelledIntents : undefined,
      from_status: row ? row.status : null,
      to_status: upd.rows[0].status,
      previous: {
        signed_name: row ? row.client_signed_name : null,
        signed_at: row ? row.client_signed_at : null,
        signature_method: row ? row.client_signature_method : null,
        document_version: row ? row.client_signature_document_version : null,
        signature_ip: row ? row.client_signature_ip : null,
        signature_user_agent: row ? row.client_signature_user_agent || null : null,
        signed_total: row ? row.client_signed_total : null,
        signed_snapshot: row ? row.client_signed_snapshot : null,
      },
    })]
  );
  return { voided: true, row: upd.rows[0] };
}

module.exports = {
  voidClientSignature, voidSignatureIfTermsMoved, rowHoldsMoney, moneyOnRow, cancelLiveIntents, markSessionsCanceled,
  PRE_PAYMENT_STATUSES,
};

