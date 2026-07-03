const { pool } = require('../db');
const { resolveEventTimezone } = require('./eventTimezone');
const { getHandlerMeta } = require('./scheduledMessageDispatcher');

/**
 * Constant for "10am event-local" used as the morning send hour for the
 * pre-event reminder ladder. The dispatcher metadata for each pre-event
 * message_type carries the offset in SECONDS from event_date midnight UTC
 * (e.g., event_week_reminder = -604800 = T-7 days). To land at 10am in the
 * EVENT'S timezone (not 10am UTC), we override the hour-of-day after the
 * raw offset math.
 *
 * Anchored on event date — NOT on shift start time — because these are
 * client-facing reminders that should land in the morning regardless of
 * the actual event start time.
 */
const SEND_HOUR_LOCAL = 10;

/**
 * Normalize a bare-DATE anchor value (`event_date`, `balance_due_date`) to a
 * 'YYYY-MM-DD' string. The `pg` driver returns `DATE` columns as JS `Date`
 * objects built at LOCAL midnight (no zone info on a SQL DATE), so the calendar
 * date is only recoverable via the local getters — `toISOString().slice(0,10)`
 * would shift the day on positive-offset machines. Plain strings (a literal or
 * pg text output) are sliced directly.
 *
 * @param {string|Date} value
 * @returns {string} 'YYYY-MM-DD'
 */
