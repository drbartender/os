require('dotenv').config();
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');

const vm = require('./voicemail');

// Every row this suite writes uses a recognizable CallSid prefix so cleanup can
// never touch a real row in the shared dev DB. A real Twilio CallSid is
// 'CA' + 32 hex, so 'CAtestvm...' cannot collide.
const PREFIX = 'CAtestvm';
const sid = (n) => `${PREFIX}${String(n).padStart(24, '0')}`;

async function cleanup() {
  await pool.query('DELETE FROM voicemail_delivery WHERE call_sid LIKE $1', [`${PREFIX}%`]);
}

beforeEach(cleanup);
after(async () => { await cleanup(); await pool.end(); });

// ── ledger ──────────────────────────────────────────────────────────────────

test('claimMissedCall wins once and loses on redelivery', async () => {
  const first = await vm.claimMissedCall({ callSid: sid(1), fromE164: '+13125550147' });
  const second = await vm.claimMissedCall({ callSid: sid(1), fromE164: '+13125550147' });
  assert.equal(first, true);
  assert.equal(second, false);
});

test('claimMissedCall stores NULL for a blocked caller', async () => {
  await vm.claimMissedCall({ callSid: sid(2), fromE164: null });
  const { rows } = await pool.query('SELECT from_e164, status FROM voicemail_delivery WHERE call_sid = $1', [sid(2)]);
  assert.equal(rows[0].from_e164, null);
  assert.equal(rows[0].status, 'missed');
});

test('claimMissedCall persists the line it is given', async () => {
  await vm.claimMissedCall({ callSid: sid(40), fromE164: '+13125550147', line: 'primary' });
  const { rows } = await pool.query('SELECT line FROM voicemail_delivery WHERE call_sid = $1', [sid(40)]);
  assert.equal(rows[0].line, 'primary');
});

test('claimMissedCall coerces a missing or unknown line to zul rather than throwing', async () => {
  // A live caller must never lose voicemail to a coding slip, and every row that
  // predates the line column was Zul's, so zul is the correct coercion.
  await vm.claimMissedCall({ callSid: sid(41), fromE164: null });
  await vm.claimMissedCall({ callSid: sid(42), fromE164: null, line: 'nope' });
  const { rows } = await pool.query(
    'SELECT call_sid, line FROM voicemail_delivery WHERE call_sid = ANY($1) ORDER BY call_sid',
    [[sid(41), sid(42)]]
  );
  assert.deepEqual(rows.map((r) => r.line), ['zul', 'zul']);
});

test('claimDelivery returns the caller number once, then null', async () => {
  await vm.claimMissedCall({ callSid: sid(3), fromE164: '+13125550147' });
  const first = await vm.claimDelivery({ callSid: sid(3), recordingSid: 'RE' + 'a'.repeat(32), durationSec: 12 });
  const second = await vm.claimDelivery({ callSid: sid(3), recordingSid: 'RE' + 'a'.repeat(32), durationSec: 12 });
  assert.deepEqual(first, { fromE164: '+13125550147', line: 'zul' });
  assert.equal(second, null);
});

test('claimDelivery returns null for a call that was never registered as missed', async () => {
  const result = await vm.claimDelivery({ callSid: sid(4), recordingSid: 'RE' + 'b'.repeat(32), durationSec: 5 });
  assert.equal(result, null);
});

test('claimDelivery refuses a row already marked failed (the sweep owns it)', async () => {
  await vm.claimMissedCall({ callSid: sid(8), fromE164: '+13125550147' });
  await vm.markDelivery({ callSid: sid(8), status: 'failed' });
  const result = await vm.claimDelivery({ callSid: sid(8), recordingSid: 'RE' + 'c'.repeat(32), durationSec: 9 });
  assert.equal(result, null, 'a late duplicate webhook must not double-upload');
});

test('markDelivery delivered stamps delivered_at; failed does not', async () => {
  await vm.claimMissedCall({ callSid: sid(5), fromE164: '+13125550147' });
  await vm.markDelivery({ callSid: sid(5), status: 'delivered' });
  let { rows } = await pool.query('SELECT status, delivered_at FROM voicemail_delivery WHERE call_sid = $1', [sid(5)]);
  assert.equal(rows[0].status, 'delivered');
  assert.ok(rows[0].delivered_at instanceof Date);

  await vm.claimMissedCall({ callSid: sid(6), fromE164: null });
  await vm.markDelivery({ callSid: sid(6), status: 'failed' });
  ({ rows } = await pool.query('SELECT status, delivered_at FROM voicemail_delivery WHERE call_sid = $1', [sid(6)]));
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].delivered_at, null);
});

