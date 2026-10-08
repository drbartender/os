'use strict';

// What the AI reads (spec 6.1 and 6.2), PURE. At most one inbound and one
// outbound subject per person, each with the slice lane inbox-ai's job
// redacts and sends. Shape agreed with that lane: every slice line carries its
// event ref, and context=true marks the up to three lines before the anchor.

const C = require('./classify');

const ms = (d) => new Date(d).getTime();
// Cost bound (spec 6.6 assumes about 1,000 input tokens a read): an unanswered
// stretch longer than this keeps its newest lines.
const AFTER_ANCHOR_MAX = 20;

function resolved(ctx, kind, ref) {
  const r = ctx.readsByKey.get(`${kind}:${ref}`);
  return Boolean(r && (r.status === 'ok' || r.status === 'refused'));
}

// Picture-only and empty messages are never read (6.1). A header-only event
// (text not loaded) counts as readable; the engine's final run has full rows.
function isReadableInbound(e) {
  if (e.kind === 'message') return !e.meta.empty;
  if (e.kind === 'media') return Boolean(e.text && String(e.text).trim());
  return false;
}

// Left out of every slice: the seven opt words and the "Opted out" lines,
// failed sends, and handled shift commands. Help, info, cancel, yes, end and
// quit stay: they are real messages (5.3).
function inSlice(e, subjectRef) {
  if (e.ref === subjectRef) return true;
  if (e.kind === 'opt_out' || e.kind === 'opt_in' || e.meta.optWord) return false;
  if (e.direction === 'out' && e.meta.failed) return false;
  if (e.direction === 'in' && e.meta.skip) return false;
  return ['message', 'media', 'tt_missed', 'proposal_sent', 'call'].includes(e.kind);
}

function sliceFor(events, subject, anchorMs, ctx) {
  const eligible = events.filter((e) => inSlice(e, subject.ref));
  const upTo = eligible.slice(0, eligible.findIndex((e) => e.ref === subject.ref) + 1);
  const before = upTo.filter((e) => ms(e.at) <= anchorMs).slice(-3);
  const after = upTo.filter((e) => ms(e.at) > anchorMs).slice(-AFTER_ANCHOR_MAX);
  const line = (e, context) => {
    const id = C.authorOf(e);
    let authorFirstName = null;
    if (e.direction !== 'in') authorFirstName = id ? ctx.firstName(id) : (e.author === 'auto' ? 'Auto' : null);
    return {
      ref: e.ref, who: e.direction === 'in' ? 'THEM' : 'US', authorFirstName,
      channel: C.channelTag(e) || e.channel || null, at: new Date(e.at).toISOString(), text: C.sliceText(e), context,
    };
  };
  return [...before.map((e) => line(e, true)), ...after.map((e) => line(e, false))];
}

function buildSubjects(states, byPerson, ctx) {
  const out = [];
  for (const st of states) {
    const events = byPerson.get(st.personKey) || [];
    const { U, real, dones, anchorMs, newestInbound } = st.internals;
    const name = ctx.nameOf ? ctx.nameOf(st.personKey) : null;
    const push = (kind, subject, sliceAnchorMs) => out.push({
      kind, subjectRef: subject.ref, personKey: st.personKey, name: name || null, at: new Date(subject.at),
      legalHold: st.legalHold, slice: sliceFor(events, subject, sliceAnchorMs, ctx),
    });
    // Inbound: the newest message in U, while the person waits (6.1).
    if ((st.status === 'waiting' || st.status === 'snoozed') && U.length) {
      const subject = U[U.length - 1];
      if (isReadableInbound(subject) && !resolved(ctx, 'inbound', subject.ref)) push('inbound', subject, anchorMs);
    }
    // Outbound: the latest real text-bearing reply after the newest inbound,
    // the one that would close the item. The auto first reply is holding by
    // rule and never read.
    if (st.status !== 'quiet' && newestInbound) {
      const after = real.filter((e) => ms(e.at) > ms(newestInbound.at) && C.isTextBearingReply(e) && !e.meta.autoFirstReply);
      const subject = after[after.length - 1];
      if (subject && !resolved(ctx, 'outbound', subject.ref)) {
        const prior = [...real.map((e) => ms(e.at)), ...dones.map((a) => ms(a.created_at))].filter((x) => x < ms(subject.at));
        push('outbound', subject, Math.max(-Infinity, ...prior));
      }
    }
  }
  return out.sort((a, b) => (a.at - b.at) || (a.subjectRef < b.subjectRef ? -1 : 1));
}

module.exports = { buildSubjects, sliceFor };
