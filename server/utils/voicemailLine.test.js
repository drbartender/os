require('dotenv').config();
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const line = require('./voicemailLine');

const SAVED = { ...process.env };
beforeEach(() => {
  delete process.env.VM_PRIMARY_DIAL_TARGET;
  delete process.env.VM_ESCALATION_QUIET_ZUL;
  delete process.env.VM_ESCALATION_QUIET_PRIMARY;
  delete process.env.VM_ESCALATION_TZ_ZUL;
  delete process.env.VM_ESCALATION_TZ_PRIMARY;
  delete process.env.VM_PRIMARY_RING_SEC;
  process.env.VA_CELL = '+639171234567';
});
after(() => { process.env = { ...SAVED }; });

test('resolveLine accepts primary and defaults everything else to zul', () => {
  assert.equal(line.resolveLine('primary'), 'primary');
  assert.equal(line.resolveLine('zul'), 'zul');
  // The default is load-bearing: an un-stamped call is a 0082 call, and every
  // row that predates the line column was Zul's.
  assert.equal(line.resolveLine(undefined), 'zul');
  assert.equal(line.resolveLine(''), 'zul');
  assert.equal(line.resolveLine('PRIMARY'), 'zul', 'exact match only, no case folding');
  assert.equal(line.resolveLine('../primary'), 'zul');
  assert.equal(line.resolveLine({}), 'zul');
});

test('escalationTargetFor crosses the lines', () => {
  process.env.VM_PRIMARY_DIAL_TARGET = '+13125889401';
  // A caller on Dallas's line who presses 1 reaches Zul, and vice versa.
  assert.equal(line.escalationTargetFor('primary'), '+639171234567');
  assert.equal(line.escalationTargetFor('zul'), '+13125889401');
});

test('escalationTargetFor returns null for a missing or malformed target', () => {
  delete process.env.VM_PRIMARY_DIAL_TARGET;
  assert.equal(line.escalationTargetFor('zul'), null, 'unset target must not dial');
  process.env.VM_PRIMARY_DIAL_TARGET = '3125889401';
  assert.equal(line.escalationTargetFor('zul'), null, 'not strict E.164');
  process.env.VM_PRIMARY_DIAL_TARGET = '+1312588940"><Dial>evil</Dial>';
  assert.equal(line.escalationTargetFor('zul'), null, 'a quote must never reach an attribute');
});

test('quietWindowFor parses HH:MM-HH:MM and rejects junk', () => {
  process.env.VM_ESCALATION_QUIET_ZUL = '22:00-08:00';
  assert.deepEqual(line.quietWindowFor('primary'), { start: 1320, end: 480, tz: 'Asia/Manila' },
    'the primary line escalates TO Zul, so Zul\'s window applies');
  process.env.VM_ESCALATION_QUIET_ZUL = 'banana';
  assert.equal(line.quietWindowFor('primary'), null, 'unparseable means no quiet window');
  process.env.VM_ESCALATION_QUIET_ZUL = '';
  assert.equal(line.quietWindowFor('primary'), null, 'empty string disables it');
});

test('inQuietWindow honors a window that wraps midnight', () => {
  process.env.VM_ESCALATION_QUIET_ZUL = '22:00-08:00';
  // 03:00 Asia/Manila is 19:00 UTC the previous day.
  const threeAmManila = new Date('2026-07-27T19:00:00Z');
  assert.equal(line.inQuietWindow('primary', threeAmManila), true);
  // 14:00 Asia/Manila is 06:00 UTC.
  const twoPmManila = new Date('2026-07-27T06:00:00Z');
  assert.equal(line.inQuietWindow('primary', twoPmManila), false);
});

test('inQuietWindow is false when no window is configured', () => {
  delete process.env.VM_ESCALATION_QUIET_ZUL;
  assert.equal(line.inQuietWindow('primary', new Date('2026-07-27T19:00:00Z')), false);
});

test('inQuietWindow never throws on a bad IANA zone, it fails open', () => {
  // The try/catch around minutesInZone is load-bearing on a live call path.
  process.env.VM_ESCALATION_QUIET_ZUL = '22:00-08:00';
  process.env.VM_ESCALATION_TZ_ZUL = 'Not/AZone';
  assert.equal(line.inQuietWindow('primary', new Date('2026-07-27T19:00:00Z')), false);
});

test('primaryRingSec defaults to 18 and clamps to 5..30', () => {
  delete process.env.VM_PRIMARY_RING_SEC;
  assert.equal(line.primaryRingSec(), 18);
  process.env.VM_PRIMARY_RING_SEC = '1';
  assert.equal(line.primaryRingSec(), 5);
  process.env.VM_PRIMARY_RING_SEC = '600';
  assert.equal(line.primaryRingSec(), 30, 'must stay under a carrier voicemail pickup');
  delete process.env.VM_PRIMARY_RING_SEC;
});

test('interceptionSuspicion fires only on an instant answer on the primary line', () => {
  const s = (o) => line.interceptionSuspicion(o).suspect;
  assert.equal(s({ line: 'primary', status: 'completed', dialCallDuration: '1' }), true);
  assert.equal(s({ line: 'primary', status: 'completed', dialCallDuration: '45' }), false,
    'a real conversation is not an anomaly');
  assert.equal(s({ line: 'zul', status: 'completed', dialCallDuration: '1' }), false,
    'Zul dials her cell directly; the canary is for the forwarded hop');
  assert.equal(s({ line: 'primary', status: 'no-answer', dialCallDuration: '0' }), false);
  assert.equal(s({ line: 'primary', status: 'completed', dialCallDuration: '0' }), false,
    'zero means never connected, not instantly answered');
  assert.equal(s({ line: 'primary', status: 'completed', dialCallDuration: undefined }), false);
  // Pin the boundary itself: 3s is suspect, 4s is a fast human.
  assert.equal(s({ line: 'primary', status: 'completed', dialCallDuration: '3' }), true);
  assert.equal(s({ line: 'primary', status: 'completed', dialCallDuration: '4' }), false);
  assert.equal(line.interceptionSuspicion({
    line: 'primary', status: 'completed', dialCallDuration: '7',
  }).dialSec, 7, 'the parsed duration comes back for the log line');
});
