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
 * Money law 15: a legal-hold proposal is left out of the selection
 * (heldProposalIds, the one list; a missing list throws before any row is
 * read), so accruePayoutsForProposal never runs for it, and every run prints
 * how many it left out. A --yes run refuses (exit 1) without --held-excluded,
 * and (exit 2) unless it equals the count this run computes; a run without
 * --yes prints that count first (in prod it then refuses, as before).
 *
 *   node -r dotenv/config scripts/backfill-duty-lines.js                               # dev
 *   node -r dotenv/config scripts/backfill-duty-lines.js --yes --held-excluded <n>     # required in prod
 */
const { pool } = require('../server/db');
const { accruePayoutsForProposal } = require('../server/utils/payrollAccrual');
const { materializePendingReviewLines } = require('../server/utils/dutyLines');
const { findOpenPeriodForDate } = require('../server/utils/payrollProcessing');
const { chicagoTodayYmd } = require('../server/utils/businessTime');
const { heldProposalIds } = require('../server/utils/legalHold');

const HELD_FLAG = '--held-excluded';

// The count after --held-excluded, or null when the flag is absent. Throws on
// a missing or malformed value, so a typo never reads as a count.
function parseHeldExcluded(args) {
  const i = args.indexOf(HELD_FLAG);
  if (i < 0) return null;
  const raw = args[i + 1];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(`${HELD_FLAG} needs the legal-hold count a run printed (a whole number)`);
  }
  return Number(raw);
}

async function main(args = process.argv.slice(2)) {
  const yes = args.includes('--yes');
  let heldFlag;
  try {
    heldFlag = parseHeldExcluded(args);
  } catch (err) {
    console.error(`REFUSING: ${err.message}. Nothing was written.`);
    process.exitCode = 1;
    return;
  }
  if (yes && heldFlag === null) {
    console.error(`REFUSING: --yes needs ${HELD_FLAG} <n>, the legal-hold count a run without --yes printed. Nothing was written.`);
    process.exitCode = 1;
    return;
  }

  // Read before any row is: a missing list throws here.
  const held = heldProposalIds();
  const period = await findOpenPeriodForDate(pool, chicagoTodayYmd());

  // The held proposals are counted, never read: the count is what the operator
  // confirms, and a --yes run carries it.
  const heldCount = period
    ? (await pool.query(
      `SELECT count(*)::int AS n FROM proposals
        WHERE status = 'completed' AND event_date BETWEEN $1 AND $2
          AND id = ANY($3::int[])`,
      [period.start_date, period.end_date, held]
    )).rows[0].n
    : 0;
  console.log(`legal hold: ${heldCount} proposal(s) on legal hold left out (money law 15). A --yes run needs ${HELD_FLAG} ${heldCount}.`);
  if (yes && heldFlag !== heldCount) {
    console.error(`REFUSING: ${HELD_FLAG} ${heldFlag} does not match the ${heldCount} held proposal(s) this run leaves out. Nothing was written.`);
    process.exitCode = 2;
    return;
  }

  if (process.env.NODE_ENV === 'production' && !yes) {
    console.error('Refusing to run against production without --yes');
    process.exitCode = 1;
    return;
  }

  if (!period) {
    console.log('No open pay period contains today; nothing to backfill.');
  } else {
    const { rows } = await pool.query(
      `SELECT id, event_date FROM proposals
        WHERE status = 'completed' AND event_date BETWEEN $1 AND $2
          AND id <> ALL($3::int[])
        ORDER BY event_date, id`,
      [period.start_date, period.end_date, held]
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
}

module.exports = { main };

if (require.main === module) {
  main()
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(() => pool.end());
}
