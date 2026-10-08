const { test } = require('node:test');
const assert = require('node:assert/strict');
const k = require('./rules.testkit');
const { normalizeEvents } = require('./normalize');
const { INBOX_HISTORY_START, TT_MISSED_TEXT } = require('./constants');

const { DALLAS, ZUL, HOUR, MIN, DAY, ago, plus, run, stateOf } = k;

// The testkit clock is Fri Nov 20 2026, noon Chicago (CST, UTC-6).

test('event happened: closes a booked event once it has passed', () => {
  const ask = k.smsIn('c-401', '2026-11-10T16:00:00.000Z', 'Can we add a mocktail?');
  const booked = k.proposalRow('c-401', { status: 'deposit_paid', eventDate: '2026-11-17' });
  const s = stateOf(run({ events: [ask], proposals: [booked] }), 'c-401');
  assert.deepEqual([s.status, s.closed.reasonText, s.closed.by], ['handled', 'Event happened Nov 17', 'AI']);
  assert.equal(s.closed.at.toISOString(), '2026-11-17T06:00:00.000Z', 'midnight Chicago on the event date');
});

test('event happened: the comparison is the Chicago date of the newest message, strictly before', () => {
  const lateEve = k.smsIn('c-402', '2026-11-17T05:30:00.000Z', 'See you tomorrow!'); // Nov 16, 11:30 PM Chicago
  const bookedA = k.proposalRow('c-402', { status: 'balance_paid', eventDate: '2026-11-17' });
  assert.equal(stateOf(run({ events: [lateEve], proposals: [bookedA] }), 'c-402').status, 'handled');
  const sameDay = k.smsIn('c-403', '2026-11-17T06:30:00.000Z', 'Running late, start at 7?'); // Nov 17, 12:30 AM Chicago
  const bookedB = k.proposalRow('c-403', { status: 'confirmed', eventDate: '2026-11-17' });
  assert.equal(stateOf(run({ events: [sameDay], proposals: [bookedB] }), 'c-403').status, 'waiting');
});

test('event happened: never for an unbooked quote or a cancelled booking', () => {
  for (const status of ['sent', 'viewed', 'accepted', 'archived']) {
    const ask = k.smsIn('c-404', '2026-11-10T16:00:00.000Z', 'Still thinking it over');
    const p = k.proposalRow('c-404', { status, eventDate: '2026-11-17' });
    assert.equal(stateOf(run({ events: [ask], proposals: [p] }), 'c-404').status, 'waiting', status);
  }
});

test('event happened: an upcoming second event blocks it', () => {
  const ask = k.smsIn('c-405', '2026-11-10T16:00:00.000Z', 'Can we book you again?');
  const past = k.proposalRow('c-405', { status: 'completed', eventDate: '2026-11-17' });
  const next = k.proposalRow('c-405', { status: 'sent', eventDate: '2026-12-05' });
  assert.equal(stateOf(run({ events: [ask], proposals: [past, next] }), 'c-405').status, 'waiting');
});

test('event happened: a Reopen on or after the event date overrides it', () => {
  const ask = k.smsIn('c-406', '2026-11-10T16:00:00.000Z', 'Quick question about glassware');
  const booked = k.proposalRow('c-406', { status: 'deposit_paid', eventDate: '2026-11-17' });
  const reopen = k.act('c-406', 'reopen', '2026-11-19T15:00:00.000Z');
  const s = stateOf(run({ events: [ask], proposals: [booked], actions: [reopen] }), 'c-406');
  assert.deepEqual([s.status, s.state.type], ['waiting', 'reopened']);
});

// They asked before the event and got a real answer; then one holding reply of
// ours at holdAt, which its outbound read calls holding.
function promiseAroundTheEvent(holdAt) {
  const ask = k.smsIn('c-415', '2026-11-10T16:00:00.000Z', 'Can you send an itemized receipt after the party?');
  const answer = k.smsOut('c-415', '2026-11-10T17:00:00.000Z', 'Yes, we can do that', { sender: DALLAS });
  const hold = k.smsOut('c-415', holdAt, 'Let me pull the final bar tab and get back to you', { sender: DALLAS });
  const booked = k.proposalRow('c-415', { status: 'deposit_paid', eventDate: '2026-11-17' });
  const reads = [k.readRow('outbound', hold, { holding: true })];
  return { hold, s: stateOf(run({ events: [ask, answer, hold], reads, proposals: [booked] }), 'c-415') };
}

test('event happened: our holding reply on or after the event date overrides it, waiting since the promise', () => {
  // Nov 17, 12:30 AM Chicago (the event date itself), then Nov 18, 9:00 AM Chicago
  for (const holdAt of ['2026-11-17T06:30:00.000Z', '2026-11-18T15:00:00.000Z']) {
    const { hold, s } = promiseAroundTheEvent(holdAt);
    assert.equal(s.status, 'waiting', holdAt);
    assert.deepEqual([s.state.type, s.closed, s.waitingSince.getTime()], ['promise', null, hold.at.getTime()], holdAt);
  }
});

test('event happened: our holding reply before the event date still closes with the event', () => {
  const { s } = promiseAroundTheEvent('2026-11-17T05:30:00.000Z'); // Nov 16, 11:30 PM Chicago
  assert.deepEqual([s.status, s.closed.reasonCode, s.closed.reasonText, s.closed.by], ['handled', 'event', 'Event happened Nov 17', 'AI']);
});

