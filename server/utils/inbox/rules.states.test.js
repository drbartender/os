const { test } = require('node:test');
const assert = require('node:assert/strict');
const k = require('./rules.testkit');
const { normalizeEvents } = require('./normalize');
const { buildThread } = require('./thread');

const { DALLAS, ZUL, NOW, HOUR, MIN, DAY, ago, plus, run, stateOf } = k;

// The person's state and the text of every line in their opened thread.
function opened(key, input) {
  const state = stateOf(run(input), key);
  const events = normalizeEvents(input.events).filter((e) => e.personKey === key);
  const actions = (input.actions || []).filter((a) => a.person_key === key);
  const thread = buildThread({ state, events, actions, reads: input.reads || [], now: NOW, viewerId: DALLAS, users: k.USERS });
  return { s: state, lines: thread.map((r) => r.text) };
}
const aiCloseLine = (lines) => lines.some((t) => /^Was closed: AI/.test(String(t)));

test('twelve thank-yous: a no-reply read closes each one, with its reason, by the AI', () => {
  const events = [];
  const reads = [];
  for (let i = 0; i < 12; i += 1) {
    const e = k.smsIn(`c-3${String(i).padStart(2, '0')}`, ago((20 - i) * HOUR), 'Thank you so much!');
    events.push(e);
    reads.push(k.readRow('inbound', e, { needs_reply: false, reason: 'just a thank-you', summary: 'Saying thanks' }));
  }
  const r = run({ events, reads });
  assert.equal(r.waiting.length, 0);
  assert.equal(r.handled.length, 12);
  for (const s of r.handled) {
    assert.deepEqual([s.closed.reasonCode, s.closed.reasonText, s.closed.by], ['ai', 'AI: just a thank-you', 'AI']);
  }
});

test('the ruling sticks: "Can you do Oct 20?" then "Thanks!" stays waiting on the question', () => {
  const ask = k.smsIn('c-320', ago(6 * HOUR), 'Can you do Oct 20?');
  const thanks = k.smsIn('c-320', ago(5 * HOUR), 'Thanks!');
  const reads = [
    k.readRow('inbound', ask, { needs_reply: true, summary: 'Asking whether Oct 20 is open' }),
    k.readRow('inbound', thanks, { needs_reply: false, reason: 'just a thank-you' }),
  ];
  const s = stateOf(run({ events: [ask, thanks], reads }), 'c-320');
  assert.equal(s.status, 'waiting');
  assert.equal(s.need, 'Asking whether Oct 20 is open');
  assert.equal(s.waitingSince.getTime(), ask.at.getTime());
});

test('the ruling sticks in Recently handled too: the later reply closed it, never the AI', () => {
  const ask = k.smsIn('c-338', ago(6 * HOUR), 'Can you do the 12th?');
  const thanks = k.smsIn('c-338', ago(5 * HOUR), 'Thanks!');
  const reads = [
    k.readRow('inbound', ask, { needs_reply: true, summary: 'Asking whether the 12th is open' }),
    k.readRow('inbound', thanks, { needs_reply: false, reason: 'just a thank-you' }),
  ];
  assert.equal(stateOf(run({ events: [ask, thanks], reads }), 'c-338').status, 'waiting');
  const reply = k.smsOut('c-338', ago(2 * HOUR), 'Yes, the 12th is open', { sender: DALLAS });
  const s = stateOf(run({ events: [ask, thanks, reply], reads }), 'c-338');
  assert.deepEqual([s.status, s.closed.reasonCode, s.closed.reasonText, s.closed.by], ['handled', 'text', 'You texted back from 888', 'D']);
  assert.equal(s.closed.at.getTime(), reply.at.getTime());
});

