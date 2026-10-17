'use strict';

// What the AI reads (spec 6.1 and 6.2), PURE. At most one inbound and one
// outbound subject per person, each with the slice lane inbox-ai's job
// redacts and sends. Shape agreed with that lane: every slice line carries its
// event ref, and context=true marks the up to three lines before the anchor.
//
// One read per mail (spec 2026-10-14 section 6): a Sent mail to several
// people is one event per person (gm:<id>:1, gm:<id>:2, or gm:<id>:z through
// Zola's relay), all sharing meta.readRef gm:<id>. Each person's subject keeps
// its own event's ref as subjectRef, the ref its slice lines carry, so every
// match of a line to its subject stays exact; readRef names the key the read
// job stores and finds the read under, so the words go out once and every
// sibling reads that one row (classify.readOf). A slice line carries
// legalHold from its event (engine.markHeldSiblings for a Sent mail that
// reached a held key, engine.markHeldAddresses for a mail whose From, To or
// Cc names a held address), which aiRead.isReadable refuses.

const C = require('./classify');

const ms = (d) => new Date(d).getTime();
// Cost bound (spec 6.6 assumes about 1,000 input tokens a read): an unanswered
// stretch longer than this keeps its newest lines.
const AFTER_ANCHOR_MAX = 20;

const readRefOf = (e) => (e.meta && e.meta.readRef) || e.ref;

// A read under the mail's readRef, else under the event's own ref (readOf's
// order), settles the subject.
function resolved(ctx, kind, e) {
  const settled = (r) => Boolean(r && (r.status === 'ok' || r.status === 'refused'));
  return settled(ctx.readsByKey.get(`${kind}:${readRefOf(e)}`)) || settled(ctx.readsByKey.get(`${kind}:${e.ref}`));
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
// quit stay: they are real messages (5.3). A Zola notice the OS could not
// read is in, as a missed Thumbtack message is, so the model sees there was
// one (spec 2026-10-14 section 6); auto-replies and bounces stay out.
function inSlice(e, subjectRef) {
  if (e.ref === subjectRef) return true;
  if (e.kind === 'opt_out' || e.kind === 'opt_in' || e.meta.optWord) return false;
  if (e.direction === 'out' && e.meta.failed) return false;
  if (e.direction === 'in' && e.meta.skip) return false;
  return ['message', 'media', 'tt_missed', 'zola_unread', 'proposal_sent', 'call'].includes(e.kind);
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
      legalHold: Boolean(e.meta.legalHold),
    };
  };
  return [...before.map((e) => line(e, true)), ...after.map((e) => line(e, false))];
}

function buildSubjects(states, byPerson, ctx) {
  const out = [];
  for (const st of states) {
    // Personal mail, judged once per mail by the sync (personalMail.js), is
    // never read, inbound or outbound (spec 2026-10-14 decision 6): its words
    // never leave the OS.
    if (st.personal) continue;
    const events = byPerson.get(st.personKey) || [];
    const { U, real, dones, zolaClosed = [], anchorMs, newestInbound } = st.internals;
    const name = ctx.nameOf ? ctx.nameOf(st.personKey) : null;
    const push = (kind, subject, sliceAnchorMs) => out.push({
      kind, subjectRef: subject.ref, readRef: readRefOf(subject), personKey: st.personKey, name: name || null, at: new Date(subject.at),
      legalHold: st.legalHold, slice: sliceFor(events, subject, sliceAnchorMs, ctx),
    });
    // Inbound: the newest message in U, while the person waits (6.1).
    if ((st.status === 'waiting' || st.status === 'snoozed') && U.length) {
      const subject = U[U.length - 1];
      if (isReadableInbound(subject) && !resolved(ctx, 'inbound', subject)) push('inbound', subject, anchorMs);
    }
    // Outbound: the latest real text-bearing reply after the newest inbound,
    // the one that would close the item. The auto first reply is holding by
    // rule and never read.
    if (st.status !== 'quiet' && newestInbound) {
      const after = real.filter((e) => ms(e.at) > ms(newestInbound.at) && C.isTextBearingReply(e) && !e.meta.autoFirstReply);
      const subject = after[after.length - 1];
      if (subject && !resolved(ctx, 'outbound', subject)) {
        // Every close before it anchors the slice: a real reply, a Done, or a
        // Zola closed notice (the couple's own Done, spec 2026-10-14 decision 19).
        const prior = [...real.map((e) => ms(e.at)), ...dones.map((a) => ms(a.created_at)), ...zolaClosed.map((e) => ms(e.at))]
          .filter((x) => x < ms(subject.at));
        push('outbound', subject, Math.max(-Infinity, ...prior));
      }
    }
  }
  return out.sort((a, b) => (a.at - b.at) || (a.subjectRef < b.subjectRef ? -1 : 1));
}

module.exports = { buildSubjects, sliceFor };
