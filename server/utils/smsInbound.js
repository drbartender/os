// Inbound-SMS processing for the Twilio webhook (POST /api/sms/inbound).
// Pure helpers here; DB-touching helpers and the orchestrator are appended
// in later tasks.

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'end', 'cancel', 'quit']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);

/**
 * Classify a message body as an opt-out / opt-in keyword.
 * Matches only when the ENTIRE trimmed body is a single keyword (Twilio's
 * own STOP handling works the same way — "stop by later" is not an opt-out).
 *
 * @param {string} body
 * @returns {'stop'|'start'|null}
 */
function detectOptKeyword(body) {
  if (!body || typeof body !== 'string') return null;
  const word = body.trim().toLowerCase();
  if (STOP_WORDS.has(word)) return 'stop';
  if (START_WORDS.has(word)) return 'start';
  return null;
}

/**
 * Classify a message body as a staff shift response code (spec section 3).
 * Whole-body match only — a code buried in a sentence is treated as
 * free-form text and routed to the admin instead.
 *
 * @param {string} body
 * @returns {'confirm'|'cant'|null}
 */
function detectResponseCode(body) {
  if (!body || typeof body !== 'string') return null;
  const word = body.trim().toLowerCase().replace(/['’]/g, '');
  if (word === 'confirm') return 'confirm';
  if (word === 'cant') return 'cant';
  return null;
}

module.exports = { detectOptKeyword, detectResponseCode };
