/**
 * cc-import payroll guards.
 *
 * Legacy CC imports create stub users (cc_id = 'legacy_cc:<scope>:<id>') for
 * historical bartenders we cannot pay through the modern payouts system. Money-
 * path code (accrual, late-tip rollforward, clawbacks) must skip those rows so
 * we never INSERT into payouts / payout_events for a stub. The two helpers
 * below are the canonical check — call from payroll util tops, BEFORE any
 * write. See specs/2026-05-25-checkcherry-import-design.md.
 */
const { pool } = require('../db');

/**
 * Per-proposal: returns true when ANY approved participant on a shift of the
 * given proposal is a legacy CC stub. Used by accruePayoutsForProposal to
 * skip accrual on cc-imported events. Guards against partial writes — if even
 * one bartender on the event is a stub, the whole accrual is skipped.
 */
async function isLegacyCcParticipant(proposalId, client = pool) {
  // Coerce defensively so a caller that passes req.params.id (a string)
  // doesn't silently bypass the guard. SERIAL ids are always >= 1, so 0
  // and negatives are not valid proposal ids and short-circuit cheaply.
  const n = Number(proposalId);
  if (!Number.isInteger(n) || n <= 0) return false;
  const r = await client.query(
    `SELECT 1 FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       JOIN users u  ON u.id = sr.user_id
      WHERE s.proposal_id = $1
        AND sr.status = 'approved'
        AND u.cc_id LIKE 'legacy_cc:%'
      LIMIT 1`,
    [n]
  );
  return r.rowCount > 0;
}

/**
 * Per-user: returns true when the user is a legacy CC stub. Used by
 * rollForwardLateTip and clawbackTip via tips.target_user_id to skip
 * payroll work for tips paid to imported-stub bartenders.
 */
async function isLegacyCcStubUser(userId, client = pool) {
  // See isLegacyCcParticipant — same defensive coerce for string callers.
  const n = Number(userId);
  if (!Number.isInteger(n) || n <= 0) return false;
  const r = await client.query(
    `SELECT 1 FROM users WHERE id = $1 AND cc_id LIKE 'legacy_cc:%' LIMIT 1`,
    [n]
  );
  return r.rowCount > 0;
}

module.exports = { isLegacyCcParticipant, isLegacyCcStubUser };
