require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false'; // never fire real email/SMS from this suite
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  detectOptKeyword,
  detectHelpKeyword,
  detectResponseCode,
  lookupSender,
  recordInboundMessage,
  applyOptOut,
  applyOptIn,
  handleConfirm,
  handleCant,
  findStaffCandidatesByPhone,
  resolveShiftResponder,
  findThumbtackProxyLead,
  processInboundSms,
  __setDeps,
} = require('./smsInbound');

// Phones whose STOP-set texts in this file now write sms_optouts (spec
// 2026-10-06, decision 10: every sender, every line). Removed in before() and
// after(), together with the rows the line-aware tests below record.
const OPTOUT_TEST_PHONES = [
  '8392750001', '3125550177',
  '3125550190', '3125550191', '3125550192', '3125550193', '3125550194',
  '3125550195', '3125550196', '3125550197', '3125550198', '3125550199',
  '9998887771', '9998887779',
  // The new opt tests below. Not 3125550505: that is a seeded dev client.
  '3125550503', '3125550504', '3125550506', '3125550508', '3125550510',
  // Amendment 32's opting-back-in tests.
  '3125550509', '3125550512',
];

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

test('detectHelpKeyword > recognizes HELP and INFO, case-insensitive, whole-body', () => {
  for (const word of ['HELP', 'help', '  Help ', 'INFO', 'info', ' Info']) {
    assert.strictEqual(detectHelpKeyword(word), 'help', `expected help for "${word}"`);
  }
});

test('detectHelpKeyword > returns null for free-form text and other keywords', () => {
  assert.strictEqual(detectHelpKeyword('help me reschedule'), null);
  assert.strictEqual(detectHelpKeyword('need info please'), null);
  assert.strictEqual(detectHelpKeyword('stop'), null);
  assert.strictEqual(detectHelpKeyword(''), null);
  assert.strictEqual(detectHelpKeyword(null), null);
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
let ttClientId;

before(async () => {
  // Idempotent cleanup - if a prior run threw mid-suite, fixed-email/phone
  // fixture rows may be left behind; delete them so this run is re-runnable.
  await pool.query("DELETE FROM contractor_profiles WHERE phone = '(312) 555-0149'");
  await pool.query("DELETE FROM users WHERE email = 'sms-lookup-staff@example.com'");
  await pool.query("DELETE FROM clients WHERE email = 'sms-lookup-client@example.com'");
  await pool.query("DELETE FROM sms_messages WHERE twilio_sid LIKE 'SMtest_help_%'");
  await pool.query('DELETE FROM sms_optouts WHERE phone_last10 = ANY($1::text[])', [OPTOUT_TEST_PHONES]);
  await pool.query("DELETE FROM sms_messages WHERE twilio_sid LIKE 'SMtest_l4_%' OR twilio_sid LIKE 'SMtest_d17_%'");

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

  // Thumbtack relay fixtures: a post-rollout lead whose proxy number is the
  // client's stored phone (mirrors prod), and a pre-rollout lead with a real
  // number that must NOT match.
  await pool.query("DELETE FROM thumbtack_leads WHERE negotiation_id IN ('tt-relay-proxy-test', 'tt-relay-legacy-test')");
  await pool.query("DELETE FROM clients WHERE email = 'tt-relay-client@example.com'");
  const tc = await pool.query(
    `INSERT INTO clients (name, email, phone, source) VALUES ('TT Relay Client', 'tt-relay-client@example.com', '8392750001', 'thumbtack') RETURNING id`
  );
  ttClientId = tc.rows[0].id;
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_phone, customer_name, raw_payload)
     VALUES ('tt-relay-proxy-test', $1, '8392750001', 'TT Relay Client', '{}'::jsonb)`,
    [ttClientId]
  );
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_phone, customer_name, raw_payload, created_at)
     VALUES ('tt-relay-legacy-test', $1, '3125550148', 'SMS Lookup Client', '{}'::jsonb, '2026-06-01T00:00:00Z')`,
    [lsClientId]
  );
});

after(async () => {
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [lsStaffUserId]);
  await pool.query('DELETE FROM users WHERE id = $1', [lsStaffUserId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [lsClientId]);
  await pool.query("DELETE FROM thumbtack_leads WHERE negotiation_id IN ('tt-relay-proxy-test', 'tt-relay-legacy-test')");
  await pool.query('DELETE FROM clients WHERE id = $1', [ttClientId]);
  await pool.query('DELETE FROM sms_optouts WHERE phone_last10 = ANY($1::text[])', [OPTOUT_TEST_PHONES]);
  await pool.query("DELETE FROM sms_messages WHERE twilio_sid LIKE 'SMtest_l4_%' OR twilio_sid LIKE 'SMtest_d17_%'");
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

let hcShiftId;
let hcRequestId;

test('handleConfirm > stamps acknowledged_at on the nearest approved shift', async () => {
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status) VALUES (CURRENT_DATE + INTERVAL '10 days', '18:00', 'filled')
     RETURNING id`
  );
  hcShiftId = sh.rows[0].id;
  const sr = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved') RETURNING id`,
    [hcShiftId, lsStaffUserId]
  );
  hcRequestId = sr.rows[0].id;

  const result = await handleConfirm(lsStaffUserId);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.shiftId, hcShiftId);

  const check = await pool.query('SELECT acknowledged_at FROM shift_requests WHERE id = $1', [hcRequestId]);
  assert.ok(check.rows[0].acknowledged_at instanceof Date);

  await pool.query('DELETE FROM shift_requests WHERE id = $1', [hcRequestId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [hcShiftId]);
});

test('handleConfirm > returns ok:false reason no_shift when staff has no approved upcoming shift', async () => {
  const result = await handleConfirm(lsStaffUserId);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'no_shift');
});

test('handleCant > un-assigns the staffer and re-opens the shift', async () => {
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, auto_assigned_at)
     VALUES (CURRENT_DATE + INTERVAL '12 days', '17:00', 'filled', NOW())
     RETURNING id`
  );
  const shiftId = sh.rows[0].id;
  const sr = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved') RETURNING id`,
    [shiftId, lsStaffUserId]
  );
  const requestId = sr.rows[0].id;

  const result = await handleCant(lsStaffUserId);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.shiftId, shiftId);

  const reqAfter = await pool.query('SELECT status, notes FROM shift_requests WHERE id = $1', [requestId]);
  assert.strictEqual(reqAfter.rows[0].status, 'denied');
  assert.match(reqAfter.rows[0].notes || '', /CANT/i);

  const shiftAfter = await pool.query('SELECT status, auto_assigned_at FROM shifts WHERE id = $1', [shiftId]);
  assert.strictEqual(shiftAfter.rows[0].status, 'open');
  // auto_assigned_at is deliberately left set so the scheduler does NOT re-staff
  assert.ok(shiftAfter.rows[0].auto_assigned_at instanceof Date);

  await pool.query('DELETE FROM shift_requests WHERE id = $1', [requestId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
});

test('handleCant > releases the Out-of-Area lock, holder-scoped, keeping the amount', async () => {
  // A CANT text is a drop by SMS: the staffer comes off the roster, so their
  // hold on an attached bonus has to release or the duty line pays someone who
  // is not working the event (spec 2026-08-06 §6).
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status,
                         out_of_area_bonus_cents, out_of_area_locked_at, out_of_area_locked_user_id)
     VALUES (CURRENT_DATE + INTERVAL '12 days', '17:00', 'filled', 2000, NOW(), $1)
     RETURNING id`,
    [lsStaffUserId]
  );
  const shiftId = sh.rows[0].id;
  const sr = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved') RETURNING id`,
    [shiftId, lsStaffUserId]
  );
  const requestId = sr.rows[0].id;

  const result = await handleCant(lsStaffUserId);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.shiftId, shiftId);

  const after = await pool.query(
    `SELECT out_of_area_bonus_cents, out_of_area_locked_at, out_of_area_locked_user_id
       FROM shifts WHERE id = $1`,
    [shiftId]
  );
  assert.strictEqual(after.rows[0].out_of_area_locked_at, null, 'CANT released the lock');
  assert.strictEqual(after.rows[0].out_of_area_locked_user_id, null);
  assert.strictEqual(Number(after.rows[0].out_of_area_bonus_cents), 2000,
    'the amount re-arms for whoever restaffs the shift, it is never cleared');

  await pool.query('DELETE FROM shift_requests WHERE id = $1', [requestId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
});

