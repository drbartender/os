require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { scheduleBalanceReminders } = require('./balanceReminderScheduling');

if (process.env.NODE_ENV === 'production') {
  throw new Error('balanceReminderScheduling.test.js refuses to run against production');
}

let clientId, summerPropId, winterPropId;

before(async () => {
  const cl = await pool.query(
    `INSERT INTO clients (name, email, email_status) VALUES ($1, $2, 'ok') RETURNING id`,
    ['Balance Reminder TZ Client', `bal-reminder-tz-${Date.now()}@example.com`]
  );
  clientId = cl.rows[0].id;

  // Non-autopay so the full 7-row ladder schedules. Balance outstanding (2500 > 0)
  // and due date in the future so nothing is skipped.
  const summer = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid,
                            balance_due_date, autopay_enrolled, event_timezone)
     VALUES ($1, '2026-07-20', 'deposit_paid', 'wedding', '6:00 PM', 4, 3000, 500,
             '2026-07-15', false, 'America/Chicago')
     RETURNING id`,
    [clientId]
  );
  summerPropId = summer.rows[0].id;

  const winter = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid,
                            balance_due_date, autopay_enrolled, event_timezone)
     VALUES ($1, '2027-01-20', 'deposit_paid', 'wedding', '6:00 PM', 4, 3000, 500,
             '2027-01-15', false, 'America/Chicago')
     RETURNING id`,
    [clientId]
  );
  winterPropId = winter.rows[0].id;
});

after(async () => {
  for (const id of [summerPropId, winterPropId]) {
    if (id) await pool.query(`DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1`, [id]);
    if (id) await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

async function scheduledFor(proposalId, messageType) {
  const { rows } = await pool.query(
    `SELECT scheduled_for FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1 AND message_type = $2`,
    [proposalId, messageType]
  );
  assert.equal(rows.length, 1, `exactly one ${messageType} row for proposal ${proposalId}`);
  return rows[0].scheduled_for.toISOString();
}

test('scheduleBalanceReminders > summer (CDT) anchors each reminder to 10:00am Chicago = 15:00Z', async () => {
  await scheduleBalanceReminders(summerPropId);
  // balance_due_date 2026-07-15 is CDT (UTC-5); 10:00am local = 15:00Z.
  assert.equal(await scheduledFor(summerPropId, 'balance_due_today'), '2026-07-15T15:00:00.000Z');
  // t-3 -> 2026-07-12, t+1 -> 2026-07-16, t+3 -> 2026-07-18, all at 9am CDT.
  assert.equal(await scheduledFor(summerPropId, 'balance_reminder_non_autopay_t3'), '2026-07-12T15:00:00.000Z');
  assert.equal(await scheduledFor(summerPropId, 'balance_late_t1'), '2026-07-16T15:00:00.000Z');
  assert.equal(await scheduledFor(summerPropId, 'balance_late_t3'), '2026-07-18T15:00:00.000Z');
  // SMS halves share the same instants.
  assert.equal(await scheduledFor(summerPropId, 'balance_due_today_sms'), '2026-07-15T15:00:00.000Z');
});

test('scheduleBalanceReminders > winter (CST) anchors 10:00am Chicago = 16:00Z (DST-aware)', async () => {
  await scheduleBalanceReminders(winterPropId);
  // balance_due_date 2027-01-15 is CST (UTC-6); 10:00am local = 16:00Z.
  assert.equal(await scheduledFor(winterPropId, 'balance_due_today'), '2027-01-15T16:00:00.000Z');
  assert.equal(await scheduledFor(winterPropId, 'balance_reminder_non_autopay_t3'), '2027-01-12T16:00:00.000Z');
  assert.equal(await scheduledFor(winterPropId, 'balance_late_t1'), '2027-01-16T16:00:00.000Z');
});
