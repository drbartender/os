const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderPaystubPdf, formatUsdCents } = require('./paystubPdf');

test('formatUsdCents: integer cents to USD', () => {
  assert.equal(formatUsdCents(0), '$0.00');
  assert.equal(formatUsdCents(54740), '$547.40');
  assert.equal(formatUsdCents(382060), '$3,820.60');
  assert.equal(formatUsdCents(-1936), '-$19.36');
  assert.equal(formatUsdCents(null), '$0.00');
});

const FIXTURE = {
  contractorName: 'Jordan Blake',
  period: { start_date: '2026-05-16', end_date: '2026-05-31', payday: '2026-06-01' },
  paid: { at: '2026-06-01', method: 'venmo', handle: '@jblake' },
  events: [
    { event_date: '2026-05-17', client_name: 'Smith Family', event_type: 'wedding', event_type_custom: null, hours: 6, wage_cents: 24000, gratuity_share_cents: 5000, card_tip_net_cents: 3240, adjustment_cents: 0, adjustment_note: null, line_total_cents: 32240 },
    { event_date: '2026-05-24', client_name: 'Acme Co', event_type: 'corporate', event_type_custom: null, hours: 5, wage_cents: 20000, gratuity_share_cents: 1500, card_tip_net_cents: 0, adjustment_cents: 1000, adjustment_note: 'mileage', line_total_cents: 22500 },
  ],
  thisPeriod: { wages_cents: 44000, gratuity_cents: 6500, card_tips_net_cents: 3240, adjustments_cents: 1000, net_cents: 54740 },
  ytd: { wages_cents: 312000, gratuity_cents: 48000, card_tips_net_cents: 21060, adjustments_cents: 1000, net_cents: 382060 },
};

test('renderPaystubPdf: returns a PDF buffer', async () => {
  const buf = await renderPaystubPdf(FIXTURE);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(buf.length > 500);
});

test('renderPaystubPdf: tolerates empty events + missing paid handle', async () => {
  const buf = await renderPaystubPdf({ ...FIXTURE, events: [], paid: { at: '2026-06-01', method: 'check', handle: null } });
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
});
