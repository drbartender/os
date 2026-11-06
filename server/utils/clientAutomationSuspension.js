// Suspends a client's remaining automation when both email_status and phone_status are 'bad' (sets
// clients.automation_suspended_at, cancels pending scheduled_messages)

const { pool } = require('../db');
// The one legal-hold predicate for scheduled messages. dispatcherDeadLetters.js
// never requires this module, so the require forms no cycle.
const { notHeldMessageSql } = require('./dispatcherDeadLetters');
const { heldProposalIds } = require('./legalHold');

/**
 * Suspend all remaining automation for a client whose every contact channel
 * has failed (spec 7.5 "both bad"). Flips every pending and deferred
 * scheduled_messages row for the client to 'suppressed'. Sent / failed rows
 * are left as-is. Idempotent, re-running on an already-suspended client
 * suppresses zero further rows.
 *
 * Money law 15: a row tied to a legal-hold proposal (it names the proposal,
 * or a shift or consult whose proposal_id is held) is never touched; it stays
 * exactly as it is. A missing list throws before the write.
 *
 * @param {number} clientId
 * @param {number[]} [held] heldProposalIds(), when the caller already read it
 * @returns {Promise<number>} count of rows suppressed.
 */
async function suspendClientAutomation(clientId, held = heldProposalIds()) {
  if (!clientId || !Number.isInteger(Number(clientId))) return 0;
  // static-checks: allow parameterized-sql (notHeldMessageSql is a fixed clause from a table name and a parameter number; the held ids are bound)
  const result = await pool.query(
    `UPDATE scheduled_messages
        SET status = 'suppressed',
            error_message = 'suspended: no working contact channel for client (spec 7.5)'
      WHERE recipient_type = 'client'
        AND recipient_id = $1
        AND status IN ('pending', 'deferred')
        AND ${notHeldMessageSql('scheduled_messages', 2)}`,
    [Number(clientId), held]
  );
  return result.rowCount;
}

module.exports = { suspendClientAutomation };
