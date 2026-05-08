// server/scripts/backfillTipPages.js
// One-time backfill: for each approved contractor missing tip_page_token,
// generate a UUID and create a Stripe Payment Link in DRB's account.
// Idempotent: skips rows that already have tokens.
// Usage: node server/scripts/backfillTipPages.js

require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { createTipPaymentLink } = require('../utils/tipPaymentLinks');

async function main() {
  const { rows } = await pool.query(`
    SELECT u.id AS user_id, cp.preferred_name
    FROM users u
    JOIN contractor_profiles cp ON cp.user_id = u.id
    LEFT JOIN payment_profiles pp ON pp.user_id = u.id
    WHERE u.onboarding_status IN ('submitted', 'reviewed', 'approved', 'hired')
      AND (pp.tip_page_token IS NULL OR pp.user_id IS NULL)
  `);

  console.log(`[backfill] ${rows.length} contractors need tip-page setup`);

  for (const row of rows) {
    const token = uuidv4();
    const displayName = row.preferred_name || 'your bartender';
    try {
      const { url, id } = await createTipPaymentLink({
        userId: row.user_id,
        displayName,
        token,
      });
      await pool.query(`
        INSERT INTO payment_profiles (user_id, tip_page_token, stripe_payment_link_url, stripe_payment_link_id, tip_page_active)
        VALUES ($1, $2, $3, $4, TRUE)
        ON CONFLICT (user_id) DO UPDATE SET
          tip_page_token = COALESCE(payment_profiles.tip_page_token, EXCLUDED.tip_page_token),
          stripe_payment_link_url = COALESCE(payment_profiles.stripe_payment_link_url, EXCLUDED.stripe_payment_link_url),
          stripe_payment_link_id = COALESCE(payment_profiles.stripe_payment_link_id, EXCLUDED.stripe_payment_link_id),
          -- Preserve any explicit FALSE an admin has set; only default to TRUE
          -- when the column was NULL (fresh row from this backfill INSERT).
          tip_page_active = COALESCE(payment_profiles.tip_page_active, TRUE),
          updated_at = NOW()
      `, [row.user_id, token, url, id]);
      // Token is the public URL secret — log only the prefix so Render log
      // retention can't be mined for working tip URLs.
      console.log(`[backfill] user_id=${row.user_id} provisioned (token ${token.slice(0, 8)}…, link ${id})`);
    } catch (err) {
      console.error(`[backfill] FAILED user_id=${row.user_id}:`, err.message);
    }
  }

  await pool.end();
  console.log('[backfill] done');
}

main().catch(err => {
  console.error('[backfill] fatal', err);
  process.exit(1);
});
