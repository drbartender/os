const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCents, parsePct, firstIsoDate, parseTimestamp, normalizeStatus,
  normalizeName, firstEmail, intOrNull, buildPayments, buildPayouts,
  buildEvents, verify, insertBatch, EXPECT, decodeExport,
} = require('./cc-ledger-import');

test('parseCents: decimal-string math, no float drift', () => {
  assert.equal(parseCents('$1,085'), 108500);
  assert.equal(parseCents('$-385'), -38500);
  assert.equal(parseCents('($385)'), -38500);
  assert.equal(parseCents('$999.35'), 99935);
  assert.equal(parseCents('1,085.5'), 108550);
  assert.equal(parseCents('$102,828.85'), 10282885);
  assert.equal(parseCents('0.005'), 1); // sub-cent rounds half-up
  assert.equal(parseCents(''), null);
  assert.equal(parseCents('n/a'), null);
});

test('parsePct strips % and handles blanks', () => {
  assert.equal(parsePct('0.0%'), 0);
  assert.equal(parsePct('10.25%'), 10.25);
  assert.equal(parsePct(''), null);
});

test('firstIsoDate takes day one of multi-day events', () => {
  assert.equal(firstIsoDate('06-13-2026, 06-14-2026'), '2026-06-13');
  assert.equal(firstIsoDate('07-01-2026'), '2026-07-01');
  assert.equal(firstIsoDate(''), null);
});

test('parseTimestamp handles CC 12-hour stamps and bare dates', () => {
  assert.equal(parseTimestamp('03-16-2026  7:49 PM'), '2026-03-16 19:49:00');
  assert.equal(parseTimestamp('01-13-2026  1:46 PM'), '2026-01-13 13:46:00');
  assert.equal(parseTimestamp('12-01-2025 12:15 AM'), '2025-12-01 00:15:00');
  assert.equal(parseTimestamp('12-01-2025 12:15 PM'), '2025-12-01 12:15:00');
  assert.equal(parseTimestamp('05-18-2026'), '2026-05-18 00:00:00');
  assert.equal(parseTimestamp(''), null);
});

test('normalizeStatus maps all six CC statuses and throws on surprises', () => {
  assert.equal(normalizeStatus('Confirmed'), 'booked');
  assert.equal(normalizeStatus('Canceled Booking'), 'cancelled_booking');
  assert.equal(normalizeStatus('Proposal (Date Open)'), 'quote_open');
  assert.equal(normalizeStatus('Canceled Proposal'), 'quote_cancelled');
  assert.equal(normalizeStatus('Expired Proposal'), 'quote_expired');
  assert.equal(normalizeStatus('Postponed Proposal'), 'quote_postponed');
  assert.throws(() => normalizeStatus('Some New Status'), /unknown CC event status/);
});

test('decodeExport falls back to windows-1252', () => {
  assert.equal(decodeExport(Buffer.from([0x41, 0x96, 0x42])), 'A–B'); // en dash in cp1252
});

test('buildPayments maps money to cents and keeps refunds negative', () => {
  const [p] = buildPayments([{
    Type: 'Refund', 'Paid On': '07-01-2026', 'Event Date': '06-13-2026, 06-14-2026',
    'Payment Applied': '$-385', 'Tip Amount': '$0', 'Processing Fees': '$0',
    'Net Amount': '$-385', 'Event Total': '$1,085', 'Taxable Amount': '$1,085',
    'Total Adjustment Amount': '$-385', 'Tax Rate': '0.0%', 'Tax Collected': '$0',
    'Payment Method': 'Credit Card', 'Event Title': 'Pat Q Art Fair', 'Paid By': 'Pat Q',
  }]);
  assert.equal(p.cc_type, 'Refund'); // verbatim: table CHECK allows 'Payment'/'Refund' only
  assert.equal(p.paid_on, '2026-07-01');
  assert.equal(p.event_date, '2026-06-13');
  assert.equal(p.payment_applied_cents, -38500);
  assert.equal(p.event_total_cents, 108500);
  assert.equal(p.tax_rate_pct, 0);
});

