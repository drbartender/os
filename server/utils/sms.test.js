require('dotenv').config();
// Never fire a real SMS from this suite: the cases that need Twilio inject a
// fake client through __setSmsDeps.
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { sendAndLogSms } = require('./sms');

// Recipients the line tests text through a fake Twilio client. None is a
// client, so message_log stays empty; the deletes are insurance.
const SMS_TEST_PHONES = [
  '+13125550601', '+13125550602', '+13125550603', '+13125550604', '+13125550605',
  '+13125550606', '+13125550607', '+13125550608', '+13125550609',
];

const SMS_TEST_LAST10 = SMS_TEST_PHONES.map((p) => p.slice(-10));

before(async () => {
  await pool.query('DELETE FROM message_log WHERE recipient = ANY($1::text[])', [SMS_TEST_PHONES]);
  await pool.query('DELETE FROM sms_optouts WHERE phone_last10 = ANY($1::text[])', [SMS_TEST_LAST10]);
});

after(async () => {
  await pool.query("DELETE FROM sms_messages WHERE message_type LIKE 'smstest_%'");
  await pool.query('DELETE FROM message_log WHERE recipient = ANY($1::text[])', [SMS_TEST_PHONES]);
  await pool.query('DELETE FROM sms_optouts WHERE phone_last10 = ANY($1::text[])', [SMS_TEST_LAST10]);
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

// ─── Lines and status callbacks (spec 2026-10-06, Inbox) ────────────────────

const { sendSMS, smsStatusCallbackUrl, twilioErrorText, __setSmsDeps: setSmsDeps } = require('./sms');
const { notificationsEnabled: realNotificationsEnabled } = require('./notificationsEnabled');
const ORIG_888 = process.env.TWILIO_PHONE_NUMBER;
const FAKE_888 = '+18885550100';

/** A stand-in Twilio client that records every messages.create call. */
function fakeTwilio(reply = (params) => ({ sid: `SMsmstest${Date.now()}`, from: params.from })) {
  const calls = [];
  return {
    calls,
    client: { messages: { create: async (params) => { calls.push(params); return reply(params); } } },
  };
}

async function withTwilio(fake, fn) {
  setSmsDeps({ client: fake.client, notificationsEnabled: () => true });
  process.env.TWILIO_PHONE_NUMBER = FAKE_888;
  try {
    return await fn();
  } finally {
    // client:null matches dev/test reality (no Twilio creds), the same
    // restore placeBridgedCall.test.js uses.
    setSmsDeps({ client: null, notificationsEnabled: realNotificationsEnabled });
    if (ORIG_888 === undefined) delete process.env.TWILIO_PHONE_NUMBER;
    else process.env.TWILIO_PHONE_NUMBER = ORIG_888;
  }
}

test('sendSMS > with no from it sends from TWILIO_PHONE_NUMBER with exactly from, to and body', async () => {
  const fake = fakeTwilio();
  await withTwilio(fake, () => sendSMS({ to: '+13125550601', body: 'Same as before' }));
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0], { from: FAKE_888, to: '+13125550601', body: 'Same as before' });
});

test('sendSMS > a line key resolves through the registry, and the status callback is passed', async () => {
  const fake = fakeTwilio();
  await withTwilio(fake, () => sendSMS({
    to: '+13125550602', body: 'From the 1922', from: '1922',
    statusCallback: 'https://example.test/api/sms/status',
  }));
  assert.deepEqual(fake.calls[0], {
    from: '+12242221922', to: '+13125550602', body: 'From the 1922',
    statusCallback: 'https://example.test/api/sms/status',
  });
});

test('sendSMS > the result carries the from Twilio reports', async () => {
  const fake = fakeTwilio(() => ({ sid: 'SMsmstest_from', from: '+12242220082' }));
  const result = await withTwilio(fake, () => sendSMS({ to: '+13125550603', body: 'x', from: '0082' }));
  assert.equal(result.sid, 'SMsmstest_from');
  assert.equal(result.from, '+12242220082');
});

