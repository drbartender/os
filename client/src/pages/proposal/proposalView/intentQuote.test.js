import { applyIntentQuote } from './intentQuote';

// A proposal as the row holds it: total_price is the PERSISTED total, and the
// snapshot is what the page renders.
const row = {
  id: 774,
  total_price: 350,
  amount_paid: 0,
  pricing_snapshot: { total: 350, gratuity: { rate: 0, total: 0, tip_jar: true }, package: { name: 'The Core Reaction' } },
};

// What POST /stripe/create-intent returns once the client elects a gratuity.
// Election-at-payment (spec 2026-08-03) persists NOTHING, so this total is a
// projection, never a row value.
const electionQuote = { total_price: 550, gratuity: { rate: 50, total: 200, tip_jar: false } };

test('the election total drives the rendered snapshot', () => {
  const next = applyIntentQuote(row, electionQuote);
  expect(next.pricing_snapshot.total).toBe(550);
  expect(next.pricing_snapshot.gratuity).toEqual({ rate: 50, total: 200, tip_jar: false });
});

// THE REGRESSION. create-intent writes no gratuity to the row, so adopting its
// total as total_price makes the client acknowledge a number the row has never
// held — and the sign endpoint's assertion (publicToken.js: ABS(total_price -
// acknowledged_total) < 0.005) then rejects every signature with 409
// TOTAL_CHANGED. Blocked proposals 774/775 in prod, 2026-08-21 → 08-28.
test('the election total NEVER overwrites the row total the signature acknowledges', () => {
  const next = applyIntentQuote(row, electionQuote);
  expect(next.total_price).toBe(350);
});

test('untouched fields survive the merge', () => {
  const next = applyIntentQuote(row, electionQuote);
  expect(next.id).toBe(774);
  expect(next.amount_paid).toBe(0);
  expect(next.pricing_snapshot.package).toEqual({ name: 'The Core Reaction' });
});

test('a quote with no numeric total leaves the proposal untouched', () => {
  expect(applyIntentQuote(row, { total_price: undefined })).toBe(row);
  expect(applyIntentQuote(row, {})).toBe(row);
});

test('a null proposal stays null', () => {
  expect(applyIntentQuote(null, electionQuote)).toBe(null);
});

test('a gratuity-less quote (client never touched the field) still matches the row', () => {
  const next = applyIntentQuote(row, { total_price: 350, gratuity: null });
  expect(next.total_price).toBe(350);
  expect(next.pricing_snapshot.total).toBe(350);
});

test('a null gratuity in the quote keeps the prior gratuity block (staff_count, hours, floor_rate drive the floor gate)', () => {
  const prior = { ...row, pricing_snapshot: { ...row.pricing_snapshot, gratuity: { rate: 0, total: 0, tip_jar: true, staff_count: 2, hours: 4, floor_rate: null } } };
  const next = applyIntentQuote(prior, { total_price: 350, gratuity: null });
  expect(next.pricing_snapshot.gratuity).toEqual(prior.pricing_snapshot.gratuity);
});
