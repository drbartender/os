/**
 * Event-eve SMS — a full SMS-only touch (spec 3.12). T-24h from the event
 * START time, in the event timezone. This timing is NOT the 10:00-event-local
 * convention of computeScheduledFor, so the touch registers with
 * offsetFromEventDate: null (the generic reschedule cascade skips it) and
 * computes its own send instant via computeEventEveSendAt.
 *
 * Cooldown-exempt: priority 1, cooldownExempt true (inert until Phase 4b — the
 * event-eve SMS must fire on its exact day regardless of the daily-cooldown
 * rule, per spec 7.4).
 *
 * Reschedule: because the row has a null offset, reanchorPendingMessages leaves
 * it alone. scheduleEventEve is therefore written to DELETE any stale pending
 * event_eve row and re-INSERT at the recomputed instant; rescheduleProposalInTx
 * already re-invokes schedulePreEventReminders after its reanchor pass, and
 * schedulePreEventReminders calls scheduleEventEve — so a reschedule does move
 * this row.
 */
const { pool } = require('../db');
const { registerHandler } = require('./scheduledMessageDispatcher');
const { sendAndLogSms } = require('./sms');
const smsTemplates = require('./smsTemplates');
const { resolveEventTimezone } = require('./eventTimezone');
const { effectiveSetupMinutes } = require('./setupTime');

/**
 * Parse an event-local wall-clock start time string ('18:00' or '6:00 PM')
 * into { hour, minute } 24-hour numbers. Returns { hour: 12, minute: 0 } as a
 * tame fallback when unparseable (noon — never a midnight day-shift surprise).
 */
function parseStartTime(timeStr) {
  if (timeStr === null || timeStr === undefined) return { hour: 12, minute: 0 };
  const cleaned = String(timeStr).trim().toUpperCase();
  const m = cleaned.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  if (!m) return { hour: 12, minute: 0 };
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3];
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59) return { hour: 12, minute: 0 };
  if (ampm) {
    if (h < 1 || h > 12) return { hour: 12, minute: 0 };
    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
  } else if (h > 23) {
    return { hour: 12, minute: 0 };
  }
  return { hour: h, minute: min };
}

/**
 * The UTC instant the event-eve SMS should send: the event start moment in the
 * event timezone, minus 24 hours.
 *
 * @param {{ event_date: string|Date, event_start_time: string, event_timezone?: string }} proposal
 * @returns {Date} UTC instant
 */
function computeEventEveSendAt(proposal) {
  const tz = resolveEventTimezone(proposal);
  const ymd = (proposal.event_date instanceof Date)
    ? `${proposal.event_date.getFullYear()}-${String(proposal.event_date.getMonth() + 1).padStart(2, '0')}-${String(proposal.event_date.getDate()).padStart(2, '0')}`
    : String(proposal.event_date).slice(0, 10);
  const [y, mo, d] = ymd.split('-').map(Number);
  const { hour, minute } = parseStartTime(proposal.event_start_time);

  const noonUtc = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, timeZoneName: 'shortOffset', hour: '2-digit', hour12: false,
  });
  const offsetPart = fmt.formatToParts(noonUtc).find((p) => p.type === 'timeZoneName').value;
  const match = /GMT([+-]?\d{1,2})(?::(\d{2}))?/.exec(offsetPart);
  const tzHours = match ? Number(match[1]) : 0;
  const tzMinutes = match && match[2] ? Number(match[2]) * (tzHours >= 0 ? 1 : -1) : 0;

  const startUtcMs = Date.UTC(y, mo - 1, d, hour - tzHours, minute - tzMinutes, 0);
  return new Date(startUtcMs - 24 * 3600 * 1000);
}

/**
 * Format the event-local start time as "6:00 PM CDT" for the SMS body.
 */
function formatStartTimeLocal(proposal) {
  const tz = resolveEventTimezone(proposal);
  const { hour, minute } = parseStartTime(proposal.event_start_time);
  const hour12 = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const time12 = `${hour12}:${String(minute).padStart(2, '0')} ${ampm}`;
  let tzAbbrev = '';
  try {
    const ymd = String(proposal.event_date).slice(0, 10);
    const refMs = Date.parse(`${ymd}T12:00:00Z`);
    if (Number.isFinite(refMs)) {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
        .formatToParts(new Date(refMs));
      const tzPart = parts.find((p) => p.type === 'timeZoneName');
      if (tzPart && tzPart.value) tzAbbrev = ` ${tzPart.value}`;
    }
  } catch (_e) { /* leave empty */ }
  return `${time12}${tzAbbrev}`;
}

