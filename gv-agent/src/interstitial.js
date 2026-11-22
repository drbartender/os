// Classifies the page GV left us on (spec section 6, Box): any Google
// interstitial idles the sender without attempting a login. The glue passes
// only structural text (the title, headings, short control labels outside the
// conversation list), never message content, so a customer who texts
// "sign in" cannot trip this.

// The reCAPTCHA challenge frame (the spike's rule): the bframe src, opened up
// past 50 px. GV loads invisible reCAPTCHA on every page, and its idle frame
// stays collapsed.
const CHALLENGE_FRAME_RE = /recaptcha\/(api2|enterprise)\/bframe/i;

function challengeFrameVisible(frames) {
  return (Array.isArray(frames) ? frames : [])
    .some((f) => Boolean(f) && CHALLENGE_FRAME_RE.test(String(f.src || '')) && Number(f.h) > 50);
}

// Curly and modifier apostrophes read as a straight one.
const norm = (s) => String(s == null ? '' : s)
  .replace(/[\u{2018}\u{2019}\u{02BC}]/gu, "'")
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const CHALLENGE_TEXT = [/^verify it's you\b/, /unusual activity/, /unusual traffic/];
const SESSION_TEXT = [/^choose an account\b/, /^sign in\b/];

// Returns 'ok' | 'session_expired' | 'challenge'. A challenge wins: Google's
// verify-it's-you flow lives on accounts.google.com too.
function classifyPage({ host, texts, frames } = {}) {
  const t = (Array.isArray(texts) ? texts : []).map(norm).filter(Boolean);
  if (challengeFrameVisible(frames) || t.some((x) => CHALLENGE_TEXT.some((re) => re.test(x)))) return 'challenge';
  if (String(host || '').toLowerCase() === 'accounts.google.com'
    || t.some((x) => SESSION_TEXT.some((re) => re.test(x)))) return 'session_expired';
  return 'ok';
}

module.exports = { classifyPage, challengeFrameVisible };
