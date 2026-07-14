/**
 * Pricing snapshot version stamp + tolerant reader.
 *
 * The pricing_snapshot JSONB is written by pricingEngine.calculateProposal and
 * read by several back-of-house consumers (eventCreation, payrollAccrual,
 * invoiceExtras, changeRequests, preEventHandlers, setupTime). Before the stamp,
 * a key rename in the engine would silently break every reader at runtime.
 *
 * Contract (audit F-PS, DECIDED: tolerate-and-tag, NO prod backfill):
 *  - A snapshot WITHOUT `_version` is legacy → treated as v1 and proceeds. Its
 *    shape is tagged to Sentry ONCE per process per context for observability
 *    (throttled by a Set so schedulers can't spam).
 *  - A snapshot with `_version` > PRICING_SNAPSHOT_VERSION is an unknown FUTURE
 *    version → hard-fail with a clear Error naming the context. This is the only
 *    hard-fail; it turns a silent-misread into a loud stop.
 *  - null / undefined / empty → returns null (readers keep their existing
 *    null/absent fallbacks).
 *
 * NO per-key shape validation in v1 — the version stamp is the seam; per-key
 * validation is future work keyed off `_version`.
 */

const PRICING_SNAPSHOT_VERSION = 1;

// Throttle: legacy-shape observability fires at most once per process per
// context, so a scheduler iterating thousands of legacy rows logs once.
const seenLegacyContexts = new Set();

/**
 * Parse + version-gate a raw pricing_snapshot.
 *
 * @param {object|string|null|undefined} raw  The snapshot object, a JSON string
 *   of it (some callers pass the raw column, which can be text), or empty.
 * @param {{ context?: string }} [opts]  A short tag naming the read site, used
 *   in the legacy-shape Sentry message and the future-version Error.
 * @returns {object|null} The parsed snapshot, or null for empty/unparseable input.
 */
function readSnapshot(raw, { context = 'unknown' } = {}) {
  if (raw === null || raw === undefined || raw === '') return null;

  let snap = raw;
  if (typeof raw === 'string') {
    try {
      snap = JSON.parse(raw);
    } catch {
      // Malformed JSON is treated as absent (tolerant): readers fall back to
      // their own null-handling, exactly as they did before the version stamp.
      return null;
    }
  }
  if (snap === null || typeof snap !== 'object') return null;

  const version = snap._version;
  if (version === undefined || version === null) {
    // Legacy (pre-stamp) snapshot: proceed as v1, tag its shape once per context.
    if (!seenLegacyContexts.has(context)) {
      seenLegacyContexts.add(context);
      // Lazy require keeps @sentry/node out of the module-load graph of the
      // pure engine (pricingEngine.js) and pure helpers (setupTime.js).
      require('@sentry/node').captureMessage(
        'pricingSnapshot: legacy snapshot without _version',
        {
          level: 'info',
          tags: { component: 'pricingSnapshot', reason: 'legacy_no_version', context },
        }
      );
    }
    return snap;
  }

  if (Number(version) > PRICING_SNAPSHOT_VERSION) {
    throw new Error(
      `pricingSnapshot: unsupported future _version ${version} `
      + `(reader supports up to ${PRICING_SNAPSHOT_VERSION}) at context "${context}"`
    );
  }

  return snap;
}

module.exports = { PRICING_SNAPSHOT_VERSION, readSnapshot };
