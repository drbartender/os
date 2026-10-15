'use strict';

// Reader: gmail_messages, the Zola rows (spec 2026-10-14 section 5.1). Every
// zola_ row carries its lead (the sync links one, even to an unparsed notice),
// and the lead is the person: its client when linked, else z-<lead id>.
//   inquiry, message  their words, inbound, kind message;
//   unparsed          inbound, kind zola_unread, which reads ZOLA_UNREAD_TEXT,
//                     counts, and the AI may never close (the tt_missed rule);
//   closed            a system line, kind zola_closed: the couple closed their
//                     inquiry, a close by rule (decision 19).
// A Gmail reply to a message notice reaches the couple through Zola's relay,
// so a Sent mail is their reply when its In-Reply-To names a stored message
// notice (never for a forward, which answers its recipients only), or when it
// went to Zola's relay domain and its thread holds one. The join runs HERE, at
// read time, never at sync time: the backfill lists newest first, so the
// reply is often stored before the notice it answers. The reply's ref is
// gm:<id>:z, its readRef gm:<id>, so a Sent mail that also answers an email
// person (readGmail.js, gm:<id> or gm:<id>:<n>) never shares a ref with it.

const { personKey } = require('./personKey');
const { ZOLA_UNREAD_TEXT } = require('./constants');
const { gmMeta, newestInThreadBefore, isZolaRelay, addressesOf, mapGmailHeaders } = require('./readGmail');

const ZOLA_KINDS = new Set(['zola_inquiry', 'zola_message', 'zola_closed', 'zola_unparsed']);
// The notices, and the Sent mail the join may tie to a couple, from the one
// shared scan (readGmail.MAIL_HEADERS_SQL).
const isZolaRow = (r) => Boolean(r && r.gmail_id) && (ZOLA_KINDS.has(r.kind) || (r.direction === 'out' && r.kind === 'message'));

const TEMPLATES = new Map([
  ['zola_inquiry', 'inquiry'], ['zola_message', 'message'], ['zola_closed', 'closed'], ['zola_unparsed', 'unparsed'],
]);

const leadOf = (index, id) => (index.zolaLeadsById ? index.zolaLeadsById.get(Number(id)) || null : null);

// The couple's key: the lead's client when linked, else z-<lead id> (also
// when the lead was written after the index loaded).
function keyOf(index, leadId) {
  const lead = leadOf(index, leadId);
  return (lead && index.zolaKey && index.zolaKey(lead)) || personKey('z', Number(leadId));
}

function zolaMeta(row, index, leadId, template, reach = null) {
  const lead = leadOf(index, leadId);
  return { ...gmMeta(row, { reach }), zolaLeadId: Number(leadId), template, leadUuid: (lead && lead.lead_uuid) || null };
}

function noticeEvent(row, index) {
  let kind = 'message';
  let direction = 'in';
  let text;
  if (row.kind === 'zola_closed') {
    kind = 'zola_closed';
    direction = 'system';
  } else if (row.kind === 'zola_unparsed') {
    kind = 'zola_unread';
    text = ZOLA_UNREAD_TEXT;
  }
  return {
    ref: `gm:${row.gmail_id}`, personKey: keyOf(index, row.zola_lead_id), channel: 'zola', line: null, direction,
    at: new Date(row.at), author: null, kind, text, meta: zolaMeta(row, index, row.zola_lead_id, TEMPLATES.get(row.kind)),
  };
}

// The couple was reached through the relay addresses (or, joined by
// In-Reply-To alone, through every recipient): a bounce fails the reply only
// when it names one of them.
function replyEvent(row, notice, index) {
  const relay = addressesOf(row).filter(isZolaRelay);
  return {
    ref: `gm:${row.gmail_id}:z`, personKey: keyOf(index, notice.zola_lead_id), channel: 'zola', line: null, direction: 'out',
    at: new Date(row.at), author: null, kind: 'message', text: undefined,
    meta: zolaMeta(row, index, notice.zola_lead_id, 'message', relay.length ? relay : addressesOf(row)),
  };
}

function mapZolaHeaders(rows, index) {
  const list = (rows || []).filter(isZolaRow);
  const notices = list.filter((r) => TEMPLATES.has(r.kind) && r.zola_lead_id !== null && r.zola_lead_id !== undefined);
  const messagesById = new Map();
  const messagesByThread = new Map();
  for (const r of notices) {
    if (r.kind !== 'zola_message') continue;
    if (r.message_id_header && !messagesById.has(r.message_id_header)) messagesById.set(r.message_id_header, r);
    const inThread = messagesByThread.get(r.thread_id) || [];
    inThread.push(r);
    messagesByThread.set(r.thread_id, inThread);
  }
  const out = notices.map((r) => noticeEvent(r, index));
  for (const r of list) {
    if (r.direction !== 'out' || r.kind !== 'message') continue;
    let notice = r.in_reply_to && !r.forward ? messagesById.get(r.in_reply_to) || null : null;
    if (!notice && addressesOf(r).some(isZolaRelay)) notice = newestInThreadBefore(messagesByThread, r.thread_id, r.at);
    if (notice) out.push(replyEvent(r, notice, index));
  }
  return out;
}

// Both readers over the one shared scan. A Sent mail whose Zola reply lands
// on a person its email side already answers (a linked couple's own address
// among the recipients) is one reply, kept as the email event.
function mapMailHeaders(rows, index) {
  const gm = mapGmailHeaders(rows, index);
  const answered = new Set(gm.map((e) => `${e.meta.readRef}|${e.personKey}`));
  const zola = mapZolaHeaders(rows, index).filter((e) => e.direction !== 'out' || !answered.has(`${e.meta.readRef}|${e.personKey}`));
  return [...gm, ...zola];
}

module.exports = { mapZolaHeaders, mapMailHeaders, isZolaRow };
