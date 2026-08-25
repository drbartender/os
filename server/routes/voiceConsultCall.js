/**
 * Consult call bridge Twilio webhooks (spec 2026-08-25 section 4.3), mounted at
 * /api/voice/consult:
 *
 *   POST /answer   an agent leg was picked up: Gather-wrapped spoken briefing
 *   POST /digit    Gather action: 1 bridges to the booker, 9 replays, else bye
 *   POST /dialend  the Dial action: how the BRIDGED call to the booker ended
 *   POST /status   statusCallback for every leg: the chain's terminal handler
 *
 * Signature policy: FAIL CLOSED IN EVERY ENVIRONMENT (voiceLeadCall.js
 * precedent, NOT voice.js's dev warn-and-allow). These endpoints speak client
 * PII and place billed calls; a dev box against the shared DB must never serve
 * them unsigned. Tests stub the gate via __setConsultVoiceDeps.
 *
 * State machine law: every transition is a guarded UPDATE keyed on the expected
 * prior status AND, on the admin leg, on admin_ring (the row re-enters
 * calling_admin up to three times, so status alone cannot tell ring 1's
 * callback from ring 2's). Twilio delivers callbacks at-least-once and can
 * deliver them late; every duplicate must be a no-op.
 *
 * NEVER A 5xx TO TWILIO. Twilio RETRIES a 5xx, and a retried callback on a
 * billed call chain is exactly what the guards above exist to prevent. Unlike
 * the tail-side helpers, advanceChain and onLegTerminal CAN reject on a
 * database error, so every handler here carries its own catch and answers 200
 * with TwiML (or with the 403 it already sent).
 */

const express = require('express');
const Sentry = require('@sentry/node');
const { xmlEscape } = require('../utils/xmlEscape');
const { isValidTwilioRequest } = require('../utils/twilioSignature');
const { pool } = require('../db');
const {
  onLegTerminal, guardStillScheduled, sendMissedText, MAX_ADMIN_RINGS,
} = require('../utils/consultCallChain');
const { buildConsultBriefing, formatUsPhoneForText } = require('../utils/consultCallBriefing');
const { toUsE164 } = require('../utils/usPhone');
const { API_URL } = require('../utils/urls');

const router = express.Router();

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

// The only Twilio call statuses that mean a leg is DONE. Ruling R25: this list
// is the whole is-this-leg-really-done invariant on the route side. Forwarding
// a non-terminal status such as 'answered' for a live ring 1 would re-arm the
// chain to pending with ring-2 timing and the sweep would dial Dallas a SECOND
// time while he is mid-briefing on the first call. onLegTerminal carries the
// same allowlist itself, so the billed-effect boundary does not have to trust
// its only caller.
const TERMINAL_STATUSES = new Set(['completed', 'no-answer', 'busy', 'failed', 'canceled']);

// How a bridged <Dial> ended when the CLIENT never picked up. Only these four
// latch, text and speak. The cheap branch is the DEFAULT, the way voice.js's
// MISSED_STATUSES works on the inbound line: a denylist of 'completed' would
// stamp the latch, text Dallas and tell an agent who just finished a good
// conversation that nobody answered, on an absent DialCallStatus or on any word
// Twilio adds to the vocabulary later. Kept separate from that constant on
// purpose: this one reads a consult bridge, that one an inbound dial.
const MISSED_DIAL_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled']);

const MAX_BRIEFING_PLAYS = 3;
// MAX_ADMIN_RINGS is imported, never re-declared: the ring plan is law under
// the lane's global constraints and a local copy is how one drifts out of
// agreement with it.
const STRICT_E164 = /^\+[1-9]\d{6,14}$/;

function timeLimitSec() {
  return parseInt(process.env.VA_CALL_TIME_LIMIT_SEC, 10) || 1800;
}

