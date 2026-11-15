// The menu tasks in the Inbox rules (spec 2026-10-19 section 13.2; the Inbox
// spec's decision 2 as amended 2026-11-03): a task is kept apart from the
// conversation. It is never counted, never a reply and never read by the AI;
// a reply never closes it and it never closes the client's text; Done never
// clears it; a row held only by tasks hides Done; a task opened during a
// snooze ends the snooze, and a snooze on a row held only by tasks ends on
// their newer text (for good), a newer task, a Wake or a Reopen, never on a
// text, a reply or a Done of ours. Review Focus 3 is the second test.
// Pure: invented fixtures from rules.testkit.js, no database.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const k = require('./rules.testkit');
const C = require('./classify');

const { DALLAS, NOW, HOUR, DAY, ago, plus, run, stateOf } = k;
const KINDS = ['menu_ready', 'menu_failed', 'menu_changes', 'menu_no_answer'];
const CHANGES = 'Asked for menu changes';
const NO_ANSWER = 'No answer on the menu yet. Release it for printing?';

test('all four task kinds are registered up front: never counted, never a reply, and the AI may not close one', () => {
  assert.deepEqual([...C.MENU_TASK_KINDS].sort(), [...KINDS].sort());
  for (const kind of KINDS) {
    const t = k.menuTask('c-901', ago(HOUR), kind);
    assert.equal(C.isMenuTask(t), true, kind);
    assert.equal(C.isCountedInbound(t), false, `${kind} is never counted`);
    assert.equal(C.countsAsReply(t), false, `${kind} is never a reply`);
    assert.equal(C.aiCannotClose(t), true, `${kind} is in aiCannotClose`);
    assert.equal(C.eventNeedText(t), t.text, `${kind} reads its fixed text as the need line`);
    // Shaped like their message or like a human's send, a task is still neither.
    assert.equal(C.isCountedInbound({ ...t, direction: 'in' }), false, `${kind} as an inbound`);
    assert.equal(C.countsAsReply({ ...t, direction: 'out', author: DALLAS }), false, `${kind} with a user author`);
  }
});

test('Review Focus 3: a reply to the client clears the text but not the task, and the task never answers the text', () => {
  const key = 'c-902';
  const ask = k.smsIn(key, ago(5 * HOUR), 'Can we add a mocktail?');
  const task = k.menuTask(key, ago(3 * HOUR), 'menu_changes', { proposalId: 902 });
  const both = stateOf(run({ events: [ask, task] }), key);
  assert.deepEqual([both.status, both.tasksOnly], ['waiting', false]);
  assert.deepEqual(both.internals.U.map((e) => e.ref), [ask.ref], 'the text is still unanswered');
  assert.deepEqual(both.internals.real, [], 'the task is no reply');
  assert.equal(both.waitingSince.toISOString(), ask.at.toISOString(), 'waiting since the earliest open reason');
  assert.deepEqual([both.need, both.link], [CHANGES, '/events/902?menu=1'], 'the task is the newest reason');
  // Dallas texts back: the text is answered, and the task alone holds the row.
  const reply = k.smsOut(key, ago(1 * HOUR), 'Yes, we can', { sender: DALLAS });
  const after = stateOf(run({ events: [ask, task, reply] }), key);
  assert.deepEqual(after.internals.U, [], 'the reply answered the text');
  assert.deepEqual([after.status, after.tasksOnly, after.need, after.link], ['waiting', true, CHANGES, '/events/902?menu=1']);
  assert.equal(after.waitingSince.toISOString(), task.at.toISOString());
  assert.equal(after.closed.reasonCode, 'text', 'the reply closed the conversation, and only the conversation');
});

test('a task alone makes the client wait, with the task line and its link, held only by tasks, and no channel tag', () => {
  const t = k.menuTask('c-903', ago(2 * HOUR), 'menu_no_answer', { proposalId: 903 });
  const s = stateOf(run({ events: [t] }), 'c-903');
  assert.deepEqual([s.status, s.need, s.link, s.tasksOnly, s.waitingSince.toISOString()],
    ['waiting', NO_ANSWER, '/events/903?menu=1', true, t.at.toISOString()]);
  assert.deepEqual(s.channels, []);
  const old = stateOf(run({ events: [k.menuTask('c-904', ago(2 * DAY))] }), 'c-904');
  assert.equal(old.hot, true, 'a task open a day or more is hot like any wait');
});

