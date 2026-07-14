const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { composeVenueLocation } = require('./venueAddress');
const { effectiveSetupMinutes } = require('./setupTime');
const { scheduleDrinkPlanNudge } = require('./drinkPlanNudge');
const { parsePositionsNeeded, rosterCounts } = require('./positionsNeeded');
const { canonicalizeRole } = require('./staffingRoles');
const { readSnapshot } = require('./pricingSnapshot');

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

// === Staffing roster derivation (spec Section 1) ===========================

// The per-hour minimum used to recover banquet-server / barback headcount from
// their stored hours-quantity (quantity = headcount x max(durationHours, MIN)).
// This is a LOAD-BEARING coupling: it MUST equal service_addons.minimum_hours for
// banquet-server / barback (set to 4 in schema.sql) AND the pricing engine's
// Math.max(durationHours, addon.minimum_hours) that produced the quantity
// (server/utils/pricingEngine.js). If that minimum ever changes, change it in all
// three places together or headcount recovery silently mis-counts.
const STAFFING_ADDON_MIN_HOURS = 4;

// Recover headcount for a staffing add-on from its stored hours-quantity. The
// divisor is per-slug: additional-bartender stores durationHours x headcount
// (no minimum); banquet-server / barback store max(durationHours, MIN) x headcount.
// A single uniform divisor mis-counts sub-minimum events.
function addonHeadcount(addons, slug, durationHours) {
  const divisor = slug === 'additional-bartender'
    ? Math.max(1, Number(durationHours) || 1)
    : Math.max(Number(durationHours) || 0, STAFFING_ADDON_MIN_HOURS);
  return (addons || [])
    .filter((a) => a.slug === slug)
    .reduce((sum, a) => sum + Math.max(0, Math.round((Number(a.quantity) || 0) / divisor)), 0);
}

// Ordered roster of canonical role labels the client paid for: bartenders
// (num_bartenders + additional-bartender add-on, the two additive channels),
// then banquet servers, then barbacks. Pure; never throws.
function deriveStaffingRoster(proposal, addons) {
  const dur = Number(proposal && proposal.event_duration_hours) || 0;
  const bartenders = (Number(proposal && proposal.num_bartenders) || 1)
    + addonHeadcount(addons, 'additional-bartender', dur);
  const servers = addonHeadcount(addons, 'banquet-server', dur);
  const barbacks = addonHeadcount(addons, 'barback', dur);
  const out = [];
  for (let i = 0; i < bartenders; i++) out.push('Bartender');
  for (let i = 0; i < servers; i++) out.push('Banquet Server');
  for (let i = 0; i < barbacks; i++) out.push('Barback');
  return out;
}

// Legacy proposal_addons rows whose addon_id went NULL on a service_addons
// delete keep only addon_name; map the staffing ones back to a slug.
const STAFFING_NAME_TO_SLUG = {
  'additional bartender': 'additional-bartender',
  'banquet server': 'banquet-server',
  barback: 'barback',
};

// Load the proposal's staffing add-ons as [{slug, quantity(hours)}]. Snapshot
// first (it carries slug + the hours-quantity); fall back to the proposal_addons
// join when the snapshot has no addons[] (older / imported proposals). Never
// throws on a malformed snapshot.
async function loadStaffingAddons(proposal, db) {
  try {
    const snap = readSnapshot(proposal.pricing_snapshot, { context: 'eventCreation' });
    if (snap && Array.isArray(snap.addons) && snap.addons.length) {
      return snap.addons
        .map((a) => ({ slug: a.slug, quantity: Number(a.quantity) || 0 }))
        .filter((a) => a.slug);
    }
  } catch { /* fall through to the join */ }
  const { rows } = await db.query(
    `SELECT sa.slug, pa.quantity, pa.addon_name
       FROM proposal_addons pa
       LEFT JOIN service_addons sa ON sa.id = pa.addon_id
      WHERE pa.proposal_id = $1`,
    [proposal.id],
  );
  return rows
    .map((r) => ({
      slug: r.slug
        || STAFFING_NAME_TO_SLUG[String(r.addon_name || '').trim().toLowerCase()]
        || null,
      quantity: Number(r.quantity) || 0,
    }))
    .filter((a) => a.slug);
}

