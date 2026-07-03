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
 *
 *   node server/scripts/healBalanceReminderTimes.js            # dry run
 *   node server/scripts/healBalanceReminderTimes.js --apply    # write
 */

require('dotenv').config();
const { pool } = require('../db');
const { resolveEventTimezone } = require('../utils/eventTimezone');
const {
  REMINDER_OFFSET_DAYS,
  reminderAnchorInstant,
  toBaseYmd,
} = require('../utils/balanceReminderScheduling');

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dryRun = !apply;

  console.log(`[heal-balance-reminders] ${dryRun ? 'DRY RUN — no writes' : 'APPLY — writing scheduled_for'}`);

  const types = Object.keys(REMINDER_OFFSET_DAYS);
  const { rows } = await pool.query(
    `SELECT sm.id, sm.message_type, sm.scheduled_for,
            p.balance_due_date, p.event_timezone
       FROM scheduled_messages sm
       JOIN proposals p ON p.id = sm.entity_id
      WHERE sm.entity_type = 'proposal'
        AND sm.status = 'pending'
        AND sm.message_type = ANY($1)
      ORDER BY sm.message_type, sm.id`,
    [types]
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
    console.log('Re-run with --apply to write these changes.');
  }
  console.log('[heal-balance-reminders] done.');
}

main()
  .catch((err) => { console.error('Heal failed:', err); process.exitCode = 1; })
  .finally(async () => { await pool.end(); });
