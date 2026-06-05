const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapEventType, toEtDateAndTime, buildAdminNotes } = require('./thumbtackProposalDraft');

test('mapEventType: maps wedding category to wedding-reception + category', () => {
  const r = mapEventType({ category: 'Wedding Bartending', details: [] });
  assert.equal(r.eventType, 'wedding-reception');
  assert.equal(r.eventTypeCategory, 'wedding_related');
});

test('mapEventType: specific beats generic (milestone before birthday)', () => {
  const r = mapEventType({ category: 'Bartending', details: [{ question: 'Occasion?', answer: 'Milestone birthday' }] });
  assert.equal(r.eventType, 'milestone-birthday');
});

test('mapEventType: happy hour beats corporate', () => {
  const r = mapEventType({ category: 'Corporate happy hour', details: [] });
  assert.equal(r.eventType, 'corporate-happy-hour');
});

test('mapEventType: no match returns nulls', () => {
  const r = mapEventType({ category: 'Bartending', details: [{ question: 'x', answer: 'just drinks' }] });
  assert.equal(r.eventType, null);
  assert.equal(r.eventTypeCategory, null);
});

test('toEtDateAndTime: late-evening UTC stays on the ET calendar day', () => {
  // 2026-06-21T01:00:00Z is 2026-06-20 21:00 EDT
  const r = toEtDateAndTime('2026-06-21T01:00:00Z');
  assert.equal(r.eventDate, '2026-06-20');
  assert.match(r.eventStartTime, /9:00\s?PM/i);
});

test('toEtDateAndTime: null input yields nulls', () => {
  assert.deepEqual(toEtDateAndTime(null), { eventDate: null, eventStartTime: null });
});

test('buildAdminNotes: includes negotiation, category, description, Q&A', () => {
  const notes = buildAdminNotes({
    negotiationId: 'neg123', category: 'Wedding', leadPrice: '$15', chargeState: 'charged',
    eventDate: '2026-06-21T01:00:00Z', description: 'Need a bartender',
    details: [{ question: 'Guests?', answer: '80' }],
  });
  assert.match(notes, /neg123/);
  assert.match(notes, /Wedding/);
  assert.match(notes, /Need a bartender/);
  assert.match(notes, /Guests\?: 80/);
});