test('the need line is the newest reason: a text after the task is the row\'s line, with no link', () => {
  const task = k.menuTask('c-905', ago(5 * HOUR), 'menu_no_answer');
  const ask = k.smsIn('c-905', ago(1 * HOUR), 'Is the bar outside?');
  const s = stateOf(run({ events: [task, ask] }), 'c-905');
  assert.deepEqual([s.status, s.need, s.link, s.tasksOnly], ['waiting', 'Is the bar outside?', null, false]);
  assert.equal(s.waitingSince.toISOString(), task.at.toISOString(), 'waiting since the earliest open reason, the task');
  assert.deepEqual(s.channels, ['text_888'], 'the text\'s channel, never one for the task');
});

test('Done does not clear a task: the text closes, the task keeps the row waiting; Done on a task-only row changes nothing', () => {
  const key = 'c-906';
  const ask = k.smsIn(key, ago(6 * HOUR), 'Thanks for the menu');
  const task = k.menuTask(key, ago(4 * HOUR), 'menu_changes');
  const done = k.act(key, 'done', ago(1 * HOUR));
  const s = stateOf(run({ events: [ask, task], actions: [done] }), key);
  assert.deepEqual([s.status, s.tasksOnly, s.need, s.closed.reasonCode], ['waiting', true, CHANGES, 'done']);
  const only = stateOf(run({ events: [k.menuTask('c-907', ago(4 * HOUR))], actions: [k.act('c-907', 'done', ago(HOUR))] }), 'c-907');
  assert.deepEqual([only.status, only.tasksOnly], ['waiting', true]);
});

test('a row held only by tasks says so (it hides Done); a row with a waiting text does not', () => {
  const task = k.menuTask('c-908', ago(3 * HOUR));
  assert.equal(stateOf(run({ events: [task] }), 'c-908').tasksOnly, true);
  const ask = k.smsIn('c-909', ago(2 * HOUR), 'Hello?');
  assert.equal(stateOf(run({ events: [k.menuTask('c-909', ago(3 * HOUR)), ask] }), 'c-909').tasksOnly, false);
  assert.equal(stateOf(run({ events: [ask] }), 'c-909').tasksOnly, false, 'no task, no flag');
});

test('snooze hides a task; a task opened during the snooze ends it, an older one does not, and a snoozed text wakes the same way', () => {
  const key = 'c-910';
  const task = k.menuTask(key, ago(5 * HOUR), 'menu_changes', { proposalId: 910 });
  const snooze = k.act(key, 'snooze', ago(3 * HOUR), { until: plus(NOW, DAY) });
  const held = stateOf(run({ events: [task], actions: [snooze] }), key);
  assert.deepEqual([held.status, held.snooze.until.toISOString()], ['snoozed', plus(NOW, DAY).toISOString()]);
  const later = k.menuTask(key, ago(1 * HOUR), 'menu_no_answer', { proposalId: 911 });
  const woke = stateOf(run({ events: [task, later], actions: [snooze] }), key);
  assert.deepEqual([woke.status, woke.snooze, woke.need, woke.link], ['waiting', null, NO_ANSWER, '/events/911?menu=1']);
  const text = 'c-912';
  const ask = k.smsIn(text, ago(6 * HOUR), 'Let us decide next week');
  const snoozed = k.act(text, 'snooze', ago(5 * HOUR), { until: plus(NOW, DAY) });
  assert.equal(stateOf(run({ events: [ask], actions: [snoozed] }), text).status, 'snoozed');
  assert.equal(stateOf(run({ events: [ask, k.menuTask(text, ago(6 * HOUR))], actions: [snoozed] }), text).status, 'snoozed',
    'a task already open when the snooze was made stays hidden');
  assert.equal(stateOf(run({ events: [ask, k.menuTask(text, ago(2 * HOUR))], actions: [snoozed] }), text).status, 'waiting');
});

// Lane menu-inbox-followups, item 2: a snooze on a row held only by tasks
// ends on their newer text, a newer task, a Wake or a Reopen. Our own closers
// (a text the admin sends, a Done) say nothing about a task, so none of them
// ends that snooze early.
test('a tasks-only row snoozed and then texted by the admin stays snoozed; a Done does not end it either', () => {
  const key = 'c-920';
  const task = k.menuTask(key, ago(5 * HOUR), 'menu_changes', { proposalId: 920 });
  const snooze = k.act(key, 'snooze', ago(3 * HOUR), { until: plus(NOW, DAY) });
  const text = k.smsOut(key, ago(1 * HOUR), 'Quick question about your timeline', { sender: DALLAS });
  const texted = stateOf(run({ events: [task, text], actions: [snooze] }), key);
  assert.deepEqual([texted.status, texted.tasksOnly], ['snoozed', true]);
  assert.equal(texted.snooze.until.toISOString(), plus(NOW, DAY).toISOString());
  const done = k.act(key, 'done', ago(30 * 60 * 1000));
  assert.equal(stateOf(run({ events: [task, text], actions: [snooze, done] }), key).status, 'snoozed', 'a Done is not one of its closers');
});

