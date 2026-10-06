require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// The single-recipient staff send core (spec 2026-10-06, Inbox, section 9),
// against the dev DB. Staff sit on 312-555-092x; every row is removed in
// before() and after().
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { AppError } = require('./errors');
const { __setSmsDeps } = require('./sms');
const { notificationsEnabled } = require('./notificationsEnabled');
const { loadEligibleStaffRecipients, sendToStaffRecipient, StaffTextUnrecordedError } = require('./staffText');

const NONCE = `${Date.now()}`;
const FAKE_888 = '+18885550100';
const ORIG_888 = process.env.TWILIO_PHONE_NUMBER;
const S = {};
let adminId;

async function clean() {
  const ids = (await pool.query("SELECT id FROM users WHERE email LIKE 'staff-text-%@example.com'")).rows.map((r) => r.id);
  if (!ids.length) return;
  await pool.query('DELETE FROM sms_messages WHERE recipient_id = ANY($1::int[]) OR sender_id = ANY($1::int[])', [ids]);
  await pool.query('DELETE FROM agreements WHERE user_id = ANY($1::int[])', [ids]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])', [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
}

async function mkUser(label, role, onboarding) {
  const r = await pool.query(
    "INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1, 'x', $2, $3) RETURNING id",
    [`staff-text-${label}-${NONCE}@example.com`, role, onboarding]
  );
  return r.rows[0].id;
}

async function mkStaffer(label, { onboarding = 'approved', phone, displayName = null, preferredName = null, consent }) {
  const id = await mkUser(label, 'staff', onboarding);
  await pool.query(
    'INSERT INTO contractor_profiles (user_id, phone, display_name, preferred_name) VALUES ($1, $2, $3, $4)',
    [id, phone, displayName, preferredName]
  );
  if (consent !== undefined) {
    await pool.query('INSERT INTO agreements (user_id, sms_consent) VALUES ($1, $2)', [id, consent]);
  }
  return id;
}

function withTwilio(createImpl) {
  const calls = [];
  __setSmsDeps({
    client: { messages: { create: async (params) => { calls.push(params); return createImpl(params); } } },
    notificationsEnabled: () => true,
  });
  process.env.TWILIO_PHONE_NUMBER = FAKE_888;
  return calls;
}

function restoreTwilio() {
  __setSmsDeps({ client: null, notificationsEnabled });
  if (ORIG_888 === undefined) delete process.env.TWILIO_PHONE_NUMBER;
  else process.env.TWILIO_PHONE_NUMBER = ORIG_888;
}

before(async () => {
  await clean();
  adminId = await mkUser('admin', 'admin', 'approved');
  S.ok = await mkStaffer('ok', { phone: '(312) 555-0921', displayName: 'Core A.', preferredName: 'Core', consent: true });
  S.nocon = await mkStaffer('nocon', { phone: '3125550922', preferredName: 'Nocon', consent: false });
  S.badphone = await mkStaffer('badphone', { onboarding: 'submitted', phone: '555', preferredName: 'Shortnum', consent: true });
  S.applied = await mkStaffer('applied', { onboarding: 'applied', phone: '3125550924', consent: true });
});

after(async () => {
  await clean();
  await pool.end();
});