// Whether the proposal is a hosted (per_guest) package. Snapshot first, else the
// package row (package_id can be NULL after a package delete).
async function isHostedProposal(proposal, db) {
  try {
    const snap = readSnapshot(proposal.pricing_snapshot, { context: 'eventCreation' });
    if (snap && snap.package && snap.package.pricing_type) {
      return snap.package.pricing_type === 'per_guest';
    }
  } catch { /* fall through */ }
  if (!proposal.package_id) return false;
  const { rows } = await db.query(
    'SELECT pricing_type FROM service_packages WHERE id = $1',
    [proposal.package_id],
  );
  return rows[0] ? rows[0].pricing_type === 'per_guest' : false;
}

// Supply-run default: a hosted event (DRB provides everything) OR any add-on
// flagged requires_provisioning needs a Pilsen pickup and/or a shopping run.
function computeSupplyRunDefault(isHosted, addons, provisioningSlugs) {
  if (isHosted) return true;
  return (addons || []).some((a) => provisioningSlugs.has(a.slug));
}

// Set of addon slugs flagged requires_provisioning.
async function provisioningSlugSet(db) {
  const { rows } = await db.query(
    'SELECT slug FROM service_addons WHERE requires_provisioning = true',
  );
  return new Set(rows.map((r) => r.slug));
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
async function createDrinkPlan(proposalId, proposal, { skipEmail = false, skipNudge = false } = {}) {
  // Idempotency: skip if a drink plan already exists for this proposal
  const existing = await pool.query(
    'SELECT id FROM drink_plans WHERE proposal_id = $1 LIMIT 1',
    [proposalId]
  );
  if (existing.rows.length > 0) return null;

  const clientEmail = proposal.client_email;

  // Insert the drink plan. skipNudge also persists as a DURABLE suppression
  // (nudge_suppressed) so automatic re-enqueues (schedulePreEventReminders on
  // any proposal PATCH) stay silent until the admin re-enrolls.
  const result = await pool.query(`
    INSERT INTO drink_plans (client_name, client_email, event_type, event_type_custom, event_date, proposal_id, created_by, nudge_suppressed)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `, [
    proposal.client_name || null,
    clientEmail || null,
    proposal.event_type || null,
    proposal.event_type_custom || null,
    proposal.event_date || null,
    proposalId,
    proposal.created_by,
    skipNudge === true
  ]);

  const drinkPlan = result.rows[0];

  // The standalone drink-plan-link email has been retired: the Stripe webhook's
  // orientation email (signedAndPaidClient) now carries the Potion Planner link,
  // so a separate drinkPlanLink send would duplicate it. The drink_plans row
  // itself still has to exist here — the orientation payload reads its token.

  // Enroll the drink-plan nudge (T-21 email + SMS) right after the plan row
  // is inserted. Hook fires only when this call actually inserted a row — the
  // idempotent skip path returns null at the top of the function and never
  // reaches here. Non-blocking: a scheduling failure must not roll back the
  // plan. skipNudge (cc-transfer 2026-07-07): transferred CC events get their
  // plan SILENTLY — Dallas intro-notes those clients personally first, then
  // re-enrolls via the admin reenroll-drink-plan-nudge button when ready.
  if (!skipNudge) {
    try {
      await scheduleDrinkPlanNudge(proposalId, pool);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { hook: 'createDrinkPlan_postinsert', proposalId },
      });
    }
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
    SELECT p.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone
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

  // Build positions_needed from the FULL paid roster: bartenders (num_bartenders
  // plus the additional-bartender add-on), banquet servers, and barbacks.
  const addons = await loadStaffingAddons(proposal, pool);
  const positions = deriveStaffingRoster(proposal, addons);
  // Supply-run default (hosted OR any provisioning add-on).
  const provSlugs = await provisioningSlugSet(pool);
  const isHosted = await isHostedProposal(proposal, pool);
  const supplyRunRequired = computeSupplyRunDefault(isHosted, addons, provSlugs);

  // Insert the shift. setup_minutes_before mirrors the proposal's effective
  // value (explicit override, else 90 hosted / 60 — derived from pricing_snapshot
  // which is in hand via SELECT p.*). Informational only — start_time stays equal
  // to service start; this never shifts the billable/pay window.
  const shiftResult = await pool.query(`
    INSERT INTO shifts (event_type, event_type_custom, client_name, event_date, start_time, end_time, location, setup_minutes_before, positions_needed, notes, status, proposal_id, created_by, client_email, client_phone, guest_count, event_duration_hours, supply_run_required)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open', $11, $12, $13, $14, $15, $16, $17)
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
    proposal.created_by,
    // Schema-drift sync (audit 5a): populate the denormalized shift columns that
    // back the manual-event path + the COALESCE(client/proposal, shift) fallbacks
    // in the shift list/detail and the staff ShiftCard guest tag. Sourced from
    // the proposal (guest_count, event_duration_hours) and clients (email, phone).
    proposal.client_email || null,
    proposal.client_phone || null,
    proposal.guest_count ?? null,
    proposal.event_duration_hours ?? null,
    supplyRunRequired
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
    SELECT p.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone
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
  // Reconcile staffing slots to the proposal's bartender count (spec 6.1). Grow
  // freely; on shrink never drop below already-approved (non-dropped) assignments,
  // capping there and logging staffing_shrink_capped so admin resolves by hand.
  // Reconcile slots to the FULL paid roster, per role. Grow freely; on shrink
  // never drop a role below its already-approved (non-dropped) assignments,
  // capping there and logging staffing_shrink_capped per role.
  const addons = await loadStaffingAddons(proposal, db);
  const desired = rosterCounts(deriveStaffingRoster(proposal, addons));
  const approvedRes = await db.query(
    `SELECT position, COUNT(*)::int AS n FROM shift_requests
       WHERE shift_id = (SELECT id FROM shifts WHERE proposal_id = $1 LIMIT 1)
         AND status = 'approved' AND dropped_at IS NULL
       GROUP BY position`,
    [proposalId]
  );
  const approvedByRole = {};
  for (const r of approvedRes.rows) {
    // A NULL / non-canonical approved position counts as Bartender (the legacy
    // default, and what the migration normalized existing rows to), so the
    // per-role shrink cap can never silently drop a real assignment.
    const role = canonicalizeRole(r.position) || 'Bartender';
    approvedByRole[role] = (approvedByRole[role] || 0) + r.n;
  }
  const finalPositions = [];
  for (const role of ['Bartender', 'Banquet Server', 'Barback']) {
    const want = desired[role] || 0;
    const have = approvedByRole[role] || 0;
    const slots = Math.max(want, have);
    if (have > want) {
      await db.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
         VALUES ($1, 'staffing_shrink_capped', 'system', $2)`,
        [proposalId, JSON.stringify({ role, desired: want, approved: have, kept: slots })]
      );
    }
    for (let i = 0; i < slots; i++) finalPositions.push(role);
  }
  if (finalPositions.length === 0) finalPositions.push('Bartender');
  const positionsNeeded = JSON.stringify(finalPositions);
  // Supply-run default, applied only when an admin has not overridden it.
  const provSlugs = await provisioningSlugSet(db);
  const isHosted = await isHostedProposal(proposal, db);
  const supplyRunDefault = computeSupplyRunDefault(isHosted, addons, provSlugs);
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
      setup_minutes_before = $9,
      positions_needed = $10,
      supply_run_required = CASE WHEN supply_run_overridden THEN supply_run_required ELSE $15 END,
      client_email = $11,
      client_phone = $12,
      guest_count = $13,
      event_duration_hours = $14
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
    positionsNeeded,
    // Schema-drift sync (audit 5a): keep the denormalized shift columns in step
    // with the proposal on every admin edit (see createEventShifts for why).
    proposal.client_email || null,
    proposal.client_phone || null,
    proposal.guest_count ?? null,
    proposal.event_duration_hours ?? null,
    supplyRunDefault,
  ]);
  return upd.rows[0] || null;
}

module.exports = {
  createEventShifts,
  createDrinkPlan,
  syncShiftsFromProposal,
  deriveStaffingRoster,
  loadStaffingAddons,
};
