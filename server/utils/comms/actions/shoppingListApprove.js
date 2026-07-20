'use strict';

// Comms action: shopping_list_approve (spec 4.4). Ports the PATCH
// /:id/shopping-list/approve behavior into the compose-first contract:
// side effects (the atomic pending_review -> approved flip, now also writing
// the client-facing approved snapshot per spec 4.9) run in ensureSideEffects,
// idempotently; dispatch sends the possibly-edited message and OWNS its ledger
// writes (sendEmail is called with skipLog so a Resend SDK throw can never
// produce a sent-but-unlogged email again — the 7/16 Brandon Martin failure).
const { pool } = require('../../../db');
const { sendEmail } = require('../../email');
const { sendSMS, normalizePhone } = require('../../sms');
const { logClientMessage } = require('../../messageLog');
const { renderPartsEmail } = require('../render');
const { shoppingListReadyParts } = require('../../lifecycleEmailTemplates');
const { checkEmailDomain } = require('../../emailValidation');
const { getEventTypeLabel } = require('../../../utils/eventTypes');
const { ensureNotFinalized } = require('../../beoFinalize');
const { NotFoundError, ConflictError } = require('../../errors');
const { PUBLIC_SITE_URL } = require('../../urls');

const key = 'shopping_list_approve';
const messageType = 'shopping_list_ready';
const defaultChannels = { email: true, sms: false };

// One row fetch shared by resolve/build/dispatch. Live client email via the
// proposal join is the source of truth (spec 4.2: recipient is never the
// drink_plans snapshot when a linked client exists — the snapshot went stale
// for Brandon Martin and Aaran Varatharajan and killed their sends).
async function load(planId) {
  const { rows } = await pool.query(
    `SELECT dp.id, dp.token, dp.proposal_id, dp.client_name,
            dp.client_email AS snapshot_email,
            dp.event_type, dp.event_type_custom,
            dp.shopping_list IS NOT NULL AS has_list, dp.shopping_list_status,
            c.id AS client_id, c.email AS live_email, c.phone AS live_phone,
            c.email_status,
            sp.pricing_type
       FROM drink_plans dp
       LEFT JOIN proposals p ON p.id = dp.proposal_id
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE dp.id = $1`,
    [planId]
  );
  if (!rows[0]) throw new NotFoundError('Plan not found.');
  return rows[0];
}

