'use strict';

// What counts, for the Inbox rules (spec 2026-10-06, sections 5.3 and 5.4).
// PURE: every judgment reads facts the readers copied off the source rows, so
// each one is a unit test over invented fixtures.

const { ANSWERING_MESSAGE_TYPES } = require('../answeringMessageTypes');
const { CALL_MIN_SECONDS, TT_MISSED_TEXT } = require('./constants');
const { firstNameOf } = require('../firstName');

const isUserId = (a) => Number.isInteger(a) && a > 0;
const NOT_TEXT_SOURCES = new Set(['ml', 'pal', 'lc', 'cc']);

// The user behind an outbound event, or null: automated, or a Thumbtack
// Business message, whose author the OS cannot know. An SMS row whose ledger
// twin names a human (normalize.js) is that human's.
function authorOf(e) {
  if (isUserId(e.author)) return e.author;
  if (e.meta && isUserId(e.meta.ledgerSentBy)) return e.meta.ledgerSentBy;
  return null;
}

// Them writing (5.3). The SMS reader marks a handled shift command with
// meta.skip and turns an unambiguous opt word into a system event, so neither
// counts here. A never-received Thumbtack message does.
function isCountedInbound(e) {
  return e.direction === 'in' && !e.meta.skip
    && (e.kind === 'message' || e.kind === 'media' || e.kind === 'tt_missed');
}

// The AI may never close these (5.5 step 3): a picture, an empty text, or a
// Thumbtack message the OS never received. There is nothing in them to read.
function aiCannotClose(e) {
  return Boolean(e) && (e.kind === 'media' || e.kind === 'tt_missed'
    || (e.kind === 'message' && Boolean(e.meta.empty)));
}

// A reply (5.4): an outbound human action toward the person that is not known
// to have failed. A holding reply is still a reply; isHolding sorts those out.
function countsAsReply(e) {
  if (e.direction !== 'out' || e.meta.failed) return false;
  switch (e.meta.source) {
    case 'sms':
      // A text a human sent. To a staffer it answers only when its group holds
      // a single recipient, so an announcement never answers one question.
      if (isUserId(e.meta.smsSenderId)) return e.channel !== 'staff_text' || e.meta.groupSize === 1;
      // A human-triggered OS send that reached sms_messages with sender_id NULL
      // (the Send to client and event-details SMS) answers on its ledger twin's
      // author and type, exactly as the ledger row itself would.
      return isUserId(e.meta.ledgerSentBy) && ANSWERING_MESSAGE_TYPES.has(e.meta.ledgerMessageType);
    case 'ml':
      return isUserId(e.author) && ANSWERING_MESSAGE_TYPES.has(e.meta.messageType);
    case 'pal':
      return isUserId(e.author)
        && (e.meta.actorRole === 'admin' || e.meta.actorRole === 'manager')
        && Array.isArray(e.meta.deliveries) && e.meta.deliveries.some((d) => !d.failed);
    case 'tt':
      return true;
    case 'lc':
    case 'cc':
      return Number(e.meta.durationSec || 0) >= CALL_MIN_SECONDS && !e.meta.clientNoAnswer;
    default:
      // Pieces 3 and 4 add readers and nothing else (5.1): an outbound row from
      // a new source answers when a human sent it.
      return isUserId(e.author);
  }
}

// Only text-bearing replies are read for a promise (5.4): texts, Thumbtack
// messages, and a later source's rows that say they carry text.
function isTextBearingReply(e) {
  if (e.direction !== 'out') return false;
  if (e.meta.source === 'sms' || e.meta.source === 'tt') return true;
  if (NOT_TEXT_SOURCES.has(e.meta.source)) return false;
  return Boolean(e.meta.textBearing);
}

// A finished AI read, or null. Pending, error and refused reads decide nothing
// (6.5: an unread inbound waits; an unread outbound counts as real).
function readOf(reads, kind, ref) {
  const r = reads.get(`${kind}:${ref}`);
  return r && r.status === 'ok' ? r : null;
}

// A holding reply (5.4): the Thumbtack auto first reply by rule, or a text the
// AI read as "let me check and get back to you". The legal-hold client is never
// read (decision 31), so for them only the rule applies.
function isHolding(e, reads, legalHold) {
  if (e.meta.autoFirstReply) return true;
  if (legalHold || !isTextBearingReply(e)) return false;
  const r = readOf(reads, 'outbound', e.ref);
  return Boolean(r && r.holding === true);
}

// The need line before the AI summary lands (4.1).
function eventNeedText(e) {
  if (!e) return null;
  if (e.kind === 'tt_missed') return TT_MISSED_TEXT;
  const text = String(e.text || '').replace(/\s+/g, ' ').trim();
  if (e.kind === 'media') return text || 'Sent a photo';
  if (!text) return e.meta.empty ? 'Sent a message with no text' : null;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

function durationText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return s < 60 ? `${s} sec` : `${Math.round(s / 60)} min`;
}

function sliceText(e) {
  if (e.kind === 'tt_missed') return TT_MISSED_TEXT;
  if (e.kind === 'media') return `[photo]${e.text && String(e.text).trim() ? ` ${String(e.text).trim()}` : ''}`;
  if (e.kind === 'proposal_sent') return 'Sent the proposal';
  if (e.kind === 'call') return `Phone call, ${durationText(e.meta.durationSec)}`;
  if (e.meta.source === 'ml') return e.meta.subject || e.text || '';
  return e.text || '';
}

// The list's channel tag (contract): text_888 / text_1922 / text_0082 for a
// text, otherwise the channel itself. A bridge call carries none.
function channelTag(e) {
  if (!e || !e.channel) return null;
  if (e.channel === 'text') return `text_${e.line || '888'}`;
  if (e.channel === 'voice' && e.kind === 'call') return null;
  return e.channel;
}

// users: [{ id, name }] (the admins and managers). Unknown ids read "Someone".
function makeNamer(users) {
  const names = new Map((users || []).map((u) => [Number(u.id), u.name]));
  return (id) => (names.has(Number(id)) ? firstNameOf(names.get(Number(id)), 'Someone') : 'Someone');
}

module.exports = {
  isUserId, authorOf, isCountedInbound, aiCannotClose, countsAsReply, isTextBearingReply,
  readOf, isHolding, eventNeedText, durationText, sliceText, channelTag, makeNamer,
};
