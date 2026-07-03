const { pool } = require('../db');
const { scheduleMessage } = require('./messageScheduling');
const { resolveEventTimezone } = require('./eventTimezone');
const { eventLocalToUtc, chicagoTodayYmd } = require('./businessTime');
const Sentry = require('@sentry/node');

// Each balance-reminder message_type fires at 10:00am LOCAL (event timezone) on a
// day offset from balance_due_date. This map is the single source of truth,
// shared with scripts/healBalanceReminderTimes.js so the scheduler and the heal
// script can never drift.
const REMINDER_ANCHOR_HOUR = 10;
const REMINDER_OFFSET_DAYS = {
  balance_reminder_autopay_t3: -3,
  balance_reminder_non_autopay_t3: -3,
  balance_due_today: 0,
  balance_late_t1: 1,
  balance_late_t3: 3,
  balance_due_today_sms: 0,
  balance_late_t1_sms: 1,
  balance_late_t3_sms: 3,
};

// Shift a YYYY-MM-DD calendar string by whole days (UTC-based, calendar-only, so
// no wall-clock / DST drift creeps in).
function shiftYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// pg returns a DATE as a JS Date at the process-local midnight of that calendar
// day; read its LOCAL components back to recover the stored YYYY-MM-DD without tz
// drift. A plain YYYY-MM-DD string passes through unchanged.
function toBaseYmd(balanceDueDate) {
  if (balanceDueDate instanceof Date) {
    const y = balanceDueDate.getFullYear();
    const m = String(balanceDueDate.getMonth() + 1).padStart(2, '0');
    const d = String(balanceDueDate.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(balanceDueDate).slice(0, 10);
}

// The UTC instant for a reminder: REMINDER_ANCHOR_HOUR local on (baseYmd + offsetDays).
function reminderAnchorInstant(baseYmd, offsetDays, tz) {
  return eventLocalToUtc(shiftYmd(baseYmd, offsetDays), REMINDER_ANCHOR_HOUR, 0, tz);
}

/**
 * Schedule the balance-reminder ladder for a freshly-deposit-paid proposal.
 *
 * Autopay enrolled:
 *   1 row at balance_due_date - 3 days (message_type: balance_reminder_autopay_t3)
 *
 * Non-autopay:
 *   4 rows: t-3, due-date, t+1, t+3
 *   (balance_reminder_non_autopay_t3, balance_due_today, balance_late_t1, balance_late_t3)
 *
 * Skips entirely if balance <= 0, balance_due_date not set, or balance_due_date in the past.
 *
 * Idempotent — scheduleMessage no-ops on duplicate pending rows.
 */
async function scheduleBalanceReminders(proposalId) {
  try {
    const id = Number(proposalId);
    if (!Number.isInteger(id)) return;
    const r = await pool.query(
      `SELECT id, client_id, total_price, amount_paid, balance_due_date, autopay_enrolled, event_timezone
       FROM proposals WHERE id = $1`,
      [id]
    );
    const p = r.rows[0];
    if (!p) return;
    if (!p.client_id) return;
    if (!p.balance_due_date) return;
    const balanceDue = Number(p.total_price) - Number(p.amount_paid);
    if (balanceDue <= 0) return;

    const dueDate = new Date(p.balance_due_date);
    if (Number.isNaN(dueDate.getTime())) return;
    // Skip only when the balance due date is strictly BEFORE today, where
    // "today" is the CHICAGO calendar day. A server-local (UTC) compare flips
    // to the next day at 6-7pm Chicago, so a deposit landing that evening ON
    // the due date would wrongly abort the whole ladder (including the late
    // reminders). Calendar-string compare keeps both sides on the same basis.
    // A balance due TODAY is NOT skipped: a same-day deposit must not silently
    // drop the balance_due_today reminder.
    if (toBaseYmd(p.balance_due_date) < chicagoTodayYmd()) return; // due strictly before Chicago-today — admin handles manually

    // Anchor each reminder at 10:00am LOCAL (event timezone), matching the send hour every other anchored touch uses (computeScheduledFor SEND_HOUR_LOCAL), so a post-reschedule reanchor computes the identical instant on its labeled day.
    // Previously these were pg DATE -> JS Date instants at implicit midnight UTC,
    // which under a GMT session landed the send around 7pm the PRIOR evening in
    // Chicago. Deriving the labeled day by calendar arithmetic off
    // balance_due_date keeps DST from shifting which day fires.
    const tz = resolveEventTimezone(p);
    const baseYmd = toBaseYmd(p.balance_due_date);
    const t3Before = reminderAnchorInstant(baseYmd, REMINDER_OFFSET_DAYS.balance_reminder_non_autopay_t3, tz);
    const dueDay = reminderAnchorInstant(baseYmd, REMINDER_OFFSET_DAYS.balance_due_today, tz);
    const t1After = reminderAnchorInstant(baseYmd, REMINDER_OFFSET_DAYS.balance_late_t1, tz);
    const t3After = reminderAnchorInstant(baseYmd, REMINDER_OFFSET_DAYS.balance_late_t3, tz);

    const base = {
      entityType: 'proposal',
      entityId: id,
      recipientType: 'client',
      recipientId: p.client_id,
      channel: 'email',
    };

    if (p.autopay_enrolled === true) {
      await scheduleMessage({
        ...base,
        messageType: 'balance_reminder_autopay_t3',
        scheduledFor: t3Before,
      });
    } else {
      // Email halves.
      await scheduleMessage({ ...base, messageType: 'balance_reminder_non_autopay_t3', scheduledFor: t3Before });
      await scheduleMessage({ ...base, messageType: 'balance_due_today', scheduledFor: dueDay });
      await scheduleMessage({ ...base, messageType: 'balance_late_t1', scheduledFor: t1After });
      await scheduleMessage({ ...base, messageType: 'balance_late_t3', scheduledFor: t3After });
      // SMS halves (Phase 3, spec 3.5 / 3.6). Non-autopay only — autopay
      // clients get no balance SMS, matching the email side. `base` has
      // channel:'email'; override per row to 'sms'.
      const smsBase = { ...base, channel: 'sms' };
      await scheduleMessage({ ...smsBase, messageType: 'balance_due_today_sms', scheduledFor: dueDay });
      await scheduleMessage({ ...smsBase, messageType: 'balance_late_t1_sms', scheduledFor: t1After });
      await scheduleMessage({ ...smsBase, messageType: 'balance_late_t3_sms', scheduledFor: t3After });
    }
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, {
        tags: { webhook: 'stripe', component: 'scheduleBalanceReminders' },
        extra: { proposalId },
      });
    }
    console.error('scheduleBalanceReminders failed (non-blocking):', err);
  }
}

module.exports = {
  scheduleBalanceReminders,
  REMINDER_OFFSET_DAYS,
  reminderAnchorInstant,
  toBaseYmd,
};
