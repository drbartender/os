const { pool } = require('../db');

// Twilio final delivery states that mean the message did not reach the handset.
// 'failed' = Twilio could not send (carrier rejection, invalid number).
// 'undelivered' = carrier accepted then could not deliver.
const FAILED_DELIVERY_STATES = new Set(['failed', 'undelivered']);

/**
 * Flip clients.phone_status to 'bad' when an SMS delivery failed.
 *
 * Delivery-failure fallback, spec 7.5. Callers: a Twilio status-callback route,
 * or sendAndLogSms's failure path. Pure-ish, single parameterized UPDATE, no
 * external I/O beyond the DB.
 *
 * @param {Object} args
 * @param {number|null} args.clientId clients.id the SMS was addressed to, or
 *   null when the SMS had no associated client (staff/admin SMS), then no-op.
 * @param {string} args.deliveryStatus the Twilio delivery status string.
 * @returns {Promise<boolean>} true when a row was flipped to 'bad'.
 */
async function markPhoneStatusFromSmsResult({ clientId, deliveryStatus }) {
  if (!clientId || !Number.isInteger(Number(clientId))) return false;
  const status = String(deliveryStatus || '').toLowerCase();
  if (!FAILED_DELIVERY_STATES.has(status)) return false;

  const result = await pool.query(
    `UPDATE clients SET phone_status = 'bad'
      WHERE id = $1 AND phone_status <> 'bad'`,
    [Number(clientId)]
  );
  return result.rowCount > 0;
}

module.exports = { markPhoneStatusFromSmsResult, FAILED_DELIVERY_STATES };
