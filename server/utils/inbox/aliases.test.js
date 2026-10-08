const { test } = require('node:test');
const assert = require('node:assert/strict');
const k = require('./rules.testkit');
const { buildPeopleIndex } = require('./people');
const { foldTaps } = require('./aliases');

const { DALLAS, ZUL, HOUR, ago, run, stateOf } = k;
const T = (iso) => new Date(iso);
// Client 77 owns +13125550111 (on file) and lead 555300.
const index = buildPeopleIndex({
  env: {},
  clients: [{ id: 77, name: 'Robin Example', phone: '+13125550111', created_at: T('2026-11-01T00:00:00Z') }],
  leads: [{ id: 300, negotiation_id: '555300', client_id: 77, customer_name: 'Robin E.', customer_phone: null, created_at: T('2026-10-20T00:00:00Z'), first_reply_sent_at: null }],
});

test('a Reopen tapped while they were an unknown number lands on the client they became, and no p- row is left', () => {
  const ask = k.smsIn('c-77', ago(30 * HOUR), 'Is the 14th open?', { phone: '+13125550111' });
  const reply = k.smsOut('c-77', ago(29 * HOUR), 'It is', { sender: ZUL, phone: '+13125550111' });
  const reopen = k.act('p-3125550111', 'reopen', ago(2 * HOUR), { userId: DALLAS });
  const folded = foldTaps({ actions: [reopen], seen: [], events: [ask, reply], index });
  assert.equal(folded.actions[0].person_key, 'c-77');
  const r = run({ events: [ask, reply], actions: folded.actions });
  assert.deepEqual([stateOf(r, 'c-77').status, stateOf(r, 'c-77').state.type], ['waiting', 'reopened']);
  assert.equal(r.people.has('p-3125550111'), false);
  assert.deepEqual(r.waiting.map((p) => p.personKey), ['c-77']);
  const unfolded = run({ events: [ask, reply], actions: [reopen] });
  assert.deepEqual(unfolded.waiting, [], 'without the fold the Reopen is lost');
});

test('a holding read stored under the old p- key still makes the reply a promise (reads match by subject_ref)', () => {
  const ask = k.smsIn('c-77', ago(5 * HOUR), 'Can you do the 14th?', { phone: '+13125550111' });
  const reply = k.smsOut('c-77', ago(4 * HOUR), 'Let me check and get back to you', { sender: ZUL, phone: '+13125550111' });
  const read = { ...k.readRow('outbound', reply, { holding: true, promised_by: 'Monday' }), person_key: 'p-3125550111' };
  const s = stateOf(run({ events: [ask, reply], reads: [read] }), 'c-77');
  assert.deepEqual([s.status, s.state.type, s.state.promisedBy], ['waiting', 'promise', 'Monday']);
});

test('seen marks fold too, and the newest mark wins', () => {
  const older = k.seenRow('c-77', ago(5 * HOUR), DALLAS);
  const newer = k.seenRow('p-3125550111', ago(3 * HOUR), ZUL);
  const folded = foldTaps({ actions: [], seen: [older, newer], events: [], index });
  assert.deepEqual(folded.seen.map((x) => [x.person_key, x.seen_by]), [['c-77', ZUL]]);
});

test('a t- tap follows its lead to the client; a lead with no client keeps its key', () => {
  const onLead = k.act('t-555300', 'claim', ago(HOUR), { userId: ZUL });
  const onOther = k.act('t-555999', 'claim', ago(HOUR), { userId: ZUL });
  const folded = foldTaps({ actions: [onLead, onOther], seen: [], events: [], index });
  assert.deepEqual(folded.actions.map((a) => a.person_key), ['c-77', 't-555999']);
});

test('a phone they texted from, not on file, is an alias too', () => {
  const fromWork = k.smsIn('c-77', ago(3 * HOUR), 'From my work phone', { phone: '+13125550112' });
  const done = k.act('p-3125550112', 'done', ago(2 * HOUR), { userId: ZUL });
  const folded = foldTaps({ actions: [done], seen: [], events: [fromWork], index });
  assert.equal(folded.actions[0].person_key, 'c-77');
});

