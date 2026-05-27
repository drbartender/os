const crypto = require('crypto');

/**
 * Normalize a name for matching: lowercase, trim, collapse internal whitespace.
 * Mirrors the SQL `LOWER(TRIM(regexp_replace(..., '[[:space:]]+', ' ', 'g')))`
 * normalization applied to `contractor_profiles.preferred_name` in Pass 1 / 2.
 */
function normalize(name) {
  return String(name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Comma-flip: convert "Last, First [Middle]" → "First [Middle] Last".
 * Returns null when the input has no comma (so callers can skip Pass 2).
 */
function commaFlip(name) {
  const m = /^(.+?),\s*(.+)$/.exec(String(name || ''));
  if (!m) return null;
  return `${m[2].trim()} ${m[1].trim()}`;
}

/**
 * Pass 1 → Pass 2 → Pass 3 fuzzy cascade against `contractor_profiles.preferred_name`.
 * Returns an array of matched `users.id`. Empty = no match (caller creates a stub);
 * length > 1 = ambiguous (caller flags for the Review page).
 *
 * The `clientOrPool` parameter accepts either a `pg.Pool` or a `pg.Client` /
 * pooled-client checkout. Both expose `.query(text, params)`.
 *
 * Spec §7.3 — name source is `contractor_profiles.preferred_name`, joined via
 * `LEFT JOIN contractor_profiles cp ON cp.user_id = u.id`.
 */
async function findByName(clientOrPool, payeeName) {
  const norm = normalize(payeeName);
  if (!norm) return [];

  // Pass 1: exact normalized preferred_name.
  let r = await clientOrPool.query(
    `SELECT u.id FROM users u
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE LOWER(TRIM(regexp_replace(COALESCE(cp.preferred_name, ''), '[[:space:]]+', ' ', 'g'))) = $1`,
    [norm]
  );
  if (r.rowCount > 0) return r.rows.map(x => x.id);

  // Pass 2: comma-flipped retry ('Smith, Mike' → 'Mike Smith').
  const flipped = commaFlip(payeeName);
  if (flipped) {
    r = await clientOrPool.query(
      `SELECT u.id FROM users u
         LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
        WHERE LOWER(TRIM(regexp_replace(COALESCE(cp.preferred_name, ''), '[[:space:]]+', ' ', 'g'))) = $1`,
      [normalize(flipped)]
    );
    if (r.rowCount > 0) return r.rows.map(x => x.id);
  }

  // Pass 3: first-initial + last-name LIKE (e.g. "Mike Smith" matches "Michael S.").
  const parts = norm.split(' ');
  if (parts.length >= 2) {
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first.length > 0) {
      r = await clientOrPool.query(
        `SELECT u.id FROM users u
           LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
          WHERE LOWER(TRIM(cp.preferred_name)) LIKE $1`,
        [`${first[0]}% ${last}%`]
      );
      if (r.rowCount > 0) return r.rows.map(x => x.id);
    }
  }

  return [];
}

/**
 * Build a deterministic legacy-CC stub identifier for an unmatched payee.
 *
 * Per spec §7.3 / §6.6:
 *   - cc_id  = `legacy_cc:<slug>:<hash6>`
 *   - email  = `legacy-cc-<slug>-<hash6>@drbartender.local`
 *   - slug   = alphanumeric-only lowercase of the payee name
 *   - hash6  = first 6 hex chars of sha256(`<payeeName>|<earliestPaidOnIso>`)
 *
 * The hash makes the id reproducible on re-runs (Phase 5 is idempotent), and the
 * `earliestPaidOn` salt ensures payee-name collisions across different humans
 * still produce distinct stubs as long as their first-payout dates differ.
 */
function buildStubCcId(payeeName, earliestPaidOnIso) {
  const slug = String(payeeName).toLowerCase().replace(/[^a-z0-9]/g, '');
  const hash6 = crypto
    .createHash('sha256')
    .update(`${payeeName}|${earliestPaidOnIso}`)
    .digest('hex')
    .slice(0, 6);
  return {
    slug,
    hash6,
    ccId: `legacy_cc:${slug}:${hash6}`,
    email: `legacy-cc-${slug}-${hash6}@drbartender.local`,
  };
}

module.exports = { normalize, commaFlip, findByName, buildStubCcId };
