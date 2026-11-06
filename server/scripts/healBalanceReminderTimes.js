'use strict';

/**
 * Re-anchor already-scheduled balance-reminder rows to the corrected 10:00am local (REMINDER_ANCHOR_HOUR)
 * event-local send instant (T2 fix). Before the fix, balanceReminderScheduling
 * anchored these to the pg DATE -> JS Date midnight-UTC value, which under a GMT
 * session fired around 7pm the PRIOR evening in Chicago. This script recomputes
 * scheduled_for for PENDING rows only, using the same single-source-of-truth
 * offset map + anchor helper the scheduler now uses.
 *
 * Safe by construction:
 *   - PENDING rows only (never touches sent / failed / already-dispatched rows).
 *   - Sends NOTHING — it only rewrites scheduled_for.
 *   - DRY RUN by default: prints per-type counts of what WOULD move and writes
 *     nothing. Pass --apply to actually update.
 *   - Money law 15: the rows of a legal-hold proposal are left out of the
 *     selection (heldProposalIds), and every run prints how many it left out.
 *     A write run refuses unless --held-excluded <n> gives that count from a
 *     dry run and the count still matches, so a bulk write always follows a
 *     dry run that confirmed the held rows. A missing list throws before any
 *     row is read.
 *
 *   node server/scripts/healBalanceReminderTimes.js                               # dry run
 *   node server/scripts/healBalanceReminderTimes.js --apply --held-excluded <n>   # write
 *
 * Exit codes: 0 clean; 1 bad arguments, a write run with no held count, or a
 * failure; 2 the held count did not match and nothing was written.
 */

require('dotenv').config();
const { pool } = require('../db');
const { resolveEventTimezone } = require('../utils/eventTimezone');
const {
  REMINDER_OFFSET_DAYS,
  reminderAnchorInstant,
  toBaseYmd,
} = require('../utils/balanceReminderScheduling');
const { heldProposalIds } = require('../utils/legalHold');

const HELD_FLAG = '--held-excluded';

// The count after --held-excluded, or null when the flag is absent. Throws on
// a missing or malformed value, so a typo never reads as a count.
function parseHeldExcluded(args) {
  const i = args.indexOf(HELD_FLAG);
  if (i < 0) return null;
  const raw = args[i + 1];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(`${HELD_FLAG} needs the legal-hold count a dry run printed (a whole number)`);
  }
  return Number(raw);
}

async function main(args = process.argv.slice(2)) {
  const apply = args.includes('--apply');
  const dryRun = !apply;
  let heldFlag;
  try {
    heldFlag = parseHeldExcluded(args);
  } catch (err) {
    console.error(`REFUSING: ${err.message}. Nothing was written.`);
    process.exitCode = 1;
    return;
  }
  if (apply && heldFlag === null) {
    console.error(`REFUSING: --apply needs ${HELD_FLAG} <n>, the legal-hold count a dry run printed. Nothing was written.`);
    process.exitCode = 1;
    return;
  }

  // Read before any row is: a missing list throws here.
  const held = heldProposalIds();

  console.log(`[heal-balance-reminders] ${dryRun ? 'DRY RUN — no writes' : 'APPLY — writing scheduled_for'}`);

  const types = Object.keys(REMINDER_OFFSET_DAYS);

  // The held rows are counted, never read: the count is what the operator
  // confirms, and a write run must carry it.
  const heldRes = await pool.query(
    `SELECT count(*)::int AS n
       FROM scheduled_messages sm
      WHERE sm.entity_type = 'proposal'
        AND sm.status = 'pending'
        AND sm.message_type = ANY($1)
        AND sm.entity_id = ANY($2::int[])`,
    [types, held]
  );
  const heldCount = heldRes.rows[0].n;
  console.log(`[heal-balance-reminders] legal hold: ${heldCount} pending row(s) on held proposals left out (money law 15). A write run needs ${HELD_FLAG} ${heldCount}.`);
  if (apply && heldFlag !== heldCount) {
    console.error(`REFUSING: ${HELD_FLAG} ${heldFlag} does not match the ${heldCount} held row(s) this run leaves out. Re-run the dry run first. Nothing was written.`);
    process.exitCode = 2;
    return;
  }

  const { rows } = await pool.query(
    `SELECT sm.id, sm.message_type, sm.scheduled_for,
            p.balance_due_date, p.event_timezone
       FROM scheduled_messages sm
       JOIN proposals p ON p.id = sm.entity_id
      WHERE sm.entity_type = 'proposal'
        AND sm.status = 'pending'
        AND sm.message_type = ANY($1)
        AND p.id <> ALL($2::int[])
      ORDER BY sm.message_type, sm.id`,
    [types, held]
  );

  // Per-type tally: how many PENDING rows examined, how many would move, and how
  // many were skipped for want of a balance_due_date (can't anchor those).
  const stats = {};
  for (const t of types) stats[t] = { examined: 0, changed: 0, skippedNoDueDate: 0 };

  let totalChanged = 0;
  let totalSkipped = 0;

  for (const row of rows) {
    const s = stats[row.message_type];
    s.examined += 1;
    if (!row.balance_due_date) {
      s.skippedNoDueDate += 1;
      totalSkipped += 1;
      continue;
    }
    const tz = resolveEventTimezone({ event_timezone: row.event_timezone });
    const baseYmd = toBaseYmd(row.balance_due_date);
    const anchor = reminderAnchorInstant(baseYmd, REMINDER_OFFSET_DAYS[row.message_type], tz);

    const current = row.scheduled_for ? new Date(row.scheduled_for).getTime() : null;
    if (current === anchor.getTime()) continue; // already correct

    s.changed += 1;
    totalChanged += 1;
    if (!dryRun) {
      // Re-guard status='pending' so a row the dispatcher claimed mid-run is not
      // rewritten out from under it.
      await pool.query(
        `UPDATE scheduled_messages SET scheduled_for = $1 WHERE id = $2 AND status = 'pending'`,
        [anchor, row.id]
      );
    }
  }

  console.log(`Examined ${rows.length} pending balance-reminder row(s).`);
  for (const t of types) {
    const s = stats[t];
    if (s.examined === 0) continue;
    const verb = dryRun ? 'would move' : 'moved';
    const skipNote = s.skippedNoDueDate ? `, ${s.skippedNoDueDate} skipped (no balance_due_date)` : '';
    console.log(`  ${t}: ${s.examined} examined, ${s.changed} ${verb}${skipNote}`);
  }
  console.log(`Total: ${totalChanged} ${dryRun ? 'would move' : 'moved'}, ${totalSkipped} skipped (no balance_due_date).`);
  if (dryRun && totalChanged > 0) {
    console.log(`Re-run with --apply ${HELD_FLAG} ${heldCount} to write these changes.`);
  }
  console.log('[heal-balance-reminders] done.');
}

module.exports = { main };

if (require.main === module) {
  main()
    .catch((err) => { console.error('Heal failed:', err); process.exitCode = 1; })
    .finally(async () => { await pool.end(); });
}
