'use strict';

// shiftReap — soft-cancel a proposal's linked shifts and reap their staffing
// side effects inside the caller's transaction. Extracted verbatim from the P6
// cancel flow (routes/proposals/cancel.js step 2) so BOTH the cancel endpoint
// AND the admin archive endpoint reap shifts through one code path, and the two
// kill switches can never drift. The file is deliberately NOT named
// *Handlers.js / *Scheduler.js (those globs are sensitive-listed).
//
// Behavior per non-cancelled shift (identical to the inline cancel flow, plus the
// B14 TRIM alignment noted below):
//   1. capture the approved user_ids (for staff notifications) and the approved
//      BARTENDER user_ids PRE-denial (for the tip clawback, whose own
//      approved-query would find nobody once these rows flip to 'denied');
//   2. soft-cancel the shift (status='cancelled' — hides it from the open-shift
//      feeds, which filter status='open'; never hard-DELETE: payroll joins + the
//      shift history depend on the row surviving);
//   3. deny every non-denied shift_request;
//   4. suppress pending shift-level 'shift_reminder' / 'staff_thank_you' comms;
//   5. suppress BEO nudges for the affected staffers.
//
// The bartender capture compares LOWER(TRIM(position)) so it agrees with the
// accrual (payrollAccrual isBartender) and clawback (payrollClawback) matchers.
// The shift_requests_position_canonical CHECK already rejects whitespace-padded
// positions, so TRIM is defense-in-depth / P3 idiom alignment (identity on clean
// data), never a behavioral change.

const { suppressBeoNudgesForStaffers } = require('./beoHandlers');

/**
 * @param {number|string} proposalId
 * @param {import('pg').PoolClient} dbClient  the caller's transaction connection
 * @param {string} errorMessage               scheduled_messages.error_message / BEO reason
 * @returns {Promise<Array<{shiftId:number, userIds:number[], bartenderUserIds:number[]}>>}
 *          one entry per reaped (non-cancelled) shift.
 */
async function reapShiftsForProposal(proposalId, dbClient, errorMessage) {
  const reaped = [];
  const shifts = await dbClient.query(
    `SELECT id FROM shifts WHERE proposal_id = $1 AND status <> 'cancelled'`,
    [proposalId]
  );
  for (const s of shifts.rows) {
    const approved = await dbClient.query(
      "SELECT user_id FROM shift_requests WHERE shift_id = $1 AND status = 'approved'",
      [s.id]
    );
    const userIds = approved.rows.map((r) => r.user_id);
    // Capture the approved BARTENDERS before we deny the requests, so the
    // post-commit tip clawback charges the right people.
    const bt = await dbClient.query(
      `SELECT user_id FROM shift_requests
        WHERE shift_id = $1 AND status = 'approved' AND dropped_at IS NULL
          AND LOWER(TRIM(position)) = 'bartender'`,
      [s.id]
    );
    const bartenderUserIds = bt.rows.map((r) => r.user_id);
    await dbClient.query("UPDATE shifts SET status = 'cancelled' WHERE id = $1", [s.id]);
    await dbClient.query(
      "UPDATE shift_requests SET status = 'denied' WHERE shift_id = $1 AND status != 'denied'",
      [s.id]
    );
    await dbClient.query(
      `UPDATE scheduled_messages SET status = 'suppressed', error_message = $2
        WHERE entity_type = 'shift' AND entity_id = $1
          AND message_type IN ('shift_reminder', 'staff_thank_you')
          AND status = 'pending'`,
      [s.id, errorMessage]
    );
    if (userIds.length) {
      await suppressBeoNudgesForStaffers(proposalId, userIds, dbClient, errorMessage);
    }
    reaped.push({ shiftId: s.id, userIds, bartenderUserIds });
  }
  return reaped;
}

module.exports = { reapShiftsForProposal };
