// server/routes/voiceAssets.js
//
// The static audio Twilio <Play>s during a call: greetings, the press-1
// acknowledgment, and the "nobody's available" message. Split out of
// server/routes/voice.js for the reason voicemailListen.js was: that file sits
// at its 700-line soft cap, and static asset serving is a separate concern that
// is easier to review on its own.
//
// PUBLIC and unauthenticated by necessity. Twilio fetches these with no
// credentials and no signature, and there is nothing to gate: no DB, no caller
// input, no side effects. They are recordings of our own outgoing greetings,
// not anybody's private audio (that is voicemailListen.js, which IS token-gated).
//
// SECURITY: the request never names a file. `:name` is an OWN-PROPERTY key in a
// fixed map, so no value of it can traverse out of server/assets/ or reach a
// file we did not intend to publish. Adding audio means adding a line here.
//
// The own-property check is load-bearing, not ceremony: a bare `ASSETS[key]`
// also reads Object.prototype, so 'constructor', '__proto__', and 'toString'
// all return truthy non-strings, sail past a falsy check, and throw inside
// path.join. That is not a traversal (nothing inherited is a string), but it is
// an unauthenticated 500 on a public route, and this app reports unknown errors
// to Sentry, so it converts one request into one billed event.

const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const ASSETS = Object.freeze({
  // Zul's line, recorded 2026-07-24. The default target of VM_GREETING_URL, so
  // this key is load-bearing: renaming it silently breaks her greeting.
  'greeting.mp3': 'voicemail-greeting.mp3',
  // Dallas's line, recorded 2026-08-19 (spec 2026-08-19). 8kHz mono, the rate a
  // phone line actually carries.
  'primary-greeting-day.mp3': 'primary-greeting-day.mp3',
  'primary-greeting-night.mp3': 'primary-greeting-night.mp3',
  'primary-escalate-ack.mp3': 'primary-escalate-ack.mp3',
  'primary-escalate-failed.mp3': 'primary-escalate-failed.mp3',
  // Zul's line, recorded 2026-08-19. Her day greeting SAYS the press-1 offer,
  // unlike the 2026-07-24 mp3 above, which is why the slot table can stop
  // appending the synthetic prompt on her line.
  'zul-greeting-day.mp3': 'zul-greeting-day.mp3',
  'zul-greeting-night.mp3': 'zul-greeting-night.mp3',
  'zul-escalate-ack.mp3': 'zul-escalate-ack.mp3',
  'zul-escalate-failed.mp3': 'zul-escalate-failed.mp3',
});

function serveAsset(req, res, key) {
  const file = Object.prototype.hasOwnProperty.call(ASSETS, key) ? ASSETS[key] : null;
  // 404 rather than 400: an unknown key is indistinguishable from a typo'd URL,
  // and this surface should tell an unauthenticated prober nothing.
  if (typeof file !== 'string') return res.status(404).type('text/plain').send('Not found');
  res.type('audio/mpeg');
  // One hour, not a day. Twilio caches <Play> sources, so a longer TTL turns
  // "re-record and redeploy under the same filename" into an hours-long wait
  // before callers hear the new take. Set on the SUCCESS path only: a 500 from
  // a missing file must never be cached.
  res.set('Cache-Control', 'public, max-age=3600');
  return res.sendFile(path.join(__dirname, '..', 'assets', file), (err) => {
    if (!err) return;
    // The primary line's DEFAULT greeting is one of these files, so a missing
    // one is a caller hearing silence. Never let that be silent server-side too.
    console.error(`[voiceAssets] failed to send ${file}: ${err.message}`);
    if (!res.headersSent) { res.removeHeader('Cache-Control'); res.status(500).end(); }
  });
}

// Twilio fetches these MID-CALL, so saturating the origin means a real client
// hears silence where the greeting should be. Every sibling public voice route
// carries a limiter; this one is 115KB per hit, so it needs one more than most.
// Sized ABOVE the app's own admitted worst case, not below it: VA_INBOUND_PER_MIN_CAP
// admits 30 calls/min per line and a primary miss fetches up to 3 clips, so ~90/min
// is reachable on a cold Twilio cache right after a deploy. A 60 bucket would 429
// exactly then, Twilio would skip the <Play>, and the caller would hear the silence
// this limiter exists to prevent. 300 still stops a scripted sweep of a 115KB file.
const assetLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  // Explicit, like every sibling voice limiter: `trust proxy` is set app-wide,
  // so this is Twilio's real media IP rather than one shared edge address.
  keyGenerator: (req) => req.ip,
});

// Kept at its original path: VM_GREETING_URL defaults to this exact URL, and
// production has been fetching it since 2026-07-24.
router.get('/greeting.mp3', assetLimiter, (req, res) => serveAsset(req, res, 'greeting.mp3'));

router.get('/audio/:name', assetLimiter, (req, res) => serveAsset(req, res, req.params.name));

module.exports = { router, ASSETS };
