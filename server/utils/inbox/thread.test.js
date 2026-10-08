const { test } = require('node:test');
const assert = require('node:assert/strict');
const k = require('./rules.testkit');
const { normalizeEvents } = require('./normalize');
const { buildThread, outboundThreadRow } = require('./thread');

const { DALLAS, ZUL, NOW, HOUR, MIN, DAY, ago, plus, run } = k;

function threadOf({ key, events, actions = [], reads = [], viewerId = DALLAS, proposals = [] }) {
  const state = run({ events, actions, reads, viewerId, proposals }).people.get(key);
  const mine = normalizeEvents(events).filter((e) => e.personKey === key);
  return buildThread({ state, events: mine, actions: actions.filter((a) => a.person_key === key), reads, now: NOW, viewerId, users: k.USERS });
}

test('the thread is the last 30 days plus anything older still unanswered, oldest first', () => {
  const oldAsk = k.smsIn('c-601', ago(40 * DAY), 'An old question');
  const oldReply = k.smsOut('c-601', ago(39 * DAY), 'An old answer', { sender: ZUL });
  const recent = k.smsIn('c-601', ago(2 * DAY), 'A new question');
  assert.deepEqual(threadOf({ key: 'c-601', events: [oldAsk, oldReply, recent] }).map((r) => r.ref), [recent.ref]);
  const stale = k.smsIn('c-602', ago(40 * DAY), 'Still unanswered');
  const fresh = k.smsIn('c-602', ago(1 * DAY), 'Hello again?');
  assert.deepEqual(threadOf({ key: 'c-602', events: [stale, fresh] }).map((r) => r.ref), [stale.ref, fresh.ref]);
});

test('our side carries the author: You, a first name, or Auto; Thumbtack carries none', () => {
  const rows = threadOf({ key: 'c-603', events: [
    k.smsIn('c-603', ago(5 * HOUR), 'Hi'),
    k.smsOut('c-603', ago(4 * HOUR), 'Hello from Dallas', { sender: DALLAS }),
    k.smsOut('c-603', ago(3 * HOUR), 'Hello from Zul', { sender: ZUL }),
    k.smsOut('c-603', ago(2 * HOUR), 'Your balance is due', { sender: null }),
    k.ttOut('c-603', ago(1 * HOUR), 'A Thumbtack reply', { negotiationId: 'neg-603' }),
  ] });
  assert.deepEqual(rows.map((r) => [r.direction, r.author_name, r.auto]), [
    ['in', null, false], ['out', 'You', false], ['out', 'Zul', false], ['out', 'Auto', true], ['out', null, false],
  ]);
});

test('system lines: proposal sends, calls, an opt-out and the taps, in Chicago time', () => {
  const at = ago(6 * HOUR);
  const events = [
    k.smsIn('c-604', at, 'Can we talk?'),
    k.palSend('c-604', plus(at, 10 * MIN), { actor: ZUL, proposalId: 604 }),
    k.mlSend('c-604', plus(at, 11 * MIN), { messageType: 'proposal_sent', proposalId: 604, sentBy: ZUL }),
    k.palSend('c-604', plus(at, 2 * HOUR), { actor: ZUL, proposalId: 605 }),
    k.call('c-604', plus(at, 3 * HOUR), { durationSec: 185, answeredBy: DALLAS }),
    k.call('c-604', plus(at, 4 * HOUR), { source: 'cc', durationSec: 45, answeredBy: ZUL, clientNoAnswer: true }),
    k.optLine('c-604', plus(at, 5 * HOUR), 'stop'),
  ];
  const actions = [
    k.act('c-604', 'claim', '2026-11-20T17:02:00.000Z', { userId: ZUL }),
    k.act('c-604', 'snooze', '2026-11-20T17:03:00.000Z', { userId: ZUL, until: '2026-11-23T14:00:00.000Z' }),
    k.act('c-604', 'reopen', '2026-11-20T17:04:00.000Z', { userId: DALLAS }),
  ];
  const system = threadOf({ key: 'c-604', events, actions, viewerId: ZUL }).filter((r) => r.direction === 'system');
  assert.deepEqual(system.map((r) => [r.text, r.failed]), [
    ['You sent the proposal', false],
    ['You sent the proposal', true],
    ['Call, 3 min, Dallas', false],
    ['Call, client did not answer, you', false],
    ['Opted out of texts', false],
    ["You're on it, 11:02 AM", false],
    ['You snoozed it until Mon 8:00 AM', false],
    ['Reopened by Dallas', false],
  ]);
  assert.equal(system[1].failure_reason, 'No email or text went out');
});

