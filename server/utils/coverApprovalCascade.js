/**
 * Cover-approval cascade (spec §6.5 step 2).
 *
 * Shared between two callers:
 *   1. PUT /api/shifts/requests/:requestId (when the approved request has
 *      `replaced_by_request_id` set — admin approving a teammate's claim via
 *      the normal staffing dashboard).
 *   2. POST /api/admin/cover-swaps/:swapToken (one-click admin email link).
 *
 * Both run the same 5-step cascade inside a transaction:
 *   1. Mark the original request `status='denied'`, `dropped_at=NOW()`,
 *      `drop_reason='covered_by_request:<newId>'`, `cover_requested_at=NULL`.
 *   2. Suppress remaining `cover_broadcast` scheduled_messages for the shift
 *      (other teammates can no longer claim — the slot is filled).
 *   3. Schedule shift-day messages for the NEW staffer
 *      (`scheduleStaffShiftMessages` is idempotent).
 *   4. If the proposal has a finalized drink plan, insert a BEO acknowledge-
 *      nudge for the new staffer at `MAX(eventStartUtc-3d, NOW()+5min)`.
 *   5. Reset shifts.status — the shift remains 'staffed' if no other slot is
 *      open; callers can re-check via the existing assignment count helpers.
 *
 * Mid-cascade failure ROLLS BACK: the original stays active, broadcast rows
 * stay pending so another teammate can still claim. Caller decides whether to
 * surface the rollback as a 500 or to retry.
 *
 * This module is the integration point — it does NOT validate ownership or
 * pay-period state; those are the caller's responsibility.
 */

const Sentry = require('@sentry/node');
const { ConflictError } = require('./errors');
const { scheduleStaffShiftMessages, computeEventStartUtc } = require('./staffShiftHandlers');
const { insertBeoNudgeIfMissing } = require('./beoHandlers');

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Apply the cover-approval cascade. MUST be called from inside an open
 * transaction on `dbClient`; this function only runs the 4 DB-side steps and
 * does NOT BEGIN/COMMIT itself.
 *
 * `scheduleStaffShiftMessages` is called via the pool (idempotent UPSERTs);
 * its failure is logged but never aborts the cascade.
 *
 * @param {{query: Function}} dbClient pg client already inside a transaction
 * @param {number} originalRequestId   the cover-requesting shift_request.id
 * @param {number} newRequestId        the claiming staffer's shift_request.id
 * @returns {Promise<{originalUserId:number, newUserId:number, shiftId:number, beoNudgeScheduled:boolean}>}
 * @throws {ConflictError} on a structural mismatch (missing rows / different shifts)
 */
