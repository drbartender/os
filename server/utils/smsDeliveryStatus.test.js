require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { markPhoneStatusFromSmsResult } = require('./smsDeliveryStatus');

let testClientId;

before(async () => {
  const existing = await pool.query(
    "SELECT id FROM clients WHERE email = 'sms-delivery-test@example.com' LIMIT 1"
  );
  if (existing.rowCount > 0) {
    testClientId = existing.rows[0].id;
  } else {
    const c = await pool.query(
      `INSERT INTO clients (name, email, phone) VALUES ('SMS Delivery Test', 'sms-delivery-test@example.com', '5555550199')
       RETURNING id`
    );
    testClientId = c.rows[0].id;
  }
  await pool.query("UPDATE clients SET phone_status = 'ok' WHERE id = $1", [testClientId]);
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [testClientId]);
  await pool.end();
});

test('markPhoneStatusFromSmsResult > flips phone_status to bad on a failed delivery', async () => {
  const changed = await markPhoneStatusFromSmsResult({ clientId: testClientId, deliveryStatus: 'failed' });
  assert.strictEqual(changed, true);
  const { rows } = await pool.query('SELECT phone_status FROM clients WHERE id = $1', [testClientId]);
  assert.strictEqual(rows[0].phone_status, 'bad');
});

test('markPhoneStatusFromSmsResult > flips phone_status to bad on undelivered', async () => {
  await pool.query("UPDATE clients SET phone_status = 'ok' WHERE id = $1", [testClientId]);
  const changed = await markPhoneStatusFromSmsResult({ clientId: testClientId, deliveryStatus: 'undelivered' });
  assert.strictEqual(changed, true);
  const { rows } = await pool.query('SELECT phone_status FROM clients WHERE id = $1', [testClientId]);
  assert.strictEqual(rows[0].phone_status, 'bad');
});

test('markPhoneStatusFromSmsResult > leaves phone_status ok on a delivered status', async () => {
  await pool.query("UPDATE clients SET phone_status = 'ok' WHERE id = $1", [testClientId]);
  const changed = await markPhoneStatusFromSmsResult({ clientId: testClientId, deliveryStatus: 'delivered' });
  assert.strictEqual(changed, false);
  const { rows } = await pool.query('SELECT phone_status FROM clients WHERE id = $1', [testClientId]);
  assert.strictEqual(rows[0].phone_status, 'ok');
});

test('markPhoneStatusFromSmsResult > no-ops on a null clientId', async () => {
  const changed = await markPhoneStatusFromSmsResult({ clientId: null, deliveryStatus: 'failed' });
  assert.strictEqual(changed, false);
});
