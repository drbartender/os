const { test } = require('node:test');
const assert = require('node:assert/strict');
const k = require('./rules.testkit');

const { DALLAS, ZUL, HOUR, MIN, ago, plus, run } = k;
const subjectsFor = (r, key) => r.subjects.filter((x) => x.personKey === key);

test('inbound subject: the newest unanswered message, sliced from the anchor plus the three before', () => {
  const stop = k.optLine('c-501', ago(11 * HOUR), 'stop');
  const help = k.smsIn('c-501', ago(10 * HOUR), 'help');
  const first = k.smsIn('c-501', ago(9 * HOUR), 'Hi, is Saturday open?');
  const answer = k.smsOut('c-501', ago(8 * HOUR), 'Yes it is', { sender: ZUL });
  const failed = k.smsOut('c-501', ago(7 * HOUR), 'Here is the link', { sender: ZUL, failed: true });
  const ask = k.smsIn('c-501', ago(6 * HOUR), 'Great, can we add a second bar?');
  const nameOf = (key) => (key === 'c-501' ? 'Robin Example' : null);
  const [subj] = subjectsFor(run({ events: [stop, help, first, answer, failed, ask], nameOf }), 'c-501');
  assert.deepEqual([subj.kind, subj.subjectRef, subj.name, subj.legalHold], ['inbound', ask.ref, 'Robin Example', false]);
  assert.deepEqual(subj.slice.map((x) => [x.ref, x.who, x.authorFirstName, x.text, x.context]), [
    [help.ref, 'THEM', null, 'help', true],
    [first.ref, 'THEM', null, 'Hi, is Saturday open?', true],
    [answer.ref, 'US', 'Zul', 'Yes it is', true],
    [ask.ref, 'THEM', null, 'Great, can we add a second bar?', false],
  ]);
  assert.equal(subj.slice[0].channel, 'text_888');
});

test('a newer message makes a new subject; an already-read one is not offered again', () => {
  const a = k.smsIn('c-502', ago(5 * HOUR), 'Do you travel to the suburbs?');
  const reads = [k.readRow('inbound', a, { needs_reply: true })];
  const b = k.smsIn('c-502', ago(4 * HOUR), 'Also, how many bartenders for 120?');
  assert.deepEqual(subjectsFor(run({ events: [a, b], reads }), 'c-502').map((x) => x.subjectRef), [b.ref]);
  assert.deepEqual(subjectsFor(run({ events: [a], reads }), 'c-502'), []);
});

test('outbound subject: the latest real text-bearing reply after the newest message, and nothing else', () => {
  const ask = k.smsIn('c-503', ago(5 * HOUR), 'When will the list come?');
  const reply = k.smsOut('c-503', ago(4 * HOUR), 'I will check and get back to you tomorrow', { sender: DALLAS });
  const subs = subjectsFor(run({ events: [ask, reply] }), 'c-503');
  assert.deepEqual(subs.map((x) => [x.kind, x.subjectRef]), [['outbound', reply.ref]]);
  assert.deepEqual(subs[0].slice.map((x) => [x.who, x.context]), [['THEM', false], ['US', false]]);
  for (const other of [
    k.call('c-504', ago(4 * HOUR), { durationSec: 200 }),
    k.mlSend('c-504', ago(4 * HOUR), { messageType: 'shopping_list_ready' }),
  ]) {
    const ask4 = k.smsIn('c-504', ago(5 * HOUR), 'Any update?');
    assert.deepEqual(subjectsFor(run({ events: [ask4, other] }), 'c-504'), [], other.meta.source);
  }
  const sentAt = ago(3 * HOUR);
  const tt = k.ttIn('c-505', plus(sentAt, -MIN), 'Quote please', { negotiationId: 'neg-505' });
  const auto = k.ttOut('c-505', plus(sentAt, 10 * 1000), 'We are reviewing your request', { negotiationId: 'neg-505', firstReplySentAt: sentAt });
  assert.deepEqual(subjectsFor(run({ events: [tt, auto] }), 'c-505').map((x) => x.kind), ['inbound']);
});

test('a resolved read is not offered again; an error read is', () => {
  const ask = k.smsIn('c-506', ago(5 * HOUR), 'Is the 3rd still free?');
  for (const status of ['ok', 'refused']) {
    const reads = [k.readRow('inbound', ask, { status, needs_reply: status === 'ok' ? true : null })];
    assert.deepEqual(subjectsFor(run({ events: [ask], reads }), 'c-506'), [], status);
  }
  assert.equal(subjectsFor(run({ events: [ask], reads: [k.readRow('inbound', ask, { status: 'error' })] }), 'c-506').length, 1);
});

test('a resolved outbound read is not offered again either; an error read is', () => {
  const ask = k.smsIn('c-509', ago(5 * HOUR), 'Can you send the menu?');
  const reply = k.smsOut('c-509', ago(4 * HOUR), 'Here is the menu', { sender: DALLAS });
  const offered = (reads) => subjectsFor(run({ events: [ask, reply], reads }), 'c-509').map((x) => [x.kind, x.subjectRef]);
  assert.deepEqual(offered([]), [['outbound', reply.ref]]);
  for (const status of ['ok', 'refused']) {
    assert.deepEqual(offered([k.readRow('outbound', reply, { status, holding: status === 'ok' ? false : null })]), [], status);
  }
  assert.deepEqual(offered([k.readRow('outbound', reply, { status: 'error' })]), [['outbound', reply.ref]]);
});

test('a picture-only message is never a subject; the legal-hold client is flagged', () => {
  const media = [{ url: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMt/Media/MEt', content_type: 'image/png' }];
  assert.deepEqual(subjectsFor(run({ events: [k.smsIn('c-507', ago(2 * HOUR), '', { media })] }), 'c-507'), []);
  const ask = k.smsIn('c-508', ago(2 * HOUR), 'Please call me');
  const hold = k.proposalRow('c-508', { status: 'confirmed', eventDate: '2026-12-12', legalHold: true });
  const subs = subjectsFor(run({ events: [ask], proposals: [hold] }), 'c-508');
  assert.deepEqual(subs.map((x) => x.legalHold), [true]);
});