async function applyCoverCascade(dbClient, originalRequestId, newRequestId) {
  // Pull both rows + shift + proposal context in one round trip. Lock the
  // shift_requests rows so a concurrent admin can't approve the same swap
  // twice (FOR UPDATE on OF sr only — we don't need to lock the proposal).
  const { rows } = await dbClient.query(
    `SELECT sr.id AS request_id,
            sr.user_id,
            sr.shift_id,
            sr.status,
            sr.replaced_by_request_id,
            sr.cover_requested_at,
            s.proposal_id,
            s.event_date,
            p.event_start_time,
            p.event_duration_hours,
            p.event_timezone,
            dp.finalized_at AS drink_plan_finalized_at
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       LEFT JOIN proposals p ON p.id = s.proposal_id
       LEFT JOIN drink_plans dp ON dp.proposal_id = s.proposal_id
      WHERE sr.id = ANY($1::int[])
      FOR UPDATE OF sr`,
    [[originalRequestId, newRequestId]]
  );
  // Structural mismatches MUST throw, never return — the caller runs this
  // inside a transaction that has already flipped the new request to
  // 'approved'. A silent null-shape return would let that COMMIT, leaving the
  // new staffer approved while the original stays active = double-coverage.
  // Throwing rolls the whole cascade back.
  const original = rows.find((r) => r.request_id === originalRequestId);
  const neu = rows.find((r) => r.request_id === newRequestId);
  if (rows.length < 2 || !original || !neu) {
    throw new ConflictError('Cover swap requests not found.', 'swap_requests_missing');
  }
  if (original.shift_id !== neu.shift_id) {
    throw new ConflictError('Cover swap requests are on different shifts.', 'swap_shift_mismatch');
  }

  const shiftId = original.shift_id;
  const proposalId = original.proposal_id;

  // 1. Original request: deny + mark covered.
  await dbClient.query(
    `UPDATE shift_requests
        SET status = 'denied',
            dropped_at = COALESCE(dropped_at, NOW()),
            drop_reason = $1,
            cover_requested_at = NULL
      WHERE id = $2`,
    [`covered_by_request:${newRequestId}`, originalRequestId]
  );

  // 2. Suppress remaining cover_broadcast rows for this shift.
  await dbClient.query(
    `UPDATE scheduled_messages
        SET status = 'suppressed',
            error_message = 'cover_filled'
      WHERE entity_type = 'shift'
        AND entity_id = $1
        AND message_type = 'cover_broadcast'
        AND status = 'pending'`,
    [shiftId]
  );

  // 3. Shift-day messages for the new staffer. Best-effort; uses the pool
  // (not the transaction client) because the helper relies on its own UPSERTs
  // and may write rows the dispatcher reads, plus an outer transaction would
  // hold its row locks past commit anyway. Failures here log to Sentry but do
  // not unwind the cover swap.
  scheduleStaffShiftMessages(shiftId).catch((err) => {
    Sentry.captureException(err, {
      tags: { feature: 'cover-cascade', step: 'schedule-shift-messages' },
      extra: { shift_id: shiftId, new_user_id: neu.user_id },
    });
    console.error('[coverApprovalCascade] scheduleStaffShiftMessages failed:', err.message);
  });

  // 4. BEO acknowledge-nudge for the new staffer (only if drink plan
  // finalized AND eventStartUtc is in the future).
  let beoNudgeScheduled = false;
  if (proposalId && original.drink_plan_finalized_at && original.event_start_time) {
    const eventStartUtc = computeEventStartUtc({
      event_date: original.event_date,
      event_start_time: original.event_start_time,
      event_duration_hours: original.event_duration_hours,
      event_timezone: original.event_timezone,
    });
    if (eventStartUtc && eventStartUtc.getTime() > Date.now()) {
      const scheduledFor = new Date(Math.max(
        eventStartUtc.getTime() - THREE_DAYS_MS,
        Date.now() + FIVE_MINUTES_MS,
      ));
      await insertBeoNudgeIfMissing(dbClient, {
        proposalId,
        userId: neu.user_id,
        scheduledFor,
      });
      beoNudgeScheduled = true;
    }
  }

  return {
    originalUserId: original.user_id,
    newUserId: neu.user_id,
    shiftId,
    beoNudgeScheduled,
  };
}

/**
 * Convenience wrapper for callers that need the full transaction (approve the
 * new request + run the cascade in one atomic unit). Used by both the PUT
 * approval branch in shifts.js and the cover-swap POST in adminCoverSwaps.js.
 *
 * @param {{connect: Function}} pool pg pool (NOT a transaction client)
 * @param {number} originalRequestId
 * @param {number} newRequestId
 */
async function approveAndCascade(pool, originalRequestId, newRequestId) {
  const dbc = await pool.connect();
  try {
    await dbc.query('BEGIN');
    await dbc.query(
      `UPDATE shift_requests SET status = 'approved', beo_acknowledged_at = NULL WHERE id = $1`,
      [newRequestId]
    );
    const result = await applyCoverCascade(dbc, originalRequestId, newRequestId);
    await dbc.query('COMMIT');
    return result;
  } catch (err) {
    await dbc.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    dbc.release();
  }
}

module.exports = { applyCoverCascade, approveAndCascade };
