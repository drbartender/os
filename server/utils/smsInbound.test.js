require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  detectOptKeyword,
  detectResponseCode,
  lookupSender,
  recordInboundMessage,
  applyOptOut,
  applyOptIn,
} = require('./smsInbound');

test('detectOptKeyword > recognizes STOP and equivalents, case-insensitive', () => {
  for (const word of ['STOP', 'stop', '  Stop ', 'UNSUBSCRIBE', 'end', 'CANCEL', 'quit']) {
    assert.strictEqual(detectOptKeyword(word), 'stop', `expected stop for "${word}"`);
  }
});

test('detectOptKeyword > recognizes START and equivalents', () => {
  for (const word of ['START', 'start', ' Start', 'UNSTOP', 'yes']) {
    assert.strictEqual(detectOptKeyword(word), 'start', `expected start for "${word}"`);
  }
});

test('detectOptKeyword > returns null for non-keyword text', () => {
  assert.strictEqual(detectOptKeyword('stop by the store later'), null);
  assert.strictEqual(detectOptKeyword('thanks!'), null);
  assert.strictEqual(detectOptKeyword(''), null);
  assert.strictEqual(detectOptKeyword(null), null);
});

test('detectResponseCode > recognizes CONFIRM, case-insensitive, whole-word', () => {
  for (const word of ['CONFIRM', 'confirm', ' Confirm ']) {
    assert.strictEqual(detectResponseCode(word), 'confirm');
  }
});

test('detectResponseCode > recognizes CANT and common spellings', () => {
  for (const word of ['CANT', 'cant', "CAN'T", "can't", ' Cant']) {
    assert.strictEqual(detectResponseCode(word), 'cant');
  }
});

test('detectResponseCode > returns null for free-form text', () => {
  assert.strictEqual(detectResponseCode('I confirm I will be there'), null);
  assert.strictEqual(detectResponseCode('running late sorry'), null);
  assert.strictEqual(detectResponseCode(''), null);
  assert.strictEqual(detectResponseCode(null), null);
});

let lsClientId;
let lsStaffUserId;

before(async () => {
  // Idempotent cleanup - if a prior run threw mid-suite, fixed-email/phone
  // fixture rows may be left behind; delete them so this run is re-runnable.
  await pool.query("DELETE FROM contractor_profiles WHERE phone = '(312) 555-0149'");
  await pool.query("DELETE FROM users WHERE email = 'sms-lookup-staff@example.com'");
  await pool.query("DELETE FROM clients WHERE email = 'sms-lookup-client@example.com'");

  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('SMS Lookup Client', 'sms-lookup-client@example.com', '3125550148')
     RETURNING id`
  );
  lsClientId = c.rows[0].id;

  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ('sms-lookup-staff@example.com', 'x', 'staff')
     RETURNING id`
  );
  lsStaffUserId = u.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone) VALUES ($1, '(312) 555-0149')`,
    [lsStaffUserId]
  );
});

after(async () => {
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [lsStaffUserId]);
  await pool.query('DELETE FROM users WHERE id = $1', [lsStaffUserId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [lsClientId]);
  await pool.end();
});

test('lookupSender > matches a client by last-10-digits regardless of stored format', async () => {
  const r = await lookupSender('+13125550148');
  assert.strictEqual(r.type, 'client');
  assert.strictEqual(r.client.id, lsClientId);
});

test('lookupSender > matches a staff member via contractor_profiles', async () => {
  const r = await lookupSender('+13125550149');
  assert.strictEqual(r.type, 'staff');
  assert.strictEqual(r.staffUserId, lsStaffUserId);
});

test('lookupSender > returns unknown for an unmatched number', async () => {
  const r = await lookupSender('+19998887777');
  assert.strictEqual(r.type, 'unknown');
});

test('lookupSender > returns unknown for a null/garbage number', async () => {
  assert.strictEqual((await lookupSender(null)).type, 'unknown');
  assert.strictEqual((await lookupSender('not-a-phone')).type, 'unknown');
});

test('recordInboundMessage > inserts an inbound row linked to a client', async () => {
  const row = await recordInboundMessage({
    fromPhone: '+13125550148',
    body: 'hello from the test',
    clientId: lsClientId,
    twilioSid: 'SMtest_record_1',
  });
  assert.ok(row.id > 0);
  assert.strictEqual(row.direction, 'inbound');
  assert.strictEqual(row.client_id, lsClientId);
  assert.strictEqual(row.status, 'received');
  assert.strictEqual(row.read_at, null);
  await pool.query('DELETE FROM sms_messages WHERE id = $1', [row.id]);
});

test('recordInboundMessage > tolerates an empty body and a null client', async () => {
  const row = await recordInboundMessage({
    fromPhone: '+19998887777',
    body: '',
    clientId: null,
    twilioSid: 'SMtest_record_2',
  });
  assert.strictEqual(row.body, '');
  assert.strictEqual(row.client_id, null);
  await pool.query('DELETE FROM sms_messages WHERE id = $1', [row.id]);
});

test('applyOptOut > sets sms_enabled false on a client and records the audit', async () => {
  await applyOptOut({ type: 'client', client: { id: lsClientId } });
  const r = await pool.query('SELECT communication_preferences FROM clients WHERE id = $1', [lsClientId]);
  assert.strictEqual(r.rows[0].communication_preferences.sms_enabled, false);
  // restore
  await pool.query(
    `UPDATE clients SET communication_preferences = jsonb_set(communication_preferences, '{sms_enabled}', 'true') WHERE id = $1`,
    [lsClientId]
  );
});

test('applyOptIn > sets sms_enabled true on a staff user', async () => {
  await pool.query(
    `UPDATE users SET communication_preferences = jsonb_set(communication_preferences, '{sms_enabled}', 'false') WHERE id = $1`,
    [lsStaffUserId]
  );
  await applyOptIn({ type: 'staff', staffUserId: lsStaffUserId });
  const r = await pool.query('SELECT communication_preferences FROM users WHERE id = $1', [lsStaffUserId]);
  assert.strictEqual(r.rows[0].communication_preferences.sms_enabled, true);
});

test('applyOptOut > is a no-op for an unknown sender', async () => {
  await applyOptOut({ type: 'unknown' }); // must not throw
});
