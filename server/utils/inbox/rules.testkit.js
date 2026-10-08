'use strict';

// Invented fixtures for the pure Inbox suites (normalize, rules.*, subjects,
// thread, payload). Not a test file: no .test.js suffix, so node --test never
// runs it on its own. Every name, number and message here is made up (the repo
// is public), and phone numbers sit in the 555 range.

const NOW = new Date('2026-11-20T18:00:00.000Z'); // Fri Nov 20 2026, 12:00 PM Chicago (CST)
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (msAgo) => new Date(NOW.getTime() - msAgo);
const plus = (date, ms) => new Date(new Date(date).getTime() + ms);

const DALLAS = 1;
const ZUL = 2;
const USERS = [{ id: DALLAS, name: 'Dallas R.' }, { id: ZUL, name: 'Zul' }];
const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'optout', 'revoke'];

let seq = 1000;
const nextId = () => { seq += 1; return seq; };
const shortWord = (text) => {
  const s = String(text || '').trim();
  return s.length <= 12 ? s.toLowerCase() : null;
};

function smsIn(personKey, at, text, opts = {}) {
  const id = opts.id || nextId();
  const media = opts.media || [];
  return {
    ref: `sms:${id}`, personKey, channel: opts.channel || 'text', line: opts.line || '888',
    direction: 'in', at: new Date(at), author: null, kind: media.length ? 'media' : 'message', text,
    meta: {
      source: 'sms', id, inbound: true, phone: opts.phone || '+13125550100', word: shortWord(text),
      optWord: false, optKeyword: opts.optKeyword || null, skip: opts.skip || null,
      empty: !media.length && !String(text || '').trim(), media,
      relay: Boolean(opts.relayLeadName), relayLeadName: opts.relayLeadName || null, twilioSid: opts.twilioSid || null,
    },
  };
}

// One of the seven unambiguous opt words, as the SMS reader emits it.
function optLine(personKey, at, word, opts = {}) {
  const id = opts.id || nextId();
  const stop = STOP_WORDS.includes(word);
  return {
    ref: `sms:${id}`, personKey, channel: 'text', line: opts.line || '888', direction: 'system',
    at: new Date(at), author: null, kind: stop ? 'opt_out' : 'opt_in', text: word,
    meta: { source: 'sms', id, inbound: true, phone: opts.phone || '+13125550100', word, optWord: true, optKeyword: stop ? 'stop' : 'start' },
  };
}

function smsOut(personKey, at, text, opts = {}) {
  const id = opts.id || nextId();
  const sender = opts.sender === undefined ? DALLAS : opts.sender;
  return {
    ref: `sms:${id}`, personKey, channel: opts.channel || 'text', line: opts.line || '888',
    direction: 'out', at: new Date(at), author: sender || 'auto', kind: 'message', text,
    meta: {
      source: 'sms', id, inbound: false, phone: opts.phone || '+13125550100', smsSenderId: sender || null,
      failed: Boolean(opts.failed), failureReason: opts.failureReason || null, groupSize: opts.groupSize || 1,
      twilioSid: opts.twilioSid || null, messageType: opts.messageType || 'general',
    },
  };
}

function ttIn(personKey, at, text, opts = {}) {
  const id = opts.id || nextId();
  return {
    ref: `tt:m${id}`, personKey, channel: 'thumbtack', line: null, direction: 'in', at: new Date(at),
    author: null, kind: 'message', text,
    meta: { source: 'tt', id, negotiationId: opts.negotiationId || 'neg-1', empty: !String(text || '').trim(), firstReplySentAt: null },
  };
}

function ttOut(personKey, at, text, opts = {}) {
  const id = opts.id || nextId();
  return {
    ref: `tt:m${id}`, personKey, channel: 'thumbtack', line: null, direction: 'out', at: new Date(at),
    author: null, kind: 'message', text,
    meta: {
      source: 'tt', id, negotiationId: opts.negotiationId || 'neg-1', empty: false,
      firstReplySentAt: opts.firstReplySentAt ? new Date(opts.firstReplySentAt) : null,
    },
  };
}

function mlSend(personKey, at, opts = {}) {
  const id = opts.id || nextId();
  const channel = opts.channel || 'email';
  const sentBy = opts.sentBy === undefined ? DALLAS : opts.sentBy;
  const subject = opts.subject || 'An update from Dr. Bartender';
  return {
    ref: `ml:${id}`, personKey, channel, line: channel === 'text' ? '888' : null, direction: 'out',
    at: new Date(at), author: sentBy || 'auto', kind: 'message', text: channel === 'text' ? subject : null,
    meta: {
      source: 'ml', id, messageType: opts.messageType || 'other', proposalId: opts.proposalId || 77,
      providerId: opts.providerId || null, subject, failed: Boolean(opts.failed), bounced: Boolean(opts.bounced),
    },
  };
}

