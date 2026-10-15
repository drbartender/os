'use strict';

// Reader: gmail_messages, the email rows (spec 2026-10-14 section 5.1). The
// sync (gmailSync.js) decided at storage which mail counts; this decides WHO
// each row is about, at read time, through the people index (spec 5.2), so
// mail stored before its sender became a client joins that client's item.
// Pass 1 reads headers (no subject, no words); pass 2 (loadGmailDetails) loads
// the subject and the words for the people the rules keep, by row id.
//   inbound   the From address names the person; our own addresses (and so
//             the mail the sync never stores) form nothing.
//   outbound  a Sent mail answers, in order, the person of the stored inbound
//             it replies to (In-Reply-To names it, else the newest inbound in
//             its Gmail thread), then every recipient in To, Cc and Bcc that
//             resolves to someone not us, so a reply sent to a Reply-To
//             address still answers the person who wrote. A forward (its
//             subject starts Fwd: or Fw:) answers its recipients only: Gmail
//             keeps it in the thread it forwards, and passing a client's
//             question to a bartender answers the bartender, not the client.
//             One event per person: gm:<id> alone, or gm:<id>:1, gm:<id>:2
//             ..., all sharing meta.readRef = 'gm:<id>' so the mail is read
//             once (spec 6). A mail that reached two or more staffers answers
//             none of them (spec 5.4, the group-text rule): meta.staffGroup on
//             those. A bounce fails the events of the people it reached
//             through the addresses it names (bounced_to), or every event of
//             the mail when it names none.
//   system    an auto-reply, either direction (meta.sent on our own), and a
//             bounce. A bounce is about the people of the Sent mail it names
//             (In-Reply-To, else the newest Sent mail in its thread) that its
//             failed addresses reached, never its machine sender.
// A recipient at Zola's relay domain is never a person here: readZola.js ties
// a reply sent there to its couple.
//
// Personal mail (spec 2026-10-14 decision 6, as the owner decided it on
// 2026-10-15) was judged by the sync, once, when it stored the row
// (personalMail.js), and is never judged again here: no index change moves it
// either way. A personal mail lives on its own person, people.personalEmailKey
// of the address, never the business key that address resolves to, and every
// event of that person carries meta.personal (classify.isPersonal reads it).
//   inbound   a row stored personal is its sender's personal person, whoever
//             the index says the sender is now.
//   outbound  ANSWERING decides first, as at sync time. A Sent mail that
//             answers a personal inbound puts that inbound's sender, each
//             recipient in personal_to and each recipient the index knows as
//             nobody (an e- key), on their personal people; one that
//             answers a business inbound is business for everyone, whatever
//             personal_to holds, so the business item gets its reply. Only a
//             mail that answers nothing (a fresh send, a forward) reads
//             personal_to alone. The reader asks again because the first sync
//             stores Sent mail before the inbound it answers, so the sync
//             judged such a reply as a fresh send. Every other recipient (a
//             client copied on it) keeps their business event.
//   bounce    sits with the people of its Sent mail, personal ones included.

const { ZOLA_RELAY_DOMAIN } = require('./constants');
const { personalEmailKey } = require('./people');

// Every column the readers need but subject and text, plus whether the row
// has words and whether its subject marks a forward, so pass 1 ships nothing
// anyone wrote. The writer stores null for a body with no words, so
// empty_body never reads the text itself (which would detoast it).
const GM_HEADER_COLUMNS = `id, gmail_id, thread_id, direction, kind, from_address, from_name, to_addresses, attachments,
         message_id_header, in_reply_to, failed, bounced_to, zola_lead_id, at, personal, personal_to,
         (text IS NULL) AS empty_body,
         (COALESCE(subject, '') ~* '^\\s*fwd?\\s*:') AS forward`;

// One scan of gmail_messages per snapshot: both readers take their own rows
// from it (isGmRow here, readZola.isZolaRow there).
const MAIL_HEADERS_SQL = `
  SELECT ${GM_HEADER_COLUMNS}
    FROM gmail_messages
   WHERE at >= $1`;

const GM_KINDS = new Set(['message', 'auto_reply', 'bounce']);
const isGmRow = (r) => Boolean(r && r.gmail_id) && (r.zola_lead_id === null || r.zola_lead_id === undefined) && GM_KINDS.has(r.kind);

const GM_DETAILS_SQL = 'SELECT gmail_id, subject, text FROM gmail_messages WHERE id = ANY($1::int[])';

const ms = (d) => new Date(d).getTime();
const lower = (a) => String(a || '').trim().toLowerCase();

