// Unit tests for the pure post-send verification decisions. No DOM, no
// Playwright: these are the judgments that decide whether a clicked Send
// counts as delivered, and a wrong call here is either a lost lead (false
// "failed") or a phantom "sent" (worse). Run: `node --test src/sendVerify.test.js`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { snippetPattern, urlOnThread, provenDelivered } = require('./sendVerify');

// ─── snippetPattern ──────────────────────────────────────────────────────────

test('anchors on the first 8 words, not the whole template', () => {
  const re = snippetPattern('one two three four five six seven eight nine ten');
  assert.equal(re.source.split('\\s+').length, 8);
  assert.ok(re.test('one two three four five six seven eight nine ten'));
});

test('a template shorter than 8 words still yields a usable pattern', () => {
  const re = snippetPattern('Thanks for reaching out!');
  assert.ok(re.test('Thanks for reaching out!'));
});

test('regex metacharacters in the template are escaped, never interpreted', () => {
  // A real quick reply is full of these. Unescaped, "(and" opens a group and
  // the whole verification throws or silently matches the wrong thing.
  const re = snippetPattern('Hi! We charge $175/hr (2hr min) + travel.');
  assert.ok(re.test('Hi! We charge $175/hr (2hr min) + travel.'));
  assert.ok(!re.test('Hi! We charge 175hr 2hr min  travel.'));
});

test('matches across the whitespace the DOM actually renders', () => {
  // The composer holds one line; the thread bubble may wrap or re-break it.
  const re = snippetPattern('Thanks so much for reaching out about your event');
  assert.ok(re.test('Thanks so much\n  for reaching out\tabout your event'));
});

test('matching ignores case', () => {
  const re = snippetPattern('Thanks so much for reaching out');
  assert.ok(re.test('THANKS SO MUCH FOR REACHING OUT'));
});

// ─── urlOnThread ─────────────────────────────────────────────────────────────

const NEG = '588625260853018630';

test('the lead thread URL is on the thread', () => {
  assert.equal(urlOnThread(`https://www.thumbtack.com/pro-leads/${NEG}`, NEG), true);
});

test('a percent-encoded id still counts as on the thread', () => {
  assert.equal(urlOnThread(`https://www.thumbtack.com/x?id=${encodeURIComponent(NEG)}`, NEG), true);
});

test('the leads LIST is not the thread (this is the 2026-08-22 regression)', () => {
  // TT navigates here the moment Send is clicked. Reading this as "still on
  // the thread" is what burned 12s and false-failed six real deliveries.
  assert.equal(urlOnThread('https://www.thumbtack.com/pro-leads', NEG), false);
});

test('a missing or unreadable URL is not the thread', () => {
  for (const bad of [null, undefined, '']) {
    assert.equal(urlOnThread(bad, NEG), false, `url=${bad}`);
  }
});

// ─── provenDelivered ─────────────────────────────────────────────────────────

const RE = snippetPattern('Thanks so much for reaching out about your event');
const TEXT = 'Thanks so much for reaching out about your event';

test('text visible on the reloaded thread with an empty composer is delivered', () => {
  assert.equal(provenDelivered({ snippetVisible: true, editorTexts: [''], snippetRe: RE }), true);
});

test('text visible with NO readable editor is still delivered', () => {
  // The whole 8/22 break was requiring the composer to exist. getByText does
  // not match a textarea's value (verified against Playwright's elementText),
  // so a value-property draft cannot be the visible match.
  assert.equal(provenDelivered({ snippetVisible: true, editorTexts: [null], snippetRe: RE }), true);
  assert.equal(provenDelivered({ snippetVisible: true, editorTexts: [], snippetRe: RE }), true);
  assert.equal(provenDelivered({ snippetVisible: true, snippetRe: RE }), true);
});

test('text visible while the editors hold unrelated text is delivered', () => {
  assert.equal(provenDelivered({ snippetVisible: true, editorTexts: ['a half-typed note'], snippetRe: RE }), true);
});

test('PHANTOM GUARD: the only match being the composer draft is NOT delivered', () => {
  // If TT ever restores our unsent template into the composer, the text is on
  // the page and nothing was sent. Never call that delivered.
  assert.equal(provenDelivered({ snippetVisible: true, editorTexts: [TEXT], snippetRe: RE }), false);
});

test('PHANTOM GUARD: a contenteditable draft blocks the proof even when the composer is unreadable', () => {
  // The value-property argument above only holds while the composer stays a
  // textarea. If TT re-skins it as contenteditable, the draft IS getByText
  // -visible and inputValue() throws, so the composer reads null. Scanning
  // every editor on the page is what keeps that from manufacturing a "sent".
  assert.equal(provenDelivered({ snippetVisible: true, editorTexts: [null, TEXT], snippetRe: RE }), false);
});

test('a malformed editor read is treated as no editors, never as a throw', () => {
  // editorTexts comes back from page.evaluate; if it ever returns a non-array,
  // .some would throw INSIDE the verify and the whole reply would be reported
  // failed. Degrade to "nothing to block on" instead.
  for (const junk of [null, undefined, 'not-an-array', 42, {}]) {
    assert.equal(provenDelivered({ snippetVisible: true, editorTexts: junk, snippetRe: RE }), true,
      `editorTexts=${JSON.stringify(junk)}`);
  }
});

test('no visible text is never delivered, whatever the editors say', () => {
  for (const editorTexts of [[''], [null], ['anything'], []]) {
    assert.equal(provenDelivered({ snippetVisible: false, editorTexts, snippetRe: RE }), false,
      `editorTexts=${JSON.stringify(editorTexts)}`);
  }
});
