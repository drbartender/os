'use strict';

// Recently handled reasons (spec 4.5), PURE. "You" means the viewer.

const C = require('./classify');
const { SEND_LABELS } = require('./constants');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthDay(ymd) {
  const [, m, d] = String(ymd).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

const labelFor = (messageType) => SEND_LABELS.get(messageType) || 'a message';

// "You sent the shopping list" / "Proposal sent by Zul".
function sendReason(label, id, ctx) {
  if (id !== null && id === ctx.viewerId) return `You sent ${label}`;
  const noun = label.replace(/^(the|a) /, '');
  const head = noun.charAt(0).toUpperCase() + noun.slice(1);
  return id ? `${head} sent by ${ctx.firstName(id)}` : `${head} sent`;
}

function replyReason(e, ctx) {
  const id = C.authorOf(e);
  const you = id !== null && id === ctx.viewerId;
  const who = you ? 'You' : (id ? ctx.firstName(id) : 'Someone');
  const by = id ? ctx.firstName(id).charAt(0).toUpperCase() : null;
  switch (e.meta.source) {
    case 'sms':
      if (C.isUserId(e.meta.smsSenderId)) return { reasonCode: 'text', reasonText: `${who} texted back from ${e.line || '888'}`, by };
      return { reasonCode: 'send', reasonText: sendReason(labelFor(e.meta.ledgerMessageType), id, ctx), by };
    case 'ml':
      return { reasonCode: 'send', reasonText: sendReason(labelFor(e.meta.messageType), id, ctx), by };
    case 'pal':
      return { reasonCode: 'proposal', reasonText: sendReason('the proposal', id, ctx), by };
    case 'tt':
      return { reasonCode: 'thumbtack', reasonText: 'Replied in Thumbtack', by: null };
    case 'lc':
    case 'cc': {
      const minutes = Math.max(1, Math.round(Number(e.meta.durationSec || 0) / 60));
      return { reasonCode: 'call', reasonText: `${who} called (${minutes} min)`, by };
    }
    default:
      return { reasonCode: 'reply', reasonText: `${who} replied`, by };
  }
}

// c: { type: 'ai'|'event'|'done'|'reply', at, read?, eventYmd?, action?, event?,
//      stretchInbound, needOf }
function describeCloser(c, ctx) {
  const source = c.stretchInbound || c.event || null;
  const base = { at: new Date(c.at), need: c.needOf(c.stretchInbound), channel: source ? C.channelTag(source) : null };
  if (c.type === 'ai') {
    const reason = String((c.read && c.read.reason) || '').trim() || 'no reply needed';
    return { ...base, reasonCode: 'ai', reasonText: `AI: ${reason}`, detail: reason, by: 'AI' };
  }
  if (c.type === 'event') {
    return { ...base, reasonCode: 'event', reasonText: `Event happened ${monthDay(c.eventYmd)}`, detail: monthDay(c.eventYmd), by: 'AI' };
  }
  if (c.type === 'done') {
    const id = Number(c.action.user_id) || null;
    const who = id !== null && id === ctx.viewerId ? 'You' : (id ? ctx.firstName(id) : 'Someone');
    return { ...base, reasonCode: 'done', reasonText: `${who} marked it done`, detail: null, by: id ? ctx.firstName(id).charAt(0).toUpperCase() : null };
  }
  return { ...base, ...replyReason(c.event, ctx), detail: null };
}

module.exports = { describeCloser, monthDay };
