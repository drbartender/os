// server/routes/voicemailListen.js
//
// The voicemail listen link (spec 2026-08-10). The primary line's alert SMS
// carries only the caller's number, so without this the message CONTENT is
// unreachable without opening the Twilio console. GET /api/voice/vm/:token
// streams the retained recording so tapping the link in the text plays it.
//
// Its own router file, mounted at /api/voice/vm ahead of /api/voice, the shape
// voiceLeadCall.js and voiceEscalate.js already use. server/routes/voice.js sits
// at its 700-line soft cap and this concern is separately reviewable.
//
// SECURITY: the token is the ONLY input. The recording SID is read from the row
// and never accepted from the request, which is the line between a listen link
// and an open proxy into our Twilio account. The media URL and the account
// credentials are used server-side and never appear in a response.
//
// The bare UUID stands as sole auth on ONE argument, and it is not the
// proposals/invoices precedent: those documents belong to their recipient, so a
// leak by the recipient exposes only their own. Here the audio belongs to a
// THIRD PARTY (a client who never asked for a link to exist), and what makes it
// acceptable is that the link is only ever sent to VM_TEXT_DESTINATION, a
// single pinned operator number who can already hear every voicemail in the
// Twilio console. Nobody gains access they did not already have. If that
// recipient ever stops being the operator, this model must be revisited.
//
// REVOKING ONE LINK (incident procedure, one row, no deploy):
//   UPDATE voicemail_delivery SET listen_token = gen_random_uuid()
//    WHERE call_sid = $1;
// The route reads the token live on every request, so the old URL dies at once
// and the ledger row is preserved. VM_LISTEN_LINK_ENABLED=false is the blunt
// alternative: it kills EVERY link, including ones already sent.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { requireUuidToken } = require('../utils/tokens');
const asyncHandler = require('../middleware/asyncHandler');
const voicemail = require('../utils/voicemail');

const router = express.Router();

// The link's own lifetime bound, NOT borrowed from the row prune. The prune
// (pendingCall.js) deliberately RETAINS 'recorded' / 'failed' / 'skipped' rows
// past retention because their audio is still in Twilio undelivered, so a token
// on one of those rows would otherwise never expire. Owning the bound here also
// decouples this link from a status allowlist tuned to a different question,
// which would silently extend every link if edited (security-review MEDIUM-2).
const LISTEN_LINK_MAX_AGE = '30 days';
// LOOKUP_SQL is exported so a dbTest can execute the EXACT statement the route
// runs: the stubbed-pool tests prove the handler, this proves the predicates.
const LOOKUP_SQL = `SELECT call_sid, recording_sid
                      FROM voicemail_delivery
                     WHERE listen_token = $1
                       AND line = 'primary'
                       AND recording_sid IS NOT NULL
                       AND created_at > NOW() - $2::interval`;
router.LOOKUP_SQL = LOOKUP_SQL;
router.LISTEN_LINK_MAX_AGE = LISTEN_LINK_MAX_AGE;

let _deps = {
  pool,
  fetchRecordingMp3Once: (...a) => voicemail.fetchRecordingMp3Once(...a),
  listenLinkEnabled: (...a) => voicemail.listenLinkEnabled(...a),
};
function __setListenDeps(d) { _deps = { ..._deps, ...d }; }
router.__setListenDeps = __setListenDeps;

// Per-IP cap. Unlike the voice webhooks there is no live caller on this path, so
// a bare 429 is correct here. The real anti-enumeration control is the 122-bit
// token; this only blunts a scripted sweep.
const listenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

/** One 404 for every miss: unknown token, wrong line, recording gone, switch off.
 *  Byte-identical so nothing distinguishes them to a prober. */
function notFound(res) {
  res.status(404).type('text/plain').send('Not found');
}

/**
 * GET /api/voice/vm/:token — stream the recording for this token.
 *
 * requireUuidToken runs FIRST so a non-UUID param 404s before touching the DB
 * (a UUID column casts-and-throws 22P02 on junk, which would surface as a 500).
 */
