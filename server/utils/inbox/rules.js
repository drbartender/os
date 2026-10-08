'use strict';

// The Inbox rules (spec 2026-10-06, sections 5.5 and 5.6). PURE: no I/O and
// no clock read. computeInbox takes every event the readers produced plus the
// stored taps, opens and AI reads, and says for each person whether they are
// waiting, snoozed, recently handled, or quiet, and what the AI should read.
// Every case in spec section 14 "Rules" is a test in rules.*.test.js.

const { CLAIM_HOURS, HOT_HOURS, HANDLED_DAYS } = require('./constants');
const { normalizeEvents } = require('./normalize');
const C = require('./classify');
const { describeCloser } = require('./reasons');
const { buildSubjects } = require('./subjects');
const { isBooked } = require('../proposalStatus');
const { chicagoYmdOf, eventLocalToUtc } = require('../businessTime');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ms = (d) => new Date(d).getTime();
const last = (arr) => (arr.length ? arr[arr.length - 1] : null);

function makeContext({ reads = [], actions = [], seen = [], proposals = [], now = new Date(), viewerId = null, users = [], nameOf = null }) {
  const readsByKey = new Map(reads.map((r) => [`${r.kind}:${r.subject_ref}`, r]));
  const actionsByPerson = new Map();
  const live = actions.filter((a) => !a.undone_at)
    .sort((a, b) => (ms(a.created_at) - ms(b.created_at)) || (Number(a.id) - Number(b.id)));
  for (const a of live) {
    const list = actionsByPerson.get(a.person_key) || [];
    list.push(a);
    actionsByPerson.set(a.person_key, list);
  }
  const proposalsByPerson = new Map();
  const legalHoldPersons = new Set();
  for (const p of proposals) {
    const list = proposalsByPerson.get(p.person_key) || [];
    list.push(p);
    proposalsByPerson.set(p.person_key, list);
    if (p.legal_hold) legalHoldPersons.add(p.person_key);
  }
  const nowDate = new Date(now);
  return {
    readsByKey, actionsByPerson, proposalsByPerson, legalHoldPersons,
    seenByPerson: new Map(seen.map((s) => [s.person_key, s])),
    now: nowDate, nowMs: nowDate.getTime(), todayYmd: chicagoYmdOf(nowDate),
    viewerId: viewerId === null || viewerId === undefined ? null : Number(viewerId),
    firstName: C.makeNamer(users),
    nameOf: typeof nameOf === 'function' ? nameOf : null,
  };
}

// Step 4, event happened (decision 22). Returns the event's 'YYYY-MM-DD', or null.
function eventHappenedDate(personKey, ctx, refMs) {
  const props = (ctx.proposalsByPerson.get(personKey) || []).filter((p) => p.event_date);
  if (!props.length || refMs === null) return null;
  const today = ctx.todayYmd;
  if (props.some((p) => p.status !== 'archived' && p.event_date >= today)) return null; // an upcoming event blocks it
  const past = props.filter((p) => p.event_date < today).sort((a, b) => {
    if (a.event_date !== b.event_date) return a.event_date < b.event_date ? 1 : -1;
    return Number(isBooked(b.status)) - Number(isBooked(a.status));
  });
  const mostRecent = past[0];
  if (!mostRecent || !isBooked(mostRecent.status)) return null; // an unbooked quote or a cancelled booking
  return chicagoYmdOf(new Date(refMs)) < mostRecent.event_date ? mostRecent.event_date : null;
}

// Step 4, snoozed (4.4): until is ahead, made after the newest inbound and
// after the anchor (a snooze defers the stretch it was made in, as a claim
// does, so the latest real reply or Done ends it), and not ended by a later
// Wake (or a Reopen, which also brings it back to Waiting).
function activeSnooze(acts, newestInbound, anchorMs, ctx) {
  const s = last(acts.filter((a) => a.action === 'snooze'));
  if (!s || !s.until_at || ms(s.until_at) <= ctx.nowMs) return null;
  if (newestInbound && ms(s.created_at) <= ms(newestInbound.at)) return null;
  if (ms(s.created_at) <= anchorMs) return null;
  if (acts.some((a) => (a.action === 'wake' || a.action === 'reopen') && ms(a.created_at) > ms(s.created_at))) return null;
  const by = Number(s.user_id) || null;
  return { until: new Date(s.until_at), byUserId: by, byName: by ? ctx.firstName(by) : null, mine: by !== null && by === ctx.viewerId };
}

