'use strict';

// HTTP bodies (snake_case) for GET /api/admin/inbox and GET /api/admin/inbox/:personKey
// (contract). PURE: the engine hands in the rules result, the directory of
// names and kinds, and whatever it loaded.
//
// Menu tasks (spec 2026-10-19 section 13.2): a waiting row carries `link`, the
// open task's event link when its text is the row's need line (else null),
// and `tasks_only`, true when only menu tasks hold the row (Done is hidden
// there: Done never clears a task). The item carries `tasks_only` too, and
// both carry it inside `state` as well, the object the item's actions read
// (ItemActions.js draws no Done while it is true), beside `has_task`: an open
// menu task holds this person, alone or beside a text, waiting or snoozed
// (useInboxActions.js says Done leaves them waiting on the menu only when
// the status it reads back is waiting too). The client's change note is
// never on the list; it rides only on its thread row.

const { buildThread } = require('./thread');

const iso = (d) => (d ? new Date(d).toISOString() : null);

// The state object on every list row and on the item. since is the claim's
// time on a claim chip (lane inbox-page: "since Mon 11:02 AM"), else null.
// tasks_only: only menu tasks hold the person; has_task: an open menu task
// holds them (spec 2026-10-19 section 13.2).
function stateJson(s, { tasksOnly = false, hasTask = false } = {}) {
  return {
    type: s ? s.type : null,
    by_user_id: s && s.byUserId !== undefined ? s.byUserId : null,
    by_name: s && s.byName !== undefined ? s.byName : null,
    mine: Boolean(s && s.mine),
    promised_by: s && s.promisedBy ? s.promisedBy : null,
    since: s && s.since ? iso(s.since) : null,
    tasks_only: Boolean(tasksOnly),
    has_task: Boolean(hasTask),
  };
}

// An open menu task holds a waiting or snoozed person (rules.js keeps them in internals.tasks).
const holdsTask = (p) => Boolean(p && p.internals && Array.isArray(p.internals.tasks) && p.internals.tasks.length > 0);

// Why a handled item closed (lane inbox-page). Null unless status is handled.
function closedJson(state) {
  if (!state || state.status !== 'handled' || !state.closed) return null;
  return { reason_text: state.closed.reasonText, closed_at: iso(state.closed.at), by: state.closed.by };
}

function listPayload({ result, directory, feeds, aiStatus, generatedAt }) {
  return {
    generated_at: iso(generatedAt),
    ai: { status: aiStatus },
    // personal: personal mail, judged once per mail by the sync
    // (personalMail.js, spec 2026-10-14 decision 6), the row's "dallas@"
    // chip; only the owner's list ever holds one. pitch: the newest inbound
    // was read as a solicitation (decision 12), the row's "Pitch" chip.
    waiting: result.waiting.map((p) => ({
      person_key: p.personKey, name: directory.nameOf(p.personKey), kind: directory.kindOf(p.personKey),
      need: p.need, waiting_since: iso(p.waitingSince), hot: p.hot, channels: p.channels, state: stateJson(p.state, { tasksOnly: p.tasksOnly, hasTask: holdsTask(p) }),
      personal: Boolean(p.personal), pitch: Boolean(p.pitch),
      link: p.link || null, tasks_only: Boolean(p.tasksOnly),
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
    state: stateJson(state ? state.state : null, { tasksOnly: open && state.tasksOnly, hasTask: open && holdsTask(state) }),
    snooze: state && state.snooze ? { until: iso(state.snooze.until), by_name: state.snooze.byName, mine: state.snooze.mine } : null,
    closed: closedJson(state),
    legal_hold: Boolean(legalHold || (state && state.legalHold)),
    tasks_only: Boolean(open && state.tasksOnly),
    context,
    thread: buildThread({ state, events, actions, reads, now, viewerId, users }),
    reply,
  };
}

module.exports = { listPayload, itemPayload, stateJson };
