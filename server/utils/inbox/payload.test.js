const { test } = require('node:test');
const assert = require('node:assert/strict');
const k = require('./rules.testkit');
const { normalizeEvents } = require('./normalize');
const { listPayload, itemPayload, stateJson } = require('./payload');
const F = require('./contextFormat');

const { DALLAS, ZUL, NOW, HOUR, MIN, DAY, ago, plus, run } = k;
const directory = { nameOf: (key) => `Name of ${key}`, kindOf: (key) => (key.startsWith('s-') ? 'staff' : 'lead') };

test('list payload: snake_case rows, a state object on every waiting row, ISO times', () => {
  const ask = k.smsIn('c-701', ago(25 * HOUR), 'Is Friday open?', { line: '1922' });
  const snoozeAsk = k.smsIn('c-702', ago(3 * HOUR), 'Later is fine');
  const snooze = k.act('c-702', 'snooze', ago(2 * HOUR), { until: plus(NOW, 3 * HOUR), userId: ZUL });
  const thanks = k.smsIn('c-703', ago(5 * HOUR), 'Thanks!');
  const reply = k.smsOut('c-703', ago(4 * HOUR), 'You are welcome', { sender: DALLAS, line: '1922' });
  const result = run({ events: [ask, snoozeAsk, thanks, reply], actions: [snooze] });
  const feeds = [{ source: '888', last_at: null, quiet: true }];
  const body = listPayload({ result, directory, feeds, aiStatus: 'off', generatedAt: NOW });
  assert.equal(body.generated_at, NOW.toISOString());
  assert.deepEqual(body.ai, { status: 'off' });
  assert.deepEqual(body.waiting, [{
    person_key: 'c-701', name: 'Name of c-701', kind: 'lead', need: 'Is Friday open?', waiting_since: ask.at.toISOString(),
    hot: true, channels: ['text_1922'], state: { type: 'unseen', by_user_id: null, by_name: null, mine: false, promised_by: null, since: null },
  }]);
  assert.deepEqual(body.snoozed, [{ person_key: 'c-702', name: 'Name of c-702', until: plus(NOW, 3 * HOUR).toISOString(), by_name: 'Zul', mine: false }]);
  assert.deepEqual(body.handled, [{
    person_key: 'c-703', name: 'Name of c-703', need: 'Thanks!', channel: 'text_888', closed_at: reply.at.toISOString(),
    reason_code: 'text', reason_text: 'You texted back from 1922', by: 'D',
  }]);
  assert.deepEqual(body.feeds, feeds);
});

test('the Recently handled reason table (spec 4.5), as the viewer reads it', () => {
  const ask = (key) => k.smsIn(key, ago(10 * HOUR), 'A question');
  const cases = [
    ['c-711', [k.smsOut('c-711', ago(9 * HOUR), 'Answer', { sender: ZUL })], [], 'Zul texted back from 888', 'Z'],
    ['c-712', [k.mlSend('c-712', ago(9 * HOUR), { messageType: 'shopping_list_ready', sentBy: DALLAS })], [], 'You sent the shopping list', 'D'],
    ['c-713', [k.palSend('c-713', ago(9 * HOUR), { actor: ZUL, proposalId: 713 }),
      k.mlSend('c-713', plus(ago(9 * HOUR), MIN), { messageType: 'proposal_sent', proposalId: 713, sentBy: ZUL })], [], 'Proposal sent by Zul', 'Z'],
    ['c-714', [k.ttOut('c-714', ago(9 * HOUR), 'A Thumbtack answer', { negotiationId: 'neg-714' })], [], 'Replied in Thumbtack', null],
    ['c-715', [k.call('c-715', ago(9 * HOUR), { durationSec: 180 })], [], 'You called (3 min)', 'D'],
    ['c-716', [], [k.act('c-716', 'done', ago(9 * HOUR), { userId: ZUL })], 'Zul marked it done', 'Z'],
  ];
  for (const [key, extra, actions, text, by] of cases) {
    const s = run({ events: [ask(key), ...extra], actions }).people.get(key);
    assert.deepEqual([s.closed.reasonText, s.closed.by], [text, by], key);
  }
});

test('chooseProposal: the soonest upcoming that is not archived, else the most recent', () => {
  const p = (id, status, eventDate, createdAt) => ({ id, status, event_date: eventDate, created_at: new Date(createdAt) });
  const today = '2026-11-20';
  assert.equal(F.chooseProposal([p(1, 'sent', '2026-12-20', '2026-10-01'), p(2, 'deposit_paid', '2026-12-05', '2026-09-01'),
    p(3, 'archived', '2026-11-25', '2026-11-01')], today).id, 2);
  assert.equal(F.chooseProposal([p(4, 'completed', '2026-06-01', '2026-03-01'), p(5, 'archived', '2026-05-01', '2026-04-01')], today).id, 5);
  assert.equal(F.chooseProposal([], today), null);
});