// Step 6: the latest claim after the anchor and after any later holding reply
// (a claim ends when anyone replies, 4.4), under 4 hours old, not released.
function activeClaim(acts, anchorMs, P, ctx) {
  const claim = last(acts.filter((a) => a.action === 'claim'));
  if (!claim) return null;
  const at = ms(claim.created_at);
  if (at <= Math.max(anchorMs, P.length ? ms(last(P).at) : -Infinity)) return null;
  if (ctx.nowMs - at >= CLAIM_HOURS * HOUR) return null;
  if (acts.some((a) => a.action === 'release' && ms(a.created_at) > at)) return null;
  return claim;
}

// One chip at most, in priority order (4.1).
function chipFor({ claim, P, reopen, reopenWaits, U, seen, reads, ctx }) {
  const asUser = (id) => (C.isUserId(Number(id)) ? Number(id) : null);
  const mine = (id) => asUser(id) !== null && asUser(id) === ctx.viewerId;
  // since: the claim's time, for "since Mon 11:02 AM"; null on every other chip.
  if (claim) {
    return {
      type: 'claim', byUserId: asUser(claim.user_id), byName: ctx.firstName(claim.user_id), mine: mine(claim.user_id),
      promisedBy: null, since: new Date(claim.created_at),
    };
  }
  if (P.length) {
    const p = last(P);
    const author = C.authorOf(p);
    const r = C.readOf(reads, 'outbound', p.ref);
    return {
      type: 'promise', byUserId: author, byName: author ? ctx.firstName(author) : null, mine: mine(author),
      promisedBy: (r && r.promised_by) || null, since: null,
    };
  }
  if (reopenWaits && !U.some((e) => ms(e.at) > ms(reopen.created_at))) {
    return {
      type: 'reopened', byUserId: asUser(reopen.user_id), byName: ctx.firstName(reopen.user_id), mine: mine(reopen.user_id),
      promisedBy: null, since: null,
    };
  }
  if (!seen) return { type: 'unseen', byUserId: null, byName: null, mine: false, promisedBy: null, since: null };
  return null;
}

// 5.6: the event that closed the latest waiting stretch, the earliest of the
// real reply, the Done, and the AI's no-reply read. The read closes only a
// stretch nothing else held open as it landed: a promise of ours or a Reopen
// between the previous close and their newest message kept them waiting
// (decision 23), so the person who then answered closed it.
function findCloser({ U, newestU, subjectRead, inbound, holding, real, dones, acts, anchorMs, inboundRead }) {
  if (U.length) {
    // Every unanswered message is covered by a no-reply read: the AI closed it.
    const at = Math.max(ms(subjectRead.updated_at || subjectRead.created_at || newestU.at), ms(newestU.at));
    return { type: 'ai', at: new Date(at), read: subjectRead, stretchInbound: newestU };
  }
  const openers = [
    ...inbound.map((e) => ({ at: ms(e.at), event: e })),
    ...holding.map((e) => ({ at: ms(e.at), event: e })),
    ...acts.filter((a) => a.action === 'reopen').map((a) => ({ at: ms(a.created_at), event: null })),
  ].filter((o) => o.at <= anchorMs).sort((a, b) => a.at - b.at);
  const start = last(openers);
  if (!start) return null; // never waited
  const closerTimes = [...real.map((e) => ms(e.at)), ...dones.map((a) => ms(a.created_at))];
  const prevMs = Math.max(-Infinity, ...closerTimes.filter((x) => x < start.at));
  const stretchInbound = inbound.filter((e) => ms(e.at) > prevMs && ms(e.at) <= start.at);
  const newest = last(stretchInbound);
  const candidates = [
    ...real.filter((e) => ms(e.at) > start.at).map((e) => ({ type: 'reply', at: new Date(e.at), event: e })),
    ...dones.filter((a) => ms(a.created_at) > start.at).map((a) => ({ type: 'done', at: new Date(a.created_at), action: a })),
  ];
  const heldOpen = holding.some((h) => ms(h.at) > prevMs && ms(h.at) < start.at)
    || acts.some((a) => a.action === 'reopen' && ms(a.created_at) > prevMs && ms(a.created_at) < start.at);
  if (newest && newest === start.event && !C.aiCannotClose(newest) && !heldOpen) {
    const r = inboundRead(newest);
    const sticky = stretchInbound.some((e) => { const x = inboundRead(e); return Boolean(x && x.needs_reply === true); });
    if (r && r.needs_reply === false && !sticky) {
      candidates.push({ type: 'ai', at: new Date(Math.max(ms(r.updated_at || r.created_at || newest.at), ms(newest.at))), read: r });
    }
  }
  candidates.sort((a, b) => a.at - b.at);
  // What they needed: the stretch's newest message, else (a kept promise, a
  // reopened item marked Done) the last one at or before the stretch began,
  // as the waiting row falls back to their newest message.
  const needFrom = newest || last(inbound.filter((e) => ms(e.at) <= start.at));
  return candidates[0] ? { ...candidates[0], stretchInbound: needFrom } : null;
}

