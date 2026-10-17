import {
  splitRows, slotWidth, artStart, artWidth, chunkRows, partitionDrinks, layoutDrinks,
  artGeometry, stepSize, logoSize,
  ART_FLOOR, ART_STEP, MAX_ILLUSTRATED, MAX_MORE, CANVAS_W, CANVAS_H, PAGE_PAD_BOTTOM, NAME_FLOOR, DESC_FLOOR,
} from './layouts';

// The 2026-10-01 snapshot's numbers (spec 11.2; table D item 7 says the v3
// files drifted: 4 in one row, slot widths 300 and 146, starts 260/210/160/120).

const EXPECTED = {
  0: { rows: [], widths: [] },
  1: { rows: [1], widths: [360] },
  2: { rows: [2], widths: [250] },
  3: { rows: [3], widths: [200] },
  4: { rows: [2, 2], widths: [250, 250] },
  5: { rows: [3, 2], widths: [200, 250] },
  6: { rows: [3, 3], widths: [200, 200] },
  7: { rows: [4, 3], widths: [152, 200] },
  8: { rows: [4, 4], widths: [152, 152] },
};

describe('splitRows and slotWidth for every count from 0 to 8', () => {
  Object.entries(EXPECTED).forEach(([n, { rows, widths }]) => {
    test(`${n} drinks`, () => {
      expect(splitRows(Number(n))).toEqual(rows);
      expect(splitRows(Number(n)).map(slotWidth)).toEqual(widths);
    });
  });

  test('nonsense counts are no rows', () => {
    expect(splitRows(-1)).toEqual([]);
    expect(splitRows(2.5)).toEqual([]);
    expect(splitRows(undefined)).toEqual([]);
  });

  test('past 8 rows of 4 carry on, so nothing is dropped', () => {
    expect(splitRows(9)).toEqual([4, 4, 1]);
    expect(splitRows(9).reduce((a, b) => a + b, 0)).toBe(9);
  });

  test('a row length outside 1 to 4 still gets a width', () => {
    expect(slotWidth(5)).toBe(152);
    expect(slotWidth(0)).toBe(360);
  });
});

describe('artStart', () => {
  test('starts by total rows across both groups', () => {
    expect(artStart(1)).toBe(280);
    expect(artStart(2)).toBe(210);
    expect(artStart(3)).toBe(165);
    expect(artStart(4)).toBe(130);
    expect(artStart(6)).toBe(130);
  });

  test('0 rows (a beer-and-wine-only menu) still returns a number', () => {
    expect(artStart(0)).toBe(130);
  });

  test('the floor, step and art width', () => {
    expect(ART_FLOOR).toBe(65);
    expect(ART_STEP).toBe(6);
    expect(artWidth(165)).toBe(119);
    expect(artWidth(65)).toBe(47);
  });
});

test('chunkRows cuts a list top-heavy', () => {
  expect(chunkRows(['a', 'b', 'c', 'd', 'e'])).toEqual([['a', 'b', 'c'], ['d', 'e']]);
  expect(chunkRows([])).toEqual([]);
  expect(chunkRows(null)).toEqual([]);
});

const drink = (i, over = {}) => ({ key: `custom:d${i}`, group: 'sig', display_name: `Drink ${i}`, hidden: false, has_art: true, ...over });

