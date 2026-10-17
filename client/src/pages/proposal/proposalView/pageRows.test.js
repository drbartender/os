import { pageRows } from './pageRows';
import { applyIntentQuote } from './intentQuote';

// What the server sends for a hidden-discount booking (price_rows): a $350
// package with a hidden $100 discount already folded into a $250 package row.
// The rows sum to the service total; no hidden label or amount is in them.
const SERVER_ROWS = [
  { key: 'package', label: 'Test Package', amount: 250 },
  { key: 'addon-1', label: 'Test Add-on', amount: 50 },
];

const cents = (rows) => rows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0);

// Every real snapshot carries its package; the page draws nothing without one.
const PKG = { name: 'Test Package' };

test('the server rows, as sent, when there is no gratuity', () => {
  const rows = pageRows(SERVER_ROWS, { package: PKG, total: 300, gratuity: { total: 0 } });
  expect(rows).toEqual(SERVER_ROWS);
  expect(cents(rows)).toBe(30000);
});

// Review Focus 2: a gratuity election re-quote on a hidden-discount booking.
// applyIntentQuote rewrites snapshot.total and snapshot.gratuity together in
// client state; the server rows plus the re-quoted gratuity row must still
// equal the Total the page shows.
test('a gratuity election re-quote still adds up to the shown Total', () => {
  const proposal = {
    total_price: 300,
    price_rows: SERVER_ROWS,
    pricing_snapshot: { package: PKG, total: 300, gratuity: { rate: 0, total: 0, tip_jar: true, staff_count: 2, hours: 4 } },
  };
  const quoted = applyIntentQuote(proposal, {
    total_price: 340,
    gratuity: { rate: 5, total: 40, tip_jar: false, staff_count: 2, hours: 4 },
  });
  expect(quoted.price_rows).toBe(SERVER_ROWS);
  const rows = pageRows(quoted.price_rows, quoted.pricing_snapshot);
  expect(rows).toEqual([
    ...SERVER_ROWS,
    { key: 'gratuity', label: 'Gratuity', amount: 40, gratuity: true },
  ]);
  expect(cents(rows)).toBe(Math.round(quoted.pricing_snapshot.total * 100));
  expect(cents(rows)).toBe(34000);
});

// Plan decision 11: a new bundle against a server that does not send rows yet
// shows the Total and the gratuity row only, for the minutes of a deploy.
test('no server rows yet: only the gratuity row', () => {
  expect(pageRows(undefined, { package: PKG, total: 340, gratuity: { total: 40 } })).toEqual([
    { key: 'gratuity', label: 'Gratuity', amount: 40, gratuity: true },
  ]);
});

// Spec 4.1: a snapshot without a package shows its Total only, as the old
// memo did (its gratuity row sat inside the same package check), never a
// lone Gratuity row beside a Total it does not add up to.
test('a snapshot without a package draws no rows, not even the gratuity', () => {
  expect(pageRows([], { total: 50, gratuity: { total: 50 } })).toEqual([]);
  expect(pageRows(undefined, { total: 50, gratuity: { total: 50 } })).toEqual([]);
});

test('nothing to draw: no rows', () => {
  expect(pageRows(undefined, null)).toEqual([]);
  expect(pageRows([], undefined)).toEqual([]);
  expect(pageRows(null, { total: 10 })).toEqual([]);
});

test('the server rows are never mutated', () => {
  const rows = SERVER_ROWS.map((r) => ({ ...r }));
  const out = pageRows(rows, { package: PKG, total: 340, gratuity: { total: 40 } });
  expect(rows).toEqual(SERVER_ROWS);
  expect(out).not.toBe(rows);
});