test('buildPayouts normalizes payees and matches users case/space-insensitively', () => {
  const users = new Map([['grace hopper', 42]]);
  const [a, b] = buildPayouts([
    { Payee: 'Grace  Hopper ', Date: '01-08-2026', Amount: '$482.50', Reference: 'Server', Category: 'Staff Payments' },
    { Payee: 'Jet\'s Pizza', Date: '03-02-2025', Amount: '$24.77', Reference: '', Category: 'Meals & Entertainment' },
  ], users);
  assert.equal(a.payee_user_id, 42);
  assert.equal(a.amount_cents, 48250);
  assert.equal(a.reference_role, 'Server');
  assert.equal(b.payee_user_id, null);
  assert.equal(b.category, 'Meals & Entertainment');
});

test('buildEvents links clients by first contact email and keeps quotes unlinked', () => {
  const clients = new Map([['ada@example.com', 7]]);
  const [booked, quote] = buildEvents([
    {
      ID: '541610', Status: 'Confirmed', 'Event Date': '12-31-2025', 'Event Type': 'Birthday Party',
      'Contact Email(s)': 'Ada@Example.com', 'Contact Name(s)': 'Ada Lovelace', Brand: 'Dr. Bartender',
      'Venue Name': 'The Rookery', 'Estimated Number of Guests': '120', Source: 'Google',
      'Total Cost': '$1,070', 'Created At': '11-02-2025  3:05 PM', 'Booked At': '11-05-2025 10:00 AM',
      'Package Name': 'Carbon Suspension',
    },
    { ID: '541611', Status: 'Proposal (Date Open)', 'Event Date': '06-18-2027', 'Contact Email(s)': 'ghost@x.com', 'Created At': '03-16-2026  7:49 PM' },
  ], clients);
  assert.equal(booked.cc_id, '541610');
  assert.equal(booked.status, 'booked');
  assert.equal(booked.client_id, 7);
  assert.equal(booked.estimated_guests, 120);
  assert.equal(booked.total_cost_cents, 107000);
  assert.equal(booked.cc_created_at, '2025-11-02 15:05:00');
  assert.equal(booked.booked_at, '2025-11-05 10:00:00');
  assert.equal(quote.status, 'quote_open');
  assert.equal(quote.client_id, null);
  assert.equal(quote.booked_at, null);
});

test('verify gates: whole-set failure surfaces, matching set passes', () => {
  const payments = [{ paid_on: '2024-06-01', payment_applied_cents: EXPECT.payments2024Cents, tip_cents: EXPECT.tipsCents }];
  const { failures } = verify(payments, [], []);
  assert.ok(failures.length > 0); // counts and other sums are off by construction
  const labels = failures.map(([l]) => l);
  assert.ok(labels.includes('payments row count'));
  assert.ok(!labels.includes('payments 2024 cents (P&L 2024)')); // this one ties
});

test('insertBatch: placeholder/param alignment and chunking', async () => {
  const calls = [];
  const fakeClient = { query: async (sql, params) => calls.push({ sql, params }) };
  const rows = Array.from({ length: 3 }, (_, i) => ({ a: `a${i}`, b: i, c: null }));
  await insertBatch(fakeClient, 't', rows, ['a', 'b', 'c']);
  assert.equal(calls.length, 1); // 3 rows < 200 chunk size
  assert.equal(calls[0].sql, 'INSERT INTO t (a,b,c, imported_at) VALUES ($1,$2,$3, NOW()),($4,$5,$6, NOW()),($7,$8,$9, NOW())');
  assert.deepEqual(calls[0].params, ['a0', 0, null, 'a1', 1, null, 'a2', 2, null]);
  // chunking: 201 rows -> two statements (200 + 1), params re-numbered per chunk
  calls.length = 0;
  await insertBatch(fakeClient, 't', Array.from({ length: 201 }, (_, i) => ({ a: i })), ['a']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sql, 'INSERT INTO t (a, imported_at) VALUES ($1, NOW())');
  assert.deepEqual(calls[1].params, [200]);
});

test('misc parsers', () => {
  assert.equal(intOrNull('1,244'), 1244);
  assert.equal(intOrNull(''), null);
  assert.equal(normalizeName('Charles  Babbage  III'), 'charles babbage iii');
  assert.equal(firstEmail({ 'Contact Email(s)': '', 'User Email(s)': ' Bob@Y.com; c@z.com' }), 'bob@y.com');
});