test('history floor: an unanswered message after the floor waits however old; one before never opens', () => {
  const floorMs = new Date(INBOX_HISTORY_START).getTime();
  const old = k.smsIn('c-407', ago(45 * DAY), 'Are you still available?');
  assert.ok(old.at.getTime() > floorMs, 'the fixture sits after the floor');
  const s = stateOf(run({ events: [old] }), 'c-407');
  assert.deepEqual([s.status, s.hot], ['waiting', true]);
  const before = k.smsIn('c-408', new Date(floorMs - 1000), 'Hello from before the floor');
  assert.equal(run({ events: [before] }).people.has('c-408'), false);
});

test('boundaries: red at 24 hours, Recently handled for 7 days', () => {
  assert.equal(stateOf(run({ events: [k.smsIn('c-409', ago(24 * HOUR), 'Hi')] }), 'c-409').hot, true);
  assert.equal(stateOf(run({ events: [k.smsIn('c-410', plus(ago(24 * HOUR), MIN), 'Hi')] }), 'c-410').hot, false);
  const ask = k.smsIn('c-411', ago(8 * DAY), 'A question');
  const inside = k.smsOut('c-411', plus(ago(7 * DAY), MIN), 'An answer');
  assert.equal(stateOf(run({ events: [ask, inside] }), 'c-411').status, 'handled');
  const atEdge = k.smsOut('c-411', ago(7 * DAY), 'An answer', { id: 94111 });
  assert.equal(stateOf(run({ events: [ask, atEdge] }), 'c-411').status, 'quiet');
});

test('legal hold: flagged, and an AI read can neither close it nor turn a reply into a promise', () => {
  const ask = k.smsIn('c-412', ago(5 * HOUR), 'Thanks for everything');
  const hold = k.proposalRow('c-412', { status: 'confirmed', eventDate: '2026-12-12', legalHold: true });
  const s = stateOf(run({ events: [ask], reads: [k.readRow('inbound', ask, { needs_reply: false })], proposals: [hold] }), 'c-412');
  assert.deepEqual([s.legalHold, s.status], [true, 'waiting']);
  const reply = k.smsOut('c-412', ago(4 * HOUR), 'Let me check and get back to you', { sender: DALLAS });
  const out = [k.readRow('outbound', reply, { holding: true })];
  assert.equal(stateOf(run({ events: [ask, reply], reads: out, proposals: [hold] }), 'c-412').status, 'handled');
});

test('the never-received Thumbtack item waits, and the AI cannot close it', () => {
  const notice = k.relayNotice('c-413', ago(2 * HOUR), { negotiationId: 'neg-413' });
  const s = stateOf(run({ events: [notice], reads: [k.readRow('inbound', notice, { needs_reply: false })] }), 'c-413');
  assert.deepEqual([s.status, s.need], ['waiting', TT_MISSED_TEXT]);
  assert.deepEqual(s.channels, ['thumbtack']);
});

test('a quoted relay notice waits on its words, is offered to the AI, and its no-reply read closes it (Task 18 F1)', () => {
  const notice = k.relayNotice('c-416', ago(3 * HOUR), { negotiationId: 'neg-416', quoted: true });
  const open = run({ events: [notice] });
  const w = stateOf(open, 'c-416');
  assert.deepEqual([w.status, w.need, w.channels], ['waiting', 'Got it, we will review and get back to you.', ['thumbtack']]);
  assert.deepEqual(open.subjects.map((s) => [s.kind, s.subjectRef]), [['inbound', notice.ref]]);
  const [item] = normalizeEvents([notice]);
  const reads = [k.readRow('inbound', item, { needs_reply: false, reason: 'an acknowledgement' })];
  const s = stateOf(run({ events: [notice], reads }), 'c-416');
  assert.deepEqual([s.status, s.closed.reasonCode, s.closed.by, s.closed.channel], ['handled', 'ai', 'AI', 'thumbtack']);
});

test('an unquoted relay notice with no Customer row stays tt_missed (the old rule kept)', () => {
  const [item] = normalizeEvents([k.relayNotice('c-417', ago(3 * HOUR), { negotiationId: 'neg-417' })]);
  assert.deepEqual([item.kind, item.text], ['tt_missed', TT_MISSED_TEXT]);
});

test('a closed stretch reports what they needed and the channel they wrote on', () => {
  const ask = k.ttIn('c-414', ago(9 * HOUR), 'Looking for a bartender', { negotiationId: 'neg-414' });
  const pal = k.palSend('c-414', ago(8 * HOUR), { actor: ZUL, proposalId: 414 });
  const email = k.mlSend('c-414', plus(ago(8 * HOUR), MIN), { messageType: 'proposal_sent', proposalId: 414, sentBy: ZUL });
  const s = stateOf(run({ events: [ask, pal, email], viewerId: ZUL }), 'c-414');
  assert.deepEqual([s.closed.need, s.closed.channel, s.closed.reasonText], ['Looking for a bartender', 'thumbtack', 'You sent the proposal']);
});

test('history floor: a message exactly at the floor is inside it', () => {
  const atFloor = k.smsIn('c-418', new Date(INBOX_HISTORY_START), 'Right at the floor');
  const s = stateOf(run({ events: [atFloor] }), 'c-418');
  assert.deepEqual([s.status, s.waitingSince.toISOString()], ['waiting', INBOX_HISTORY_START]);
});

test('event happened: an upcoming archived proposal does not block it', () => {
  const ask = k.smsIn('c-419', '2026-11-10T16:00:00.000Z', 'Quick question about the bar setup');
  const booked = k.proposalRow('c-419', { status: 'deposit_paid', eventDate: '2026-11-17' });
  const archived = k.proposalRow('c-419', { status: 'archived', eventDate: '2026-12-05' });
  const s = stateOf(run({ events: [ask], proposals: [booked, archived] }), 'c-419');
  assert.deepEqual([s.status, s.closed.reasonCode, s.closed.reasonText], ['handled', 'event', 'Event happened Nov 17']);
});