test('countVoicemailsSince counts rows inside the window', async () => {
  const before = await vm.countVoicemailsSince(24);
  await vm.claimMissedCall({ callSid: sid(7), fromE164: '+13125550147' });
  const after_ = await vm.countVoicemailsSince(24);
  assert.equal(after_, before + 1);
});

// ── media ───────────────────────────────────────────────────────────────────

const GOOD_SID = 'RE' + 'a1b2c3d4'.repeat(4);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realFetch = (...a) => globalThis.fetch(...a);

test('isRecordingSid accepts the Twilio shape and rejects everything else', () => {
  assert.equal(vm.isRecordingSid(GOOD_SID), true);
  assert.equal(vm.isRecordingSid('RE' + 'A1B2C3D4'.repeat(4)), false, 'uppercase hex is not Twilio shape');
  assert.equal(vm.isRecordingSid('CA' + 'a1b2c3d4'.repeat(4)), false, 'wrong prefix');
  assert.equal(vm.isRecordingSid(GOOD_SID + 'a'), false, 'too long');
  assert.equal(vm.isRecordingSid('../../Accounts/AC1/Recordings/RE1'), false);
  assert.equal(vm.isRecordingSid(''), false);
  assert.equal(vm.isRecordingSid(undefined), false);
});

test('recordingMediaUrl is built from env, never from caller input', () => {
  process.env.TWILIO_ACCOUNT_SID = 'ACtest0000000000000000000000000000';
  const url = vm.recordingMediaUrl(GOOD_SID);
  assert.equal(
    url,
    `https://api.twilio.com/2010-04-01/Accounts/ACtest0000000000000000000000000000/Recordings/${GOOD_SID}.mp3`
  );
});

test('recordingMediaUrl refuses a malformed sid', () => {
  process.env.TWILIO_ACCOUNT_SID = 'ACtest0000000000000000000000000000';
  assert.throws(() => vm.recordingMediaUrl('https://evil.example/x'), /RecordingSid/);
});

test('fetchRecordingMp3 retries a 404 then succeeds', async () => {
  process.env.TWILIO_ACCOUNT_SID = 'ACtest0000000000000000000000000000';
  process.env.TWILIO_AUTH_TOKEN = 'tok';
  let n = 0;
  try {
    vm.__setVoicemailDeps({
      fetch: async () => {
        n += 1;
        if (n === 1) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
        return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('ID3audio').buffer };
      },
      sleep: async () => {},
    });
    const buf = await vm.fetchRecordingMp3(GOOD_SID);
    assert.equal(n, 2);
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.toString(), 'ID3audio');
  } finally {
    vm.__setVoicemailDeps({ fetch: realFetch, sleep: realSleep });
  }
});

test('fetchRecordingMp3 does not retry a 401', async () => {
  process.env.TWILIO_ACCOUNT_SID = 'ACtest0000000000000000000000000000';
  process.env.TWILIO_AUTH_TOKEN = 'tok';
  let n = 0;
  try {
    vm.__setVoicemailDeps({
      fetch: async () => { n += 1; return { ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0) }; },
      sleep: async () => {},
    });
    await assert.rejects(() => vm.fetchRecordingMp3(GOOD_SID), /401/);
    assert.equal(n, 1, 'a credential failure must not be retried');
  } finally {
    vm.__setVoicemailDeps({ fetch: realFetch, sleep: realSleep });
  }
});

test('deleteRecording never throws and reports failure', async () => {
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: { recordings: () => ({ remove: async () => { throw new Error('boom'); } }) },
  });
  assert.equal(await vm.deleteRecording(GOOD_SID), false);
  vm.__setVoicemailDeps({
    client: { recordings: () => ({ remove: async () => true }) },
  });
  assert.equal(await vm.deleteRecording(GOOD_SID), true);
});

test('deleteRecording refuses a malformed sid without touching Twilio', async () => {
  let called = false;
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: { recordings: () => { called = true; return { remove: async () => true }; } },
  });
  assert.equal(await vm.deleteRecording('https://evil.example/x'), false);
  assert.equal(called, false);
});

