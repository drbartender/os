/**
 * Drink-plan / Potion Planner nudge — a full email + SMS touch (spec 3.7).
 * No email side existed before Phase 3, so this file owns the email template,
 * both dispatcher handlers, and the scheduling helper.
 *
 * Two message_types:
 *   - drink_plan_nudge      (channel email)
 *   - drink_plan_nudge_sms  (channel sms)
 * Both scheduled T-21 days from event, 10:00 event-local via computeScheduledFor.
 * Category 'operational' (drink plan completion is transactional). priority 2
 * and multiChannel: true (both inert until Phase 4b). multiChannel marks this
 * as an email+SMS pair so the Phase 4b delivery-failure logic does NOT
 * channel-substitute either row — per spec 7.3 each channel's row is
 * independent (the dead channel suppresses, the other fires).
 *
 * Send-time suppression: throw 'SUPPRESS: ...' when the drink plan is already
 * filled or the proposal is archived. The dispatcher records the throw as
 * 'failed' with the reason in error_message — that is the chosen signal for
 * "no longer needed" (mirrors marketingHandlers.js retention_nudge, which also
 * throws 'SUPPRESS:' for a last-mile skip).
 *
 * "Filled" is NOT "a drink_plans row exists". drink_plans.selections is
 * JSONB DEFAULT '{}', and createDrinkPlan (eventCreation.js) inserts a row at
 * conversion with no selections value — so a converted proposal has a
 * default-empty '{}' row long before T-21. "Submitted" therefore means a
 * POPULATED selections object: selections IS NOT NULL AND selections::text
 * <> '{}'. The consult signal stays consult_filled_at IS NOT NULL (a timestamp
 * column, no '{}' default).
 */
const { pool } = require('../db');
const { registerHandler } = require('./scheduledMessageDispatcher');
const { SuppressMessageError } = require('./errors');
const { scheduleMessage } = require('./messageScheduling');
const { computeScheduledFor } = require('./preEventScheduling');
const { sendEmail } = require('./email');
const { sendAndLogSms } = require('./sms');
const smsTemplates = require('./smsTemplates');
const { wrapEmail } = require('./emailTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');

const BRAND = { primary: '#3b2314', secondary: '#6b4226' };
const DAY_SECONDS = 86400;
const NUDGE_OFFSET = -21 * DAY_SECONDS;
const NUDGE_PRIORITY = 2;

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function eventDateSms(eventDate) {
  if (!eventDate) return 'your event';
  const parsed = new Date(String(eventDate).slice(0, 10) + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) return 'your event';
  return parsed.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

/**
 * Drink-plan nudge email body. Spec 3.7: three ways to lock in drinks.
 * NO em dashes. ctaButton inlined to avoid the emailTemplates.js require cycle.
 */
function drinkPlanNudgeEmail({ clientFirstName, eventTypeLabel, eventDateDisplay, plannerUrl, consultUrl, phone }) {
  const name = clientFirstName || 'there';
  const consultLine = consultUrl
    ? `<li>Book a 15-minute phone consult: <a href="${esc(consultUrl)}">${esc(consultUrl)}</a></li>`
    : '';
  const phoneLine = phone
    ? `<li>Call or text us at ${esc(phone)} and we'll walk through it together</li>`
    : `<li>Call or text us and we'll walk through it together</li>`;
  return {
    subject: `Time to lock in drinks for your ${eventTypeLabel} event`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Time to lock in drinks</h2>
      <p>Hi ${esc(name)},</p>
      <p>Time to lock in drinks for your <strong>${esc(eventTypeLabel)}</strong> on ${esc(eventDateDisplay)}. Three ways to do it:</p>
      <ol style="line-height:1.7;color:${BRAND.primary};padding-left:1.25rem;">
        <li>Potion Planner: <a href="${esc(plannerUrl)}">${esc(plannerUrl)}</a> (about 5 minutes, easiest)</li>
        ${consultLine}
        ${phoneLine}
      </ol>
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
      <p>Cheers, Dallas</p>
    `),
    text: [
      `Hi ${name}, time to lock in drinks for your ${eventTypeLabel} on ${eventDateDisplay}. Three ways to do it:`,
      `1. Potion Planner: ${plannerUrl} (about 5 minutes, easiest)`,
      consultUrl ? `2. Book a 15-minute phone consult: ${consultUrl}` : null,
      `${consultUrl ? '3' : '2'}. Call or text us${phone ? ` at ${phone}` : ''} and we'll walk through it together`,
      'Cheers, Dallas',
    ].filter(Boolean).join('\n'),
  };
}

/**
 * Load the proposal + client + drink_plan fields the nudge handlers need.
 * Throws 'SUPPRESS: ...' for the no-longer-needed cases so the dispatcher
 * records a clear reason.
 */