// Checkpoint 2 (database review): the fold never moves a tap off a live key.
test('a Done on a live unknown-number item stays there, even when that number once texted as a client', () => {
  // Client 77 has +13125550111 on file now. An old thread on their former
  // number, +13125550113, was stamped with their client id; a stranger who has
  // that number now texts in unattributed, and the stranger's item takes a Done.
  const oldIn = k.smsIn('c-77', ago(240 * HOUR), 'Is the 14th open?', { phone: '+13125550113' });
  const oldReply = k.smsOut('c-77', ago(239 * HOUR), 'It is', { sender: ZUL, phone: '+13125550113' });
  const ask = k.smsIn('c-77', ago(5 * HOUR), 'Can we add a second bar?', { phone: '+13125550111' });
  const stranger = k.smsIn('p-3125550113', ago(4 * HOUR), 'Who is this?', { phone: '+13125550113' });
  const done = k.act('p-3125550113', 'done', ago(3 * HOUR), { userId: DALLAS });
  const events = [oldIn, oldReply, ask, stranger];
  const folded = foldTaps({ actions: [done], seen: [], events, index });
  assert.equal(folded.actions[0].person_key, 'p-3125550113', 'a key that still has events keeps its taps');
  const r = run({ events, actions: folded.actions });
  assert.deepEqual([stateOf(r, 'c-77').status, stateOf(r, 'p-3125550113').status], ['waiting', 'handled']);
});

test('a phone that two people texted from never moves a tap, in either order', () => {
  const first = k.smsIn('c-77', ago(48 * HOUR), 'Texting from the family phone', { phone: '+13125550114' });
  const second = k.smsIn('c-78', ago(24 * HOUR), 'Same phone, a different person', { phone: '+13125550114' });
  const claim = k.act('p-3125550114', 'claim', ago(HOUR), { userId: ZUL });
  for (const events of [[first, second], [second, first]]) {
    const folded = foldTaps({ actions: [claim], seen: [], events, index });
    assert.equal(folded.actions[0].person_key, 'p-3125550114');
  }
});

test('a staffer who left the send-eligible set: their taps follow their phone, as the item route moves the key', () => {
  // Staffer 20 is no longer send-eligible, so their texts now read as an
  // unknown number. Staffer 21 still is, and shares a phone with client 79.
  const staffIndex = buildPeopleIndex({
    env: {},
    clients: [{ id: 79, name: 'Jo Example', phone: '+13125550121', created_at: T('2026-11-01T00:00:00Z') }],
    staff: [{ id: 21, role: 'staff', phone: '+13125550121', updated_at: T('2026-11-01T00:00:00Z'), name: 'Kai B.' }],
    profilePhones: [{ user_id: 20, phone: '+13125550120' }, { user_id: 21, phone: '+13125550121' }],
  });
  const ask = k.smsIn('p-3125550120', ago(3 * HOUR), 'Can I still pick up shifts?', { phone: '+13125550120' });
  const fromShared = k.smsIn('c-79', ago(3 * HOUR), 'About our party', { phone: '+13125550121' });
  const left = k.act('s-20', 'claim', ago(2 * HOUR), { userId: ZUL });
  const stillStaff = k.act('s-21', 'claim', ago(2 * HOUR), { userId: ZUL });
  const folded = foldTaps({ actions: [left, stillStaff], seen: [], events: [ask, fromShared], index: staffIndex });
  assert.deepEqual(folded.actions.map((a) => a.person_key), ['p-3125550120', 's-21'], 'a send-eligible staffer never moves');
  const nowhere = foldTaps({ actions: [left], seen: [], events: [], index: staffIndex });
  assert.equal(nowhere.actions[0].person_key, 's-20', 'only onto a key that has events, as resolveKey moves it');
});

test('a live unknown-number item keeps its taps even after a Thumbtack lead takes that number', () => {
  // The text came before the lead existed, so it stays p-; at the tap's time
  // the index already names the lead, so only "a key with events stays" keeps
  // the Done where it was tapped.
  const leadIndex = buildPeopleIndex({
    env: {},
    leads: [{ id: 301, negotiation_id: '555301', client_id: null, customer_name: 'Lee N.', customer_phone: '+18725550160', created_at: ago(2 * HOUR), first_reply_sent_at: null }],
  });
  const hello = k.smsIn('p-8725550160', ago(5 * HOUR), 'Hello?', { phone: '+18725550160' });
  const done = k.act('p-8725550160', 'done', ago(HOUR), { userId: DALLAS });
  const folded = foldTaps({ actions: [done], seen: [], events: [hello], index: leadIndex });
  assert.equal(folded.actions[0].person_key, 'p-8725550160');
});

test('an unknown number asks the live people index before an event alias', () => {
  // +13125550115 is on file for client 78 now; the only texts from it are
  // client 77's old ones. The tap goes where the item route sends that key.
  const handedOn = buildPeopleIndex({
    env: {},
    clients: [{ id: 78, name: 'Sam Example', phone: '+13125550115', created_at: T('2026-11-02T00:00:00Z') }],
  });
  const old = k.smsIn('c-77', ago(48 * HOUR), 'From my old number', { phone: '+13125550115' });
  const claim = k.act('p-3125550115', 'claim', ago(HOUR), { userId: ZUL });
  const folded = foldTaps({ actions: [claim], seen: [], events: [old], index: handedOn });
  assert.equal(folded.actions[0].person_key, 'c-78');
});
