// server/utils/voicemail.js
//
// 224-inbound voicemail: the delivery ledger and the Twilio media calls. Split
// out of server/routes/voice.js so the route file stays a thin webhook layer
// (CLAUDE.md file-size discipline) and so every DB and network effect is
// injectable in tests.
//
// SECURITY NOTE (spec section 4): nothing caller-supplied ever reaches an
// outbound request. The media URL is CONSTRUCTED from TWILIO_ACCOUNT_SID plus a
// shape-validated RecordingSid; the RecordingUrl in the webhook body is ignored
// entirely. TWILIO_AUTH_TOKEN is the HMAC key for every Twilio webhook in this
// app, so a forged callback pointing our basic auth at an attacker host would
// compromise the whole billed-voice surface.

const twilio = require('twilio');
const { pool } = require('../db');
const { notificationsEnabled } = require('./notificationsEnabled');
const { sendTelegramAudio } = require('./telegram');

// Twilio recording SIDs are 'RE' + 32 lowercase hex. Anchored, so nothing with a
// path separator, a scheme, or a traversal segment can pass.
const RECORDING_SID_RE = /^RE[0-9a-f]{32}$/;

// A recording is occasionally not fetchable for a beat after its status
// callback fires. Bounded retry on 404 only.
const MEDIA_FETCH_TIMEOUT_MS = 10000;
const MEDIA_FETCH_ATTEMPTS = 3;
const MEDIA_RETRY_BACKOFF_MS = 1500;