/**
 * Caller ID on the client leg: the 1922 (the company line printed on proposals)
 * when Dallas pressed 1, so the client's callback rings through to him; the
 * 0082 when Zul pressed 1, so a callback reaches her.
 *
 * The strict format check, not just a presence check, is the point. A Render
 * typo in CONSULT_CALLER_ID would otherwise make every press-1 Dial fail AT
 * TWILIO while the row already reads 'connected', which is terminal and never
 * reaped, so the failure would be invisible. server/index.js warns about the
 * same value at boot.
 */
function callerIdFor(leg) {
  const voice = String(process.env.VOICE_CALLER_ID || '').trim();
  if (leg !== 'admin') return voice;
  const consultCallerId = String(process.env.CONSULT_CALLER_ID || '').trim();
  return STRICT_E164.test(consultCallerId) ? consultCallerId : voice;
}

// Dependency-injection seam for tests (mirrors voiceLeadCall's __setLeadVoiceDeps).
let _deps = { isValidTwilioRequest, pool, onLegTerminal, guardStillScheduled, sendMissedText };
function __setConsultVoiceDeps(d) { _deps = { ..._deps, ...d }; }
router.__setConsultVoiceDeps = __setConsultVoiceDeps;

/**
 * A rejection value is not guaranteed to be an Error. An unguarded err.message
 * on a null or undefined rejection throws a TypeError INSIDE the catch, the
 * async handler then rejects, Express 4 does not await it, and NO RESPONSE IS
 * EVER SENT: the leg hangs until Twilio times out. That is not a 5xx, but it is
 * not a TwiML answer either. consultCallChain's captureError guards the same
 * value for the same reason.
 */
function errText(err) {
  return (err && err.message) || err;
}

function sendTwiml(res, body) {
  res.set('Content-Type', 'text/xml').send(`${XML_DECL}${body}`);
}

/** Polite dead-end: never a 500, never an empty ring. */
function apologyTwiml(res) {
  sendTwiml(res, '<Response><Say>Sorry, this consult call has expired. Goodbye.</Say><Hangup/></Response>');
}

/**
 * Fail-closed signature gate. Returns true when the request may proceed; false
 * means the 403 has already been sent. No dev skip, by design.
 */
function requireSignature(req, res, tag) {
  if (_deps.isValidTwilioRequest(req)) return true;
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage('Twilio consult-call webhook signature failure', {
      level: 'warning', tags: { webhook: 'twilio-voice-consult', route: tag, reason: 'invalid_signature' },
    });
  }
  res.status(403).send('Invalid signature');
  return false;
}

/** Positive-int route param or null (attempt ids are BIGSERIAL). */
function parseAttemptId(raw) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 && String(n) === String(raw).trim() ? n : null;
}

function parseLeg(raw) {
  return raw === 'admin' || raw === 'va' ? raw : null;
}

/** 0 (the Zul leg) through 3 (the last admin ring), or null. */
function parseRing(raw) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n <= MAX_ADMIN_RINGS && String(n) === String(raw).trim() ? n : null;
}

/**
 * Which play of the briefing this is, 1 through MAX_BRIEFING_PLAYS. Anything
 * outside that range starts over at 1 rather than being echoed: the value goes
 * into a TwiML attribute and into the replay budget, and a bare
 * `parseInt(...) || 1` would pass a negative straight through both.
 */
function parsePlay(raw) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 && n <= MAX_BRIEFING_PLAYS ? n : 1;
}

/** Explicit column list: column ORDER differs between a fresh database and dev/prod. */
async function loadAttempt(attemptId) {
  const r = await _deps.pool.query(
    `SELECT a.id, a.status, a.admin_ring, a.scheduled_at, a.answered_by, a.detail,
            c.booker_name, c.booker_phone,
            p.id AS proposal_id, p.event_date, p.guest_count
       FROM consult_call_attempts a
       JOIN consults c ON c.id = a.consult_id
       LEFT JOIN proposals p ON p.id = c.proposal_id
      WHERE a.id = $1`,
    [attemptId]
  );
  return r.rows[0] || null;
}

