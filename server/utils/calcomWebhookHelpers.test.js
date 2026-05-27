const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  verifyCalcomSignature,
  computeBodyHash,
  parseCalcomBody,
  extractBookingFields,
  extractRescheduleOldUid,
  extractPhone,
  normalizeBooker,
} = require('./calcomWebhookHelpers');

test('verifyCalcomSignature: valid signature passes', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{"hello":"world"}');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyCalcomSignature(body, sig, secret), true);
});

test('verifyCalcomSignature: tampered body fails', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{"hello":"world"}');
  const tampered = Buffer.from('{"hello":"WORLD"}');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyCalcomSignature(tampered, sig, secret), false);
});

test('verifyCalcomSignature: wrong-length signature fails without throwing', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{}');
  assert.equal(verifyCalcomSignature(body, 'short', secret), false);
});

test('verifyCalcomSignature: empty signature fails', () => {
  assert.equal(verifyCalcomSignature(Buffer.from('{}'), '', 'secret'), false);
});

test('computeBodyHash: deterministic per byte sequence', () => {
  const a = computeBodyHash(Buffer.from('{"a":1}'));
  const b = computeBodyHash(Buffer.from('{"a":1}'));
  const c = computeBodyHash(Buffer.from('{"a":2}'));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
});

test('parseCalcomBody: valid JSON returns object', () => {
  const body = Buffer.from('{"triggerEvent":"BOOKING_CREATED","payload":{}}');
  const parsed = parseCalcomBody(body);
  assert.equal(parsed.triggerEvent, 'BOOKING_CREATED');
});

test('parseCalcomBody: malformed JSON throws', () => {
  assert.throws(() => parseCalcomBody(Buffer.from('not json')));
});

test('extractBookingFields: pulls uid + startTime from payload', () => {
  const out = extractBookingFields({ uid: 'abc123', startTime: '2026-05-27T15:00:00Z' });
  assert.equal(out.uid, 'abc123');
  assert.equal(out.startTime, '2026-05-27T15:00:00Z');
});

test('extractBookingFields: returns undefined for missing fields', () => {
  const out = extractBookingFields({});
  assert.equal(out.uid, undefined);
  assert.equal(out.startTime, undefined);
});

test('extractRescheduleOldUid: probes rescheduleUid first', () => {
  assert.equal(extractRescheduleOldUid({ rescheduleUid: 'old-1' }), 'old-1');
});

test('extractRescheduleOldUid: probes rescheduleId', () => {
  assert.equal(extractRescheduleOldUid({ rescheduleId: 'old-2' }), 'old-2');
});

test('extractRescheduleOldUid: probes originalRescheduleEvent.uid', () => {
  assert.equal(extractRescheduleOldUid({ originalRescheduleEvent: { uid: 'old-3' } }), 'old-3');
});

test('extractRescheduleOldUid: probes metadata.rescheduleUid', () => {
  assert.equal(extractRescheduleOldUid({ metadata: { rescheduleUid: 'old-4' } }), 'old-4');
});

test('extractRescheduleOldUid: returns null when no source matches', () => {
  assert.equal(extractRescheduleOldUid({ uid: 'new-1' }), null);
});

test('extractPhone: probes attendees[0].phoneNumber first', () => {
  assert.equal(extractPhone({ attendees: [{ phoneNumber: '+15551234567' }] }), '+15551234567');
});

test('extractPhone: probes attendees[0].phone', () => {
  assert.equal(extractPhone({ attendees: [{ phone: '+15551234567' }] }), '+15551234567');
});

test('extractPhone: probes responses.phone', () => {
  assert.equal(extractPhone({ responses: { phone: '+15551234567' } }), '+15551234567');
});

test('extractPhone: probes customInputs.phone', () => {
  assert.equal(extractPhone({ customInputs: { phone: '+15551234567' } }), '+15551234567');
});

test('extractPhone: returns null when no source matches', () => {
  assert.equal(extractPhone({}), null);
});

test('extractPhone: handles object-shaped value field', () => {
  assert.equal(extractPhone({ responses: { phone: { value: '+15551234567', label: 'Phone' } } }), '+15551234567');
});

test('extractPhone: rejects object without value field', () => {
  assert.equal(extractPhone({ responses: { phone: { notValue: 'x' } } }), null);
});

test('normalizeBooker: trims, length-caps, lowercases email, validates format', () => {
  const out = normalizeBooker({
    attendees: [{ name: '  Jane Smith  ', email: '  Jane@Example.COM ' }],
  });
  assert.equal(out.name, 'Jane Smith');
  assert.equal(out.email, 'jane@example.com');
  assert.equal(out.bookerNameRaw, 'Jane Smith');
  assert.equal(out.bookerEmailRaw, 'jane@example.com');
});

test('normalizeBooker: empty name falls back to Unknown booker', () => {
  const out = normalizeBooker({ attendees: [{ name: '', email: 'jane@example.com' }] });
  assert.equal(out.name, 'Unknown booker');
});

test('normalizeBooker: malformed email becomes null', () => {
  const out = normalizeBooker({ attendees: [{ name: 'Jane', email: 'not-an-email' }] });
  assert.equal(out.email, null);
});

test('normalizeBooker: 300-char name truncates to 255', () => {
  const longName = 'a'.repeat(300);
  const out = normalizeBooker({ attendees: [{ name: longName, email: 'jane@example.com' }] });
  assert.equal(out.name.length, 255);
});

test('normalizeBooker: no attendees array yields Unknown booker + null email', () => {
  const out = normalizeBooker({});
  assert.equal(out.name, 'Unknown booker');
  assert.equal(out.email, null);
  assert.equal(out.phone, null);
});
