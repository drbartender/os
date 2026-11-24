// dotenv BEFORE anything that could reach ../db (see the 2026-08-20 sweep: nine
// suites sat silently red on ECONNREFUSED for want of this line). Nothing here
// touches the database, but the rule is cheap and the failure is invisible.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VERSIONS } = require('./contractorAgreement');

// THE OTHER HALF of client/src/utils/markdownBold.test.js.
//
// Two surfaces render these frozen strings: the archived PDF (agreementPdf.js
// renderMixedBoldText) and the signing screen (client/src/utils/markdownBold.js).
// Both understand exactly one construct, `**bold**`, and both leave an unmatched
// marker literal. That is safe only while the COPY stays inside that construct,
// and the copy is the half neither renderer controls.
//
// So this asserts the data, not the renderers: every `**` in every clause of
// every version closes, and no run is empty or nested. A clause that violated it
// would print raw asterisks on a legal document at the moment of signing, which
// is the bug this pair exists to stop recurring.
const RUN = /\*\*[^*]+\*\*/g;

function clausesOf(version) {
  return (version && version.clauses) || [];
}

test('every version exposes clauses with a formal body', () => {
  const names = Object.keys(VERSIONS);
  assert.ok(names.length >= 1, 'there is at least one agreement version');
  for (const name of names) {
    const clauses = clausesOf(VERSIONS[name]);
    assert.ok(clauses.length >= 1, `${name} has clauses`);
    for (const c of clauses) {
      assert.equal(typeof c.formal, 'string', `${name} clause ${c.number} has a formal body`);
    }
  }
});

test('every ** marker in the frozen copy belongs to a closed bold run', () => {
  for (const name of Object.keys(VERSIONS)) {
    for (const c of clausesOf(VERSIONS[name])) {
      const markers = (c.formal.match(/\*\*/g) || []).length;
      const inRuns = (c.formal.match(RUN) || []).length * 2;
      assert.equal(markers, inRuns,
        `${name} clause ${c.number}: ${markers} markers but only ${inRuns} inside closed runs — `
        + 'an unmatched marker renders as a literal ** on the signing screen');
    }
  }
});

test('no bold run is empty, and none nests another', () => {
  for (const name of Object.keys(VERSIONS)) {
    for (const c of clausesOf(VERSIONS[name])) {
      for (const run of c.formal.match(RUN) || []) {
        const inner = run.slice(2, -2);
        assert.ok(inner.trim().length > 0, `${name} clause ${c.number}: empty bold run`);
        assert.ok(!inner.includes('*'), `${name} clause ${c.number}: nested marker in "${inner}"`);
      }
    }
  }
});

test('the bold runs that exist today are the two clause-6 lead-ins', () => {
  // Not a style rule, a change detector: this pair of tests is the only thing
  // standing between new copy and raw asterisks on a signed document, so a new
  // run should make someone re-read them rather than land silently.
  const found = [];
  for (const name of Object.keys(VERSIONS)) {
    for (const c of clausesOf(VERSIONS[name])) {
      for (const run of c.formal.match(RUN) || []) found.push(run.slice(2, -2));
    }
  }
  assert.deepEqual([...new Set(found)].sort(), ['From Contractor.', 'Mutual.']);
});

// A SHIPPED version's text is what its signers agreed to, so it can never be
// edited in place (a typo fix included): ship a new version instead (the
// agreementVersions.test.js precedent for the client agreement; audit
// ESIG-10). These hashes are the frozen objects as shipped, through the same
// agreementVersionSha256 the sign route stores on the row. Add a line here
// with every new version.
const { agreementVersionSha256 } = require('./contractorAgreement');
const SHIPPED_SHA256 = {
  'contractor-agreement-v2': '9b27b6666b875a83764b5eb062e7002ca5924444496623547f854e59a5fa6d11',
  'contractor-agreement-v3': '6c9dfb7b9e2e408b4b1da539577b114763e46cfa1f472522f25d5a83cc2b59bc',
};

test('every contractor agreement version is pinned byte for byte', () => {
  assert.deepEqual(Object.keys(VERSIONS).sort(), Object.keys(SHIPPED_SHA256).sort(),
    'a version was added or removed without pinning it here');
  for (const [name, version] of Object.entries(VERSIONS)) {
    assert.equal(agreementVersionSha256(version), SHIPPED_SHA256[name], `${name} text changed after it shipped`);
  }
});
