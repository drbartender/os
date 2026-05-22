/**
 * Staff-shift SMS timing + dispatcher handlers (Phase 4a). Two touches:
 *
 *   1. shift_reminder — fires at the event START instant minus 24 hours, in
 *      the EVENT timezone. NOT the 10:00-event-local convention of
 *      computeScheduledFor; this touch computes its own send instant via
 *      computeShiftReminderScheduledFor.
 *
 *   2. staff_thank_you — fires at the event END instant plus 30 minutes,
 *      in the EVENT timezone. Same bespoke-timing rationale.
 *
 * shifts has no timezone of its own. The event TZ, event_date,
 * event_start_time, and event_duration_hours come from the linked proposals
 * row via shifts.proposal_id. event_start_time is wall-clock event-local
 * text ("18:00" or "6:00 PM"); it must NOT be parsed as UTC.
 *
 * The timezone math in this module is the same shape Phase 3's eventEveSms.js
 * used and was reviewer-verified for summer AND winter dates.
 *
 * Task 2 ships the pure timing helpers only. Task 3 will add the scheduling
 * helper; Task 5 will add the dispatcher handlers to this same file.
 */
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { resolveEventTimezone, formatEventLocalTime } = require('./eventTimezone');
const { getEventTypeLabel } = require('./eventTypes');
const { subtractMinutesFromTime } = require('./setupTime');
const { PUBLIC_SITE_URL } = require('./urls');
const { registerHandler } = require('./scheduledMessageDispatcher');
const { sendAndLogSms } = require('./sms');
const { sendEmail } = require('./email');
const smsTemplates = require('./smsTemplates');

// ─── Timing helpers ──────────────────────────────────────────────
// shift_reminder fires at event start minus 24h; staff_thank_you fires at
// event end plus 30 min. Both compute in the EVENT timezone. event_start_time
// is wall-clock event-local text, never a UTC ISO string.

const DAY_MS = 24 * 60 * 60 * 1000;
const THANK_YOU_OFFSET_MS = 30 * 60 * 1000;

/**
 * Coerce a date-like value to a calendar YYYY-MM-DD string using its LOCAL
 * components (no timezone shift). Accepts a Date instance, an ISO date
 * string, or any string whose first 10 characters are already YYYY-MM-DD.
 * Returns null for null / undefined / empty / invalid Date inputs.
 *
 * @param {Date|string|null|undefined} value
 * @returns {string|null}
 */
function toCalendarYmd(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/**
 * Parse an event-local wall-clock start time string into 24-hour
 * { hour, minute } numbers. Accepts either 24-hour "HH:MM" (e.g. "18:00")
 * or 12-hour "H:MM AM/PM" (e.g. "6:00 PM"). Returns null on any malformed
 * input — callers treat null as "cannot schedule" rather than substituting
 * a default time.
 *
 * @param {string|null|undefined} raw
 * @returns {{ hour: number, minute: number }|null}
 */
function parseClockTime(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // 24-hour HH:MM
  let m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return { hour: h, minute: min };
    return null;
  }
  // 12-hour H:MM AM/PM
  m = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/.exec(s);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const pm = /p/i.test(m[3]);
    if (h < 1 || h > 12 || min < 0 || min > 59) return null;
    if (h === 12) h = 0;
    if (pm) h += 12;
    return { hour: h, minute: min };
  }
  return null;
}

/**
 * Convert a calendar date + wall-clock time in an event-local timezone to
 * the corresponding UTC instant. Uses Intl.DateTimeFormat with
 * timeZoneName: 'shortOffset' to read the offset that applies on the given
 * date in the given zone (so summer / winter DST are both honored).
 *
 * @param {string} ymd YYYY-MM-DD calendar date
 * @param {number} hour 0-23 event-local hour
 * @param {number} minute 0-59 event-local minute
 * @param {string} tz IANA timezone identifier (e.g. "America/Chicago")
 * @returns {Date} UTC instant
 */
function eventLocalToUtc(ymd, hour, minute, tz) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(noonUtc);
  const offsetPart = parts.find((p) => p.type === 'timeZoneName').value;
  const match = /GMT([+-]?\d{1,2})(?::(\d{2}))?/.exec(offsetPart);
  const tzHours = match ? Number(match[1]) : 0;
  const tzMinutes = match && match[2] ? Number(match[2]) * (tzHours >= 0 ? 1 : -1) : 0;
  return new Date(Date.UTC(y, mo - 1, d, hour - tzHours, minute - tzMinutes, 0));
}