function toCalendarYmd(value) {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/**
 * Compute the UTC instant a pre-event (or any event-anchored) reminder should
 * send. SINGLE SOURCE OF TRUTH used by BOTH the initial scheduler
 * (`schedulePreEventReminders`) AND the reschedule cascade
 * (`reanchorPendingMessages`) so the two paths can never disagree.
 *
 * The dispatcher metadata (registered in `preEventHandlers.registerAll()` and
 * looked up via `getHandlerMeta(messageType)`) is the canonical source for
 * the offset and anchor. We read the offset in SECONDS, derive the calendar
 * day of the send, and then override the time-of-day with 10:00 IN THE
 * EVENT'S TIMEZONE so the send always lands at a tame morning hour for the
 * client (not 10am UTC, not 10am admin-local).
 *
 * @param {string} messageType - registered handler name, e.g. 'event_week_reminder'
 * @param {{ event_date: string|Date, event_timezone?: string }} proposal
 *        - or any object with the anchor field referenced by the handler meta
 * @returns {Date} UTC instant
 * @throws when the message_type has no registered handler metadata
 */
function computeScheduledFor(messageType, proposal) {
  const meta = getHandlerMeta(messageType);
  if (!meta) {
    throw new Error(`Unknown messageType: ${messageType} (no handler metadata registered — did you call registerAll() at boot?)`);
  }
  if (meta.offsetFromEventDate === null || meta.offsetFromEventDate === undefined) {
    throw new Error(`computeScheduledFor: ${messageType} is anchor-independent (null offset) — caller must compute its own send time`);
  }
  const tz = resolveEventTimezone(proposal);

  // Pick the anchor field per handler meta (event_date | balance_due_date | created_at | completed_at)
  let anchorVal = null;
  switch (meta.anchor) {
    case 'balance_due_date': anchorVal = proposal.balance_due_date; break;
    case 'created_at':       anchorVal = proposal.created_at; break;
    case 'completed_at':     anchorVal = proposal.completed_at; break;
    case 'event_date':
    default:                 anchorVal = proposal.event_date; break;
  }
  if (!anchorVal) {
    throw new Error(`computeScheduledFor: ${messageType} requires anchor=${meta.anchor} but proposal lacks that field`);
  }

  // Parse anchor as a calendar date (treat as midnight UTC for the day-math)
  // and apply the offset in seconds. `anchorVal` may arrive as a string OR a
  // pg `Date` object — toCalendarYmd normalizes both to 'YYYY-MM-DD'.
  const anchorStr = toCalendarYmd(anchorVal);
  const [y, m, d] = anchorStr.split('-').map(Number);
  const shiftedUtcMs = Date.UTC(y, m - 1, d) + meta.offsetFromEventDate * 1000;
  const shiftedDate = new Date(shiftedUtcMs);
  const shiftedYear = shiftedDate.getUTCFullYear();
  const shiftedMonth = shiftedDate.getUTCMonth() + 1;
  const shiftedDay = shiftedDate.getUTCDate();

  // Now compute "10:00 in tz on the shifted calendar date" → UTC.
  // Read the actual TZ offset Intl reports for noon UTC on the shifted day —
  // this handles DST transitions correctly because we ask about the specific
  // date, not the current date.
  const noonUtc = new Date(Date.UTC(shiftedYear, shiftedMonth - 1, shiftedDay, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(noonUtc);
  const offsetPart = parts.find((p) => p.type === 'timeZoneName').value; // e.g. "GMT-5"
  const match = /GMT([+-]?\d{1,2})(?::(\d{2}))?/.exec(offsetPart);
  const tzHours = match ? Number(match[1]) : 0;
  const tzMinutes = match && match[2] ? Number(match[2]) * (tzHours >= 0 ? 1 : -1) : 0;
  // 10:00 local → (10 - tzHours) UTC, with minute adjustment if any
  const utcHour = SEND_HOUR_LOCAL - tzHours;
  const utcMinute = -tzMinutes;
  return new Date(Date.UTC(shiftedYear, shiftedMonth - 1, shiftedDay, utcHour, utcMinute, 0));
}

/**
 * @param {{ event_date: string|Date|null, created_at: string|Date|null }} proposal
 * @returns {boolean}
 */
function shouldScheduleLongLeadRecap(proposal) {
  if (!proposal.event_date || !proposal.created_at) return false;
  // event_date may arrive as a string or a pg `Date` — normalize the calendar
  // date, then anchor at midnight UTC for the lead-time math. created_at is a
  // real TIMESTAMPTZ instant, so `new Date()` on it directly is correct.
  const eventMs = new Date(toCalendarYmd(proposal.event_date) + 'T00:00:00Z').getTime();
  const bookedMs = new Date(proposal.created_at).getTime();
  if (!Number.isFinite(eventMs) || !Number.isFinite(bookedMs)) return false;
  const leadDays = (eventMs - bookedMs) / (24 * 3600 * 1000);
  return leadDays >= 90;
}

/**
 * Insert pending `scheduled_messages` rows for every pre-event reminder
 * applicable to this proposal. Idempotent: if a row for the same (entity,
 * message_type, recipient, channel) already exists, the insert is skipped.
 *
 * Skips entirely for archived proposals.
 *
 * Called from two anchor points:
 *   1. The Stripe `payment_intent.succeeded` post-commit notifier when the
 *      deposit / full / coupled-sign+pay branch fires (initial schedule).
 *      Plan 2a also calls sibling `scheduleBalanceReminders` from the same
 *      anchor point.
 *   2. The reschedule cascade in `rescheduleProposalInTx` AFTER the reanchor
 *      pass, to add NEW long-lead rows when a reschedule moves the event
 *      into a 90+ day window (Pre-execution Finding W4).
 *
 * The optional `executor` parameter lets callers pass in a pg client that
 * already holds an open transaction (case #2). When omitted (case #1), the
 * function uses `pool` and each query runs in its own implicit transaction.
 *
 * @param {number|string} proposalId
 * @param {{ query: (text: string, params?: any[]) => Promise<any> }} [executor]
 *        - pg PoolClient or pool; defaults to `pool` if not supplied
 */
async function schedulePreEventReminders(proposalId, executor) {
  const exec = executor || pool;
  const { rows } = await exec.query(
    `SELECT p.id, p.client_id, p.status, p.event_date, p.event_start_time,
            p.event_timezone, p.created_at
       FROM proposals p
      WHERE p.id = $1`,
    [proposalId]
  );
  const proposal = rows[0];
  if (!proposal) return;
  if (proposal.status === 'archived') return;
  if (!proposal.client_id || !proposal.event_date) return;

  // Always schedule the event-week reminder
  await insertIfMissing(exec, {
    entityType: 'proposal',
    entityId: proposal.id,
    messageType: 'event_week_reminder',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: computeScheduledFor('event_week_reminder', proposal),
  });

  // Conditionally schedule the T-30 long-lead recap
  if (shouldScheduleLongLeadRecap(proposal)) {
    await insertIfMissing(exec, {
      entityType: 'proposal',
      entityId: proposal.id,
      messageType: 'long_lead_t30_recap',
      recipientType: 'client',
      recipientId: proposal.client_id,
      channel: 'email',
      scheduledFor: computeScheduledFor('long_lead_t30_recap', proposal),
    });
  }

  // Comms Phase 3: drink-plan nudge (email + SMS), T-21 days, 10:00 event-local.
  // Delegated to drinkPlanNudge.js so this file does not grow. require() is
  // inline to avoid a load-order cycle (drinkPlanNudge.js requires
  // computeScheduledFor from this file).
  try {
    const { scheduleDrinkPlanNudge } = require('./drinkPlanNudge');
    await scheduleDrinkPlanNudge(proposalId, exec);
  } catch (nudgeErr) {
    // Best-effort relative to the always-on event_week_reminder above.
    console.warn('[schedulePreEventReminders] drink-plan nudge scheduling failed (non-fatal):', nudgeErr.message);
  }

  // Comms Phase 3: event-eve SMS, T-24h from event start (bespoke timing).
  // Delegated to eventEveSms.js. scheduleEventEve is reschedule-correct (it
  // deletes any stale pending row and re-inserts), so re-invoking it from the
  // reschedule cascade moves the touch even though its null offset means
  // reanchorPendingMessages skips it.
  try {
    const { scheduleEventEve } = require('./eventEveSms');
    await scheduleEventEve(proposalId, exec);
  } catch (eveErr) {
    console.warn('[schedulePreEventReminders] event-eve scheduling failed (non-fatal):', eveErr.message);
  }
}

/**
 * Idempotent insert helper. First checks for an existing pending/sent/deferred
 * row with the same (entity, message_type, recipient, channel) and returns
 * without inserting if one already exists. Otherwise inserts the row.
 *
 * The INSERT runs DIRECTLY on the passed `executor` (pg client OR pool) so it
 * joins the caller's open transaction when one is supplied — `rescheduleProposalInTx`
 * relies on the new long-lead rows landing inside its transaction. Delegating to
 * `scheduleMessage` would route the INSERT through the module-level `pool`,
 * escaping the caller's transaction and breaking atomicity.
 *
 * The INSERT mirrors `scheduleMessage`'s statement exactly (same column list and
 * partial-unique `ON CONFLICT ... DO NOTHING` guard) so the two paths can never
 * disagree on shape.
 *
 * @param {{ query: Function }} executor - pg client or pool
 * @param {object} args - insert args
 */
async function insertIfMissing(executor, {
  entityType, entityId, messageType, recipientType, recipientId, channel, scheduledFor,
}) {
  const existing = await executor.query(
    `SELECT id FROM scheduled_messages
      WHERE entity_type = $1 AND entity_id = $2
        AND message_type = $3
        AND recipient_type = $4 AND recipient_id = $5
        AND channel = $6
        AND status IN ('pending', 'processing', 'sent', 'deferred')
      LIMIT 1`,
    [entityType, entityId, messageType, recipientType, recipientId, channel]
  );
  if (existing.rows.length > 0) return;
  // INSERT on `executor` (not `pool`) so the row joins the caller's transaction
  // when one is open. ON CONFLICT mirrors scheduleMessage's partial-unique guard.
  await executor.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
       WHERE status = 'pending'
     DO NOTHING`,
    [entityId, entityType, messageType, recipientType, recipientId, channel, scheduledFor]
  );
}

module.exports = {
  computeScheduledFor,
  shouldScheduleLongLeadRecap,
  schedulePreEventReminders,
  SEND_HOUR_LOCAL,
};