/**
 * Is this callback the one the row is actually waiting on? The admin half
 * carries the ring, so a redelivered ring 1 callback arriving while ring 2 is
 * live is answered with the apology instead of a replayed briefing (R5).
 */
function legMatches(row, leg, ring) {
  if (!row) return false;
  if (leg === 'admin') return row.status === 'calling_admin' && Number(row.admin_ring) === ring;
  return row.status === 'calling_va';
}

/**
 * POST /answer?attempt&leg&ring&play — the agent leg's TwiML. Gather wraps the
 * spoken briefing; a second <Say> is the one automatic repeat; then hang up
 * (voicemail can never press 1, so the status callback advances the chain).
 */
router.post('/answer', async (req, res) => {
  try {
    if (!requireSignature(req, res, '/answer')) return;
    const attemptId = parseAttemptId(req.query.attempt);
    const leg = parseLeg(req.query.leg);
    const ring = parseRing(req.query.ring);
    if (!attemptId || !leg || ring === null) return apologyTwiml(res);

    const row = await loadAttempt(attemptId);
    if (!legMatches(row, leg, ring)) return apologyTwiml(res);

    const play = parsePlay(req.query.play);
    const briefing = xmlEscape(buildConsultBriefing({
      bookerName: row.booker_name,
      scheduledAt: row.scheduled_at,
      ring: Number(row.admin_ring),
      forVa: leg === 'va',
      // Zul must never be told Dallas missed a call he was never rung for:
      // with ADMIN_PHONE unset her leg is the FIRST leg and admin_ring is 0.
      adminWasRung: Number(row.admin_ring) > 0,
      eventDate: row.event_date,
      guestCount: row.guest_count,
      proposalId: row.proposal_id,
    }));
    // Attribute-value invariant: every value below is a validated integer or a
    // fixed enum. The booker's name is free text and lives in element text only.
    const ringOut = leg === 'admin' ? Number(row.admin_ring) : ring;
    const action = xmlEscape(`/api/voice/consult/digit?attempt=${attemptId}&leg=${leg}&ring=${ringOut}&play=${play}`);
    sendTwiml(res,
      `<Response>`
        + `<Gather numDigits="1" timeout="10" method="POST" action="${action}">`
          + `<Say>${briefing}</Say>`
        + `</Gather>`
        + `<Say>${briefing}</Say>`
        + `<Hangup/>`
      + `</Response>`
    );
  } catch (err) {
    console.error('[voiceConsultCall] /answer failed:', errText(err));
    if (!res.headersSent) apologyTwiml(res);
  }
});

/**
 * POST /digit?attempt&leg&ring&play — Gather action. 1 = claim the bridge and
 * dial the booker; 9 = replay (max 3 plays); anything else = hang up and let
 * the status callback advance the chain.
 */