test('client context: Booked or Lead, the event, the proposal chip, and money with the balance', () => {
  const booked = {
    id: 31, status: 'deposit_paid', event_date: '2026-11-28', event_start_time: '18:00', event_type: 'wedding-reception',
    event_type_custom: null, guest_count: 120, venue_name: 'The Barn', venue_city: 'Naperville', event_location: null,
    total_price: '2450.50', amount_paid: '100.00', balance_due_date: '2026-11-14', client_signed_at: new Date('2026-09-02'),
    created_at: new Date('2026-09-01'),
  };
  assert.deepEqual(F.clientContext({ clientId: 9, proposals: [booked], todayYmd: '2026-11-20' }), {
    kind: 'client', status_chip: 'Booked', event_type_label: 'Wedding Reception', guests: 120,
    when_text: 'Sat, Nov 28 · 6:00 PM', where_text: 'The Barn, Naperville',
    proposal: { id: 31, status_label: 'Deposit paid', chip: 'Signed' },
    money: { total: 2450.5, paid: 100, balance: 2350.5, due_date: '2026-11-14' },
    links: { client_id: 9, proposal_id: 31, event_id: 31 },
  });
  const none = F.clientContext({ clientId: 9, proposals: [], todayYmd: '2026-11-20' });
  assert.deepEqual([none.kind, none.status_chip, none.proposal, none.money, none.links], [
    'lead', 'Lead', { id: null, status_label: 'Not sent yet', chip: 'None' }, null, { client_id: 9, proposal_id: null, event_id: null },
  ]);
});

test('when, phone, staff, Thumbtack and unknown shapes', () => {
  assert.equal(F.formatWhen('2027-01-09', '6:30 pm', '2026-11-20'), 'Sat, Jan 9, 2027 · 6:30 PM');
  assert.equal(F.formatWhen('2026-12-05', null, '2026-11-20'), 'Sat, Dec 5');
  assert.equal(F.phoneDisplay('+13125550100'), '(312) 555-0100');
  assert.equal(F.phoneDisplay('+447700900123'), '+447700900123');
  assert.equal(F.phoneDisplay(null), null);
  const shift = { id: 44, event_date: '2026-11-28', start_time: '17:00', location: 'The Barn', event_type: 'wedding-reception', event_type_custom: null, open_slots: 1, total: 4 };
  assert.deepEqual(F.staffContext({ userId: 7, role: 'Bartender', shift, todayYmd: '2026-11-20' }), {
    kind: 'staff', role: 'Bartender',
    shift: { id: 44, when_text: 'Sat, Nov 28 · 5:00 PM', event_text: 'Wedding Reception · The Barn', roster: { filled: 3, total: 4 } },
    links: { user_id: 7, shift_id: 44 },
  });
  assert.equal(F.staffContext({ userId: 7, role: 'Staff', shift: null, todayYmd: '2026-11-20' }).shift, null);
  const lead = { customer_name: 'Pat Q.', event_date: new Date('2026-12-12T18:00:00Z'), location_city: 'Evanston', location_state: 'IL' };
  assert.deepEqual(F.ttLeadContext(lead, '987'), {
    kind: 'tt_lead', name: 'Pat Q.', event_date: '2026-12-12T18:00:00.000Z', location: 'Evanston, IL', negotiation_id: '987',
  });
  assert.deepEqual(F.unknownContext('+13125550100'), { kind: 'unknown', phone_display: '(312) 555-0100' });
});

function itemOf(key, events, actions = []) {
  const state = run({ events, actions }).people.get(key);
  return itemPayload({
    personKey: key, state, events: normalizeEvents(events), actions, reads: [], now: NOW, viewerId: DALLAS,
    users: k.USERS, directory, context: { kind: 'lead' }, legalHold: key === 'c-721', reply: { mode: 'text' },
  });
}

test('item payload: the contract keys plus status, snooze and closed, and the legal-hold flag', () => {
  const ask = k.smsIn('c-721', ago(3 * HOUR), 'Is the 5th open?');
  const body = itemOf('c-721', [ask]);
  assert.deepEqual(Object.keys(body), ['person', 'status', 'waiting', 'waiting_since', 'need', 'state', 'snooze', 'closed', 'legal_hold', 'context', 'thread', 'reply']);
  assert.deepEqual(body.person, { person_key: 'c-721', name: 'Name of c-721', kind: 'lead' });
  assert.deepEqual([body.status, body.waiting, body.waiting_since, body.need, body.state.type, body.snooze, body.closed, body.legal_hold],
    ['waiting', true, ask.at.toISOString(), 'Is the 5th open?', 'unseen', null, null, true]);
  assert.equal(body.thread.length, 1);
  assert.deepEqual(stateJson(null), { type: null, by_user_id: null, by_name: null, mine: false, promised_by: null, since: null });
});

test('item payload: a claim carries since; a handled item carries closed; a quiet one carries neither', () => {
  const ask = k.smsIn('c-722', ago(3 * HOUR), 'Can we add a second bar?');
  const claim = k.act('c-722', 'claim', ago(2 * HOUR), { userId: ZUL });
  assert.deepEqual(itemOf('c-722', [ask], [claim]).state,
    { type: 'claim', by_user_id: ZUL, by_name: 'Zul', mine: false, promised_by: null, since: claim.created_at.toISOString() });
  const reply = k.smsOut('c-722', ago(1 * HOUR), 'Yes, we can', { sender: ZUL });
  const handled = itemOf('c-722', [ask, reply]);
  assert.deepEqual([handled.status, handled.waiting, handled.waiting_since, handled.state.type, handled.snooze],
    ['handled', false, null, null, null]);
  assert.deepEqual(handled.closed, { reason_text: 'Zul texted back from 888', closed_at: reply.at.toISOString(), by: 'Z' });
  const oldAsk = k.smsIn('c-723', ago(10 * DAY), 'Old question');
  const oldReply = k.smsOut('c-723', ago(9 * DAY), 'Old answer', { sender: ZUL });
  const quiet = itemOf('c-723', [oldAsk, oldReply]);
  assert.deepEqual([quiet.status, quiet.closed], ['quiet', null]);
});