describe('partitionDrinks', () => {
  test('12 visible: 8 illustrated by group, 4 in More from the bar', () => {
    const drinks = [
      ...[1, 2, 3, 4, 5, 6].map((i) => drink(i)),
      drink(7, { group: 'mock' }),
      drink(8, { group: 'mock' }),
      ...[9, 10, 11, 12].map((i) => drink(i, { has_art: false })),
    ];
    const p = partitionDrinks(drinks);
    expect(p.sig.map((d) => d.key)).toEqual([1, 2, 3, 4, 5, 6].map((i) => `custom:d${i}`));
    expect(p.mock.map((d) => d.key)).toEqual(['custom:d7', 'custom:d8']);
    expect(p.more.map((d) => d.key)).toEqual(['custom:d9', 'custom:d10', 'custom:d11', 'custom:d12']);
    expect(p.extra).toEqual([]);
  });

  test('all hidden lays out as nothing (Review Focus 3)', () => {
    const drinks = [1, 2, 3].map((i) => drink(i, { hidden: true }));
    expect(partitionDrinks(drinks)).toEqual({ sig: [], mock: [], more: [], extra: [] });
    const l = layoutDrinks(drinks);
    expect(l.rows).toBe(0);
    expect(l.sigRows).toEqual([]);
    expect(l.mockRows).toEqual([]);
    expect(typeof l.artStart).toBe('number');
  });

  test('no drinks at all, or no array, lays out as nothing', () => {
    expect(layoutDrinks([]).rows).toBe(0);
    expect(layoutDrinks(undefined).rows).toBe(0);
  });

  test('hidden drinks are left out and the order is kept', () => {
    const drinks = [drink(1), drink(2, { hidden: true }), drink(3, { group: 'mock' }), drink(4)];
    const p = partitionDrinks(drinks);
    expect(p.sig.map((d) => d.key)).toEqual(['custom:d1', 'custom:d4']);
    expect(p.mock.map((d) => d.key)).toEqual(['custom:d3']);
  });

  test('past the limits, the rest is extra and never printed', () => {
    const drinks = [
      ...Array.from({ length: 9 }, (_, i) => drink(i + 1)),
      ...Array.from({ length: 5 }, (_, i) => drink(i + 20, { has_art: false })),
    ];
    const p = partitionDrinks(drinks);
    expect(p.sig.length + p.mock.length).toBe(MAX_ILLUSTRATED);
    expect(p.more).toHaveLength(MAX_MORE);
    expect(p.extra.map((d) => d.key)).toEqual(['custom:d9', 'custom:d24']);
  });

  test('layoutDrinks counts rows across both groups for the art start', () => {
    // The garden sample: 4 signatures (2 + 2) and 1 mocktail (1) is 3 rows.
    const drinks = [drink(1), drink(2), drink(3), drink(4), drink(5, { group: 'mock' })];
    const l = layoutDrinks(drinks);
    expect(l.sigRows.map((r) => r.length)).toEqual([2, 2]);
    expect(l.mockRows.map((r) => r.length)).toEqual([1]);
    expect(l.rows).toBe(3);
    expect(l.artStart).toBe(165);
  });
});

describe('canvas geometry', () => {
  test('the canvas and its page box', () => {
    expect([CANVAS_W, CANVAS_H, PAGE_PAD_BOTTOM]).toEqual([800, 1000, 86]);
  });

  test('a drink image is a square of the art box width, centered in its height', () => {
    expect(artGeometry(165)).toEqual({ aw: 119, top: 23 });
    expect(artGeometry(280)).toEqual({ aw: 202, top: 39 });
    expect(artGeometry(65)).toEqual({ aw: 47, top: 9 });
  });

  test('one type step is 10% down, never below the floors, never up', () => {
    expect([NAME_FLOOR, DESC_FLOOR]).toEqual([20, 14]);
    expect(stepSize(25, NAME_FLOOR)).toBe(22.5);
    expect(stepSize(17.5, DESC_FLOOR)).toBe(15.75);
    expect(stepSize(21, NAME_FLOOR)).toBe(20);
    expect(stepSize(15, DESC_FLOOR)).toBe(14);
    expect(stepSize(18, NAME_FLOOR)).toBe(18);
  });

  test('the logo: 96 above the title, 150 replacing it, capped by width at its ratio', () => {
    expect(logoSize('above_title', false, null)).toEqual({ width: undefined, height: 96 });
    expect(logoSize('replaces_title', false, null)).toEqual({ width: undefined, height: 150 });
    expect(logoSize('above_title', false, 2)).toEqual({ width: 192, height: 96 });
    expect(logoSize('replaces_title', true, 1)).toEqual({ width: 150, height: 150 });
    // 20:1 is wider than the page: 668 wide plain, 640 on a badge.
    expect(logoSize('above_title', false, 20)).toEqual({ width: 668, height: 33.4 });
    expect(logoSize('above_title', true, 20)).toEqual({ width: 640, height: 32 });
    expect(logoSize('nope', false, null).height).toBe(96);
  });
});
