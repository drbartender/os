'use strict';

// The opened item's message list (spec 4.2), PURE. Every event with the person
// in the last 30 days plus anything older still unanswered, oldest first, with
// system lines for proposal sends, calls, opt-outs, the taps, promises, and a
// close the thread could not otherwise explain. Times stay ISO; the page
// renders them in Chicago time. Clock words inside a line are Chicago time.

const { THREAD_DAYS, TT_MISSED_TEXT } = require('./constants');
const C = require('./classify');
const { failureReasonFor } = require('./readSms');
const { LINE_KEYS } = require('../smsLines');

const DAY = 24 * 3600 * 1000;
const ms = (d) => new Date(d).getTime();
const iso = (d) => new Date(d).toISOString();
// Some ICU builds put U+202F before AM/PM; plain spaces keep the copy stable.
const chicago = (opts) => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', ...opts });
  return (d) => f.format(new Date(d)).replace(/\s/g, ' ');
};
const clock = chicago({ hour: 'numeric', minute: '2-digit' });
const dayClock = chicago({ weekday: 'short', hour: 'numeric', minute: '2-digit' });

function blankRow(ref, at) {
  return {
    ref, direction: 'system', channel: null, line: null, at: iso(at), text: null, subject: null,
    author_name: null, auto: false, failed: false, failure_reason: null, media: [], relay_lead_name: null,
  };
}

function eventRow(e, h) {
  const row = { ...blankRow(e.ref, e.at), channel: e.channel || null, line: e.line || null };
  if (e.direction === 'in') {
    return {
      ...row, direction: 'in', text: e.kind === 'tt_missed' ? TT_MISSED_TEXT : (e.text === undefined ? null : e.text),
      media: Array.isArray(e.meta.media) ? e.meta.media : [], relay_lead_name: e.meta.relayLeadName || null,
    };
  }
  if (e.kind === 'opt_out') return { ...row, text: 'Opted out of texts' };
  if (e.kind === 'opt_in') return { ...row, text: 'Opted back in to texts' };
  const id = C.authorOf(e);
  const authorName = id ? h.who(id) : (e.author === 'auto' ? 'Auto' : null);
  if (e.kind === 'proposal_sent') {
    const delivered = (e.meta.deliveries || []).some((d) => !d.failed);
    const text = id && id === h.viewerId ? 'You sent the proposal' : `Proposal sent${id ? ` by ${h.name(id)}` : ''}`;
    return { ...row, channel: null, author_name: authorName, text, failed: !delivered, failure_reason: delivered ? null : 'No email or text went out' };
  }
  if (e.kind === 'call') {
    const who = id && id === h.viewerId ? 'you' : (id ? h.name(id) : 'someone');
    const text = e.meta.clientNoAnswer ? `Call, client did not answer, ${who}` : `Call, ${C.durationText(e.meta.durationSec)}, ${who}`;
    return { ...row, author_name: authorName, text };
  }
  const ledger = e.meta.source === 'ml';
  let text = e.text === undefined ? null : e.text;
  if (ledger) text = e.channel === 'text' ? (e.meta.subject || e.text || null) : null;
  return {
    ...row, direction: 'out', author_name: authorName, auto: !id && e.author === 'auto', text,
    subject: ledger && e.channel === 'email' ? (e.meta.subject || null) : null,
    failed: Boolean(e.meta.failed),
    // Null when the reason is unknown: the page says "Not delivered" itself.
    failure_reason: e.meta.failed ? (e.meta.failureReason || (e.meta.bounced ? 'Email bounced' : null)) : null,
  };
}

function actionText(a, you, name) {
  switch (a.action) {
    case 'claim': return `${you ? "You're" : `${name} is`} on it, ${clock(a.created_at)}`;
    case 'release': return `${name} let it go`;
    case 'done': return `${name} marked it done`;
    case 'snooze': return `${name} snoozed it until ${a.until_at ? dayClock(a.until_at) : 'later'}`;
    case 'wake': return `${name} woke it`;
    case 'reopen': return `Reopened by ${you ? 'you' : name}`;
    default: return null;
  }
}

