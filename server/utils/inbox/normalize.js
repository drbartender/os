'use strict';

// One event per real-world send, plus the cross-row matches the rules need
// (spec 2026-10-06, sections 5.1, 5.3 and 5.4). PURE. Runs once over every
// reader's rows, before the rules:
//   1. drop anything before the history floor (decision 18);
//   2. collapse a comparison's group_sent rows into one send;
//   3. link each message_log SMS row to its sms_messages twin (same Twilio SID).
//      The twin takes the ledger row's failure, sent_by and message type, so a
//      "Send to client" or event-details SMS (sender_id NULL by design, lane
//      send-attribution) keeps its human author. A send that threw has no SID
//      on either side: its failed text and its failed ledger row pair when
//      they are one person's within 10 seconds (amendment 23);
//   4. a proposal send absorbs its message_log deliveries within 5 minutes,
//      either side; a lone proposal-send ledger row with no activity row (the
//      send_now create path) stays as a send of its own;
//   5. absorbed and twinned ledger rows disappear: the sms: and pal: refs win;
//   6. a Thumbtack relay notice with no Customer message within 15 minutes
//      becomes a "never received" item, and a matched one is dropped; an
//      unmatched one that quotes their words (Task 18 F1) is their Thumbtack
//      message instead, which the AI may read;
//   7. the Thumbtack auto first reply is marked (within 2 minutes);
//   8. an ambiguous opt word that also opted the person out gets an "Opted out
//      of texts" companion line.
// Output events carry meta.normalized; already-normalized input passes straight
// through, so the rules may call this on either. The pass-through is all or
// nothing: a list that mixes normalized and raw events re-runs every step on
// all of them (a proposal send loses its deliveries, opt-out companions
// double). Normalize a list once, and never hand it a mix of the two.

const { PROPOSAL_SEND_MESSAGE_TYPES } = require('../answeringMessageTypes');
const {
  INBOX_HISTORY_START, PROPOSAL_ABSORB_MINUTES, TT_MISSED_MINUTES, AUTO_FIRST_REPLY_MINUTES,
  GROUP_SEND_COLLAPSE_SECONDS, TT_MISSED_TEXT, FAILED_TWIN_SECONDS,
} = require('./constants');

const MIN = 60 * 1000;
const t = (e) => new Date(e.at).getTime();
const isUserId = (a) => Number.isInteger(a) && a > 0;

// Time, then source row id, then ref: a total order, so two runs over the same
// rows always produce the same sequence.
function byTime(a, b) {
  return (t(a) - t(b))
    || (Number(a.meta && a.meta.id) || 0) - (Number(b.meta && b.meta.id) || 0)
    || (a.ref < b.ref ? -1 : (a.ref > b.ref ? 1 : 0));
}

function collapseGroupSends(events) {
  const out = [];
  const groups = new Map();
  for (const e of events) {
    if (e.meta.source !== 'pal') { out.push(e); continue; }
    e.meta.proposalIds = [e.meta.proposalId];
    if (e.meta.action !== 'group_sent') { out.push(e); continue; }
    const list = groups.get(e.personKey) || [];
    list.push(e);
    groups.set(e.personKey, list);
  }
  for (const list of groups.values()) {
    list.sort(byTime);
    let head = null;
    for (const e of list) {
      if (head && t(e) - t(head) <= GROUP_SEND_COLLAPSE_SECONDS * 1000) {
        head.meta.proposalIds.push(e.meta.proposalId);
      } else {
        head = e;
        out.push(e);
      }
    }
  }
  return out;
}

// Returns Map(ledger ref -> its sms_messages twin).
function linkLedgerTwins(events) {
  const smsBySid = new Map();
  for (const e of events) if (e.meta.source === 'sms' && e.meta.twilioSid) smsBySid.set(e.meta.twilioSid, e);
  const twins = new Map();
  for (const e of events) {
    if (e.meta.source !== 'ml' || e.channel !== 'text' || !e.meta.providerId) continue;
    const twin = smsBySid.get(e.meta.providerId);
    if (!twin) continue;
    twin.meta.failed = Boolean(twin.meta.failed || e.meta.failed);
    if (!isUserId(twin.meta.ledgerSentBy) && isUserId(e.author)) twin.meta.ledgerSentBy = e.author;
    if (!twin.meta.ledgerMessageType && e.meta.messageType) twin.meta.ledgerMessageType = e.meta.messageType;
    twins.set(e.ref, twin);
  }
  // A send that threw has no Twilio SID: its sms_messages row (failed, no SID)
  // and the failed message_log row sendSMS wrote (no provider id) are one
  // attempt when they are one person's, at most 10 seconds apart.
  const sidless = events
    .filter((e) => e.meta.source === 'sms' && e.direction === 'out' && e.meta.failed && !e.meta.twilioSid)
    .sort(byTime);
  const paired = new Set();
  for (const e of events) {
    if (e.meta.source !== 'ml' || e.channel !== 'text' || !e.meta.failed || e.meta.providerId || twins.has(e.ref)) continue;
    let best = null;
    for (const s of sidless) {
      if (paired.has(s.ref) || s.personKey !== e.personKey) continue;
      const d = Math.abs(t(s) - t(e));
      if (d <= FAILED_TWIN_SECONDS * 1000 && (!best || d < best.d)) best = { s, d };
    }
    if (!best) continue;
    paired.add(best.s.ref);
    if (!isUserId(best.s.meta.ledgerSentBy) && isUserId(e.author)) best.s.meta.ledgerSentBy = e.author;
    if (!best.s.meta.ledgerMessageType && e.meta.messageType) best.s.meta.ledgerMessageType = e.meta.messageType;
    twins.set(e.ref, best.s);
  }
  return twins;
}