function resolveFromRow(row) {
  const email = row.live_email || row.snapshot_email || null;
  const source = row.live_email ? 'client' : 'snapshot';
  const phone = row.live_phone ? normalizePhone(row.live_phone) : null;
  const isHosted = row.pricing_type === 'per_guest';
  // RFC-2606 import placeholders (CC import): sendEmail silently drops them,
  // so offering the channel would report a send that never happens.
  const isPlaceholder = Boolean(email && String(email).toLowerCase().endsWith('.invalid'));
  const warnings = [];

  if (row.live_email && row.snapshot_email && row.live_email !== row.snapshot_email) {
    warnings.push(`Plan record still holds an older email (${row.snapshot_email}); sending to the current client record instead.`);
  }
  if (row.email_status === 'bad') {
    warnings.push('A previous email to this address hard-bounced. Confirm the address before sending.');
  }
  if (email) {
    const typo = checkEmailDomain(email);
    if (typo.suspicious) warnings.push(typo.reason + (typo.suggestion ? ` Did you mean ${typo.suggestion}?` : ''));
  }
  if (!email && !isHosted) warnings.push('No email on file for this client.');
  if (isPlaceholder && !isHosted) warnings.push('Address is a CC-import placeholder (.invalid); no real email exists for this client.');
  if (row.live_phone && !phone) warnings.push('Phone on file could not be parsed for SMS.');

  const emailAvailable = Boolean(email && row.token && !isHosted && !isPlaceholder);
  // SMS mirrors every email guard (review finding: a hosted client must not
  // get a shopping-list text either; the token rides in the SMS body too).
  const smsAvailable = Boolean(phone && row.token && !isHosted);
  return {
    name: row.client_name || null,
    email,
    phone,
    source,
    warnings,
    channels: {
      email: {
        available: emailAvailable,
        default: defaultChannels.email && emailAvailable,
        unavailable_reason: isHosted
          ? 'Hosted package: DRB does the shopping, no client email applies.'
          : (!email ? 'No email on file.'
            : (isPlaceholder ? 'Placeholder address (.invalid) from the CC import; no real email exists.'
              : (!row.token ? 'Plan has no share token.' : null))),
      },
      sms: {
        available: smsAvailable,
        default: false,
        unavailable_reason: isHosted
          ? 'Hosted package: DRB does the shopping, no client SMS applies.'
          : (!phone ? 'No usable phone on file.' : (!row.token ? 'Plan has no share token.' : null)),
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
  const shoppingListUrl = `${PUBLIC_SITE_URL}/shopping-list/${row.token}`;
  return {
    email: shoppingListReadyParts({
      clientName: row.client_name,
      eventTypeLabel,
      shoppingListUrl,
    }),
    sms: {
      body: `Hi, Dallas here. Your shopping list for your ${eventTypeLabel} is ready: ${shoppingListUrl}`,
    },
  };
}

async function buildMessages(planId) {
  return defaultParts(await load(planId));
}

/**
 * Idempotent side effects: the original route's atomic transition, extended to
 * write the approved snapshot in the same UPDATE (spec 4.9). Second call
 * returns { applied: false } and changes nothing (no re-approve, no
 * re-snapshot), which is what makes a failed-dispatch Retry safe.
 */
async function ensureSideEffects(planId) {
  await ensureNotFinalized(parseInt(planId, 10));
  const upd = await pool.query(
    `UPDATE drink_plans
        SET shopping_list_status = 'approved',
            shopping_list_approved_at = NOW(),
            shopping_list_approved_snapshot = shopping_list,
            updated_at = NOW()
      WHERE id = $1
        AND shopping_list IS NOT NULL
        AND shopping_list_status IS DISTINCT FROM 'approved'
      RETURNING id`,
    [planId]
  );
  if (upd.rows[0]) return { applied: true };

  const check = await pool.query(
    `SELECT shopping_list IS NOT NULL AS has_list, shopping_list_status FROM drink_plans WHERE id = $1`,
    [planId]
  );
  if (!check.rows[0]) throw new NotFoundError('Plan not found.');
  if (!check.rows[0].has_list) {
    throw new ConflictError('Cannot approve: this plan has no shopping list yet. Generate one first.');
  }
  return { applied: false }; // already approved — idempotent no-op
}

/**
 * Sends on the selected channels and writes one ledger row per attempt,
 * success or failure. sendEmail/sendSMS get skipLog: this action's ledger
 * writes are authoritative (sent_by, body_edited, exact error), and a thrown
 * provider error still lands a 'failed' row — no silent gaps.
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
  if (wantSms && !recipient.channels.sms.available) {
    results.skip_reasons.sms = recipient.channels.sms.unavailable_reason;
  } else if (!wantSms) {
    results.skip_reasons.sms = 'not selected';
  }

  if (wantEmail && recipient.channels.email.available) {
    const subject = (message?.email?.subject ?? defaults.email.subject).trim();
    const bodyText = (message?.email?.bodyText ?? defaults.email.bodyText).trim();
    const bodyEdited = subject !== defaults.email.subject || bodyText !== defaults.email.bodyText;
    const rendered = renderPartsEmail({ ...defaults.email, subject, bodyText });
    let entry = {
      channel: 'email', recipient: recipient.email, subject,
      proposalId: row.proposal_id, clientId: row.client_id || null,
      messageType, sentBy: ctx.sentBy || null, bodyEdited,
    };
    try {
      const r = await sendEmail({
        to: recipient.email, subject: rendered.subject, html: rendered.html, text: rendered.text,
        meta: { skipLog: true },
      });
      if (r && r.id === 'skipped-invalid') {
        // Defense in depth behind the availability guard: sendEmail dropped a
        // placeholder recipient, so nothing left the building. Never report
        // or ledger it as sent (the sent-but-not-sent class this lane kills).
        results.email = 'skipped';
        results.skip_reasons.email = 'Placeholder address (.invalid); no email was sent.';
      } else {
        results.email = 'sent';
        if (r && r.id !== 'dev-skipped') {
          await logClientMessage({ ...entry, status: 'sent', providerId: r.id });
        }
      }
    } catch (err) {
      results.email = 'failed';
      results.email_error = err.message || 'Email send failed.';
      await logClientMessage({ ...entry, status: 'failed', error: String(err.message || err).slice(0, 500) });
    }
  }

  if (wantSms && recipient.channels.sms.available) {
    const body = (message?.sms?.body ?? defaults.sms.body).trim();
    const bodyEdited = body !== defaults.sms.body;
    let entry = {
      channel: 'sms', recipient: recipient.phone, subject: body.slice(0, 140),
      proposalId: row.proposal_id, clientId: row.client_id || null,
      messageType: `${messageType}_sms`, sentBy: ctx.sentBy || null, bodyEdited,
    };
    try {
      const r = await sendSMS({ to: recipient.phone, body, meta: { skipLog: true } });
      results.sms = 'sent';
      if (r && !String(r.sid || '').startsWith('dev-skipped')) {
        await logClientMessage({ ...entry, status: 'sent', providerId: r.sid });
      }
    } catch (err) {
      results.sms = 'failed';
      results.sms_error = err.message || 'SMS send failed.';
      await logClientMessage({ ...entry, status: 'failed', error: String(err.message || err).slice(0, 500) });
    }
  }

  results.recipient_email = recipient.email;
  results.recipient_phone = recipient.phone;
  return results;
}

module.exports = {
  key, messageType, defaultChannels, allowSilent: true,
  resolveRecipient, buildMessages, ensureSideEffects, dispatch,
};
