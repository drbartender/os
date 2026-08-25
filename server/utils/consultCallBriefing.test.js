const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const {
  spokenClockTime,
  clockTimeWithMinutes,
  spokenDateOnly,
  formatUsPhoneForText,
  buildConsultBriefing,
} = require('./consultCallBriefing');

// ─── consultCallBriefing ─────────────────────────────────────────
// Pure spoken-copy builder for the consult call bridge (spec 2026-08-25
// section 4.4). No DB, no I/O, no escaping (the TwiML layer owns xmlEscape).
// Every string here is asserted whole: this copy is read aloud to Dallas and
// to Zul, so a stray double space or a stuttering "Sarah M.." is a real defect.

// 10:00 AM Chicago on 2026-10-10 (CDT, UTC-5).
const SLOT_10AM = new Date('2026-10-10T15:00:00.000Z');

// ─── spokenClockTime / clockTimeWithMinutes ──────────────────────

test('spokenClockTime drops :00 on the hour and keeps real minutes', () => {
  assert.equal(spokenClockTime(SLOT_10AM), '10 AM');
  assert.equal(spokenClockTime(new Date('2026-10-10T15:15:00.000Z')), '10:15 AM');
});

test('spokenClockTime speaks Chicago wall clock, not UTC', () => {
  // 02:30Z on Oct 11 is still 9:30 PM Oct 10 in Chicago.
  assert.equal(spokenClockTime(new Date('2026-10-11T02:30:00.000Z')), '9:30 PM');
  // Winter: Chicago is UTC-6, so 16:00Z is 10 AM, not 11 AM.
  assert.equal(spokenClockTime(new Date('2026-01-15T16:00:00.000Z')), '10 AM');
});

test('spokenClockTime accepts an ISO string as well as a Date', () => {
  assert.equal(spokenClockTime('2026-10-10T15:00:00.000Z'), '10 AM');
});

test('clockTimeWithMinutes always keeps the minutes', () => {
  assert.equal(clockTimeWithMinutes(SLOT_10AM), '10:00 AM');
  assert.equal(clockTimeWithMinutes(new Date('2026-10-10T15:15:00.000Z')), '10:15 AM');
});

test('clock helpers return null on an unparseable instant', () => {
  assert.equal(spokenClockTime(new Date('nope')), null);
  assert.equal(spokenClockTime(null), null);
  assert.equal(clockTimeWithMinutes('garbage'), null);
  assert.equal(clockTimeWithMinutes(undefined), null);
});

// ─── spokenDateOnly ──────────────────────────────────────────────

const MODULE_PATH = path.join(__dirname, 'consultCallBriefing.js');

// Runs the SAME assertion inside a child node with an explicit TZ. This is the
// only shape that catches the real bug: proposals.event_date is a Postgres DATE
// and node-pg hands it back as a JS Date at PROCESS-LOCAL midnight. A helper
// that formats that Date as an INSTANT in America/Chicago prints the day BEFORE
// on Render (TZ=UTC) while passing every test written on this box
// (TZ=America/Chicago). Comparing the two processes is what exposes it.
function spokenDateOnlyUnderTz(zone) {
  const script =
    'const { spokenDateOnly } = require(' + JSON.stringify(MODULE_PATH) + ');\n' +
    'process.stdout.write(String(spokenDateOnly(new Date(2026, 9, 10))));';
  return execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: zone },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('spokenDateOnly of a local-midnight DATE is identical under TZ=UTC and TZ=America/Chicago', () => {
  const utc = spokenDateOnlyUnderTz('UTC');
  const chicago = spokenDateOnlyUnderTz('America/Chicago');
  assert.equal(utc, chicago, `TZ leaked into the DATE: UTC said ${utc}, Chicago said ${chicago}`);
  assert.equal(utc, 'Saturday October 10th');
  assert.equal(chicago, 'Saturday October 10th');
});

test('spokenDateOnly reads a Date by its local calendar fields', () => {
  assert.equal(spokenDateOnly(new Date(2026, 9, 10)), 'Saturday October 10th');
});

test('spokenDateOnly reads the first 10 chars of a string', () => {
  assert.equal(spokenDateOnly('2026-10-10'), 'Saturday October 10th');
  assert.equal(spokenDateOnly('2026-10-10T00:00:00.000Z'), 'Saturday October 10th');
  assert.equal(spokenDateOnly('2026-10-10 00:00:00'), 'Saturday October 10th');
});