function palSend(personKey, at, opts = {}) {
  const id = opts.id || nextId();
  const actor = opts.actor === undefined ? ZUL : opts.actor;
  let role = null;
  if (actor === DALLAS) role = 'admin';
  else if (actor) role = 'manager';
  return {
    ref: `pal:${id}`, personKey, channel: null, line: null, direction: 'out', at: new Date(at),
    author: actor || 'auto', kind: 'proposal_sent', text: null,
    meta: {
      source: 'pal', id, proposalId: opts.proposalId || 77, action: opts.action || 'status_changed',
      actorRole: opts.actorRole === undefined ? role : opts.actorRole,
    },
  };
}

function call(personKey, at, opts = {}) {
  const id = opts.id || nextId();
  const source = opts.source || 'lc';
  return {
    ref: `${source}:${id}`, personKey, channel: 'voice', line: null, direction: 'out', at: new Date(at),
    author: opts.answeredBy === undefined ? DALLAS : opts.answeredBy, kind: 'call', text: null,
    meta: { source, id, durationSec: opts.durationSec === undefined ? 180 : opts.durationSec, clientNoAnswer: Boolean(opts.clientNoAnswer) },
  };
}

// Thumbtack's own "Name replied to you on Thumbtack." text from a proxy number.
// quoted: true is the shape prod sends (Task 18 F1): the notice quotes the
// customer's words below a line of dashes. meta.relayQuoted is the header
// pass's flag, and the text is the words alone, as pass 2 hands them over.
function relayNotice(personKey, at, opts = {}) {
  const id = opts.id || nextId();
  const name = opts.leadName || 'Pat Q.';
  const quoted = Boolean(opts.quoted);
  return {
    ref: `sms:${id}`, personKey, channel: 'text', line: '888', direction: 'in', at: new Date(at),
    author: null, kind: 'message',
    text: quoted ? (opts.words || 'Got it, we will review and get back to you.') : `${name} replied to you on Thumbtack.`,
    meta: {
      source: 'sms', id, inbound: true, phone: opts.phone || '+13125550188', word: null, optWord: false,
      empty: false, relay: true, relayNotice: true, relayQuoted: quoted,
      relayNegotiationId: opts.negotiationId || 'neg-1', relayLeadName: name,
    },
  };
}

function act(personKey, action, at, opts = {}) {
  return {
    id: opts.id || nextId(), person_key: personKey, action, until_at: opts.until ? new Date(opts.until) : null,
    user_id: opts.userId === undefined ? DALLAS : opts.userId, created_at: new Date(at),
    undone_at: opts.undone ? new Date(at) : null,
  };
}

function readRow(kind, event, fields = {}) {
  const at = fields.at ? new Date(fields.at) : plus(event.at, MIN);
  return {
    kind, subject_ref: event.ref, person_key: event.personKey, status: fields.status || 'ok',
    needs_reply: fields.needs_reply === undefined ? null : fields.needs_reply,
    holding: fields.holding === undefined ? null : fields.holding,
    summary: fields.summary || null, promised_by: fields.promised_by || null, reason: fields.reason || null,
    created_at: at, updated_at: at,
  };
}

function seenRow(personKey, at, userId = DALLAS) {
  return { person_key: personKey, seen_at: new Date(at), seen_by: userId };
}

function proposalRow(personKey, opts = {}) {
  return {
    id: opts.id || nextId(), person_key: personKey, status: opts.status || 'deposit_paid',
    event_date: opts.eventDate || null, created_at: opts.createdAt ? new Date(opts.createdAt) : ago(30 * DAY),
    legal_hold: Boolean(opts.legalHold),
  };
}

// computeInbox with the testkit's clock, operators and viewer (Dallas).
function run(input = {}) {
  const { computeInbox } = require('./rules');
  return computeInbox({ now: NOW, users: USERS, viewerId: DALLAS, reads: [], actions: [], seen: [], proposals: [], ...input });
}

const stateOf = (result, personKey) => result.people.get(personKey);

module.exports = {
  NOW, SEC, MIN, HOUR, DAY, ago, plus, DALLAS, ZUL, USERS,
  smsIn, optLine, smsOut, ttIn, ttOut, mlSend, palSend, call, relayNotice,
  act, readRow, seenRow, proposalRow, run, stateOf,
};
