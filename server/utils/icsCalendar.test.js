const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderEventIcs, foldIcsLine } = require('./icsCalendar');

test('renders a minimal VCALENDAR with VEVENT block', () => {
  const ics = renderEventIcs({
    uid: 'proposal-42@drbartender.com',
    startUtc: new Date('2026-06-15T23:00:00Z'),
    endUtc: new Date('2026-06-16T03:00:00Z'),
    summary: 'Birthday Party — Dr. Bartender',
    location: '123 Main St, Austin, TX',
    description: 'Your booking with Dr. Bartender',
    stampUtc: new Date('2026-05-20T18:00:00Z'),
  });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /VERSION:2\.0\r\n/);
  assert.match(ics, /PRODID:-\/\/Dr\. Bartender\/\/Booking\/\/EN\r\n/);
  assert.match(ics, /BEGIN:VEVENT\r\n/);
  assert.match(ics, /UID:proposal-42@drbartender\.com\r\n/);
  assert.match(ics, /DTSTAMP:20260520T180000Z\r\n/);
  assert.match(ics, /DTSTART:20260615T230000Z\r\n/);
  assert.match(ics, /DTEND:20260616T030000Z\r\n/);
  assert.match(ics, /SUMMARY:Birthday Party.*Dr\. Bartender\r\n/);
  assert.match(ics, /END:VEVENT\r\nEND:VCALENDAR\r\n$/);
});

test('uses CRLF line endings throughout', () => {
  const ics = renderEventIcs({
    uid: 'x@y',
    startUtc: new Date('2026-01-01T00:00:00Z'),
    endUtc: new Date('2026-01-01T01:00:00Z'),
    summary: 'X',
    location: 'Y',
    description: 'Z',
    stampUtc: new Date('2026-01-01T00:00:00Z'),
  });
  const bareLfIndex = ics.search(/(?<!\r)\n/);
  assert.equal(bareLfIndex, -1, `bare LF found at index ${bareLfIndex}`);
});

test('escapes commas, semicolons, backslashes, and newlines in text fields', () => {
  const ics = renderEventIcs({
    uid: 'esc@drbartender',
    startUtc: new Date('2026-01-01T00:00:00Z'),
    endUtc: new Date('2026-01-01T01:00:00Z'),
    summary: 'Wedding; reception, after-party',
    location: '123 Main St, Suite #4\\B',
    description: 'Line one\nLine two; with, commas',
    stampUtc: new Date('2026-01-01T00:00:00Z'),
  });
  assert.match(ics, /SUMMARY:Wedding\\;\s?reception\\,\s?after-party\r\n/);
  assert.match(ics, /LOCATION:123 Main St\\,\s?Suite #4\\\\B\r\n/);
  assert.match(ics, /DESCRIPTION:Line one\\nLine two\\;\s?with\\,\s?commas\r\n/);
});

test('foldIcsLine wraps content lines longer than 75 octets', () => {
  const long = 'X'.repeat(200);
  const folded = foldIcsLine(`DESCRIPTION:${long}`);
  const lines = folded.split('\r\n');
  assert.ok(lines[0].length <= 75, `first line was ${lines[0].length} octets`);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    assert.ok(lines[i].startsWith(' '), `continuation line ${i} missing leading space`);
    assert.ok(lines[i].length <= 75, `continuation line ${i} was ${lines[i].length} octets`);
  }
});

test('returns string suitable for Buffer.from(content, "utf8") into Resend attachments', () => {
  const ics = renderEventIcs({
    uid: 'buf@drbartender',
    startUtc: new Date('2026-06-15T23:00:00Z'),
    endUtc: new Date('2026-06-16T03:00:00Z'),
    summary: 'Test',
    location: 'Test',
    description: 'Test',
    stampUtc: new Date('2026-05-20T18:00:00Z'),
  });
  const buf = Buffer.from(ics, 'utf8');
  assert.ok(buf.length > 0);
  assert.equal(buf.subarray(0, 15).toString('utf8'), 'BEGIN:VCALENDAR');
});

test('null / missing optional fields are emitted as empty strings, not the literal "null"', () => {
  const ics = renderEventIcs({
    uid: 'min@drbartender',
    startUtc: new Date('2026-06-15T23:00:00Z'),
    endUtc: new Date('2026-06-16T03:00:00Z'),
    summary: 'Test',
    location: null,
    description: null,
    stampUtc: new Date('2026-05-20T18:00:00Z'),
  });
  assert.match(ics, /LOCATION:\r\n/);
  assert.match(ics, /DESCRIPTION:\r\n/);
});
