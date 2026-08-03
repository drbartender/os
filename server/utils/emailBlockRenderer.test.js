'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { renderBlocksToHtml, blocksToText, absolutize } = require('./emailBlockRenderer');

test('renderBlocksToHtml returns empty string for non-array / empty input', () => {
  assert.strictEqual(renderBlocksToHtml(null), '');
  assert.strictEqual(renderBlocksToHtml(undefined), '');
  assert.strictEqual(renderBlocksToHtml([]), '');
});

test('heading block renders escaped text at the requested level', () => {
  const html = renderBlocksToHtml([{ type: 'heading', props: { text: 'Hello <b>& welcome</b>', level: 'h1', align: 'center' } }]);
  assert.match(html, /<h1[^>]*text-align:center/);
  assert.match(html, /Hello &lt;b&gt;/); // escaped, no raw tags injected
  assert.doesNotMatch(html, /<b>/);
});

test('unknown block types are skipped, valid ones still render', () => {
  const html = renderBlocksToHtml([
    { type: 'nope', props: {} },
    { type: 'heading', props: { text: 'Kept' } },
  ]);
  assert.match(html, /Kept/);
});

test('image block absolutizes root-relative src against baseUrl', () => {
  const html = renderBlocksToHtml(
    [{ type: 'image', props: { src: '/api/blog/images/x.jpg', alt: 'X' } }],
    { baseUrl: 'https://api.example.com' }
  );
  assert.match(html, /src="https:\/\/api\.example\.com\/api\/blog\/images\/x\.jpg"/);
});

test('image block leaves absolute src untouched and wraps in link when href present', () => {
  const html = renderBlocksToHtml(
    [{ type: 'image', props: { src: 'https://cdn.example.com/x.jpg', href: 'https://drbartender.com' } }],
    { baseUrl: 'https://api.example.com' }
  );
  assert.match(html, /src="https:\/\/cdn\.example\.com\/x\.jpg"/);
  assert.match(html, /<a href="https:\/\/drbartender\.com"/);
});

test('button block uses defaults and only allows hex colors', () => {
  const html = renderBlocksToHtml([{ type: 'button', props: { label: 'Book now', href: 'https://x.com', bg: 'javascript:alert(1)' } }]);
  assert.match(html, /Book now/);
  assert.match(html, /href="https:\/\/x\.com"/);
  // malicious bg rejected -> falls back to brand primary
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /#3b2314/);
});

test('spacer clamps height into a sane range', () => {
  assert.match(renderBlocksToHtml([{ type: 'spacer', props: { height: 9999 } }]), /height:120px/);
  assert.match(renderBlocksToHtml([{ type: 'spacer', props: { height: 1 } }]), /height:4px/);
});

test('hero renders image, heading, subtext, and button', () => {
  const html = renderBlocksToHtml(
    [{ type: 'hero', props: { src: '/img/h.jpg', heading: 'Summer', subtext: 'is here', buttonLabel: 'Shop', buttonHref: 'https://x.com' } }],
    { baseUrl: 'https://api.example.com' }
  );
  assert.match(html, /https:\/\/api\.example\.com\/img\/h\.jpg/);
  assert.match(html, /Summer/);
  assert.match(html, /is here/);
  assert.match(html, /Shop/);
});

test('columns renders both sides side by side', () => {
  const html = renderBlocksToHtml([{ type: 'columns', props: { left: { html: '<p>L</p>' }, right: { html: '<p>R</p>' } } }]);
  assert.match(html, /width="50%"/);
  assert.match(html, />L</);
  assert.match(html, />R</);
});

test('blocksToText produces a readable plain-text fallback', () => {
  const text = blocksToText([
    { type: 'heading', props: { text: 'Big News' } },
    { type: 'text', props: { html: '<p>Hello <strong>friend</strong></p>' } },
    { type: 'button', props: { label: 'Read more', href: 'https://x.com' } },
  ]);
  assert.match(text, /Big News/);
  assert.match(text, /Hello friend/);
  assert.match(text, /Read more: https:\/\/x\.com/);
});

test('absolutize leaves mailto/anchor and empty values alone', () => {
  assert.strictEqual(absolutize('', 'https://x.com'), '');
  assert.strictEqual(absolutize('mailto:a@b.com', 'https://x.com'), 'mailto:a@b.com');
  assert.strictEqual(absolutize('/p', 'https://x.com/'), 'https://x.com/p');
});

test('javascript: URLs are rejected at the renderer, not just downstream', () => {
  const html = renderBlocksToHtml([
    { type: 'button', props: { label: 'x', href: 'javascript:alert(1)' } },
    { type: 'image', props: { src: 'javascript:alert(2)' } },
    { type: 'hero', props: { src: 'JAVASCRIPT:alert(3)', heading: 'h' } },
  ], { baseUrl: 'https://api.example.com' });
  assert.doesNotMatch(html, /javascript:/i);
});

test('font stack never carries double quotes into style attributes', () => {
  const html = renderBlocksToHtml([{ type: 'heading', props: { text: 'T', level: 'h1', align: 'center' } }]);
  const style = /style="([^"]*)"/.exec(html)[1];
  assert.match(style, /font-size:28px/);
  assert.match(style, /text-align:center/);
});
