// Unit tests for the pure extractor. Synthetic body text only (no real PII, no real
// DOM). Run from this dir: `node --test src/extract.test.js`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractCustomerEmail } = require('./extract');

const PRO = 'contact@drbartender.com';

test('exactly one non-pro email -> ok', () => {
  const bodyText = `Pro: ${PRO}\nCustomer: jane.doe@gmail.com\nReply to start a quote.`;
  const r = extractCustomerEmail({ proEmail: PRO, bodyText });
  assert.equal(r.status, 'ok');
  assert.equal(r.customerEmail, 'jane.doe@gmail.com');
});

test('pro email only -> render_timeout', () => {
  const bodyText = `Logged in as ${PRO}. Loading customer details...`;
  const r = extractCustomerEmail({ proEmail: PRO, bodyText });
  assert.equal(r.status, 'render_timeout');
  assert.equal(r.customerEmail, null);
});

test('no emails at all -> render_timeout', () => {
  const r = extractCustomerEmail({ proEmail: PRO, bodyText: 'Loading...' });
  assert.equal(r.status, 'render_timeout');
});

test('two non-pro emails -> ambiguous (never guess)', () => {
  const bodyText = `${PRO} a@gmail.com b@yahoo.com`;
  const r = extractCustomerEmail({ proEmail: PRO, bodyText });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.customerEmail, null);
  assert.deepEqual(r.candidates.sort(), ['a@gmail.com', 'b@yahoo.com']);
});

test('pro email repeated, one customer -> ok (deduped)', () => {
  const bodyText = `${PRO} header ... ${PRO} footer ... carlos@hotmail.com`;
  const r = extractCustomerEmail({ proEmail: PRO, bodyText });
  assert.equal(r.status, 'ok');
  assert.equal(r.customerEmail, 'carlos@hotmail.com');
});

test('pro exclusion is case-insensitive', () => {
  const bodyText = `CONTACT@DRBARTENDER.COM and real.customer@gmail.com`;
  const r = extractCustomerEmail({ proEmail: PRO, bodyText });
  assert.equal(r.status, 'ok');
  assert.equal(r.customerEmail, 'real.customer@gmail.com');
});

test('same customer email twice -> ok (single)', () => {
  const bodyText = `${PRO} dana@gmail.com ... dana@gmail.com`;
  const r = extractCustomerEmail({ proEmail: PRO, bodyText });
  assert.equal(r.status, 'ok');
  assert.equal(r.customerEmail, 'dana@gmail.com');
});

test('missing inputs -> render_timeout, no throw', () => {
  assert.equal(extractCustomerEmail({}).status, 'render_timeout');
  assert.equal(extractCustomerEmail().status, 'render_timeout');
});
