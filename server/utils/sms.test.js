require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { sendAndLogSms } = require('./sms');

after(async () => {
  await pool.query("DELETE FROM sms_messages WHERE message_type LIKE 'smstest_%'");
  await pool.end();
});

test('sendAndLogSms > returns skipped and logs nothing when the phone is unparseable', async () => {
  const result = await sendAndLogSms({
    to: 'not-a-phone',
    body: 'hello',
    messageType: 'smstest_skip',
  });
  assert.strictEqual(result.status, 'skipped');
  assert.strictEqual(result.sid, null);
  const { rows } = await pool.query(
    "SELECT count(*) FROM sms_messages WHERE message_type = 'smstest_skip'"
  );
  assert.strictEqual(Number(rows[0].count), 0);
});

test('sendAndLogSms > sends and inserts an outbound row with status sent', async () => {
  // Twilio creds are absent in dev → sendSMS returns { sid: 'dev-skipped' }.
  const result = await sendAndLogSms({
    to: '3125550199',
    body: 'Hi there',
    clientId: null,
    messageType: 'smstest_send',
    recipientName: 'Test Person',
  });
  assert.strictEqual(result.status, 'sent');
  assert.ok(result.sid, 'expected a sid');
  const { rows } = await pool.query(
    `SELECT direction, recipient_phone, recipient_name, body, message_type, status, twilio_sid
       FROM sms_messages WHERE message_type = 'smstest_send'`
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].direction, 'outbound');
  assert.strictEqual(rows[0].recipient_phone, '+13125550199');
  assert.strictEqual(rows[0].recipient_name, 'Test Person');
  assert.strictEqual(rows[0].body, 'Hi there');
  assert.strictEqual(rows[0].status, 'sent');
});

test('sendAndLogSms > on Twilio failure logs a failed row and throws', async () => {
  // Inject a failing sender via the _deps seam.
  const { __setSmsDeps } = require('./sms');
  __setSmsDeps({ sendSMS: async () => { throw new Error('twilio boom'); } });
  await assert.rejects(
    () => sendAndLogSms({ to: '3125550188', body: 'x', messageType: 'smstest_fail' }),
    /twilio boom/
  );
  const { rows } = await pool.query(
    "SELECT status, error_message FROM sms_messages WHERE message_type = 'smstest_fail'"
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'failed');
  assert.match(rows[0].error_message, /twilio boom/);
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});