test('promises: a question and a holding reply wait with the promise chip; "ok thanks" after it still waits', () => {
  const ask = k.smsIn('c-321', ago(7 * HOUR), 'Can you send the bar menu?');
  const hold = k.smsOut('c-321', ago(6 * HOUR), 'Let me check with the team and get back to you Monday', { sender: DALLAS });
  const ok = k.smsIn('c-321', ago(5 * HOUR), 'ok thanks');
  const reads = [
    k.readRow('outbound', hold, { holding: true, promised_by: 'Monday' }),
    k.readRow('inbound', ok, { needs_reply: false, reason: 'an acknowledgement' }),
  ];
  const s = stateOf(run({ events: [ask, hold, ok], reads }), 'c-321');
  assert.equal(s.status, 'waiting');
  assert.deepEqual([s.state.type, s.state.mine, s.state.promisedBy], ['promise', true, 'Monday']);
  const zulView = stateOf(run({ events: [ask, hold, ok], reads, viewerId: ZUL }), 'c-321');
  assert.deepEqual([zulView.state.mine, zulView.state.byName], [false, 'Dallas']);
});

test('promises: Done closes it, and so does a later real reply', () => {
  const ask = k.smsIn('c-322', ago(7 * HOUR), 'Can you check the parking?');
  const hold = k.smsOut('c-322', ago(6 * HOUR), 'I will check and get back to you', { sender: DALLAS });
  const reads = [k.readRow('outbound', hold, { holding: true })];
  const done = k.act('c-322', 'done', ago(3 * HOUR), { userId: ZUL });
  const viaDone = stateOf(run({ events: [ask, hold], reads, actions: [done] }), 'c-322');
  assert.deepEqual([viaDone.status, viaDone.closed.reasonText, viaDone.closed.by], ['handled', 'Zul marked it done', 'Z']);
  const answer = k.smsOut('c-322', ago(2 * HOUR), 'Parking is in the back lot', { sender: DALLAS });
  const viaReply = stateOf(run({ events: [ask, hold, answer], reads }), 'c-322');
  assert.deepEqual([viaReply.status, viaReply.closed.reasonText], ['handled', 'You texted back from 888']);
});

test('a promise with no open question waits from the promise time', () => {
  const ask = k.smsIn('c-323', ago(9 * HOUR), 'Do you bring ice?');
  const answer = k.smsOut('c-323', ago(8 * HOUR), 'Yes, ice is included', { sender: ZUL });
  const hold = k.smsOut('c-323', ago(7 * HOUR), 'I will also confirm the parking and get back to you', { sender: ZUL });
  const s = stateOf(run({ events: [ask, answer, hold], reads: [k.readRow('outbound', hold, { holding: true })] }), 'c-323');
  assert.deepEqual([s.status, s.state.type], ['waiting', 'promise']);
  assert.equal(s.waitingSince.getTime(), hold.at.getTime());
});

test('keywords: Cancel, yes, help and info count; plain STOP and START do not', () => {
  for (const [word, optKeyword] of [['Cancel', 'stop'], ['yes', 'start'], ['help', null], ['info', null]]) {
    const e = k.smsIn('c-324', ago(2 * HOUR), word, { optKeyword });
    assert.equal(stateOf(run({ events: [e] }), 'c-324').status, 'waiting', word);
  }
  for (const word of ['stop', 'start']) {
    assert.equal(stateOf(run({ events: [k.optLine('c-325', ago(2 * HOUR), word)] }), 'c-325').status, 'quiet', word);
  }
});

