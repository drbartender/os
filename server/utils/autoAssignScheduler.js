const { pool } = require('../db');
const { autoAssignShift } = require('./autoAssign');
const { getEventTypeLabel } = require('./eventTypes');
const { chicagoTodayYmd } = require('./businessTime');

/**
 * Process scheduled auto-assign for shifts approaching their event date.
 * Finds shifts where event_date - auto_assign_days_before <= today (the
 * Chicago business day, bound as a parameter)
 * and auto_assigned_at IS NULL, then runs the auto-assign algorithm.
 *
 * Runs hourly via setInterval in server/index.js.
 */
async function processScheduledAutoAssigns() {
  try {
    const result = await pool.query(`
      SELECT s.id, s.event_type, s.event_type_custom, s.client_name, s.event_date, s.auto_assign_days_before
      FROM shifts s
      LEFT JOIN proposals p ON p.id = s.proposal_id
      WHERE s.status = 'open'
        AND s.auto_assign_days_before IS NOT NULL
        AND s.auto_assigned_at IS NULL
        -- $1 is the Chicago business day, not CURRENT_DATE: the session runs at
        -- GMT, so from 19:00 Chicago the window opened a day early and the
        -- scheduler auto-assigned staff to a shift the evening before it was due
        -- to be filled.
        AND s.event_date - (s.auto_assign_days_before * INTERVAL '1 day') <= $1::date
        AND (p.id IS NULL OR p.status != 'archived')
    `, [chicagoTodayYmd()]);

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
    throw err; // surface to wrapScheduler so heartbeat records 'failed'
  }
}

module.exports = { processScheduledAutoAssigns };
