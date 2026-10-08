'use strict';

// Who a reply goes to, and the rows the line rule reads (decision 29, spec
// 5.8). PURE, over the person's normalized events.

const { lineE164 } = require('../smsLines');

const E164_RE = /^\+\d{8,15}$/;

// A Thumbtack notice texted from a proxy number: "never received", or one
// that quotes their words, which is their Thumbtack message (Task 18 F1).
// Either way it is Thumbtack's text, never theirs.
const isThumbtackNotice = (e) => e.kind === 'tt_missed' || Boolean(e.meta.relayQuoted);

// Their own texts: inbound SMS rows (an opt-word line is still their text),
// never a Thumbtack notice from a proxy number.
function isTheirText(e) {
  return Boolean(e.meta && e.meta.source === 'sms' && e.meta.inbound && !e.meta.companionOf
    && !isThumbtackNotice(e) && E164_RE.test(String(e.meta.phone || '')));
}

// The E.164 on their latest inbound text; with none, the fallback the caller
// already normalized (clients.phone, or the staff profile phone). Never a
// number rebuilt from a person key: a p- key holds only ten digits.
function pickRecipient({ events, fallbackE164 = null }) {
  const latest = events.findLast(isTheirText);
  return latest ? latest.meta.phone : (fallbackE164 || null);
}

// The person's texts as the sms_messages rows lane sms-lines'
// lastHumanLineFromRows reads ({ id, direction, sender_id, status, metadata,
// created_at }; it orders them itself), so the Messages reply and Inbox share
// one "last human-involved line" rule (decision 9, amendment 20). An inbound
// row carries the DRB number it reached and its relay flag; an outbound row
// its line. Companion lines are not rows of their own.
function smsRowsOf(events) {
  const rows = [];
  for (const e of events) {
    if (!e.meta || e.meta.source !== 'sms' || e.meta.companionOf) continue;
    const inbound = Boolean(e.meta.inbound);
    const metadata = inbound
      ? { to: lineE164(e.line || '888'), ...(e.meta.relay ? { thumbtack_relay: true } : {}) }
      : { line: e.line || null };
    rows.push({
      id: e.meta.id,
      direction: inbound ? 'inbound' : 'outbound',
      sender_id: inbound ? null : (e.meta.smsSenderId || null),
      status: e.meta.failed ? 'failed' : (inbound ? 'received' : 'sent'),
      metadata,
      created_at: new Date(e.at),
    });
  }
  return rows;
}

// The DRB line of their latest inbound text, or null (amendment 21: the
// page's "they texted the 1922" hint). A Thumbtack notice is Thumbtack's.
function theirLineOf(events) {
  const latest = events.findLast((e) => e.meta && e.meta.source === 'sms' && e.meta.inbound && !e.meta.companionOf
    && !isThumbtackNotice(e));
  return latest ? (latest.line || '888') : null;
}

// The channel of their latest message, which decides the reply area (4.3).
function latestConversationChannel(events) {
  const latest = events.findLast((e) => e.direction === 'in' && !e.meta.skip
    && ['thumbtack', 'text', 'staff_text'].includes(e.channel));
  return latest ? latest.channel : null;
}

module.exports = { pickRecipient, smsRowsOf, theirLineOf, latestConversationChannel };