test('a tasks-only snooze ends on a newer task, a Wake or a Reopen', () => {
  const key = 'c-921';
  const task = k.menuTask(key, ago(5 * HOUR), 'menu_changes', { proposalId: 921 });
  const snooze = k.act(key, 'snooze', ago(3 * HOUR), { until: plus(NOW, DAY) });
  const text = k.smsOut(key, ago(2 * HOUR), 'Checking in', { sender: DALLAS });
  const newer = k.menuTask(key, ago(1 * HOUR), 'menu_no_answer', { proposalId: 922 });
  const byTask = stateOf(run({ events: [task, text, newer], actions: [snooze] }), key);
  assert.deepEqual([byTask.status, byTask.snooze, byTask.need], ['waiting', null, NO_ANSWER]);
  const wake = k.act(key, 'wake', ago(1 * HOUR));
  const byWake = stateOf(run({ events: [task, text], actions: [snooze, wake] }), key);
  assert.deepEqual([byWake.status, byWake.snooze, byWake.tasksOnly], ['waiting', null, true]);
  const reopen = k.act(key, 'reopen', ago(1 * HOUR));
  const byReopen = stateOf(run({ events: [task, text], actions: [snooze, reopen] }), key);
  assert.deepEqual([byReopen.status, byReopen.snooze], ['waiting', null]);
});

// Their newer text ends a tasks-only snooze for good: the row comes back to
// Waiting while the text waits, and once we answer it (a reply or a Done) the
// task alone holds the row again, still waiting, and the old snooze never
// comes back to hide it.
test('a client text during a tasks-only snooze ends the snooze for good: after our reply or a Done the task row waits, unsnoozed', () => {
  const key = 'c-923';
  const task = k.menuTask(key, ago(6 * HOUR), 'menu_changes', { proposalId: 923 });
  const snooze = k.act(key, 'snooze', ago(5 * HOUR), { until: plus(NOW, DAY) });
  const ask = k.smsIn(key, ago(3 * HOUR), 'Can we add ten guests?');
  const back = stateOf(run({ events: [task, ask], actions: [snooze] }), key);
  assert.deepEqual([back.status, back.tasksOnly, back.snooze], ['waiting', false, null], 'their newer text ends it, as today');
  const reply = k.smsOut(key, ago(2 * HOUR), 'Yes, we can', { sender: DALLAS });
  const answered = stateOf(run({ events: [task, ask, reply], actions: [snooze] }), key);
  assert.deepEqual([answered.status, answered.tasksOnly, answered.snooze], ['waiting', true, null],
    'our reply never brings the old snooze back');
  const done = k.act(key, 'done', ago(2 * HOUR));
  const closed = stateOf(run({ events: [task, ask], actions: [snooze, done] }), key);
  assert.deepEqual([closed.status, closed.tasksOnly, closed.snooze], ['waiting', true, null],
    'nor does a Done of ours');
});

test('a row with a waiting conversation keeps today\'s snooze rules: their newer text ends it, an older task does not', () => {
  const key = 'c-924';
  const ask = k.smsIn(key, ago(6 * HOUR), 'Let us decide next week');
  const task = k.menuTask(key, ago(7 * HOUR), 'menu_changes', { proposalId: 924 });
  const snooze = k.act(key, 'snooze', ago(5 * HOUR), { until: plus(NOW, DAY) });
  const held = stateOf(run({ events: [ask, task], actions: [snooze] }), key);
  assert.deepEqual([held.status, held.tasksOnly], ['snoozed', false]);
  const again = k.smsIn(key, ago(1 * HOUR), 'Actually, one more thing');
  const woke = stateOf(run({ events: [ask, task, again], actions: [snooze] }), key);
  assert.deepEqual([woke.status, woke.snooze, woke.tasksOnly], ['waiting', null, false]);
  const fresh = k.menuTask(key, ago(1 * HOUR), 'menu_no_answer', { proposalId: 925 });
  assert.equal(stateOf(run({ events: [ask, task, fresh], actions: [snooze] }), key).status, 'waiting', 'a newer task ends it');
});

