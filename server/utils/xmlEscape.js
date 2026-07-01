/**
 * Escape XML metacharacters (& < >) for safe interpolation into TwiML element
 * text. Extracted from the inline copy in server/routes/sms.js (the inbound-SMS
 * <Message> handler) so the SMS route and the new voice TwiML routes share one
 * implementation. Order matters: & is escaped first.
 *
 * Only for ELEMENT TEXT, never attribute values (quotes are intentionally not
 * escaped). The only value ever interpolated by callers is a validated E.164
 * phone number in <Number> text.
 *
 * @param {*} s - value to escape (coerced to String)
 * @returns {string}
 */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { xmlEscape };
