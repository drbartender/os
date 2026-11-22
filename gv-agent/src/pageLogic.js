// Every judgment the GV glue makes about the page, kept pure so it is unit
// tested (gvFlow.js only reads the DOM into plain values and acts). Shapes are
// the GV web UI as the 2026-10-17 spike found it (spec section 10): the
// formatted number sits between bidi marks, screen-reader twins spell the
// digits out ("3 1 2 ..."), and a chip's label reads "Remove <digits>?".
const { challengeFrameVisible } = require('./interstitial');
const { normalizeText } = require('./validate');

// Left-to-right and right-to-left marks, embeddings, overrides and isolates.
const BIDI = /[\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const str = (v) => String(v == null ? '' : v);

// The 10-digit national number, from text or a phone: exactly 10 digits, or
// 11 with a leading 1. Anything longer or shorter is not this number.
function tenDigits(v) {
  const d = str(v).replace(/\D/g, '');
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return null;
}

// The text's digits are the phone's last 10 (optionally after a leading 1),
// and nothing else: an international number that happens to end in the same
// 10 digits does not match.
function digitsEqual(text, phone) {
  const want = tenDigits(phone);
  return want !== null && tenDigits(text) === want;
}

// The negotiation id in a Thumbtack notice link (/request/{r}/bids/{bid}/...),
// also when the link is redirect-wrapped and percent-encoded.
function parseBidId(noticeHref) {
  const s = str(noticeHref);
  if (!s) return null;
  const re = /\/bids\/([A-Za-z0-9_-]+)/;
  let m = re.exec(s);
  if (!m) {
    let decoded;
    try { decoded = decodeURIComponent(s); } catch { return null; }
    m = re.exec(decoded);
  }
  return m ? m[1] : null;
}

// The one "Send to (number)" suggestion to click, or -1. entries are the
// gv-contact-list divs whose text starts with Send to, in DOM order:
// { ownText (the div's own text nodes), w, h, containsOther (indices of the
// other entries this div contains) }. A hit is rendered above 4 px (the
// screen-reader twin is 1 px), starts with Send to, and carries exactly this
// number; a hit nested inside another hit is the same entry, so the outermost
// counts. Anything but exactly one is -1: a saved contact renders as a name
// card instead, and relay numbers are never saved contacts.
function oneSendToEntry(entries, phone) {
  const list = Array.isArray(entries) ? entries : [];
  const hits = [];
  list.forEach((e, i) => {
    if (!e) return;
    const text = str(e.ownText).replace(BIDI, '');
    if (Number(e.w) > 4 && Number(e.h) > 4 && /^\s*send to\b/i.test(text) && digitsEqual(text, phone)) hits.push(i);
  });
  const outermost = hits.filter((i) => !hits.some((j) => j !== i
    && Array.isArray(list[j].containsOther) && list[j].containsOther.includes(i)));
  return outermost.length === 1 ? outermost[0] : -1;
}

// After the pick: exactly one Remove chip in the recipients region, carrying
// this number, and the recipient field emptied. A second chip of any number
// would make it a group text (spec law 9). inputValue null means no field found.
function oneRecipientChip(labels, phone, inputValue = null) {
  if (inputValue != null && str(inputValue) !== '') return false;
  const removes = (Array.isArray(labels) ? labels : []).map(str).filter((l) => /^\s*remove\b/i.test(l));
  return removes.length === 1 && digitsEqual(removes[0], phone);
}

// Sent only with both halves of the proof: one more thread message holding the
// token than the read right before the click found, AND the box emptied
// (strictly; null means unreadable). Before and after, never the token alone:
// on a resend the box's own earlier post already shows the token, so its
// presence proves nothing about this click. Anything less is unverified.
function verifyDecision(v) {
  const counted = v && Number.isInteger(v.before) && Number.isInteger(v.after);
  return counted && v.after > v.before && v.boxEmpty === true ? 'sent' : 'clicked_unverified';
}

// Is a link in the thread one the box did not post (spec law 6)? threadTexts
// are the thread's messages that hold the token; priors is the job's
// prior_bodies, already normalized (validate.priorBodies). Each distinct
// message text may show up at most as many times as the list holds it: one
// copy more is a paste. The list is an upper bound (an earlier post may never
// have landed), so fewer copies in the thread is fine. An empty list makes any
// token-holding message a paste, the rule before resends existed.
function pasteInThread(threadTexts, priors) {
  const tally = (list) => {
    const m = new Map();
    for (const t of Array.isArray(list) ? list : []) {
      const k = normalizeText(t);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  };
  const allowed = tally(priors);
  for (const [text, shown] of tally(threadTexts)) {
    if (shown > (allowed.get(text) || 0)) return true;
  }
  return false;
}

// Is this conversation-list item the one-to-one thread with the number? Some
// line of it must be nothing but this phone number: a preview that mentions
// the number, or a group title, does not count.
function threadItemMatches(lines, phone) {
  return (Array.isArray(lines) ? lines : []).some((line) => {
    const s = str(line).replace(BIDI, '').trim();
    return /^[+\d\s().-]+$/.test(s) && digitsEqual(s, phone);
  });
}

// Every Thumbtack notice in an open thread names a bid. A repeat customer's
// conversation holds a notice per bid, all of one customer (the server's
// identity rule serves no job otherwise), so the thread is the job's when ANY
// notice names its negotiation id, and wrong_thread (spec law 9) only when
// notices exist and none does. No notice (a thread we started) or no expected
// id (the dry run) has nothing to check. bidIds: each bid once, in page order.
function threadBids(hrefs, negotiationId) {
  const bidIds = [...new Set((Array.isArray(hrefs) ? hrefs : []).map(parseBidId).filter(Boolean))];
  const expected = str(negotiationId);
  return { bidIds, wrongThread: expected !== '' && bidIds.length > 0 && !bidIds.includes(expected) };
}

// Does any of these strings carry the proposal token? Matched on the token,
// not the URL, to survive www., slashes and a trailing period (spec law 6).
// Only a uuid-shaped token is ever matched: an empty one would match anything.
function hasToken(texts, token) {
  const t = str(token).trim().toLowerCase();
  if (!UUID_RE.test(t)) return false;
  return (Array.isArray(texts) ? texts : []).some((s) => str(s).toLowerCase().includes(t));
}

// The last look before the journal and the click: the box holds exactly the
// body, the Call panel's dialer is empty (the call-dialer trap), no challenge
// frame is open, and there is exactly one enabled Send.
function fillCheck({ value, body, callPanelValues, frames, sendCount, sendEnabled } = {}) {
  if (challengeFrameVisible(frames)) return { ok: false, reason: 'challenge' };
  const fail = { ok: false, reason: 'ui_error_before_send' };
  if (typeof body !== 'string' || value !== body) return fail;
  if ((Array.isArray(callPanelValues) ? callPanelValues : []).some((v) => str(v) !== '')) return fail;
  if (sendCount !== 1 || sendEnabled !== true) return fail;
  return { ok: true };
}

module.exports = {
  parseBidId, digitsEqual, oneSendToEntry, oneRecipientChip, verifyDecision,
  threadItemMatches, threadBids, hasToken, fillCheck, pasteInThread,
};
