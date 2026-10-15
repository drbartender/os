'use strict';

// Which mail counts, decided at sync time (spec 2026-10-14 sections 5.2 and
// 5.5), PURE: no I/O. gmailSync.js fetches a message, reads it here, applies
// classifyMessage and stores what it says. Nothing here logs: a header value
// is someone's mail.
//
// Header order matters. Gmail lists a message's headers top first, and the
// topmost Authentication-Results is the one Google's MX wrote; a later copy
// may be forged inside the message. headersOf therefore keeps the FIRST value
// of every repeated header, which is what zolaAuthPasses reads.

const { extractText } = require('./mailText');
const { zolaAuthPasses, zolaTemplateOf } = require('./zolaMail');
const { GMAIL_MAILBOX } = require('../gmailClient');
const {
  ZOLA_VENDOR_ADDRESS, DROPPED_SENDER_DOMAINS, NO_REPLY_LOCAL_RE, AUTO_REPLY_SUBJECT_RE,
} = require('./constants');

// Bounds on what a row stores (spec 5.6's rule: everything bounded before it
// reaches a row). Far past any real header.
const SUBJECT_MAX = 1000;
const NAME_MAX = 200;
const MESSAGE_ID_MAX = 500;
const REFERENCES_MAX = 50;
const ADDRESS_LIST_MAX = 500;
// RFC 5321's practical ceiling on an address, and a bound on the recipients a
// row keeps (to_addresses).
const ADDRESS_MAX = 320;
const RECIPIENTS_MAX = 200;
const GMAIL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ADDRESS_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
const MESSAGE_ID_RE = /<([^<>\s]{1,500})>/g;
const DROP_LABELS = ['DRAFT', 'SPAM', 'TRASH'];
const BOUNCE_LOCAL_RE = /^(mailer[-.]?daemon|postmaster)$/i;
// Every mail we send leaves through Gmail, so a real delivery report is
// Google's. A mailer-daemon anywhere else could be anyone, and a bounce marks
// one of our replies failed.
const BOUNCE_DOMAINS = new Set(['googlemail.com', 'google.com']);
// A message dropped once is read again when it later gains one of these
// (spec 5.2: Dallas drags a human mail into Primary). INBOX catches a mail
// rescued from Spam; SENT catches a draft that is sent under the id it had as
// a draft. A message that is already stored is never re-read either way.
const REEVALUATE_LABELS = new Set(['CATEGORY_PERSONAL', 'INBOX', 'SENT']);
// A delivery report's status part (RFC 3464, and RFC 6533's international
// form), read from at most 64 KB of its encoded body; at most BOUNCED_TO_MAX
// failed recipients are named.
const DSN_MIME_TYPES = new Set(['message/delivery-status', 'message/global-delivery-status']);
const DSN_DATA_MAX = 87384;
const BOUNCED_TO_MAX = 20;
const PART_DEPTH_MAX = 20;

const lower = (s) => String(s || '').trim().toLowerCase();
// Postgres refuses a NUL character in text, so one in a header or a body would
// fail that message on every attempt and skip a real mail for good.
const stripNul = (s) => s.replace(/\u0000/g, '');
const isString = (v) => typeof v === 'string';

