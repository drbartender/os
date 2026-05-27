require('dotenv').config({ path: 'C:/Users/dalla/DRB_OS/os/.env' });
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { pruneOldWebhookEvents } = require('./webhookEventsPruneScheduler');

before(async () => {
  await pool.query("DELETE FROM webhook_events WHERE event_id LIKE 'prune-test-%'");
});

after(async () => {
  await pool.query("DELETE FROM webhook_events WHERE event_id LIKE 'prune-test-%'");
  await pool.end();
});

test('pruneOldWebhookEvents: deletes rows older than 30 days, leaves fresh rows', async () => {
  // Insert one old row (35 days ago) and one fresh row (1 hour ago).
  await pool.query(
    `INSERT INTO webhook_events (provider, event_id, received_at) VALUES ('calcom', 'prune-test-old', NOW() - INTERVAL '35 days')`
  );
  await pool.query(
    `INSERT INTO webhook_events (provider, event_id, received_at) VALUES ('calcom', 'prune-test-fresh', NOW() - INTERVAL '1 hour')`
  );

  const deleted = await pruneOldWebhookEvents();
  assert.ok(deleted >= 1, 'at least the old row was pruned');

  const remaining = await pool.query(
    "SELECT event_id FROM webhook_events WHERE event_id LIKE 'prune-test-%'"
  );
  const ids = remaining.rows.map(r => r.event_id);
  assert.ok(ids.includes('prune-test-fresh'), 'fresh row remains');
  assert.ok(!ids.includes('prune-test-old'), 'old row pruned');
});