test('a picture-only text and an empty text wait, and a no-reply read never closes them', () => {
  const media = [{ url: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEtest', content_type: 'image/jpeg' }];
  const pic = k.smsIn('c-326', ago(3 * HOUR), '', { media });
  const empty = k.smsIn('c-327', ago(3 * HOUR), '   ');
  const reads = [k.readRow('inbound', pic, { needs_reply: false }), k.readRow('inbound', empty, { needs_reply: false })];
  const r = run({ events: [pic, empty], reads });
  assert.deepEqual([stateOf(r, 'c-326').status, stateOf(r, 'c-326').need], ['waiting', 'Sent a photo']);
  assert.deepEqual([stateOf(r, 'c-327').status, stateOf(r, 'c-327').need], ['waiting', 'Sent a message with no text']);
});

test('claims: active under 4 hours, lapsed at 4, ended by a reply or a release; Take over replaces the other claim', () => {
  const ask = k.smsIn('c-328', ago(10 * HOUR), 'Who should I talk to about the date?');
  const fresh = k.act('c-328', 'claim', plus(ago(4 * HOUR), 1000), { userId: ZUL });
  const s = stateOf(run({ events: [ask], actions: [fresh] }), 'c-328');
  assert.deepEqual([s.state.type, s.state.byName, s.state.mine, s.state.since.getTime()], ['claim', 'Zul', false, fresh.created_at.getTime()]);
  const lapsed = k.act('c-328', 'claim', ago(4 * HOUR), { userId: ZUL });
  assert.equal(stateOf(run({ events: [ask], actions: [lapsed] }), 'c-328').state.type, 'unseen');
  const takeover = k.act('c-328', 'claim', ago(1 * HOUR), { userId: DALLAS });
  const t = stateOf(run({ events: [ask], actions: [fresh, takeover] }), 'c-328');
  assert.deepEqual([t.state.type, t.state.mine], ['claim', true]);
  const release = k.act('c-328', 'release', ago(30 * MIN), { userId: DALLAS });
  assert.equal(stateOf(run({ events: [ask], actions: [takeover, release] }), 'c-328').state.type, 'unseen');
  const reply = k.smsOut('c-328', ago(2 * HOUR), 'Me, Dallas. What date works?', { sender: DALLAS });
  const again = k.smsIn('c-328', ago(1 * HOUR), 'The 14th');
  const ended = stateOf(run({ events: [ask, reply, again], actions: [k.act('c-328', 'claim', ago(3 * HOUR), { userId: ZUL })] }), 'c-328');
  assert.deepEqual([ended.status, ended.state.type], ['waiting', 'unseen']);
});

test('a holding reply ends a claim too: Zul is on it, then Dallas promises a follow-up', () => {
  const ask = k.smsIn('c-337', ago(6 * HOUR), 'Can you check the venue rules?');
  const claim = k.act('c-337', 'claim', ago(3 * HOUR), { userId: ZUL });
  const before = stateOf(run({ events: [ask], actions: [claim] }), 'c-337');
  assert.deepEqual([before.state.type, before.state.byName], ['claim', 'Zul']);
  const hold = k.smsOut('c-337', ago(2 * HOUR), 'Let me check with the venue and get back to you', { sender: DALLAS });
  const reads = [k.readRow('outbound', hold, { holding: true })];
  const s = stateOf(run({ events: [ask, hold], reads, actions: [claim] }), 'c-337');
  assert.deepEqual([s.status, s.state.type, s.state.byName, s.state.mine], ['waiting', 'promise', 'Dallas', true]);
});

test('channel tags: every channel in the waiting stretch, ordered by last use so the newest is last', () => {
  const text = k.smsIn('c-334', ago(5 * HOUR), 'Texting about the 12th');
  const tt = k.ttIn('c-334', ago(4 * HOUR), 'Also asking here', { negotiationId: 'neg-334' });
  const other = k.smsIn('c-334', ago(3 * HOUR), 'From my other line', { line: '1922' });
  const again = k.smsIn('c-334', ago(1 * HOUR), 'Any news?');
  assert.deepEqual(stateOf(run({ events: [text, tt] }), 'c-334').channels, ['text_888', 'thumbtack']);
  assert.deepEqual(stateOf(run({ events: [text, tt, again] }), 'c-334').channels, ['thumbtack', 'text_888']);
  assert.deepEqual(stateOf(run({ events: [text, tt, other, again] }), 'c-334').channels, ['thumbtack', 'text_1922', 'text_888']);
});

test('channel tags are only the channels they used: our holding reply from the 1922 never becomes one', () => {
  const ask = k.smsIn('c-336', ago(3 * HOUR), 'Can you send the menu and check the parking?', { line: '888' });
  const hold = k.smsOut('c-336', ago(2 * HOUR), 'I will check the parking and get back to you', { sender: DALLAS, line: '1922' });
  const reads = [k.readRow('outbound', hold, { holding: true })];
  const s = stateOf(run({ events: [ask, hold], reads }), 'c-336');
  assert.deepEqual([s.status, s.state.type, s.channels], ['waiting', 'promise', ['text_888']]);
  const answer = k.smsOut('c-336', ago(150 * MIN), 'Here is the menu', { sender: DALLAS });
  const promiseOnly = stateOf(run({ events: [ask, answer, hold], reads }), 'c-336');
  assert.deepEqual([promiseOnly.status, promiseOnly.state.type, promiseOnly.channels], ['waiting', 'promise', ['text_888']],
    'waiting only on our promise: still the channel they wrote on');
});

test('taps with no events never make a person: no phantom waiting row, nothing to count', () => {
  const reopen = k.act('c-335', 'reopen', ago(1 * HOUR), { userId: DALLAS });
  const r = run({ events: [], actions: [reopen] });
  assert.deepEqual([r.waiting.length, r.people.has('c-335')], [0, false]);
});

test('Done, then a new message, reopens with a fresh wait', () => {
  const first = k.smsIn('c-329', ago(30 * HOUR), 'Thanks again');
  const done = k.act('c-329', 'done', ago(29 * HOUR), { userId: ZUL });
  const next = k.smsIn('c-329', ago(2 * HOUR), 'One more question about parking');
  const s = stateOf(run({ events: [first, next], actions: [done] }), 'c-329');
  assert.equal(s.status, 'waiting');
  assert.equal(s.waitingSince.getTime(), next.at.getTime());
  assert.equal(s.hot, false);
});

test('Snooze hides the item; a new message brings it back early with the full wait; Wake ends it', () => {
  const ask = k.smsIn('c-330', ago(26 * HOUR), 'Can you hold the 9th for us?');
  const snooze = k.act('c-330', 'snooze', ago(25 * HOUR), { until: plus(NOW, 2 * DAY), userId: ZUL });
  const snoozed = stateOf(run({ events: [ask], actions: [snooze] }), 'c-330');
  assert.deepEqual([snoozed.status, snoozed.snooze.byName, snoozed.snooze.mine], ['snoozed', 'Zul', false]);
  const again = k.smsIn('c-330', ago(1 * HOUR), 'Just checking in');
  const back = stateOf(run({ events: [ask, again], actions: [snooze] }), 'c-330');
  assert.equal(back.status, 'waiting');
  assert.equal(back.waitingSince.getTime(), ask.at.getTime(), 'the full wait, from the first message');
  assert.equal(back.hot, true);
  const wake = k.act('c-330', 'wake', ago(10 * HOUR), { userId: DALLAS });
  assert.equal(stateOf(run({ events: [ask], actions: [snooze, wake] }), 'c-330').status, 'waiting');
});

test('an undone action is ignored', () => {
  const ask = k.smsIn('c-331', ago(3 * HOUR), 'Is the deposit refundable?');
  const done = k.act('c-331', 'done', ago(2 * HOUR), { undone: true });
  assert.equal(stateOf(run({ events: [ask], actions: [done] }), 'c-331').status, 'waiting');
});

test('Reopen puts a closed item back in Waiting, from the Reopen time, with the Reopened chip', () => {
  const ask = k.smsIn('c-332', ago(9 * HOUR), 'What is included?');
  const reply = k.smsOut('c-332', ago(8 * HOUR), 'Everything on the menu card', { sender: ZUL });
  const reopen = k.act('c-332', 'reopen', ago(1 * HOUR), { userId: DALLAS });
  const s = stateOf(run({ events: [ask, reply], actions: [reopen] }), 'c-332');
  assert.equal(s.status, 'waiting');
  assert.equal(s.waitingSince.getTime(), reopen.created_at.getTime());
  assert.deepEqual([s.state.type, s.state.mine, s.need], ['reopened', true, 'What is included?']);
});

test('seen: "Not read yet" until someone opens the item after the newest message', () => {
  const ask = k.smsIn('c-333', ago(3 * HOUR), 'Hello');
  assert.deepEqual(stateOf(run({ events: [ask] }), 'c-333').state,
    { type: 'unseen', byUserId: null, byName: null, mine: false, promisedBy: null, since: null });
  assert.equal(stateOf(run({ events: [ask], seen: [k.seenRow('c-333', ago(2 * HOUR), ZUL)] }), 'c-333').state, null);
  assert.equal(stateOf(run({ events: [ask], seen: [k.seenRow('c-333', ago(4 * HOUR), ZUL)] }), 'c-333').state.type, 'unseen');
});

// Merge review: a promise or a Reopen that held the stretch open when the AI's
// no-reply read landed means the AI closed nothing; the person who answered did.
test('the closer, Q1: question, our promise, "ok thanks", then Dallas answers: Dallas closed it, not the AI', () => {
  const ask = k.smsIn('c-340', ago(7 * HOUR), 'Can you send the bar menu?');
  const hold = k.smsOut('c-340', ago(6 * HOUR), 'Let me check with the team and get back to you Monday', { sender: DALLAS });
  const ok = k.smsIn('c-340', ago(5 * HOUR), 'ok thanks');
  const answer = k.smsOut('c-340', ago(2 * HOUR), 'Here is the menu', { sender: DALLAS });
  const reads = [
    k.readRow('outbound', hold, { holding: true, promised_by: 'Monday' }),
    k.readRow('inbound', ok, { needs_reply: false, reason: 'an acknowledgement' }),
  ];
  const { s, lines } = opened('c-340', { events: [ask, hold, ok, answer], reads });
  assert.deepEqual([s.status, s.closed.reasonCode, s.closed.reasonText, s.closed.by], ['handled', 'text', 'You texted back from 888', 'D']);
  assert.equal(s.closed.at.getTime(), answer.at.getTime());
  assert.equal(aiCloseLine(lines), false, 'no "Was closed: AI" line');
});

test('the closer, Q2: a request, the auto first reply, "Thanks!", then Zul sends the proposal: "Proposal sent by Zul"', () => {
  const sentAt = ago(10 * HOUR);
  const ask = k.ttIn('c-341', ago(10 * HOUR + 2 * MIN), 'Quote for 60 guests in June?', { negotiationId: 'neg-341' });
  const auto = k.ttOut('c-341', plus(sentAt, 20 * 1000), 'Hi there, we are reviewing your request', { negotiationId: 'neg-341', firstReplySentAt: sentAt });
  const thanks = k.ttIn('c-341', ago(9 * HOUR), 'Thanks!', { negotiationId: 'neg-341' });
  const pal = k.palSend('c-341', ago(8 * HOUR), { actor: ZUL, proposalId: 341 });
  const email = k.mlSend('c-341', plus(ago(8 * HOUR), 40 * 1000), { messageType: 'proposal_sent', proposalId: 341, sentBy: ZUL });
  const reads = [k.readRow('inbound', thanks, { needs_reply: false, reason: 'just a thank-you' })];
  const { s, lines } = opened('c-341', { events: [ask, auto, thanks, pal, email], reads });
  assert.deepEqual([s.status, s.closed.reasonCode, s.closed.reasonText, s.closed.by], ['handled', 'proposal', 'Proposal sent by Zul', 'Z']);
  assert.equal(s.closed.at.getTime(), pal.at.getTime());
  assert.equal(aiCloseLine(lines), false, 'no "Was closed: AI" line');
});

test('the closer, R1: an AI-closed item is reopened, they write "thanks" while it is open, then Dallas replies: Dallas closed it', () => {
  const first = k.smsIn('c-342', ago(30 * HOUR), 'Thanks for everything!');
  const reopen = k.act('c-342', 'reopen', ago(20 * HOUR), { userId: DALLAS });
  const thanks = k.smsIn('c-342', ago(10 * HOUR), 'thanks');
  const reply = k.smsOut('c-342', ago(5 * HOUR), 'Happy to help, see you soon', { sender: DALLAS });
  const reads = [
    k.readRow('inbound', first, { needs_reply: false, reason: 'just a thank-you' }),
    k.readRow('inbound', thanks, { needs_reply: false, reason: 'just a thank-you' }),
  ];
  const { s, lines } = opened('c-342', { events: [first, thanks, reply], reads, actions: [reopen] });
  assert.deepEqual([s.status, s.closed.reasonCode, s.closed.reasonText, s.closed.by], ['handled', 'text', 'You texted back from 888', 'D']);
  assert.equal(s.closed.at.getTime(), reply.at.getTime());
  assert.equal(aiCloseLine(lines), false, 'no "Was closed: AI" line');
});

test('a kept promise keeps the need line and the channel they wrote on', () => {
  const ask = k.smsIn('c-343', ago(9 * HOUR), 'Do you bring ice?', { line: '1922' });
  const answer = k.smsOut('c-343', ago(8 * HOUR), 'Yes, ice is included', { sender: ZUL });
  const hold = k.smsOut('c-343', ago(7 * HOUR), 'I will also confirm the parking and get back to you', { sender: ZUL });
  const kept = k.smsOut('c-343', ago(2 * HOUR), 'Parking is in the back lot', { sender: ZUL });
  const s = stateOf(run({ events: [ask, answer, hold, kept], reads: [k.readRow('outbound', hold, { holding: true })] }), 'c-343');
  assert.deepEqual([s.status, s.closed.reasonText, s.closed.at.getTime()], ['handled', 'Zul texted back from 888', kept.at.getTime()]);
  assert.deepEqual([s.need, s.closed.need, s.closed.channel], ['Do you bring ice?', 'Do you bring ice?', 'text_1922']);
});

test('a reopened item marked Done keeps the need line and the channel they wrote on', () => {
  const ask = k.smsIn('c-344', ago(9 * HOUR), 'What is included?');
  const reply = k.smsOut('c-344', ago(8 * HOUR), 'Everything on the menu card', { sender: ZUL });
  const reopen = k.act('c-344', 'reopen', ago(3 * HOUR), { userId: DALLAS });
  const done = k.act('c-344', 'done', ago(1 * HOUR), { userId: ZUL });
  const s = stateOf(run({ events: [ask, reply], actions: [reopen, done] }), 'c-344');
  assert.deepEqual([s.status, s.closed.reasonText, s.closed.at.getTime()], ['handled', 'Zul marked it done', done.created_at.getTime()]);
  assert.deepEqual([s.need, s.closed.need, s.closed.channel], ['What is included?', 'What is included?', 'text_888']);
});

test('a snooze is bounded by the anchor, as a claim is: our real reply ends it, so a later promise waits', () => {
  const ask = k.smsIn('c-345', ago(10 * HOUR), 'Can you hold the 9th for us?');
  const snooze = k.act('c-345', 'snooze', ago(9 * HOUR), { until: plus(NOW, 2 * DAY), userId: ZUL });
  const answer = k.smsOut('c-345', ago(8 * HOUR), 'Yes, the 9th is held', { sender: DALLAS });
  const hold = k.smsOut('c-345', ago(7 * HOUR), 'I will send the contract and get back to you', { sender: DALLAS });
  const s = stateOf(run({ events: [ask, answer, hold], reads: [k.readRow('outbound', hold, { holding: true })], actions: [snooze] }), 'c-345');
  assert.deepEqual([s.status, s.snooze, s.state.type, s.waitingSince.getTime()], ['waiting', null, 'promise', hold.at.getTime()]);
});

test('ties resolve toward waiting: a message at the same instant as our reply or a Done is unanswered', () => {
  const at = ago(3 * HOUR);
  const ask = k.smsIn('c-346', at, 'Are you open Friday?');
  const reply = k.smsOut('c-346', at, 'Hi, Dallas here', { sender: DALLAS });
  const r = stateOf(run({ events: [ask, reply] }), 'c-346');
  assert.equal(r.status, 'waiting');
  assert.equal(r.waitingSince.getTime(), at.getTime());
  const done = k.act('c-346', 'done', at, { userId: ZUL });
  assert.equal(stateOf(run({ events: [ask], actions: [done] }), 'c-346').status, 'waiting');
});

test('a snooze whose until is exactly now has ended: waiting', () => {
  const ask = k.smsIn('c-347', ago(3 * HOUR), 'Any news on the date?');
  const snooze = k.act('c-347', 'snooze', ago(2 * HOUR), { until: NOW, userId: ZUL });
  const s = stateOf(run({ events: [ask], actions: [snooze] }), 'c-347');
  assert.deepEqual([s.status, s.snooze], ['waiting', null]);
});