function domainOf(address) {
  const a = lower(address);
  const at = a.lastIndexOf('@');
  return at === -1 ? '' : a.slice(at + 1);
}
const isZolaRelay = (address) => domainOf(address) === ZOLA_RELAY_DOMAIN;
const listOf = (value) => (Array.isArray(value) ? value.map(lower).filter(Boolean) : []);
const addressesOf = (row) => listOf(row.to_addresses);

// Whether a bounce that names `bounced` (the addresses its report says
// failed) is about a person the Sent mail `sent` reached through `reach`. A
// bounce we cannot place is about everyone, the safe side (the item waits):
// one that names no recipient of that mail (none, or only an address the
// mail never named, say where an alias forwarded it), or a person whose reach
// is unknown.
function concerns(bounced, sent, reach) {
  const named = bounced.filter((a) => addressesOf(sent).includes(a));
  if (!named.length || !Array.isArray(reach) || !reach.length) return true;
  return reach.some((a) => named.includes(a));
}
const failedFor = (row, reach) => Boolean(row.failed) && concerns(listOf(row.bounced_to), row, reach);

// The meta every gm event carries (spec 5.1), plus personal: this event is a
// personal mail's, on its own person (classify.isPersonal). address and
// fromName are the other party's, read in pass 1 so the list can name an e-
// person without loading words. reach is the recipients the mail reached
// that person through, which decides a per-recipient bounce.
function gmMeta(row, { address = null, fromName = null, reach = null, personal = false } = {}) {
  const attachments = Math.max(0, Number(row.attachments) || 0);
  const out = row.direction === 'out';
  const words = !row.empty_body;
  return {
    source: 'gm', id: Number(row.id), gmailId: row.gmail_id, threadId: row.thread_id || null,
    address, fromName, attachments,
    textBearing: out && words, empty: !out && !words && attachments === 0,
    failed: failedFor(row, reach), readRef: `gm:${row.gmail_id}`, legalHold: false, personal: Boolean(personal),
  };
}

// The person an address is on this mail: its personal person when the mail
// is personal for it, else whoever the index resolves it to (null for ours).
const keyFor = (address, personal, index) => (personal ? personalEmailKey(address) : index.resolveEmail(address));

// The newest row of a thread at or before a time, or null.
function newestInThreadBefore(byThread, threadId, at) {
  let best = null;
  for (const r of byThread.get(threadId) || []) {
    if (ms(r.at) > ms(at)) continue;
    if (!best || ms(r.at) > ms(best.at) || (ms(r.at) === ms(best.at) && Number(r.id) > Number(best.id))) best = r;
  }
  return best;
}

// The stored human mail, by Message-ID and by thread, one side each. Every
// row that carries a Message-ID is kept under it: two mails can share one.
function rowIndex(rows) {
  const side = () => ({ byId: new Map(), byThread: new Map() });
  const ix = { inbound: side(), sent: side() };
  const push = (map, key, r) => {
    const list = map.get(key) || [];
    list.push(r);
    map.set(key, list);
  };
  for (const r of rows) {
    if (r.kind !== 'message') continue;
    const s = r.direction === 'out' ? ix.sent : ix.inbound;
    if (r.message_id_header) push(s.byId, r.message_id_header, r);
    push(s.byThread, r.thread_id, r);
  }
  return ix;
}

// The row a Message-ID names: the lowest id among them, whatever order the
// scan returned them in, and for a reply only one dated at or before it
// (personalMail.SQL.answeredInbound's rule, security review 2026-10-15), so a
// later mail that reuses the Message-ID never takes the reply over.
function byMessageId(side, messageId, notAfter = null) {
  let best = null;
  for (const r of side.byId.get(messageId) || []) {
    if (notAfter !== null && ms(r.at) > ms(notAfter)) continue;
    if (!best || Number(r.id) < Number(best.id)) best = r;
  }
  return best;
}

