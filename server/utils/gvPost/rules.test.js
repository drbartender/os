'use strict';

// The GV post rules (spec 2026-10-17 laws 7 and 9, plan Task 3). Pure: no DB.
//   node --test server/utils/gvPost/rules.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const smsTemplates = require('../smsTemplates');
const { proposalUrl } = require('../urls');
const { RESENDABLE } = require('../comms/actions/proposalResend');
const {
  GV_BODY_MAX, GV_SENDABLE_STATUSES, normalizeGvBody, validateGvBody,
} = require('./rules');

const TOKEN = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const OTHER = 'aa11bb22-cc33-4d44-8e55-ff6677889900';
const link = (token = TOKEN) => proposalUrl(token);

// A body of exactly n characters that carries the link once.
function bodyOfLength(n) {
  const head = `Your proposal: ${link()} `;
  return head + 'x'.repeat(n - head.length);
}

test('whitespace runs and line breaks collapse to single spaces', () => {
  assert.equal(normalizeGvBody('  Hi there,\n\nyour  proposal\t is\r\nready.  '), 'Hi there, your proposal is ready.');
  assert.equal(normalizeGvBody(null), '');
  const r = validateGvBody(`Hi,\n\nhere it is:\n${link()}\n`, TOKEN);
  assert.deepEqual(r, { ok: true, body: `Hi, here it is: ${link()}` });
});

test('a 321-character body is too_long', () => {
  assert.equal(GV_BODY_MAX, 320);
  assert.deepEqual(validateGvBody(bodyOfLength(321), TOKEN), { ok: false, reason: 'too_long' });
  // The limit is on the normalized body, and 320 itself is allowed.
  assert.equal(validateGvBody(bodyOfLength(320), TOKEN).ok, true);
  assert.equal(validateGvBody(`${bodyOfLength(320)}\n\n   `, TOKEN).ok, true);
});

test('a body without the link is no_link', () => {
  assert.deepEqual(validateGvBody('Hi, Dallas here. Your proposal is ready.', TOKEN), { ok: false, reason: 'no_link' });
  // The bare token is not the link.
  assert.deepEqual(validateGvBody(`Your proposal code is ${TOKEN}.`, TOKEN), { ok: false, reason: 'no_link' });
});

test('a link with another token is wrong_link', () => {
  assert.deepEqual(validateGvBody(`Here it is: ${link(OTHER)}.`, TOKEN), { ok: false, reason: 'wrong_link' });
  // The right token on another host is not the public link either.
  assert.deepEqual(validateGvBody(`Here it is: https://example.com/proposal/${TOKEN}.`, TOKEN),
    { ok: false, reason: 'wrong_link' });
});

test('two links is multiple_links', () => {
  assert.deepEqual(validateGvBody(`First ${link()} and again ${link()}`, TOKEN), { ok: false, reason: 'multiple_links' });
  // A second proposal link on any host counts: it could be another client's.
  assert.deepEqual(validateGvBody(`Yours ${link()} not https://example.com/proposal/${OTHER}`, TOKEN),
    { ok: false, reason: 'multiple_links' });
});

test('the template body with its trailing period validates', () => {
  const body = smsTemplates.initialProposalSms({
    eventTypeLabel: 'wedding reception', eventDate: 'Saturday, June 6', link: link(),
  });
  assert.ok(body.includes(`${link()}.`), 'the template puts a period right after the link');
  assert.deepEqual(validateGvBody(body, TOKEN), { ok: true, body });
});

test('GV_SENDABLE_STATUSES matches proposalResend RESENDABLE', () => {
  assert.ok(Array.isArray(RESENDABLE), 'proposalResend must export RESENDABLE');
  assert.deepEqual([...GV_SENDABLE_STATUSES], [...RESENDABLE]);
});
