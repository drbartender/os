// Enhancement Lab follow-up handler (planner v2). Scheduled by submit.js at
// plan submit (+36h, entityType 'proposal'). All cancel conditions are checked
// HERE at fire time instead of by cancel bookkeeping at every state change:
// a lab addition, a closed window, a de-submitted plan, or an event inside
// 72h each turn the send into a silent no-op (the row still goes 'sent',
// which is fine: this is a one-shot nudge either way).
const { pool } = require('../db');
const { registerHandler } = require('./scheduledMessageDispatcher');
const { sendEmail } = require('./email');
const { enhancementLabFollowup } = require('./lifecycleEmailTemplates');
const { getEventTypeLabel } = require('./eventTypes');

const LAB_CLOSE_HORIZON_MS = 72 * 60 * 60 * 1000;

async function labFollowupHandler({ entity: proposal, recipient: client }) {
  if (!proposal || !client || !client.email) return;

  // /plan/:token/lab needs the DRINK-PLAN token, not the proposal token
  // (the classic planner-link trap). Latest plan on the proposal wins.
  const planRes = await pool.query(
    `SELECT token, status, selections, shopping_list_status, finalized_at, planner_version
       FROM drink_plans
      WHERE proposal_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [proposal.id]
  );
  const plan = planRes.rows[0];
  if (!plan || plan.planner_version < 2) return;
  if (plan.status !== 'submitted' && plan.status !== 'reviewed') return;
  if (plan.finalized_at || plan.shopping_list_status === 'approved') return; // window closed

  // Client already visited the lab and added something: no nudge needed.
  const sel = plan.selections || {};
  const hasLabAdditions =
    Object.values(sel.addOns || {}).some((m) => m && m.labAdded === true) ||
    Object.keys(sel.labSyrupSelections || {}).length > 0;
  if (hasLabAdditions) return;

  // Event too close: additions can't make the shopping/prep run anymore.
  if (proposal.event_date && new Date(proposal.event_date).getTime() - Date.now() < LAB_CLOSE_HORIZON_MS) {
    return;
  }

  const sigIds = Array.isArray(sel.signatureDrinks) ? sel.signatureDrinks : [];
  let drinkNames = [];
  if (sigIds.length > 0) {
    const named = await pool.query('SELECT name FROM cocktails WHERE id = ANY($1::text[])', [sigIds]);
    drinkNames = named.rows.map((r) => r.name);
  }

  const base = process.env.PUBLIC_SITE_URL || 'https://drbartender.com';
  // Proposals money is DOLLARS (never cents) — straight subtraction is right.
  const balanceDue = Math.max(0, (Number(proposal.total_price) || 0) - (Number(proposal.amount_paid) || 0));
  const { subject, html, text } = enhancementLabFollowup({
    clientName: client.name,
    eventTypeLabel: getEventTypeLabel(proposal),
    labUrl: `${base}/plan/${plan.token}/lab`,
    drinkNames,
    balanceDue,
  });
  await sendEmail({
    to: client.email,
    subject,
    html,
    text,
    replyTo: process.env.ADMIN_EMAIL,
  });
}

function registerLabFollowupHandler() {
  registerHandler('lab_followup', labFollowupHandler, {
    offsetFromEventDate: null,  // anchored to submit time, not the event date
    anchor: 'created_at',
    category: 'marketing',      // upsell nudge: respects the marketing opt-out
    priority: 4,
    cooldownExempt: false,
    multiChannel: false,
  });
}

module.exports = { registerLabFollowupHandler, labFollowupHandler };
