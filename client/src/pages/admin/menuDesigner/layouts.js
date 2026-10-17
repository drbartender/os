// The printed menu's drink geometry (spec 2026-10-01 section 11.2: Rows, Slot
// width, Art height, More from the bar; plan Task C1). Pure: no React, no DOM.
//
// The numbers are the 2026-10-01 snapshot's (menu-designer.html, ROWS, SLOTW
// and the il0 table), not the v3 files' drifted copy (table D, item 7).
//
// splitRows(n)           -> row sizes for one group of n illustrated drinks
// slotWidth(rowLen)      -> the slot width in canvas px for a row of rowLen
// artStart(totalRows)    -> the art height the fit loop starts from
// chunkRows(list)        -> list cut into rows by splitRows
// partitionDrinks(drinks) -> { sig, mock, more, extra } (visible drinks only)
// layoutDrinks(drinks)   -> the partition plus the rows and the art start
// artGeometry(il)        -> { aw, top }: the art box width and the drink
//                           image's top inside it (a square, centered)
// stepSize(size, floor)  -> a face size after the one type step
// logoSize(mode, badge, ratio) -> { width, height } of the logo image

// The canvas: 800 x 1000 px, 100 px = 1 in. The page box pads 58 top, 66 a
// side and 86 at the bottom.
export const CANVAS_W = 800;
export const CANVAS_H = 1000;
export const PAGE_PAD_BOTTOM = 86;
const PAGE_INNER_W = CANVAS_W - 2 * 66;

// Type floors and the one step down (11.2): names never below 20 px,
// descriptions never below 14 px, one 10% step.
export const NAME_FLOOR = 20;
export const DESC_FLOOR = 14;
export const TYPE_STEP = 0.9;

// Row splits by count: top-heavy, at most 4 per row.
export const ROW_SPLITS = Object.freeze({
  1: [1], 2: [2], 3: [3], 4: [2, 2], 5: [3, 2], 6: [3, 3], 7: [4, 3], 8: [4, 4],
});

// Slot width by row length.
export const SLOT_WIDTHS = Object.freeze({ 1: 360, 2: 250, 3: 200, 4: 152 });

// Art height start by the total row count across both groups (index = rows - 1);
// 4 or more rows start at the last value.
export const ART_STARTS = Object.freeze([280, 210, 165, 130]);

// The fit loop: shrink in 6 px steps, never below 65 px (0.65 in).
export const ART_FLOOR = 65;
export const ART_STEP = 6;

// The art box is 0.72 of the art height wide.
export const ART_WIDTH_RATIO = 0.72;

// Drink limits (spec 4.5): 8 illustrated, 4 more in text, 12 visible in all.
export const MAX_ILLUSTRATED = 8;
export const MAX_MORE = 4;
export const MAX_VISIBLE = MAX_ILLUSTRATED + MAX_MORE;

const toCount = (n) => (Number.isInteger(n) && n > 0 ? n : 0);

// Row sizes for one group. 0 (or anything that is not a positive integer) is
// no rows. Past 8, which the partition never sends, rows of 4 carry on so no
// drink is dropped.
export function splitRows(n) {
  const count = toCount(n);
  if (count === 0) return [];
  if (ROW_SPLITS[count]) return [...ROW_SPLITS[count]];
  const rows = [...ROW_SPLITS[MAX_ILLUSTRATED]];
  let left = count - MAX_ILLUSTRATED;
  while (left > 0) {
    rows.push(Math.min(4, left));
    left -= 4;
  }
  return rows;
}

export function slotWidth(rowLen) {
  const len = toCount(rowLen);
  if (SLOT_WIDTHS[len]) return SLOT_WIDTHS[len];
  return len > 4 ? SLOT_WIDTHS[4] : SLOT_WIDTHS[1];
}

// With no rows (a beer-and-wine-only menu) there is no art, and the start
// value only has to be a number: the snapshot's fallback, 130.
export function artStart(totalRows) {
  const rows = toCount(totalRows);
  if (rows === 0) return ART_STARTS[ART_STARTS.length - 1];
  return ART_STARTS[Math.min(rows, ART_STARTS.length) - 1];
}

// The art box width for an art height, in whole px.
export function artWidth(artHeight) {
  return Math.round(artHeight * ART_WIDTH_RATIO);
}

// Drink art is square (spec 10.2) and html2canvas has no object-fit, so the
// image is sized as a square of the box's width and centered in its height.
export function artGeometry(il) {
  const aw = artWidth(il);
  return { aw, top: Math.round((il - aw) / 2) };
}

// One type step: 10% smaller, never below the floor, never larger (Gallery's
// 18 px names already sit under the 20 px floor and stay 18).
export function stepSize(size, floor) {
  return Math.min(size, Math.max(floor, Math.round(size * TYPE_STEP * 100) / 100));
}

// The logo (11.2, Head): 96 px tall above the title or 150 px replacing it,
// at its natural ratio once known; one wider than the page (less the badge's
// 14 px sides) is capped by width and keeps its ratio, never stretched.
export const LOGO_TALL = Object.freeze({ above_title: 96, replaces_title: 150 });
export const BADGE_PAD = Object.freeze({ x: 14, y: 10 });

export function logoSize(mode, badge, ratio) {
  const tall = LOGO_TALL[mode] || LOGO_TALL.above_title;
  if (!(ratio > 0)) return { width: undefined, height: tall };
  const maxW = PAGE_INNER_W - (badge ? 2 * BADGE_PAD.x : 0);
  const width = Math.min(maxW, Math.round(tall * ratio * 100) / 100);
  return { width, height: Math.round((width / ratio) * 100) / 100 };
}

export function chunkRows(list) {
  const items = Array.isArray(list) ? list : [];
  const out = [];
  let i = 0;
  for (const size of splitRows(items.length)) {
    out.push(items.slice(i, i + size));
    i += size;
  }
  return out;
}

const isDrink = (d) => d !== null && typeof d === 'object';

// Visible drinks only (hidden !== true), in content order. The illustrated
// ones (has_art true, the first 8) split by group: mocktails are group 'mock',
// everything else is a signature. Visible drinks without art are More from the
// bar, the first 4. Anything past those limits is `extra`: the draft PATCH
// refuses a count that rises past them, but a stored draft can still hold
// more, and the editor asks Dallas to hide them rather than the canvas
// printing them.
export function partitionDrinks(drinks) {
  const visible = (Array.isArray(drinks) ? drinks : []).filter((d) => isDrink(d) && d.hidden !== true);
  const illustrated = visible.filter((d) => d.has_art === true);
  const plain = visible.filter((d) => d.has_art !== true);
  const art = illustrated.slice(0, MAX_ILLUSTRATED);
  return {
    sig: art.filter((d) => d.group !== 'mock'),
    mock: art.filter((d) => d.group === 'mock'),
    more: plain.slice(0, MAX_MORE),
    extra: [...illustrated.slice(MAX_ILLUSTRATED), ...plain.slice(MAX_MORE)],
  };
}

// Everything the canvas needs to lay the drinks out, before the fit loop.
export function layoutDrinks(drinks) {
  const parts = partitionDrinks(drinks);
  const sigRows = chunkRows(parts.sig);
  const mockRows = chunkRows(parts.mock);
  const rows = sigRows.length + mockRows.length;
  return { ...parts, sigRows, mockRows, rows, artStart: artStart(rows) };
}