router.post('/digit', async (req, res) => {
  try {
    if (!requireSignature(req, res, '/digit')) return;
    const attemptId = parseAttemptId(req.query.attempt);
    const leg = parseLeg(req.query.leg);
    const ring = parseRing(req.query.ring);
    if (!attemptId || !leg || ring === null) return apologyTwiml(res);
    const digits = String((req.body && req.body.Digits) || '').trim();

    if (digits === '9') {
      const play = parsePlay(req.query.play) + 1;
      if (play > MAX_BRIEFING_PLAYS) return apologyTwiml(res);
      const next = xmlEscape(`/api/voice/consult/answer?attempt=${attemptId}&leg=${leg}&ring=${ring}&play=${play}`);
      return sendTwiml(res, `<Response><Redirect method="POST">${next}</Redirect></Response>`);
    }

    if (digits !== '1') {
      // Explicit pass (or a pocket-dialed digit): end the leg and let the
      // status callback move the chain on.
      return sendTwiml(res, '<Response><Hangup/></Response>');
    }

    // Press 1, the moment a billed call to the CLIENT is placed. Order matters
    // and is deliberate: validate the dial target, then re-check the consult,
    // and only then claim.
    const row = await loadAttempt(attemptId);
    if (!legMatches(row, leg, ring)) return apologyTwiml(res);

    // Dial-target law, second checkpoint (the first is at chain-open). A
    // post-claim validation failure would strand the row as 'connected' with no
    // bridge, and 'connected' is deliberately never reaped, so the chain would
    // be invisible forever. Validate-first just apologizes, the leg ends, and
    // the status callback advances the chain as usual.
    const target = row.booker_phone ? toUsE164(row.booker_phone) : null;
    if (!target) return apologyTwiml(res);

    // The consult itself may have been cancelled, completed or moved while the
    // phone was ringing. Speak the cancellation and DO NOT claim: the leg's own
    // status callback then lands the chain in skipped_cancelled normally.
    const guard = await _deps.guardStillScheduled(attemptId);
    if (!guard.ok) {
      console.log(`[voiceConsultCall] press 1 on a consult that is no longer scheduled (attempt ${attemptId}, ${guard.detail})`);
      return sendTwiml(res, '<Response><Say>This consult was cancelled. Goodbye.</Say><Hangup/></Response>');
    }

    // Claim the bridge. The guard makes a stale or duplicated webhook a polite
    // no-op instead of a second billed dial. R9: admin_ring is bound and cast
    // for BOTH legs; the va leg passes null and its disjunct short-circuits.
    const expected = leg === 'admin' ? 'calling_admin' : 'calling_va';
    const claim = await _deps.pool.query(
      `UPDATE consult_call_attempts
          SET status = 'connected', answered_by = $2, bridge_started_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = $3
          AND ($3 <> 'calling_admin' OR admin_ring = $4::smallint)`,
      [attemptId, leg, expected, leg === 'admin' ? ring : null]
    );
    if (claim.rowCount !== 1) return apologyTwiml(res);

    // Attribute-value invariant: xmlEscape covers & < > but NOT quotes, so every
    // attribute below must stay a validated integer, a fixed enum, an env value,
    // or toUsE164 output. Free text belongs in element text only.
    const action = xmlEscape(`/api/voice/consult/dialend?attempt=${attemptId}&leg=${leg}`);
    const statusCb = xmlEscape(`${API_URL}/api/voice/consult/status?attempt=${attemptId}&leg=client`);
    sendTwiml(res,
      `<Response>`
        + `<Dial answerOnBridge="true" callerId="${xmlEscape(callerIdFor(leg))}" timeLimit="${timeLimitSec()}" action="${action}">`
          + `<Number statusCallback="${statusCb}">${xmlEscape(target)}</Number>`
        + `</Dial>`
      + `</Response>`
    );
  } catch (err) {
    console.error('[voiceConsultCall] /digit failed:', errText(err));
    if (!res.headersSent) apologyTwiml(res);
  }
});

/**
 * POST /dialend?attempt&leg — the <Dial> action: how the bridged call to the
 * booker ended. One of MISSED_DIAL_STATUSES means the client did not pick up,
 * which is the one thing the agent on the line cannot tell from a Twilio
 * status: latch it, text Dallas once, and read the number back so he can try
 * again. Everything else, 'completed' included, hangs up silently.
 *
 * The latch is its own column, NOT a string in `detail` (ruling R14):
 * placeLeg's catch writes a Twilio error code into `detail` earlier in the same
 * chain, and a detail-based latch would then match zero rows and silently drop
 * the text. The row stays 'connected', which is terminal and never reaped.
 */
