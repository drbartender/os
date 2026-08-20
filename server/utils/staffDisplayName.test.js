const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeDisplayName } = require('./staffDisplayName');

// Table-driven off REAL production pairs (spec §4.1). Every row was read out of
// the production contractor_profiles / agreements join on 2026-07-26.
const CASES = [
  // [preferredName, legalFullName, expected, why]
  ['Fareed', 'Mohammad F Shafiuddin', 'Fareed S.', 'nickname unrelated to legal first name'],
  ['Teah', 'Teah Teriele', 'Teah T.', 'plain first name'],
  ['Dallas', 'Dallas Raby', 'Dallas R.', 'plain first name'],
  ['Joey', 'Joseph Key', 'Joey K.', 'NEVER renders as Joseph'],
  ['Nikki', 'Monique Lundy', 'Nikki L.', 'NEVER renders as Monique'],
  ['Tashea Coates', 'Tashea Coates', 'Tashea C.', 'typed full name, surname dropped'],
  ['Evan Williams', 'Evan Williams', 'Evan W.', 'typed full name, surname dropped'],
  ['Billie', 'Billie Jean Barrone', 'Billie B.', 'initial comes from surname, not middle name'],
  ['Billie Jean', 'Billie Jean Barrone', 'Billie Jean B.', 'two-word given name kept whole: surname-only match'],
  ['Mark Holt', 'Mark', 'Mark H.', 'single-token agreement: initial off the preferred name'],
  ['Ariel  D. Smith', 'Ariel Smith', 'Ariel S.', 'surname and middle initial both dropped'],
  ['Adelle M. Reynolds', null, 'Adelle R.', 'no legal name: initial off preferred, middle initial dropped'],
  ['veronica martinez', 'veronica martinez', 'Veronica M.', 'all-lowercase token gets capitalized'],
  ['Jasmine Jeff', 'Jasmine jeff', 'Jasmine J.', 'surname match is case-insensitive'],
  ['Zul', 'Zul', 'Zul', 'single-token everything: no initial, no invention'],
  ['Dallas', null, 'Dallas', 'no legal name and one token: bare'],
  // Empty preferred name falls back to the legal FIRST name (spec §4.1 step 4).
  // This is what keeps the event-details roster (eventDetailsPayload.js)
  // behavior-preserving and keeps an email local-part off a client-facing BEO. It is NOT the rejected legal-name fallback: there
  // is no preferred name here to displace.
  [null, 'Nevver Sayles', 'Nevver S.', 'no preferred name: legal first name plus initial'],
  ['', 'Joseph Key', 'Joseph K.', 'blank preferred name behaves the same as null'],
  [null, 'Zul', 'Zul', 'no preferred name, single-token legal'],
  [null, null, null, 'nothing at all: caller keeps its email fallback'],
];

for (const [preferredName, legalFullName, expected, why] of CASES) {
  test(`computeDisplayName: ${JSON.stringify(preferredName)} + ${JSON.stringify(legalFullName)} -> ${expected} (${why})`, () => {
    assert.equal(computeDisplayName({ preferredName, legalFullName }), expected);
  });
}

test('no arguments at all returns null rather than throwing', () => {
  assert.equal(computeDisplayName(), null);
  assert.equal(computeDisplayName({}), null);
  assert.equal(computeDisplayName({ preferredName: '   ', legalFullName: '  ' }), null);
});

// GUARD (spec §2, §7). Scoped to the preferred-name-PRESENT case, because the
// empty case falls back to the legal first name on purpose. If this fails,
// someone reintroduced legal-name displacement and Joey is about to be called
// Joseph on a roster.
test('when a preferred name exists, the legal name reaches the output only as one initial', () => {
  const out = computeDisplayName({ preferredName: 'Joey', legalFullName: 'Joseph Key' });
  assert.equal(out, 'Joey K.');
  assert.ok(!out.includes('Joseph'));
  assert.ok(!out.includes('Key'));
});

// The first draft of this helper failed exactly this case: fixCase promoted the
// connector and produced "Nicholas Or Nick D."
test('connector words are not capitalized by the lowercase repair', () => {
  assert.equal(
    computeDisplayName({ preferredName: 'Nicholas or Nick', legalFullName: 'Nicholas George DiCristina' }),
    'Nicholas or Nick D.'
  );
});

// Documented garbage-in behavior. These rows are hand-fixed by a human
// (spec §6); the helper is not expected to rescue them.
test('malformed stored values render predictably rather than being rescued', () => {
  assert.equal(computeDisplayName({ preferredName: 'TwistidTreets', legalFullName: 'Nevver Sayles' }), 'TwistidTreets S.');
  assert.equal(computeDisplayName({ preferredName: 'Miss Taylor', legalFullName: null }), 'Miss T.');
});

// The astral-plane hardening (2026-08-14) had no test until 2026-08-20. Its two
// call sites both take the FIRST character of a token, and charAt(0) on a
// character outside the BMP returns half a surrogate pair. fixCase survived that
// by accident (toUpperCase leaves a lone surrogate alone, so slice(1) put the
// pair back together); the LAST INITIAL did not, and shipped a broken glyph into
// a name people read. Pinned here so the spread cannot be "simplified" back.
test('an astral-plane initial is a whole character, never half a surrogate pair', () => {
  const out = computeDisplayName({ preferredName: 'Amy', legalFullName: 'Amy \u{1D4AE}mith' });
  assert.equal(out, 'Amy \u{1D4AE}.');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), 'no lone high surrogate');
  // And the same rule on the leading token the case repair touches.
  assert.equal(computeDisplayName({ preferredName: '\u{1D49C}my', legalFullName: '\u{1D49C}my Smith' }), '\u{1D49C}my S.');
});