test('loadEligibleStaffRecipients > the eligible set, in the pinned shape', async () => {
  await pool.query(
    `UPDATE users SET communication_preferences = jsonb_set(communication_preferences, '{sms_enabled}', 'false') WHERE id = $1`,
    [S.nocon]
  );
  const rows = await loadEligibleStaffRecipients([S.ok, S.nocon, S.badphone, S.applied]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.deepEqual([...byId.keys()].sort((a, b) => a - b), [S.ok, S.nocon, S.badphone].sort((a, b) => a - b));
  const ok = byId.get(S.ok);
  assert.equal(ok.name, 'Core A.');
  assert.equal(ok.phone, '(312) 555-0921');
  assert.equal(ok.sms_consent, true);
  assert.equal(ok.sms_enabled, true);
  assert.equal(typeof ok.communication_preferences, 'object');
  assert.equal(byId.get(S.nocon).sms_enabled, false, 'returned for textability, not enforced by the core');
  assert.equal(byId.get(S.nocon).name, 'Nocon', 'no display name falls back to the preferred name');
});

test('sendToStaffRecipient > a line, a send id and a status callback ride into Twilio and the row', async () => {
  const [recipient] = await loadEligibleStaffRecipients([S.ok]);
  const calls = withTwilio(() => ({ sid: 'SMstafftext_line', from: FAKE_888 }));
  const sendId = crypto.randomUUID();
  const groupId = crypto.randomUUID();
  let result;
  try {
    result = await sendToStaffRecipient({
      recipient, body: 'Can you cover Saturday?', senderId: adminId, groupId,
      line: '888', sendId, statusCallback: 'https://example.test/api/sms/status',
    });
  } finally {
    restoreTwilio();
  }
  assert.equal(result.status, 'sent');
  assert.deepEqual(calls, [{
    from: FAKE_888, to: '+13125550921', body: 'Can you cover Saturday?',
    statusCallback: 'https://example.test/api/sms/status',
  }]);
  const { row } = result;
  assert.equal(row.direction, 'outbound');
  assert.equal(row.group_id, groupId);
  assert.equal(row.sender_id, adminId);
  assert.equal(row.recipient_id, S.ok);
  assert.equal(row.recipient_phone, '+13125550921');
  assert.equal(row.recipient_name, 'Core A.');
  assert.equal(row.twilio_sid, 'SMstafftext_line');
  assert.equal(row.message_type, 'general');
  assert.deepEqual(row.metadata, { line: '888', send_id: sendId });
});

test('sendToStaffRecipient > metadata.line is the line Twilio reports sending from', async () => {
  const [recipient] = await loadEligibleStaffRecipients([S.ok]);
  withTwilio(() => ({ sid: 'SMstafftext_from', from: '+12242220082' }));
  let result;
  try {
    result = await sendToStaffRecipient({ recipient, body: 'x', senderId: adminId, groupId: crypto.randomUUID(), line: '888' });
  } finally {
    restoreTwilio();
  }
  assert.equal(result.row.metadata.line, '0082', 'the number Twilio reports wins over the one asked for');
});

test('sendToStaffRecipient > no consent and an unusable phone are failed rows, and Twilio is never called', async () => {
  const recipients = await loadEligibleStaffRecipients([S.nocon, S.badphone]);
  const calls = withTwilio(() => ({ sid: 'SMstafftext_never', from: FAKE_888 }));
  const results = [];
  try {
    for (const recipient of recipients) {
      results.push(await sendToStaffRecipient({
        recipient, body: 'x', senderId: adminId, groupId: crypto.randomUUID(), line: '888',
      }));
    }
  } finally {
    restoreTwilio();
  }
  assert.equal(calls.length, 0);
  const byId = new Map(results.map((r) => [r.row.recipient_id, r]));
  assert.equal(byId.get(S.nocon).status, 'failed');
  assert.equal(byId.get(S.nocon).row.error_message, 'No SMS consent');
  assert.equal(byId.get(S.nocon).row.recipient_phone, '3125550922');
  assert.deepEqual(byId.get(S.nocon).row.metadata, { line: '888' }, 'the requested line is still recorded');
  assert.equal(byId.get(S.badphone).status, 'failed');
  assert.equal(byId.get(S.badphone).row.error_message, 'Invalid phone number');
  assert.equal(byId.get(S.badphone).row.recipient_phone, '555');
});

test('sendToStaffRecipient > with no send id (the group send) a Twilio throw stores its raw message', async () => {
  const [recipient] = await loadEligibleStaffRecipients([S.ok]);
  withTwilio(() => { throw new Error('carrier filtered'); });
  let result;
  try {
    result = await sendToStaffRecipient({ recipient, body: 'x', senderId: adminId, groupId: crypto.randomUUID() });
  } finally {
    restoreTwilio();
  }
  assert.equal(result.status, 'failed');
  assert.equal(result.row.error_message, 'carrier filtered');
  assert.equal(result.row.twilio_sid, null);
  assert.equal(result.row.recipient_phone, '+13125550921');
});

test('sendToStaffRecipient > an Inbox send (a send id) stores the Twilio code, never the provider prose', async () => {
  const [recipient] = await loadEligibleStaffRecipients([S.ok]);
  withTwilio(() => { throw Object.assign(new Error('Carrier filtered the text to +13125550921'), { code: 30007 }); });
  let result;
  try {
    result = await sendToStaffRecipient({
      recipient, body: 'x', senderId: adminId, groupId: crypto.randomUUID(), line: '888', sendId: crypto.randomUUID(),
    });
  } finally {
    restoreTwilio();
  }
  assert.equal(result.status, 'failed');
  assert.equal(result.row.error_message, 'Twilio 30007 (failed)');
});

test('sendToStaffRecipient > with no line it is the group send exactly: the 888, no callback, metadata {}', async () => {
  const [recipient] = await loadEligibleStaffRecipients([S.ok]);
  const calls = withTwilio(() => ({ sid: 'SMstafftext_plain', from: FAKE_888 }));
  let result;
  try {
    result = await sendToStaffRecipient({
      recipient, body: 'Plain', senderId: adminId, groupId: crypto.randomUUID(), messageType: 'announcement', shiftId: null,
    });
  } finally {
    restoreTwilio();
  }
  assert.deepEqual(calls, [{ from: FAKE_888, to: '+13125550921', body: 'Plain' }]);
  assert.deepEqual(result.row.metadata, {});
  assert.equal(result.row.message_type, 'announcement');
});

test('sendToStaffRecipient > a row that fails to save throws StaffTextUnrecordedError after the send (amendment 29)', async () => {
  const [recipient] = await loadEligibleStaffRecipients([S.ok]);
  // sms_messages.twilio_sid is VARCHAR(100): a longer sid makes this row's INSERT
  // fail after Twilio has taken the text.
  const calls = withTwilio(() => ({ sid: `SM${'x'.repeat(120)}`, from: FAKE_888 }));
  const body = 'Unrecorded core text';
  const digits = String(recipient.phone).replace(/\D/g, '').slice(-10);
  try {
    await assert.rejects(
      () => sendToStaffRecipient({
        recipient, body, senderId: adminId, groupId: crypto.randomUUID(), line: '888', sendId: crypto.randomUUID(),
      }),
      (err) => {
        assert.ok(err instanceof StaffTextUnrecordedError);
        assert.ok(!(err instanceof AppError), 'a plain error, so the Inbox route answers 500 INBOX_SEND_UNRECORDED');
        assert.equal(err.sendStatus, 'sent', 'Twilio took the text; only the record is missing');
        assert.equal(err.recipientId, S.ok);
        assert.equal(err.sqlState, '22001');
        // A pg error's detail can read "Failing row contains (...)" with the
        // phone and the text, so the database error itself never rides along.
        assert.equal(Object.prototype.hasOwnProperty.call(err, 'cause'), false, 'no cause');
        assert.equal(err.cause, undefined);
        const said = `${err.message} ${JSON.stringify(err)}`;
        assert.ok(!said.includes(body), 'no message text');
        assert.ok(!said.replace(/[\s().+-]/g, '').includes(digits), 'no phone number');
        return true;
      }
    );
  } finally {
    restoreTwilio();
  }
  assert.equal(calls.length, 1);
  const rows = await pool.query('SELECT 1 FROM sms_messages WHERE recipient_id = $1 AND body = $2', [S.ok, body]);
  assert.equal(rows.rowCount, 0, 'no row was written');
});