test('deleteRecording never touches the live account when notifications are gated off', async () => {
  // A destructive call from a SEND_NOTIFICATIONS=false instance is the worst of
  // both worlds: it cannot deliver anything but can still destroy the audio.
  let called = false;
  vm.__setVoicemailDeps({
    notificationsEnabled: () => false,
    client: { recordings: () => { called = true; return { remove: async () => true }; } },
  });
  assert.equal(await vm.deleteRecording(GOOD_SID), false);
  assert.equal(called, false);
});

// ── deliverVoicemail: the one place that owns the delete decision ───────────

function deliverDeps(over) {
  return {
    notificationsEnabled: () => true,
    fetchRecordingMp3: async () => Buffer.from('ID3'),
    client: { recordings: () => ({ remove: async () => true }) },
    ...over,
  };
}

test('deliverVoicemail deletes ONLY on ok === true', async () => {
  await vm.claimMissedCall({ callSid: sid(20), fromE164: '+13125550147' });
  let deleted = 0;
  vm.__setVoicemailDeps(deliverDeps({
    sendTelegramAudio: async () => ({ ok: true }),
    client: { recordings: () => ({ remove: async () => { deleted += 1; return true; } }) },
  }));
  const outcome = await vm.deliverVoicemail({
    callSid: sid(20), recordingSid: GOOD_SID, durationSec: 9, fromE164: '+13125550147', chatId: 1,
  });
  assert.equal(outcome, 'delivered');
  assert.equal(deleted, 1);
  const { rows } = await pool.query('SELECT status FROM voicemail_delivery WHERE call_sid = $1', [sid(20)]);
  assert.equal(rows[0].status, 'delivered');
});

test('deliverVoicemail on a gated send keeps the row RETRYABLE and deletes nothing', async () => {
  // The bug this prevents: parking a gated send in a terminal status put it
  // outside the sweep filter forever, so it was never delivered once
  // SEND_NOTIFICATIONS came back on.
  await vm.claimMissedCall({ callSid: sid(21), fromE164: '+13125550147' });
  await vm.claimDelivery({ callSid: sid(21), recordingSid: GOOD_SID, durationSec: 9 });
  let deleted = 0;
  vm.__setVoicemailDeps(deliverDeps({
    sendTelegramAudio: async () => ({ ok: false, skipped: true }),
    client: { recordings: () => ({ remove: async () => { deleted += 1; return true; } }) },
  }));
  const outcome = await vm.deliverVoicemail({
    callSid: sid(21), recordingSid: GOOD_SID, durationSec: 9, fromE164: '+13125550147', chatId: 1,
  });
  assert.equal(outcome, 'skipped');
  assert.equal(deleted, 0);
  const { rows } = await pool.query('SELECT status FROM voicemail_delivery WHERE call_sid = $1', [sid(21)]);
  assert.equal(rows[0].status, 'recorded', 'still inside the sweep window');
});

test('deliverVoicemail distinguishes an unfetchable recording from a failed upload', async () => {
  await vm.claimMissedCall({ callSid: sid(22), fromE164: null });
  vm.__setVoicemailDeps(deliverDeps({
    fetchRecordingMp3: async () => { throw new Error('recording fetch failed (404)'); },
    sendTelegramAudio: async () => { throw new Error('must not be reached'); },
  }));
  assert.equal(await vm.deliverVoicemail({
    callSid: sid(22), recordingSid: GOOD_SID, durationSec: 9, fromE164: null, chatId: 1,
  }), 'unfetchable');

  await vm.claimMissedCall({ callSid: sid(23), fromE164: null });
  vm.__setVoicemailDeps(deliverDeps({ sendTelegramAudio: async () => ({ ok: false, description: 'Bad Request' }) }));
  assert.equal(await vm.deliverVoicemail({
    callSid: sid(23), recordingSid: GOOD_SID, durationSec: 9, fromE164: null, chatId: 1,
  }), 'failed');
});

