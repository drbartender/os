'use strict';

// Comms action: consult_recap (spec 4.4). Converts the post-consult client
// recap email (the second stale-snapshot sender) into the compose-first
// contract AND fixes its recipient bug.
//
// THE BUG: the legacy send (drinkPlanConsult.js post-commit block) read
// dp.client_email — the drink_plans SNAPSHOT — as the recipient. That snapshot
// goes stale when a client updates their email (the Brandon Martin failure
// shape). resolveRecipient here resolves the LIVE client email via the proposal
// join, with the snapshot kept only as a fallback + mismatch warning, mirroring
// shoppingListApprove.js.
//
// Email only. Recap is an AUTOMATIC send fired on consult save (no admin in the
// loop to read a warning), so unlike shoppingListApprove it HARD-suppresses the
// email channel on the same rules the legacy path applied via shouldSendImmediate:
// archived event, email opt-out, or a known-bad address. The stale-snapshot and
// typo-domain signals stay warnings.
//
// dispatch OWNS its ledger write (sendEmail called with skipLog) so a provider
// throw still lands a 'failed' row.
const { pool } = require('../../../db');
const { sendEmail } = require('../../email');
const { logClientMessage } = require('../../messageLog');
const { renderPartsEmail } = require('../render');
const { consultRecapParts } = require('../../lifecycleEmailTemplates');
const { formatConsultRecap, pickNextStepLine } = require('../../consultRecap');
const { checkEmailDomain } = require('../../emailValidation');
const { getEventTypeLabel } = require('../../../utils/eventTypes');
const { NotFoundError } = require('../../errors');

const key = 'consult_recap';
const messageType = 'consult_recap';
const defaultChannels = { email: true, sms: false };

// One row fetch shared by resolve/build/dispatch. Live client email via the
// proposal join is the source of truth; dp.client_email is a fallback only.
async function load(planId) {
  const { rows } = await pool.query(
    `SELECT dp.id, dp.proposal_id, dp.client_name,
            dp.client_email AS snapshot_email,
            dp.event_type, dp.event_type_custom, dp.event_date,
            dp.consult_selections, dp.consult_filled_at,
            p.status AS proposal_status,
            c.id AS client_id, c.email AS live_email, c.email_status,
            c.communication_preferences,
            sp.pricing_type
       FROM drink_plans dp
       LEFT JOIN proposals p ON p.id = dp.proposal_id
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE dp.id = $1`,
    [planId]
  );
  if (!rows[0]) throw new NotFoundError('Drink plan not found.');
  return rows[0];
}

function resolveFromRow(row) {
  const email = row.live_email || row.snapshot_email || null;
  const source = row.live_email ? 'client' : 'snapshot';
  const prefs = row.communication_preferences || {};
  const archived = row.proposal_status === 'archived';
  const optedOut = prefs.email_enabled === false;
  const emailBad = row.email_status === 'bad';
  // RFC-2606 import placeholders (CC import): sendEmail silently drops them, so
  // offering the channel would report a send that never happens (mirrors 937ba35).
  const isPlaceholder = Boolean(email && String(email).toLowerCase().endsWith('.invalid'));
  const warnings = [];

  if (row.live_email && row.snapshot_email && row.live_email !== row.snapshot_email) {
    warnings.push(`Plan record still holds an older email (${row.snapshot_email}); sending to the current client record instead.`);
  }
  if (email) {
    const typo = checkEmailDomain(email);
    if (typo.suspicious) warnings.push(typo.reason + (typo.suggestion ? ` Did you mean ${typo.suggestion}?` : ''));
  }
  if (isPlaceholder) warnings.push('Address is a CC-import placeholder (.invalid); no real email exists for this client.');

  // Automatic-send suppression (legacy shouldSendImmediate parity): no email, a
  // .invalid CC-import placeholder, archived event, email opt-out, or a known-bad
  // address all make the email channel unavailable with an honest reason.
  const emailReason = !email
    ? 'No email on file.'
    : (isPlaceholder
      ? 'Placeholder address (.invalid) from the CC import; no real email exists.'
      : (archived
        ? 'This event is archived; recap not sent.'
        : (optedOut
          ? 'Client has opted out of email.'
          : (emailBad ? 'A previous email to this address hard-bounced.' : null))));
  const emailAvailable = !emailReason;

  return {
    name: row.client_name || null,
    email,
    phone: null,
    source,
    warnings,
    channels: {
      email: {
        available: emailAvailable,
        default: defaultChannels.email && emailAvailable,
        unavailable_reason: emailReason,
      },
      sms: {
        available: false,
        default: false,
        unavailable_reason: 'Recap is email only.',
      },
    },
  };
}

async function resolveRecipient(planId) {
  return resolveFromRow(await load(planId));
}

