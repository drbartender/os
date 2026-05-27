const { pool } = require('../db');

const RETENTION_DAYS = 30;

async function pruneOldWebhookEvents() {
  const result = await pool.query(
    `DELETE FROM webhook_events WHERE received_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`
  );
  return result.rowCount;
}

module.exports = { pruneOldWebhookEvents, RETENTION_DAYS };