// A snooze made while their text waited covers the whole row, the task
// included: answering the text leaves the task alone on the row, still snoozed.
test('a snoozed row with a text and a task: a reply of ours answers the text, and the task stays snoozed', () => {
  const key = 'c-926';
  const ask = k.smsIn(key, ago(6 * HOUR), 'Let us decide next week');
  const task = k.menuTask(key, ago(7 * HOUR), 'menu_changes', { proposalId: 926 });
  const snooze = k.act(key, 'snooze', ago(5 * HOUR), { until: plus(NOW, DAY) });
  const reply = k.smsOut(key, ago(2 * HOUR), 'We will hold the date', { sender: DALLAS });
  const s = stateOf(run({ events: [ask, task, reply], actions: [snooze] }), key);
  assert.deepEqual([s.status, s.tasksOnly, s.internals.U], ['snoozed', true, []]);
});

test('the AI cover never closes a task: a no-reply read closes the text and the task still waits', () => {
  const key = 'c-913';
  const ask = k.smsIn(key, ago(5 * HOUR), 'Thanks!');
  const read = k.readRow('inbound', ask, { needs_reply: false, reason: 'a thank-you' });
  assert.equal(stateOf(run({ events: [ask], reads: [read] }), key).status, 'handled', 'the AI closes the text alone');
  const task = k.menuTask(key, ago(3 * HOUR), 'menu_changes');
  const s = stateOf(run({ events: [ask, task], reads: [read] }), key);
  assert.deepEqual([s.status, s.tasksOnly, s.need], ['waiting', true, CHANGES]);
});

test('the AI never reads a task: the subjects and slices are what they would be without it, and the client\'s note is in none', () => {
  const key = 'c-914';
  const ask = k.smsIn(key, ago(5 * HOUR), 'Can we start at six?');
  const task = k.menuTask(key, ago(3 * HOUR), 'menu_changes', { note: 'Swap the margarita for a mojito' });
  const withTask = run({ events: [ask, task] });
  assert.deepEqual(withTask.subjects, run({ events: [ask] }).subjects);
  assert.equal(withTask.subjects.length, 1, 'the text is still read');
  assert.equal(JSON.stringify(withTask.subjects).includes('mojito'), false);
  // A quiet conversation a task brings back gets no read of our old reply.
  const old = 'c-915';
  const oldAsk = k.smsIn(old, ago(10 * DAY), 'Is the 5th open?');
  const oldReply = k.smsOut(old, ago(9 * DAY), 'It is', { sender: DALLAS });
  const back = run({ events: [oldAsk, oldReply, k.menuTask(old, ago(HOUR), 'menu_no_answer')] });
  assert.equal(stateOf(back, old).status, 'waiting');
  assert.deepEqual(back.subjects, run({ events: [oldAsk, oldReply] }).subjects);
});

test('an event that happened closes the conversation, never a task', () => {
  const key = 'c-916';
  const ask = k.smsIn(key, ago(10 * DAY), 'See you on the 15th');
  const proposals = [
    k.proposalRow(key, { id: 9161, status: 'completed', eventDate: '2026-11-15' }),
    k.proposalRow(key, { id: 9162, status: 'deposit_paid', eventDate: null }),
  ];
  assert.equal(stateOf(run({ events: [ask], proposals }), key).closed.reasonCode, 'event');
  const task = k.menuTask(key, ago(2 * HOUR), 'menu_no_answer', { proposalId: 9162 });
  const s = stateOf(run({ events: [ask, task], proposals }), key);
  assert.deepEqual([s.status, s.tasksOnly, s.need, s.closed.reasonCode], ['waiting', true, NO_ANSWER, 'event']);
});

test('a task under a person the legal hold covers is never shown (the reader never emits one; the rules drop it too)', () => {
  const key = 'c-917';
  const proposals = [k.proposalRow(key, { legalHold: true, eventDate: '2026-12-01' })];
  const s = stateOf(run({ events: [k.menuTask(key, ago(HOUR))], proposals }), key);
  assert.deepEqual([s.status, s.tasksOnly, s.need, s.link], ['quiet', false, null, null]);
});

