// What may reach a log line (spec law 11; review fix 4). Pure.
// Run: `node --test src/scrub.test.js`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scrub, last4, errText } = require('./scrub');

const TOKEN = '0f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f';

test('scrub masks a proposal token, in either case', () => {
  assert.equal(scrub(`opened https://drbartender.com/proposal/${TOKEN} ok`),
    'opened https://drbartender.com/proposal/<token> ok');
  assert.equal(scrub(TOKEN.toUpperCase()), '<token>');
  // A token of all digits (a version 4 shape) is still a token, not a phone number.
  assert.equal(scrub('12345678-1234-4234-8234-123456789012'), '<token>');
  assert.equal(scrub(`a ${TOKEN} and b ${TOKEN}`), 'a <token> and b <token>');
});

test('scrub drops a Playwright call log, which quotes the filled body', () => {
  const err = [
    'locator.fill: Timeout 8000ms exceeded.',
    'Call log:',
    '  - waiting for locator(\'textarea[placeholder="Type a message"]\').first()',
    `  -   fill("Your proposal: https://drbartender.com/proposal/${TOKEN}")`,
    '',
  ].join('\n');
  assert.equal(scrub(err), 'locator.fill: Timeout 8000ms exceeded.');
  // Mid-line, as the loop logs it: everything from the marker on goes.
  assert.equal(scrub(`job 41: threw before the journal (${err})`),
    'job 41: threw before the journal (locator.fill: Timeout 8000ms exceeded.');
  const scrubbed = scrub(err);
  assert.equal(scrubbed.includes('fill('), false);
  assert.equal(scrubbed.includes('proposal'), false);
});

test('scrub still masks phone-shaped digit runs and keeps short numbers', () => {
  assert.equal(scrub('to +1 (312) 555-0123 now'), 'to # now');
  assert.equal(scrub('https://voice.google.com/u/0/messages?itemId=t.%2B13125550123'),
    'https://voice.google.com/u/0/messages?itemId=t.%2B#');
  assert.equal(scrub('job 41: leased (number ending 0123)'), 'job 41: leased (number ending 0123)');
  assert.equal(scrub(null), '');
  assert.equal(scrub(undefined), '');
  assert.equal(last4('+13125550123'), '0123');
  assert.equal(last4(null), '????');
  assert.equal(errText(new Error('boom')), 'boom');
  assert.equal(errText('plain'), 'plain');
});
