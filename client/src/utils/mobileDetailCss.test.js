import '@testing-library/jest-dom';
import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
const START = '/* ---- Mobile admin: event detail and assignment sheet';
const END = '/* ---- end: event detail and assignment sheet ---- */';
const block = css.slice(css.indexOf(START), css.indexOf(END));

const VOCABULARY = [
  'm-header-detail', 'm-dhead', 'm-dhead-line', 'm-dhead-title', 'm-dhead-kind', 'm-dhead-guests', 'm-dhead-venue',
  'm-dhead-vname', 'm-dhead-addr', 'm-dhead-street', 'm-dhead-town', 'm-dhead-town-after',
  'm-detail-when', 'm-detail-whenline', 'm-detail-setup',
  'm-section', 'm-section-row', 'm-section-name', 'm-section-sum', 'm-section-num', 'm-section-caret',
  'm-section-caret-open', 'm-section-label', 'm-section-note', 'm-section-item',
  'm-contact', 'm-contact-name', 'm-contact-line', 'm-contact-link', 'm-contact-plain', 'm-contact-act',
  'm-shift-head', 'm-shift-label',
  'm-money-row', 'm-money-main', 'm-money-label', 'm-money-sub', 'm-money-amt', 'm-money-total', 'm-money-bal',
  'm-money-flight', 'm-money-paid', 'm-money-pay', 'm-edit-note', 'm-edit-note-locked',
  'm-sheet-row', 'm-person', 'm-avatar', 'm-avatar-app', 'm-person-main', 'm-person-name', 'm-person-meta',
  'm-person-check', 'm-person-go', 'm-person-go-off', 'm-assign-row',
  'm-sheet-scrim', 'm-sheet', 'm-sheet-handle', 'm-sheet-head', 'm-sheet-title', 'm-sheet-kind', 'm-sheet-when',
  'm-pills', 'm-pill', 'm-pill-filled', 'm-pill-pending', 'm-pill-count', 'm-sheet-mix', 'm-sheet-venue',
  'm-sheet-body', 'm-sheet-sec', 'm-sheet-sec-line', 'm-sheet-item', 'm-sheet-note', 'm-sheet-note-dot',
  'm-sheet-note-text', 'm-acts', 'm-act', 'm-act-primary', 'm-act-quiet', 'm-act-danger', 'm-act-confirm',
  'm-confirm', 'm-confirm-copy', 'm-confirm-btns', 'm-fail', 'm-fail-who', 'm-fail-msg', 'm-fail-retry',
  'm-role-label', 'm-role-name', 'm-role-open', 'm-sheet-searchwrap', 'm-sheet-search', 'm-sheet-nomatch',
  'm-sheet-state', 'm-saving', 'm-fail-quiet', 'm-sheet-busy',
];

test('the block exists, between the Events list rules and the Staff hub block', () => {
  expect(css.indexOf(START)).toBeGreaterThan(css.lastIndexOf('.m-empty.ok'));
  expect(css.indexOf(END)).toBeGreaterThan(css.indexOf(START));
  expect(css.indexOf('Staff hub chrome')).toBeGreaterThan(css.indexOf(END));
});

test.each(VOCABULARY)('.%s has a rule', (name) => {
  expect(block).toMatch(new RegExp(`\\.${name}(?![a-z0-9-])`));
});

