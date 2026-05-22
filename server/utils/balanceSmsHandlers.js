/**
 * Balance SMS handlers — the SMS halves of the non-autopay balance reminder
 * ladder (spec 3.5 due-today, 3.6 late t1 / t3). The email halves
 * (balance_due_today, balance_late_t1, balance_late_t3) live in
 * scheduledMessageDispatcher.js. Kept separate so the dispatcher core stays
 * lean.
 *
 * Three message_types, all anchored on balance_due_date (NOT event_date) so the
 * reschedule cascade re-anchors them when admin moves the balance due date:
 *   - balance_due_today_sms  (offset 0,  priority 1, cooldownExempt)
 *   - balance_late_t1_sms    (offset +1d, priority 2)
 *   - balance_late_t3_sms    (offset +3d, priority 2)
 * priority / cooldownExempt / multiChannel are inert until Phase 4b. All three
 * register multiChannel: true — each is the SMS half of an email+SMS balance
 * reminder pair, and spec 7.3 forbids the Phase 4b delivery-failure logic from
 * channel-substituting a multi-channel touch (each channel's row is
 * independent; the dead channel suppresses while the other fires).
 *
 * These are scheduled only for NON-autopay proposals (scheduleBalanceReminders
 * gates on autopay_enrolled), matching the email side.
 */
const { pool } = require('../db');
const { registerHandler } = require('./scheduledMessageDispatcher');
const { sendAndLogSms } = require('./sms');
const smsTemplates = require('./smsTemplates');
const { PUBLIC_SITE_URL } = require('./urls');

const DAY_SECONDS = 86400;

/**
 * Load proposal + client fields a balance SMS handler needs. Throws when the
 * proposal is gone / archived, the client has no phone / opted out of SMS, or
 * the balance is already cleared (the reminder is moot — admin or autopay
 * resolved it).
 */
async function loadBalanceSmsContext(proposalId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.status, p.event_date, p.total_price, p.amount_paid,
            c.id AS client_id, c.name AS client_name, c.phone AS client_phone,
            c.communication_preferences AS comm_prefs, c.phone_status
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );
  const ctx = rows[0];
  if (!ctx) throw new Error(`balance SMS: proposal ${proposalId} not found`);
  if (ctx.status === 'archived') throw new Error('balance SMS: proposal archived');
  if (!ctx.client_phone) throw new Error('balance SMS: client has no phone');
  if (ctx.phone_status === 'bad') throw new Error('balance SMS: client phone_status is bad');
  const prefs = ctx.comm_prefs || {};
  if (prefs.sms_enabled === false) throw new Error('balance SMS: sms_enabled is false');
  const balanceDue = Number(ctx.total_price) - Number(ctx.amount_paid);
  if (!(balanceDue > 0)) throw new Error('balance SMS: balance is zero or negative, reminder moot');
  return ctx;
}

function eventDateSms(eventDate) {
  if (!eventDate) return 'your event';
  const parsed = new Date(String(eventDate).slice(0, 10) + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) return 'your event';
  return parsed.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

function proposalUrl(token) {
  return `${PUBLIC_SITE_URL}/proposal/${token}`;
}

async function sendBalanceSms(proposalId, messageType, bodyFn) {
  const ctx = await loadBalanceSmsContext(proposalId);
  await sendAndLogSms({
    to: ctx.client_phone,
    body: bodyFn(ctx),
    clientId: ctx.client_id,
    messageType,
    recipientName: ctx.client_name || null,
  });
}

function registerBalanceSmsHandlers() {
  // multiChannel: true on all three — each is the SMS half of an email+SMS
  // balance-reminder pair (email halves: balance_due_today, balance_late_t1,
  // balance_late_t3). Per spec 7.3 the Phase 4b delivery-failure logic must NOT
  // channel-substitute a multi-channel touch: each channel's row is
  // independent, the dead channel suppresses while the other fires.
  // multiChannel is a Phase-4b-defined registerHandler option, inert until
  // Phase 4b lands — today's registerHandler ignores unknown option keys,
  // exactly as it does for priority / cooldownExempt.
  registerHandler(
    'balance_due_today_sms',
    ({ entity }) => sendBalanceSms(entity.id, 'balance_due_today_sms', (ctx) => smsTemplates.balanceDueTodaySms({
      eventDate: eventDateSms(ctx.event_date),
      link: proposalUrl(ctx.token),
    })),
    { offsetFromEventDate: 0, anchor: 'balance_due_date', category: 'operational', priority: 1, cooldownExempt: true, multiChannel: true }
  );
  registerHandler(
    'balance_late_t1_sms',
    ({ entity }) => sendBalanceSms(entity.id, 'balance_late_t1_sms', (ctx) => smsTemplates.balanceLateSms({
      eventDate: eventDateSms(ctx.event_date),
      link: proposalUrl(ctx.token),
      daysLate: 1,
    })),
    { offsetFromEventDate: 1 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 2, multiChannel: true }
  );
  registerHandler(
    'balance_late_t3_sms',
    ({ entity }) => sendBalanceSms(entity.id, 'balance_late_t3_sms', (ctx) => smsTemplates.balanceLateSms({
      eventDate: eventDateSms(ctx.event_date),
      link: proposalUrl(ctx.token),
      daysLate: 3,
    })),
    { offsetFromEventDate: 3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 2, multiChannel: true }
  );
}

module.exports = { registerBalanceSmsHandlers, loadBalanceSmsContext };