/**
 * Compute the UTC instant of an event's START moment from an event/proposal
 * row carrying event_date, event_start_time, and optionally event_timezone.
 * Returns null when event_date or event_start_time is missing/malformed.
 *
 * @param {{ event_date: string|Date, event_start_time: string, event_timezone?: string }} ev
 * @returns {Date|null}
 */
function computeEventStartUtc(ev) {
  const ymd = toCalendarYmd(ev.event_date);
  if (!ymd) return null;
  const clock = parseClockTime(ev.event_start_time);
  if (!clock) return null;
  const tz = resolveEventTimezone(ev);
  return eventLocalToUtc(ymd, clock.hour, clock.minute, tz);
}

/**
 * Compute the UTC instant the shift_reminder SMS should send: the event
 * start moment minus 24 hours. Returns null when the event's start instant
 * cannot be resolved.
 *
 * @param {{ event_date: string|Date, event_start_time: string, event_timezone?: string }} ev
 * @returns {Date|null}
 */
function computeShiftReminderScheduledFor(ev) {
  const start = computeEventStartUtc(ev);
  if (!start) return null;
  return new Date(start.getTime() - DAY_MS);
}

/**
 * Compute the UTC instant the staff_thank_you SMS should send: the event
 * end moment plus 30 minutes. End = start + event_duration_hours. Returns
 * null when the event's start instant cannot be resolved or when
 * event_duration_hours is missing / not a positive finite number.
 *
 * @param {{ event_date: string|Date, event_start_time: string, event_duration_hours: number|string, event_timezone?: string }} ev
 * @returns {Date|null}
 */
function computeStaffThankYouScheduledFor(ev) {
  const start = computeEventStartUtc(ev);
  if (!start) return null;
  const durationHours = Number(ev.event_duration_hours);
  if (!Number.isFinite(durationHours) || durationHours <= 0) return null;
  const end = start.getTime() + durationHours * 60 * 60 * 1000;
  return new Date(end + THANK_YOU_OFFSET_MS);
}

// ─── Shared assignment scheduler ─────────────────────────────────

/**
 * Idempotent insert helper. SELECTs for ANY existing row on the natural key
 * (entity, message_type, recipient, channel) first, then INSERTs only when
 * none exists. INSERT runs DIRECTLY on the passed `executor` (pg client OR
 * pool) so it joins the caller's open transaction when one is supplied.
 *
 * The existence check intentionally has NO status filter — unlike
 * preEventScheduling.insertIfMissing, which only skips on
 * pending/sent/deferred. A staff message that hit a terminal `failed` or
 * `suppressed` state must NOT be recreated as a fresh `pending` row on the
 * next assignment or schedule-change: that would endlessly resurrect terminal
 * rows. So ANY row for the natural key counts as "already exists" and the
 * insert is skipped.
 */
