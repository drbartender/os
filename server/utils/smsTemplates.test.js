const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('./smsTemplates');

// No SMS body may contain an em dash (the AI tell, per CLAUDE.md).
function assertNoEmDash(str, label) {
  assert.ok(!str.includes('—'), `${label} must not contain an em dash`);
}

test('initialProposalSms > greets, names the event, includes the link', () => {
  const s = t.initialProposalSms({ eventTypeLabel: 'birthday party', eventDate: 'August 15', link: 'https://x/p/abc' });
  assert.match(s, /^Hi, Dallas here\./);
  assert.match(s, /birthday party/);
  assert.match(s, /August 15/);
  assert.match(s, /https:\/\/x\/p\/abc/);
  assertNoEmDash(s, 'initialProposalSms');
});

test('signPayConfirmationSms > confirms the booking and the date', () => {
  const s = t.signPayConfirmationSms({ eventDate: 'August 15' });
  assert.match(s, /You're booked for August 15/);
  assertNoEmDash(s, 'signPayConfirmationSms');
});

test('dripTouch1Sms > asks if they got the proposal', () => {
  const s = t.dripTouch1Sms({ eventTypeLabel: 'wedding', eventDate: 'June 1' });
  assert.match(s, /Did you get the proposal/);
  assert.match(s, /wedding/);
  assertNoEmDash(s, 'dripTouch1Sms');
});

test('dripTouch3Sms > offers a tweak before it books up', () => {
  const s = t.dripTouch3Sms({ eventTypeLabel: 'wedding', eventDate: 'June 1', link: 'https://x/p/abc' });
  assert.match(s, /tweak/);
  assert.match(s, /https:\/\/x\/p\/abc/);
  assertNoEmDash(s, 'dripTouch3Sms');
});

test('dripTouch5Sms > last check, includes link', () => {
  const s = t.dripTouch5Sms({ eventDate: 'June 1', link: 'https://x/p/abc' });
  assert.match(s, /Last check/);
  assert.match(s, /https:\/\/x\/p\/abc/);
  assertNoEmDash(s, 'dripTouch5Sms');
});

test('drinkPlanNudgeSms > points at planner and consult', () => {
  const s = t.drinkPlanNudgeSms({ eventDate: 'June 1', plannerUrl: 'https://x/plan/abc', consultUrl: 'https://cal/x' });
  assert.match(s, /lock in drinks/);
  assert.match(s, /https:\/\/x\/plan\/abc/);
  assertNoEmDash(s, 'drinkPlanNudgeSms');
});

test('drinkPlanNudgeSms > omits the consult clause when consultUrl is null', () => {
  const s = t.drinkPlanNudgeSms({ eventDate: 'June 1', plannerUrl: 'https://x/plan/abc', consultUrl: null });
  assert.ok(!s.includes('book a consult'), 'consult clause should be omitted');
  assert.match(s, /https:\/\/x\/plan\/abc/);
});

test('balanceDueTodaySms > says due today and includes the link', () => {
  const s = t.balanceDueTodaySms({ eventDate: 'June 1', link: 'https://x/p/abc' });
  assert.match(s, /due today/);
  assert.match(s, /https:\/\/x\/p\/abc/);
  assertNoEmDash(s, 'balanceDueTodaySms');
});

test('balanceLateSms > t1 is gentle, t3 is firmer', () => {
  const s1 = t.balanceLateSms({ eventDate: 'June 1', link: 'https://x/p/abc', daysLate: 1 });
  const s3 = t.balanceLateSms({ eventDate: 'June 1', link: 'https://x/p/abc', daysLate: 3 });
  assert.match(s1, /1 day past due/);
  assert.match(s3, /3 days past due/);
  assert.match(s3, /ASAP/);
  assertNoEmDash(s1, 'balanceLateSms t1');
  assertNoEmDash(s3, 'balanceLateSms t3');
});

test('paymentFailureSms > says it did not go through, includes link', () => {
  const s = t.paymentFailureSms({ eventDate: 'June 1', link: 'https://x/p/abc' });
  assert.match(s, /didn't go through/);
  assert.match(s, /https:\/\/x\/p\/abc/);
  assertNoEmDash(s, 'paymentFailureSms');
});

test('eventEveSms > names bartender, time, location, phone, setup minutes', () => {
  const s = t.eventEveSms({
    startTime: '6:00 PM CDT',
    location: '123 Main St',
    bartenderName: 'Sam',
    bartenderPhone: '+13125550000',
    setupMinutes: 60,
  });
  assert.match(s, /Sam/);
  assert.match(s, /6:00 PM CDT/);
  assert.match(s, /123 Main St/);
  assert.match(s, /\+13125550000/);
  assert.match(s, /60 minutes/);
  assertNoEmDash(s, 'eventEveSms');
});

test('eventEveSms > omits the bartender clause when no bartender assigned', () => {
  const s = t.eventEveSms({
    startTime: '6:00 PM CDT',
    location: '123 Main St',
    bartenderName: null,
    bartenderPhone: null,
    setupMinutes: 60,
  });
  assert.ok(!s.includes('direct number'), 'phone clause should be omitted');
  assert.match(s, /6:00 PM CDT/);
});

test('rescheduleSms > gives the new details', () => {
  const s = t.rescheduleSms({ newDate: 'July 4', newStartTime: '7:00 PM', newLocation: '5 Oak Ave' });
  assert.match(s, /has been updated/);
  assert.match(s, /July 4/);
  assert.match(s, /5 Oak Ave/);
  assertNoEmDash(s, 'rescheduleSms');
});

test('lastMinuteStaffingConfirmationSms > singular form', () => {
  const s = t.lastMinuteStaffingConfirmationSms({
    eventDate: 'Saturday, May 30, 2026',
    bartenderList: 'Alex ((312) 555-1234)',
    isPlural: false,
  });
  assert.match(s, /^Hi, Dallas here\./);
  assert.match(s, /Your bartender for Saturday, May 30, 2026 is Alex \(\(312\) 555-1234\)\./);
  assert.match(s, /reach out the day of the event/);
  assertNoEmDash(s, 'lastMinuteStaffingConfirmationSms singular');
});

test('lastMinuteStaffingConfirmationSms > plural form', () => {
  const s = t.lastMinuteStaffingConfirmationSms({
    eventDate: 'Saturday, May 30, 2026',
    bartenderList: 'Alex ((312) 555-1234) and Jordan ((312) 555-5678)',
    isPlural: true,
  });
  assert.match(s, /Your bartenders for Saturday, May 30, 2026 are Alex/);
  assert.match(s, /and Jordan/);
  assertNoEmDash(s, 'lastMinuteStaffingConfirmationSms plural');
});


test('staffBeoNudgeSms > includes event type, date, and URL', () => {
  const body = t.staffBeoNudgeSms({
    eventTypeLabel: 'birthday party',
    eventDateLocal: 'Saturday, August 15',
    beoUrl: 'https://staff.drbartender.com/events/42/beo',
  });
  assert.match(body, /BEO ready from Dr\. Bartender/);
  assert.match(body, /birthday party/);
  assert.match(body, /Saturday, August 15/);
  assert.match(body, /https:\/\/staff\.drbartender\.com\/events\/42\/beo/);
  assertNoEmDash(body, 'staffBeoNudgeSms');
});

test('staffBeoNudgeSms > truncates long event type to 40 chars + ellipsis', () => {
  const longLabel = 'My Daughter Sweet Sixteen Quinceanera Co-Birthday Celebration';
  const body = t.staffBeoNudgeSms({
    eventTypeLabel: longLabel,
    eventDateLocal: 'Saturday, August 15',
    beoUrl: 'https://staff.drbartender.com/events/42/beo',
  });
  const truncated = body.match(/BEO ready from Dr\. Bartender: (.+) on /)[1];
  assert.ok(truncated.length <= 41, `expected truncated label <= 41 chars, got ${truncated.length}: "${truncated}"`);
});

test('staffBeoNudgeSms > strips curly quotes for GSM-7 friendliness', () => {
  const body = t.staffBeoNudgeSms({
    eventTypeLabel: '“birthday” party',
    eventDateLocal: 'Saturday, August 15',
    beoUrl: 'https://staff.drbartender.com/events/42/beo',
  });
  assert.ok(!/[“”‘’]/.test(body), 'no curly quotes');
});

// ─── Phase 5 Drop / Cover marketplace SMS ────────────────────────────────

test('cover_broadcast_sms > includes initials, role, client, date, URL', () => {
  const body = t.cover_broadcast_sms({
    first_initial_last_initial: 'J.B.',
    client_name: 'Smith Family',
    event_date_short: 'Sat May 30',
    shift_role: 'bartender',
    shift_url: 'https://staff.drbartender.com/shifts/42',
  });
  assert.match(body, /Cover needed from Dr\. Bartender/);
  assert.match(body, /J\.B\./);
  assert.match(body, /bartender/);
  assert.match(body, /Smith Family/);
  assert.match(body, /Sat May 30/);
  assert.match(body, /https:\/\/staff\.drbartender\.com\/shifts\/42/);
  assertNoEmDash(body, 'cover_broadcast_sms');
});

test('cover_broadcast_sms > fits 2 SMS segments worst case (320 chars)', () => {
  const body = t.cover_broadcast_sms({
    first_initial_last_initial: 'X.Y.',
    client_name: 'A Reasonably Long Client Name LLC',
    event_date_short: 'Saturday, December 31',
    shift_role: 'bartender',
    shift_url: 'https://staff.drbartender.com/shifts/999999',
  });
  assert.ok(body.length <= 320, `cover_broadcast_sms exceeds 2 segments: ${body.length} chars`);
});

test('cover_broadcast_sms > falls back to defaults on missing inputs', () => {
  const body = t.cover_broadcast_sms({});
  assert.match(body, /Cover needed/);
  assert.match(body, /bartender/);
});

test('cover_broadcast_sms > strips curly quotes', () => {
  const body = t.cover_broadcast_sms({
    first_initial_last_initial: 'J.B.',
    client_name: '“Quoted” Client',
    event_date_short: 'Sat May 30',
    shift_role: 'bartender',
    shift_url: 'https://x/y',
  });
  assert.ok(!/[“”‘’]/.test(body), 'no curly quotes');
});

test('staff_drop_to_management_sms > front-loads EMERGENCY DROP + name + reason', () => {
  const body = t.staff_drop_to_management_sms({
    staff_name: 'Alex Johnson',
    client_name: 'Smith Family',
    event_date_short: 'Sat May 30',
    hours_to_event: 12.4,
    reason: 'Car broke down on the way to the event',
  });
  assert.match(body, /^EMERGENCY DROP from Alex Johnson:/);
  assert.match(body, /Car broke down/);
  assert.match(body, /Smith Family/);
  assert.match(body, /Sat May 30/);
  assert.match(body, /12h/);
  assertNoEmDash(body, 'staff_drop_to_management_sms');
});

test('staff_drop_to_management_sms > truncates long reason to 80 chars', () => {
  const longReason = 'A'.repeat(200);
  const body = t.staff_drop_to_management_sms({
    staff_name: 'Alex',
    client_name: 'Smith',
    event_date_short: 'Sat May 30',
    hours_to_event: 12,
    reason: longReason,
  });
  // Body contains 80 A's max in the reason segment, never the full 200.
  const aRun = body.match(/A+/);
  assert.ok(aRun && aRun[0].length <= 80, `reason segment exceeds 80 chars: ${aRun?.[0].length}`);
});

test('staff_drop_to_management_sms > fits 2 SMS segments worst case', () => {
  const body = t.staff_drop_to_management_sms({
    staff_name: 'Some Person With A Long Name',
    client_name: 'A Reasonably Long Client Name LLC',
    event_date_short: 'Saturday, December 31',
    hours_to_event: 71,
    reason: 'A'.repeat(80),
  });
  assert.ok(body.length <= 320, `staff_drop_to_management_sms exceeds 2 segments: ${body.length} chars`);
});

test('staff_drop_to_management_sms > handles missing inputs gracefully', () => {
  const body = t.staff_drop_to_management_sms({});
  assert.match(body, /^EMERGENCY DROP from A staffer:/);
});
