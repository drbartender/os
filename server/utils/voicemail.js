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
const { sendTelegramAudio, sendTelegramMessage } = require('./telegram');
const { sendSMS } = require('./sms');
const { resolveLine, E164_RE } = require('./voicemailLine');
const { API_URL } = require('./urls');

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
  sendTelegramMessage: (...args) => sendTelegramMessage(...args),
  sendSMS: (...args) => sendSMS(...args),
  fetchRecordingMp3: (...args) => fetchRecordingMp3(...args),
  fetchRecordingMp3Once: (...args) => fetchRecordingMp3Once(...args),
  fetch: (...args) => globalThis.fetch(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
function __setVoicemailDeps(d) { _deps = { ..._deps, ...d }; }

/**
 * Register a missed inbound call. The INSERT is also the missed-call ping's
 * dedup claim: Twilio delivers <Dial action> at least once, so only the request
 * that wins the PK may ping and offer a recording.
 *
 * `line` decides who this voicemail is eventually DELIVERED to, so it is written
 * explicitly on every insert rather than left to the column default. An absent
 * or unrecognized value is coerced to 'zul' (never thrown): a live caller must
 * not lose their voicemail to a coding slip, and 'zul' is both the safe default
 * and the correct value for the line that predates this column.
 *
 * @param {{callSid: string, fromE164: string|null, line?: 'primary'|'zul'}} args
 * @returns {Promise<boolean>} true iff this caller won the claim.
 */
async function claimMissedCall({ callSid, fromE164, line }) {
  const safeLine = resolveLine(line);
  const { rows } = await _deps.pool.query(
    `INSERT INTO voicemail_delivery (call_sid, from_e164, line)
     VALUES ($1, $2, $3)
     ON CONFLICT (call_sid) DO NOTHING
     RETURNING call_sid`,
    [callSid, fromE164 ?? null, safeLine]
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
 * @returns {Promise<{fromE164: string|null, line: 'primary'|'zul', listenToken: string}|null>}
 *   null if already claimed, or if the call was never registered as missed.
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
      RETURNING from_e164, line, listen_token`,
    [recordingSid, Number.isFinite(durationSec) ? durationSec : null, callSid]
  );
  return rows.length > 0
    ? { fromE164: rows[0].from_e164, line: rows[0].line, listenToken: rows[0].listen_token }
    : null;
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
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MEDIA_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await _deps.fetchRecordingMp3Once(recordingSid);
    } catch (err) {
      // No `.status` means the request never got a response at all: a network
      // failure, the AbortSignal timeout, or a malformed SID / unset account
      // SID from recordingMediaUrl. Propagate THAT error rather than
      // flattening it into "failed (0)", or a DNS outage, a timeout, and a
      // missing env var become indistinguishable in the logs. Only an HTTP
      // status reaches the retry policy below.
      if (!err.status) throw err;
      lastStatus = err.status;
      if (lastStatus !== 404) break;
      if (attempt < MEDIA_FETCH_ATTEMPTS) await _deps.sleep(MEDIA_RETRY_BACKOFF_MS * attempt);
    }
  }
  throw new Error(`recording fetch failed (${lastStatus}) sid=...${String(recordingSid).slice(-4)}`);
}

/**
 * ONE authenticated GET for a recording's mp3. The single place the account
 * credentials are assembled into a media request, which is part of why this
 * file is on scripts/sensitive-paths.txt. Throws with `.status` set so callers
 * can distinguish "gone" (404) from "our problem" (anything else).
 *
 * The listen route uses this directly rather than the retrying wrapper above:
 * a person is waiting on that HTTP response, and a missing recording is a
 * final answer, not a transient.
 */
async function fetchRecordingMp3Once(recordingSid) {
  const url = recordingMediaUrl(recordingSid);
  const auth = 'Basic ' + Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');
  const res = await _deps.fetch(url, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`recording fetch failed (${res.status}) sid=...${String(recordingSid).slice(-4)}`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Listen-link master switch, default ON. TWO-SIDED by contract: off must both
 * close GET /api/voice/vm/:token AND stop the alert SMS from carrying a link.
 * Defined here, beside the delivery path, and imported by the route, so the two
 * sides cannot drift apart and leave a dead URL in a client-facing alert.
 */
function listenLinkEnabled() {
  return process.env.VM_LISTEN_LINK_ENABLED !== 'false';
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

/** Short Chicago timestamp for the alert body. */
function chicagoStamp(d = new Date()) {
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/**
 * The internal alert text for a voicemail on the primary line.
 *
 * Kept short on purpose: it lands in a Google Voice inbox as a normal SMS, and a
 * long body would split into multiple billed segments and may be truncated. The
 * caller number is the payload that matters, and it sits on its own line so it
 * stays tappable and copy-pasteable on a phone.
 *
 * The listen link (spec 2026-08-10) deliberately spends the second segment: a
 * fraction of a cent against an alert that otherwise announces a message
 * without offering any way to hear it. It is appended only when the caller
 * passes a token AND listenLinkEnabled(), so the kill switch cannot strand a
 * dead URL in a text that has already been sent.
 */
function primaryAlertText({ fromE164, durationSec, redelivered = false, listenToken = null }) {
  const who = fromE164 || 'a withheld number';
  const secs = Number.isFinite(durationSec) ? `${durationSec}s` : 'unknown length';
  const redo = redelivered ? ' (redelivered)' : '';
  // The link goes LAST so phone clients linkify it cleanly. It is omitted when
  // there is no token OR when the switch is off: a broken or dead URL in an
  // alert is worse than no URL, because it reads as a bug in the voicemail.
  // This is the SMS half of the two-sided VM_LISTEN_LINK_ENABLED contract; the
  // route half is in routes/voicemailListen.js, and both call the same function.
  const listen = (listenToken && listenLinkEnabled())
    ? `\n${API_URL}/api/voice/vm/${listenToken}`
    : '';
  return `New voicemail on the business line (${secs})${redo}, ${chicagoStamp()}.\n${who}${listen}`;
}

/**
 * Route a delivery-failure alert to the LINE'S OWNER: the primary line's owner
 * is texted (sendSMS with skipLog, an internal ops alert that must never file
 * into the client message ledger and is not subject to THIS APP'S consent or
 * STOP suppression); Zul is messaged on Telegram. When the primary destination
 * is unset or malformed it falls back to the Telegram chat, prefixed so it
 * cannot be mistaken for one of Zul's own. Lives here beside the delivery
 * pipeline and is exported for routes/voice.js and the sweep, so the channel
 * choice cannot drift between files. Best-effort by construction: never throws.
 */
async function alertOperator({ line, chatId, text, tail }) {
  if (resolveLine(line) === 'primary') {
    const to = String(process.env.VM_TEXT_DESTINATION || '').trim();
    if (E164_RE.test(to)) {
      await _deps.sendSMS({ to, body: text, meta: { skipLog: true, messageType: 'voicemail_alert' } })
        .catch((err) => console.error(`[voicemail] primary alert failed ${tail}: ${err.message}`));
      return;
    }
    // A mis-set destination must not mean NO human hears about a lost primary
    // voicemail: fall through to the Telegram path as a second channel, marked
    // so Zul can tell it is NOT one of hers.
    console.error(`[voicemail] no primary alert destination ${tail}; falling back to Telegram`);
    if (!chatId) return;
    await _deps.sendTelegramMessage(chatId, `Business line (not yours): ${text}`)
      .catch((err) => console.error(`[voicemail] telegram alert failed ${tail}: ${err.message}`));
    return;
  }
  if (!chatId) return;
  await _deps.sendTelegramMessage(chatId, text)
    .catch((err) => console.error(`[voicemail] telegram alert failed ${tail}: ${err.message}`));
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
 *   'delivered'   the send succeeded. On the ZUL line this is the only case
 *                 that deletes the Twilio recording; the PRIMARY line retains
 *                 it (the alert now carries a listen link, but that link
 *                 STREAMS FROM TWILIO, so Twilio still holds the only copy of
 *                 the audio until 1b's R2 copy: deleting would break every
 *                 link already sent).
 *   'skipped'     gated off / channel unconfigured. Not success, not failure.
 *                 Keeps the recording, must not page anyone, must stay
 *                 retryable.
 *   'failed'      a real send error. Keeps the recording.
 *   'unfetchable' the media could not be retrieved (zul line only; the primary
 *                 branch runs before the fetch). Keeps the recording.
 *
 * Status writes are the caller's business only for 'unfetchable' vs 'failed'
 * messaging; this function writes the ledger itself so the two callers cannot
 * disagree about what a given outcome means.
 *
 * @returns {Promise<'delivered'|'skipped'|'failed'|'unfetchable'>}
 */
async function deliverVoicemail({ callSid, recordingSid, durationSec, fromE164, chatId, line = 'zul', listenToken = null, redelivered = false }) {
  const tail = `sid=...${String(callSid || '').slice(-4)}`;
  const who = fromE164 || 'a withheld number';

  // Delivery is per line. Zul's voicemails go to her Telegram (audio inline, as
  // shipped 2026-07-24); Dallas's go to his phone as a text, because that is
  // where he actually looks. `line` defaults to 'zul' so an older caller cannot
  // land a primary voicemail in Zul's Telegram by omission: the default is the
  // pre-1a behavior. The primary branch runs BEFORE the media fetch, and must
  // stay there: its payload is the number, the duration, and a listen link, none
  // of which need the audio BYTES (the duration comes from the webhook body,
  // the number and token from the row), so a
  // transient media 404 must not turn a deliverable text into 'unfetchable'.
  // (The link resolves the media later, when the operator actually taps it.)
  if (resolveLine(line) === 'primary') {
    const to = String(process.env.VM_TEXT_DESTINATION || '').trim();
    if (!E164_RE.test(to)) {
      // Gated, not failed: the same contract as a tokenless Telegram send. Keep
      // the recording and write NO status, so the row stays inside the sweep's
      // retry window and a corrected config still delivers.
      console.warn(`[voicemail] primary delivery skipped (VM_TEXT_DESTINATION unset or malformed) ${tail}`);
      return 'skipped';
    }
    let sms;
    try {
      // sendSMS, NOT sendAndLogSms: this is an internal ops alert about a client,
      // not a message TO a client. skipLog keeps it out of the client message
      // ledger (messageLog.buildSmsLogEntry honors it), so internal alerts
      // never show up in a client's conversation history, and neither primitive
      // applies THIS APP'S consent or STOP suppression. Carrier-level opt-out is
      // outside our control: a stray STOP from the 312 to the sending number
      // would make Twilio refuse these sends (21610), which surfaces here as the
      // failure path below. Treat a 21610 on this destination as an incident.
      sms = await _deps.sendSMS({
        to,
        body: primaryAlertText({ fromE164, durationSec, redelivered, listenToken }),
        meta: { skipLog: true, messageType: 'voicemail_alert' },
      });
    } catch (err) {
      console.error(`[voicemail] primary SMS failed ${tail}: ${err.message}`);
      await markDelivery({ callSid, status: 'failed' });
      // Second-channel backstop. The SMS is the ONLY delivery channel on this
      // line and it lands in a Google Voice inbox, so a silent drop would lose
      // the lead with no signal at all. Best-effort by construction: this must
      // never be the thing that throws, and it never changes the outcome.
      const allowed = process.env.TELEGRAM_ALLOWED_USER_ID;
      if (allowed) {
        try {
          await _deps.sendTelegramMessage(
            allowed,
            `A voicemail on the business line could not be texted through. Caller: ${fromE164 || 'withheld'}. It is still in the Twilio console.`
          );
        } catch (alertErr) {
          console.error(`[voicemail] primary backstop alert failed ${tail}: ${alertErr.message}`);
        }
      }
      return 'failed';
    }

    // A GATED send is not a delivery. sendSMS does not throw when notifications
    // are off or Twilio creds are missing; it returns a `dev-skipped-*` sid
    // (sms.js). Treating that as delivered would mark the row 'delivered' and
    // DELETE the recording, and because delivered_at is a one-way door and the
    // sweep only reaps 'recorded'/'failed', the voicemail would be parked outside
    // both retry and delivery forever. Same contract as the Telegram path's
    // {ok:false, skipped:true}: write NO status, keep the recording, stay retryable.
    if (!sms || String(sms.sid || '').startsWith('dev-skipped')) {
      console.log(`[voicemail] primary delivery gated off, recording retained and still retryable ${tail}`);
      return 'skipped';
    }

    // The recording is deliberately KEPT on the primary line. The alert now
    // carries a listen link (spec 2026-08-10), but that link streams from
    // TWILIO: this recording is still the only copy of the message until 1b's
    // R2 copy, and the spec's delete rationale ("redelivery re-fetches from
    // R2") does not hold yet. Deleting here would now break every listen link
    // already sent as well as destroying a lead's actual words. Cost: audio lingers in Twilio
    // (trivial storage, real PII) until 1b's purge; the row prune can outlive
    // the pointer. Zul's line still deletes, because her audio was delivered.
    await markDelivery({ callSid, status: 'delivered' });
    console.log(`[voicemail] delivered to the primary line ${tail} duration=${Number.isFinite(durationSec) ? durationSec : '?'}s (recording retained until 1b)`);
    return 'delivered';
  }

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
  alertOperator,
  isRecordingSid,
  recordingMediaUrl,
  fetchRecordingMp3,
  fetchRecordingMp3Once,
  listenLinkEnabled,
  // Pure formatter, exported for its own tests: the SMS body is the feature's
  // only client-facing surface and its copy is worth pinning directly.
  primaryAlertText,
  deleteRecording,
  __setVoicemailDeps,
};