function defaultParts(row) {
  const eventTypeLabel = getEventTypeLabel({
    event_type: row.event_type,
    event_type_custom: row.event_type_custom,
  });
  const formattedEventDate = row.event_date
    ? new Date(row.event_date).toLocaleDateString('en-US', {
        timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      })
    : null;
  // Hosted (per_guest) events point at bartender prep; BYOB points at the
  // shopping list, exactly as the legacy route derived from pricing_type.
  const barOption = row.pricing_type === 'per_guest' ? 'hosted' : 'byob';
  return {
    email: consultRecapParts({
      clientName: row.client_name,
      eventTypeLabel,
      formattedEventDate,
      drinkRecapLines: formatConsultRecap(row.consult_selections),
      nextStepLine: pickNextStepLine(barOption),
    }),
    sms: null,
  };
}

async function buildMessages(planId) {
  return defaultParts(await load(planId));
}

/**
 * Idempotent side effect: flip consult_filled_at NULL -> NOW(). This marks the
 * consult recorded, which also suppresses the T-21 drink-plan nudge (see
 * loadNudgeContext in drinkPlanNudge.js). The WHERE consult_filled_at IS NULL
 * guard makes a second call a clean no-op — never re-flips, never moves the
 * timestamp — so a failed-dispatch retry is safe.
 *
 * In the delegating consult-save route this is a no-op because the save
 * transaction already flipped consult_filled_at; the action still owns the flip
 * for any standalone invocation.
 */
async function ensureSideEffects(planId) {
  const upd = await pool.query(
    `UPDATE drink_plans
        SET consult_filled_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND consult_filled_at IS NULL
      RETURNING id`,
    [planId]
  );
  if (upd.rows[0]) return { applied: true };
  const check = await pool.query('SELECT id FROM drink_plans WHERE id = $1', [planId]);
  if (!check.rows[0]) throw new NotFoundError('Drink plan not found.');
  return { applied: false }; // already recorded — idempotent no-op
}

/**
 * Sends the recap on the email channel and writes one ledger row (success or
 * failure). sendEmail gets skipLog so this action's ledger write is
 * authoritative and a thrown provider error still lands a 'failed' row.
 */
async function dispatch(planId, message, channels, ctx = {}) {
  const row = await load(planId);
  const recipient = resolveFromRow(row);
  const defaults = defaultParts(row);
  const results = { email: 'skipped', sms: 'skipped', skip_reasons: {} };

  const wantEmail = channels.includes('email');
  const wantSms = channels.includes('sms');

  if (wantEmail && !recipient.channels.email.available) {
    results.skip_reasons.email = recipient.channels.email.unavailable_reason;
  } else if (!wantEmail) {
    results.skip_reasons.email = 'not selected';
  }
  // SMS is never a channel for this action.
  results.skip_reasons.sms = wantSms ? recipient.channels.sms.unavailable_reason : 'not selected';

  if (wantEmail && recipient.channels.email.available) {
    const subject = (message?.email?.subject ?? defaults.email.subject).trim();
    const bodyText = (message?.email?.bodyText ?? defaults.email.bodyText).trim();
    const bodyEdited = subject !== defaults.email.subject || bodyText !== defaults.email.bodyText;
    const rendered = renderPartsEmail({ ...defaults.email, subject, bodyText });
    const entry = {
      channel: 'email', recipient: recipient.email, subject,
      proposalId: row.proposal_id, clientId: row.client_id || null,
      messageType, sentBy: ctx.sentBy || null, bodyEdited,
    };
    try {
      const r = await sendEmail({
        to: recipient.email, subject: rendered.subject, html: rendered.html, text: rendered.text,
        meta: { skipLog: true },
      });
      results.email = 'sent';
      if (r && r.id !== 'dev-skipped') {
        await logClientMessage({ ...entry, status: 'sent', providerId: r.id });
      }
    } catch (err) {
      results.email = 'failed';
      results.email_error = err.message || 'Email send failed.';
      await logClientMessage({ ...entry, status: 'failed', error: String(err.message || err).slice(0, 500) });
    }
  }

  results.recipient_email = recipient.email;
  results.recipient_phone = null;
  return results;
}

// dispatchWithoutSideEffects: pre-applied side effect. The consult-save
// transaction flips consult_filled_at BEFORE the recap dispatches, so
// ensureSideEffects is an idempotent no-op (applied:false) at send time and
// SENDING IS the operation. Without the flag the /send route's concurrent-confirm
// dispatch guard (05d3ebd) would skip the dispatch. Inert in-lane (this branch's
// comms.js predates the guard), active on merge.
module.exports = {
  key, messageType, defaultChannels,
  resolveRecipient, buildMessages, ensureSideEffects, dispatch,
  dispatchWithoutSideEffects: true,
};
