require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { mergeClients } = require('./clientMerge');

// Each test runs inside BEGIN/ROLLBACK, so nothing it writes is committed.

test('mergeClients repoints FK references, backfills the winner, and deletes the loser', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const loser = (await db.query(
      `INSERT INTO clients (name, phone, source) VALUES ('Merge Loser', '5550104040', 'thumbtack') RETURNING id`
    )).rows[0].id;
    const winner = (await db.query(
      `INSERT INTO clients (name, email, source) VALUES ('Merge Winner', 'mergewinner@example.com', 'direct') RETURNING id`
    )).rows[0].id;
    // A proposal referencing the loser (client_id is the FK; all other columns default).
    const propId = (await db.query(
      `INSERT INTO proposals (client_id) VALUES ($1) RETURNING id`, [loser]
    )).rows[0].id;

    const { repointed } = await mergeClients(db, loser, winner);

    const prop = await db.query('SELECT client_id FROM proposals WHERE id = $1', [propId]);
    assert.strictEqual(prop.rows[0].client_id, winner, 'proposal repointed to the winner');

    const gone = await db.query('SELECT id FROM clients WHERE id = $1', [loser]);
    assert.strictEqual(gone.rows.length, 0, 'loser client deleted');

    const w = await db.query('SELECT phone FROM clients WHERE id = $1', [winner]);
    assert.strictEqual(w.rows[0].phone, '5550104040', 'winner backfilled phone from the loser');

    assert.ok(repointed.some(r => r.table === 'proposals' && r.rows === 1), 'repointed report includes the proposals row');
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});

test('mergeClients refuses to merge a client into itself', async () => {
  const db = await pool.connect();
  try {
    await assert.rejects(() => mergeClients(db, 5, 5), /loser === winner/);
  } finally {
    db.release();
  }
});

after(async () => {
  await pool.end();
});