test('handleCant > does NOT release a bonus locked to a different staffer', async () => {
  // Holder-scoped: one staffer bailing must not unlock money that belongs to a
  // teammate still working the shift.
  const other = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
    [`ooa-cant-other-${Date.now()}@example.com`]
  );
  const otherId = other.rows[0].id;
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status,
                         out_of_area_bonus_cents, out_of_area_locked_at, out_of_area_locked_user_id)
     VALUES (CURRENT_DATE + INTERVAL '13 days', '17:00', 'filled', 3500, NOW(), $1)
     RETURNING id`,
    [otherId]
  );
  const shiftId = sh.rows[0].id;
  const sr = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved') RETURNING id`,
    [shiftId, lsStaffUserId]
  );

  const result = await handleCant(lsStaffUserId);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.shiftId, shiftId);

  const after = await pool.query(
    'SELECT out_of_area_locked_user_id FROM shifts WHERE id = $1', [shiftId]
  );
  assert.strictEqual(after.rows[0].out_of_area_locked_user_id, otherId,
    "a teammate's CANT must not release someone else's bonus");

  await pool.query('DELETE FROM shift_requests WHERE id = $1', [sr.rows[0].id]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM users WHERE id = $1', [otherId]);
});

test('handleCant > returns ok:false reason no_shift when staff has no approved upcoming shift', async () => {
  const result = await handleCant(lsStaffUserId);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'no_shift');
});

// ---------------------------------------------------------------------------
// Resolver hardening: active-account filter + multi-account disambiguation.
// A phone can match more than one staff account (e.g. a shared company line).
// ---------------------------------------------------------------------------

async function mkStaff(email, onboardingStatus, phone) {
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'staff', $2) RETURNING id`,
    [email, onboardingStatus]
  );
  const id = u.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone) VALUES ($1, $2)`,
    [id, phone]
  );
  return id;
}

async function mkApprovedShift(userId, daysOut) {
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status)
     VALUES (CURRENT_DATE + ($1::int) * INTERVAL '1 day', '18:00', 'filled') RETURNING id`,
    [daysOut]
  );
  const shiftId = sh.rows[0].id;
  const sr = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved') RETURNING id`,
    [shiftId, userId]
  );
  return { shiftId, requestId: sr.rows[0].id };
}

async function cleanupStaff(ids) {
  await pool.query('DELETE FROM shift_requests WHERE user_id = ANY($1::int[])', [ids]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])', [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
}

test('lookupSender > excludes a deactivated staff account', async () => {
  const uid = await mkStaff('sms-rh-deactivated@example.com', 'deactivated', '3125550151');
  try {
    const r = await lookupSender('+13125550151');
    assert.strictEqual(r.type, 'unknown');
  } finally {
    await cleanupStaff([uid]);
  }
});

test('findStaffCandidatesByPhone > returns every active staffer sharing a number, excluding deactivated', async () => {
  const a = await mkStaff('sms-rh-a@example.com', 'approved', '3125550150');
  const b = await mkStaff('sms-rh-b@example.com', 'hired', '3125550150');
  const dead = await mkStaff('sms-rh-dead@example.com', 'deactivated', '3125550150');
  try {
    const ids = await findStaffCandidatesByPhone('+13125550150');
    assert.ok(ids.includes(a), 'includes active a');
    assert.ok(ids.includes(b), 'includes active b');
    assert.ok(!ids.includes(dead), 'excludes deactivated');
    assert.strictEqual(ids.length, 2);
  } finally {
    await cleanupStaff([a, b, dead]);
  }
});

test('findStaffCandidatesByPhone > excludes rejected accounts, matching the auth block-list', async () => {
  // 'suspended' is in auth.js's block-list too, but the users_onboarding_status_check
  // CHECK forbids storing it, so only 'rejected' (and 'deactivated', above) are testable.
  const active = await mkStaff('sms-rh-active@example.com', 'approved', '3125550155');
  const rejected = await mkStaff('sms-rh-rej@example.com', 'rejected', '3125550155');
  try {
    const ids = await findStaffCandidatesByPhone('+13125550155');
    assert.ok(ids.includes(active), 'keeps active');
    assert.ok(!ids.includes(rejected), 'excludes rejected');
    assert.strictEqual(ids.length, 1);
  } finally {
    await cleanupStaff([active, rejected]);
  }
});