function computePersonState(personKey, events, ctx) {
  const reads = ctx.readsByKey;
  const acts = ctx.actionsByPerson.get(personKey) || [];
  const legalHold = ctx.legalHoldPersons.has(personKey);
  const inboundRead = (e) => (e && !legalHold ? C.readOf(reads, 'inbound', e.ref) : null);
  const needOf = (e) => {
    if (!e) return null;
    const r = inboundRead(e);
    return (r && r.summary) || C.eventNeedText(e);
  };

  const inbound = events.filter(C.isCountedInbound);
  const replies = events.filter(C.countsAsReply);
  const holding = replies.filter((e) => C.isHolding(e, reads, legalHold));
  const holdingRefs = new Set(holding.map((e) => e.ref));
  const real = replies.filter((e) => !holdingRefs.has(e.ref));
  const dones = acts.filter((a) => a.action === 'done');

  // 1. anchor = max(latest real reply, latest Done)
  const lastReal = last(real);
  const lastDone = last(dones);
  const anchorMs = Math.max(lastReal ? ms(lastReal.at) : -Infinity, lastDone ? ms(lastDone.created_at) : -Infinity);

  // 2. U: counted inbound at or after the anchor (a message at the anchor's
  // instant is unanswered: ties resolve toward waiting); P: holding replies
  // after it
  const U = inbound.filter((e) => ms(e.at) >= anchorMs);
  const P = holding.filter((e) => ms(e.at) > anchorMs);
  const reopen = last(acts.filter((a) => a.action === 'reopen'));
  const reopenWaits = Boolean(reopen && ms(reopen.created_at) > anchorMs);

  // 3. waiting
  const newestU = last(U);
  const subjectRead = inboundRead(newestU);
  const needsReply = U.filter((e) => { const r = inboundRead(e); return Boolean(r && r.needs_reply === true); });
  const coveredNoReply = Boolean(subjectRead && subjectRead.needs_reply === false);
  const uWaits = U.length > 0 && (!coveredNoReply || needsReply.length > 0 || C.aiCannotClose(newestU));
  const waitingRaw = uWaits || P.length > 0 || reopenWaits;

  // 5. waiting since: the earliest of U and P, else the Reopen time
  const newestInbound = last(inbound);
  const starts = [U[0], P[0]].filter(Boolean).map((e) => ms(e.at));
  let waitingSince = null;
  if (starts.length) waitingSince = new Date(Math.min(...starts));
  else if (reopenWaits) waitingSince = new Date(reopen.created_at);

  // 4. not waiting even so: event happened (it outranks a snooze), or snoozed
  // A Reopen, or one of our holding replies, on or after the event's Chicago date overrides it (decision 23 over decision 22, controller ruling 2026-10-08).
  let status = 'quiet';
  let closed = null;
  let snooze = null;
  if (waitingRaw) {
    const refMs = newestInbound ? ms(newestInbound.at) : waitingSince.getTime();
    const eventYmd = eventHappenedDate(personKey, ctx, refMs);
    const onOrAfterEvent = (at) => chicagoYmdOf(new Date(at)) >= eventYmd;
    const overridden = Boolean(eventYmd
      && ((reopen && onOrAfterEvent(reopen.created_at)) || (P.length > 0 && onOrAfterEvent(last(P).at))));
    if (eventYmd && !overridden) {
      status = 'handled';
      closed = describeCloser({
        type: 'event', at: eventLocalToUtc(eventYmd, 0, 0, 'America/Chicago'), eventYmd, stretchInbound: newestInbound, needOf,
      }, ctx);
    } else {
      snooze = activeSnooze(acts, newestInbound, anchorMs, ctx);
      status = snooze ? 'snoozed' : 'waiting';
    }
  } else {
    const closer = findCloser({ U, newestU, subjectRead, inbound, holding, real, dones, acts, anchorMs, inboundRead });
    if (closer) {
      closed = describeCloser({ ...closer, needOf }, ctx);
      status = 'handled';
    }
  }
  if (status === 'handled' && ctx.nowMs - ms(closed.at) >= HANDLED_DAYS * DAY) status = 'quiet';

  // 6 and 7: the chip
  const open = status === 'waiting' || status === 'snoozed';
  const seenRow = ctx.seenByPerson.get(personKey);
  const seen = !newestInbound || Boolean(seenRow && ms(seenRow.seen_at) > ms(newestInbound.at));
  const claim = open ? activeClaim(acts, anchorMs, P, ctx) : null;
  const state = open ? chipFor({ claim, P, reopen, reopenWaits, U, seen, reads, ctx }) : null;

  // Channel tags: every channel THEY used in this waiting stretch (spec 4.1),
  // so U only; one of our holding replies (P) never becomes a tag. Ordered by
  // LAST use (U is in time order): a tag moves to the end each time it is used
  // again, so the newest channel is last (lane inbox-page reads the last entry
  // as their newest). Waiting only on a promise, it is their newest inbound's.
  const channels = [];
  for (const e of U) {
    const tag = C.channelTag(e);
    if (!tag) continue;
    const seenAt = channels.indexOf(tag);
    if (seenAt !== -1) channels.splice(seenAt, 1);
    channels.push(tag);
  }
  if (!channels.length && newestInbound) {
    const tag = C.channelTag(newestInbound);
    if (tag) channels.push(tag);
  }

  const needEvent = needsReply.length ? last(needsReply) : newestU;
  const waitingNeed = needOf(needEvent) || needOf(newestInbound)
    || (P.length ? 'Waiting on our follow-up' : null) || (reopenWaits ? 'Reopened' : null);

  return {
    personKey, status, legalHold, seen, channels,
    waitingSince: open ? waitingSince : null,
    hot: status === 'waiting' && ctx.nowMs - waitingSince.getTime() >= HOT_HOURS * HOUR,
    need: open ? waitingNeed : (closed ? closed.need : null),
    state, snooze, closed,
    internals: { U, P, real, holding, dones, anchorMs, newestInbound },
  };
}