/**
 * Resolve the assigned bartender: the first approved shift_requests row joined
 * to contractor_profiles. Returns { name, phone } or { name: null, phone: null }.
 */
async function resolveBartender(proposalId) {
  const { rows } = await pool.query(
    `SELECT cp.preferred_name AS name, cp.phone AS phone
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
      WHERE s.proposal_id = $1
        AND sr.status = 'approved'
      ORDER BY sr.updated_at ASC
      LIMIT 1`,
    [proposalId]
  );
  if (rows.length === 0) return { name: null, phone: null };
  return { name: rows[0].name || null, phone: rows[0].phone || null };
}

/**
 * Handler: event_eve. Renders the event-eve SMS and sends via sendAndLogSms.
 */
async function handleEventEve({ entity }) {
  const proposalId = entity.id;
  const { rows } = await pool.query(
    `SELECT p.id, p.status, p.event_date, p.event_start_time, p.event_location,
            p.event_timezone, p.setup_minutes_before, p.pricing_snapshot,
            c.id AS client_id, c.name AS client_name, c.phone AS client_phone,
            c.communication_preferences AS comm_prefs, c.phone_status
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );
  const ctx = rows[0];
  if (!ctx) throw new Error(`event_eve: proposal ${proposalId} not found`);
  if (ctx.status === 'archived') throw new Error('event_eve: proposal archived');
  if (!ctx.client_phone) throw new Error('event_eve: client has no phone');
  if (ctx.phone_status === 'bad') throw new Error('event_eve: client phone_status is bad');
  const prefs = ctx.comm_prefs || {};
  if (prefs.sms_enabled === false) throw new Error('event_eve: sms_enabled is false');

  const bartender = await resolveBartender(proposalId);
  const setupMinutes = effectiveSetupMinutes(
    { setup_minutes_before: ctx.setup_minutes_before, pricing_snapshot: ctx.pricing_snapshot },
    null
  );
  const body = smsTemplates.eventEveSms({
    startTime: formatStartTimeLocal(ctx),
    location: ctx.event_location,
    bartenderName: bartender.name,
    bartenderPhone: bartender.phone,
    setupMinutes,
  });
  await sendAndLogSms({
    to: ctx.client_phone,
    body,
    clientId: ctx.client_id,
    messageType: 'event_eve',
    recipientName: ctx.client_name || null,
  });
}

function registerEventEveHandler() {
  registerHandler('event_eve', handleEventEve, {
    offsetFromEventDate: null,
    anchor: 'event_date',
    category: 'operational',
    priority: 1,
    cooldownExempt: true,
  });
}

/**
 * Insert (or, on reschedule, re-insert) the event_eve scheduled_messages row.
 * @param {number|string} proposalId
 * @param {{ query: Function }} [executor] - pg client or pool; defaults to pool.
 */
async function scheduleEventEve(proposalId, executor) {
  const exec = executor || pool;
  const { rows } = await exec.query(
    `SELECT id, client_id, status, event_date, event_start_time, event_timezone
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = rows[0];
  if (!proposal) return;
  if (proposal.status === 'archived') return;
  if (!proposal.client_id || !proposal.event_date || !proposal.event_start_time) return;

  const sendAt = computeEventEveSendAt(proposal);
  if (!(sendAt instanceof Date) || Number.isNaN(sendAt.getTime())) return;
  if (sendAt.getTime() <= Date.now()) {
    await exec.query(
      `DELETE FROM scheduled_messages
        WHERE entity_type = 'proposal' AND entity_id = $1
          AND message_type = 'event_eve' AND status = 'pending'`,
      [proposalId]
    );
    return;
  }

  await exec.query(
    `DELETE FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1
        AND message_type = 'event_eve' AND status = 'pending'`,
    [proposalId]
  );
  await exec.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'event_eve', 'client', $2, 'sms', $3)
     ON CONFLICT (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
       WHERE status = 'pending'
     DO NOTHING`,
    [Number(proposalId), proposal.client_id, sendAt]
  );
}

module.exports = {
  registerEventEveHandler,
  scheduleEventEve,
  computeEventEveSendAt,
  formatStartTimeLocal,
  resolveBartender,
};
