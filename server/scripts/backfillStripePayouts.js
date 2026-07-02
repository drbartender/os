#!/usr/bin/env node
// One-off backfill: full Stripe payout history into the read-side mirror.
// Safe to re-run (idempotent upserts). Refuses to run in test mode.
// Pass --full to force a full-history sweep even when the mirror table is already
// non-empty (recovers from a partial bootstrap that narrowed re-runs to 30 days).
require('dotenv').config();
const { sweep } = require('../utils/stripePayoutSync');
const { pool } = require('../db');

(async () => {
  const until = process.env.STRIPE_TEST_MODE_UNTIL;
  if (until && new Date(until) > new Date()) {
    console.error('STRIPE_TEST_MODE_UNTIL is active — backfill must run against live. Aborting.');
    process.exit(1);
  }
  const fullHistory = process.argv.includes('--full');
  await sweep({ fullHistory }); // empty-table bootstrap fetches full history; --full forces it
  const p = await pool.query('SELECT COUNT(*)::int n FROM stripe_payouts');
  const l = await pool.query(`SELECT matched_kind, COUNT(*)::int n FROM stripe_payout_lines GROUP BY matched_kind ORDER BY n DESC`);
  console.log(`payouts: ${p.rows[0].n}`);
  console.table(l.rows);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
