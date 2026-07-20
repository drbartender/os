/**
 * Lead call bridge Twilio webhooks (spec 2026-07-18 section 4.3), mounted at
 * /api/voice/lead:
 *
 *   POST /answer  agent leg answered: Gather-wrapped spoken briefing
 *   POST /digit   Gather action: 1 bridges to the lead, 9 replays, else bye
 *   POST /status  statusCallback for every leg: claim-guarded chain advance
 *
 * Signature policy: FAIL CLOSED IN EVERY ENVIRONMENT (telegram.js precedent,
 * NOT voice.js's dev warn-and-allow). These endpoints speak client PII and
 * place billed calls; a dev box against the shared DB must never serve them
 * unsigned. Tests stub the gate via __setLeadVoiceDeps.
 *
 * State machine law: every transition is a guarded UPDATE keyed on the
 * expected prior status; every billed or notifying side effect fires only for
 * the claim winner (advanceChain/sendChainEmail own that logic). Twilio
 * delivers status callbacks at-least-once; duplicates must no-op.
 */

const express = require('express');
const Sentry = require('@sentry/node');
const { xmlEscape } = require('../utils/xmlEscape');
const { isValidTwilioRequest } = require('../utils/twilioSignature');
const { pool } = require('../db');
const { advanceChain } = require('../utils/leadCallTrigger');
const { buildLeadBriefing } = require('../utils/leadCallBriefing');
const { toUsE164 } = require('../utils/usPhone');
const { API_URL } = require('../utils/urls');

const router = express.Router();

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const TERMINAL_STATUSES = new Set(['completed', 'no-answer', 'busy', 'failed', 'canceled']);
const MAX_BRIEFING_PLAYS = 3;

// Bridge duration below this floor is a relay refusal / instant drop, not a
// conversation: the lead must NOT be marked contacted (spec 4.1).
const CONTACTED_MIN_BRIDGE_SEC = 20;

function timeLimitSec() {
  return parseInt(process.env.VA_CALL_TIME_LIMIT_SEC, 10) || 1800;
}

// Dependency-injection seam for tests (mirrors voice.js __setVoiceDeps).
let _deps = { isValidTwilioRequest, pool, advanceChain };
function __setLeadVoiceDeps(d) { _deps = { ..._deps, ...d }; }
router.__setLeadVoiceDeps = __setLeadVoiceDeps;

function sendTwiml(res, body) {
  res.set('Content-Type', 'text/xml').send(`${XML_DECL}${body}`);
}

/** Polite dead-end: never a 500, never an empty ring. */
function apologyTwiml(res) {
  sendTwiml(res, '<Response><Say>Sorry, this lead call has expired. Goodbye.</Say><Hangup/></Response>');
}

/**
 * Fail-closed signature gate. Returns true when the request may proceed;
 * false means the 403 has already been sent. No dev skip, by design.
 */
