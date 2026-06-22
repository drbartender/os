require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false'; // never fire real email/SMS from this suite
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
  handleConfirm,
  handleCant,
  findStaffCandidatesByPhone,
  resolveShiftResponder,
  findThumbtackProxyLead,
  processInboundSms,
  __setDeps,
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
let ttClientId;

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
