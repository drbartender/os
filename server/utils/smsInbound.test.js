const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectOptKeyword, detectResponseCode } = require('./smsInbound');

test('detectOptKeyword > recognizes STOP and equivalents, case-insensitive', () => {
  for (const word of ['STOP', 'stop', '  Stop ', 'UNSUBSCRIBE', 'end', 'CANCEL', 'quit']) {
    assert.strictEqual(detectOptKeyword(word), 'stop', `expected stop for "${word}"`);
  }
});

test('detectOptKeyword > recognizes START and equivalents', () => {
  for (const word of ['START', 'start', ' Start', 'UNSTOP', 'yes']) {
    assert.strictEqual(detectOptKeyword(word), 'start', `expected start for "${word}"`);
  }
});

test('detectOptKeyword > returns null for non-keyword text', () => {
  assert.strictEqual(detectOptKeyword('stop by the store later'), null);
  assert.strictEqual(detectOptKeyword('thanks!'), null);
  assert.strictEqual(detectOptKeyword(''), null);
  assert.strictEqual(detectOptKeyword(null), null);
});

test('detectResponseCode > recognizes CONFIRM, case-insensitive, whole-word', () => {
  for (const word of ['CONFIRM', 'confirm', ' Confirm ']) {
    assert.strictEqual(detectResponseCode(word), 'confirm');
  }
});

test('detectResponseCode > recognizes CANT and common spellings', () => {
  for (const word of ['CANT', 'cant', "CAN'T", "can't", ' Cant']) {
    assert.strictEqual(detectResponseCode(word), 'cant');
  }
});

test('detectResponseCode > returns null for free-form text', () => {
  assert.strictEqual(detectResponseCode('I confirm I will be there'), null);
  assert.strictEqual(detectResponseCode('running late sorry'), null);
  assert.strictEqual(detectResponseCode(''), null);
  assert.strictEqual(detectResponseCode(null), null);
});
