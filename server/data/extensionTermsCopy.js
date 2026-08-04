'use strict';

/**
 * Versioned client-facing terms for an on-site service extension.
 *
 * Stored as data, and looked up by the version recorded on the
 * service_extensions row, so the audit trail can always reproduce exactly
 * what the client agreed to. getExtensionTerms THROWS on an unknown version
 * rather than returning a default: recording "they accepted v3" while showing
 * v1's text would make the artifact a lie. smsConsentCopy refuses with null;
 * throwing here is a deliberate strengthening of that precedent.
 *
 * Copy rule: no em dashes.
 */

const CURRENT_EXTENSION_TERMS_VERSION = '2026-07-26.1';

const VERSIONS = Object.freeze({
  '2026-07-26.1': Object.freeze({
    headline: 'Extend bar service to {{END}}',
    body: Object.freeze([
      'Additional bar service under your existing agreement. Same team, same terms, same $2 million liquor liability coverage.',
      'That coverage applies to service booked through Dr. Bartender. Our bartenders cannot accept payment directly for additional service time, and any arrangement made privately with a bartender is not insured.',
    ]),
  }),
});

function getExtensionTerms(version) {
  // Own-property guard, matching the smsConsentCopy precedent: a bare index
  // walks the prototype chain, so 'constructor' and friends resolve truthy
  // and would sail past the miss check instead of throwing.
  const entry = Object.prototype.hasOwnProperty.call(VERSIONS, version)
    ? // eslint-disable-next-line security/detect-object-injection
      VERSIONS[version]
    : null;
  if (!entry) {
    throw new Error(`getExtensionTerms: unknown terms version '${version}'`);
  }
  return { version, headline: entry.headline, body: entry.body };
}

function renderExtensionTerms({ version, newEndDisplay }) {
  const terms = getExtensionTerms(version);
  return {
    version: terms.version,
    headline: terms.headline.replace('{{END}}', newEndDisplay || 'the new end time'),
    paragraphs: [...terms.body],
  };
}

module.exports = {
  CURRENT_EXTENSION_TERMS_VERSION,
  getExtensionTerms,
  renderExtensionTerms,
  VERSIONS,
};
