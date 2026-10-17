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

test('a personal person (their mail stored personal by the sync) is never a subject, inbound or outbound', () => {
  const ask = k.gmIn('e-1212121212121212', ago(3 * HOUR), 'Dinner on Sunday?', { personal: true });
  assert.deepEqual(subjectsFor(run({ events: [ask] }), 'e-1212121212121212'), []);
  const reply = k.gmOut('e-1212121212121212', ago(2 * HOUR), 'Let me check and get back to you', { personal: true });
  assert.deepEqual(subjectsFor(run({ events: [ask, reply] }), 'e-1212121212121212'), []);
  const business = k.gmIn('e-3434343434343434', ago(3 * HOUR), 'Do you do corporate events?');
  assert.deepEqual(subjectsFor(run({ events: [business] }), 'e-3434343434343434').map((x) => x.kind), ['inbound']);
});

// Test 3 of the 2026-10-15 brief, at the rules: one sender's personal mail
// and business mail are two people, and no subject or slice line of either
// ever holds the personal mail's words.
test('one sender, a personal mail and a business mail: only the business one is read, and its slice holds none of the personal words', () => {
  const personal = k.gmIn('e-5656565656565656', ago(5 * HOUR), 'Private words about Sunday dinner', { personal: true, address: 'friend.r@example.com' });
  const business = k.gmIn('e-7878787878787878', ago(3 * HOUR), 'Do you do corporate events?', { address: 'friend.r@example.com' });
  const ourReply = k.gmOut('e-7878787878787878', ago(2 * HOUR), 'We do, let me check the date', { address: 'friend.r@example.com' });
  const ownerReply = k.gmOut('e-5656565656565656', ago(4 * HOUR), 'Private reply about dinner', { personal: true, address: 'friend.r@example.com' });
  const all = run({ events: [personal, ownerReply, business, ourReply] }).subjects;
  assert.ok(all.length > 0, 'the business person is read');
  assert.deepEqual([...new Set(all.map((x) => x.personKey))], ['e-7878787878787878']);
  const words = JSON.stringify(all);
  assert.equal(words.includes('Private'), false, 'no subject or slice line holds the personal words');
});

test('a Zola closed notice anchors the outbound slice: a Gmail reply after it reads the inquiry as context', () => {
  const inquiry = k.zolaEvent('z-61', ago(5 * HOUR), 'We love your menu', { leadId: 61, template: 'inquiry' });
  const closed = k.zolaEvent('z-61', ago(4 * HOUR), 'We found another vendor', { leadId: 61, template: 'closed' });
  const reply = k.zolaEvent('z-61', ago(3 * HOUR), 'Thanks for letting us know', { leadId: 61, template: 'out' });
  const [subj] = subjectsFor(run({ events: [inquiry, closed, reply] }), 'z-61');
  assert.equal(subj.kind, 'outbound');
  assert.deepEqual(subj.slice.map((x) => [x.ref, x.context]), [[inquiry.ref, true], [reply.ref, false]]);
});

// ─── Email (spec 2026-10-14 section 6 and section 17 item 25) ───

test('a Zola notice the OS could not read joins the slice with its fixed line; auto-replies and bounces stay out', () => {
  const { ZOLA_UNREAD_TEXT } = require('./constants');
  const unread = k.zolaEvent('z-62', ago(6 * HOUR), null, { leadId: 62, template: 'unparsed' });
  const ask = k.zolaEvent('z-62', ago(5 * HOUR), 'Is June 12 open?', { leadId: 62, template: 'message' });
  const [subj] = subjectsFor(run({ events: [unread, ask] }), 'z-62');
  assert.deepEqual([subj.kind, subj.subjectRef], ['inbound', ask.ref]);
  assert.deepEqual(subj.slice.map((x) => [x.ref, x.who, x.text]), [[unread.ref, 'THEM', ZOLA_UNREAD_TEXT], [ask.ref, 'THEM', 'Is June 12 open?']]);
  const mail = k.gmIn('c-520', ago(5 * HOUR), 'Can we add a mocktail station?');
  const auto = k.gmIn('c-520', ago(4 * HOUR), 'I am out of the office', { kind: 'auto_reply' });
  const later = k.gmIn('c-520', ago(3 * HOUR), 'Also, two bars?');
  const [m] = subjectsFor(run({ events: [mail, auto, later] }), 'c-520');
  assert.deepEqual(m.slice.map((x) => x.ref), [mail.ref, later.ref]);
});

// The readRef trap (lane email-feed's carry-forward, item 3): one Sent mail
// to two people is two events, gm:<id>:1 and gm:<id>:2, sharing readRef
// gm:<id>. Each person's subject keeps its own event's ref (its slice lines
// carry the same refs, so every match inside one subject stays exact) and
// names the mail's readRef, the key the read is stored and found under.
test('a Sent mail to two people: each subject keeps its own ref and names the readRef; a read under the readRef resolves both', () => {
  const askC = k.gmIn('c-521', ago(5 * HOUR), 'Who brings the ice?');
  const askP = k.gmIn('e-5210000000000521', ago(5 * HOUR), 'Same question on the ice');
  const toC = k.gmOut('c-521', ago(4 * HOUR), 'Let me check and get back to you', { gmailId: 'g521', n: 1 });
  const toP = k.gmOut('e-5210000000000521', ago(4 * HOUR), 'Let me check and get back to you', { gmailId: 'g521', n: 2 });
  const events = [askC, askP, toC, toP];
  const out = run({ events }).subjects.filter((x) => x.kind === 'outbound');
  assert.deepEqual(out.map((x) => [x.personKey, x.subjectRef, x.readRef]), [
    ['c-521', 'gm:g521:1', 'gm:g521'],
    ['e-5210000000000521', 'gm:g521:2', 'gm:g521'],
  ]);
  for (const s of out) assert.equal(s.slice[s.slice.length - 1].ref, s.subjectRef, 'the subject line is in its slice under the same ref');
  const read = { ...k.readRow('outbound', toC, { holding: false }), subject_ref: 'gm:g521' };
  assert.deepEqual(run({ events, reads: [read] }).subjects.filter((x) => x.kind === 'outbound'), [], 'one read resolves every sibling');
  const old = k.readRow('outbound', toC, { holding: false });
  assert.deepEqual(run({ events, reads: [old] }).subjects.filter((x) => x.kind === 'outbound').map((x) => x.subjectRef), ['gm:g521:2'],
    'a read stored under a suffixed ref still resolves its own event');
  const sms = k.smsIn('c-522', ago(2 * HOUR), 'Is Friday open?');
  assert.equal(subjectsFor(run({ events: [sms] }), 'c-522')[0].readRef, sms.ref, 'with no readRef, the ref');
});

test('a slice line carries legalHold from its event: a sibling of a Sent mail that reached the held client', () => {
  const ask = k.gmIn('e-5230000000000523', ago(5 * HOUR), 'Who brings the ice?');
  const sent = k.gmOut('e-5230000000000523', ago(4 * HOUR), 'Words written to the held client too', { gmailId: 'g523', n: 2, legalHold: true });
  const follow = k.gmIn('e-5230000000000523', ago(3 * HOUR), 'Following up on the ice');
  const [subj] = subjectsFor(run({ events: [ask, sent, follow] }), 'e-5230000000000523');
  assert.deepEqual(subj.slice.map((x) => [x.ref, x.legalHold]), [[ask.ref, false], [sent.ref, true], [follow.ref, false]]);
});
