// Post-send verification decisions for the auto first reply, kept pure and
// out of the Playwright glue so the judgments that matter are unit-testable.
//
// WHY THIS EXISTS (2026-08-22 regression, root-caused 8/26): Thumbtack now
// navigates the tab OFF the lead thread back to /pro-leads the moment Send is
// clicked. The in-place proof (template text visible in the thread AND the
// composer read back empty) is unobservable on the leads list, so it timed out
// on every send and reported `send_unverified` — six confirmed real deliveries
// filed as failures. The fix re-opens the thread and proves the text is there.
//
// The fail-closed law is unchanged: the redirect itself is NEVER read as proof
// of a send. Only seeing the text we sent, rendered on the thread, is proof.

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Enough words to identify the template, few enough to survive the thread
// bubble re-wrapping or truncating a long reply.
const SNIPPET_WORDS = 8;

// Build the "this is our template" pattern from the text we captured in the
// composer before sending. Whitespace-flexible (the composer holds one line;
// the rendered bubble may wrap), case-insensitive, metacharacters escaped —
// a real quick reply is full of $, (, ), + and .
function snippetPattern(filledText) {
  const words = String(filledText == null ? '' : filledText)
    .trim().split(/\s+/).filter(Boolean).slice(0, SNIPPET_WORDS).map(escapeRegex);
  return new RegExp(words.join('\\s+'), 'i');
}

// Is the tab still on the lead's own thread? Mirrors the urlCarriesId check in
// replyOne so both places judge "we left the page" the same way.
function urlOnThread(url, negotiationId) {
  const u = String(url == null ? '' : url);
  const id = String(negotiationId == null ? '' : negotiationId);
  if (!u || !id) return false;
  return u.includes(id) || u.includes(encodeURIComponent(id));
}

// Does a freshly re-opened thread prove the reply was delivered?
//
// Proof = our text is VISIBLE on the thread and is not merely sitting in an
// editor. An unreadable editor does NOT block the proof: requiring the composer
// to exist is exactly the assumption that broke on 8/22, and Playwright matches
// rendered text, not a textarea's value (verified against its elementText), so
// a value-property draft cannot produce the visible match on its own.
//
// But that argument holds only while the composer stays a textarea. `editorTexts`
// is every editor-ish element's text read straight off the re-opened page, so a
// contenteditable re-skin holding a restored draft still blocks the proof. A
// "sent" we did not send is far worse than a "failed" we did: the failed path
// still fires the promised day call, a phantom sent stops Dallas following up.
function provenDelivered({ snippetVisible, editorTexts, snippetRe }) {
  if (!snippetVisible) return false;
  const editors = Array.isArray(editorTexts) ? editorTexts : [];
  return !editors.some((text) => text && snippetRe.test(text));
}

module.exports = { snippetPattern, urlOnThread, provenDelivered, SNIPPET_WORDS };
