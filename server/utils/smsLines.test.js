// The DRB text-line registry (spec 2026-10-06, Inbox, decisions 9, 19, 20).
// Pure: no DB. Each case sets the two env vars it reads; afterEach restores them.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  LINE_KEYS, lineE164, lineKeyForNumber, enabledLines, ownLineForUser, allowedLines, defaultLine,
  lastHumanLineFromRows,
} = require('./smsLines');

const ORIG_888 = process.env.TWILIO_PHONE_NUMBER;
const ORIG_LINES = process.env.INBOX_TEXT_LINES;
const FAKE_888 = '+18885550100';

afterEach(() => {
  if (ORIG_888 === undefined) delete process.env.TWILIO_PHONE_NUMBER;
  else process.env.TWILIO_PHONE_NUMBER = ORIG_888;
  if (ORIG_LINES === undefined) delete process.env.INBOX_TEXT_LINES;
  else process.env.INBOX_TEXT_LINES = ORIG_LINES;
});

test('LINE_KEYS: the three lines in registry order, frozen', () => {
  assert.deepEqual([...LINE_KEYS], ['888', '1922', '0082']);
  assert.ok(Object.isFrozen(LINE_KEYS));
});

test('lineE164: the 888 reads TWILIO_PHONE_NUMBER at call time; the 224s are fixed', () => {
  process.env.TWILIO_PHONE_NUMBER = FAKE_888;
  assert.equal(lineE164('888'), FAKE_888);
  process.env.TWILIO_PHONE_NUMBER = '+18885550199';
  assert.equal(lineE164('888'), '+18885550199', 'read per call, never cached at load');
  delete process.env.TWILIO_PHONE_NUMBER;
  assert.equal(lineE164('888'), null);
  assert.equal(lineE164('1922'), '+12242221922');
  assert.equal(lineE164('0082'), '+12242220082');
  assert.equal(lineE164('312'), null);
  assert.equal(lineE164(undefined), null);
});

test('lineKeyForNumber: a last-10 match in any format; null for anything else', () => {
  process.env.TWILIO_PHONE_NUMBER = FAKE_888;
  assert.equal(lineKeyForNumber('+18885550100'), '888');
  assert.equal(lineKeyForNumber('(888) 555-0100'), '888');
  assert.equal(lineKeyForNumber('+12242221922'), '1922');
  assert.equal(lineKeyForNumber('224.222.0082'), '0082');
  assert.equal(lineKeyForNumber('+13125550601'), null);
  assert.equal(lineKeyForNumber(''), null);
  assert.equal(lineKeyForNumber(null), null);
  delete process.env.TWILIO_PHONE_NUMBER;
  assert.equal(lineKeyForNumber('+18885550100'), null, 'an unset 888 matches nothing');
});

test('enabledLines: default 888; unknown keys dropped; the 888 always on; registry order', () => {
  delete process.env.INBOX_TEXT_LINES;
  assert.deepEqual(enabledLines(), ['888']);
  process.env.INBOX_TEXT_LINES = '';
  assert.deepEqual(enabledLines(), ['888']);
  process.env.INBOX_TEXT_LINES = '1922';
  assert.deepEqual(enabledLines(), ['888', '1922']);
  process.env.INBOX_TEXT_LINES = ' 0082, 888 ,1922,312,0082 ';
  assert.deepEqual(enabledLines(), ['888', '1922', '0082']);
});

test('ownLineForUser: Dallas (1, 12) the 1922, Zul (2) the 0082, anyone else the 888', () => {
  assert.equal(ownLineForUser(1), '1922');
  assert.equal(ownLineForUser(12), '1922');
  assert.equal(ownLineForUser('12'), '1922');
  assert.equal(ownLineForUser(2), '0082');
  assert.equal(ownLineForUser(7), '888');
  assert.equal(ownLineForUser(null), '888');
  assert.equal(ownLineForUser(undefined), '888');
});

test('allowedLines: staff and Thumbtack proxies get the 888 only; anyone else the enabled lines', () => {
  process.env.INBOX_TEXT_LINES = '888,1922,0082';
  assert.deepEqual(allowedLines({ isStaff: true }), ['888']);
  assert.deepEqual(allowedLines({ isProxy: true }), ['888']);
  assert.deepEqual(allowedLines({}), ['888', '1922', '0082']);
  assert.deepEqual(allowedLines(), ['888', '1922', '0082']);
});

test('defaultLine: the line of the last human-involved text wins when it is enabled', () => {
  process.env.INBOX_TEXT_LINES = '888,1922,0082';
  assert.equal(defaultLine({ lastHumanLine: '0082', senderUserId: 1 }), '0082');
  assert.equal(defaultLine({ lastHumanLine: '888', senderUserId: 1 }), '888',
    "an 888 history beats Dallas's own 1922");
});

test('defaultLine: with no human-involved text it is the sender own line', () => {
  process.env.INBOX_TEXT_LINES = '888,1922,0082';
  assert.equal(defaultLine({ lastHumanLine: null, senderUserId: 12 }), '1922');
  assert.equal(defaultLine({ senderUserId: 2 }), '0082');
  assert.equal(defaultLine({ senderUserId: 99 }), '888');
});

