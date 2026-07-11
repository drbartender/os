const { pool } = require('../db');
const { registerHandler } = require('./scheduledMessageDispatcher');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { resolveEventTimezone, formatEventLocalTime } = require('./eventTimezone');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');

/**
 * Look up the proposal + client + package data needed to render any pre-event
 * client email. Centralized here so both handlers below get the same shape.
 *
 * @param {number} proposalId
 * @returns {object|null} composite row, or null if proposal/client gone
 */
async function loadProposalContext(proposalId) {
  // event_date / balance_due_date are cast ::text because pg returns DATE as a
  // JS Date object (there is no global type parser), and the formatters below do
  // String(date).slice(0,10) expecting 'YYYY-MM-DD'. A Date object stringifies to
  // "Sat Aug 15 2026 ..." → slice → an Invalid Date (Sentry SERVER-Z). Casting on
  // the server gives the helpers the shape they document. Mirrors the cast in
  // lastMinuteStaffingConfirmation.js.
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.status, p.event_date::text AS event_date, p.event_start_time,
            p.event_timezone, p.event_location, p.event_type, p.event_type_custom,
            p.guest_count, p.total_price, p.amount_paid, p.balance_due_date::text AS balance_due_date,
            p.autopay_enrolled, p.pricing_snapshot,
            c.id AS client_id, c.name AS client_name, c.email AS client_email,
            sp.name AS package_name, sp.slug AS package_slug, sp.category AS package_category
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.id = $1`,
    [proposalId]
  );
  return rows[0] || null;
}

/** Extract first name from a "First Last" string. Returns null if input is blank. */
function firstNameOf(fullName) {
  if (!fullName) return null;
  const first = String(fullName).trim().split(/\s+/)[0];
  return first || null;
}

/** Format event_date as a friendly day-of-week + month + day + year in event TZ. */
function formatEventDateLong(proposal) {
  const tz = resolveEventTimezone(proposal);
  // event_date is YYYY-MM-DD; combine with noon so we don't accidentally fall
  // back a day under negative-offset TZs.
  // Validate the source field first: a null/blank/malformed event_date would
  // build an Invalid Date and crash a scheduled reminder mid-dispatch
  // (Sentry DRBARTENDER-SERVER-Z). Fail with a message naming the field so the
  // dispatcher's Sentry capture (which carries the proposal id) is actionable.
  const raw = (proposal && proposal.event_date) ? String(proposal.event_date).slice(0, 10) : '';
  const d = new Date(raw + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) {
    throw new Error(`formatEventDateLong: invalid or missing event_date (received ${JSON.stringify(proposal && proposal.event_date)})`);
  }
  return formatEventLocalTime(d, tz, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Format start_time as "6:00 PM Central" — short 12-hour time + TZ abbreviation.
 *
 * IMPORTANT: `event_start_time` is wall-clock event-local time stored as a
 * string (e.g., '18:00' or '6:00 PM') — NOT a UTC ISO timestamp. We MUST NOT
 * parse it as UTC (e.g., `new Date('2026-08-15T18:00:00Z')`) and then format
 * in the event TZ — that would shift Chicago 18:00 to 13:00 ("1:00 PM CDT").
 *
 * Instead we format the literal string with `formatTime12` (string-based
 * 12-hour conversion that lives in `server/utils/eventCreation.js`) and
 * append the TZ abbreviation derived from the proposal's event_date in the
 * resolved TZ. The TZ abbreviation comes from `Intl.DateTimeFormat` with
 * `timeZoneName: 'short'` (e.g., "CDT", "EST", "PT").
 */
function formatStartTimeShort(proposal) {
  if (!proposal.event_start_time) return 'TBD';
  const tz = resolveEventTimezone(proposal);
  // Reuse the existing string-based 12-hour formatter so we never round-trip
  // through UTC. Accepts '18:00' or '6:00 PM' or '6:00 pm'.
  const raw = String(proposal.event_start_time).trim();
  let time12 = raw;
  // If it's a 24-hour HH:MM, convert. Otherwise pass through (already 12-hour).
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (hhmm) {
    const h = Number(hhmm[1]);
    const m = Number(hhmm[2]);
    if (Number.isFinite(h) && Number.isFinite(m)) {
      const hour12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
      const ampm = h >= 12 ? 'PM' : 'AM';
      time12 = `${hour12}:${String(m).padStart(2, '0')} ${ampm}`;
    }
  }
  // Derive the TZ abbreviation for the event date in the resolved zone.
  // Use the event_date at noon UTC as the reference instant — we just need a
  // moment near the event so DST is correct; the abbreviation is what we
  // pull out of formatToParts.
  let tzAbbrev = '';
  try {
    const dateStr = String(proposal.event_date || '').slice(0, 10);
    const refMs = Date.parse(`${dateStr}T12:00:00Z`);
    if (Number.isFinite(refMs)) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'short',
      }).formatToParts(new Date(refMs));
      const tzPart = parts.find((p) => p.type === 'timeZoneName');
      if (tzPart && tzPart.value) tzAbbrev = ` ${tzPart.value}`;
    }
  } catch (_e) { /* leave tzAbbrev empty */ }
  return `${time12}${tzAbbrev}`;
}

/** Format balance_due_date in event TZ as "June 8, 2026". Returns '' if null. */
function formatBalanceDueDate(proposal) {
  if (!proposal.balance_due_date) return '';
  const tz = resolveEventTimezone(proposal);
  const d = new Date(String(proposal.balance_due_date).slice(0, 10) + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return ''; // malformed date → omit (optional field), don't throw
  return formatEventLocalTime(d, tz, { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Render a one-line drinks summary from the pricing snapshot or drink_plan.
 *
 * MVP fallback when no detailed selection data is available: return
 * 'Drink plan submitted'. Plan 2d's drink-plan touches will refine this.
 */
function buildDrinksSummary(proposal) {
  const snap = proposal.pricing_snapshot || {};
  if (snap && snap.package && snap.package.name) {
    return `${snap.package.name}, selections in your portal`;
  }
  return 'Drink plan submitted';
}

/** Map package category to bar_option for the T-30 BYOB/Hosted branch. */
function barOptionFor(proposal) {
  // Hosted packages have category 'hosted' in service_packages; default to byob otherwise.
  return proposal.package_category === 'hosted' ? 'hosted' : 'byob';
}

/**
 * Handler: event_week_reminder
 * Renders eventWeekReminderClient + sends via sendEmail. Throws on failure so
 * the dispatcher marks the row 'failed' and surfaces to Sentry.
 *
 * The dispatcher passes `entity` = the proposal row (its `id` is the proposal
 * id) and `recipient` = the client row (its `id` is the client id).
 */
async function handleEventWeekReminder({ entity, recipient, scheduledMessage: _sm }) {
  const proposalId = entity.id;
  const ctx = await loadProposalContext(proposalId);
  if (!ctx) throw new Error(`event_week_reminder: proposal ${proposalId} not found`);
  if (!ctx.client_email) {
    // No address to send to — let the dispatcher mark this 'failed' so the
    // delivery-failure fallback logic in Plan 2a's dispatcher kicks in if
    // configured. If that fallback isn't yet implemented, the row just records
    // the error for admin review.
    throw new Error(`event_week_reminder: client ${recipient.id} has no email`);
  }
  if (ctx.status === 'archived') {
    // Defensive — dispatcher should already have suppressed via the archive
    // cascade. If we get here, throw rather than send.
    throw new Error(`event_week_reminder: proposal ${proposalId} is archived — should have been suppressed`);
  }

  const tpl = emailTemplates.eventWeekReminderClient({
    clientName: ctx.client_name,
    clientFirstName: firstNameOf(ctx.client_name),
    eventDateLocal: formatEventDateLong(ctx),
    startTimeLocal: formatStartTimeShort(ctx),
    location: ctx.event_location,
    guestCount: ctx.guest_count,
    packageName: ctx.package_name || getEventTypeLabel({ event_type: ctx.event_type, event_type_custom: ctx.event_type_custom }),
    proposalUrl: ctx.token ? `${PUBLIC_SITE_URL}/proposal/${ctx.token}` : null,
  });

  await sendEmail({ to: ctx.client_email, ...tpl });
}

/**
 * Handler: long_lead_t30_recap
 * BYOB-conditional shopping-list block. Skips (throws) if drink_plan or
 * shopping_list are not yet ready — the regular drink-plan nudge in Plan 2d
 * handles that case. The check is performed at send time, not schedule time,
 * because the artifacts may land any time between deposit and T-30.
 */
async function handleLongLeadT30Recap({ entity, recipient, scheduledMessage: _sm }) {
  const proposalId = entity.id;
  const ctx = await loadProposalContext(proposalId);
  if (!ctx) throw new Error(`long_lead_t30_recap: proposal ${proposalId} not found`);
  if (!ctx.client_email) {
    throw new Error(`long_lead_t30_recap: client ${recipient.id} has no email`);
  }
  if (ctx.status === 'archived') {
    throw new Error(`long_lead_t30_recap: proposal ${proposalId} archived — should have been suppressed`);
  }

  // Per spec section 1.6: suppress (don't send) if drink plan or shopping list
  // not yet ready. The regular drink-plan nudge (Plan 2d) covers that path.
  // We check by looking up the drink_plans row for this proposal and its
  // shopping_list_status, which exist today in the schema.
  const drinkRes = await pool.query(
    `SELECT dp.selections, dp.consult_filled_at, dp.shopping_list_status
       FROM drink_plans dp
      WHERE dp.proposal_id = $1
      LIMIT 1`,
    [proposalId]
  );
  const drink = drinkRes.rows[0];
  const planReady = drink && (
    (drink.selections !== null && drink.selections !== undefined)
    || (drink.consult_filled_at !== null && drink.consult_filled_at !== undefined)
  );
  const shoppingReady = drink && drink.shopping_list_status === 'approved';
  const isHosted = barOptionFor(ctx) === 'hosted';

  // Hosted events don't need a shopping list — only the drink plan must be ready.
  // BYOB needs both.
  if (!planReady) {
    throw new Error(`long_lead_t30_recap: drink plan not ready for proposal ${proposalId} — drink-plan nudge handles this case`);
  }
  if (!isHosted && !shoppingReady) {
    throw new Error(`long_lead_t30_recap: shopping list not ready for BYOB proposal ${proposalId} — drink-plan nudge handles this case`);
  }

  const shoppingListUrl = !isHosted && ctx.token
    ? `${PUBLIC_SITE_URL}/shopping-list/${ctx.token}`
    : '';

  const tpl = emailTemplates.longLeadT30RecapClient({
    clientName: ctx.client_name,
    clientFirstName: firstNameOf(ctx.client_name),
    eventDateLocal: formatEventDateLong(ctx),
    drinksSummary: buildDrinksSummary(ctx),
    shoppingListUrl,
    barOption: isHosted ? 'hosted' : 'byob',
  });

  await sendEmail({ to: ctx.client_email, ...tpl });
}

/**
 * Idempotent registration entry point. Call once from server bootstrap.
 *
 * Both handlers register with metadata so Plan 2c's reschedule cascade can
 * recompute scheduled_for via `getHandlerMeta(messageType)` (Plan 2a Task 9).
 * Offset is in SECONDS (negative = before anchor). Anchor is `event_date`
 * because these are the pre-event reminder ladder; balance reminders use
 * `balance_due_date` (registered in Plan 2a).
 */
const DAY_SECONDS = 86400;
function registerAll() {
  registerHandler('event_week_reminder', handleEventWeekReminder, {
    offsetFromEventDate: -7 * DAY_SECONDS,
    anchor: 'event_date',
    category: 'operational',
    priority: 3,
  });
  registerHandler('long_lead_t30_recap', handleLongLeadT30Recap, {
    offsetFromEventDate: -30 * DAY_SECONDS,
    anchor: 'event_date',
    category: 'operational',
    priority: 3,
  });
}

module.exports = {
  registerAll,
  handleEventWeekReminder,
  handleLongLeadT30Recap,
  // Exported for test seams:
  loadProposalContext,
  firstNameOf,
  formatEventDateLong,
  formatStartTimeShort,
  formatBalanceDueDate,
};
