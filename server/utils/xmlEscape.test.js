const { test } = require('node:test');
const assert = require('node:assert/strict');
const { xmlEscape } = require('./xmlEscape');

test('xmlEscape: escapes &, <, and > (and only those)', () => {
  assert.equal(xmlEscape('a & b'), 'a &amp; b');
  assert.equal(xmlEscape('<Dial>'), '&lt;Dial&gt;');
  assert.equal(xmlEscape('1 < 2 > 0 & ok'), '1 &lt; 2 &gt; 0 &amp; ok');
  // Ampersand is escaped first, so mixed input stays well-formed.
  assert.equal(xmlEscape('<a href="x">'), '&lt;a href="x"&gt;');
  // Quotes and apostrophes are NOT escaped (element-text only; never attributes).
  assert.equal(xmlEscape(`he said "hi" it's fine`), `he said "hi" it's fine`);
});

test('xmlEscape: coerces non-string input via String()', () => {
  assert.equal(xmlEscape(12345), '12345');
  assert.equal(xmlEscape(null), 'null');
  assert.equal(xmlEscape(undefined), 'undefined');
});
