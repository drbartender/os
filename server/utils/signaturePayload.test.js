// validateSignaturePayload (audit ESIG-06): the shape both signature writers
// accept. Pure; no database.
//
// Run: node --test server/utils/signaturePayload.test.js

require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateSignaturePayload, SIGNATURE_MAX_BYTES, TYPED_MAX } = require('./signaturePayload');

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const dataUrl = (mime, bytes) => `data:image/${mime};base64,${bytes.toString('base64')}`;

const draw = (data) => validateSignaturePayload({ data, method: 'draw' });
const typed = (data) => validateSignaturePayload({ data, method: 'type' });

test('a PNG or JPEG data URL with matching magic bytes passes and is stored as sent', () => {
  const png = `data:image/png;base64,${PNG_1X1}`;
  assert.deepEqual(draw(png), { value: png, error: null });
  const jpeg = dataUrl('jpeg', Buffer.concat([JPEG_MAGIC, crypto.randomBytes(64)]));
  assert.deepEqual(draw(jpeg), { value: jpeg, error: null });
});

test('an image at the cap passes; one byte over is refused without being accepted', () => {
  const atCap = dataUrl('png', Buffer.concat([PNG_MAGIC, crypto.randomBytes(SIGNATURE_MAX_BYTES - PNG_MAGIC.length)]));
  assert.equal(draw(atCap).error, null);
  const over = dataUrl('png', Buffer.concat([PNG_MAGIC, crypto.randomBytes(SIGNATURE_MAX_BYTES - PNG_MAGIC.length + 1)]));
  assert.match(draw(over).error, /too large/);
  assert.equal(draw(over).value, null);
  // Far over the cap: refused on the string length, never decoded.
  const huge = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`;
  assert.match(draw(huge).error, /too large/);
});

test('an SVG data URL, a declared type whose bytes are another image, and non-image strings are refused', () => {
  const svg = dataUrl('svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  assert.match(draw(svg).error, /PNG or JPEG/);
  const lying = dataUrl('png', Buffer.concat([JPEG_MAGIC, crypto.randomBytes(16)]));
  assert.match(draw(lying).error, /PNG or JPEG/);
  for (const bad of ['signed', 'javascript:alert(1)', 'data:image/png;base64,', 'data:image/png;base64,not*base64', 'data:text/html;base64,PGI+', `data:image/png;base64,${PNG_1X1}\n`]) {
    const out = draw(bad);
    assert.equal(out.value, null, bad);
    assert.ok(out.error, bad);
  }
});

test('a typed signature is a 2 to 120 character printable string, stored trimmed', () => {
  assert.deepEqual(typed('  Test Signer '), { value: 'Test Signer', error: null });
  assert.deepEqual(typed("Ana-María O'Neil, 3rd"), { value: "Ana-María O'Neil, 3rd", error: null });
  // Round 2 (L7): names carry ampersands, slashes and parentheses; the audit
  // asked for a bounded printable string, not a letters-only alphabet.
  for (const ok of ['Jane & John Doe', 'Smith/Jones', 'Name (jr)', "Dr. O'Neil-Smith, III", 'José Ñandú 3rd', 'Ngā Tāngata Trust']) {
    assert.equal(typed(ok).error, null, ok);
    assert.equal(typed(ok).value, ok, ok);
  }
  assert.equal(typed('A'.repeat(TYPED_MAX)).error, null);
  assert.match(typed('x').error, /2 to 120/);
  assert.match(typed('   ').error, /2 to 120/);
  assert.match(typed('A'.repeat(TYPED_MAX + 1)).error, /2 to 120/);
  // Control characters are never part of a name; leading and trailing
  // whitespace is trimmed away, an inner tab or newline is refused.
  for (const bad of ['Jane\u0000Doe', 'Jane\nDoe', 'Jane\tDoe', 'Jane\u001bDoe', 'Jane\u007fDoe']) {
    assert.match(typed(bad).error, /printable/, JSON.stringify(bad));
    assert.equal(typed(bad).value, null);
  }
});

test('an empty, non-string or unknown-method payload is refused', () => {
  for (const data of ['', null, undefined, 42, {}, []]) {
    assert.ok(draw(data).error, `draw ${JSON.stringify(data)}`);
    assert.ok(typed(data).error, `type ${JSON.stringify(data)}`);
  }
  assert.equal(validateSignaturePayload({ data: `data:image/png;base64,${PNG_1X1}`, method: 'other' }).error, 'Invalid signature method.');
  assert.equal(validateSignaturePayload({ data: 'Test Signer', method: undefined }).error, 'Invalid signature method.');
  assert.equal(validateSignaturePayload().error, 'Invalid signature method.');
});