// Who a Sent mail answers (spec 5.1): the person of the inbound it replies
// to first (never for a forward), then each recipient that names someone not
// us. Each person keeps the recipients that reached them (reach): their own
// addresses among the recipients, or, for the person answered through a
// Reply-To address, every recipient. Personal recipients and a personal
// asker take their personal person (the header above).
function sentPeople(row, ix, index) {
  const people = [];
  const add = (key, address, fromName, via, personal) => {
    if (!key) return null;
    let p = people.find((x) => x.key === key);
    if (!p) {
      p = { key, address, fromName, reach: [], personal };
      people.push(p);
    }
    if (via && !p.reach.includes(via)) p.reach.push(via);
    return p;
  };
  const answered = row.forward ? null : ((row.in_reply_to && byMessageId(ix.inbound, row.in_reply_to, row.at))
    || newestInThreadBefore(ix.inbound.byThread, row.thread_id, row.at));
  const askerAddress = answered ? lower(answered.from_address) : null;
  const askerPersonal = Boolean(answered && answered.personal);
  // A reply to a business inbound is business whatever personal_to says (the
  // first sync judged it before that inbound was stored).
  const personalTo = new Set(answered && !askerPersonal ? [] : listOf(row.personal_to));
  const asker = answered
    ? add(keyFor(askerAddress, askerPersonal, index), askerAddress, answered.from_name || null, null, askerPersonal) : null;
  for (const a of addressesOf(row)) {
    if (isZolaRelay(a)) continue;
    // A reply to a personal mail is personal for its sender and for each
    // recipient nobody knows (an e- key now: nobody knew them when it was
    // sent either), so a reply the first sync judged before that mail was
    // stored still lands there. A copied client or staffer stays business.
    const nobody = askerPersonal && String(index.resolveEmail(a) || '').startsWith('e-');
    const personal = personalTo.has(a) || (askerPersonal && a === askerAddress) || nobody;
    add(keyFor(a, personal, index), a, null, a, personal);
  }
  if (asker && !asker.reach.length) asker.reach = addressesOf(row);
  return people;
}

function eventsOf(row, people) {
  const system = row.kind === 'auto_reply' || row.kind === 'bounce';
  const out = row.direction === 'out';
  const staffGroup = !system && out && people.filter((p) => p.key.startsWith('s-')).length >= 2;
  let kind = row.kind;
  if (!system) kind = !out && row.empty_body && Number(row.attachments) > 0 ? 'media' : 'message';
  return people.map((p, i) => {
    const meta = gmMeta(row, p);
    if (staffGroup && p.key.startsWith('s-')) meta.staffGroup = true;
    // Our own auto-reply (a vacation responder, a calendar answer): the
    // direction is system for both sides, so this is what tells them apart.
    if (row.kind === 'auto_reply' && out) meta.sent = true;
    return {
      ref: people.length > 1 ? `gm:${row.gmail_id}:${i + 1}` : `gm:${row.gmail_id}`,
      personKey: p.key, channel: 'email', line: null, direction: system ? 'system' : row.direction,
      at: new Date(row.at), author: null, kind, text: undefined, meta,
    };
  });
}

// Takes the whole header set: resolving "the inbound this answers" and "the
// Sent mail this bounce names" needs the stored rows beside each other. Rows
// that are not email rows (Zola's, from the one shared scan) are passed over.
function mapGmailHeaders(rows, index) {
  const list = (rows || []).filter(isGmRow);
  const ix = rowIndex(list);
  const memo = new Map();
  const peopleOfSent = (r) => {
    if (!memo.has(r.gmail_id)) memo.set(r.gmail_id, sentPeople(r, ix, index));
    return memo.get(r.gmail_id);
  };
  const out = [];
  for (const r of list) {
    let people = [];
    if (r.kind === 'bounce') {
      const sent = (r.in_reply_to && byMessageId(ix.sent, r.in_reply_to)) || newestInThreadBefore(ix.sent.byThread, r.thread_id, r.at);
      // The bounce line sits with the people its failed addresses reached.
      if (sent) people = peopleOfSent(sent).filter((p) => concerns(listOf(r.bounced_to), sent, p.reach));
    } else if (r.direction === 'out') {
      people = peopleOfSent(r);
    } else {
      const personal = Boolean(r.personal);
      const key = keyFor(r.from_address, personal, index);
      if (key) people = [{ key, address: lower(r.from_address), fromName: r.from_name || null, personal }];
    }
    out.push(...eventsOf(r, people));
  }
  return out;
}

// Pass 2: the subject and the words, keyed by the mail's readRef ('gm:<id>'),
// which every suffixed sibling shares. ids are gmail_messages row ids.
async function loadGmailDetails(ids, db) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(GM_DETAILS_SQL, [ids]);
  return new Map(rows.map((r) => [`gm:${r.gmail_id}`, { subject: r.subject || null, text: r.text === undefined ? null : r.text }]));
}

module.exports = {
  GM_HEADER_COLUMNS, MAIL_HEADERS_SQL, GM_DETAILS_SQL, mapGmailHeaders, loadGmailDetails, isGmRow,
  gmMeta, newestInThreadBefore, isZolaRelay, addressesOf,
};