test('a row held only by tasks carries no channel tag, even with the text the AI covered still in U', () => {
  const key = 'c-918';
  const ask = k.smsIn(key, ago(5 * HOUR), 'Thanks!');
  const read = k.readRow('inbound', ask, { needs_reply: false, reason: 'a thank-you' });
  const s = stateOf(run({ events: [ask, k.menuTask(key, ago(3 * HOUR))], reads: [read] }), key);
  assert.deepEqual([s.status, s.tasksOnly, s.internals.U.length, s.channels], ['waiting', true, 1, []]);
});

// Lane menu-auto-start: the two run kinds, built by the reader's own mapper
// from auto-start rows (spec 2026-10-19 section 13.1), wait and close like the
// proof kinds: alone they hold the row with their line and link, a reply or a
// Done never clears them, a task opened during a snooze ends it, and a run
// the reader no longer emits (an approval, a manual Generate) holds nothing.
const { mapMenuTaskRows } = require('./readMenuTasks');

// An auto-start row as the query returns it, under client c-<id>.
function runRow(id, over = {}) {
  const runId = `aaaaaaaa-bbbb-4000-8000-${String(id).padStart(12, '0')}`;
  return {
    task_row: 'run', id, draft_id: id, proposal_id: id, client_id: id, event_date: '2026-12-05',
    run_id: runId, current_run_id: runId, attempted_at: ago(2 * HOUR), error_code: null, error_sentence: null,
    words_status: 'done', words_heartbeat_at: ago(2 * HOUR).toISOString(), words_error: null,
    words_finished_at: ago(90 * 60 * 1000).toISOString(), pieces_open: 0, open_oldest_beat: null, pieces_failed: 0,
    pieces_finished_at: ago(HOUR), has_proof: false, dead_start: false, db_now: NOW, ...over,
  };
}
const tasksFrom = (rows) => mapMenuTaskRows(rows, { now: NOW });
const READY = 'Menu ready to review';
const NOT_STARTED = "Menu couldn't be generated: The menu couldn't be started. Generate it from the event page.";

test('run kinds: a ready or failed auto run alone holds the client with its line and link; a reply and a Done never clear it', () => {
  const [ready] = tasksFrom([runRow(941)]);
  assert.equal(ready.kind, 'menu_ready');
  const s = stateOf(run({ events: [ready] }), 'c-941');
  assert.deepEqual([s.status, s.need, s.link, s.tasksOnly, s.waitingSince.toISOString()],
    ['waiting', READY, '/events/941?menu=1', true, ago(HOUR).toISOString()]);
  const [failed] = tasksFrom([runRow(942, { run_id: null, current_run_id: null, draft_id: null, dead_start: true })]);
  const f = stateOf(run({ events: [failed] }), 'c-942');
  assert.deepEqual([f.status, f.need, f.link, f.tasksOnly], ['waiting', NOT_STARTED, '/events/942?menu=1', true]);
  for (const task of [ready, failed]) {
    assert.equal(C.isCountedInbound(task), false);
    assert.equal(C.countsAsReply(task), false);
    const key = task.personKey;
    const ask = k.smsIn(key, ago(3 * HOUR), 'Can we add a mocktail?');
    const reply = k.smsOut(key, ago(30 * 60 * 1000), 'Yes, we can', { sender: DALLAS });
    const after = stateOf(run({ events: [ask, task, reply] }), key);
    assert.deepEqual([after.status, after.tasksOnly, after.need], ['waiting', true, task.text], `${task.kind}: the reply answered the text only`);
    const done = stateOf(run({ events: [task], actions: [k.act(key, 'done', ago(10 * 60 * 1000))] }), key);
    assert.deepEqual([done.status, done.tasksOnly], ['waiting', true], `${task.kind}: Done does not clear it`);
  }
});

test('run kinds: a ready task opened during a snooze ends it; one the reader stops emitting holds nothing', () => {
  const key = 'c-943';
  const snooze = k.act(key, 'snooze', ago(3 * HOUR), { until: plus(NOW, DAY) });
  const [ready] = tasksFrom([runRow(943)]);
  const woke = stateOf(run({ events: [ready], actions: [snooze] }), key);
  assert.deepEqual([woke.status, woke.snooze, woke.need], ['waiting', null, READY]);
  // Approved since (a proof), or Start over by hand (a later run): the reader emits nothing, so nothing waits.
  for (const over of [{ has_proof: true }, { current_run_id: '00000000-0000-4000-8000-000000009999' }]) {
    const none = tasksFrom([runRow(943, over)]);
    assert.deepEqual(none, []);
    const s = stateOf(run({ events: none }), key);
    assert.ok(!s || s.status !== 'waiting', 'nothing holds the client');
  }
});
