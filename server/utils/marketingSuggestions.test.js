const { test } = require('node:test');
const assert = require('node:assert/strict');
const { suggestTag, domainOf } = require('./marketingSuggestions');
const { isValidTag } = require('./marketingTags');

test('corporate history on a personal address still suggests corporate', () => {
  // 3 of the 9 clients who actually booked corporate work used a personal address.
  const s = suggestTag({ email: 'someone@gmail.com', corporateEventCount: 1, personalEventCount: 0 });
  assert.equal(s.tag, 'corporate');
  assert.match(s.reason, /corporate/i);
  assert.match(s.reason, /personal address/i, 'should explain why the domain did not decide it');
});

test('a company domain with only personal events suggests NOTHING', () => {
  // 19 of the 25 company-domain clients with history booked only personal events.
  assert.equal(
    suggestTag({ email: 'bride@acmecorp.com', corporateEventCount: 0, personalEventCount: 1 }),
    null
  );
});

test('a company domain with no history suggests corporate and admits it is a guess', () => {
  const s = suggestTag({ email: 'ops@acmecorp.com', corporateEventCount: 0, personalEventCount: 0 });
  assert.equal(s.tag, 'corporate');
  assert.match(s.reason, /guess/i, 'a domain-only suggestion must not sound confident');
  assert.match(s.reason, /acmecorp\.com/, 'should show the evidence it used');
});

test('free mail with no history suggests nothing', () => {
  assert.equal(
    suggestTag({ email: 'nobody@gmail.com', corporateEventCount: 0, personalEventCount: 0 }),
    null
  );
});

test('mixed history still suggests corporate, because that is the actionable fact', () => {
  const s = suggestTag({ email: 'x@gmail.com', corporateEventCount: 1, personalEventCount: 3 });
  assert.equal(s.tag, 'corporate');
});

test('guest count and venue strengthen the reason', () => {
  const s = suggestTag({
    email: 'faculty@calderwood.edu', corporateEventCount: 1, personalEventCount: 0,
    largestGuestCount: 180, venueName: 'Calderwood faculty reception',
  });
  assert.equal(s.tag, 'corporate');
  assert.match(s.reason, /180/);
  assert.match(s.reason, /Calderwood/);
});

test('handles missing or malformed input without throwing', () => {
  for (const bad of [
    { email: null }, { email: 'not-an-email' }, { email: '@nodomain.com' },
    { email: 'trailing@' }, { email: 'no-tld@localhost' }, {}, undefined,
  ]) {
    assert.doesNotThrow(() => suggestTag(bad));
    assert.equal(suggestTag(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('every suggested tag is one the API will actually accept', () => {
  // A suggestion the tag endpoint would 400 is worse than no suggestion.
  const s = suggestTag({ email: 'ops@acmecorp.com', corporateEventCount: 2, personalEventCount: 0 });
  assert.ok(isValidTag(s.tag), `${s.tag} is not in the tag vocabulary`);
});

test('no reason contains an em dash', () => {
  const s = suggestTag({
    email: 'ops@acmecorp.com', corporateEventCount: 2, personalEventCount: 0,
    largestGuestCount: 90, venueName: 'HQ',
  });
  assert.ok(!s.reason.includes('—'), 'copy rule: no em dashes');
});

test('domainOf is case and whitespace insensitive', () => {
  assert.equal(domainOf('A@Example.COM '), 'example.com');
  assert.equal(domainOf('a@b'), null, 'no dot means not a domain');
});