const client = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Dependency seam for tests (mirror server/utils/sms.js __setSmsDeps).
// `fetchRecordingMp3` is a hoisted declaration below, so naming it here is safe
// and lets tests stub the media fetch without stubbing global fetch.
let _deps = {
  pool,
  client,
  notificationsEnabled,
  sendTelegramAudio,
  fetchRecordingMp3: (...args) => fetchRecordingMp3(...args),
  fetch: (...args) => globalThis.fetch(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
function __setVoicemailDeps(d) { _deps = { ..._deps, ...d }; }

/**
 * Register a missed inbound call. The INSERT is also the missed-call ping's
 * dedup claim: Twilio delivers <Dial action> at least once, so only the request
 * that wins the PK may ping and offer a recording.
 * @returns {Promise<boolean>} true iff this caller won the claim.
 */
async function claimMissedCall({ callSid, fromE164 }) {
  const { rows } = await _deps.pool.query(
    `INSERT INTO voicemail_delivery (call_sid, from_e164)
     VALUES ($1, $2)
     ON CONFLICT (call_sid) DO NOTHING
     RETURNING call_sid`,
    [callSid, fromE164 ?? null]
  );
  return rows.length > 0;
}

/**
 * Rolling-window row count backing VM_DAILY_CAP. Counts every missed call in
 * the window regardless of outcome, because the cost being capped (greeting +
 * recording) is incurred at offer time, not at delivery time.
 */
async function countVoicemailsSince(hours) {
  const { rows } = await _deps.pool.query(
    `SELECT COUNT(*)::int AS n FROM voicemail_delivery
      WHERE created_at > NOW() - ($1 || ' hours')::interval`,
    [String(hours)]
  );
  return rows[0].n;
}

/**
 * Claim the right to deliver this recording, and read back the caller number in
 * the same round trip (the recording status callback does not carry `From`).
 * The claim IS the missed -> recorded transition, so the guard is exactly
 * status = 'missed'. Anything wider breaks idempotency: including 'recorded'
 * lets a concurrent Twilio redelivery re-claim a row the first callback is
 * still uploading and send the audio twice, and including 'failed' lets a late
 * duplicate re-enter delivery on a row the scheduler's sweep already owns (the
 * sweep queries voicemail_delivery directly and never calls this).
 *
 * @returns {Promise<{fromE164: string|null}|null>} null if already claimed, or
 *   if the call was never registered as missed.
 */
async function claimDelivery({ callSid, recordingSid, durationSec }) {
  const { rows } = await _deps.pool.query(
    `UPDATE voicemail_delivery
        SET status = 'recorded',
            recording_sid = $1,
            duration_sec = $2,
            attempts = attempts + 1
      WHERE call_sid = $3
        AND status = 'missed'
      RETURNING from_e164`,
    [recordingSid, Number.isFinite(durationSec) ? durationSec : null, callSid]
  );
  return rows.length > 0 ? { fromE164: rows[0].from_e164 } : null;
}

/**
 * Terminal (or resting) status write. `delivered` also stamps delivered_at.
 *
 * `delivered_at IS NULL` is a one-way door: once a voicemail has been delivered
 * and its recording deleted, NOTHING may demote the row back to 'failed'. That
 * demotion is what put a delivered row back into the sweep's retry set, where
 * the fetch 404s forever (the audio is gone) and Zul is eventually told to pull
 * a voicemail by hand that she already received.
 */
async function markDelivery({ callSid, status }) {
  await _deps.pool.query(
    `UPDATE voicemail_delivery
        SET status = $1,
            delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END
      WHERE call_sid = $2
        AND delivered_at IS NULL`,
    [status, callSid]
  );
}

/** Anchored shape check. The ONLY gate between a webhook body and a URL. */
function isRecordingSid(value) {
  return typeof value === 'string' && RECORDING_SID_RE.test(value);
}

/**
 * Build the media URL ourselves. The webhook body's RecordingUrl is deliberately
 * never consulted: see the SECURITY NOTE at the top of this file.
 */
function recordingMediaUrl(recordingSid) {
  if (!isRecordingSid(recordingSid)) throw new Error('invalid RecordingSid');
  const account = process.env.TWILIO_ACCOUNT_SID;
  if (!account) throw new Error('TWILIO_ACCOUNT_SID not set');
  return `https://api.twilio.com/2010-04-01/Accounts/${account}/Recordings/${recordingSid}.mp3`;
}

/**
 * Fetch the recording as a Buffer using the account's basic auth against the
 * URL we constructed. This is a plain authenticated GET and not an SDK call on
 * purpose: client.recordings(sid).fetch() returns the recording's METADATA, not
 * its audio bytes, so there is no SDK path to the mp3. The SDK is used for the
 * delete below, where it is the right tool.
 *
 * 404 is the known just-after-callback race and is retried; 401/403 are
 * credential problems and are not. Throws on permanent or exhausted failure so
 * the caller can take the failure path (keep the recording, alert).
 */
async function fetchRecordingMp3(recordingSid) {
  const url = recordingMediaUrl(recordingSid);
  const auth = 'Basic ' + Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  let lastStatus = 0;
  for (let attempt = 1; attempt <= MEDIA_FETCH_ATTEMPTS; attempt += 1) {
    const res = await _deps.fetch(url, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    lastStatus = res.status;
    if (res.status !== 404) break;
    if (attempt < MEDIA_FETCH_ATTEMPTS) await _deps.sleep(MEDIA_RETRY_BACKOFF_MS * attempt);
  }
  throw new Error(`recording fetch failed (${lastStatus}) sid=...${String(recordingSid).slice(-4)}`);
}

/**
 * Delete the recording from Twilio. Called ONLY after a confirmed delivery, so
 * a failure here is cosmetic (the ledger already records delivery and nothing
 * re-sends). Never throws.
 * @returns {Promise<boolean>} true iff Twilio accepted the delete.
 */
async function deleteRecording(recordingSid) {
  if (!isRecordingSid(recordingSid)) return false;
  // Gated identically to every other live Twilio call (sms.js sendSMS /
  // placeBridgedCall). A DESTRUCTIVE call against the live account from a
  // SEND_NOTIFICATIONS=false instance would be the worst of both worlds: it
  // cannot deliver anything, but it can still destroy the recording.
  if (!_deps.notificationsEnabled()) {
    console.log(`[voicemail] delete skipped (notifications gated off) sid=...${String(recordingSid).slice(-4)}`);
    return false;
  }
  if (!_deps.client) {
    console.log(`[voicemail] delete skipped (Twilio creds not set) sid=...${String(recordingSid).slice(-4)}`);
    return false;
  }
  try {
    await _deps.client.recordings(recordingSid).remove();
    console.log(`[voicemail] recording deleted sid=...${String(recordingSid).slice(-4)}`);
    return true;
  } catch (err) {
    console.error(`[voicemail] recording delete failed sid=...${String(recordingSid).slice(-4)}: ${err.message}`);
    return false;
  }
}

/**
 * Fetch a recording, deliver it to a Telegram chat, and write the outcome.
 *
 * This is the ONE place that owns the money-and-audio decision, because there
 * are two callers (the recording webhook in routes/voice.js and the scheduler's
 * redelivery sweep) and having each implement it separately already produced a
 * bug: the sweep collapsed a gated `skipped` send into `failed`, burning its
 * retry budget and stranding the voicemail permanently.
 *
 * The three outcomes are NOT interchangeable and must never be collapsed:
 *   'delivered'   ok === true. The ONLY case that deletes the Twilio recording.
 *   'skipped'     gated off / no bot token. Not success, not failure. Keeps the
 *                 recording, must not page anyone, must stay retryable.
 *   'failed'      a real Bot API error. Keeps the recording.
 *   'unfetchable' the media could not be retrieved at all. Keeps the recording.
 *
 * Status writes are the caller's business only for 'unfetchable' vs 'failed'
 * messaging; this function writes the ledger itself so the two callers cannot
 * disagree about what a given outcome means.
 *
 * @returns {Promise<'delivered'|'skipped'|'failed'|'unfetchable'>}
 */
async function deliverVoicemail({ callSid, recordingSid, durationSec, fromE164, chatId, redelivered = false }) {
  const tail = `sid=...${String(callSid || '').slice(-4)}`;
  const who = fromE164 || 'a withheld number';

  let audio;
  try {
    audio = await _deps.fetchRecordingMp3(recordingSid);
  } catch (err) {
    await markDelivery({ callSid, status: 'failed' });
    console.error(`[voicemail] media fetch failed ${tail}: ${err.message}`);
    return 'unfetchable';
  }

  const secs = Number.isFinite(durationSec) ? durationSec : 0;
  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const caption = `Voicemail from ${who}, ${mmss}${redelivered ? ' (redelivered)' : ''}`;
  const result = await _deps.sendTelegramAudio(chatId, audio, { filename: 'voicemail.mp3', caption });

  if (result && result.ok === true) {
    await markDelivery({ callSid, status: 'delivered' });
    await deleteRecording(recordingSid);
    console.log(`[voicemail] delivered ${tail} duration=${secs}s`);
    return 'delivered';
  }
  if (result && result.skipped === true) {
    // Deliberately does NOT write a status. Leaving the row where it is keeps it
    // inside the sweep's retry window, so the voicemail is still delivered once
    // SEND_NOTIFICATIONS is turned back on. Writing 'skipped' here would park it
    // outside the sweep filter forever.
    console.log(`[voicemail] send gated off, recording retained and still retryable ${tail}`);
    return 'skipped';
  }
  await markDelivery({ callSid, status: 'failed' });
  console.error(`[voicemail] upload failed ${tail}: ${(result && result.description) || 'unknown'}`);
  return 'failed';
}

module.exports = {
  claimMissedCall,
  deliverVoicemail,
  countVoicemailsSince,
  claimDelivery,
  markDelivery,
  isRecordingSid,
  recordingMediaUrl,
  fetchRecordingMp3,
  deleteRecording,
  __setVoicemailDeps,
};