async function insertShiftMessageIfMissing(executor, {
  entityType, entityId, messageType, recipientType, recipientId, channel, scheduledFor,
}) {
  const existing = await executor.query(
    `SELECT id FROM scheduled_messages
      WHERE entity_type = $1 AND entity_id = $2
        AND message_type = $3
        AND recipient_type = $4 AND recipient_id = $5
        AND channel = $6
      LIMIT 1`,
    [entityType, entityId, messageType, recipientType, recipientId, channel]
  );
  if (existing.rows.length > 0) return;
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

/**
 * Schedule the day-before reminder and post-event thank-you SMS for every
 * currently-approved staffer on a shift. Idempotent — re-running on an
 * already-scheduled shift is a no-op. Best-effort by contract: the caller
 * wraps this in try/catch + Sentry; the inner guard here is defense in depth.
 *
 * Skips silently when:
 *   - the shift has no linked proposal (legacy hand-built shift), or
 *   - the linked proposal is archived, or
 *   - the event start/end instant cannot be computed (missing date/time).
 *
 * @param {number|string} shiftId
 * @param {{query: Function}} [executor] - pg client or pool; defaults to pool
 * @returns {Promise<{reminder: number, thankYou: number}>}
 */
async function scheduleStaffShiftMessages(shiftId, executor) {
  const exec = executor || pool;
  let inserted = { reminder: 0, thankYou: 0 };
  try {
    const { rows } = await exec.query(
      `SELECT s.id AS shift_id, s.proposal_id,
              p.status AS proposal_status,
              p.event_date, p.event_start_time, p.event_duration_hours,
              p.event_timezone
         FROM shifts s
         LEFT JOIN proposals p ON p.id = s.proposal_id
        WHERE s.id = $1`,
      [shiftId]
    );
    const shift = rows[0];
    if (!shift || !shift.proposal_id) return inserted;
    if (shift.proposal_status === 'archived') return inserted;

    const reminderAt = computeShiftReminderScheduledFor(shift);
    const thankYouAt = computeStaffThankYouScheduledFor(shift);
    if (!reminderAt && !thankYouAt) return inserted;

    const staffRes = await exec.query(
      `SELECT user_id FROM shift_requests
        WHERE shift_id = $1 AND status = 'approved'`,
      [shiftId]
    );

    for (const row of staffRes.rows) {
      if (reminderAt) {
        await insertShiftMessageIfMissing(exec, {
          entityType: 'shift',
          entityId: Number(shiftId),
          messageType: 'shift_reminder',
          recipientType: 'staff',
          recipientId: row.user_id,
          channel: 'sms',
          scheduledFor: reminderAt,
        });
        inserted.reminder += 1;
      }
      if (thankYouAt) {
        await insertShiftMessageIfMissing(exec, {
          entityType: 'shift',
          entityId: Number(shiftId),
          messageType: 'staff_thank_you',
          recipientType: 'staff',
          recipientId: row.user_id,
          channel: 'sms',
          scheduledFor: thankYouAt,
        });
        inserted.thankYou += 1;
      }
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: 'staffShiftHandlers', step: 'scheduleStaffShiftMessages' },
      extra: { shiftId },
    });
    console.error('[staffShiftHandlers] scheduleStaffShiftMessages failed (non-blocking):', err.message);
  }
  return inserted;
}

// ─── Dispatcher handlers ─────────────────────────────────────────

/**
 * Load the shift + linked proposal + recipient staffer contact for a scheduled
 * staff SMS handler. users has no phone column; staff phone is joined from
 * contractor_profiles.
 */
async function loadStaffShiftContext(shiftId, staffUserId) {
  const { rows } = await pool.query(
    `SELECT s.id AS shift_id, s.proposal_id, s.location AS shift_location,
            s.start_time AS shift_start_time, s.setup_minutes_before,
            p.status AS proposal_status, p.token AS proposal_token,
            p.event_date, p.event_start_time, p.event_duration_hours,
            p.event_timezone, p.event_location,
            p.event_type, p.event_type_custom,
            COALESCE(c.name, s.client_name) AS client_name,
            cp.preferred_name AS staff_name, cp.phone AS staff_phone
       FROM shifts s
       LEFT JOIN proposals p ON p.id = s.proposal_id
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = $2
      WHERE s.id = $1`,
    [shiftId, staffUserId]
  );
  return rows[0] || null;
}

/** Format event start as "6:00 PM CDT". */
function formatStartTimeShort(ctx) {
  const raw = ctx.event_start_time || ctx.shift_start_time;
  const clock = parseClockTime(raw);
  if (!clock) return 'TBD';
  const hour12 = clock.hour % 12 === 0 ? 12 : clock.hour % 12;
  const ampm = clock.hour >= 12 ? 'PM' : 'AM';
  const time12 = `${hour12}:${String(clock.minute).padStart(2, '0')} ${ampm}`;
  let tzAbbrev = '';
  try {
    const ymd = toCalendarYmd(ctx.event_date);
    if (ymd) {
      const refMs = Date.parse(`${ymd}T12:00:00Z`);
      if (Number.isFinite(refMs)) {
        const tz = resolveEventTimezone(ctx);
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: tz, timeZoneName: 'short',
        }).formatToParts(new Date(refMs));
        const tzPart = parts.find((p) => p.type === 'timeZoneName');
        if (tzPart && tzPart.value) tzAbbrev = ` ${tzPart.value}`;
      }
    }
  } catch (_e) { /* leave empty */ }
  return `${time12}${tzAbbrev}`;
}

/** Format event_date as "Saturday, August 15" in event TZ. */
function formatEventDateLong(ctx) {
  const ymd = toCalendarYmd(ctx.event_date);
  if (!ymd) return 'your event';
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return 'your event';
  const tz = resolveEventTimezone(ctx);
  return formatEventLocalTime(d, tz, { weekday: 'long', month: 'long', day: 'numeric' });
}

