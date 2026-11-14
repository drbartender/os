// menuReminderDueAt (spec 2026-10-19 section 13.3, decision 11): when an
// unanswered menu proof comes back to the Inbox, in Chicago business time.
// Pure: no database, no clock. Every instant here is written out in UTC with
// its Chicago wall time beside it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { menuReminderDueAt } = require('./menuReminder');

const HOUR = 3600 * 1000;
// Fri Nov 20 2026, 12:00 PM Chicago (CST, UTC-6).
const NOON = new Date('2026-11-20T18:00:00.000Z');
const plus = (d, ms) => new Date(new Date(d).getTime() + ms);
const due = (sentAt, eventDate) => menuReminderDueAt({ sentAt, eventDate }).toISOString();

test('eight days or more out: 9:00 a.m. Chicago on the day a week before the event', () => {
  assert.equal(due(NOON, '2026-12-20'), '2026-12-13T15:00:00.000Z', '30 days out: Sun Dec 13, 9:00 AM CST');
  assert.equal(due(NOON, '2026-11-28'), '2026-11-21T15:00:00.000Z', '8 days out: Sat Nov 21, 9:00 AM CST');
});

test('three to seven days out: a day after the send', () => {
  assert.equal(due(NOON, '2026-11-27'), plus(NOON, 24 * HOUR).toISOString(), '7 days out');
  assert.equal(due(NOON, '2026-11-23'), plus(NOON, 24 * HOUR).toISOString(), '3 days out');
});

test('two days or less out: at once', () => {
  assert.equal(due(NOON, '2026-11-22'), NOON.toISOString(), '2 days out');
  assert.equal(due(NOON, '2026-11-20'), NOON.toISOString(), 'the event day itself');
  assert.equal(due(NOON, '2026-11-18'), NOON.toISOString(), 'an event already past reads as at once');
});

test('no event date: a day after the send', () => {
  assert.equal(due(NOON, null), plus(NOON, 24 * HOUR).toISOString());
  assert.equal(due(NOON, undefined), plus(NOON, 24 * HOUR).toISOString());
});

// Review Focus 2: the GMT date is already tomorrow. Counted from the GMT day
// the event would be seven days out (a reminder a day later); counted from the
// Chicago day it is eight, so the reminder is 9:00 a.m. Chicago a week out.
test('a proof sent on a Chicago evening counts days from the Chicago date, never the GMT one', () => {
  const evening = new Date('2026-11-20T03:30:00.000Z'); // Thu Nov 19, 9:30 PM CST
  assert.equal(due(evening, '2026-11-27'), '2026-11-20T15:00:00.000Z', 'Fri Nov 20, 9:00 AM CST');
  assert.equal(due(evening, '2026-11-26'), plus(evening, 24 * HOUR).toISOString(), 'seven Chicago days out: a day later');
  assert.equal(due(evening, '2026-11-21'), evening.toISOString(), 'two Chicago days out: at once');
});

test('9:00 a.m. is Chicago wall time across a DST change', () => {
  const fall = new Date('2026-10-20T17:00:00.000Z'); // Tue Oct 20, 12:00 PM CDT
  assert.equal(due(fall, '2026-11-08'), '2026-11-01T15:00:00.000Z', 'Sun Nov 1, the day DST ends: 9:00 AM CST');
  assert.equal(due(fall, '2026-10-31'), '2026-10-24T14:00:00.000Z', 'before the change: 9:00 AM CDT');
  const spring = new Date('2027-02-20T18:00:00.000Z'); // Sat Feb 20, 12:00 PM CST
  assert.equal(due(spring, '2027-03-21'), '2027-03-14T14:00:00.000Z', 'Sun Mar 14, the day DST starts: 9:00 AM CDT');
});

test('a send time read back from the database as a string works the same', () => {
  assert.equal(due(NOON.toISOString(), '2026-11-28'), '2026-11-21T15:00:00.000Z');
});

test('an input it cannot read throws rather than guessing a time', () => {
  assert.throws(() => menuReminderDueAt({ sentAt: 'not a time', eventDate: '2026-11-28' }), /sentAt/);
  assert.throws(() => menuReminderDueAt({ sentAt: null, eventDate: '2026-11-28' }), /sentAt/);
  assert.throws(() => menuReminderDueAt({ sentAt: NOON, eventDate: '11/28/2026' }), /eventDate/);
  assert.throws(() => menuReminderDueAt({ sentAt: NOON, eventDate: '2026-02-31' }), /eventDate/);
});