// Returns the Set of absorbed ledger refs. A delivery that has an SMS twin is
// recorded under the twin's ref, with the twin's (async-callback) failure.
// Each send is indexed under every proposal it covers, once, so a ledger row
// is paired only against its own proposal's sends instead of scanning them
// all (performance review: quadratic at a year of history). The pick is the
// nearest send, then the lowest activity id.
function absorbProposalDeliveries(events, twins) {
  const sendsByProposal = new Map();
  for (const p of events) {
    if (p.meta.source !== 'pal') continue;
    p.meta.deliveries = [];
    for (const id of new Set(p.meta.proposalIds)) {
      const list = sendsByProposal.get(id) || [];
      list.push(p);
      sendsByProposal.set(id, list);
    }
  }
  const absorbed = new Set();
  for (const e of events) {
    if (e.meta.source !== 'ml' || !PROPOSAL_SEND_MESSAGE_TYPES.has(e.meta.messageType)) continue;
    let best = null;
    for (const p of sendsByProposal.get(e.meta.proposalId) || []) {
      const d = Math.abs(t(e) - t(p));
      if (d > PROPOSAL_ABSORB_MINUTES * MIN) continue;
      if (!best || d < best.d || (d === best.d && Number(p.meta.id) < Number(best.p.meta.id))) best = { p, d };
    }
    if (!best) continue; // no activity row near it (send_now): the ledger row stands as its own send
    const twin = twins.get(e.ref);
    best.p.meta.deliveries.push({
      ref: twin ? twin.ref : e.ref,
      channel: e.channel,
      failed: Boolean(twin ? twin.meta.failed : e.meta.failed),
    });
    absorbed.add(e.ref);
  }
  return absorbed;
}

function resolveRelayNotices(events) {
  const customerTimes = new Map();
  for (const e of events) {
    if (e.meta.source === 'tt' && e.direction === 'in' && e.meta.negotiationId) {
      const list = customerTimes.get(e.meta.negotiationId) || [];
      list.push(t(e));
      customerTimes.set(e.meta.negotiationId, list);
    }
  }
  const out = [];
  for (const e of events) {
    if (!(e.meta.source === 'sms' && e.meta.relayNotice)) { out.push(e); continue; }
    const times = customerTimes.get(e.meta.relayNegotiationId) || [];
    if (times.some((ms) => Math.abs(ms - t(e)) <= TT_MISSED_MINUTES * MIN)) continue; // the webhook delivered it
    if (e.meta.relayQuoted) {
      // Their words, quoted below Thumbtack's dash line: their inbound
      // Thumbtack message. Pass 2 loads only the words (readSms.js).
      out.push({
        ...e, channel: 'thumbtack', line: null, kind: 'message',
        meta: { ...e.meta, relayNotice: false, negotiationId: e.meta.relayNegotiationId },
      });
      continue;
    }
    out.push({
      ...e, channel: 'thumbtack', line: null, kind: 'tt_missed', text: TT_MISSED_TEXT,
      meta: { ...e.meta, relayNotice: false, negotiationId: e.meta.relayNegotiationId },
    });
  }
  return out;
}

function markAutoFirstReplies(events) {
  const byNegotiation = new Map();
  for (const e of events) {
    if (e.meta.source === 'tt' && e.direction === 'out' && e.meta.firstReplySentAt) {
      const list = byNegotiation.get(e.meta.negotiationId) || [];
      list.push(e);
      byNegotiation.set(e.meta.negotiationId, list);
    }
  }
  for (const list of byNegotiation.values()) {
    let best = null;
    for (const e of list) {
      const d = Math.abs(t(e) - new Date(e.meta.firstReplySentAt).getTime());
      if (d > AUTO_FIRST_REPLY_MINUTES * MIN) continue;
      if (!best || d < best.d || (d === best.d && Number(e.meta.id) < Number(best.e.meta.id))) best = { e, d };
    }
    if (best) best.e.meta.autoFirstReply = true;
  }
}

function addOptOutCompanions(events) {
  const out = [];
  for (const e of events) {
    out.push(e);
    if (e.meta.source === 'sms' && e.direction === 'in' && e.meta.optKeyword === 'stop') {
      out.push({
        ref: `${e.ref}:opt_out`, personKey: e.personKey, channel: e.channel, line: e.line, direction: 'system',
        at: e.at, author: null, kind: 'opt_out', text: null,
        meta: { source: 'sms', id: e.meta.id, companionOf: e.ref },
      });
    }
  }
  return out;
}

function normalizeEvents(raw, { floor = INBOX_HISTORY_START } = {}) {
  const list = (raw || []).filter(Boolean);
  // All or nothing (see the header): one raw event re-runs every step on all.
  if (list.length && list.every((e) => e.meta && e.meta.normalized)) return [...list].sort(byTime);
  const floorMs = new Date(floor).getTime();
  let events = list
    .filter((e) => e.personKey && e.meta && Number.isFinite(t(e)) && t(e) >= floorMs)
    .map((e) => ({ ...e, meta: { ...e.meta } }));
  events = collapseGroupSends(events);
  const twins = linkLedgerTwins(events);
  const absorbed = absorbProposalDeliveries(events, twins);
  events = events.filter((e) => !absorbed.has(e.ref) && !twins.has(e.ref));
  events = resolveRelayNotices(events);
  markAutoFirstReplies(events);
  events = addOptOutCompanions(events);
  for (const e of events) e.meta.normalized = true;
  return events.sort(byTime);
}

module.exports = { normalizeEvents, byTime };