/**
 * Handler: shift_reminder (day-before staff SMS, spec 3.15).
 * The archived-proposal throw below is defense-in-depth: Task 10 suppresses
 * archived-proposal shift rows in checkSuppression before dispatch.
 */
async function handleShiftReminder({ entity, recipient }) {
  const ctx = await loadStaffShiftContext(entity.id, recipient.id);
  if (!ctx) throw new Error(`shift_reminder: shift ${entity.id} not found`);
  if (!ctx.proposal_id) throw new Error(`shift_reminder: shift ${entity.id} has no linked proposal`);
  if (ctx.proposal_status === 'archived') {
    throw new Error(`shift_reminder: proposal archived for shift ${entity.id} — should have been suppressed`);
  }
  if (!ctx.staff_phone) {
    throw new Error(`shift_reminder: staff ${recipient.id} has no phone on contractor_profiles`);
  }

  const setupArrival = subtractMinutesFromTime(
    ctx.event_start_time || ctx.shift_start_time,
    ctx.setup_minutes_before ?? 60
  ) || 'TBD';

  const link = ctx.proposal_token
    ? `${PUBLIC_SITE_URL}/shopping-list/${ctx.proposal_token}`
    : `${PUBLIC_SITE_URL}`;

  const body = smsTemplates.staffShiftReminderSms({
    eventTypeLabel: getEventTypeLabel({ event_type: ctx.event_type, event_type_custom: ctx.event_type_custom }),
    clientName: ctx.client_name || 'the host',
    startTimeLocal: formatStartTimeShort(ctx),
    location: ctx.event_location || ctx.shift_location || 'TBD',
    setupArrivalTime: setupArrival,
    link,
  });

  await sendAndLogSms({
    to: ctx.staff_phone,
    body,
    clientId: null,
    messageType: 'shift_reminder',
    recipientName: ctx.staff_name || null,
  });
}

/**
 * Handler: staff_thank_you (post-event staff SMS, spec 3.19).
 */
async function handleStaffThankYou({ entity, recipient }) {
  const ctx = await loadStaffShiftContext(entity.id, recipient.id);
  if (!ctx) throw new Error(`staff_thank_you: shift ${entity.id} not found`);
  if (!ctx.proposal_id) throw new Error(`staff_thank_you: shift ${entity.id} has no linked proposal`);
  if (ctx.proposal_status === 'archived') {
    throw new Error(`staff_thank_you: proposal archived for shift ${entity.id} — should have been suppressed`);
  }
  if (!ctx.staff_phone) {
    throw new Error(`staff_thank_you: staff ${recipient.id} has no phone on contractor_profiles`);
  }

  const body = smsTemplates.staffThankYouSms({
    eventTypeLabel: getEventTypeLabel({ event_type: ctx.event_type, event_type_custom: ctx.event_type_custom }),
  });

  await sendAndLogSms({
    to: ctx.staff_phone,
    body,
    clientId: null,
    messageType: 'staff_thank_you',
    recipientName: ctx.staff_name || null,
  });
}

/**
 * Idempotent registration entry point. shift_reminder + staff_thank_you both
 * have BESPOKE timing (T-24h from start, end+30min), so they register with
 * offsetFromEventDate: null — the generic reschedule cascade skips them and
 * Task 11 handles their reschedule re-anchor explicitly.
 *
 * priority (1 / 3) is per the cross-plan priority ladder; inert until Phase 4b.
 */
function registerStaffShiftHandlers() {
  registerHandler('shift_reminder', handleShiftReminder, {
    offsetFromEventDate: null,
    anchor: 'event_date',
    category: 'operational',
    priority: 1,
  });
  registerHandler('staff_thank_you', handleStaffThankYou, {
    offsetFromEventDate: null,
    anchor: 'event_date',
    category: 'operational',
    priority: 3,
  });
}

// ─── Immediate staff notification hooks ──────────────────────────

/**
 * Notify a set of staffers that a shift was cancelled or a staffer was
 * unassigned (spec 3.18). Sends SMS and/or email per the channel flags.
 * Best-effort throughout — never rethrows.
 *
 * @param {Object} args
 * @param {number} args.shiftId
 * @param {number[]} args.staffUserIds
 * @param {'cancelled'|'unassigned'} args.kind
 * @param {boolean} args.sms
 * @param {boolean} args.email
 * @returns {Promise<{smsSent: number, emailSent: number}>}
 */
