// Event-matching tests. Pure, no DB (CC fixtures supply expenses + bookings).
// Run: node --test server/scripts/staffPaymentImport/eventMatch.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { matchEvents } = require('./eventMatch');
const { loadExpenses, loadBookings } = require('./ccReports');

const fx = (n) => path.join(__dirname, '__fixtures__', n);
const ccExpenses = loadExpenses(fx('cc-expenses.csv'));
const ccBookings = loadBookings(fx('cc-bookings.csv'));

test('exact-amount CC expense match wins over a memo hint', () => {
  const row = { payee: 'Test Person', amountCents: 10500, date: '2025-04-12', memo: 'DrB 4/13', kind: 'payment' };
  const [m] = matchEvents([row], { ccExpenses, ccBookings });
  assert.strictEqual(m.eventEvidence, 'cc-expense');
  assert.match(m.eventLabel, /Smith Wedding/);
});

test('0–7 day proximity to an assigned booking produces "(inferred)"', () => {
  const row = { payee: 'Test Freyer', amountCents: 20000, date: '2025-05-18', memo: '', kind: 'payment' };
  const [m] = matchEvents([row], { ccExpenses, ccBookings });
  assert.strictEqual(m.eventEvidence, 'inferred');
  assert.match(m.eventLabel, /Jones Gala \(inferred\)/);
});

test('memo-derived label when no CC match (date token)', () => {
  const row = { payee: 'Test Nomatch', amountCents: 4200, date: '2025-07-01', memo: 'Taryn DrB 6/28', kind: 'payment' };
  const [m] = matchEvents([row], { ccExpenses, ccBookings });
  assert.strictEqual(m.eventEvidence, 'memo');
  assert.match(m.eventLabel, /6\/28/);
});

test('no evidence → null label', () => {
  const row = { payee: 'Nobody At All', amountCents: 333, date: '2026-01-01', memo: '', kind: 'payment' };
  const [m] = matchEvents([row], { ccExpenses, ccBookings });
  assert.strictEqual(m.eventLabel, null);
  assert.strictEqual(m.eventEvidence, null);
});