test('resolveShiftResponder > ok when exactly one candidate has an upcoming approved shift', async () => {
  const a = await mkStaff('sms-rh-one-a@example.com', 'approved', '3125550152');
  const b = await mkStaff('sms-rh-one-b@example.com', 'approved', '3125550152');
  const { shiftId, requestId } = await mkApprovedShift(a, 9);
  try {
    const res = await resolveShiftResponder([a, b]);
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(res.staffUserId, a);
  } finally {
    await pool.query('DELETE FROM shift_requests WHERE id = $1', [requestId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
    await cleanupStaff([a, b]);
  }
});

test('resolveShiftResponder > no_shift when no candidate has an upcoming approved shift', async () => {
  const a = await mkStaff('sms-rh-none-a@example.com', 'approved', '3125550153');
  const b = await mkStaff('sms-rh-none-b@example.com', 'approved', '3125550153');
  try {
    const res = await resolveShiftResponder([a, b]);
    assert.strictEqual(res.status, 'no_shift');
  } finally {
    await cleanupStaff([a, b]);
  }
});

test('resolveShiftResponder > ambiguous when multiple candidates have upcoming approved shifts', async () => {
  const a = await mkStaff('sms-rh-amb-a@example.com', 'approved', '3125550154');
  const b = await mkStaff('sms-rh-amb-b@example.com', 'approved', '3125550154');
  const sa = await mkApprovedShift(a, 8);
  const sb = await mkApprovedShift(b, 11);
  try {
    const res = await resolveShiftResponder([a, b]);
    assert.strictEqual(res.status, 'ambiguous');
    assert.deepStrictEqual([...res.userIds].sort((x, y) => x - y), [a, b].sort((x, y) => x - y));
  } finally {
    await pool.query('DELETE FROM shift_requests WHERE id = ANY($1::int[])', [[sa.requestId, sb.requestId]]);
    await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [[sa.shiftId, sb.shiftId]]);
    await cleanupStaff([a, b]);
  }
});

// ---------------------------------------------------------------------------
// Thumbtack proxy-relay detection (spec 2026-06-11). Run ALONE (shared dev DB).
// ---------------------------------------------------------------------------

test('findThumbtackProxyLead > matches a post-rollout lead by last-10 digits', async () => {
  const r = await findThumbtackProxyLead('+18392750001');
  assert.ok(r, 'expected a match');
  assert.strictEqual(r.clientId, ttClientId);
});

test('findThumbtackProxyLead > ignores pre-rollout leads (real customer numbers)', async () => {
  assert.strictEqual(await findThumbtackProxyLead('+13125550148'), null);
});

test('findThumbtackProxyLead > null for unknown and garbage numbers', async () => {
  assert.strictEqual(await findThumbtackProxyLead('+19998887777'), null);
  assert.strictEqual(await findThumbtackProxyLead(null), null);
});

test('processInboundSms > tags thumbtack relay, links the client, no reply', async () => {
  const result = await processInboundSms({
    from: '+18392750001',
    body: 'Patricia Johnson replied to you on Thumbtack.',
    twilioSid: 'SMtest_relay_1',
  });
  assert.strictEqual(result.outcome, 'thumbtack_relay');
  assert.strictEqual(result.reply, null);
  const row = await pool.query("SELECT client_id, metadata FROM sms_messages WHERE twilio_sid = 'SMtest_relay_1'");
  assert.strictEqual(row.rows[0].client_id, ttClientId);
  assert.strictEqual(row.rows[0].metadata.thumbtack_relay, true);
  await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_relay_1'");
});

test('processInboundSms > a relayed STOP does not opt the client out', async () => {
  const result = await processInboundSms({ from: '+18392750001', body: 'STOP', twilioSid: 'SMtest_relay_stop' });
  assert.strictEqual(result.outcome, 'thumbtack_relay');
  const r = await pool.query('SELECT communication_preferences FROM clients WHERE id = $1', [ttClientId]);
  assert.notStrictEqual(r.rows[0].communication_preferences?.sms_enabled, false, 'sms_enabled must not be flipped');
  await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_relay_stop'");
});

test('processInboundSms > a retried relay MessageSid is a duplicate no-op', async () => {
  const first = await processInboundSms({ from: '+18392750001', body: 'echo', twilioSid: 'SMtest_relay_dup' });
  assert.strictEqual(first.outcome, 'thumbtack_relay');
  const second = await processInboundSms({ from: '+18392750001', body: 'echo', twilioSid: 'SMtest_relay_dup' });
  assert.strictEqual(second.outcome, 'duplicate');
  await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_relay_dup'");
});

test('processInboundSms > HELP from a client returns the compliance reply and takes no other action', async () => {
  try {
    const result = await processInboundSms({ from: '+13125550148', body: 'HELP', twilioSid: 'SMtest_help_client' });
    assert.strictEqual(result.outcome, 'help');
    assert.match(result.reply, /^Dr\. Bartender:/);
    assert.match(result.reply, /Reply STOP to opt out/);
    assert.match(result.reply, /contact@drbartender\.com/);
    // HELP must never flip a preference — it answers regardless of opt state.
    const r = await pool.query('SELECT communication_preferences FROM clients WHERE id = $1', [lsClientId]);
    assert.notStrictEqual(r.rows[0].communication_preferences?.sms_enabled, false, 'HELP must not opt the client out');
    // recorded with the help audit tag
    const row = await pool.query("SELECT metadata FROM sms_messages WHERE twilio_sid = 'SMtest_help_client'");
    assert.strictEqual(row.rows[0].metadata.help_keyword, true);
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_help_client'");
  }
});

test('processInboundSms > HELP (as INFO) from staff replies with the compliance copy, not the freeform-admin path', async () => {
  try {
    const result = await processInboundSms({ from: '+13125550149', body: 'info', twilioSid: 'SMtest_help_staff' });
    assert.strictEqual(result.outcome, 'help');
    assert.match(result.reply, /Reply STOP to opt out/);
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_help_staff'");
  }
});

test('processInboundSms > HELP from an unknown number replies without an unknown-sender alert', async () => {
  try {
    const result = await processInboundSms({ from: '+19998887777', body: 'HELP', twilioSid: 'SMtest_help_unknown' });
    assert.strictEqual(result.outcome, 'help');
    assert.match(result.reply, /contact@drbartender\.com/);
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_help_unknown'");
  }
});

test('processInboundSms > a retried HELP MessageSid is a duplicate no-op', async () => {
  try {
    const first = await processInboundSms({ from: '+13125550148', body: 'HELP', twilioSid: 'SMtest_help_dup' });
    assert.strictEqual(first.outcome, 'help');
    const second = await processInboundSms({ from: '+13125550148', body: 'HELP', twilioSid: 'SMtest_help_dup' });
    assert.strictEqual(second.outcome, 'duplicate');
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_help_dup'");
  }
});

test('processInboundSms > a stranded (processed=false) opt-out re-applies on Twilio retry, then settles (audit F1b heal)', async () => {
  // Simulate a prior delivery that recorded the inbound row but whose applyOptOut
  // threw before settling — the row was left processed=false and the client was
  // never opted out. The retry must NOT skip it as a duplicate; it must re-run
  // the (idempotent) opt-out and then settle so a later replay IS skipped.
  const phone = '3125550177';
  await pool.query("DELETE FROM clients WHERE email = 'sms-heal-client@example.com'");
  const cc = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('SMS Heal Client', 'sms-heal-client@example.com', $1) RETURNING id`,
    [phone]
  );
  const healClientId = cc.rows[0].id;
  try {
    // Stranded record: inbound row exists, processed=false; client still sms-enabled.
    await pool.query(
      `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, message_type, status, twilio_sid, metadata, processed)
       VALUES ('inbound', $1, $2, 'STOP', 'general', 'received', 'SMtest_heal_stop', '{}'::jsonb, false)`,
      [healClientId, phone]
    );

    const healed = await processInboundSms({ from: `+1${phone}`, body: 'STOP', twilioSid: 'SMtest_heal_stop' });
    assert.strictEqual(healed.outcome, 'opt_stop', 'a stranded opt-out must re-process, not skip as duplicate');

    const after = await pool.query('SELECT communication_preferences FROM clients WHERE id = $1', [healClientId]);
    assert.strictEqual(after.rows[0].communication_preferences?.sms_enabled, false, 'the opt-out healed: sms_enabled is now false');

    const row = await pool.query("SELECT processed FROM sms_messages WHERE twilio_sid = 'SMtest_heal_stop'");
    assert.strictEqual(row.rows[0].processed, true, 'the row is now settled so a further retry is skipped');

    const replay = await processInboundSms({ from: `+1${phone}`, body: 'STOP', twilioSid: 'SMtest_heal_stop' });
    assert.strictEqual(replay.outcome, 'duplicate', 'once settled, a replay is skipped as a true duplicate');
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_heal_stop'");
    await pool.query('DELETE FROM clients WHERE id = $1', [healClientId]);
  }
});

test('processInboundSms > relay keeps the client link after real-number capture', async () => {
  // Simulate Component 4: the proxy no longer matches clients.phone, so the
  // lead-row fallback must supply the client link.
  await pool.query("UPDATE clients SET phone = '7735550000' WHERE id = $1", [ttClientId]);
  try {
    const result = await processInboundSms({ from: '+18392750001', body: 'echo after capture', twilioSid: 'SMtest_relay_fb' });
    assert.strictEqual(result.outcome, 'thumbtack_relay');
    const row = await pool.query("SELECT client_id FROM sms_messages WHERE twilio_sid = 'SMtest_relay_fb'");
    assert.strictEqual(row.rows[0].client_id, ttClientId);
  } finally {
    await pool.query("UPDATE clients SET phone = '8392750001' WHERE id = $1", [ttClientId]);
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_relay_fb'");
  }
});

test('processInboundSms > detection failure fails open to the normal path', async () => {
  __setDeps({ findThumbtackProxyLead: async () => { throw new Error('boom'); } });
  try {
    const result = await processInboundSms({ from: '+19998880000', body: 'hello?', twilioSid: 'SMtest_relay_open' });
    assert.strictEqual(result.outcome, 'unknown_sender', 'must fall through to todays path');
  } finally {
    __setDeps({ findThumbtackProxyLead });
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_relay_open'");
  }
});

// ─── opt keywords are no longer swallowed (backlog §3, 2026-08-25) ───────────
//
// STOP_WORDS and START_WORDS are the carrier-mandated sets, and four of those
// words carry an everyday meaning: a client texting "Cancel" almost certainly
// means "cancel my event", and the proposal drip literally asks a question that
// invites "Yes". Before this lane the opt branch returned before any alert, so
// every one of those produced no admin alert, no reply, and a silent preference
// flip. Prod has four such "yes" messages, all silent.
//
// The compliance action still runs first and unchanged — narrowing the keyword
// set is a compliance change, not a bugfix. What changes is that a human sees it.

const { notifyAdminCategory: realNotify } = require('./adminNotifications');

/** Run `fn` with notifyAdminCategory captured; returns the calls it made. */
async function captureAlerts(fn) {
  const calls = [];
  __setDeps({ notifyAdminCategory: async (a) => { calls.push(a); } });
  try {
    await fn();
  } finally {
    __setDeps({ notifyAdminCategory: realNotify });
  }
  return calls;
}

/** A client row on a phone of its own, torn down after `fn`. */
async function withOptClient(phone, name, fn) {
  const email = `opt-${phone}@example.com`;
  await pool.query('DELETE FROM clients WHERE email = $1', [email]);
  const c = await pool.query(
    'INSERT INTO clients (name, email, phone) VALUES ($1, $2, $3) RETURNING id',
    [name, email, phone]
  );
  const id = c.rows[0].id;
  try {
    return await fn(id);
  } finally {
    await pool.query('DELETE FROM sms_messages WHERE client_id = $1', [id]);
    await pool.query('DELETE FROM clients WHERE id = $1', [id]);
  }
}

test('processInboundSms > a client texting "Cancel" alerts the admin, verbatim', async () => {
  await withOptClient('3125550190', 'Cancel Client', async (clientId) => {
    let result;
    const calls = await captureAlerts(async () => {
      result = await processInboundSms({ from: '+13125550190', body: 'Cancel', twilioSid: 'SMtest_opt_cancel' });
    });

    // The compliance half is untouched.
    assert.strictEqual(result.outcome, 'opt_stop');
    assert.strictEqual(result.reply, null, 'Twilio sends the mandated compliance reply, not us');
    const after = await pool.query('SELECT communication_preferences FROM clients WHERE id = $1', [clientId]);
    assert.strictEqual(after.rows[0].communication_preferences?.sms_enabled, false);

    // The half this lane adds.
    assert.strictEqual(calls.length, 1, 'exactly one admin alert');
    assert.strictEqual(calls[0].category, 'urgent_client_reply', 'a client texting in is urgent, same as any other inbound');
    // QUOTED. Bare /Cancel/ also matches the fixture's client name, so it stayed
    // green with the word removed from the copy entirely.
    assert.match(calls[0].emailText, /"Cancel"/, 'the alert carries the word they actually sent, verbatim');
    assert.match(calls[0].emailText, /Cancel Client/, 'and who sent it');
    assert.ok(calls[0].smsBody, 'a client opt keyword texts the admin too');
  });
});

test('processInboundSms > the Cancel alert says the admin can no longer reply by SMS', async () => {
  await withOptClient('3125550191', 'Reply Blocked', async () => {
    const calls = await captureAlerts(async () => {
      await processInboundSms({ from: '+13125550191', body: 'Cancel', twilioSid: 'SMtest_opt_cancel2' });
    });
    // Without this the admin opens the Messages page and texts back a client
    // the system has just unsubscribed.
    assert.match(calls[0].emailText, /cannot reply by SMS/i);
  });
});

test('processInboundSms > an ambiguous opt word is flagged as ambiguous; a plain STOP is not', async () => {
  for (const word of ['Cancel', 'End', 'Quit', 'Yes']) {
    await withOptClient('3125550192', 'Ambiguous Sender', async () => {
      const calls = await captureAlerts(async () => {
        await processInboundSms({ from: '+13125550192', body: word, twilioSid: `SMtest_opt_amb_${word}` });
      });
      assert.match(calls[0].emailText, /often means something else/i, `"${word}" must be flagged ambiguous`);
    });
  }
  for (const word of ['STOP', 'unsubscribe', 'START', 'unstop']) {
    await withOptClient('3125550193', 'Plain Sender', async () => {
      const calls = await captureAlerts(async () => {
        await processInboundSms({ from: '+13125550193', body: word, twilioSid: `SMtest_opt_plain_${word}` });
      });
      assert.doesNotMatch(calls[0].emailText, /often means something else/i,
        `"${word}" is unambiguous — flagging it would train the admin to ignore the flag`);
    });
  }
});

test('processInboundSms > a client texting "Yes" alerts, and says they are re-subscribed', async () => {
  await withOptClient('3125550194', 'Yes Client', async () => {
    let result;
    const calls = await captureAlerts(async () => {
      result = await processInboundSms({ from: '+13125550194', body: 'Yes', twilioSid: 'SMtest_opt_yes' });
    });
    assert.strictEqual(result.outcome, 'opt_start');
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].emailText, /re-subscribed/i);
    assert.doesNotMatch(calls[0].emailText, /cannot reply by SMS/i, 'an opt-IN does not block replies');
  });
});

test('processInboundSms > an unknown number texting an opt keyword alerts by email only', async () => {
  try {
    const calls = await captureAlerts(async () => {
      const r = await processInboundSms({ from: '+19998887771', body: 'Cancel', twilioSid: 'SMtest_opt_unknown' });
      assert.strictEqual(r.outcome, 'opt_stop');
    });
    assert.strictEqual(calls.length, 1, 'an unknown sender is still worth telling someone about');
    assert.strictEqual(calls[0].category, 'routine_admin');
    assert.strictEqual(calls[0].smsBody, undefined, 'no SMS spend on an unrecognized number');
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_opt_unknown'");
  }
});

test('processInboundSms > a staffer texting STOP is NAMED in the alert', async () => {
  // A bartender who opts out stops receiving the CANT/CONFIRM prompts their
  // shifts run on, so "which bartender" is the entire content of this alert.
  const uid = await mkStaff('opt-staff@example.com', 'approved', '3125550197');
  try {
    const calls = await captureAlerts(async () => {
      const r = await processInboundSms({ from: '+13125550197', body: 'STOP', twilioSid: 'SMtest_opt_staff' });
      assert.strictEqual(r.outcome, 'opt_stop');
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].category, 'routine_admin');
    // describeStaff returns `${name} (user N)` on success and a bare `user N`
    // from its catch, so matching "user N" alone cannot tell a working lookup
    // from the degraded fallback. Pin the identity it actually resolved.
    assert.match(calls[0].emailText, /opt-staff@example\.com \(user \d+\)/,
      'the alert must identify WHICH staffer, from a lookup that worked');
    assert.doesNotMatch(calls[0].emailText, /A staff member/);
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_opt_staff'");
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [uid]);
    await pool.query('DELETE FROM users WHERE id = $1', [uid]);
  }
});

test('processInboundSms > a failing alert never blocks the compliance action', async () => {
  await withOptClient('3125550195', 'Alert Boom', async (clientId) => {
    __setDeps({ notifyAdminCategory: async () => { throw new Error('resend is down'); } });
    let result;
    try {
      result = await processInboundSms({ from: '+13125550195', body: 'STOP', twilioSid: 'SMtest_opt_boom' });
    } finally {
      __setDeps({ notifyAdminCategory: realNotify });
    }
    assert.strictEqual(result.outcome, 'opt_stop', 'the outcome is unchanged by an alert failure');
    const after = await pool.query('SELECT communication_preferences FROM clients WHERE id = $1', [clientId]);
    assert.strictEqual(after.rows[0].communication_preferences?.sms_enabled, false,
      'the carrier-mandated opt-out ran even though the alert threw');
  });
});

test('processInboundSms > a retried opt-keyword MessageSid does not alert twice', async () => {
  await withOptClient('3125550196', 'Retry Client', async () => {
    const calls = await captureAlerts(async () => {
      const first = await processInboundSms({ from: '+13125550196', body: 'Cancel', twilioSid: 'SMtest_opt_retry' });
      assert.strictEqual(first.outcome, 'opt_stop');
      const second = await processInboundSms({ from: '+13125550196', body: 'Cancel', twilioSid: 'SMtest_opt_retry' });
      assert.strictEqual(second.outcome, 'duplicate');
    });
    assert.strictEqual(calls.length, 1, 'Twilio retries must not re-alert');
  });
});

test('processInboundSms > the unknown-sender alert does NOT claim a preference was stored', async () => {
  // setSmsEnabled has no 'unknown' branch, so no PREFERENCE is written. The
  // first version of this alert still said "they are now unsubscribed", which a
  // clients row created later would contradict: it starts sms_enabled = true.
  // Since 2026-10-06 the number IS on the per-phone opt-out list (sms_optouts),
  // so the alert says that, and that the carrier holds it too.
  try {
    const calls = await captureAlerts(async () => {
      await processInboundSms({ from: '+19998887779', body: 'STOP', twilioSid: 'SMtest_opt_unknown_copy' });
    });
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].emailText, /now unsubscribed/i, 'no preference was stored, so do not say it was');
    assert.doesNotMatch(calls[0].emailText, /cannot reply by SMS/i, 'there is no thread to reply on');
    assert.match(calls[0].emailText, /not a client or staff member/i);
    assert.match(calls[0].emailText, /now on our opt-out list/i, 'says where the opt-out lives on our side');
    assert.match(calls[0].emailText, /carrier/i, 'and at the carrier');
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_opt_unknown_copy'");
  }
});

test('processInboundSms > a KNOWN client still gets the real preference copy', async () => {
  // Non-vacuity for the branch above: the unknown wording must not leak onto
  // the path where the preference genuinely was written.
  await withOptClient('3125550198', 'Real Client', async (clientId) => {
    const calls = await captureAlerts(async () => {
      await processInboundSms({ from: '+13125550198', body: 'STOP', twilioSid: 'SMtest_opt_known_copy' });
    });
    assert.match(calls[0].emailText, /now unsubscribed/i);
    assert.doesNotMatch(calls[0].emailText, /not a client or staff member/i);
    const after = await pool.query('SELECT communication_preferences FROM clients WHERE id = $1', [clientId]);
    assert.strictEqual(after.rows[0].communication_preferences?.sms_enabled, false,
      'and the preference really was written, which is what licenses the copy');
  });
});

test('processInboundSms > the compliance action runs BEFORE the alert, not after', async () => {
  // The file claims this ordering in two comments and nothing pinned it: with
  // the two lines swapped every other test stayed green, because safeAlert
  // swallows and the opt-out still lands eventually. Read the stored preference
  // from inside the alert to catch the order itself.
  await withOptClient('3125550199', 'Order Client', async (clientId) => {
    let enabledAtAlertTime = 'alert never fired';
    __setDeps({
      notifyAdminCategory: async () => {
        const r = await pool.query('SELECT communication_preferences FROM clients WHERE id = $1', [clientId]);
        enabledAtAlertTime = r.rows[0].communication_preferences?.sms_enabled;
      },
    });
    try {
      await processInboundSms({ from: '+13125550199', body: 'STOP', twilioSid: 'SMtest_opt_order' });
    } finally {
      __setDeps({ notifyAdminCategory: realNotify });
    }
    assert.strictEqual(enabledAtAlertTime, false,
      'the opt-out must already be committed when the alert reads it');
  });
});

// ─── The 2026-10-06 extraction (lane sms-lines, Task 1) ─────────────────────
// The shift commands moved to smsShiftCommands.js and last10 to phone.js.
// smsInbound re-exports them, so every caller and every test above still runs
// the moved code itself, never a copy.
test('extraction > smsInbound re-exports the moved functions themselves, not copies', () => {
  const inbound = require('./smsInbound');
  const shift = require('./smsShiftCommands');
  const phone = require('./phone');
  // typeof first: undefined === undefined would pass the identity check vacuously.
  const pairs = [
    ['findStaffCandidatesByPhone', inbound.findStaffCandidatesByPhone, shift.findStaffCandidatesByPhone],
    ['findNearestApprovedShift', inbound.findNearestApprovedShift, shift.findNearestApprovedShift],
    ['resolveShiftResponder', inbound.resolveShiftResponder, shift.resolveShiftResponder],
    ['handleConfirm', inbound.handleConfirm, shift.handleConfirm],
    ['handleCant', inbound.handleCant, shift.handleCant],
    ['last10', inbound.last10, phone.last10],
  ];
  for (const [name, reexported, moved] of pairs) {
    assert.strictEqual(typeof moved, 'function', `${name} is defined where it moved to`);
    assert.strictEqual(reexported, moved, `smsInbound must re-export ${name} itself, not a copy`);
  }
  assert.strictEqual(inbound.last10('+1 (312) 555-0501'), '3125550501');
  assert.strictEqual(inbound.last10('555-0501'), null, 'fewer than 10 digits is no key');
  assert.strictEqual(inbound.last10(null), null);
});

// ─── Line-aware inbound, and one opt-out for every line (spec 2026-10-06) ───

const { activeOptOut } = require('./smsOptOut');
const ORIG_888 = process.env.TWILIO_PHONE_NUMBER;
const FAKE_888 = '+18885550100';

function restore888() {
  if (ORIG_888 === undefined) delete process.env.TWILIO_PHONE_NUMBER;
  else process.env.TWILIO_PHONE_NUMBER = ORIG_888;
}

async function rowFor(sid) {
  const r = await pool.query('SELECT client_id, body, metadata FROM sms_messages WHERE twilio_sid = $1', [sid]);
  return r.rows[0];
}

test('detectOptKeyword > STOPALL, OPTOUT and REVOKE opt out; the START set is unchanged', () => {
  for (const word of ['STOPALL', 'stopall', ' OptOut ', 'REVOKE', 'revoke']) {
    assert.strictEqual(detectOptKeyword(word), 'stop', `expected stop for "${word}"`);
  }
  for (const word of ['START', 'UNSTOP', 'yes']) assert.strictEqual(detectOptKeyword(word), 'start');
  assert.strictEqual(detectOptKeyword('revoke my booking please'), null, 'whole-body matches only');
});

test('processInboundSms > stores the real To, the picture media and the outcome', async () => {
  await withOptClient('3125550501', 'Picture Client', async (clientId) => {
    const media = [{
      url: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEtest',
      content_type: 'image/jpeg',
    }];
    const calls = await captureAlerts(async () => {
      const r = await processInboundSms({
        from: '+13125550501', to: '+12242221922', body: '', twilioSid: 'SMtest_l4_media', media,
      });
      assert.strictEqual(r.outcome, 'client_message');
    });
    assert.strictEqual(calls.length, 1, 'the client alert still goes out');
    // Twilio media is not always a picture, so the alert counts attachments.
    assert.ok(calls[0].emailText.includes('"" (1 attachment).'), 'the alert says the text carried one attachment');
    assert.ok(calls[0].smsBody.includes('"" (1 attachment).'), 'and so does its SMS');
    const row = await rowFor('SMtest_l4_media');
    assert.strictEqual(row.client_id, clientId);
    assert.strictEqual(row.body, '', 'a picture-only text keeps its empty body');
    assert.strictEqual(row.metadata.to, '+12242221922');
    assert.deepStrictEqual(row.metadata.media, media);
    assert.strictEqual(row.metadata.outcome, 'client_message');
  });
});

test('processInboundSms > a missing To records the 888 number, and no media key', async () => {
  process.env.TWILIO_PHONE_NUMBER = FAKE_888;
  try {
    await captureAlerts(async () => {
      const r = await processInboundSms({ from: '+13125550502', body: 'Who is this?', twilioSid: 'SMtest_l4_noto' });
      assert.strictEqual(r.outcome, 'unknown_sender');
    });
    const row = await rowFor('SMtest_l4_noto');
    assert.strictEqual(row.metadata.to, FAKE_888);
    assert.strictEqual('media' in row.metadata, false);
    assert.strictEqual(row.metadata.outcome, 'unknown_sender');
  } finally {
    restore888();
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_l4_noto'");
  }
});

test('processInboundSms > every settled row carries its outcome: help, relay, opt', async () => {
  try {
    await captureAlerts(async () => {
      await processInboundSms({ from: '+19998887777', body: 'HELP', twilioSid: 'SMtest_l4_out_help' });
      await processInboundSms({ from: '+18392750001', body: 'replied on Thumbtack', twilioSid: 'SMtest_l4_out_relay' });
      await processInboundSms({ from: '+13125550503', body: 'START', twilioSid: 'SMtest_l4_out_start' });
    });
    assert.strictEqual((await rowFor('SMtest_l4_out_help')).metadata.outcome, 'help');
    assert.strictEqual((await rowFor('SMtest_l4_out_relay')).metadata.outcome, 'thumbtack_relay');
    assert.strictEqual((await rowFor('SMtest_l4_out_start')).metadata.outcome, 'opt_start');
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid LIKE 'SMtest_l4_out_%'");
  }
});

test('processInboundSms > every STOP-set word writes sms_optouts for an unknown number, and START clears it', async () => {
  try {
    await captureAlerts(async () => {
      for (const word of ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'END', 'CANCEL', 'QUIT', 'OPTOUT', 'REVOKE']) {
        await pool.query("DELETE FROM sms_optouts WHERE phone_last10 = '3125550504'");
        const r = await processInboundSms({
          from: '+13125550504', to: '+12242220082', body: word, twilioSid: `SMtest_l4_set_${word}`,
        });
        assert.strictEqual(r.outcome, 'opt_stop', word);
        const optout = await pool.query(
          "SELECT source, line, cleared_at FROM sms_optouts WHERE phone_last10 = '3125550504'"
        );
        assert.deepStrictEqual(optout.rows, [{ source: 'keyword', line: '0082', cleared_at: null }],
          `${word} must write the record, with the line it came in on`);
      }
      const r = await processInboundSms({ from: '+13125550504', body: 'UNSTOP', twilioSid: 'SMtest_l4_set_UNSTOP' });
      assert.strictEqual(r.outcome, 'opt_start');
    });
    assert.strictEqual(await activeOptOut('+13125550504'), null, 'START cleared it');
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid LIKE 'SMtest_l4_set_%'");
  }
});

test('processInboundSms > a known client texting STOPALL flips the preference AND writes the record', async () => {
  await withOptClient('3125550510', 'Stopall Client', async (clientId) => {
    await captureAlerts(async () => {
      const r = await processInboundSms({ from: '+13125550510', body: 'stopall', twilioSid: 'SMtest_l4_client_stopall' });
      assert.strictEqual(r.outcome, 'opt_stop');
    });
    const c = await pool.query('SELECT communication_preferences FROM clients WHERE id = $1', [clientId]);
    assert.strictEqual(c.rows[0].communication_preferences.sms_enabled, false);
    assert.ok(await activeOptOut('+13125550510'));
  });
});

test('processInboundSms > a relayed STOP writes the per-phone record but leaves the client preference alone', async () => {
  try {
    const r = await processInboundSms({ from: '+18392750001', body: 'STOP', twilioSid: 'SMtest_l4_relay_stop' });
    assert.strictEqual(r.outcome, 'thumbtack_relay');
    const c = await pool.query('SELECT communication_preferences FROM clients WHERE id = $1', [ttClientId]);
    assert.notStrictEqual(c.rows[0].communication_preferences?.sms_enabled, false,
      "the client's preference is not a proxy number's to change");
    assert.ok(await activeOptOut('+18392750001'), 'Twilio blocks that number from this line now, and so does the OS');
    const row = await rowFor('SMtest_l4_relay_stop');
    assert.strictEqual(row.metadata.thumbtack_relay, true);
    assert.strictEqual(row.metadata.opt_keyword, 'stop');
    const start = await processInboundSms({ from: '+18392750001', body: 'START', twilioSid: 'SMtest_l4_relay_start' });
    assert.strictEqual(start.outcome, 'thumbtack_relay');
    assert.strictEqual(await activeOptOut('+18392750001'), null);
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid IN ('SMtest_l4_relay_stop', 'SMtest_l4_relay_start')");
  }
});

test('processInboundSms > the opt-out record lands BEFORE the alert, like the preference', async () => {
  let activeAtAlertTime = 'alert never fired';
  __setDeps({
    notifyAdminCategory: async () => { activeAtAlertTime = Boolean(await activeOptOut('+13125550506')); },
  });
  try {
    await processInboundSms({ from: '+13125550506', body: 'REVOKE', twilioSid: 'SMtest_l4_order' });
  } finally {
    __setDeps({ notifyAdminCategory: realNotify });
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_l4_order'");
  }
  assert.strictEqual(activeAtAlertTime, true);
});

test('processInboundSms > an unknown number texting START is told it is not on the opt-out list now', async () => {
  try {
    const calls = await captureAlerts(async () => {
      await processInboundSms({ from: '+13125550508', body: 'START', twilioSid: 'SMtest_l4_unknown_start' });
    });
    assert.strictEqual(calls.length, 1);
    // Not "off it again": the number may never have been on it.
    assert.match(calls[0].emailText, /not on our opt-out list now/i);
    assert.doesNotMatch(calls[0].emailText, /re-subscribed/i, 'no preference was stored');
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_l4_unknown_start'");
  }
});

test('handleCant > settles the inbound row with outcome staff_cant inside the drop transaction', async () => {
  const uid = await mkStaff(`l4-cant-outcome-${Date.now()}@example.com`, 'approved', '3125550507');
  const { shiftId, requestId } = await mkApprovedShift(uid, 10);
  await pool.query(
    `INSERT INTO sms_messages (direction, recipient_phone, body, message_type, status, twilio_sid, metadata, processed)
     VALUES ('inbound', '+13125550507', 'CANT', 'general', 'received', 'SMtest_l4_cant', '{}'::jsonb, false)`
  );
  try {
    const result = await handleCant(uid, 'SMtest_l4_cant');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.shiftId, shiftId);
    const row = await pool.query("SELECT processed, metadata FROM sms_messages WHERE twilio_sid = 'SMtest_l4_cant'");
    assert.strictEqual(row.rows[0].processed, true);
    assert.strictEqual(row.rows[0].metadata.outcome, 'staff_cant');
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_l4_cant'");
    await pool.query('DELETE FROM shift_requests WHERE id = $1', [requestId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
    await cleanupStaff([uid]);
  }
});

// ─── Opting back in: only START or UNSTOP clears sms_optouts (spec 2026-10-06, amendment 32) ───
// On the toll-free 888 Twilio does not treat YES as an opt-in, so the OS record
// stays in force too. A YES still runs the preference opt-in and still counts.

test('processInboundSms > a YES leaves an unknown number on sms_optouts, and START takes it off', async () => {
  try {
    const calls = await captureAlerts(async () => {
      await processInboundSms({ from: '+13125550509', body: 'STOP', twilioSid: 'SMtest_l4_a32_unknown_stop' });
      const yes = await processInboundSms({ from: '+13125550509', body: 'Yes', twilioSid: 'SMtest_l4_a32_unknown_yes' });
      assert.strictEqual(yes.outcome, 'opt_start', 'a YES is still the opt-in branch');
    });
    assert.ok(await activeOptOut('+13125550509'), 'a YES must not clear the record');
    const row = await rowFor('SMtest_l4_a32_unknown_yes');
    assert.strictEqual(row.body, 'Yes', 'the YES is kept as a message');
    assert.strictEqual(row.metadata.opt_keyword, 'start');
    assert.strictEqual(row.metadata.outcome, 'opt_start');
    assert.strictEqual(calls.length, 2);
    assert.doesNotMatch(calls[1].emailText, /not on our opt-out list now/i, 'nothing came off the list');
    assert.match(calls[1].emailText, /only START or UNSTOP/i);
    await captureAlerts(async () => {
      await processInboundSms({ from: '+13125550509', body: 'START', twilioSid: 'SMtest_l4_a32_unknown_start' });
    });
    assert.strictEqual(await activeOptOut('+13125550509'), null, 'START clears it');
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid LIKE 'SMtest_l4_a32_unknown_%'");
  }
});

test('processInboundSms > a known client texting YES gets the preference back but stays on sms_optouts until UNSTOP', async () => {
  await withOptClient('3125550512', 'Yes Client', async (clientId) => {
    const pref = async () => (await pool.query(
      'SELECT communication_preferences FROM clients WHERE id = $1', [clientId]
    )).rows[0].communication_preferences.sms_enabled;
    const calls = await captureAlerts(async () => {
      await processInboundSms({ from: '+13125550512', body: 'STOP', twilioSid: 'SMtest_l4_a32_client_stop' });
      assert.strictEqual(await pref(), false);
      await processInboundSms({ from: '+13125550512', body: 'YES', twilioSid: 'SMtest_l4_a32_client_yes' });
    });
    assert.strictEqual(await pref(), true, 'the existing preference opt-in still runs on a YES');
    assert.ok(await activeOptOut('+13125550512'), 'but the record stays in force');
    assert.strictEqual(calls.length, 2);
    assert.match(calls[1].emailText, /only START or UNSTOP/i);
    await captureAlerts(async () => {
      await processInboundSms({ from: '+13125550512', body: 'unstop', twilioSid: 'SMtest_l4_a32_client_unstop' });
    });
    assert.strictEqual(await activeOptOut('+13125550512'), null, 'UNSTOP clears it');
  });
});

test('processInboundSms > a relayed YES leaves the proxy on sms_optouts; a relayed START clears it', async () => {
  try {
    await processInboundSms({ from: '+18392750001', body: 'STOP', twilioSid: 'SMtest_l4_a32_relay_stop' });
    const yes = await processInboundSms({ from: '+18392750001', body: 'yes', twilioSid: 'SMtest_l4_a32_relay_yes' });
    assert.strictEqual(yes.outcome, 'thumbtack_relay');
    assert.ok(await activeOptOut('+18392750001'), 'a relayed YES must not clear it');
    assert.strictEqual((await rowFor('SMtest_l4_a32_relay_yes')).metadata.opt_keyword, 'start');
    await processInboundSms({ from: '+18392750001', body: 'START', twilioSid: 'SMtest_l4_a32_relay_start' });
    assert.strictEqual(await activeOptOut('+18392750001'), null);
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid LIKE 'SMtest_l4_a32_relay_%'");
  }
});

test('processInboundSms > an unknown number texting YES is never told it opted in, and gets no carrier claim', async () => {
  // The alert says only what happened: a YES opts nobody in on the toll-free
  // 888 and leaves sms_optouts as it was.
  try {
    const calls = await captureAlerts(async () => {
      const r = await processInboundSms({ from: '+13125550513', body: 'Yes', twilioSid: 'SMtest_l4_yes_subject' });
      assert.strictEqual(r.outcome, 'opt_start');
    });
    assert.strictEqual(calls.length, 1);
    assert.doesNotMatch(calls[0].subject, /opted in/i);
    assert.strictEqual(calls[0].subject, 'An unrecognized number texted "Yes"; the opt-out list is unchanged');
    assert.doesNotMatch(calls[0].emailText, /carrier opt-in/i, 'YES is not a carrier opt-in keyword on the 888');
    assert.match(calls[0].emailText, /often means something else/i, 'it is still flagged as ambiguous');
  } finally {
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_l4_yes_subject'");
  }
});

// ─── Decision 17: shift commands only answer shift texts (spec 2026-10-06) ──
// A staffer's CONFIRM or CANT is a shift command only on the 888, and only
// when the latest text DRB sent them was automated. Otherwise a "Can't"
// answering Zul's "Can you cover Saturday?" would release their own shift.

const { latestDrbTextWasAutomated } = require('./smsInbound');
const D17_NONCE = `${Date.now()}`;
const D17_PHONE = '+13125550511';

function d17Staff(label) {
  return mkStaff(`d17-${label}-${D17_NONCE}@example.com`, 'approved', '3125550511');
}

async function d17Human() {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1, 'x', 'admin', 'approved') RETURNING id",
    [`d17-human-${D17_NONCE}-${Math.random().toString(36).slice(2, 8)}@example.com`]
  );
  return u.rows[0].id;
}

async function d17Outbound({
  senderId = null, recipientId = null, status = 'sent', minutesAgo, messageType = 'general', clientId = null,
}) {
  await pool.query(
    `INSERT INTO sms_messages (direction, sender_id, recipient_id, recipient_phone, body, message_type, status, client_id, created_at)
     VALUES ('outbound', $1, $2, $3, 'A text DRB sent', $4, $5, $6, NOW() - ($7::int * INTERVAL '1 minute'))`,
    [senderId, recipientId, D17_PHONE, messageType, status, clientId, minutesAgo]
  );
}

// Inbound rows from the staffer carry the same recipient_phone, so one delete
// clears both directions.
async function d17Cleanup(uids, humans = []) {
  await pool.query('DELETE FROM sms_messages WHERE recipient_phone = $1', [D17_PHONE]);
  await cleanupStaff(uids);
  if (humans.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [humans]);
}

test('latestDrbTextWasAutomated > the latest outbound text, by phone or recipient id; none is not automated', async () => {
  const uid = await d17Staff('latest');
  const human = await d17Human();
  try {
    assert.strictEqual(await latestDrbTextWasAutomated({ staffUserId: uid, phone: D17_PHONE }), false,
      'DRB never texted them: not automated');
    await d17Outbound({ minutesAgo: 120 });
    assert.strictEqual(await latestDrbTextWasAutomated({ staffUserId: uid, phone: D17_PHONE }), true);
    await d17Outbound({ senderId: human, recipientId: uid, minutesAgo: 60 });
    assert.strictEqual(await latestDrbTextWasAutomated({ staffUserId: uid, phone: '(312) 555-0511' }), false,
      'a human texted them last');
    assert.strictEqual(await latestDrbTextWasAutomated({ staffUserId: uid, phone: null }), false,
      'found by recipient id alone, as the human staff send stores it');
    assert.strictEqual(await latestDrbTextWasAutomated({ staffUserId: null, phone: null }), false);
  } finally {
    await d17Cleanup([uid], [human]);
  }
});

test('decision 17 > a failed human text never reached them, so the automated text before it still governs', async () => {
  const uid = await d17Staff('failed');
  const human = await d17Human();
  const { shiftId, requestId } = await mkApprovedShift(uid, 10);
  try {
    await d17Outbound({ minutesAgo: 120 });
    await d17Outbound({ senderId: human, recipientId: uid, status: 'failed', minutesAgo: 10 });
    let result;
    await captureAlerts(async () => {
      result = await processInboundSms({ from: D17_PHONE, body: 'Confirm', twilioSid: 'SMtest_d17_failed' });
    });
    assert.strictEqual(result.outcome, 'staff_confirm');
    const sr = await pool.query('SELECT acknowledged_at FROM shift_requests WHERE id = $1', [requestId]);
    assert.ok(sr.rows[0].acknowledged_at instanceof Date);
  } finally {
    await d17Cleanup([uid], [human]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  }
});

test('decision 17 > CANT on the 888 after an automated text releases the shift, as before', async () => {
  const uid = await d17Staff('cant');
  const { shiftId, requestId } = await mkApprovedShift(uid, 10);
  process.env.TWILIO_PHONE_NUMBER = FAKE_888;
  try {
    await d17Outbound({ minutesAgo: 60 });
    let result;
    await captureAlerts(async () => {
      result = await processInboundSms({ from: D17_PHONE, to: FAKE_888, body: "Can't", twilioSid: 'SMtest_d17_cant' });
    });
    assert.strictEqual(result.outcome, 'staff_cant');
    assert.match(result.reply, /you are off the/);
    const sr = await pool.query('SELECT status FROM shift_requests WHERE id = $1', [requestId]);
    assert.strictEqual(sr.rows[0].status, 'denied');
    const sh = await pool.query('SELECT status FROM shifts WHERE id = $1', [shiftId]);
    assert.strictEqual(sh.rows[0].status, 'open');
    assert.strictEqual((await rowFor('SMtest_d17_cant')).metadata.outcome, 'staff_cant');
  } finally {
    restore888();
    await d17Cleanup([uid]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  }
});

test('decision 17 > CANT after a human text is conversation: no reply, the shift untouched, an admin email', async () => {
  const uid = await d17Staff('human-cant');
  const human = await d17Human();
  const { shiftId, requestId } = await mkApprovedShift(uid, 10);
  try {
    await d17Outbound({ minutesAgo: 120 });
    await d17Outbound({ senderId: human, recipientId: uid, minutesAgo: 30 });
    let result;
    const calls = await captureAlerts(async () => {
      result = await processInboundSms({ from: D17_PHONE, body: 'CANT', twilioSid: 'SMtest_d17_human_cant' });
    });
    assert.deepStrictEqual(result, { outcome: 'conversation', reply: null });
    const sr = await pool.query('SELECT status FROM shift_requests WHERE id = $1', [requestId]);
    assert.strictEqual(sr.rows[0].status, 'approved', 'the staffer is still on the roster');
    const sh = await pool.query('SELECT status FROM shifts WHERE id = $1', [shiftId]);
    assert.strictEqual(sh.rows[0].status, 'filled');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].category, 'routine_admin');
    assert.strictEqual(calls.filter((c) => c.smsBody).length, 0, 'the routine email, never an SMS');
    // A real drop must not read like any other freeform text in the inbox.
    assert.strictEqual(calls[0].subject, 'Staff texted CANT but no shift was changed');
    assert.match(calls[0].emailText, /treated as conversation/);
    assert.ok(calls[0].emailText.includes(
      'It was not applied as a shift command because the latest text DRB sent them came from a person, '
      + 'or it came in on a 224 line. Answer them directly, and change the shift by hand if they meant it.'
    ));
    assert.strictEqual((await rowFor('SMtest_d17_human_cant')).metadata.outcome, 'conversation');
  } finally {
    await d17Cleanup([uid], [human]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  }
});

test('decision 17 > CONFIRM on the 1922 is conversation, even after an automated text', async () => {
  const uid = await d17Staff('1922');
  const { shiftId, requestId } = await mkApprovedShift(uid, 10);
  try {
    await d17Outbound({ minutesAgo: 60 });
    let result;
    const calls = await captureAlerts(async () => {
      result = await processInboundSms({
        from: D17_PHONE, to: '+12242221922', body: 'CONFIRM', twilioSid: 'SMtest_d17_1922',
      });
    });
    assert.deepStrictEqual(result, { outcome: 'conversation', reply: null });
    assert.strictEqual(calls[0].subject, 'Staff texted CONFIRM but no shift was changed');
    const sr = await pool.query('SELECT acknowledged_at FROM shift_requests WHERE id = $1', [requestId]);
    assert.strictEqual(sr.rows[0].acknowledged_at, null, 'nothing was acknowledged');
    assert.strictEqual((await rowFor('SMtest_d17_1922')).metadata.to, '+12242221922');
  } finally {
    await d17Cleanup([uid]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  }
});

test('decision 17 > free text on the 888 after an automated text still gets the automated staff reply', async () => {
  const uid = await d17Staff('free');
  try {
    await d17Outbound({ minutesAgo: 60 });
    let result;
    await captureAlerts(async () => {
      result = await processInboundSms({ from: D17_PHONE, body: 'Running ten minutes late', twilioSid: 'SMtest_d17_free' });
    });
    assert.strictEqual(result.outcome, 'staff_freeform');
    assert.match(result.reply, /this number is automated/);
  } finally {
    await d17Cleanup([uid]);
  }
});

test('decision 17 > free text after a human text gets no automated reply', async () => {
  const uid = await d17Staff('free-human');
  const human = await d17Human();
  try {
    await d17Outbound({ senderId: human, recipientId: uid, minutesAgo: 5 });
    let result;
    const calls = await captureAlerts(async () => {
      result = await processInboundSms({ from: D17_PHONE, body: 'Yes I can cover it', twilioSid: 'SMtest_d17_free_human' });
    });
    assert.deepStrictEqual(result, { outcome: 'conversation', reply: null });
    assert.strictEqual(calls[0].subject, 'Staff texted Dr. Bartender', 'any other conversation keeps the plain subject');
    assert.doesNotMatch(calls[0].emailText, /not applied as a shift command/);
  } finally {
    await d17Cleanup([uid], [human]);
  }
});

test('decision 17 > a staffer DRB has never texted gets conversation, never a shift command', async () => {
  const uid = await d17Staff('never');
  const { shiftId, requestId } = await mkApprovedShift(uid, 10);
  try {
    let result;
    await captureAlerts(async () => {
      result = await processInboundSms({ from: D17_PHONE, body: 'cant', twilioSid: 'SMtest_d17_never' });
    });
    assert.deepStrictEqual(result, { outcome: 'conversation', reply: null });
    const sr = await pool.query('SELECT status FROM shift_requests WHERE id = $1', [requestId]);
    assert.strictEqual(sr.rows[0].status, 'approved');
  } finally {
    await d17Cleanup([uid]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  }
});

// Only a text DRB sent the staffer AS STAFF counts. An admin alert, a
// dead-letter alert or an automated text on a client's thread also has no
// sender, but it is not a shift text, so it can never reopen shift commands.

test('decision 17 > an admin alert after a human text does not reopen shift commands: a CANT is conversation', async () => {
  const uid = await d17Staff('alert-after-human');
  const human = await d17Human();
  const { shiftId, requestId } = await mkApprovedShift(uid, 10);
  try {
    await d17Outbound({ senderId: human, recipientId: uid, minutesAgo: 30 });
    // The staffer's phone also gets admin alerts (sendAndLogSms: no sender, no recipient id).
    await d17Outbound({ messageType: 'admin_urgent_client_reply', minutesAgo: 5 });
    let result;
    const calls = await captureAlerts(async () => {
      result = await processInboundSms({ from: D17_PHONE, body: "Can't", twilioSid: 'SMtest_d17_alert_human' });
    });
    assert.deepStrictEqual(result, { outcome: 'conversation', reply: null });
    const sr = await pool.query('SELECT status FROM shift_requests WHERE id = $1', [requestId]);
    assert.strictEqual(sr.rows[0].status, 'approved', 'the staffer is still on the roster');
    const sh = await pool.query('SELECT status FROM shifts WHERE id = $1', [shiftId]);
    assert.strictEqual(sh.rows[0].status, 'filled', 'the shift was not re-opened');
    assert.strictEqual(calls[0].subject, 'Staff texted CANT but no shift was changed');
  } finally {
    await d17Cleanup([uid], [human]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  }
});

test('decision 17 > an admin alert after an automated shift text neither blocks nor opens the lane: a CONFIRM acts', async () => {
  const uid = await d17Staff('alert-after-auto');
  const { shiftId, requestId } = await mkApprovedShift(uid, 10);
  try {
    await d17Outbound({ messageType: 'shift_reminder', minutesAgo: 120 });
    await d17Outbound({ messageType: 'admin_urgent_client_reply', minutesAgo: 5 });
    let result;
    await captureAlerts(async () => {
      result = await processInboundSms({ from: D17_PHONE, body: 'CONFIRM', twilioSid: 'SMtest_d17_alert_auto' });
    });
    assert.strictEqual(result.outcome, 'staff_confirm');
    const sr = await pool.query('SELECT acknowledged_at FROM shift_requests WHERE id = $1', [requestId]);
    assert.ok(sr.rows[0].acknowledged_at instanceof Date, 'the shift reminder still governs');
  } finally {
    await d17Cleanup([uid]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  }
});

test('latestDrbTextWasAutomated > admin alerts, dead-letter alerts and client-thread texts are not texts DRB sent them as staff', async () => {
  const uid = await d17Staff('not-staff-texts');
  try {
    await d17Outbound({ messageType: 'admin_urgent_booking', minutesAgo: 60 });
    await d17Outbound({ messageType: 'initial_proposal', clientId: lsClientId, minutesAgo: 30 });
    assert.strictEqual(await latestDrbTextWasAutomated({ staffUserId: uid, phone: D17_PHONE }), false,
      'an admin alert and an automated client-thread text are the only outbound rows: not automated');
    await d17Outbound({ messageType: 'critical_path_dead_letter_alert', minutesAgo: 10 });
    assert.strictEqual(await latestDrbTextWasAutomated({ staffUserId: uid, phone: D17_PHONE }), false,
      'nor is a dead-letter alert');
    // Control: an older shift text is still found behind the newer rows it skips.
    await d17Outbound({ messageType: 'shift_reminder', minutesAgo: 240 });
    assert.strictEqual(await latestDrbTextWasAutomated({ staffUserId: uid, phone: D17_PHONE }), true);
  } finally {
    await d17Cleanup([uid]);
  }
});
