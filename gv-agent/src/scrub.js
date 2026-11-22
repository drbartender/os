// What may reach a log line (spec law 11). Pure.
//
// Playwright appends a call log to its error messages, and that log quotes the
// action it was running, fill("<the whole body>") included, so everything from
// its "Call log:" header on is dropped. A uuid (a proposal token, which opens
// the proposal) prints as <token>, and a phone-shaped digit run (a GV URL can
// carry the conversation's number) as #.
const CALL_LOG_RE = /\n\s*Call log:/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

function scrub(s) {
  const text = String(s == null ? '' : s);
  const cut = text.search(CALL_LOG_RE);
  return (cut >= 0 ? text.slice(0, cut).trimEnd() : text)
    .replace(UUID_RE, '<token>') // before the digit runs: a token of all digits is still a token
    .replace(PHONE_RE, '#');
}

const errText = (err) => (err && err.message) || String(err);
// The only form of a phone number a log line may carry.
const last4 = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(-4) || '????';

module.exports = { scrub, errText, last4 };
