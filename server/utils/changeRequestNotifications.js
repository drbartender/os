const { pool } = require('../db');
const { sendEmail } = require('./email');
const { sendSMS } = require('./sms');
const templates = require('./lifecycleEmailTemplates');
const { getEventTypeLabel } = require('./eventTypes');

const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || 'https://drbartender.com';
const ADMIN_URL = process.env.CLIENT_URL || 'https://admin.drbartender.com';

function labelFor(proposal) {
  return getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom });
}

// Admin alert on a new request. Email always; SMS only for inside_t14 when ADMIN_PHONE set.
async function notifyAdminOfChangeRequest(cr, proposal) {
  const c = (await pool.query('SELECT name FROM clients WHERE id = $1', [proposal.client_id])).rows[0] || {};
  const pv = cr.price_preview || {};
  const tpl = templates.changeRequestAdminAlert({
    clientName: c.name || 'A client', eventLabel: labelFor(proposal), editWindow: cr.edit_window,
    estimatedTotal: pv.estimated_total ?? 0, currentTotal: pv.current_total ?? 0,
    note: cr.note, adminUrl: `${ADMIN_URL}/proposals/${proposal.id}`,
  });
  if (process.env.ADMIN_EMAIL) await sendEmail({ to: process.env.ADMIN_EMAIL, ...tpl });
  if (cr.edit_window === 'inside_t14' && process.env.ADMIN_PHONE) {
    await sendSMS({ to: process.env.ADMIN_PHONE, body: tpl.text }).catch(e => console.error('admin CR sms failed:', e.message));
  }
}

// Client email on a decision (approved / declined). Re-reads the proposal for the
// fresh total/balance after an approve+apply.
async function notifyClientOfDecision(cr, proposal, outcome) {
  const c = (await pool.query('SELECT name, email FROM clients WHERE id = $1', [proposal.client_id])).rows[0] || {};
  if (!c.email) return;
  const portalUrl = `${PUBLIC_SITE_URL}/my-proposals`;
  let tpl;
  if (outcome === 'approved') {
    const total = Number(proposal.total_price_override ?? proposal.total_price ?? 0);
    const balance = total - Number(proposal.amount_paid ?? 0);
    tpl = templates.changeRequestApproved({ clientName: c.name, eventLabel: labelFor(proposal), newTotal: total, balanceDue: balance, portalUrl });
  } else {
    tpl = templates.changeRequestDeclined({ clientName: c.name, eventLabel: labelFor(proposal), reason: cr.decision_note || 'The change was not available.', portalUrl });
  }
  await sendEmail({ to: c.email, ...tpl });
}

module.exports = { notifyAdminOfChangeRequest, notifyClientOfDecision };
