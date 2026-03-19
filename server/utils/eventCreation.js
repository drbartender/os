const { pool } = require('../db');

/**
 * Convert a 24-hour time string (e.g. "17:00") and add hours to produce a new time string.
 * Returns a 12-hour formatted string like "9:00 PM" for the shift display.
 */
function addHoursToTime(timeStr, hours) {
  const [h, m] = timeStr.split(':').map(Number);
  const totalMinutes = h * 60 + m + hours * 60;
  const newH = Math.floor(totalMinutes / 60) % 24;
  const newM = totalMinutes % 60;
  const hour12 = newH > 12 ? newH - 12 : (newH === 0 ? 12 : newH);
  const ampm = newH >= 12 ? 'PM' : 'AM';
  return `${hour12}:${String(newM).padStart(2, '0')} ${ampm}`;
}

/**
 * Format a 24-hour time string to 12-hour display (e.g. "17:00" → "5:00 PM").
 */
function formatTime12(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const hour12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${hour12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/**
 * Auto-create a shift from a paid proposal. Idempotent — skips if shifts already exist for this proposal.
 * @param {number} proposalId
 * @returns {object|null} The created shift row, or null if skipped
 */
async function createEventShifts(proposalId) {
  // Idempotency: skip if shifts already exist for this proposal
  const existing = await pool.query(
    'SELECT id FROM shifts WHERE proposal_id = $1 LIMIT 1',
    [proposalId]
  );
  if (existing.rows.length > 0) return null;

  // Fetch proposal with client info
  const result = await pool.query(`
    SELECT p.*, c.name AS client_name
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.id = $1
  `, [proposalId]);
  if (!result.rows[0]) return null;
  const proposal = result.rows[0];

  // Calculate start and end times for the shift
  const startTime = proposal.event_start_time || null;
  let startDisplay = null;
  let endDisplay = null;
  if (startTime) {
    startDisplay = formatTime12(startTime);
    if (proposal.event_duration_hours) {
      endDisplay = addHoursToTime(startTime, Number(proposal.event_duration_hours));
    }
  }

  // Build positions_needed as array of strings (matches existing pattern)
  const numBartenders = proposal.num_bartenders || 1;
  const positions = Array(numBartenders).fill('Bartender');

  // Insert the shift
  const shiftResult = await pool.query(`
    INSERT INTO shifts (event_name, event_date, start_time, end_time, location, positions_needed, notes, status, proposal_id, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9)
    RETURNING *
  `, [
    proposal.event_name || `Event #${proposal.id}`,
    proposal.event_date,
    startDisplay,
    endDisplay,
    proposal.event_location || null,
    JSON.stringify(positions),
    `Auto-created from proposal #${proposal.id}. ${proposal.guest_count || 0} guests. Client: ${proposal.client_name || 'Unknown'}.`,
    proposalId,
    proposal.created_by
  ]);

  return shiftResult.rows[0];
}

module.exports = { createEventShifts };
