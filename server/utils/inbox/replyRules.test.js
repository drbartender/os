const { test } = require('node:test');
const assert = require('node:assert/strict');
const k = require('./rules.testkit');
const { normalizeEvents } = require('./normalize');
const { lineE164, lastHumanLineFromRows } = require('../smsLines');
const { pickRecipient, smsRowsOf, theirLineOf, latestConversationChannel } = require('./replyRules');

const { ZUL, HOUR, ago } = k;

test('decision 29: the number they last texted from, never one rebuilt from the key', () => {
  const events = normalizeEvents([
    k.smsIn('p-7700900123', ago(5 * HOUR), 'Hello from abroad', { phone: '+447700900123' }),
    k.relayNotice('p-7700900123', ago(4 * HOUR), { phone: '+18725550188' }),
  ]);
  assert.equal(pickRecipient({ events }), '+447700900123', 'a Thumbtack notice is never their text');
  const later = normalizeEvents([
    k.smsIn('c-1', ago(5 * HOUR), 'From my old phone', { phone: '+13125550101' }),
    k.smsIn('c-1', ago(4 * HOUR), 'From my new phone', { phone: '+13125550102' }),
  ]);
  assert.equal(pickRecipient({ events: later, fallbackE164: '+13125550199' }), '+13125550102');
  assert.equal(pickRecipient({ events: [], fallbackE164: '+13125550199' }), '+13125550199', 'no inbound text: clients.phone');
  assert.equal(pickRecipient({ events: normalizeEvents([k.smsIn('c-1', ago(HOUR), 'x', { phone: 'unknown' })]) }), null);
});

test('the rows the shared line rule reads: their texts with the number they reached, our sends with line, sender and status', () => {
  const inbound = k.smsIn('c-2', ago(6 * HOUR), 'Hi', { line: '1922' });
  const auto = k.smsOut('c-2', ago(5 * HOUR), 'Reminder', { sender: null, line: '888' });
  const failed = k.smsOut('c-2', ago(4 * HOUR), 'Failed reply', { sender: ZUL, line: '0082', failed: true });
  const events = normalizeEvents([inbound, auto, failed]);
  assert.deepEqual(smsRowsOf(events), [
    { id: inbound.meta.id, direction: 'inbound', sender_id: null, status: 'received', metadata: { to: lineE164('1922') }, created_at: inbound.at },
    { id: auto.meta.id, direction: 'outbound', sender_id: null, status: 'sent', metadata: { line: '888' }, created_at: auto.at },
    { id: failed.meta.id, direction: 'outbound', sender_id: ZUL, status: 'failed', metadata: { line: '0082' }, created_at: failed.at },
  ]);
  assert.equal(lastHumanLineFromRows(smsRowsOf(events)), '1922', 'automated and failed sends never move it');
  const replied = normalizeEvents([inbound, auto, failed, k.smsOut('c-2', ago(3 * HOUR), 'Answer', { sender: ZUL, line: '0082' })]);
  assert.equal(lastHumanLineFromRows(smsRowsOf(replied)), '0082');
  assert.equal(lastHumanLineFromRows(smsRowsOf(normalizeEvents([k.smsOut('c-3', ago(HOUR), 'Auto', { sender: null })]))), null);
  const relay = smsRowsOf(normalizeEvents([k.smsIn('c-4', ago(HOUR), 'Via Thumbtack', { relayLeadName: 'Pat Q.' })]));
  assert.deepEqual(relay[0].metadata, { to: lineE164('888'), thumbtack_relay: true }, 'a relay text is their 888 text');
});

test('their line: the DRB line of their latest inbound text, never a Thumbtack notice', () => {
  const events = normalizeEvents([
    k.smsIn('c-4', ago(6 * HOUR), 'Hi', { line: '1922' }),
    k.smsOut('c-4', ago(5 * HOUR), 'Hello', { sender: ZUL, line: '0082' }),
  ]);
  assert.equal(theirLineOf(events), '1922', 'our reply from the 0082 does not change what they texted');
  assert.equal(theirLineOf([]), null);
  assert.equal(theirLineOf(normalizeEvents([k.relayNotice('c-5', ago(HOUR), { negotiationId: 'neg-5' })])), null);
});

test('a notice that quotes their words is their Thumbtack message, still never their text: not the recipient, not their line (Task 18 F1)', () => {
  const events = normalizeEvents([
    k.smsIn('c-7', ago(5 * HOUR), 'Texting from my phone', { phone: '+13125550107', line: '1922' }),
    k.relayNotice('c-7', ago(4 * HOUR), { phone: '+18725550188', negotiationId: 'neg-7', quoted: true }),
  ]);
  assert.equal(events[1].kind, 'message', 'the quoted notice is a message now');
  assert.equal(pickRecipient({ events }), '+13125550107');
  assert.equal(theirLineOf(events), '1922');
  assert.equal(latestConversationChannel(events), 'thumbtack', 'their newest message is the Thumbtack one');
});

test('the reply area follows the channel they last wrote on', () => {
  const tt = normalizeEvents([k.smsIn('c-6', ago(5 * HOUR), 'Text first'), k.ttIn('c-6', ago(4 * HOUR), 'Then Thumbtack')]);
  assert.equal(latestConversationChannel(tt), 'thumbtack');
  const text = normalizeEvents([k.ttIn('c-6', ago(5 * HOUR), 'Thumbtack first'), k.smsIn('c-6', ago(4 * HOUR), 'Then a text')]);
  assert.equal(latestConversationChannel(text), 'text');
});
