'use strict';

// Post-commit comms for the drink-plan submit handler (extracted verbatim
// from submit.js in the 2026-07-22 per-concern split; behavior-inert).
// Everything here runs AFTER the submit transaction has committed and
// released its client — every query goes through `pool` (one-connection rule
// untouched) and every send is best-effort: a failure logs but never fails
// the already-successful submit.

const { pool } = require('../../db');
const { sendEmail } = require('../../utils/email');
const emailTemplates = require('../../utils/emailTemplates');
const { notifyAdminCategory } = require('../../utils/adminNotifications');
const { getEventTypeLabel } = require('../../utils/eventTypes');
const { shouldSendImmediate } = require('../../utils/messageSuppression');
const { ADMIN_URL } = require('../../utils/urls');
const { scheduleMessage } = require('../../utils/messageScheduling');
const { drinkPlanEchoSection } = require('../../utils/lifecycleEmailTemplates');

// Resolve selected drink names and build the confirmation echo section
// (planner v2). Runs in the post-commit tail; pool is correct there. Never
// fatal — a failed echo still sends the base confirmation.
async function buildSelectionsEcho(selections) {
  try {
    const sig = Array.isArray(selections?.signatureDrinks) ? selections.signatureDrinks : [];
    const moc = Array.isArray(selections?.mocktails) ? selections.mocktails : [];
    const [c, m] = await Promise.all([
      sig.length ? pool.query('SELECT id, name FROM cocktails WHERE id = ANY($1::text[])', [sig]) : Promise.resolve({ rows: [] }),
      moc.length ? pool.query('SELECT id, name FROM mocktails WHERE id = ANY($1::text[])', [moc]) : Promise.resolve({ rows: [] }),
    ]);
    const cn = new Map(c.rows.map(r => [r.id, r.name]));
    const mn = new Map(m.rows.map(r => [r.id, r.name]));
    return drinkPlanEchoSection({
      selections: selections || {},
      cocktailNames: sig.map(id => cn.get(id)).filter(Boolean),
      mocktailNames: moc.map(id => mn.get(id)).filter(Boolean),
    });
  } catch (err) {
    console.error('Selections echo build failed (non-fatal):', err.message);
    return { html: '', text: '' };
  }
}

// Enhancement Lab follow-up: one nudge email +36h after a v2 submit (spec
// §3.3). scheduleMessage is idempotent on its tuple, so nothing here can
// double-book. There is NO cancel bookkeeping anywhere: every cancel
// condition (lab addition made, window closed, plan finalized, event inside
// 72h, marketing opt-out) is re-checked at fire time by labFollowupHandler.
// Fire-and-forget from the submit tail; a failure never fails the submit.
async function scheduleLabFollowupAfterSubmit(planId) {
  if (!planId) return;
  try {
    const r = await pool.query(
      `SELECT dp.planner_version, p.id AS proposal_id, p.client_id
         FROM drink_plans dp
         JOIN proposals p ON p.id = dp.proposal_id
        WHERE dp.id = $1`,
      [planId]
    );
    const row = r.rows[0];
    if (!row || row.planner_version < 2 || !row.client_id) return;
    await scheduleMessage({
      entityType: 'proposal',
      entityId: row.proposal_id,
      messageType: 'lab_followup',
      recipientType: 'client',
      recipientId: row.client_id,
      channel: 'email',
      scheduledFor: new Date(Date.now() + 36 * 60 * 60 * 1000),
    });
  } catch (err) {
    console.error('lab_followup scheduling failed (non-fatal):', err.message);
  }
}

