// Guarantee an onboarding_progress row exists for a user.
//
// Legacy accounts (created before registration started seeding the table)
// have no row, and every onboarding step write is UPDATE-only — so without
// this guard a legacy user completes the entire flow into the void: zero-row
// updates, status flips to approved (users row exists), but the active-staff
// roster's INNER JOIN on onboarding_progress never sees them (Kevin Duffy,
// 2026-07-14).
//
// Pass the transaction's client when called inside one (one pooled connection
// per request — see CLAUDE.md); defaults to the pool for standalone use.
const { pool } = require('../db');

async function ensureOnboardingProgress(userId, db = pool) {
  await db.query(
    `INSERT INTO onboarding_progress (user_id, account_created)
     VALUES ($1, true)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

module.exports = { ensureOnboardingProgress };