function computeInbox(input = {}) {
  const ctx = makeContext(input);
  const events = normalizeEvents(input.events || []);
  const byPerson = new Map();
  for (const e of events) {
    const list = byPerson.get(e.personKey) || [];
    list.push(e);
    byPerson.set(e.personKey, list);
  }
  // A key with taps but no events never makes a person (amendment 22): no
  // phantom waiting row and no badge count. The engine folds taps stored under
  // an alias key onto the person's current key before this runs.
  const people = new Map();
  for (const [key, list] of byPerson) people.set(key, computePersonState(key, list, ctx));
  const states = [...people.values()];
  const byKey = (a, b) => (a.personKey < b.personKey ? -1 : (a.personKey > b.personKey ? 1 : 0));
  return {
    waiting: states.filter((s) => s.status === 'waiting').sort((a, b) => (a.waitingSince - b.waitingSince) || byKey(a, b)),
    snoozed: states.filter((s) => s.status === 'snoozed').sort((a, b) => (a.snooze.until - b.snooze.until) || byKey(a, b)),
    handled: states.filter((s) => s.status === 'handled').sort((a, b) => (b.closed.at - a.closed.at) || byKey(a, b)),
    subjects: buildSubjects(states, byPerson, ctx),
    people,
  };
}

module.exports = { computeInbox, computePersonState, makeContext };
