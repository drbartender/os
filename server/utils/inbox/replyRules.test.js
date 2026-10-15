const { test } = require('node:test');
const assert = require('node:assert/strict');
const k = require('./rules.testkit');
const { normalizeEvents } = require('./normalize');
const { lineE164, lastHumanLineFromRows } = require('../smsLines');
const { pickRecipient, smsRowsOf, theirLineOf, latestConversationChannel } = require('./replyRules');
const { appLinkFor } = require('./reply');
const { thumbtackInboxUrl, gmailThreadUrl, zolaLeadUrl, ZOLA_DASHBOARD_URL } = require('./constants');

const { ZUL, HOUR, ago } = k;

test('decision 29: the number they last texted from, never one rebuilt from the key', () => {
  const events = normalizeEvents([
    k.smsIn('p-3125550189', ago(5 * HOUR), 'Hello from abroad', { phone: '+443125550189' }),
    k.relayNotice('p-3125550189', ago(4 * HOUR), { phone: '+18725550188' }),
  ]);
  assert.equal(pickRecipient({ events }), '+443125550189', 'a Thumbtack notice is never their text');
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

// ─── Email and Zola (spec 2026-10-14 section 4.4) ───

test('the reply area follows email and Zola too', () => {
  const email = normalizeEvents([k.smsIn('c-8', ago(5 * HOUR), 'Text first'), k.gmIn('c-8', ago(4 * HOUR), 'Then an email')]);
  assert.equal(latestConversationChannel(email), 'email');
  const zola = normalizeEvents([k.gmIn('c-8', ago(5 * HOUR), 'An email'), k.zolaEvent('c-8', ago(4 * HOUR), 'Then Zola')]);
  assert.equal(latestConversationChannel(zola), 'zola');
  const ours = normalizeEvents([k.gmIn('c-8', ago(5 * HOUR), 'An email'), k.zolaEvent('c-8', ago(4 * HOUR), 'Bye', { template: 'closed' })]);
  assert.equal(latestConversationChannel(ours), 'email', 'a Zola closed notice is a system line, not their message');
});

const TT_CAPTION = 'Closes here on its own once you reply in Thumbtack.';
const GMAIL_CAPTION = 'Closes here on its own once you reply from Gmail.';
const ZOLA_CAPTION = "Reply to Zola's email from Gmail and it closes here on its own. A reply typed inside Zola needs Done.";

test('appLinkFor: one app, their latest channel\'s, with its caption: Thumbtack, Gmail, or Zola\'s lead page or dashboard', () => {
  const uuid = '0b6f2c1e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';
  const index = {
    latestLeadByClient: new Map([[9, { negotiation_id: 'neg-9' }]]),
    zolaLeadsById: new Map([[31, { id: 31, lead_uuid: null }], [32, { id: 32, lead_uuid: uuid }]]),
  };
  const tt = normalizeEvents([k.ttIn('c-9', ago(2 * HOUR), 'Hi', { negotiationId: 'neg-9' })]);
  assert.deepEqual(appLinkFor('c-9', index, tt), { name: 'Thumbtack', url: thumbtackInboxUrl('neg-9'), caption: TT_CAPTION });
  const mail = normalizeEvents([k.gmIn('c-9', ago(3 * HOUR), 'Older', { threadId: 'th-old' }), k.gmIn('c-9', ago(2 * HOUR), 'Hi', { threadId: 'th-new' })]);
  assert.deepEqual(appLinkFor('c-9', index, mail), { name: 'Gmail', url: gmailThreadUrl('th-new'), caption: GMAIL_CAPTION },
    'the latest channel wins over the Thumbtack lead, and the newest thread opens');
  const noUuid = normalizeEvents([k.zolaEvent('z-31', ago(2 * HOUR), 'Is June open?', { leadId: 31 })]);
  assert.deepEqual(appLinkFor('z-31', index, noUuid), { name: 'Zola', url: ZOLA_DASHBOARD_URL, caption: ZOLA_CAPTION });
  const known = normalizeEvents([k.zolaEvent('z-32', ago(2 * HOUR), 'Is June open?', { leadId: 32 })]);
  assert.deepEqual(appLinkFor('z-32', index, known), { name: 'Zola', url: zolaLeadUrl(uuid), caption: ZOLA_CAPTION },
    'the lead row knows the UUID');
  const textLast = normalizeEvents([k.gmIn('c-10', ago(3 * HOUR), 'An email', { threadId: 'th-10' }), k.smsIn('c-10', ago(2 * HOUR), 'Then a text')]);
  assert.deepEqual(appLinkFor('c-10', index, textLast), { name: 'Gmail', url: gmailThreadUrl('th-10'), caption: GMAIL_CAPTION },
    'their newest message is a text: the app for the notices is the newest app channel they used');
  assert.equal(appLinkFor('c-11', index, normalizeEvents([k.smsIn('c-11', ago(HOUR), 'Only texts')])), null);
});