async function notifyStaffOfCancellation({ shiftId, staffUserIds, kind, sms, email }) {
  const result = { smsSent: 0, emailSent: 0 };
  if ((!sms && !email) || !Array.isArray(staffUserIds) || staffUserIds.length === 0) {
    return result;
  }
  try {
    for (const userId of staffUserIds) {
      const ctx = await loadStaffShiftContext(shiftId, userId);
      if (!ctx) continue;
      const eventTypeLabel = getEventTypeLabel({
        event_type: ctx.event_type, event_type_custom: ctx.event_type_custom,
      });
      const eventDateLocal = formatEventDateLong(ctx);

      if (sms && ctx.staff_phone) {
        try {
          await sendAndLogSms({
            to: ctx.staff_phone,
            body: smsTemplates.staffCancellationSms({ eventTypeLabel, eventDateLocal, kind }),
            clientId: null,
            messageType: kind === 'unassigned' ? 'staff_unassignment_notice' : 'staff_cancellation_notice',
            recipientName: ctx.staff_name || null,
          });
          result.smsSent += 1;
        } catch (smsErr) {
          Sentry.captureException(smsErr, {
            tags: { component: 'staffShiftHandlers', step: 'notifyStaffOfCancellation', channel: 'sms' },
            extra: { shiftId, userId },
          });
          console.error('[staffShiftHandlers] cancellation SMS failed (non-blocking):', smsErr.message);
        }
      }

      if (email) {
        const u = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
        const staffEmail = u.rows[0]?.email;
        if (staffEmail) {
          const verb = kind === 'unassigned'
            ? 'your shift is no longer needed'
            : 'has been cancelled';
          try {
            await sendEmail({
              to: staffEmail,
              subject: `Update from Dr. Bartender: ${eventTypeLabel} on ${eventDateLocal}`,
              html: `<p>Update from Dr. Bartender: the ${eventTypeLabel} on ${eventDateLocal}, ${verb}.</p>`
                + `<p>Sorry for the disruption. Reach out with any questions.</p>`,
              text: `Update from Dr. Bartender: the ${eventTypeLabel} on ${eventDateLocal}, ${verb}. `
                + `Sorry for the disruption. Reach out with any questions.`,
            });
            result.emailSent += 1;
          } catch (emailErr) {
            Sentry.captureException(emailErr, {
              tags: { component: 'staffShiftHandlers', step: 'notifyStaffOfCancellation', channel: 'email' },
              extra: { shiftId, userId },
            });
            console.error('[staffShiftHandlers] cancellation email failed (non-blocking):', emailErr.message);
          }
        }
      }
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: 'staffShiftHandlers', step: 'notifyStaffOfCancellation' },
      extra: { shiftId },
    });
    console.error('[staffShiftHandlers] notifyStaffOfCancellation failed (non-blocking):', err.message);
  }
  return result;
}

/**
 * Notify a proposal's assigned staffers that the event was rescheduled
 * (spec 3.17). Best-effort throughout.
 */