// Comments are stripped FIRST, and the opening of every block at-rule but
// @keyframes is unwrapped: a rule that follows a comment, or sits inside a
// media or supports query, is still a rule.
const looseSelectors = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/@(?!keyframes)[a-z-]+[^{;]*\{/g, '').replace(/@[a-z-]+[^{;]*;/g, '')
  .split('}').map((chunk) => chunk.split('{')[0].trim())
  .filter((s) => s && !s.startsWith('@') && !/^(from|to|\d+%)/.test(s))
  .flatMap((s) => s.split(',').map((x) => x.trim()))
  .filter((s) => s && !s.startsWith('html[data-app="admin-os"]'));

test('every rule is scoped to the admin app', () => {
  expect(looseSelectors(block)).toEqual([]);
});

test('the scope check sees a rule that follows a comment, and one inside a media query', () => {
  expect(looseSelectors('/* Accordion sections */\n.m-leak { color: red; }')).toEqual(['.m-leak']);
  expect(looseSelectors('@media (prefers-reduced-motion: reduce) {\n  .m-leak-two { animation: none; }\n}')).toEqual(['.m-leak-two']);
  expect(looseSelectors('html[data-app="admin-os"] .m-fine,\n.m-leak-three { color: red; }')).toEqual(['.m-leak-three']);
  expect(looseSelectors('@supports (-webkit-touch-callout: none) {\n  .m-leak-four { font-size: 16px; }\n}')).toEqual(['.m-leak-four']);
  expect(looseSelectors('@import url(x.css);\n.m-leak-five { color: red; }')).toEqual(['.m-leak-five']);
});

test('no bare modifier: a compound class selector pairs m-* only with m-*', () => {
  const compounds = block.match(/\.m-[a-z0-9-]+\.[a-z][a-z0-9-]*/g) || [];
  expect(compounds.filter((c) => !/^\.m-[a-z0-9-]+\.m-[a-z0-9-]+$/.test(c))).toEqual([]);
});

test('red is a literal in the dark skin: no computed danger colour in this block', () => {
  expect(block).not.toMatch(/--danger-h/);
  expect(block).toMatch(/#ff4d4d/);
  expect(block).toMatch(/\[data-skin="light"\][^{]*\.m-act-danger[^{]*\{[^}]*--ms-bordeaux/);
});

test('no width media query and no dash glyph', () => {
  const queries = block.match(/@media[^{]*/g) || [];
  expect(queries.filter((q) => /width/.test(q))).toEqual([]);
  expect(block.includes(String.fromCharCode(0x2014))).toBe(false);
});

test('motion is switched off for a reader who asked for less of it', () => {
  expect(block).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.m-sheet,[^@]*\.m-sheet-scrim \{ animation: none; \}[^@]*\.m-section-caret \{ transition: none; \}/);
});

test('the venue link is 44px tall and hangs no more than 9px below its text', () => {
  const rule = (block.match(/\.m-dhead-venue \{[^}]*\}/) || [''])[0];
  const pad = rule.match(/padding: (\d+)px 0 (\d+)px;/);
  const line = rule.match(/line-height: (\d+)px/);
  expect(Number(pad[1]) + Number(line[1]) + Number(pad[2])).toBe(44);
  expect(Number(pad[2])).toBeLessThanOrEqual(9);
  expect(rule).toMatch(new RegExp(`margin: -${pad[1]}px 0 -${pad[2]}px;`));
});

test('the header venue wraps and is never clipped to one line', () => {
  const rules = block.match(/\.m-dhead-venue[^{]*\{[^}]*\}/g) || [];
  expect(rules.length).toBeGreaterThan(1);
  rules.forEach((rule) => expect(rule).not.toMatch(/nowrap|ellipsis|overflow: hidden/));
});

test('the town\'s comma sits exactly one gap before it, in both skins, and is clipped when the town wraps', () => {
  expect(block).toMatch(/\.m-dhead-addr \{[^}]*--addr-gap: 2ch;[^}]*flex-wrap: wrap;[^}]*column-gap: var\(--addr-gap\);[^}]*overflow: hidden;/);
  expect(block).toMatch(/\[data-skin="light"\] \.m-dhead-addr \{ --addr-gap: [\d.]+em; \}/);
  expect(block).toMatch(/\.m-dhead-town-after::before \{ content: ','; position: absolute; left: calc\(-1 \* var\(--addr-gap\)\); \}/);
  expect(block).toMatch(/\.m-dhead-town-after \{ position: relative; \}/);
});

test('full-width rows draw their focus ring inside themselves', () => {
  expect(block).toMatch(/\.m-section-row:focus-visible,[^{]*\.m-section-item:focus-visible,[^{]*\.m-sheet-row:focus-visible \{ outline-offset: -2px; \}/);
});

test('only the person row loses its top line inside a sheet item: role rows keep theirs', () => {
  expect(block).toMatch(/\.m-sheet-item > \.m-sheet-row\.m-person \{ border-top: none; \}/);
  expect(block).not.toMatch(/\.m-sheet-item > \.m-sheet-row \{/);
});

test('the meta line wraps, and the row insets are in px', () => {
  const meta = (block.match(/\.m-person-meta \{[^}]*\}/) || [''])[0];
  expect(meta).not.toMatch(/nowrap|ellipsis/);
  expect(block).not.toMatch(/padding: 0 1rem|gap: 0\.75rem/);
});

test('the sheet sits above the chrome and below the lock', () => {
  const z = (name) => Number((block.match(new RegExp(`\\.${name} \\{[^}]*z-index: (\\d+)`)) || [])[1]);
  expect(z('m-sheet-scrim')).toBe(900);
  expect(z('m-sheet')).toBe(901);
  expect(css).toMatch(/\.m-lock \{[^}]*z-index: 10000/);
});

test('House Lights sections keep the border and the flat surface the More list has', () => {
  expect(block).toMatch(/\[data-skin="light"\] \.m-section \{[^}]*border-color: var\(--line-2\);[^}]*box-shadow: none;/);
});

test('the h3 type token is defined beside the other two', () => {
  expect(css).toMatch(/html\[data-app="admin-os"\] \{[^}]*--fs-body: 13px;[^}]*--fs-meta: 11\.5px;[^}]*--fs-h3: 13px;/);
});
