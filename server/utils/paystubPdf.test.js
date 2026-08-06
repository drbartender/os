const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderPaystubPdf, formatUsdCents, eventLabel } = require('./paystubPdf');

test('formatUsdCents: integer cents to USD', () => {
  assert.equal(formatUsdCents(0), '$0.00');
  assert.equal(formatUsdCents(54740), '$547.40');
  assert.equal(formatUsdCents(382060), '$3,820.60');
  assert.equal(formatUsdCents(-1936), '-$19.36');
  assert.equal(formatUsdCents(null), '$0.00');
});

test('eventLabel: canonical label via getEventTypeLabel, never the raw slug', () => {
  // Canonical id -> human label (the bug fix: was printing "birthday-party").
  assert.equal(eventLabel({ event_type: 'birthday-party', client_name: 'Smith Family' }), 'Smith Family / Birthday Party');
  // No client name -> bare label.
  assert.equal(eventLabel({ event_type: 'wedding-reception' }), 'Wedding Reception');
  // Custom text wins.
  assert.equal(eventLabel({ event_type_custom: 'Launch Gala', client_name: 'Acme' }), 'Acme / Launch Gala');
  // 'other' and unknown/missing type both fall back to 'event'.
  assert.equal(eventLabel({ event_type: 'other', client_name: 'Acme' }), 'Acme / event');
  assert.equal(eventLabel({ client_name: 'Acme' }), 'Acme / event');
});

const FIXTURE = {
  contractorName: 'Jordan Blake',
  period: { start_date: '2026-05-16', end_date: '2026-05-31', payday: '2026-06-01' },
  // No payment_handle — it is PII and never flows into the paystub.
  paid: { at: '2026-06-01', method: 'venmo' },
  events: [
    { event_date: '2026-05-17', client_name: 'Smith Family', event_type: 'wedding-reception', event_type_custom: null, hours: 6, wage_cents: 24000, gratuity_share_cents: 5000, card_tip_net_cents: 3240, adjustment_cents: 0, adjustment_note: null, line_total_cents: 32240 },
    { event_date: '2026-05-24', client_name: 'Acme Co', event_type: 'corporate-event', event_type_custom: null, hours: 5, wage_cents: 20000, gratuity_share_cents: 1500, card_tip_net_cents: 0, adjustment_cents: 1000, adjustment_note: 'mileage', line_total_cents: 22500 },
  ],
  duty_lines: [
    { kind: 'bar_rental', label: 'Bar rental', amount_cents: 2000, shift_id: 1, note: null },
    { kind: 'review_bounty', label: 'Review bounty', amount_cents: 1000, shift_id: null, note: null },
  ],
  thisPeriod: { wages_cents: 44000, gratuity_cents: 6500, card_tips_net_cents: 3240, adjustments_cents: 1000, duty_cents: 3000, net_cents: 57740 },
  ytd: { wages_cents: 312000, gratuity_cents: 48000, card_tips_net_cents: 21060, adjustments_cents: 1000, duty_cents: 3000, net_cents: 385060 },
};

test('renderPaystubPdf: returns a PDF buffer', async () => {
  const buf = await renderPaystubPdf(FIXTURE);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(buf.length > 500);
});

test('renderPaystubPdf: duty lines absent renders fine (pre-duty data shape)', async () => {
  const { duty_lines, ...rest } = FIXTURE;
  const buf = await renderPaystubPdf({
    ...rest,
    thisPeriod: { ...FIXTURE.thisPeriod, duty_cents: undefined },
    ytd: { ...FIXTURE.ytd, duty_cents: undefined },
  });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
});

test('renderPaystubPdf: heavy row count with duty lines still renders (page-break guard)', async () => {
  const manyEvents = Array.from({ length: 45 }, (_, i) => ({
    ...FIXTURE.events[0], event_date: `2026-05-${String((i % 28) + 1).padStart(2, '0')}`,
  }));
  const manyDuty = Array.from({ length: 10 }, () => FIXTURE.duty_lines[0]);
  const buf = await renderPaystubPdf({ ...FIXTURE, events: manyEvents, duty_lines: manyDuty });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(buf.length > 2000, 'multi-page output');
});

test('renderPaystubPdf: tolerates empty events + missing paid handle', async () => {
  const buf = await renderPaystubPdf({ ...FIXTURE, events: [], paid: { at: '2026-06-01', method: 'check' } });
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
});