async function notifyStaffOfScheduleChange({ proposalId, updated, sms, email }) {
  const result = { smsSent: 0, emailSent: 0 };
  if (!sms && !email) return result;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT sr.user_id, u.email AS staff_email,
              cp.preferred_name AS staff_name, cp.phone AS staff_phone,
              p.event_type, p.event_type_custom, p.event_date,
              p.event_start_time, p.event_timezone, p.event_location
         FROM shifts s
         JOIN shift_requests sr ON sr.shift_id = s.id AND sr.status = 'approved'
         JOIN users u ON u.id = sr.user_id
         LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
         LEFT JOIN proposals p ON p.id = s.proposal_id
        WHERE s.proposal_id = $1`,
      [proposalId]
    );
    if (rows.length === 0) return result;

    for (const row of rows) {
      const eventTypeLabel = getEventTypeLabel({
        event_type: row.event_type, event_type_custom: row.event_type_custom,
      });
      const eventDateLocal = formatEventDateLong(row);
      const newDateLocal = formatEventDateLong({
        event_date: updated.event_date || row.event_date,
        event_timezone: row.event_timezone,
      });
      const newTime = updated.event_start_time || row.event_start_time || 'TBD';
      const newLocation = updated.event_location || row.event_location || 'same location';
      const newDetails = `${newDateLocal}, ${newTime}, ${newLocation}`;

      if (sms && row.staff_phone) {
        try {
          await sendAndLogSms({
            to: row.staff_phone,
            body: smsTemplates.staffScheduleChangeSms({ eventTypeLabel, eventDateLocal, newDetails }),
            clientId: null,
            messageType: 'staff_schedule_change',
            recipientName: row.staff_name || null,
          });
          result.smsSent += 1;
        } catch (smsErr) {
          Sentry.captureException(smsErr, {
            tags: { component: 'staffShiftHandlers', step: 'notifyStaffOfScheduleChange', channel: 'sms' },
            extra: { proposalId, userId: row.user_id },
          });
          console.error('[staffShiftHandlers] schedule-change SMS failed (non-blocking):', smsErr.message);
        }
      }

      if (email && row.staff_email) {
        try {
          await sendEmail({
            to: row.staff_email,
            subject: `Update from Dr. Bartender: ${eventTypeLabel} on ${eventDateLocal}`,
            html: `<p>Update from Dr. Bartender: the ${eventTypeLabel} on ${eventDateLocal} has been changed.</p>`
              + `<p>New details: ${newDetails}.</p>`
              + `<p>Reply CONFIRM to stay on the shift, or call if there is a conflict.</p>`,
            text: `Update from Dr. Bartender: the ${eventTypeLabel} on ${eventDateLocal} has been changed. `
              + `New details: ${newDetails}. Reply CONFIRM to stay on the shift, or call if there is a conflict.`,
          });
          result.emailSent += 1;
        } catch (emailErr) {
          Sentry.captureException(emailErr, {
            tags: { component: 'staffShiftHandlers', step: 'notifyStaffOfScheduleChange', channel: 'email' },
            extra: { proposalId, userId: row.user_id },
          });
          console.error('[staffShiftHandlers] schedule-change email failed (non-blocking):', emailErr.message);
        }
      }
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: 'staffShiftHandlers', step: 'notifyStaffOfScheduleChange' },
      extra: { proposalId },
    });
    console.error('[staffShiftHandlers] notifyStaffOfScheduleChange failed (non-blocking):', err.message);
  }
  return result;
}

/**
 * Single post-commit entry point for the proposals PATCH reschedule path.
 *   1. reanchorStaffShiftMessages (unconditional) — Task 11 adds this function;
 *      until then it is a forward reference, resolved at call time.
 *   2. notifyStaffOfScheduleChange (admin-toggled).
 * Best-effort throughout.
 */
async function runRescheduleStaffHooks({ proposalId, updated, notifyStaff, notifyStaffSms, notifyStaffEmail }) {
  try {
    await reanchorStaffShiftMessages(proposalId);
  } catch (reanchorErr) {
    Sentry.captureException(reanchorErr, {
      tags: { component: 'staffShiftHandlers', step: 'runRescheduleStaffHooks.reanchor' },
      extra: { proposalId },
    });
    console.error('[staffShiftHandlers] reschedule re-anchor failed (non-blocking):', reanchorErr.message);
  }
  if (notifyStaff === true && (notifyStaffSms === true || notifyStaffEmail === true)) {
    try {
      await notifyStaffOfScheduleChange({
        proposalId,
        updated,
        sms: notifyStaffSms === true,
        email: notifyStaffEmail === true,
      });
    } catch (notifyErr) {
      Sentry.captureException(notifyErr, {
        tags: { component: 'staffShiftHandlers', step: 'runRescheduleStaffHooks.notify' },
        extra: { proposalId },
      });
      console.error('[staffShiftHandlers] schedule-change notify failed (non-blocking):', notifyErr.message);
    }
  }
}

module.exports = {
  toCalendarYmd,
  parseClockTime,
  eventLocalToUtc,
  computeEventStartUtc,
  computeShiftReminderScheduledFor,
  computeStaffThankYouScheduledFor,
  insertShiftMessageIfMissing,
  scheduleStaffShiftMessages,
  loadStaffShiftContext,
  handleShiftReminder,
  handleStaffThankYou,
  registerStaffShiftHandlers,
  notifyStaffOfCancellation,
  notifyStaffOfScheduleChange,
  runRescheduleStaffHooks,
};
