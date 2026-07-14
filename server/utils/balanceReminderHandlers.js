/**
 * Balance-reminder EMAIL handlers — the email halves of the balance reminder
 * ladder (autopay/non-autopay T-3, due-today, late t1/t3). The SMS halves live
 * in balanceSmsHandlers.js. Extracted from scheduledMessageDispatcher.js to keep
 * the dispatcher core under the file-size cap.
 *
 * Registration is a function that TAKES the dispatcher's registerHandler as an
 * argument (not required back from the dispatcher) so there is no require cycle:
 * the dispatcher requires this module during its own module init and calls
 * registerBalanceReminderHandlers(registerHandler) at the same point it used to
 * self-register these handlers — boot behavior is byte-equivalent and
 * server/index.js is untouched (it registers these by requiring the dispatcher).
 */
const emailTemplates = require('./emailTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { proposalUrl } = require('./urls');
const { sendEmail } = require('./email');
const { SuppressMessageError } = require('./errors');

function lastFour(_proposal) {
  // last4 is not stored on proposals today (only stripe_payment_method_id).
  // Return null so templates skip the line. Future task: store last4 alongside
  // the payment method id at deposit time so we can render it here.
  return null;
}

async function sendBalanceReminder({ entity, recipient, paymentMode }) {
  const balanceDue = Number(entity.total_price) - Number(entity.amount_paid);
  if (balanceDue <= 0) {
    throw new SuppressMessageError(`balance_not_positive:${balanceDue}`);
  }
  const tpl = emailTemplates.paymentReminderClient({
    clientName: recipient.name,
    eventTypeLabel: getEventTypeLabel({ event_type: entity.event_type, event_type_custom: entity.event_type_custom }),
    balanceDue,
    balanceDueDate: entity.balance_due_date,
    proposalUrl: proposalUrl(entity.token),
    paymentMode,
    last4: lastFour(entity),
  });
  await sendEmail({ to: recipient.email, ...tpl });
}

async function sendBalanceDueToday({ entity, recipient }) {
  // T+0 — "balance due today" non-autopay email. Reuses paymentReminderClient
  // in manual mode but with a more urgent subject. Could be a separate template
  // later; for now, the manual variant covers the body.
  await sendBalanceReminder({ entity, recipient, paymentMode: 'manual' });
}

async function sendBalanceLate({ entity, recipient, daysLate }) {
  const balanceDue = Number(entity.total_price) - Number(entity.amount_paid);
  if (balanceDue <= 0) {
    throw new SuppressMessageError(`balance_not_positive:${balanceDue}`);
  }
  const tpl = emailTemplates.paymentReminderLate({
    clientName: recipient.name,
    eventTypeLabel: getEventTypeLabel({ event_type: entity.event_type, event_type_custom: entity.event_type_custom }),
    balanceDue,
    proposalUrl: proposalUrl(entity.token),
    daysLate,
  });
  await sendEmail({ to: recipient.email, ...tpl });
}

// All money-path handlers are anchored on balance_due_date (NOT event_date)
// so Plan 2c's reschedule cascade re-anchors them correctly when admin updates
// the balance due date (Gemini Finding 1 + 6 — balance-due-date updates on
// reschedule are tracked as a follow-up in Plan 2c).
const DAY_SECONDS = 86400;

function registerBalanceReminderHandlers(registerHandler) {
  registerHandler(
    'balance_reminder_autopay_t3',
    ({ entity, recipient }) => sendBalanceReminder({ entity, recipient, paymentMode: 'autopay' }),
    { offsetFromEventDate: -3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 1 }
  );
  registerHandler(
    'balance_reminder_non_autopay_t3',
    ({ entity, recipient }) => sendBalanceReminder({ entity, recipient, paymentMode: 'manual' }),
    { offsetFromEventDate: -3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 1 }
  );
  registerHandler(
    'balance_due_today',
    ({ entity, recipient }) => sendBalanceDueToday({ entity, recipient }),
    { offsetFromEventDate: 0, anchor: 'balance_due_date', category: 'operational', priority: 1, cooldownExempt: true, multiChannel: true }
  );
  registerHandler(
    'balance_late_t1',
    ({ entity, recipient }) => sendBalanceLate({ entity, recipient, daysLate: 1 }),
    { offsetFromEventDate: 1 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 2, multiChannel: true }
  );
  registerHandler(
    'balance_late_t3',
    ({ entity, recipient }) => sendBalanceLate({ entity, recipient, daysLate: 3 }),
    { offsetFromEventDate: 3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 2, multiChannel: true }
  );
}

module.exports = { registerBalanceReminderHandlers };
