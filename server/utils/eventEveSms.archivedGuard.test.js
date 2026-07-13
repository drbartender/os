require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// P6.5: the event-eve SMS must not fire for, nor be scheduled on, an archived
// (cancelled) proposal. Both guards already live in eventEveSms.js; this pins them.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { scheduleEventEve, handleEventEve } = require('./eventEveSms');

if (process.env.NODE_ENV === 'production') {
  throw new Error('eventEveSms.archivedGuard.test.js refuses to run against production');
}

const MARK = `eveguard-${Date.now()}`;
let clientId, archivedId;

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('Eve Guard', $1, '+13125550142') RETURNING id`,
    [`eveguard-${MARK}@example.com`]
  );
  clientId = c.rows[0].id;
  // Archived proposal with a future event date/time (would otherwise schedule an
  // event-eve row ~24h before start).
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, archive_reason, event_type, event_timezone,
                            event_date, event_start_time)
     VALUES ($1, 'archived', 'client_cancelled', $2, 'America/Chicago',
             (CURRENT_DATE + INTERVAL '10 days'), '18:00')
     RETURNING id`,
    [clientId, `${MARK}`]
  );
  archivedId = p.rows[0].id;
});

after(async () => {
  if (archivedId) {
    await pool.query(`DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1`, [archivedId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [archivedId]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('scheduleEventEve inserts no row for an archived proposal', async () => {
  await scheduleEventEve(archivedId);
  const { rows } = await pool.query(
    `SELECT id FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1 AND message_type = 'event_eve'`,
    [archivedId]
  );
  assert.equal(rows.length, 0, 'no event_eve scheduled_messages row for an archived proposal');
});

test('handleEventEve refuses to send for an archived proposal', async () => {
  await assert.rejects(
    () => handleEventEve({ entity: { id: archivedId } }),
    /archived/i,
    'handleEventEve must throw for an archived proposal'
  );
});
