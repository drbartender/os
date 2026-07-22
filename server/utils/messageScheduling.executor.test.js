require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('messageScheduling.executor.test.js refuses to run against production');
}
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { scheduleMessage } = require('./messageScheduling');

// Regression for the 2026-07-21 reschedule self-deadlock. scheduleMessage ran
// its INSERT on the bare pool even when the caller sat mid-transaction on a
// held client (PATCH /proposals/:id -> schedulePreEventReminders ->
// scheduleDrinkPlanNudge). The second connection blocked on the caller's own
// uncommitted scheduled_messages tuples forever, while the caller held the
// proposal row lock: app-level deadlock Postgres cannot detect. The fix
// threads an optional executor; these tests pin both halves of the contract.

const CLIENT_ID = 999999901; // sentinel ids, cleaned up below
const ENTITY_ID = 999999902;

after(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE entity_id = $1', [ENTITY_ID]);
  await pool.end();
});

test('scheduleMessage routes through a supplied executor (never the bare pool)', async () => {
  const calls = [];
  const fakeExecutor = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [{ id: 1, status: 'pending' }] };
    },
  };
  const row = await scheduleMessage({
    entityType: 'proposal', entityId: ENTITY_ID,
    messageType: 'executor_seam_probe', recipientType: 'client', recipientId: CLIENT_ID,
    channel: 'email', scheduledFor: new Date('2099-01-01T00:00:00Z'),
  }, fakeExecutor);
  assert.equal(calls.length, 1, 'exactly one query, on the fake executor');
  assert.match(calls[0].sql, /INSERT INTO scheduled_messages/);
  assert.deepEqual(row, { id: 1, status: 'pending' });
});

test('inside a transaction, the insert joins the caller transaction (invisible outside until COMMIT, no self-block)', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await scheduleMessage({
      entityType: 'proposal', entityId: ENTITY_ID,
      messageType: 'executor_tx_probe', recipientType: 'client', recipientId: CLIENT_ID,
      channel: 'email', scheduledFor: new Date('2099-01-01T00:00:00Z'),
    }, client);
    assert.ok(row && row.id, 'insert returned a row inside the transaction');

    // Pre-fix, a second scheduleMessage on the SAME tuple from inside this
    // transaction went to the bare pool and hung on our uncommitted tuple.
    // Post-fix it joins the transaction and resolves instantly as a no-op.
    const dup = await Promise.race([
      scheduleMessage({
        entityType: 'proposal', entityId: ENTITY_ID,
        messageType: 'executor_tx_probe', recipientType: 'client', recipientId: CLIENT_ID,
        channel: 'email', scheduledFor: new Date('2099-01-01T00:00:00Z'),
      }, client),
      new Promise((_, rej) => setTimeout(() => rej(new Error('deadlock: duplicate insert hung')), 5000)),
    ]);
    assert.equal(dup, null, 'idempotent duplicate resolves null inside the tx');

    // Not visible from a second connection while uncommitted.
    const outside = await pool.query(
      "SELECT id FROM scheduled_messages WHERE entity_id = $1 AND message_type = 'executor_tx_probe'",
      [ENTITY_ID]
    );
    assert.equal(outside.rowCount, 0, 'row invisible outside the open transaction');
    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

test('without an executor, defaults to the pool (existing callers unchanged)', async () => {
  const row = await scheduleMessage({
    entityType: 'proposal', entityId: ENTITY_ID,
    messageType: 'executor_default_probe', recipientType: 'client', recipientId: CLIENT_ID,
    channel: 'email', scheduledFor: new Date('2099-01-01T00:00:00Z'),
  });
  assert.ok(row && row.id, 'pool-path insert works');
  const dup = await scheduleMessage({
    entityType: 'proposal', entityId: ENTITY_ID,
    messageType: 'executor_default_probe', recipientType: 'client', recipientId: CLIENT_ID,
    channel: 'email', scheduledFor: new Date('2099-01-01T00:00:00Z'),
  });
  assert.equal(dup, null, 'pending-tuple idempotency preserved');
});