// Post-commit notifications for the financial submit path (best-effort;
// logged but never block the response). `pendingNotifications` is the data
// bundle captured inside the submit transaction (see submit.js).
async function sendFinancialSubmitNotifications(pendingNotifications, selections) {
  const { proposal: pn, snapshot, amountPaid, addonNames, clientName, clientEmail } = pendingNotifications;
  // Admin heads-up stays throttled to balance-changing submits — a
  // zero-impact addon submit (all package-covered) doesn't warrant a ping.
  if (pendingNotifications.balanceChanged) {
    const daysUntil = pn.event_date
      ? Math.ceil((new Date(pn.event_date) - new Date()) / (1000 * 60 * 60 * 24))
      : null;
    const isUrgent = daysUntil !== null && daysUntil <= 14;
    const dpSubject = `${isUrgent ? 'Urgent: ' : ''}Drink plan submitted with add-ons, ${clientName}`;
    const dpHtml = `<p><strong>${clientName}</strong> submitted their drink plan.</p>
             <p><strong>Add-ons selected:</strong> ${addonNames.join(', ')}</p>
             <p><strong>New total:</strong> $${snapshot.total.toFixed(2)}</p>
             <p><strong>Amount paid:</strong> $${amountPaid.toFixed(2)}</p>
             <p><strong>Balance due:</strong> $${(snapshot.total - amountPaid).toFixed(2)}</p>
             ${isUrgent ? `<p style="color: red;"><strong>Event is in ${daysUntil} days.</strong></p>` : ''}
             <p><a href="${ADMIN_URL}/proposals/${pn.id}">View Proposal</a></p>`;
    const dpText = `${clientName} submitted their drink plan with add-ons: ${addonNames.join(', ')}. New total $${snapshot.total.toFixed(2)}, balance due $${(snapshot.total - amountPaid).toFixed(2)}. ${ADMIN_URL}/proposals/${pn.id}`;
    notifyAdminCategory({ category: 'routine_admin', subject: dpSubject, emailHtml: dpHtml, emailText: dpText })
      .catch(emailErr => console.error('Admin notification failed:', emailErr));
  }
  if (clientEmail) {
    // Always-fire drink-plan-submitted confirmation. Balance language is
    // conditional on `balanceChanged`; the BYOB-vs-Hosted warning is driven
    // by `barOption`. Respect suppression rules on the immediate send.
    const { barOption, balanceChanged, clientForCheck } = pendingNotifications;
    const sendCheck = await shouldSendImmediate({
      proposal: { id: pn.id, status: pn.status || 'deposit_paid' },
      client: clientForCheck,
      channel: 'email',
    });
    if (!sendCheck.ok) {
      console.log(`[drinkPlanSubmit] suppressed for proposal ${pn.id}: ${sendCheck.reason}`);
    } else {
      const extrasAmount = balanceChanged ? snapshot.total - pn.prevTotal : 0;
      const balanceDue = balanceChanged ? snapshot.total - amountPaid : 0;
      const tpl = emailTemplates.drinkPlanBalanceUpdate({
        clientName,
        eventTypeLabel: getEventTypeLabel({ event_type: pn.event_type, event_type_custom: pn.event_type_custom }),
        barOption,
        balanceChanged,
        extrasAmount,
        newTotal: snapshot.total,
        amountPaid,
        balanceDue,
        balanceDueDate: pn.balance_due_date,
      });
      const echo = await buildSelectionsEcho(selections);
      sendEmail({
        to: clientEmail,
        ...tpl,
        html: echo.html ? tpl.html.replace('</body>', `${echo.html}</body>`) : tpl.html,
        text: `${tpl.text || ''}${echo.text}`,
        meta: { proposalId: pn.id, messageType: 'drink_plan_ready' },
      }).catch(emailErr => console.error('Client drink-plan confirmation email failed:', emailErr));
    }
  }
}

// Always-fire drink-plan-submitted confirmation for the fast path (no
// add-ons). Spec section 3.8: fires on every submission, with conditional
// balance language (false here: the fast path runs when no addons were
// added, so no balance shift).
async function sendFastPathConfirmation(planId, selections) {
  try {
    const r = await pool.query(`
      SELECT p.id, p.status AS proposal_status,
             p.event_type, p.event_type_custom, p.balance_due_date,
             p.total_price, p.amount_paid,
             c.name AS client_name, c.email AS client_email,
             c.communication_preferences, c.email_status, c.phone_status,
             sp.pricing_type AS package_pricing_type
      FROM drink_plans dp
      LEFT JOIN proposals p ON p.id = dp.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE dp.id = $1
      LIMIT 1
    `, [planId]);
    if (r.rows[0]?.client_email) {
      const row = r.rows[0];
      // Respect suppression rules on the immediate send.
      const sendCheck = await shouldSendImmediate({
        proposal: { id: row.id, status: row.proposal_status || 'deposit_paid' },
        client: {
          communication_preferences: row.communication_preferences,
          email_status: row.email_status,
          phone_status: row.phone_status,
        },
        channel: 'email',
      });
      if (!sendCheck.ok) {
        console.log(`[drinkPlanSubmitFastPath] suppressed for plan ${planId}: ${sendCheck.reason}`);
      } else {
        const barOption = row.package_pricing_type === 'per_guest' ? 'hosted' : 'byob';
        const tpl = emailTemplates.drinkPlanBalanceUpdate({
          clientName: row.client_name || 'Client',
          eventTypeLabel: getEventTypeLabel({ event_type: row.event_type, event_type_custom: row.event_type_custom }),
          barOption,
          balanceChanged: false,
          extrasAmount: 0,
          newTotal: Number(row.total_price) || 0,
          amountPaid: Number(row.amount_paid) || 0,
          balanceDue: 0,
          balanceDueDate: row.balance_due_date,
        });
        const echo = await buildSelectionsEcho(selections);
        sendEmail({
          to: row.client_email,
          ...tpl,
          html: echo.html ? tpl.html.replace('</body>', `${echo.html}</body>`) : tpl.html,
          text: `${tpl.text || ''}${echo.text}`,
          meta: { proposalId: row.id, messageType: 'drink_plan_ready' },
        }).catch(e => console.error('Drink-plan submit fast-path email failed:', e));
      }
    }
  } catch (e) {
    console.error('Drink-plan submit fast-path notification lookup failed (non-fatal):', e);
  }
}

module.exports = {
  buildSelectionsEcho,
  scheduleLabFollowupAfterSubmit,
  sendFinancialSubmitNotifications,
  sendFastPathConfirmation,
};