test('markDelivery can never demote a delivered row (one-way door)', async () => {
  // Round two shipped markDelivery without `AND delivered_at IS NULL`. A
  // delivered row could then be flipped back to 'failed', which put it straight
  // back into the sweep's retry set against a recording that had already been
  // deleted, ending in Zul being told to pull a voicemail by hand that she
  // already had. This test must FAIL if that guard is removed.
  await vm.claimMissedCall({ callSid: sid(30), fromE164: '+13125550147' });
  await vm.markDelivery({ callSid: sid(30), status: 'delivered' });
  await vm.markDelivery({ callSid: sid(30), status: 'failed' });
  const { rows } = await pool.query(
    'SELECT status, delivered_at FROM voicemail_delivery WHERE call_sid = $1', [sid(30)]
  );
  assert.equal(rows[0].status, 'delivered', 'delivery is terminal');
  assert.ok(rows[0].delivered_at instanceof Date);
});

// ── per-line delivery (Phase 1a) ────────────────────────────────────────────

// A recordings().remove() spy, so "did we delete the recording?" is observable.
// deleteRecording is called as a module function but reaches Twilio through
// _deps.client, which IS injectable.
function removeSpy() {
  const removed = [];
  return {
    removed,
    client: { recordings: (s) => ({ remove: async () => { removed.push(s); return true; } }) },
  };
}
async function statusOf(callSid) {
  const { rows } = await pool.query('SELECT status FROM voicemail_delivery WHERE call_sid = $1', [callSid]);
  return rows[0] && rows[0].status;
}

test('claimDelivery returns the line alongside the caller number', async () => {
  await vm.claimMissedCall({ callSid: sid(49), fromE164: '+13125550147', line: 'primary' });
  vm.__setVoicemailDeps(deliverDeps({}));
  const claim = await vm.claimDelivery({ callSid: sid(49), recordingSid: GOOD_SID, durationSec: 9 });
  assert.deepEqual(claim, { fromE164: '+13125550147', line: 'primary' });
});

test('deliverVoicemail on the zul line uploads audio to Telegram, never SMS', async () => {
  const spy = removeSpy();
  const sent = { audio: [], sms: [] };
  await vm.claimMissedCall({ callSid: sid(50), fromE164: '+13125550147', line: 'zul' });
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: spy.client,
    fetchRecordingMp3: async () => Buffer.from('ID3zul'),
    sendTelegramAudio: async (chatId, buf, opts) => { sent.audio.push({ chatId, opts }); return { ok: true }; },
    sendSMS: async (args) => { sent.sms.push(args); return { sid: 'SM1' }; },
  });
  const out = await vm.deliverVoicemail({
    callSid: sid(50), recordingSid: 'RE' + 'a'.repeat(32), durationSec: 9,
    fromE164: '+13125550147', chatId: '5550001', line: 'zul',
  });
  assert.equal(out, 'delivered');
  assert.equal(await statusOf(sid(50)), 'delivered');
  assert.equal(sent.audio.length, 1);
  assert.equal(sent.sms.length, 0, 'Zul gets Telegram, never the SMS path');
  assert.equal(spy.removed.length, 1, 'a delivered recording is deleted from Twilio');
});

test('deliverVoicemail on the primary line texts the destination, no Telegram audio', async () => {
  const spy = removeSpy();
  const sent = { audio: [], sms: [] };
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  await vm.claimMissedCall({ callSid: sid(51), fromE164: '+13125550147', line: 'primary' });
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: spy.client,
    fetchRecordingMp3: async () => Buffer.from('ID3dallas'),
    sendTelegramAudio: async (chatId, buf, opts) => { sent.audio.push({ chatId, opts }); return { ok: true }; },
    sendSMS: async (args) => { sent.sms.push(args); return { sid: 'SM2' }; },
  });
  const out = await vm.deliverVoicemail({
    callSid: sid(51), recordingSid: 'RE' + 'b'.repeat(32), durationSec: 12,
    fromE164: '+13125550147', chatId: '5550001', line: 'primary',
  });
  assert.equal(out, 'delivered');
  assert.equal(await statusOf(sid(51)), 'delivered');
  assert.equal(sent.audio.length, 0, "Dallas does not get Zul's Telegram");
  assert.equal(sent.sms.length, 1);
  assert.equal(sent.sms[0].to, '+13125889401');
  assert.match(sent.sms[0].body, /\n\+13125550147$/, 'the caller number sits alone on its own line');
  assert.equal(sent.sms[0].meta.skipLog, true, 'an internal alert never files into a client thread');
  // Phase 1a keeps the primary recording: the text carries only number and
  // duration, and until 1b's R2 copy the Twilio console holds the ONLY copy of
  // what the client actually said. Zul's line still deletes (audio delivered).
  assert.equal(spy.removed.length, 0, 'the primary recording is retained until 1b');
});

