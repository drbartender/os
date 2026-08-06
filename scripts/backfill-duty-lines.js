#!/usr/bin/env node
'use strict';
/**
 * backfill-duty-lines.js — one-time ship backfill (spec 2026-08-06 §10.1).
 *
 * Re-runs accruePayoutsForProposal over every COMPLETED proposal whose event
 * date falls inside the CURRENT OPEN pay period, so the shipping period gets
 * its duty lines (including the long-promised $5 menu prints), then runs the
 * review catch-up pass. Idempotent by construction: accrual derives, never
 * increments, and the catch-up pass inserts only missing bounty lines.
 *
 * Doubles as the period-open catch-up: safe to re-run any time.
 *
 *   node -r dotenv/config scripts/backfill-duty-lines.js          # dev
 *   node -r dotenv/config scripts/backfill-duty-lines.js --yes    # required in prod
 */
const { pool } = require('../server/db');
const { accruePayoutsForProposal } = require('../server/utils/payrollAccrual');
const { materializePendingReviewLines } = require('../server/utils/dutyLines');
const { findOpenPeriodForDate } = require('../server/utils/payrollProcessing');
const { chicagoTodayYmd } = require('../server/utils/businessTime');

async function main() {
  if (process.env.NODE_ENV === 'production' && !process.argv.includes('--yes')) {
    console.error('Refusing to run against production without --yes');
    process.exit(1);
  }

  const period = await findOpenPeriodForDate(pool, chicagoTodayYmd());
  if (!period) {
    console.log('No open pay period contains today; nothing to backfill.');
  } else {
    const { rows } = await pool.query(
      `SELECT id, event_date FROM proposals
        WHERE status = 'completed' AND event_date BETWEEN $1 AND $2
        ORDER BY event_date, id`,
      [period.start_date, period.end_date]
    );
    console.log(`Open period ${period.id}: ${rows.length} completed proposal(s) to re-derive.`);
    for (const { id, event_date } of rows) {
      try {
        const res = await accruePayoutsForProposal(id);
        console.log(`  proposal ${id} (${String(event_date).slice(0, 10)}): ${res.skipped ? `skipped (${res.reason})` : 'derived'}`);
      } catch (err) {
        console.error(`  proposal ${id}: FAILED — ${err.message}`);
      }
    }
  }

  const client = await pool.connect();
  try {
    // One transaction so a mid-sequence failure cannot strand a payout row
    // without its line or a line without its recomputed total (review W6).
    await client.query('BEGIN');
    const catchUp = await materializePendingReviewLines(client);
    await client.query('COMMIT');
    console.log(`Review catch-up: ${catchUp.materialized} bounty line(s) materialized.`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
