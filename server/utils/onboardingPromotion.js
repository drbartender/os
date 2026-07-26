// Onboarding promotion gate (spec 2026-07-22-onboarding-promotion-gate).
//
// One home for the "may this account become an active staffer?" rule, so the
// route that performs the promotion and the tests that prove it cannot drift.
//
// WHY THIS IS NARROW. `users.onboarding_status = 'in_progress'` carries two
// unrelated meanings:
//   (a) self-registered, has not applied yet — the PUBLIC default written by
//       POST /api/auth/register, which mints a live JWT to anyone.
//   (b) an admin moved them past the interview — the admin-only
//       `interviewing -> in_progress` move, commented "== onboarding".
// The promotion exists for (b). While it accepted bare `in_progress`, (a) rode
// along, so anyone who registered could reach 'approved' with one more call and
// clear `requireOnboarded` — the gate every staff-data surface leans on.
//
// An applications row is unforgeable proof of (b): POST /application requires
// `in_progress` and moves the status off it inside the SAME transaction, so a
// row cannot coexist with `in_progress` unless an admin moved the user back
// down, and that route is admin-only.
//
// `pre_hired` is deliberately NOT accepted as evidence: POST /api/auth/
// register-pre-hired is public by design (the open /onboarding URL), so the
// flag is self-assertable and proves nothing.

/** Statuses that are always promotable: admin-conferred or payment-import set. */
const ADMIN_CONFERRED_STATUSES = Object.freeze(['hired', 'submitted', 'reviewed']);

/**
 * Promote a user to 'approved' if and only if they are genuinely mid-onboarding.
 * No-op (zero rows) for anyone else, including an already-approved user, which
 * keeps a re-submitted onboarding form idempotent.
 *
 * Takes the caller's pooled `client` so it joins the surrounding transaction —
 * never a bare pool.query(), which would check out a second connection while
 * the caller holds one (the pool-deadlock rule in CLAUDE.md).
 *
 * @returns {Promise<number>} rows updated: 1 on promotion, 0 on no-op.
 */
async function promoteOnboardingIfEligible(client, userId) {
  const result = await client.query(
    `UPDATE users SET onboarding_status='approved'
      WHERE id=$1
        AND ( onboarding_status = ANY($2::text[])
           OR ( onboarding_status = 'in_progress'
                AND EXISTS (SELECT 1 FROM applications a WHERE a.user_id = $1) ) )`,
    [userId, ADMIN_CONFERRED_STATUSES]
  );
  return result.rowCount;
}

module.exports = { promoteOnboardingIfEligible, ADMIN_CONFERRED_STATUSES };
