'use strict';

// Recompute and persist contractor_profiles.display_name for one user.
// Spec §4.2. Called explicitly from every write path that can change a
// preferred name or a legal name; there is deliberately no database trigger,
// because payroll reads this table and invisible behavior there is worse than
// a stale cosmetic string. `server/scripts/refreshDisplayNames.js --check` is
// the safety net for a write path someone adds later and forgets to wire up.

const { computeDisplayName } = require('./staffDisplayName');

// Legal-name precedence matches paystubData.js:40 and accountReads.js:78:
// the signed agreement wins, then the application. Both tables have a UNIQUE
// user_id, so neither LEFT JOIN can fan out.
const LEGAL_NAME_SQL = `
  SELECT cp.preferred_name,
         COALESCE(ag.full_name, ap.full_name) AS legal_full_name
    FROM contractor_profiles cp
    LEFT JOIN agreements   ag ON ag.user_id = cp.user_id
    LEFT JOIN applications ap ON ap.user_id = cp.user_id
   WHERE cp.user_id = $1`;

function norm(v) {
  return String(v === null || v === undefined ? '' : v).trim().replace(/\s+/g, ' ');
}

/**
 * @param {number} userId
 * @param {object} client REQUIRED. The pg client or pool to run on. Inside a transaction
 *   this MUST be that transaction's client; outside one, pass the shared `pool`.
 * @param {object} [opts]
 * @param {string|null} [opts.previousPreferredName] when supplied AND different from the
 *   stored value, clears preferred_name_reviewed_at so the §3.5 notice re-raises. Omit it
 *   for writes that cannot have changed the name (phone edits, agreement signing).
 * @returns {Promise<string|null>} the stored display name, or null if the user has no profile
 */
async function refreshDisplayName(userId, client, opts = {}) {
  // No `= pool` default, on purpose. A helper that quietly checks out a second
  // connection when a caller is already holding one is the house pool-deadlock
  // bug (CLAUDE.md > Coding patterns; it has bitten twice). Omitting the client
  // must be a loud, immediate error at the call site, not a latent starve under
  // load.
  if (!client || typeof client.query !== 'function') {
    throw new TypeError(
      'refreshDisplayName(userId, client, opts): `client` is required. '
      + 'Pass the transaction client when inside a transaction, or the shared `pool` when not.'
    );
  }

  const { rows } = await client.query(LEGAL_NAME_SQL, [userId]);
  if (rows.length === 0) return null;

  const next = computeDisplayName({
    preferredName: rows[0].preferred_name,
    legalFullName: rows[0].legal_full_name,
  });

  const preferredChanged =
    Object.prototype.hasOwnProperty.call(opts, 'previousPreferredName') &&
    norm(opts.previousPreferredName) !== norm(rows[0].preferred_name);

  // Guarded so a refresh that changes nothing writes nothing. updated_at is not
  // cosmetic here: smsInbound.js lookupSender resolves a shared inbound number
  // to one staff account with `ORDER BY cp.updated_at DESC LIMIT 1`, so a no-op
  // write (an agreement signing that does not move the initial, for instance)
  // would silently re-arm who a STOP lands on.
  await client.query(
    `UPDATE contractor_profiles
        SET display_name = $1,
            preferred_name_reviewed_at =
              CASE WHEN $2::boolean THEN NULL ELSE preferred_name_reviewed_at END,
            updated_at = NOW()
      WHERE user_id = $3
        AND (display_name IS DISTINCT FROM $1
             OR ($2::boolean AND preferred_name_reviewed_at IS NOT NULL))`,
    [next, preferredChanged, userId]
  );
  return next;
}

module.exports = { refreshDisplayName };
