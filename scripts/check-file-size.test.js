'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inScope, countLines, classify, bucket } = require('./check-file-size');

// ── countLines ──
test('countLines counts newline characters like wc -l', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('one line, no trailing newline'), 0);
  assert.equal(countLines('a\nb'), 1);
  assert.equal(countLines('a\nb\n'), 2);
  assert.equal(countLines('a\r\nb\r\n'), 2); // CRLF: the \n still counts
  assert.equal(countLines('\n\n\n'), 3);
});

// ── inScope ──
test('inScope matches server/ and client/src/ js + jsx', () => {
  assert.equal(inScope('server/routes/stripe.js'), true);
  assert.equal(inScope('client/src/pages/Foo.jsx'), true);
  assert.equal(inScope('client/src/App.js'), true);
});

test('inScope rejects test files, other dirs, and non-js', () => {
  assert.equal(inScope('server/routes/stripe.test.js'), false);
  assert.equal(inScope('server/routes/crud.test.jsx'), false);
  assert.equal(inScope('scripts/check-file-size.js'), false);
  assert.equal(inScope('server/db/schema.sql'), false);
  assert.equal(inScope('client/public/index.html'), false);
  assert.equal(inScope('docs/foo.js'), false);
  assert.equal(inScope('server\\routes\\stripe.js'), false); // backslash paths never match; callers pass forward slashes
});

// ── classify (the ratchet decision) ──
test('classify fails an over-cap file that grows', () => {
  assert.equal(classify(1001, 1000), 'fail');
  assert.equal(classify(1736, 1735), 'fail');
});

test('classify allows an over-cap file that is flat or shrinking', () => {
  assert.equal(classify(1736, 1736), 'note'); // flat
  assert.equal(classify(1734, 1736), 'note'); // shrinking
});

test('classify fails a brand-new file born over the cap (old = 0)', () => {
  assert.equal(classify(1100, 0), 'fail');
});

test('classify warns in the soft-cap zone regardless of direction', () => {
  assert.equal(classify(800, 0), 'warn');
  assert.equal(classify(800, 750), 'warn');
  assert.equal(classify(1000, 999), 'warn'); // exactly 1000 is NOT over the hard cap
});

test('classify is silent under the soft cap', () => {
  assert.equal(classify(699, 0), 'ok');
  assert.equal(classify(700, 0), 'ok'); // exactly 700 is NOT over the soft cap
});

// ── bucket (the --all report) ──
test('bucket sorts a snapshot count into red / yellow / green', () => {
  assert.equal(bucket(1736), 'red');
  assert.equal(bucket(1001), 'red');
  assert.equal(bucket(1000), 'yellow');
  assert.equal(bucket(701), 'yellow');
  assert.equal(bucket(700), 'green');
  assert.equal(bucket(120), 'green');
});