test('spokenDateOnly applies the ordinal rule, including the teens', () => {
  const cases = [
    ['2026-03-01', 'Sunday March 1st'],
    ['2026-03-02', 'Monday March 2nd'],
    ['2026-03-03', 'Tuesday March 3rd'],
    ['2026-03-04', 'Wednesday March 4th'],
    ['2026-03-11', 'Wednesday March 11th'],
    ['2026-03-12', 'Thursday March 12th'],
    ['2026-03-13', 'Friday March 13th'],
    ['2026-03-21', 'Saturday March 21st'],
    ['2026-03-22', 'Sunday March 22nd'],
    ['2026-03-23', 'Monday March 23rd'],
    ['2026-03-31', 'Tuesday March 31st'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(spokenDateOnly(input), expected, input);
  }
});

test('spokenDateOnly returns null on anything unparseable', () => {
  for (const bad of [null, undefined, '', 'nope', '10/10/2026', new Date('nope'), 20261010, {}, '2026-13-45']) {
    assert.equal(spokenDateOnly(bad), null, String(bad));
  }
});

// ─── formatUsPhoneForText ────────────────────────────────────────

test('formatUsPhoneForText renders a US E.164 number as dashed digits', () => {
  assert.equal(formatUsPhoneForText('+12563281203'), '256-328-1203');
});

test('formatUsPhoneForText returns anything else exactly as given', () => {
  assert.equal(formatUsPhoneForText('+639171234567'), '+639171234567');
  assert.equal(formatUsPhoneForText('(256) 328-1203'), '(256) 328-1203');
  assert.equal(formatUsPhoneForText('+1256328120'), '+1256328120');
  assert.equal(formatUsPhoneForText('+125632812034'), '+125632812034');
  assert.equal(formatUsPhoneForText(null), null);
  assert.equal(formatUsPhoneForText(undefined), undefined);
});

// ─── buildConsultBriefing ────────────────────────────────────────

const FULL = {
  bookerName: 'Tyler Anderson',
  scheduledAt: SLOT_10AM,
  eventDate: new Date(2026, 9, 10),
  guestCount: 120,
  proposalId: 718,
};

const DETAILS = 'Event Saturday October 10th, 120 guests, proposal 718.';

test('ring 1 speaks the spec briefing with no prefix', () => {
  assert.equal(
    buildConsultBriefing({ ...FULL, ring: 1 }),
    `Potion planning call with Tyler Anderson, booked for 10 AM. ${DETAILS} Press 1 to call them now. Press 9 to hear this again.`
  );
});

test('ring 2 and ring 3 carry the retry prefixes', () => {
  assert.equal(
    buildConsultBriefing({ ...FULL, ring: 2 }),
    `Second try. Potion planning call with Tyler Anderson, booked for 10 AM. ${DETAILS} Press 1 to call them now. Press 9 to hear this again.`
  );
  assert.equal(
    buildConsultBriefing({ ...FULL, ring: 3 }),
    `Last try. Potion planning call with Tyler Anderson, booked for 10 AM. ${DETAILS} Press 1 to call them now. Press 9 to hear this again.`
  );
});

test('the Zul briefing after Dallas was rung says he missed it', () => {
  assert.equal(
    buildConsultBriefing({ ...FULL, ring: 3, forVa: true, adminWasRung: true }),
    `Dallas missed his potion planning call with Tyler Anderson, booked for 10 AM. ${DETAILS} Press 1 to call them for him. Press 9 to hear this again.`
  );
});

test('the Zul briefing when Dallas was never rung says the call is for him', () => {
  assert.equal(
    buildConsultBriefing({ ...FULL, ring: 0, forVa: true, adminWasRung: false }),
    `Potion planning call with Tyler Anderson, booked for 10 AM, for Dallas. ${DETAILS} Press 1 to call them for him. Press 9 to hear this again.`
  );
});

test('the retry prefix never leaks into a Zul briefing', () => {
  const va = buildConsultBriefing({ ...FULL, ring: 3, forVa: true, adminWasRung: true });
  assert.ok(!va.includes('Last try.'), va);
  assert.ok(!va.includes('Second try.'), va);
});

test('absent details leave no double space, no stray comma, and no "unknown"', () => {
  const bare = buildConsultBriefing({ bookerName: 'Tyler Anderson', scheduledAt: SLOT_10AM, ring: 1 });
  assert.equal(
    bare,
    'Potion planning call with Tyler Anderson, booked for 10 AM. Press 1 to call them now. Press 9 to hear this again.'
  );
  assert.ok(!/ {2}/.test(bare), 'no double space');
  assert.ok(!/unknown/i.test(bare), 'never speaks "unknown"');
  assert.ok(!/, \./.test(bare), 'no stray comma');

  const vaBare = buildConsultBriefing({ bookerName: 'Tyler Anderson', scheduledAt: SLOT_10AM, forVa: true, adminWasRung: true });
  assert.equal(
    vaBare,
    'Dallas missed his potion planning call with Tyler Anderson, booked for 10 AM. Press 1 to call them for him. Press 9 to hear this again.'
  );
  assert.ok(!/ {2}/.test(vaBare), 'no double space');
});

test('a partially known consult speaks only the details it has', () => {
  assert.equal(
    buildConsultBriefing({ ...FULL, ring: 1, eventDate: null, proposalId: null }),
    'Potion planning call with Tyler Anderson, booked for 10 AM. 120 guests. Press 1 to call them now. Press 9 to hear this again.'
  );
  assert.equal(
    buildConsultBriefing({ ...FULL, ring: 1, guestCount: null }),
    'Potion planning call with Tyler Anderson, booked for 10 AM. Event Saturday October 10th, proposal 718. Press 1 to call them now. Press 9 to hear this again.'
  );
});

test('a zero or negative guest count is not spoken', () => {
  for (const guestCount of [0, '0', -5, null, undefined, '']) {
    const out = buildConsultBriefing({ ...FULL, ring: 1, guestCount });
    assert.ok(!out.includes('guests'), `guestCount ${JSON.stringify(guestCount)} -> ${out}`);
  }
});

test('a non positive-integer proposal id is not spoken', () => {
  for (const proposalId of [0, '0', -1, null, undefined, '', 'abc', 1.5]) {
    const out = buildConsultBriefing({ ...FULL, ring: 1, proposalId });
    assert.ok(!out.includes('proposal'), `proposalId ${JSON.stringify(proposalId)} -> ${out}`);
  }
});

test('an unparseable event date is skipped, never spoken as null', () => {
  const out = buildConsultBriefing({ ...FULL, ring: 1, eventDate: 'not a date' });
  assert.ok(!out.includes('Event'), out);
  assert.ok(!out.includes('null'), out);
  assert.equal(
    out,
    'Potion planning call with Tyler Anderson, booked for 10 AM. 120 guests, proposal 718. Press 1 to call them now. Press 9 to hear this again.'
  );
});

test('an initialed name does not stutter into a double period', () => {
  const out = buildConsultBriefing({ ...FULL, ring: 1, bookerName: 'Sarah M.' });
  assert.ok(out.startsWith('Potion planning call with Sarah M, booked for'), out);
  assert.ok(!out.includes('Sarah M..'), out);
  assert.ok(!out.includes('M.,'), out);
});

test('a missing or blank name falls back to "the client"', () => {
  for (const bookerName of [null, undefined, '', '   ', '.']) {
    const out = buildConsultBriefing({ ...FULL, ring: 1, bookerName });
    assert.ok(
      out.startsWith('Potion planning call with the client, booked for 10 AM.'),
      `${JSON.stringify(bookerName)} -> ${out}`
    );
  }
});

test('surrounding whitespace is trimmed off the name', () => {
  const out = buildConsultBriefing({ ...FULL, ring: 1, bookerName: '  Tyler Anderson  ' });
  assert.ok(out.startsWith('Potion planning call with Tyler Anderson, booked for'), out);
});

test('the builder does not escape: escaping is the TwiML layer\'s job', () => {
  const out = buildConsultBriefing({ ...FULL, ring: 1, bookerName: 'Tyler & Sons' });
  assert.ok(out.includes('Tyler & Sons'), out);
  assert.ok(!out.includes('&amp;'), out);
});