async function loadNudgeContext(proposalId) {
  // dp_submitted is computed in SQL: TRUE only when selections is a populated
  // object. A drink_plans row created at conversion has selections = '{}'
  // (JSONB DEFAULT '{}'), which is NOT a submission — see the file header.
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.status, p.event_date, p.event_type, p.event_type_custom,
            c.id AS client_id, c.name AS client_name, c.email AS client_email,
            c.phone AS client_phone,
            (dp.selections IS NOT NULL AND dp.selections::text <> '{}') AS dp_submitted,
            dp.consult_filled_at AS dp_consult_filled_at
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN drink_plans dp ON dp.proposal_id = p.id
      WHERE p.id = $1
      LIMIT 1`,
    [proposalId]
  );
  const ctx = rows[0];
  if (!ctx) throw new Error(`drink_plan_nudge: proposal ${proposalId} not found`);
  if (ctx.status === 'archived') throw new Error('SUPPRESS: proposal archived');
  // Spec 3.7 suppression: the drink plan is already filled. dp_submitted is
  // the SQL-computed "populated selections" flag — a default-empty '{}' row
  // does NOT count, so the nudge still fires for a freshly-converted proposal.
  if (ctx.dp_submitted === true) {
    throw new Error('SUPPRESS: drink plan already has selections');
  }
  if (ctx.dp_consult_filled_at !== null && ctx.dp_consult_filled_at !== undefined) {
    throw new Error('SUPPRESS: drink plan consult already recorded');
  }
  return ctx;
}

function firstNameOf(fullName) {
  if (!fullName) return 'there';
  return String(fullName).trim().split(/\s+/)[0] || 'there';
}

function eventLabel(ctx) {
  return getEventTypeLabel({ event_type: ctx.event_type, event_type_custom: ctx.event_type_custom });
}

async function handleDrinkPlanNudgeEmail({ entity }) {
  const ctx = await loadNudgeContext(entity.id);
  if (!ctx.client_email) throw new SuppressMessageError('client_no_email');
  const tpl = drinkPlanNudgeEmail({
    clientFirstName: firstNameOf(ctx.client_name),
    eventTypeLabel: eventLabel(ctx),
    eventDateDisplay: eventDateSms(ctx.event_date),
    plannerUrl: ctx.token ? `${PUBLIC_SITE_URL}/plan/${ctx.token}` : `${PUBLIC_SITE_URL}/plan`,
    consultUrl: process.env.CAL_BOOKING_URL || null,
    phone: process.env.ADMIN_PHONE || null,
  });
  await sendEmail({ to: ctx.client_email, ...tpl });
}

async function handleDrinkPlanNudgeSms({ entity }) {
  const ctx = await loadNudgeContext(entity.id);
  if (!ctx.client_phone) throw new SuppressMessageError('client_no_phone');
  const body = smsTemplates.drinkPlanNudgeSms({
    eventDate: eventDateSms(ctx.event_date),
    plannerUrl: ctx.token ? `${PUBLIC_SITE_URL}/plan/${ctx.token}` : `${PUBLIC_SITE_URL}/plan`,
    consultUrl: process.env.CAL_BOOKING_URL || null,
  });
  await sendAndLogSms({
    to: ctx.client_phone,
    body,
    clientId: ctx.client_id,
    messageType: 'drink_plan_nudge_sms',
    recipientName: ctx.client_name || null,
  });
}

function registerDrinkPlanNudgeHandlers() {
  // multiChannel: true — drink_plan_nudge (email) and drink_plan_nudge_sms are
  // the two halves of one email+SMS touch. Per spec 7.3 the Phase 4b
  // delivery-failure logic must NOT channel-substitute a multi-channel touch:
  // each channel's row is independent, and the dead channel's row simply
  // suppresses while the other fires (substituting would, e.g., add an SMS on
  // top of the real drink_plan_nudge_sms row → two SMS). multiChannel is a
  // Phase-4b-defined registerHandler option, inert until Phase 4b lands —
  // today's registerHandler ignores unknown option keys, exactly as for priority.
  registerHandler('drink_plan_nudge', handleDrinkPlanNudgeEmail, {
    offsetFromEventDate: NUDGE_OFFSET, anchor: 'event_date', category: 'operational',
    priority: NUDGE_PRIORITY, multiChannel: true,
  });
  registerHandler('drink_plan_nudge_sms', handleDrinkPlanNudgeSms, {
    offsetFromEventDate: NUDGE_OFFSET, anchor: 'event_date', category: 'operational',
    priority: NUDGE_PRIORITY, multiChannel: true,
  });
}

/**
 * Insert the drink_plan_nudge email + SMS scheduled_messages rows (T-21 days,
 * 10:00 event-local). Idempotent — scheduleMessage no-ops on a pending dup.
 * Called from schedulePreEventReminders. Skips archived proposals and proposals
 * with no client / no event_date.
 *
 * @param {number|string} proposalId
 * @param {{ query: Function }} [executor] - pg client or pool; defaults to pool
 *   when omitted. Passed through so a reschedule-cascade caller's transaction is
 *   joined (mirrors schedulePreEventReminders' executor param).
 */
async function scheduleDrinkPlanNudge(proposalId, executor) {
  const { pool: realPool } = require('../db');
  const exec = executor || realPool;
  const { rows } = await exec.query(
    `SELECT id, client_id, status, event_date, event_timezone
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = rows[0];
  if (!proposal) return;
  if (proposal.status === 'archived') return;
  if (!proposal.client_id || !proposal.event_date) return;

  // CC-import: events without a drink plan never get nudged. See specs/2026-05-25-checkcherry-import-design.md §9.3.D.
  const planRes = await exec.query(
    'SELECT 1 FROM drink_plans WHERE proposal_id = $1 LIMIT 1',
    [proposalId]
  );
  if (planRes.rowCount === 0) {
    return; // No drink plan exists; nothing to nudge about.
  }

  const scheduledFor = computeScheduledFor('drink_plan_nudge', proposal);
  // Both rows share the same send instant; scheduleMessage is idempotent.
  await scheduleMessage({
    entityType: 'proposal', entityId: Number(proposalId),
    messageType: 'drink_plan_nudge', recipientType: 'client', recipientId: proposal.client_id,
    channel: 'email', scheduledFor,
  });
  await scheduleMessage({
    entityType: 'proposal', entityId: Number(proposalId),
    messageType: 'drink_plan_nudge_sms', recipientType: 'client', recipientId: proposal.client_id,
    channel: 'sms', scheduledFor,
  });
}

module.exports = {
  registerDrinkPlanNudgeHandlers,
  scheduleDrinkPlanNudge,
  drinkPlanNudgeEmail,
  loadNudgeContext,
};
