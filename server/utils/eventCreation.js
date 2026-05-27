const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { composeVenueLocation } = require('./venueAddress');
const { effectiveSetupMinutes } = require('./setupTime');
const { scheduleDrinkPlanNudge } = require('./drinkPlanNudge');

/**
 * Convert a 24-hour time string (e.g. "17:00") and add hours to produce a new time string.
 * Returns a 12-hour formatted string like "9:00 PM" for the shift display.
 */
function addHoursToTime(timeStr, hours) {
  const [h, m] = String(timeStr).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
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
  const [h, m] = String(timeStr).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const hour12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${hour12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/**
 * Auto-create a drink plan linked to a proposal. Idempotent — skips if one already exists.
 * No longer emails the client: the Stripe webhook's orientation email carries
 * the Potion Planner link. The `skipEmail` option is retained for callers that
 * still pass it but is now a no-op.
 * @param {number} proposalId
 * @param {object} proposal - Proposal row (must include client_name, client_email, event_type, event_type_custom, event_date, created_by)
 * @returns {object|null} The created drink_plan row, or null if skipped
 */
async function createDrinkPlan(proposalId, proposal, { skipEmail = false } = {}) {
  // Idempotency: skip if a drink plan already exists for this proposal
  const existing = await pool.query(
    'SELECT id FROM drink_plans WHERE proposal_id = $1 LIMIT 1',
    [proposalId]
  );
  if (existing.rows.length > 0) return null;

  const clientEmail = proposal.client_email;

  // Insert the drink plan
  const result = await pool.query(`
    INSERT INTO drink_plans (client_name, client_email, event_type, event_type_custom, event_date, proposal_id, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [
    proposal.client_name || null,
    clientEmail || null,
    proposal.event_type || null,
    proposal.event_type_custom || null,
    proposal.event_date || null,
    proposalId,
    proposal.created_by
  ]);

  const drinkPlan = result.rows[0];

  // The standalone drink-plan-link email has been retired: the Stripe webhook's
  // orientation email (signedAndPaidClient) now carries the Potion Planner link,
  // so a separate drinkPlanLink send would duplicate it. The drink_plans row
  // itself still has to exist here — the orientation payload reads its token.

  // CC-import: enroll the drink-plan nudge (T-21 email + SMS) right after the
  // plan row is inserted. Hook fires only when this call actually inserted a row
  // — the idempotent skip path returns null at the top of the function and
  // never reaches here. Non-blocking: a scheduling failure must not roll back
  // the plan. See specs/2026-05-25-checkcherry-import-design.md §9.3.D.
  try {
    await scheduleDrinkPlanNudge(proposalId, pool);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { hook: 'createDrinkPlan_postinsert', proposalId },
    });
  }

  return drinkPlan;
}

/**
 * Auto-create a shift from a paid proposal. Idempotent — skips if shifts already exist for this proposal.
 * Also auto-creates the linked drink plan (the orientation email, sent from the
 * Stripe webhook, surfaces its Potion Planner link to the client).
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

  // Insert the shift. setup_minutes_before mirrors the proposal's effective
  // value (explicit override, else 90 hosted / 60 — derived from pricing_snapshot
  // which is in hand via SELECT p.*). Informational only — start_time stays equal
  // to service start; this never shifts the billable/pay window.
  const shiftResult = await pool.query(`
    INSERT INTO shifts (event_type, event_type_custom, client_name, event_date, start_time, end_time, location, setup_minutes_before, positions_needed, notes, status, proposal_id, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open', $11, $12)
    RETURNING *
  `, [
    proposal.event_type || null,
    proposal.event_type_custom || null,
    proposal.client_name || null,
    proposal.event_date,
    startDisplay,
    endDisplay,
    composeVenueLocation(proposal) || proposal.event_location || null,
    effectiveSetupMinutes(proposal),
    JSON.stringify(positions),
    `Auto-created from proposal #${proposal.id}. ${proposal.guest_count || 0} guests. Client: ${proposal.client_name || 'Unknown'}.`,
    proposalId,
    proposal.created_by
  ]);

  // Auto-create the linked drink plan (non-blocking). No client email here —
  // the webhook's orientation email carries the Potion Planner link.
  try {
    const drinkPlan = await createDrinkPlan(proposalId, proposal);
    if (drinkPlan) console.log(`Drink plan #${drinkPlan.id} created for proposal ${proposalId}`);
  } catch (dpErr) {
    console.error('Drink plan auto-creation failed (non-blocking):', dpErr);
  }

  return shiftResult.rows[0];
}

/**
 * Re-sync the auto-created shift's event identity from its proposal after an
 * admin edits event details (date / time / location / client / event type).
 * Mirrors the field derivation in createEventShifts so a converted event's
 * shift never drifts from the proposal it came from.
 *
 * Only touches the 1:1 auto-created shift: if the proposal has 0 shifts it
 * isn't converted yet (nothing to sync); if it has >1 it's a hand-built
 * multi-shift event the admin manages directly — clobbering those with a
 * single proposal date/time would destroy deliberate setup, so we skip.
 *
 * @param {number} proposalId
 * @param {object} db - pg pool OR an in-transaction client. Pass the caller's
 *   transaction client so the sync commits atomically with the proposal edit.
 * @returns {object|null} the updated shift row, or null if skipped
 */
async function syncShiftsFromProposal(proposalId, db = pool) {
  const cnt = await db.query(
    'SELECT COUNT(*)::int AS n FROM shifts WHERE proposal_id = $1',
    [proposalId]
  );
  if (cnt.rows[0].n !== 1) return null;

  const result = await db.query(`
    SELECT p.*, c.name AS client_name, c.email AS client_email
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.id = $1
  `, [proposalId]);
  if (!result.rows[0]) return null;
  const proposal = result.rows[0];

  const startTime = proposal.event_start_time || null;
  let startDisplay = null;
  let endDisplay = null;
  if (startTime) {
    startDisplay = formatTime12(startTime);
    if (proposal.event_duration_hours) {
      endDisplay = addHoursToTime(startTime, Number(proposal.event_duration_hours));
    }
  }

  const composedLocation = composeVenueLocation(proposal) || proposal.event_location || null;
  // setup_minutes_before re-derives from the proposal each sync (same rule as
  // createEventShifts). Multi-shift events are skipped by the count !== 1 guard
  // above (by design — the admin manages those per shift via PUT /shifts/:id).
  const upd = await db.query(`
    UPDATE shifts SET
      event_date = $1,
      start_time = $2,
      end_time = $3,
      lat = CASE WHEN location IS DISTINCT FROM $4 THEN NULL ELSE lat END,
      lng = CASE WHEN location IS DISTINCT FROM $4 THEN NULL ELSE lng END,
      location = $4,
      client_name = $5,
      event_type = $6,
      event_type_custom = $7,
      setup_minutes_before = $9
    WHERE proposal_id = $8
    RETURNING *
  `, [
    proposal.event_date,
    startDisplay,
    endDisplay,
    composedLocation,
    proposal.client_name || null,
    proposal.event_type || null,
    proposal.event_type_custom || null,
    proposalId,
    effectiveSetupMinutes(proposal),
  ]);
  return upd.rows[0] || null;
}

module.exports = { createEventShifts, createDrinkPlan, syncShiftsFromProposal };
