// Allowlist of agreement-document versions the proposal sign endpoint will
// accept and record into proposals.client_signature_document_version. The
// recorded value must always be one of these, so an audit can map every
// signature to the exact text the client rendered.
//
// LEGACY_AGREEMENT_VERSION ('event-services-agreement-v2') is the hand-written
// "abridged" terms block that shipped BEFORE the full master agreement. It is
// kept in the allowlist PERMANENTLY: (a) historical rows carry it, and (b) a
// pre-feature cached client omits the new document_version field AND still
// renders that abridged v2 text, so v2 is the truthful record for those signs.
// Do NOT re-map v2 to the full agreement anywhere. Abridged-block source: see
// git history of
// client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js prior to
// the event-services-agreement integration commit.
//
// CURRENT_AGREEMENT_VERSION MUST equal the client module's version:
//   client/src/data/eventServicesAgreement.js -> EVENT_SERVICES_AGREEMENT.version.
// Bump both together when the agreement text changes, and KEEP every prior
// version in KNOWN_AGREEMENT_VERSIONS: historical rows carry it, and a client
// holding a cached pre-bump bundle still renders and sends the old version,
// which is then the truthful record of what that client saw. Current stays
// LAST (publicToken.signPhone.test.js signs with the last entry).
// agreementVersions.test.js pins the lockstep against the client module.
//
// DEPLOY ORDER: a new version must be ACCEPTED here, and live on Render, before
// the client bundle that sends it ships (Vercel usually finishes first). So a
// version lands in KNOWN one push ahead of the client bump that makes it
// CURRENT.
//
// v3 (2026-06-04): the full master agreement.
// v4 (2026-09-27): Section 8.1 only, Additional Time pricing and invoicing.
const LEGACY_AGREEMENT_VERSION = 'event-services-agreement-v2';
const CURRENT_AGREEMENT_VERSION = 'event-services-agreement-v4';
const KNOWN_AGREEMENT_VERSIONS = [
  LEGACY_AGREEMENT_VERSION,
  'event-services-agreement-v3',
  CURRENT_AGREEMENT_VERSION,
];

module.exports = {
  LEGACY_AGREEMENT_VERSION,
  CURRENT_AGREEMENT_VERSION,
  KNOWN_AGREEMENT_VERSIONS,
};