test('a primary voicemail delivers even when the media is unfetchable', async () => {
  // The text's payload is the number and duration; a transient media 404 must
  // not turn a deliverable text into a failed row.
  const sent = { sms: [] };
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  await vm.claimMissedCall({ callSid: sid(56), fromE164: '+13125550147', line: 'primary' });
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: removeSpy().client,
    fetchRecordingMp3: async () => { throw new Error('404'); },
    sendSMS: async (args) => { sent.sms.push(args); return { sid: 'SM3' }; },
  });
  const out = await vm.deliverVoicemail({
    callSid: sid(56), recordingSid: 'RE' + '1'.repeat(32), durationSec: 7,
    fromE164: '+13125550147', chatId: null, line: 'primary',
  });
  assert.equal(out, 'delivered');
  assert.equal(sent.sms.length, 1);
});

test('primaryAlertText handles unknown duration and marks a redelivery', async () => {
  const sms = [];
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  await vm.claimMissedCall({ callSid: sid(57), fromE164: '+13125550147', line: 'primary' });
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: removeSpy().client,
    fetchRecordingMp3: async () => Buffer.from('ID3'),
    sendSMS: async (args) => { sms.push(args); return { sid: 'SM4' }; },
  });
  await vm.deliverVoicemail({
    callSid: sid(57), recordingSid: 'RE' + '2'.repeat(32), durationSec: null,
    fromE164: '+13125550147', chatId: null, line: 'primary', redelivered: true,
  });
  assert.match(sms[0].body, /unknown length/);
  assert.match(sms[0].body, /\(redelivered\)/, 'a sweep redelivery must not read as a brand-new call');
});

test('primary delivery with no destination is a skip that writes no status (gate 1 of 2)', async () => {
  const spy = removeSpy();
  delete process.env.VM_TEXT_DESTINATION;
  await vm.claimMissedCall({ callSid: sid(52), fromE164: '+13125550147', line: 'primary' });
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: spy.client,
    fetchRecordingMp3: async () => Buffer.from('ID3'),
    sendSMS: async () => { throw new Error('must not be called'); },
  });
  const out = await vm.deliverVoicemail({
    callSid: sid(52), recordingSid: 'RE' + 'c'.repeat(32), durationSec: 8,
    fromE164: '+13125550147', chatId: null, line: 'primary',
  });
  // Gated, not failed: keep the recording and leave the row 'recorded' so it
  // stays inside the sweep's retry window and a fixed config still delivers.
  assert.equal(out, 'skipped');
  assert.equal(await statusOf(sid(52)), 'missed', 'no status write on a gated send');
  assert.equal(spy.removed.length, 0, 'never delete a recording we did not deliver');
});

test('a GATED primary send is a skip, not a delivery (gate 2 of 2)', async () => {
  // sendSMS does NOT throw when notifications are off or creds are missing: it
  // returns a dev-skipped-* sid. Treating that as delivered would mark the row
  // 'delivered' and DELETE the recording, and since delivered_at is a one-way door
  // and the sweep only reaps 'recorded'/'failed', the voicemail would be parked
  // outside both retry and delivery forever.
  const spy = removeSpy();
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  await vm.claimMissedCall({ callSid: sid(55), fromE164: '+13125550147', line: 'primary' });
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: spy.client,
    fetchRecordingMp3: async () => Buffer.from('ID3'),
    sendSMS: async () => ({ sid: 'dev-skipped-1753-abcd1234' }),
  });
  const out = await vm.deliverVoicemail({
    callSid: sid(55), recordingSid: 'RE' + 'f'.repeat(32), durationSec: 8,
    fromE164: '+13125550147', chatId: null, line: 'primary',
  });
  assert.equal(out, 'skipped');
  assert.equal(await statusOf(sid(55)), 'missed', 'no status write on a gated send');
  assert.equal(spy.removed.length, 0, 'a gated send must never delete the recording');
});

