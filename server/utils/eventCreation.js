const { pool } = require('../db');
const { sendEmail } = require('./email');
const { drinkPlanLink } = require('./emailTemplates');

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
 * Auto-create a drink plan linked to a proposal. Idempotent — skips if one already exists.
 * Sends the drink plan link to the client via email.
 * @param {number} proposalId
 * @param {object} proposal - Proposal row (must include client_name, client_email, event_name, event_date, created_by)
 * @returns {object|null} The created drink_plan row, or null if skipped
 */
async function createDrinkPlan(proposalId, proposal) {
  // Idempotency: skip if a drink plan already exists for this proposal
  const existing = await pool.query(
    'SELECT id FROM drink_plans WHERE proposal_id = $1 LIMIT 1',
    [proposalId]
  );
  if (existing.rows.length > 0) return null;

  const clientEmail = proposal.client_email;

  // Insert the drink plan
  const result = await pool.query(`
    INSERT INTO drink_plans (client_name, client_email, event_name, event_date, proposal_id, created_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [
    proposal.client_name || null,
    clientEmail || null,
    proposal.event_name || (proposal.client_name ? `${proposal.client_name}'s Event` : null),
    proposal.event_date || null,
    proposalId,
    proposal.created_by
  ]);

  const drinkPlan = result.rows[0];

  // Email the drink plan link to the client
  if (clientEmail && drinkPlan.token) {
    const clientUrl = process.env.CLIENT_URL || 'https://admin.drbartender.com';
    const planUrl = `${clientUrl}/plan/${drinkPlan.token}`;
    const eventName = drinkPlan.event_name || 'your upcoming event';

    try {
      const template = drinkPlanLink({ clientName: proposal.client_name, eventName, planUrl });
      await sendEmail({ to: clientEmail, ...template });
      console.log(`Drink plan email sent to ${clientEmail} for proposal ${proposalId}`);
    } catch (emailErr) {
      console.error('Drink plan email failed (non-blocking):', emailErr);
    }
  }

  return drinkPlan;
}

/**
 * Auto-create a shift from a paid proposal. Idempotent — skips if shifts already exist for this proposal.
 * Also auto-creates a drink plan and emails the client.
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
    SELECT p.*, c.name AS client_name, c.email AS client_email
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

  // Auto-create drink plan and email client (non-blocking)
  try {
    const drinkPlan = await createDrinkPlan(proposalId, proposal);
    if (drinkPlan) console.log(`Drink plan #${drinkPlan.id} created for proposal ${proposalId}`);
  } catch (dpErr) {
    console.error('Drink plan auto-creation failed (non-blocking):', dpErr);
  }

  return shiftResult.rows[0];
}

module.exports = { createEventShifts, createDrinkPlan };