// Cut on a code point, never inside a surrogate pair.
function bounded(value, max) {
  const s = String(value || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function headersOf(payload) {
  const out = new Map();
  const list = payload && Array.isArray(payload.headers) ? payload.headers : [];
  for (const h of list) {
    if (!h || !isString(h.name) || !isString(h.value)) continue;
    const name = h.name.toLowerCase();
    if (!out.has(name)) out.set(name, stripNul(h.value));
  }
  return out;
}

// An address list split on commas and semicolons outside quoted strings and
// angle brackets, with comments dropped.
function splitList(value) {
  const parts = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  let depth = 0;
  for (let i = 0; i < value.length && parts.length < ADDRESS_LIST_MAX; i += 1) {
    const ch = value.charAt(i);
    if (quoted) {
      cur += ch;
      if (ch === '\\' && i + 1 < value.length) { i += 1; cur += value.charAt(i); } else if (ch === '"') quoted = false;
    } else if (depth > 0) {
      if (ch === '\\') i += 1;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    } else if (ch === '(') {
      depth = 1;
    } else if ((ch === ',' || ch === ';') && !angle) {
      parts.push(cur);
      cur = '';
    } else {
      if (ch === '"') quoted = true;
      else if (ch === '<') angle = true;
      else if (ch === '>') angle = false;
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// The index of the first ':' outside a quoted string, or -1.
function unquotedColon(s) {
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charAt(i);
    if (ch === '\\' && quoted) i += 1;
    else if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) return i;
  }
  return -1;
}

function unquote(name) {
  const s = name.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(.)/g, '$1').trim();
  return s;
}

// One mailbox ("Name <a@b>", "a@b", "Group: a@b") as { address, name }, or null.
function mailboxOf(part) {
  let s = part;
  const lt = s.lastIndexOf('<');
  const gt = s.lastIndexOf('>');
  let name = '';
  let address;
  if (lt !== -1 && gt > lt) {
    name = s.slice(0, lt);
    address = s.slice(lt + 1, gt);
  } else {
    address = s;
  }
  const colonInName = unquotedColon(name);
  if (colonInName !== -1) name = name.slice(colonInName + 1);
  const colonInAddress = address.lastIndexOf(':');
  if (colonInAddress !== -1) address = address.slice(colonInAddress + 1);
  s = lower(address);
  if (s.length > ADDRESS_MAX || !ADDRESS_RE.test(s)) return null;
  const display = bounded(unquote(name), NAME_MAX);
  return { address: s, name: display || null };
}

function addressOf(value) {
  if (!isString(value) || value.trim() === '') return null;
  for (const part of splitList(value)) {
    const box = mailboxOf(part);
    if (box) return box;
  }
  return null;
}

// To, Cc and Bcc, lowercased, deduplicated, at most RECIPIENTS_MAX. Rule 3's
// "every recipient is ours" reads this capped list; a Sent mail with more than
// 200 recipients is a mass send either way, so the cap changes nothing there.
// names narrows the headers read (personalMail.js reads To and Cc only).
function recipientsOf(headers, names = ['to', 'cc', 'bcc']) {
  const out = [];
  const seen = new Set();
  for (const name of names) {
    const value = headers.get(name);
    if (!isString(value)) continue;
    for (const part of splitList(value)) {
      if (out.length >= RECIPIENTS_MAX) return out;
      const box = mailboxOf(part);
      if (box && !seen.has(box.address)) {
        seen.add(box.address);
        out.push(box.address);
      }
    }
  }
  return out;
}

const domainOf = (address) => address.slice(address.lastIndexOf('@') + 1);
// The local part without a +tag.
const localOf = (address) => address.slice(0, address.lastIndexOf('@')).replace(/\+.*$/, '');

// A domain on the list, or any subdomain of one (mail.stripe.com).
function isDroppedDomain(address) {
  const domain = domainOf(address);
  for (const d of DROPPED_SENDER_DOMAINS) {
    if (domain === d || domain.endsWith(`.${d}`)) return true;
  }
  return false;
}

const precedenceOf = (headers) => lower(headers.get('precedence'));

function isBulk(headers, labelIds) {
  if (!(Array.isArray(labelIds) && labelIds.includes('CATEGORY_PERSONAL'))) return true;
  if (lower(headers.get('list-unsubscribe')) !== '') return true;
  return ['bulk', 'list', 'junk'].includes(precedenceOf(headers));
}

// Auto-Submitted other than "no", X-Autoreply, X-Auto-Response-Suppress,
// Precedence auto_reply, the subject pattern, or (passed by the caller only
// for a Sent row) a body that is nothing but a calendar part.
function isAutoReply(headers, subject, hasCalendarOnly) {
  const submitted = headers.get('auto-submitted');
  if (isString(submitted) && lower(submitted.split(';')[0]) !== 'no') return true;
  if (headers.has('x-autoreply') || headers.has('x-auto-response-suppress')) return true;
  if (precedenceOf(headers) === 'auto_reply') return true;
  if (AUTO_REPLY_SUBJECT_RE.test(String(subject || '').trim())) return true;
  return Boolean(hasCalendarOnly);
}

// A delivery report from Google: its mailer-daemon or postmaster, or a Google
// sender's auto-replied multipart/report.
function isGoogleReport(headers, payload) {
  const from = addressOf(headers.get('from'));
  if (!from || !BOUNCE_DOMAINS.has(domainOf(from.address))) return false;
  if (BOUNCE_LOCAL_RE.test(localOf(from.address))) return true;
  const submitted = lower(String(headers.get('auto-submitted') || '').split(';')[0]);
  const contentType = lower(headers.get('content-type') || (payload && payload.mimeType));
  return submitted === 'auto-replied' && contentType.startsWith('multipart/report');
}

function findPart(part, mimeTypes, depth) {
  if (!part || typeof part !== 'object' || depth > PART_DEPTH_MAX) return null;
  if (mimeTypes.has(lower(part.mimeType))) return part;
  for (const kid of Array.isArray(part.parts) ? part.parts : []) {
    const hit = findPart(kid, mimeTypes, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// "rfc822; Lee@Example.com" as the address the row's to_addresses would hold,
// or null for another address type, a non-address or an overlong one.
function finalRecipientOf(value) {
  let s = lower(value).replace(/^rfc822\s*;/, '').trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  return s.length <= ADDRESS_MAX && ADDRESS_RE.test(s) ? s : null;
}

// The message/delivery-status part (RFC 3464) Gmail handed us inline, read:
// every recipient's Action, and the Final-Recipient of each that failed. Null
// when there is no such part or no recipient in it. The fields come in
// groups split by blank lines (the first describes the message); a folded
// line is joined to the one above it.
function deliveryStatusOf(payload) {
  const part = findPart(payload, DSN_MIME_TYPES, 0);
  const data = part && part.body && part.body.data;
  if (!isString(data) || data === '') return null;
  const text = Buffer.from(data.slice(0, DSN_DATA_MAX), 'base64url').toString('utf8')
    .replace(/\r\n?/g, '\n').replace(/\n[ \t]+(?=\S)/g, ' ');
  const actions = [];
  const failedTo = [];
  for (const group of text.split(/\n[ \t]*\n/)) {
    const fields = new Map();
    for (const line of group.split('\n')) {
      const colon = line.indexOf(':');
      const name = colon > 0 ? lower(line.slice(0, colon)) : '';
      if (name && !fields.has(name)) fields.set(name, line.slice(colon + 1));
    }
    if (!fields.has('action')) continue;
    const action = lower(fields.get('action')).split(/[\s(;]/)[0];
    actions.push(action);
    const to = action === 'failed' ? finalRecipientOf(fields.get('final-recipient')) : null;
    if (to && !failedTo.includes(to) && failedTo.length < BOUNCED_TO_MAX) failedTo.push(to);
  }
  return actions.length > 0 ? { actions, failedTo } : null;
}

// Google's report read as { failed, bouncedTo }, or null for mail that is no
// report from Google. A report fails only when a recipient's Action is
// "failed"; "delayed" (Google's "(Delay)" notice, which usually ends in a
// delivery), "delivered", "relayed" and "expanded" are not bounces. With no
// status part to read, a "(Delay)" subject is the tell.
function bounceOf(headers, payload) {
  if (!isGoogleReport(headers, payload)) return null;
  const status = deliveryStatusOf(payload);
  if (status) return { failed: status.actions.includes('failed'), bouncedTo: status.failedTo };
  return { failed: !/\(delay\)/i.test(String(headers.get('subject') || '')), bouncedTo: [] };
}

function isBounce(headers, payload) {
  const report = bounceOf(headers, payload);
  return Boolean(report && report.failed);
}

// Every <message-id> token in a header value, in order.
function messageIdsIn(value) {
  if (!isString(value)) return [];
  return Array.from(value.matchAll(MESSAGE_ID_RE), (m) => `<${m[1]}>`);
}

function firstMessageId(value) {
  const [first] = messageIdsIn(value);
  if (first) return first.length <= MESSAGE_ID_MAX + 2 ? first : null;
  const bare = isString(value) ? value.trim() : '';
  return bare && /^[^<>\s]{1,500}$/.test(bare) ? `<${bare}>` : null;
}

function atOf(message, nowMs) {
  const internal = Number(message.internalDate);
  if (Number.isFinite(internal) && internal > 0) return new Date(internal);
  return new Date(nowMs);
}

/**
 * The parts of one Gmail message (format=full) the sync reads and stores.
 * Throws only on a message that is not an object; every field is bounded.
 */
function parseMessage(message, { nowMs = Date.now() } = {}) {
  if (!message || typeof message !== 'object') throw new TypeError('not a Gmail message');
  const labelIds = Array.isArray(message.labelIds) ? message.labelIds.filter(isString) : [];
  const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
  const headers = headersOf(payload);
  const direction = labelIds.includes('SENT') ? 'out' : 'in';
  const from = addressOf(headers.get('from'));
  // Rule 1 before any extraction (spec 5.5 step 4): a draft, spam or trash
  // message is dropped, so none of its body is ever decoded.
  const { text, attachments, hasCalendarOnly } = DROP_LABELS.some((l) => labelIds.includes(l))
    ? { text: null, attachments: 0, hasCalendarOnly: false }
    : extractText(payload, { senderName: from ? from.name : null });
  return {
    gmailId: isString(message.id) ? message.id : '',
    threadId: isString(message.threadId) && message.threadId ? message.threadId : String(message.id || ''),
    labelIds,
    headers,
    payload,
    direction,
    fromAddress: from ? from.address : (direction === 'out' ? GMAIL_MAILBOX : ''),
    fromName: from ? from.name : null,
    recipients: recipientsOf(headers),
    subject: bounded(headers.get('subject'), SUBJECT_MAX) || null,
    messageIdHeader: firstMessageId(headers.get('message-id')),
    inReplyTo: firstMessageId(headers.get('in-reply-to')),
    references: messageIdsIn(headers.get('references')).slice(-REFERENCES_MAX),
    at: atOf(message, nowMs),
    text: text === null ? null : stripNul(text) || null,
    attachments,
    hasCalendarOnly,
  };
}

const drop = (reason) => ({ action: 'drop', reason });
const store = (kind) => ({ action: 'store', kind });

// The Zola branch runs only on a From that is exactly Zola's address, bare or
// after one display name (quoted, plain or an encoded word). A group, a list,
// a comment or a stray character could leave Google writing no DMARC result
// for zola.com while the lenient parser above still read Zola's address
// (re-verify 2026-10-15), so any other shape is a gate failure. The check is
// deterministic: one regex over the whole value backtracked cubically on
// leading whitespace (4,000 spaces took 22 s), so the value is trimmed,
// refused past ZOLA_FROM_MAX, and the display name tested on its own. The
// guard fails closed if ZOLA_VENDOR_ADDRESS moves off the address it pins.
const ZOLA_FROM_MAX = 400;
const QUOTED_NAME_RE = /^"(?:[^"\\\r\n]|\\.)*"$/;
const PLAIN_NAME_RE = /^[^"<>()\\,;:@\r\n]*$/;
function isStrictZolaFrom(value) {
  if (!isString(value) || ZOLA_VENDOR_ADDRESS !== 'weddingvendors@zola.com') return false;
  const s = value.trim();
  if (s.length > ZOLA_FROM_MAX) return false;
  const low = s.toLowerCase();
  if (low === ZOLA_VENDOR_ADDRESS) return true;
  const angle = `<${ZOLA_VENDOR_ADDRESS}>`;
  if (!low.endsWith(angle)) return false;
  const name = s.slice(0, s.length - angle.length).trim();
  return QUOTED_NAME_RE.test(name) || PLAIN_NAME_RE.test(name);
}

// One of the business's own mailboxes as written, or once its +tag is gone:
// the mailbox, its personal alias and the INBOX_OWN_EMAILS list
// (index.mailboxEmails, built by people.js with the one parse of that list).
// Never every address the sync treats as ours: an admin's or a manager's
// users.email, FROM_EMAIL and ADMIN_EMAIL are ours as senders, but a notice
// Zola signed for a manager's personal address and re-sent to the mailbox
// must not pass (security re-review 2026-10-15). An index without the set
// addresses nobody, and Zola's own address is never "us" here.
function isMailboxRecipient(address, index) {
  const mine = index && index.mailboxEmails instanceof Set ? index.mailboxEmails : null;
  if (!mine || address === ZOLA_VENDOR_ADDRESS) return false;
  return mine.has(address) || mine.has(`${localOf(address)}@${domainOf(address)}`);
}

// Spec 5.6's gate, the replay half (security review 2026-10-15): a notice
// Zola really signed for another vendor, re-sent to our mailbox, passes From,
// DKIM and DMARC alike, so the notice must name one of the business's
// mailboxes in To or Cc. Never Bcc, which a re-sender sets. Every real notice
// checked on 2026-10-15 had the mailbox in To, or the business's older address
// in To and the mailbox in Cc.
//
// RFC 5322 allows one To and one Cc. headersOf keeps the TOP copy of a
// repeated header while DKIM verifies the BOTTOM one (RFC 6376 5.4.2), so a
// second To placed above a signed one could name us on a notice signed for
// someone else: a notice with two of either is refused.
function countHeader(payload, name) {
  const list = payload && Array.isArray(payload.headers) ? payload.headers : [];
  return list.filter((h) => h && isString(h.name) && h.name.toLowerCase() === name).length;
}

function addressedToUs(headers, payload, index) {
  if (countHeader(payload, 'to') > 1 || countHeader(payload, 'cc') > 1) return false;
  for (const name of ['to', 'cc']) {
    const value = headers.get(name);
    if (!isString(value)) continue;
    for (const part of splitList(value)) {
      const box = mailboxOf(part);
      if (box && isMailboxRecipient(box.address, index)) return true;
    }
  }
  return false;
}

function classifyZola({ headers, subject, payload, index }) {
  if (!isStrictZolaFrom(headers.get('from'))) return drop('zola_gate');
  if (!zolaAuthPasses(headers)) return drop('zola_gate');
  if (!addressedToUs(headers, payload, index)) return drop('zola_gate');
  const { template, label } = zolaTemplateOf(subject);
  if (template === 'booked') return drop('zola_booked');
  if (!template) return drop('zola_marketing');
  // Lane email-feed has no body parser yet: every gated notice is stored as
  // unparsed, against the label its subject carries (or the caller's fallback).
  return { action: 'store', kind: 'zola_unparsed', zola: { template, label } };
}

/**
 * Spec 5.2's rules, in order, for one parsed message. storedSentIds holds the
 * Message-IDs of our stored Sent rows that this message's In-Reply-To or
 * References names; sentInThread says its Gmail thread holds a stored Sent
 * row. Returns { action: 'drop', reason } or { action: 'store', kind } plus
 * zola (the template and label), or, for a bounce, bounced (the one Sent
 * Message-ID to mark) and bouncedTo (the report's failed recipients,
 * lowercased, at most 20, empty when it names none).
 */
// The one Sent row a bounce names: In-Reply-To's, else the LAST References
// entry we stored (the newest in the chain), never every entry.
function bouncedRow(inReplyTo, references, sent) {
  if (inReplyTo && sent.has(inReplyTo)) return inReplyTo;
  const refs = Array.isArray(references) ? references : [];
  for (let i = refs.length - 1; i >= 0; i -= 1) {
    if (sent.has(refs.at(i))) return refs.at(i);
  }
  return null;
}

function classifyMessage({
  headers, labelIds, subject, hasCalendarOnly, fromAddress, recipients, index, storedSentIds, sentInThread, payload, inReplyTo,
  references,
}) {
  const labels = Array.isArray(labelIds) ? labelIds : [];
  const sent = storedSentIds instanceof Set ? storedSentIds : new Set();
  // 1. Never a draft, spam or trash.
  if (DROP_LABELS.some((l) => labels.includes(l))) return drop('label');
  const out = labels.includes('SENT');
  const from = lower(fromAddress);
  // 2. Zola's vendor address goes to its own branch before any own-address rule.
  if (!out && from === ZOLA_VENDOR_ADDRESS) return classifyZola({ headers, subject, payload, index });
  if (out) {
    // 3. A Sent mail only to ourselves (the report), or to a dropped domain
    // (a Thumbtack Business reply the webhook already records).
    const list = Array.isArray(recipients) ? recipients : [];
    if (list.every((a) => index.ownEmails.has(a))) return drop('own_only');
    if (list.some(isDroppedDomain)) return drop('dropped_domain');
    // 7. Gmail's own automation writes Sent rows too.
    if (isAutoReply(headers, subject, hasCalendarOnly)) return store('auto_reply');
    return store('message');
  }
  if (!from) return drop('no_sender');
  // 4. Our own addresses.
  if (index.ownEmails.has(from)) return drop('own_sender');
  // 6, read before 5: a bounce counts only when it names a Sent row we
  // stored. It runs ahead of the dropped-domain rule because a delivery
  // report can come from a domain on that list (google.com), and a bounce
  // dropped there would let the bounced reply close the item.
  // A report nobody failed in (a Delay) is notification mail: never stored.
  const replyTo = inReplyTo || firstMessageId(headers.get('in-reply-to'));
  const report = bounceOf(headers, payload);
  if (report) {
    if (!report.failed) return drop('dsn_not_failed');
    const named = bouncedRow(replyTo, references || messageIdsIn(headers.get('references')), sent);
    if (!named) return drop('bounce_unmatched');
    // bouncedTo narrows which recipients of that one row failed; empty when
    // the report names none we could read.
    return { action: 'store', kind: 'bounce', bounced: [named], bouncedTo: report.bouncedTo };
  }
  // 5. The senders that only ever notify.
  if (isDroppedDomain(from)) return drop('dropped_domain');
  // 7. A machine auto-reply is stored and never counts.
  if (isAutoReply(headers, subject, false)) return store('auto_reply');
  // 8. A known client or staffer, whatever Gmail's category.
  const key = index.resolveEmail(from);
  if (key && (key.startsWith('c-') || key.startsWith('s-'))) return store('message');
  // 9. A reply to our stored Sent mail, whatever the category.
  if ((replyTo && sent.has(replyTo)) || sentInThread) return store('message');
  // 10. Anyone else passes the bulk filter or is not stored.
  if (isBulk(headers, labels) || NO_REPLY_LOCAL_RE.test(localOf(from))) return drop('bulk');
  // 11. Everything else inbound.
  return store('message');
}

/**
 * The ids one history record asks the sync to read, in order. An id added as
 * a draft, or into Spam or Trash, is not read (rule 1 would drop it); one
 * rescued later arrives as a labelsAdded record for INBOX or Primary, and
 * that is read.
 */
function idsOfHistoryRecord(record) {
  const out = [];
  if (!record || typeof record !== 'object') return out;
  const valid = (m) => m && isString(m.id) && GMAIL_ID_RE.test(m.id);
  for (const added of Array.isArray(record.messagesAdded) ? record.messagesAdded : []) {
    const m = added && added.message;
    const labels = m && Array.isArray(m.labelIds) ? m.labelIds : [];
    if (valid(m) && !DROP_LABELS.some((l) => labels.includes(l))) out.push(m.id);
  }
  for (const added of Array.isArray(record.labelsAdded) ? record.labelsAdded : []) {
    const m = added && added.message;
    const gained = added && Array.isArray(added.labelIds) ? added.labelIds : [];
    if (valid(m) && gained.some((l) => REEVALUATE_LABELS.has(l))) out.push(m.id);
  }
  return out;
}

module.exports = {
  GMAIL_ID_RE, ADDRESS_MAX, RECIPIENTS_MAX,
  headersOf, recipientsOf, addressOf, isStrictZolaFrom, isBulk, isAutoReply, isBounce, isDroppedDomain,
  parseMessage, classifyMessage, idsOfHistoryRecord, messageIdsIn,
};