test('defaultLine: a default that is not enabled falls back to the 888', () => {
  delete process.env.INBOX_TEXT_LINES;
  assert.equal(defaultLine({ lastHumanLine: '1922', senderUserId: 1 }), '888');
  assert.equal(defaultLine({ senderUserId: 2 }), '888');
  process.env.INBOX_TEXT_LINES = '1922';
  assert.equal(defaultLine({ senderUserId: 2 }), '888', 'the 0082 is not enabled');
});

test('defaultLine: staff and proxies are 888-only whatever the history', () => {
  process.env.INBOX_TEXT_LINES = '888,1922,0082';
  assert.equal(defaultLine({ lastHumanLine: '1922', senderUserId: 1, isStaff: true }), '888');
  assert.equal(defaultLine({ lastHumanLine: '0082', senderUserId: 2, isProxy: true }), '888');
});

test('defaultLine: a line value that is not a key reads as the 888, as an unknown To does', () => {
  process.env.INBOX_TEXT_LINES = '888,1922,0082';
  assert.equal(defaultLine({ lastHumanLine: '+12242221922', senderUserId: 1 }), '888');
});

test('lastHumanLineFromRows: null when no row is human-involved', () => {
  assert.equal(lastHumanLineFromRows([]), null);
  assert.equal(lastHumanLineFromRows(null), null);
  assert.equal(lastHumanLineFromRows([
    { id: 1, direction: 'outbound', sender_id: null, status: 'sent', metadata: { line: '1922' }, created_at: '2026-09-01T10:00:00Z' },
    { id: 2, direction: 'outbound', sender_id: 7, status: 'failed', metadata: { line: '0082' }, created_at: '2026-09-02T10:00:00Z' },
  ]), null, 'automated sends and failed replies never count');
});

test('lastHumanLineFromRows: their text is the line it reached; a relay text is their 888 text', () => {
  process.env.TWILIO_PHONE_NUMBER = FAKE_888;
  const inbound = (metadata) => [{
    id: 1, direction: 'inbound', sender_id: null, status: 'received', metadata, created_at: '2026-09-01T10:00:00Z',
  }];
  assert.equal(lastHumanLineFromRows(inbound({ to: '+12242221922' })), '1922');
  assert.equal(lastHumanLineFromRows(inbound({ to: FAKE_888 })), '888');
  assert.equal(lastHumanLineFromRows(inbound({ to: '+13125550699' })), '888', 'a To that is not ours reads as the 888');
  assert.equal(lastHumanLineFromRows(inbound({})), '888', 'an old row with no To reads as the 888');
  assert.equal(lastHumanLineFromRows(inbound(null)), '888');
  assert.equal(lastHumanLineFromRows(inbound({ thumbtack_relay: true, to: '+12242221922' })), '888',
    'a Thumbtack proxy texts the 888, whatever the row says');
});

test('lastHumanLineFromRows: our reply counts with a sender and a status that is not failed; its line is metadata.line', () => {
  const reply = (extra) => [{
    id: 1, direction: 'outbound', sender_id: 7, status: 'sent', created_at: '2026-09-01T10:00:00Z', ...extra,
  }];
  assert.equal(lastHumanLineFromRows(reply({ metadata: { line: '0082' } })), '0082');
  assert.equal(lastHumanLineFromRows(reply({ metadata: {} })), '888', 'an older reply with no line reads as the 888');
  assert.equal(lastHumanLineFromRows(reply({ metadata: { line: '312' } })), '888');
  assert.equal(lastHumanLineFromRows(reply({ status: 'queued', metadata: { line: '1922' } })), '1922');
  assert.equal(lastHumanLineFromRows(reply({ status: null, metadata: { line: '1922' } })), '1922', 'only failed is skipped');
});

test('lastHumanLineFromRows: the newest qualifying row wins, in any order (created_at, then id)', () => {
  process.env.TWILIO_PHONE_NUMBER = FAKE_888;
  const rows = [
    { id: 10, direction: 'outbound', sender_id: 7, status: 'sent', metadata: { line: '1922' }, created_at: new Date('2026-09-03T10:00:00Z') },
    { id: 11, direction: 'outbound', sender_id: null, status: 'sent', metadata: {}, created_at: new Date('2026-09-05T10:00:00Z') },
    { id: 9, direction: 'inbound', sender_id: null, status: 'received', metadata: { to: '+12242220082' }, created_at: new Date('2026-09-04T10:00:00Z') },
    { id: 12, direction: 'outbound', sender_id: 7, status: 'failed', metadata: { line: '888' }, created_at: new Date('2026-09-06T10:00:00Z') },
  ];
  assert.equal(lastHumanLineFromRows(rows), '0082', 'the automated and the failed rows are newer but never count');
  assert.equal(lastHumanLineFromRows([...rows].reverse()), '0082');
  const tie = [
    { id: 20, direction: 'inbound', sender_id: null, status: 'received', metadata: { to: FAKE_888 }, created_at: '2026-09-07T10:00:00Z' },
    { id: 21, direction: 'outbound', sender_id: 7, status: 'sent', metadata: { line: '1922' }, created_at: '2026-09-07T10:00:00Z' },
  ];
  assert.equal(lastHumanLineFromRows(tie), '1922', 'a created_at tie goes to the higher id');
  assert.equal(lastHumanLineFromRows([{ ...tie[0], created_at: null }, { ...tie[1], created_at: null }]), '1922');
});
