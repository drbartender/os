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

test('claimDelivery returns the caller number once, then null', async () => {
  await vm.claimMissedCall({ callSid: sid(3), fromE164: '+13125550147' });
  const first = await vm.claimDelivery({ callSid: sid(3), recordingSid: 'RE' + 'a'.repeat(32), durationSec: 12 });
  const second = await vm.claimDelivery({ callSid: sid(3), recordingSid: 'RE' + 'a'.repeat(32), durationSec: 12 });
  assert.deepEqual(first, { fromE164: '+13125550147' });
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
