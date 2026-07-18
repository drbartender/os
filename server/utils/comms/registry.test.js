'use strict';

// Pure structural tests: registry auto-discovery + action contract. No DB.
const test = require('node:test');
const assert = require('node:assert');

const { getAction, listActionKeys } = require('./registry');

test('registry auto-discovers shopping_list_approve', () => {
  assert.ok(listActionKeys().includes('shopping_list_approve'));
});

test('unknown key returns null', () => {
  assert.strictEqual(getAction('nope_not_real'), null);
});

test('shopping_list_approve satisfies the action contract', () => {
  const a = getAction('shopping_list_approve');
  assert.strictEqual(a.key, 'shopping_list_approve');
  assert.strictEqual(a.messageType, 'shopping_list_ready');
  assert.deepStrictEqual(a.defaultChannels, { email: true, sms: false });
  for (const fn of ['resolveRecipient', 'buildMessages', 'ensureSideEffects', 'dispatch']) {
    assert.strictEqual(typeof a[fn], 'function', `${fn} must be a function`);
  }
});

test('renderPartsEmail escapes edited prose and keeps the CTA fixed', () => {
  const { renderPartsEmail } = require('./render');
  const out = renderPartsEmail({
    subject: 'S',
    heading: 'H & Co',
    bodyText: 'Hi <b>there</b>,\n\nSecond & final paragraph.',
    cta: { label: 'View list', url: 'https://example.com/x' },
  });
  assert.ok(!out.html.includes('<b>there</b>'), 'edited prose must be escaped');
  assert.ok(out.html.includes('&lt;b&gt;there&lt;/b&gt;'));
  assert.ok(out.html.includes('H &amp; Co'));
  assert.ok(out.html.includes('https://example.com/x'));
  assert.ok(out.text.includes('View list: https://example.com/x'));
});