function actionRow(a, h) {
  const id = Number(a.user_id) || null;
  const you = id !== null && id === h.viewerId;
  const name = you ? 'You' : h.name(id);
  return { ...blankRow(`ia:${a.id}`, a.created_at), author_name: name, text: actionText(a, you, name) };
}

function promiseRow(e, read, h) {
  const id = C.authorOf(e);
  const by = read && read.promised_by ? ` ${read.promised_by}` : '';
  let text;
  if (e.meta.autoFirstReply) text = 'Auto first reply: follow-up promised';
  else if (id && id === h.viewerId) text = `You said you would follow up${by}`;
  else text = `${id ? h.name(id) : 'We'} promised to follow up${by}`;
  return { ...blankRow(`${e.ref}:promise`, e.at), text };
}

// Only the closes the thread cannot otherwise show: the AI's no-reply read and
// event happened. A reply or a Done is already a row of its own.
function closerRow(state) {
  const c = state && state.closed;
  if (!c || (c.reasonCode !== 'ai' && c.reasonCode !== 'event')) return null;
  const text = c.reasonCode === 'ai' ? `Was closed: AI says ${c.detail}` : `Was closed: event happened ${c.detail}`;
  return { ...blankRow(`close:${c.reasonCode}:${ms(c.at)}`, c.at), text };
}

function buildThread({ state = null, events = [], actions = [], reads = [], now = new Date(), viewerId = null, users = [] }) {
  const name = C.makeNamer(users);
  const viewer = viewerId === null || viewerId === undefined ? null : Number(viewerId);
  const h = { name, viewerId: viewer, who: (id) => (Number(id) === viewer ? 'You' : name(id)) };
  const readsByKey = new Map(reads.map((r) => [`${r.kind}:${r.subject_ref}`, r]));
  const legalHold = Boolean(state && state.legalHold);
  const open = new Set(state && state.internals ? [...state.internals.U, ...state.internals.P].map((e) => e.ref) : []);
  const fromMs = ms(now) - THREAD_DAYS * DAY;
  const rows = [];
  for (const e of events) {
    if (ms(e.at) < fromMs && !open.has(e.ref)) continue;
    rows.push(eventRow(e, h));
    if (C.countsAsReply(e) && C.isHolding(e, readsByKey, legalHold)) rows.push(promiseRow(e, C.readOf(readsByKey, 'outbound', e.ref), h));
  }
  for (const a of actions) if (!a.undone_at && ms(a.created_at) >= fromMs) rows.push(actionRow(a, h));
  // An AI or event close covers the open set (U and P), whose rows show however
  // old, so its line shows whenever one of them does, not only inside 30 days.
  const closer = closerRow(state);
  if (closer && (ms(closer.at) >= fromMs || events.some((e) => open.has(e.ref)))) rows.push(closer);
  return rows.sort((a, b) => (ms(a.at) - ms(b.at)) || (a.ref < b.ref ? -1 : (a.ref > b.ref ? 1 : 0)));
}

// One just-sent sms_messages row as a thread row, for the text route's 201.
// The route throws (409 opted out, else 502) on a send Twilio refused, but a
// sent row can still be failed: a failure callback that beat the INSERT is
// folded into it (textSend.js). Its reason is the reader's, through
// readSms.failureReasonFor: plain words for a known code, null for the
// codeless texts (the page then writes its own "Not delivered").
function outboundThreadRow(row, { channel }) {
  const meta = row.metadata || {};
  const failed = row.status === 'failed';
  return {
    ...blankRow(`sms:${row.id}`, row.created_at), direction: 'out', channel,
    line: LINE_KEYS.includes(meta.line) ? meta.line : '888', text: row.body, author_name: 'You',
    failed, failure_reason: failed ? failureReasonFor(row.error_message) : null,
  };
}

module.exports = { buildThread, outboundThreadRow };
