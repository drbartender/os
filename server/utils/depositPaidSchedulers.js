const Sentry = require('@sentry/node');
const { scheduleBalanceReminders } = require('./balanceReminderScheduling');
const { schedulePreEventReminders } = require('./preEventScheduling');

/**
 * Schedule the balance-reminder ladder + pre-event reminders for a
 * deposit-paid proposal. Called from both Stripe webhook paths:
 *   - payment_intent.succeeded (Elements / direct charge)
 *   - checkout.session.completed (Payment Link)
 *
 * scheduleBalanceReminders has its own Sentry capture; schedulePreEventReminders
 * is wrapped here. Both helpers are idempotent so a Stripe retry that re-enters
 * the caller will not double-schedule.
 */
async function scheduleDepositPaidReminders(proposalId, { source } = {}) {
  await scheduleBalanceReminders(proposalId);
  try {
    await schedulePreEventReminders(proposalId);
  } catch (schedErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(schedErr, {
        tags: { webhook: 'stripe', step: 'schedulePreEventReminders', source: source || 'unknown' },
      });
    }
    console.error('schedulePreEventReminders failed (non-blocking):', schedErr);
  }
}

module.exports = { scheduleDepositPaidReminders };