function requireSignature(req, res, tag) {
  if (_deps.isValidTwilioRequest(req)) return true;
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage('Twilio lead-call webhook signature failure', {
      level: 'warning', tags: { webhook: 'twilio-voice-lead', route: tag, reason: 'invalid_signature' },
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

async function loadAttempt(attemptId) {
  const r = await _deps.pool.query(
    `SELECT a.id, a.status, a.lead_id,
            l.customer_name, l.customer_phone, l.category, l.event_date,
            l.guest_count, l.location_city
     FROM lead_call_attempts a
     JOIN thumbtack_leads l ON l.id = a.lead_id
     WHERE a.id = $1`,
    [attemptId]
  );
  return r.rows[0] || null;
}

/**
 * POST /answer?attempt&leg&play — the agent leg's TwiML. Gather wraps the
 * spoken briefing; a second <Say> is the one automatic repeat; then hang up
 * (voicemail can never press 1, so the status callback advances the chain).
 */
router.post('/answer', async (req, res) => {
  if (!requireSignature(req, res, '/answer')) return;
  try {
    const attemptId = parseAttemptId(req.query.attempt);
    const leg = parseLeg(req.query.leg);
    if (!attemptId || !leg) return apologyTwiml(res);

    const row = await loadAttempt(attemptId);
    if (!row || (row.status !== 'calling_admin' && row.status !== 'calling_va')) {
      return apologyTwiml(res);
    }

    const play = parseInt(req.query.play, 10) || 1;
    const briefing = xmlEscape(buildLeadBriefing(row));
    const action = xmlEscape(`/api/voice/lead/digit?attempt=${attemptId}&leg=${leg}&play=${play}`);
    sendTwiml(res,
      `<Response>` +
        `<Gather numDigits="1" timeout="10" method="POST" action="${action}">` +
          `<Say>${briefing}</Say>` +
        `</Gather>` +
        `<Say>${briefing}</Say>` +
        `<Hangup/>` +
      `</Response>`
    );
  } catch (err) {
    console.error('[voiceLeadCall] /answer failed:', err.message);
    apologyTwiml(res);
  }
});

/**
 * POST /digit?attempt&leg&play — Gather action. 1 = claim the bridge and dial
 * the lead from the 224; 9 = replay (max 3 plays); anything else = hang up
 * and let the status callback advance the chain.
 */
router.post('/digit', async (req, res) => {
  if (!requireSignature(req, res, '/digit')) return;
  try {
    const attemptId = parseAttemptId(req.query.attempt);
    const leg = parseLeg(req.query.leg);
    if (!attemptId || !leg) return apologyTwiml(res);
    const digits = String((req.body && req.body.Digits) || '').trim();

    if (digits === '9') {
      const play = (parseInt(req.query.play, 10) || 1) + 1;
      if (play > MAX_BRIEFING_PLAYS) return apologyTwiml(res);
      const next = xmlEscape(`/api/voice/lead/answer?attempt=${attemptId}&leg=${leg}&play=${play}`);
      return sendTwiml(res, `<Response><Redirect method="POST">${next}</Redirect></Response>`);
    }

    if (digits !== '1') {
      // Explicit pass (or pocket-dial digit): end the leg; the status
      // callback advances the chain.
      return sendTwiml(res, '<Response><Hangup/></Response>');
    }

    // Press 1: validate the bridge target BEFORE claiming (review finding:
    // a post-claim validation failure would strand the row as 'connected'
    // with no bridge, and 'connected' is deliberately never reaped). With
    // validate-first, a bad target just apologizes, the leg ends, and the
    // status callback advances the chain to the next agent as usual.
    // Defense in depth: the trigger validated at chain-open; re-validate at
    // dial time so the lead leg can never dial an unvalidated target.
    const row = await loadAttempt(attemptId);
    if (!row || (row.status !== 'calling_admin' && row.status !== 'calling_va')) {
      return apologyTwiml(res);
    }
    const target = row.customer_phone ? toUsE164(row.customer_phone) : null;
    if (!target) return apologyTwiml(res);

    // Claim the bridge. The guard makes a stale or duplicated webhook a
    // polite no-op instead of a second billed dial.
    const claim = await _deps.pool.query(
      `UPDATE lead_call_attempts
       SET status = 'connected', answered_by = $2, bridge_started_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status IN ('calling_admin', 'calling_va')
       RETURNING lead_id`,
      [attemptId, leg]
    );
    if (claim.rowCount !== 1) return apologyTwiml(res);

    // Attribute-value invariant: xmlEscape covers &<> but NOT quotes, so
    // every attribute below must stay a validated integer, fixed enum, env
    // value, or toUsE164 output. Never interpolate free text into an
    // attribute here; free text belongs in element text only.
    const statusCb = xmlEscape(`${API_URL}/api/voice/lead/status?attempt=${attemptId}&leg=lead`);
    sendTwiml(res,
      `<Response>` +
        `<Dial answerOnBridge="true" callerId="${xmlEscape(process.env.VOICE_CALLER_ID || '')}" timeLimit="${timeLimitSec()}">` +
          `<Number statusCallback="${statusCb}">${xmlEscape(target)}</Number>` +
        `</Dial>` +
      `</Response>`
    );
  } catch (err) {
    console.error('[voiceLeadCall] /digit failed:', err.message);
    apologyTwiml(res);
  }
});

/**
 * POST /status?attempt&leg — statusCallback for all legs. Twilio fires the
 * terminal callback at-least-once with the final CallStatus; every duplicate
 * must be a no-op (the claims inside advanceChain / the missed UPDATE carry
 * that guarantee).
 */
router.post('/status', async (req, res) => {
  try {
    if (!requireSignature(req, res, '/status')) return;
    const attemptId = parseAttemptId(req.query.attempt);
    const leg = req.query.leg === 'lead' ? 'lead' : parseLeg(req.query.leg);
    const callStatus = String((req.body && req.body.CallStatus) || '');
    if (!attemptId || !leg) return sendTwiml(res, '<Response/>');

    if (!TERMINAL_STATUSES.has(callStatus)) {
      console.log(`[voiceLeadCall] ignoring non-terminal status '${callStatus}' for attempt ${attemptId} leg ${leg}`);
      return sendTwiml(res, '<Response/>');
    }

    if (leg === 'lead') {
      const rawDuration = parseInt((req.body && req.body.CallDuration), 10);
      const duration = Number.isInteger(rawDuration) && rawDuration >= 0 ? rawDuration : null;
      await _deps.pool.query(
        `UPDATE lead_call_attempts SET bridge_duration_sec = $2, updated_at = NOW() WHERE id = $1`,
        [attemptId, duration]
      );
      if (duration !== null && duration >= CONTACTED_MIN_BRIDGE_SEC) {
        // A real conversation happened: the lead lifecycle advances. A
        // near-zero bridge (relay refusal) must NOT hide the lead from
        // follow-up surfaces, so no flip below the floor.
        await _deps.pool.query(
          `UPDATE thumbtack_leads SET status = 'contacted', updated_at = NOW()
           WHERE id = (SELECT lead_id FROM lead_call_attempts WHERE id = $1) AND status = 'new'`,
          [attemptId]
        );
      }
      return sendTwiml(res, '<Response/>');
    }

    // Agent leg terminal. Record the per-leg disposition unconditionally
    // (it is telemetry, not a claim), then advance only from this leg's
    // calling_* state: a leg that already pressed 1 leaves the row
    // 'connected' and both branches below no-op on their guards.
    const statusCol = leg === 'admin' ? 'admin_call_status' : 'va_call_status';
    await _deps.pool.query(
      `UPDATE lead_call_attempts SET ${statusCol} = $2, updated_at = NOW() WHERE id = $1`,
      [attemptId, callStatus.slice(0, 40)]
    );

    if (leg === 'admin') {
      await _deps.advanceChain({ attemptId, fromLeg: 'admin' });
    } else {
      // Missed is a terminal log state, NOT an alert (2026-07-20 per Dallas:
      // the moment has passed; follow-up is the normal email/SMS pipeline).
      // Only chain FAILURES email, via advanceChain/reaper.
      await _deps.pool.query(
        `UPDATE lead_call_attempts SET status = 'missed', updated_at = NOW()
         WHERE id = $1 AND status = 'calling_va'`,
        [attemptId]
      );
    }
    sendTwiml(res, '<Response/>');
  } catch (err) {
    console.error('[voiceLeadCall] /status failed:', err.message);
    // 200 regardless: Twilio retries 5xx and the claims already guard state.
    if (!res.headersSent) sendTwiml(res, '<Response/>');
  }
});

module.exports = router;