test('sendSMS > an unknown line key is refused before anything is sent', async () => {
  const fake = fakeTwilio();
  await withTwilio(fake, async () => {
    await assert.rejects(() => sendSMS({ to: '+13125550604', body: 'x', from: '312' }), /unknown line "312"/);
  });
  assert.equal(fake.calls.length, 0);
});

test('sendSMS > the 888 with no TWILIO_PHONE_NUMBER is refused on the live path', async () => {
  const fake = fakeTwilio();
  await withTwilio(fake, async () => {
    delete process.env.TWILIO_PHONE_NUMBER;
    await assert.rejects(
      () => sendSMS({ to: '+13125550605', body: 'x', from: '888' }),
      /line 888 has no number configured/
    );
  });
  assert.equal(fake.calls.length, 0);
});

test('sendSMS > gated off, the dev stub reports the from it would have used', async () => {
  setSmsDeps({ client: null, notificationsEnabled: realNotificationsEnabled });
  const result = await sendSMS({ to: '+13125550606', body: 'x', from: '0082' });
  assert.match(result.sid, /^dev-skipped-/);
  assert.equal(result.from, '+12242220082');
});

test('smsStatusCallbackUrl > is the API origin plus /api/sms/status', () => {
  const { API_URL } = require('./urls');
  assert.equal(smsStatusCallbackUrl(), `${API_URL}/api/sms/status`);
});

test('twilioErrorText > "Twilio <code> (failed)" for a numeric code, else a fixed text', () => {
  assert.equal(
    twilioErrorText(Object.assign(new Error('Attempt to send to unsubscribed recipient'), { code: 21610 })),
    'Twilio 21610 (failed)'
  );
  assert.equal(twilioErrorText({ code: '30007', message: 'Carrier filtered the text to +13125550699' }), 'Twilio 30007 (failed)',
    'the provider prose, which can quote the number, never reaches the row');
  assert.equal(twilioErrorText(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), 'Twilio send failed');
  assert.equal(twilioErrorText(new Error('no code at all')), 'Twilio send failed');
  assert.equal(twilioErrorText(null), 'Twilio send failed');
});

// ─── Twilio 21610 writes the per-phone opt-out (spec 2026-10-06, decision 10) ─

const { activeOptOut } = require('./smsOptOut');

function refusingTwilio(code, message) {
  return {
    calls: [],
    client: { messages: { create: async () => { throw Object.assign(new Error(message), { code, status: 400 }); } } },
  };
}

test('sendSMS > Twilio 21610 writes sms_optouts for that number and line, then rethrows', async () => {
  await withTwilio(refusingTwilio(21610, 'Attempt to send to unsubscribed recipient'), async () => {
    await assert.rejects(() => sendSMS({ to: '+13125550607', body: 'x', from: '1922' }), /unsubscribed recipient/);
  });
  assert.ok(await activeOptOut('+13125550607'), 'recorded before the error reaches the caller');
  const { rows } = await pool.query("SELECT source, line FROM sms_optouts WHERE phone_last10 = '3125550607'");
  assert.deepEqual(rows, [{ source: 'twilio_21610', line: '1922' }]);
});

test('sendSMS > a 21610 on a send with no from records the 888', async () => {
  await withTwilio(refusingTwilio(21610, 'Attempt to send to unsubscribed recipient'), async () => {
    await assert.rejects(() => sendSMS({ to: '+13125550608', body: 'x' }), /unsubscribed recipient/);
  });
  const { rows } = await pool.query("SELECT line FROM sms_optouts WHERE phone_last10 = '3125550608'");
  assert.deepEqual(rows, [{ line: '888' }]);
});

test('sendSMS > any other Twilio error records no opt-out', async () => {
  await withTwilio(refusingTwilio(30008, 'Unknown error'), async () => {
    await assert.rejects(() => sendSMS({ to: '+13125550609', body: 'x' }), /Unknown error/);
  });
  assert.equal(await activeOptOut('+13125550609'), null);
});
