const { pool } = require('../db');

const RETENTION_DAYS = 30;
// Chunked DELETE bounds lock-hold time and WAL growth. After a long quiet
// period (first-run, paused scheduler), an unbounded DELETE could lock every
// row at once and stack against autovacuum. With hourly cadence and steady
// Cal.com traffic, 5000 covers a typical batch comfortably.
const PRUNE_BATCH_SIZE = 5000;

async function pruneOldWebhookEvents() {
  let totalDeleted = 0;
  let batch;
  do {
    const result = await pool.query(
      `DELETE FROM webhook_events
       WHERE ctid IN (
         SELECT ctid FROM webhook_events
         WHERE received_at < NOW() - ($1 || ' days')::INTERVAL
         LIMIT $2
       )`,
      [String(RETENTION_DAYS), PRUNE_BATCH_SIZE]
    );
    batch = result.rowCount;
    totalDeleted += batch;
    // Yield between full batches so live webhook traffic can acquire pool
    // slots during a long-quiet-period recovery (paused scheduler leaving
    // millions of rows aged-out at once). Skip the yield on the terminal
    // partial batch.
    if (batch === PRUNE_BATCH_SIZE) {
      await new Promise((r) => setTimeout(r, 50));
    }
  } while (batch === PRUNE_BATCH_SIZE);
  return totalDeleted;
}

module.exports = { pruneOldWebhookEvents, RETENTION_DAYS, PRUNE_BATCH_SIZE };
