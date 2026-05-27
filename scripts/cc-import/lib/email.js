/**
 * Email helpers shared by the importer phases.
 *
 * Originally lived inline in `phase2.js`; extracted so Phase 3 (and any other
 * phase that needs to normalize CC email values for a `client_email_normalized`
 * lookup) can reuse them without duplicating the placeholder convention.
 *
 * Spec reference: docs/superpowers/specs/2026-05-25-checkcherry-import-design.md §7.1.
 */

/**
 * Normalize a raw email per spec §7.1 step 1. Returns the canonical (lowercased,
 * trimmed) email when it's a usable value; returns null to signal "use a
 * placeholder + flag email_status = 'bad'".
 */
function normalizeEmail(rawEmail) {
  if (rawEmail == null) return null;
  const trimmed = String(rawEmail).trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === 'n/a' || lower === 'none') return null;
  if (lower.startsWith('noemail@')) return null;
  return lower;
}

/**
 * Build the placeholder email used for clients with missing/junk email values.
 * Spec §7.1: `cc-import-noemail-<cc_id>@drbartender.local`.
 */
function placeholderEmail(ccId) {
  return `cc-import-noemail-${ccId}@drbartender.local`;
}

module.exports = { normalizeEmail, placeholderEmail };
