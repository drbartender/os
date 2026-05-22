const { pool } = require('../db');
const { scheduleMessage } = require('./messageScheduling');
const Sentry = require('@sentry/node');

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
      `SELECT id, client_id, total_price, amount_paid, balance_due_date, autopay_enrolled
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
    // Skip only when the balance due date is strictly BEFORE today. pg returns
    // a DATE column as a JS Date at LOCAL midnight, so `startOfToday` is also
    // built at local midnight — the two are on the same basis and the compare
    // is correct no matter what time of day the deposit lands. A balance due
    // TODAY is NOT skipped (the balance_due_today reminder still schedules),
    // which is the point: a same-day deposit must not silently drop it.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    if (dueDate.getTime() < startOfToday.getTime()) return; // balance due strictly before today — admin handles manually

    const dayMs = 24 * 60 * 60 * 1000;
    const t3Before = new Date(dueDate.getTime() - 3 * dayMs);
    const dueDay = dueDate;
    const t1After = new Date(dueDate.getTime() + 1 * dayMs);
    const t3After = new Date(dueDate.getTime() + 3 * dayMs);

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

module.exports = { scheduleBalanceReminders };
