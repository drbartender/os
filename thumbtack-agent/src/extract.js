// Pure, selector-free customer-email extraction. The caller (index.js) reads the
// pro's own email from __NEXT_DATA__ and the page's visible body text via Playwright,
// then hands both here. We return the lone OTHER email:
//   exactly one non-pro email -> ok
//   zero                      -> render_timeout (the customer email had not rendered)
//   more than one             -> ambiguous (never guess between two)
// No hashed CSS selectors, so a Thumbtack class-name change cannot break it. This was
// validated live during the 2026-06-16 de-risk (capture.js ran the same logic).
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function extractCustomerEmail({ proEmail, bodyText } = {}) {
  const pro = String(proEmail || '').toLowerCase();
  const found = String(bodyText || '').match(EMAIL_RE) || [];
  const nonPro = [...new Set(found.map((e) => e.toLowerCase()))].filter((e) => e && e !== pro);

  if (nonPro.length === 0) return { status: 'render_timeout', customerEmail: null };
  if (nonPro.length > 1) return { status: 'ambiguous', customerEmail: null, candidates: nonPro };
  return { status: 'ok', customerEmail: nonPro[0] };
}

module.exports = { extractCustomerEmail };
