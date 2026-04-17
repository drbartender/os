const { pool } = require('../db');
const { autoAssignShift } = require('./autoAssign');
const { getEventTypeLabel } = require('./eventTypes');

/**
 * Process scheduled auto-assign for shifts approaching their event date.
 * Finds shifts where event_date - auto_assign_days_before <= today
 * and auto_assigned_at IS NULL, then runs the auto-assign algorithm.
 *
 * Runs hourly via setInterval in server/index.js.
 */
async function processScheduledAutoAssigns() {
  try {
    const result = await pool.query(`
      SELECT id, event_type, event_type_custom, client_name, event_date, auto_assign_days_before
      FROM shifts
      WHERE status = 'open'
        AND auto_assign_days_before IS NOT NULL
        AND auto_assigned_at IS NULL
        AND event_date - (auto_assign_days_before * INTERVAL '1 day') <= CURRENT_DATE
    `);

    if (result.rows.length === 0) return;

    console.log(`[AutoAssignScheduler] Found ${result.rows.length} shift(s) to auto-assign`);

    for (const shift of result.rows) {
      try {
        const outcome = await autoAssignShift(shift.id);
        console.log(
          `[AutoAssignScheduler] Shift ${shift.id} (${getEventTypeLabel({ event_type: shift.event_type, event_type_custom: shift.event_type_custom })}): approved ${outcome.approved.length} of ${outcome.slots_remaining} slots`
        );
      } catch (err) {
        console.error(`[AutoAssignScheduler] Shift ${shift.id} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('[AutoAssignScheduler] Error:', err.message);
  }
}

module.exports = { processScheduledAutoAssigns };