test('a failed primary SMS marks failed, keeps the recording, and alerts the backstop', async () => {
  const spy = removeSpy();
  const alerts = [];
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
  await vm.claimMissedCall({ callSid: sid(53), fromE164: '+13125550147', line: 'primary' });
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: spy.client,
    fetchRecordingMp3: async () => Buffer.from('ID3'),
    sendSMS: async () => { throw new Error('twilio 500'); },
    sendTelegramMessage: async (chatId, text) => { alerts.push({ chatId, text }); return { ok: true }; },
  });
  const out = await vm.deliverVoicemail({
    callSid: sid(53), recordingSid: 'RE' + 'd'.repeat(32), durationSec: 8,
    fromE164: '+13125550147', chatId: null, line: 'primary',
  });
  assert.equal(out, 'failed');
  assert.equal(await statusOf(sid(53)), 'failed');
  assert.equal(spy.removed.length, 0, 'never delete a recording we did not deliver');
  // The 312 is a Google Voice inbox and the SMS is the ONLY delivery channel on
  // this line, so a silent drop would lose the lead with no signal.
  assert.equal(alerts.length, 1, 'a failed primary SMS must raise a second-channel alert');
  assert.match(alerts[0].text, /\+13125550147/);
});

test('a backstop alert that itself fails does not change the outcome', async () => {
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  await vm.claimMissedCall({ callSid: sid(54), fromE164: null, line: 'primary' });
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: removeSpy().client,
    fetchRecordingMp3: async () => Buffer.from('ID3'),
    sendSMS: async () => { throw new Error('twilio 500'); },
    sendTelegramMessage: async () => { throw new Error('telegram down too'); },
  });
  const out = await vm.deliverVoicemail({
    callSid: sid(54), recordingSid: 'RE' + 'e'.repeat(32), durationSec: 8,
    fromE164: null, chatId: null, line: 'primary',
  });
  assert.equal(out, 'failed', 'the backstop is best-effort, never the thing that throws');
});

// ── alertOperator (route failure alerts, per line) ──────────────────────────

test('alertOperator texts the primary owner with skipLog and telegrams Zul', async () => {
  const sent = { sms: [], telegram: [] };
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  vm.__setVoicemailDeps({
    sendSMS: async (args) => { sent.sms.push(args); return { sid: 'SMa' }; },
    sendTelegramMessage: async (chatId, text) => { sent.telegram.push({ chatId, text }); return { ok: true }; },
  });
  await vm.alertOperator({ line: 'primary', chatId: '5550001', text: 'boom +13125550147', tail: 't' });
  assert.equal(sent.sms.length, 1);
  assert.equal(sent.sms[0].to, '+13125889401');
  assert.equal(sent.sms[0].meta.skipLog, true);
  assert.equal(sent.telegram.length, 0, "a primary failure never lands in Zul's Telegram");
  await vm.alertOperator({ line: 'zul', chatId: '5550001', text: 'boom', tail: 't' });
  assert.equal(sent.telegram.length, 1);
  assert.equal(sent.sms.length, 1, "Zul's alerts never take the SMS path");
});

test('alertOperator falls back to Telegram when the primary destination is bad', async () => {
  // A mis-set VM_TEXT_DESTINATION must not mean NO human hears about a lost
  // primary voicemail.
  const sent = { telegram: [] };
  delete process.env.VM_TEXT_DESTINATION;
  vm.__setVoicemailDeps({
    sendSMS: async () => { throw new Error('must not be called'); },
    sendTelegramMessage: async (chatId, text) => { sent.telegram.push({ chatId, text }); return { ok: true }; },
  });
  await vm.alertOperator({ line: 'primary', chatId: '5550001', text: 'lost one', tail: 't' });
  assert.equal(sent.telegram.length, 1);
  assert.equal(sent.telegram[0].text, 'Business line (not yours): lost one',
    'prefixed so Zul cannot mistake it for one of her own');
});

test('alertOperator never throws: missing destination, missing chat id, failing sends', async () => {
  delete process.env.VM_TEXT_DESTINATION;
  vm.__setVoicemailDeps({
    sendSMS: async () => { throw new Error('down'); },
    sendTelegramMessage: async () => { throw new Error('down'); },
  });
  await vm.alertOperator({ line: 'primary', chatId: null, text: 'x', tail: 't' });
  await vm.alertOperator({ line: 'zul', chatId: null, text: 'x', tail: 't' });
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  await vm.alertOperator({ line: 'primary', chatId: null, text: 'x', tail: 't' });
  vm.__setVoicemailDeps({ sendTelegramMessage: async () => { throw new Error('down'); } });
  await vm.alertOperator({ line: 'zul', chatId: '5550001', text: 'x', tail: 't' });
  delete process.env.VM_TEXT_DESTINATION;
});