router.post('/dialend', async (req, res) => {
  try {
    if (!requireSignature(req, res, '/dialend')) return;
    const attemptId = parseAttemptId(req.query.attempt);
    const dialStatus = String((req.body && req.body.DialCallStatus) || '').trim();
    // Allowlist, not a denylist: only an explicitly recognized miss costs money
    // or contradicts what the agent just heard.
    if (!attemptId || !MISSED_DIAL_STATUSES.has(dialStatus)) {
      return sendTwiml(res, '<Response><Hangup/></Response>');
    }

    const latched = await _deps.pool.query(
      `UPDATE consult_call_attempts
          SET client_no_answer_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'connected' AND client_no_answer_at IS NULL`,
      [attemptId]
    );
    // Text-exactly-once law: only the latch winner notifies. Twilio delivers
    // this callback at-least-once.
    if (latched.rowCount === 1) {
      await _deps.sendMissedText({ attemptId, kind: 'client_no_answer' });
    }

    // Re-derived through toUsE164 rather than read raw: the spoken number is
    // the one we would actually dial. A number edited out mid-chain says what
    // is known instead of reading back something nobody can call.
    const row = await loadAttempt(attemptId);
    const target = row && row.booker_phone ? toUsE164(row.booker_phone) : null;
    const line = target
      ? `They did not answer. Their number is ${formatUsPhoneForText(target)}. Goodbye.`
      : 'They did not answer. Goodbye.';
    sendTwiml(res, `<Response><Say>${xmlEscape(line)}</Say><Hangup/></Response>`);
  } catch (err) {
    console.error('[voiceConsultCall] /dialend failed:', errText(err));
    if (!res.headersSent) sendTwiml(res, '<Response><Hangup/></Response>');
  }
});

/**
 * POST /status?attempt&leg&ring — statusCallback for every leg. The agent legs
 * hand off to onLegTerminal, which owns every non-initial transition; the
 * client leg records how long the bridge lasted.
 */
router.post('/status', async (req, res) => {
  try {
    if (!requireSignature(req, res, '/status')) return;
    const attemptId = parseAttemptId(req.query.attempt);
    const leg = req.query.leg === 'client' ? 'client' : parseLeg(req.query.leg);
    const ring = parseRing(req.query.ring);
    const callStatus = String((req.body && req.body.CallStatus) || '').trim();
    if (!attemptId || !leg) return sendTwiml(res, '<Response/>');

    // R25 gate 1, and it must come BEFORE any write: a non-terminal status is a
    // complete no-op. See TERMINAL_STATUSES above for what a leak would cost.
    if (!TERMINAL_STATUSES.has(callStatus)) {
      console.log(`[voiceConsultCall] ignoring non-terminal status '${callStatus}' for attempt ${attemptId} leg ${leg}`);
      return sendTwiml(res, '<Response/>');
    }

    if (leg === 'client') {
      // Digits only: parseInt would turn '3.5' into 3 and '12abc' into 12, and
      // the column is INTEGER, so an absurdly long run of digits is refused
      // rather than left to overflow mid-statement.
      const raw = String((req.body && req.body.CallDuration) || '').trim();
      const duration = /^\d{1,9}$/.test(raw) ? Number(raw) : null;
      // COALESCE, not a bare assignment: Twilio delivers at-least-once, and a
      // redelivery carrying a missing or malformed CallDuration would otherwise
      // ERASE the good value the first delivery recorded. writeLegStatus in
      // consultCallChain refuses the symmetric case for the same reason.
      await _deps.pool.query(
        `UPDATE consult_call_attempts
            SET bridge_duration_sec = COALESCE($2::int, bridge_duration_sec), updated_at = NOW()
          WHERE id = $1`,
        [attemptId, duration]
      );
      return sendTwiml(res, '<Response/>');
    }

    // The agent legs. Every guard (the ring match, the claim, the kill switch,
    // the too-late bounds) lives inside onLegTerminal, which is also called by
    // placeLeg's create-failure path, so both doors share one implementation.
    await _deps.onLegTerminal({ attemptId, leg, ring, callStatus });
    sendTwiml(res, '<Response/>');
  } catch (err) {
    console.error('[voiceConsultCall] /status failed:', errText(err));
    // 200 regardless: Twilio retries a 5xx, and every claim above already
    // guards against the duplicate that retry would deliver.
    if (!res.headersSent) sendTwiml(res, '<Response/>');
  }
});

module.exports = router;
