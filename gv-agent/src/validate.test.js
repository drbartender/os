// Box-side job validation (spec law 9). Pure: no browser, no network.
// Run: `node --test src/validate.test.js`. Numbers are invented 555-01xx.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateJob, proposalToken, validPhone, priorBodies, normalizeText } = require('./validate');

const TOKEN = '0f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f';
const LINK = `https://drbartender.com/proposal/${TOKEN}`;
// The template's shape, trailing period included.
const BODY = `Hi, this is Dr. Bartender. Here's the link to your proposal, in case the email didn't come through: ${LINK}.`;
const job = (over = {}) => ({ id: 41, phone: '+13125550123', body: BODY, negotiation_id: '500000000000000123', ...over });
const INVALID_BODY = { ok: false, reason: 'invalid_body' };

test('a 10-digit E.164 number passes and a short form fails', () => {
  assert.deepEqual(validateJob(job()), { ok: true });
  assert.equal(validPhone('+13125550123'), true);
  // Too long is 13 digits after the +1, and the international one is a full-length
  // E.164: a digit run that long is never read as a phone number.
  for (const phone of ['3125550123', '13125550123', '+1312555012', '+13125550123456', '(312) 555-0123',
    '+1 312 555 0123', '+443125550123456', '', null, undefined, 13125550123]) {
    assert.deepEqual(validateJob(job({ phone })), { ok: false, reason: 'invalid_number' }, `phone=${phone}`);
    assert.equal(validPhone(phone), false, `phone=${phone}`);
  }
});

test('a two-link body is invalid_body', () => {
  const other = 'https://drbartender.com/proposal/11111111-2222-4333-8444-555555555555';
  assert.deepEqual(validateJob(job({ body: `${BODY} Or this one: ${other}` })), INVALID_BODY);
  // The same link twice is still two links.
  assert.deepEqual(validateJob(job({ body: `${BODY} ${LINK}` })), INVALID_BODY);
  // A second proposal path counts even without the scheme or on another host.
  assert.deepEqual(validateJob(job({ body: `${BODY} www.drbartender.com/proposal/${TOKEN}` })), INVALID_BODY);
  assert.equal(proposalToken(`${BODY} ${LINK}`), null);
});

test('a body with a line break is invalid_body', () => {
  // Enter sends in GV; the server collapses whitespace at enqueue, so a break here is contract drift.
  for (const br of ['\n', '\r\n', '\r', '\u{2028}', '\u{2029}']) {
    assert.deepEqual(validateJob(job({ body: `Hi there.${br}${LINK}.` })), INVALID_BODY, `break=${JSON.stringify(br)}`);
  }
});

test('the link must be the one canonical proposal link, inside 320 characters', () => {
  assert.equal(proposalToken(BODY), TOKEN);
  for (const body of [
    'Hi, your proposal is ready.',
    `See https://drbartender.com.evil.example/proposal/${TOKEN}`,
    `See http://drbartender.com/proposal/${TOKEN}`,
    `See https://drbartender.com/proposal/${TOKEN}0`,
    'See https://drbartender.com/proposal/not-a-uuid',
    '',
    null,
  ]) {
    assert.deepEqual(validateJob(job({ body })), INVALID_BODY, `body=${body}`);
    assert.equal(proposalToken(body), null, `body=${body}`);
  }
  const padTo = (n) => `${BODY} ${'x'.repeat(n - BODY.length - 1)}`;
  assert.equal(padTo(320).length, 320);
  assert.deepEqual(validateJob(job({ body: padTo(320) })), { ok: true });
  assert.deepEqual(validateJob(job({ body: padTo(321) })), INVALID_BODY);
});

test('a job without a usable negotiation id is identity_mismatch', () => {
  // The wrong_thread check compares against it; a missing one would skip that check silently.
  for (const negotiation_id of ['', null, undefined, '12/../34', 'a b', 'x'.repeat(101)]) {
    assert.deepEqual(validateJob(job({ negotiation_id })), { ok: false, reason: 'identity_mismatch' },
      `negotiation_id=${negotiation_id}`);
  }
});

test('priorBodies reads a malformed list as empty and bounds and normalizes a good one', () => {
  for (const raw of [undefined, null, '', BODY, 3, {}, { 0: BODY }, [BODY, null], [BODY, 7], [[BODY]], [BODY, { body: BODY }]]) {
    assert.deepEqual(priorBodies(raw), [], `raw=${JSON.stringify(raw)}`);
  }
  assert.deepEqual(priorBodies([]), []);
  assert.deepEqual(priorBodies([` ${BODY}\n`, 'two  words']), [BODY, 'two words']);
  // Repeats are kept: each is one earlier post.
  assert.deepEqual(priorBodies([BODY, BODY]), [BODY, BODY]);
  // At most 10, the newest (first) ones.
  const many = Array.from({ length: 14 }, (_, i) => `post ${i}`);
  assert.deepEqual(priorBodies(many), many.slice(0, 10));
  assert.equal(normalizeText('  a \t b\n\nc  '), 'a b c');
  assert.equal(normalizeText(null), '');
});

test('a job with or without prior_bodies validates the same', () => {
  assert.deepEqual(validateJob(job({ prior_bodies: [BODY] })), { ok: true });
  assert.deepEqual(validateJob(job({ prior_bodies: 'junk' })), { ok: true });
});
