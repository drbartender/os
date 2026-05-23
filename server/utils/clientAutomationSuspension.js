const { pool } = require('../db');

/**
 * Suspend all remaining automation for a client whose every contact channel
 * has failed (spec 7.5 "both bad"). Flips every pending and deferred
 * scheduled_messages row for the client to 'suppressed'. Sent / failed rows
 * are left as-is. Idempotent, re-running on an already-suspended client
 * suppresses zero further rows.
 *
 * @param {number} clientId
 * @returns {Promise<number>} count of rows suppressed.
 */
async function suspendClientAutomation(clientId) {
  if (!clientId || !Number.isInteger(Number(clientId))) return 0;
  const result = await pool.query(
    `UPDATE scheduled_messages
        SET status = 'suppressed',
            error_message = 'suspended: no working contact channel for client (spec 7.5)'
      WHERE recipient_type = 'client'
        AND recipient_id = $1
        AND status IN ('pending', 'deferred')`,
    [Number(clientId)]
  );
  return result.rowCount;
}

module.exports = { suspendClientAutomation };