test('an opting-out Cancel keeps its message and adds a line; a promise line follows each holding reply', () => {
  const cancel = k.smsIn('c-605', ago(5 * HOUR), 'Cancel', { optKeyword: 'stop' });
  const hold = k.smsOut('c-605', ago(4 * HOUR), 'I will check and get back to you', { sender: DALLAS });
  const reads = [k.readRow('outbound', hold, { holding: true, promised_by: 'Monday' })];
  assert.deepEqual(threadOf({ key: 'c-605', events: [cancel, hold], reads }).map((r) => [r.direction, r.text]), [
    ['in', 'Cancel'], ['system', 'Opted out of texts'],
    ['out', 'I will check and get back to you'], ['system', 'You said you would follow up Monday'],
  ]);
  assert.equal(threadOf({ key: 'c-605', events: [cancel, hold], reads, viewerId: ZUL }).pop().text, 'Dallas promised to follow up Monday');
  const sentAt = ago(3 * HOUR);
  const tt = [
    k.ttIn('c-606', plus(sentAt, -MIN), 'Quote please', { negotiationId: 'neg-606' }),
    k.ttOut('c-606', plus(sentAt, 20 * 1000), 'We are reviewing your request', { negotiationId: 'neg-606', firstReplySentAt: sentAt }),
  ];
  assert.equal(threadOf({ key: 'c-606', events: tt }).pop().text, 'Auto first reply: follow-up promised');
});

test('an AI close and an event close leave a "Was closed" line', () => {
  const thanks = k.smsIn('c-607', ago(5 * HOUR), 'Thank you!');
  const reads = [k.readRow('inbound', thanks, { needs_reply: false, reason: 'just a thank-you' })];
  assert.equal(threadOf({ key: 'c-607', events: [thanks], reads }).pop().text, 'Was closed: AI says just a thank-you');
  const ask = k.smsIn('c-608', '2026-11-10T16:00:00.000Z', 'One more question');
  const booked = k.proposalRow('c-608', { status: 'deposit_paid', eventDate: '2026-11-17' });
  assert.equal(threadOf({ key: 'c-608', events: [ask], proposals: [booked] }).pop().text, 'Was closed: event happened Nov 17');
});

test('an old message the AI or an event closed still shows with its "Was closed" line', () => {
  const thanks = k.smsIn('c-611', ago(40 * DAY), 'Thanks so much');
  const reads = [k.readRow('inbound', thanks, { needs_reply: false, reason: 'just a thank-you' })];
  const ask = k.smsIn('c-612', ago(40 * DAY), 'One more question');
  const booked = k.proposalRow('c-612', { status: 'deposit_paid', eventDate: '2026-10-16' });
  const lines = (rows) => rows.map((r) => [r.direction, r.text]);
  assert.deepEqual([
    lines(threadOf({ key: 'c-611', events: [thanks], reads })),
    lines(threadOf({ key: 'c-612', events: [ask], proposals: [booked] })),
  ], [
    [['in', 'Thanks so much'], ['system', 'Was closed: AI says just a thank-you']],
    [['in', 'One more question'], ['system', 'Was closed: event happened Oct 16']],
  ]);
});

test('failures, relay leads, photos and email subjects ride their rows; outboundThreadRow matches the shape', () => {
  const media = [{ url: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMx/Media/MEx', content_type: 'image/jpeg' }];
  const rows = threadOf({ key: 'c-609', events: [
    k.smsIn('c-609', ago(6 * HOUR), 'Look at this', { media }),
    k.smsIn('c-609', ago(5 * HOUR), 'Can we start at 5?', { relayLeadName: 'Pat Q.' }),
    k.smsOut('c-609', ago(4 * HOUR), 'Sure', { sender: ZUL, failed: true, failureReason: 'Twilio 30007' }),
    k.mlSend('c-609', ago(3 * HOUR), { messageType: 'shopping_list_ready', subject: 'Your shopping list', sentBy: ZUL }),
  ] });
  assert.deepEqual(rows[0].media, media);
  assert.equal(rows[1].relay_lead_name, 'Pat Q.');
  assert.deepEqual([rows[2].failed, rows[2].failure_reason], [true, 'Twilio 30007']);
  const unknown = threadOf({ key: 'c-610', events: [
    k.smsIn('c-610', ago(5 * HOUR), 'Hello?'),
    k.smsOut('c-610', ago(4 * HOUR), 'Hi', { sender: ZUL, failed: true }),
  ] });
  assert.deepEqual([unknown[1].failed, unknown[1].failure_reason], [true, null], 'an unknown reason is null, never invented');
  assert.deepEqual([rows[3].subject, rows[3].text, rows[3].channel], ['Your shopping list', null, 'email']);
  const row = outboundThreadRow(
    { id: 77, created_at: NOW, body: 'Sent from Inbox', status: 'sent', error_message: null, metadata: { line: '1922', send_id: 'x' } },
    { channel: 'text' }
  );
  assert.deepEqual(row, {
    ref: 'sms:77', direction: 'out', channel: 'text', line: '1922', at: NOW.toISOString(), text: 'Sent from Inbox',
    subject: null, author_name: 'You', auto: false, failed: false, failure_reason: null, media: [], relay_lead_name: null,
  });
});

test('outboundThreadRow: a failed row (an early failure folded in) carries the reader\'s reason, never the raw stored text', () => {
  const failed = (errorMessage) => outboundThreadRow(
    { id: 78, created_at: NOW, body: 'Sent from Inbox', status: 'failed', error_message: errorMessage, metadata: { line: '888' } },
    { channel: 'text' }
  );
  assert.deepEqual([failed('Twilio 30005 (undelivered)').failed, failed('Twilio 30005 (undelivered)').failure_reason],
    [true, 'Unknown or inactive number (Twilio 30005)']);
  assert.equal(failed('Twilio error (undelivered)').failure_reason, null, 'no code: the page writes its own "Not delivered"');
  assert.equal(failed(null).failure_reason, null);
});
