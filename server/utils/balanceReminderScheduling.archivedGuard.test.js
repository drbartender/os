require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// P6.5: scheduleBalanceReminders must skip an archived (cancelled) proposal, so
// a re-schedule can never re-arm a reminder ladder on a cancelled booking.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { scheduleBalanceReminders } = require('./balanceReminderScheduling');

if (process.env.NODE_ENV === 'production') {
  throw new Error('balanceReminderScheduling.archivedGuard.test.js refuses to run against production');
}

const MARK = `remguard-${Date.now()}`;
let clientId, archivedId;

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Reminder Guard', $1) RETURNING id`,
    [`remguard-${MARK}@example.com`]
  );
  clientId = c.rows[0].id;
  // Archived proposal with an outstanding balance and a future balance_due_date —
  // every non-status precondition for scheduling reminders is satisfied.
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, archive_reason, event_type, event_timezone,
                            total_price, amount_paid, balance_due_date, autopay_enrolled)
     VALUES ($1, 'archived', 'client_cancelled', $2, 'America/Chicago',
             1000, 100, (CURRENT_DATE + INTERVAL '20 days'), false)
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

test('scheduleBalanceReminders schedules nothing for an archived proposal', async () => {
  await scheduleBalanceReminders(archivedId);
  const { rows } = await pool.query(
    `SELECT id FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1
        AND message_type LIKE 'balance_%'`,
    [archivedId]
  );
  assert.equal(rows.length, 0, 'no balance-reminder rows for an archived proposal');
});