router.get('/:token', listenLimiter, requireUuidToken('token'), asyncHandler(async (req, res) => {
  if (!_deps.listenLinkEnabled()) return notFound(res);

  let row;
  try {
    const { rows } = await _deps.pool.query(LOOKUP_SQL, [req.params.token, LISTEN_LINK_MAX_AGE]);
    row = rows[0];
  } catch (err) {
    console.error(`[vm-listen] lookup failed: ${err.message}`);
    return res.status(502).type('text/plain').send('Unavailable');
  }
  if (!row) return notFound(res);

  const tail = `sid=...${String(row.call_sid || '').slice(-4)}`;
  let audio;
  try {
    audio = await _deps.fetchRecordingMp3Once(row.recording_sid);
  } catch (err) {
    // 404 at Twilio means the audio is genuinely gone (deleted, or aged out).
    // Anything else is our problem, not the listener's, and must not masquerade
    // as "no such voicemail".
    if (err.status === 404) {
      console.warn(`[vm-listen] recording gone ${tail}`);
      return notFound(res);
    }
    console.error(`[vm-listen] media fetch failed ${tail}: ${err.message}`);
    return res.status(502).type('text/plain').send('Unavailable');
  }

  res.set({
    'Content-Type': 'audio/mpeg',
    'Content-Disposition': 'inline; filename="voicemail.mp3"',
    // Never cached by an intermediary, never crawled: this is a client's voice.
    'Cache-Control': 'no-store, private',
    'X-Robots-Tag': 'noindex, nofollow',
    // Do not let another origin embed a client's voice as a subresource; the
    // app sets crossOriginResourcePolicy: 'cross-origin' globally.
    'Cross-Origin-Resource-Policy': 'same-origin',
    // Range support is not decoration here: iOS Safari's media stack probes
    // with `Range: bytes=0-1` and wants a 206 before it will play at all, and
    // the only reader of this link is a phone. Without it the likely outcome
    // is not "cannot seek", it is "does not play" (security-review MEDIUM-4).
    'Accept-Ranges': 'bytes',
    // One ETag over the FULL representation, set before the Range branch.
    // Express generates its own from whatever body it sends, so a 206 would
    // otherwise be tagged with a hash of the SLICE, and RFC 9110 wants a 206's
    // validator to identify the whole thing.
    //
    // STRONG (no `W/`) deliberately. `If-Range` mandates the strong comparison
    // function, which a weak validator can never satisfy, so a `W/` tag would
    // make iOS discard its partial and refetch the whole body — a second
    // authenticated Twilio media GET per playback. Strong is honest here: a
    // recording SID identifies immutable bytes at Twilio, so the same tag
    // always means the same representation.
    ETag: `"vm-${audio.length}-${String(row.recording_sid).slice(-8)}"`,
  });

  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range) {
    const last = audio.length - 1;
    let start = range[1] === '' ? null : Number(range[1]);
    let end = range[2] === '' ? null : Number(range[2]);
    // Suffix form (`bytes=-500`) means the LAST n bytes.
    if (start === null && end !== null) { start = Math.max(0, audio.length - end); end = last; }
    if (start !== null && end === null) end = last;
    if (start === null || start > last || start > end) {
      return res.status(416).set('Content-Range', `bytes */${audio.length}`).end();
    }
    end = Math.min(end, last);
    const slice = audio.subarray(start, end + 1);
    console.log(`[vm-listen] served ${tail} range=${start}-${end}/${audio.length}`);
    // res.end, NOT res.send: res.send runs Express's freshness check, which
    // downgrades a 2xx to 304 when If-None-Match matches. On this branch that
    // would emit a 304 still carrying Content-Range, which is malformed and
    // risks stalling the one client that reads these links. A conditional GET
    // is answered by the full-body path below, where a 304 is well-formed.
    res.status(206)
      .set({ 'Content-Range': `bytes ${start}-${end}/${audio.length}`, 'Content-Length': String(slice.length) });
    return res.end(slice);
  }

  console.log(`[vm-listen] served ${tail} bytes=${audio.length}`);
  res.set('Content-Length', String(audio.length));
  res.send(audio);
}));

module.exports = router;
