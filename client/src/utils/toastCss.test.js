import fs from 'fs';
import path from 'path';

// Pins the Inbox toast (spec 2026-10-06, amendment 24). Its House Lights
// edges (square, jewel-tone) and its phone placement under the header apply
// only while Inbox is open; every other admin page keeps today's toast. So a
// rule for the toast box or its container, past the shipped ones below, must
// be scoped to an open Inbox: :has(.ib-page) on the desktop, :has(.ib-phone)
// on the phone. The buttons inside a toast are not the box; the dismiss x has
// its own check below (the Inbox toast has none, every other page keeps it),
// and .toast-action is not checked.

const css = fs.readFileSync(path.join(__dirname, '../index.css'), 'utf8');

const SHIPPED = [
  '.toast-container', '.toast', '.toast-success', '.toast-error', '.toast-info',
  'html[data-app="admin-os"] .toast', 'html[data-app="admin-os"] .toast-success',
  'html[data-app="admin-os"] .toast-error', 'html[data-app="admin-os"] .toast-info',
];
const SHIPPED_DISMISS = [
  '.toast-dismiss', '.toast-dismiss:hover',
  'html[data-app="admin-os"] .toast .toast-dismiss', 'html[data-app="admin-os"] .toast .toast-dismiss:hover',
];
const TOAST_BOX = /^\.toast(?:-container|-success|-error|-info)?(?=$|[.:[])/;
const DISMISS = /^\.toast-dismiss(?=$|[.:[])/;
const INBOX_OPEN = /:has\(\.ib-(?:page|phone)\)/;

// Comments stripped first, and the opening of every block at-rule but
// @keyframes unwrapped, so a rule inside a media query is still a rule.
const selectorsOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/@(?!keyframes)[a-z-]+[^{;]*\{/g, '').replace(/@[a-z-]+[^{;]*;/g, '')
  .split('}').map((chunk) => chunk.split('{')[0].trim())
  .filter((s) => s && !s.startsWith('@') && !/^(from|to|\d+%)/.test(s))
  .flatMap((s) => s.split(',').map((x) => x.trim()));
const lastCompound = (selector) => selector.split(/[\s>+~]+/).pop();
const looseToastSelectors = (text) => selectorsOf(text)
  .filter((s) => TOAST_BOX.test(lastCompound(s)) && !SHIPPED.includes(s) && !INBOX_OPEN.test(s));
const looseDismissSelectors = (text) => selectorsOf(text)
  .filter((s) => DISMISS.test(lastCompound(s)) && !SHIPPED_DISMISS.includes(s) && !INBOX_OPEN.test(s));
// Each rule's selectors with its declarations, comments stripped.
const rulesOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').split('}')
  .map((chunk) => chunk.split('{'))
  .filter((pair) => pair.length >= 2)
  .map((pair) => ({ selectors: pair[pair.length - 2].split(',').map((x) => x.trim()), body: pair[pair.length - 1].trim() }));

test('past the shipped rules, every rule for the toast box or its container is scoped to an open Inbox', () => {
  expect(looseToastSelectors(css)).toEqual([]);
});

test('the Inbox toast: square House Lights edges on both shells, under the header on the phone', () => {
  expect(selectorsOf(css)).toEqual(expect.arrayContaining([
    'html[data-app="admin-os"][data-skin="light"]:has(.ib-page) .toast',
    'html[data-app="admin-os"][data-skin="light"]:has(.ib-phone) .toast',
    'html[data-app="admin-os"]:has(.ib-phone) .toast-container',
  ]));
});

test('the scope check sees an unscoped rule, inside a media query too, and skips the buttons', () => {
  expect(looseToastSelectors('html[data-app="admin-os"][data-skin="light"] .toast { border-radius: 0; }'))
    .toEqual(['html[data-app="admin-os"][data-skin="light"] .toast']);
  expect(looseToastSelectors('@media (max-width: 600px) {\n  html[data-app="admin-os"] .toast-container { top: 66px; }\n}'))
    .toEqual(['html[data-app="admin-os"] .toast-container']);
  expect(looseToastSelectors('/* note */\nhtml[data-app="admin-os"] .toast .toast-action { color: red; }')).toEqual([]);
});

// The design's toast is the message and Undo only (spec 11): while Inbox is
// open the dismiss x is hidden, by one rule under the same :has() scope as
// the other Inbox toast rules. Every other page keeps today's x: past the
// shipped rules, a rule for .toast-dismiss must be scoped to an open Inbox.
test('the Inbox toast has no dismiss x, and every other page keeps it', () => {
  const hide = rulesOf(css).filter((r) => r.selectors.some((x) => /\.toast-dismiss$/.test(x)) && /display:\s*none/.test(r.body));
  expect(hide).toHaveLength(1);
  expect(hide[0].selectors).toEqual([
    'html[data-app="admin-os"]:has(.ib-page) .toast .toast-dismiss',
    'html[data-app="admin-os"]:has(.ib-phone) .toast .toast-dismiss',
  ]);
  expect(looseDismissSelectors(css)).toEqual([]);
  expect(looseDismissSelectors('html[data-app="admin-os"][data-skin="light"] .toast .toast-dismiss { display: none; }'))
    .toEqual(['html[data-app="admin-os"][data-skin="light"] .toast .toast-dismiss']);
});

// A second rule with a shipped selector's exact text would change every
// page's toast and pass the scope check above unnoticed (it is shipped), so
// each shipped selector occurs exactly once.
test('each shipped toast selector occurs exactly once in index.css', () => {
  const all = selectorsOf(css);
  const notOnce = [...SHIPPED, ...SHIPPED_DISMISS]
    .map((sel) => [sel, all.filter((x) => x === sel).length])
    .filter(([, n]) => n !== 1);
  expect(notOnce).toEqual([]);
  const twice = selectorsOf(`${css}\nhtml[data-app="admin-os"] .toast { border-radius: 0; }`);
  expect(twice.filter((x) => x === 'html[data-app="admin-os"] .toast')).toHaveLength(2);
});
