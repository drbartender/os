'use strict';

// HTTP bodies (snake_case) for GET /api/admin/inbox and GET /api/admin/inbox/:personKey
// (contract). PURE: the engine hands in the rules result, the directory of
// names and kinds, and whatever it loaded.

const { buildThread } = require('./thread');

const iso = (d) => (d ? new Date(d).toISOString() : null);

// The state object on every list row and on the item. since is the claim's
// time on a claim chip (lane inbox-page: "since Mon 11:02 AM"), else null.
function stateJson(s) {
  return {
    type: s ? s.type : null,
    by_user_id: s && s.byUserId !== undefined ? s.byUserId : null,
    by_name: s && s.byName !== undefined ? s.byName : null,
    mine: Boolean(s && s.mine),
    promised_by: s && s.promisedBy ? s.promisedBy : null,
    since: s && s.since ? iso(s.since) : null,
  };
}

// Why a handled item closed (lane inbox-page). Null unless status is handled.
function closedJson(state) {
  if (!state || state.status !== 'handled' || !state.closed) return null;
  return { reason_text: state.closed.reasonText, closed_at: iso(state.closed.at), by: state.closed.by };
}

function listPayload({ result, directory, feeds, aiStatus, generatedAt }) {
  return {
    generated_at: iso(generatedAt),
    ai: { status: aiStatus },
    waiting: result.waiting.map((p) => ({
      person_key: p.personKey, name: directory.nameOf(p.personKey), kind: directory.kindOf(p.personKey),
      need: p.need, waiting_since: iso(p.waitingSince), hot: p.hot, channels: p.channels, state: stateJson(p.state),
    })),
    snoozed: result.snoozed.map((p) => ({
      person_key: p.personKey, name: directory.nameOf(p.personKey), until: iso(p.snooze.until),
      by_name: p.snooze.byName, mine: p.snooze.mine,
    })),
    handled: result.handled.map((p) => ({
      person_key: p.personKey, name: directory.nameOf(p.personKey), need: p.closed.need, channel: p.closed.channel,
      closed_at: iso(p.closed.at), reason_code: p.closed.reasonCode, reason_text: p.closed.reasonText, by: p.closed.by,
    })),
    feeds,
  };
}

function itemPayload({ personKey, state, events, actions, reads, now, viewerId, users, directory, context, legalHold, reply }) {
  const open = Boolean(state) && (state.status === 'waiting' || state.status === 'snoozed');
  return {
    person: { person_key: personKey, name: directory.nameOf(personKey), kind: directory.kindOf(personKey) },
    status: state ? state.status : 'quiet',
    waiting: Boolean(state && state.status === 'waiting'),
    waiting_since: open ? iso(state.waitingSince) : null,
    need: state ? state.need : null,
    state: stateJson(state ? state.state : null),
    snooze: state && state.snooze ? { until: iso(state.snooze.until), by_name: state.snooze.byName, mine: state.snooze.mine } : null,
    closed: closedJson(state),
    legal_hold: Boolean(legalHold || (state && state.legalHold)),
    context,
    thread: buildThread({ state, events, actions, reads, now, viewerId, users }),
    reply,
  };
}

module.exports = { listPayload, itemPayload, stateJson };
