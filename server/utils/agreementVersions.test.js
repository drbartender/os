'use strict';
// Pins the server allowlist to the client agreement module. The two are bumped
// by hand in two places; a mismatch means every sign POST from a fresh bundle
// is rejected ("Please refresh the page and try again") or records a version
// whose text the page never rendered.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const {
  LEGACY_AGREEMENT_VERSION, CURRENT_AGREEMENT_VERSION, KNOWN_AGREEMENT_VERSIONS,
} = require('./agreementVersions');

const CLIENT_MODULE = pathToFileURL(
  path.join(__dirname, '../../client/src/data/eventServicesAgreement.js')
).href;

function loadClient() {
  return import(CLIENT_MODULE);
}

test('the version a client signs today is the server CURRENT and the last KNOWN entry', async () => {
  const m = await loadClient();
  assert.equal(m.EVENT_SERVICES_AGREEMENT.version, CURRENT_AGREEMENT_VERSION);
  assert.equal(KNOWN_AGREEMENT_VERSIONS[KNOWN_AGREEMENT_VERSIONS.length - 1], CURRENT_AGREEMENT_VERSION);
});

test('every agreement text the client holds is a version the server will record', async () => {
  const m = await loadClient();
  for (const [key, entry] of Object.entries(m.AGREEMENT_VERSIONS)) {
    assert.equal(entry.version, key);
    assert.ok(KNOWN_AGREEMENT_VERSIONS.includes(key), `${key} missing from KNOWN_AGREEMENT_VERSIONS`);
  }
  assert.ok(KNOWN_AGREEMENT_VERSIONS.includes(LEGACY_AGREEMENT_VERSION), 'legacy v2 stays accepted forever');
});

test('v4 differs from v3 in Section 8.1 and nowhere else', async () => {
  const m = await loadClient();
  const v3 = m.AGREEMENT_VERSIONS['event-services-agreement-v3'].markdown;
  const v4 = m.AGREEMENT_VERSIONS['event-services-agreement-v4'].markdown;
  assert.ok(v3.includes(m.V3_SECTION_8_1), 'v3 carries the original 8.1');
  assert.ok(v4.includes(m.V4_SECTION_8_1), 'v4 carries the amended 8.1 (the swap happened)');
  assert.ok(!v4.includes(m.V3_SECTION_8_1), 'v4 no longer carries the original 8.1');
  assert.equal(v3.replace(m.V3_SECTION_8_1, ''), v4.replace(m.V4_SECTION_8_1, ''));
});

test('a signed proposal resolves to the text it was signed under; anything else to current', async () => {
  const m = await loadClient();
  assert.equal(m.agreementForVersion('event-services-agreement-v3').version, 'event-services-agreement-v3');
  assert.equal(m.agreementForVersion(CURRENT_AGREEMENT_VERSION).version, CURRENT_AGREEMENT_VERSION);
  assert.equal(m.agreementForVersion(null).version, CURRENT_AGREEMENT_VERSION);
  assert.equal(m.agreementForVersion(LEGACY_AGREEMENT_VERSION).version, CURRENT_AGREEMENT_VERSION);
});

// A SHIPPED version's text is what its signers agreed to, so it can never be
// edited in place (a typo fix included): ship a new version instead. These
// hashes are the texts as shipped. v3 was verified equal to the pre-v4 module
// in git (77ca16ec~1) when v4 was cut. Add a line here with every new version.
// v4 was re-pinned once, on 2026-09-29, BEFORE it shipped (no client bundle had
// ever sent v4): clause 8.1(b) gained "as stated in the Event-Specific
// Agreement". From its first deploy on it is frozen like v3.
const SHIPPED_SHA256 = {
  'event-services-agreement-v3': 'c2d50a91c77c6b90e0f85e3da38aa124c9a4a3ba493e1572eaf7d3724b1bf9db',
  'event-services-agreement-v4': 'c2e6b391ddbfa19e76aaf4cffb5dbd9abedb0417c2698250b7743d048b8ebf62',
};

test('every agreement version is pinned byte for byte', async () => {
  const m = await loadClient();
  assert.deepEqual(Object.keys(m.AGREEMENT_VERSIONS).sort(), Object.keys(SHIPPED_SHA256).sort(),
    'a version was added or removed without pinning it here');
  for (const [key, entry] of Object.entries(m.AGREEMENT_VERSIONS)) {
    const sha = createHash('sha256').update(entry.markdown).digest('hex');
    assert.equal(sha, SHIPPED_SHA256[key], `${key} text changed after it shipped`);
  }
});
