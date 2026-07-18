'use strict';

// Comms action: proposal_send_group (plan P1). Ports POST
// /api/proposals/:id/send-group (server/routes/proposals/groups.js ->
// utils/groupSend.js). EMAIL ONLY: a comparison goes out as one
// proposalOptionsSent "compare your options" email; there is deliberately no
// per-option text message. ensureSideEffects runs the exact groupSend
// transaction (FOR UPDATE lock — the AB-BA-safe ordering — transition every
// draft member to 'sent' with NO per-option invoice and NO per-option
// proposalSent comms), idempotently: a second call finds no newly-draft members
// and applies nothing. dispatch OWNS the single compare email + its ledger row.
const { pool } = require('../../../db');
const { sendEmail } = require('../../email');
const { logClientMessage } = require('../../messageLog');
const { renderPartsEmail } = require('../render');
const { proposalOptionsSentParts } = require('../../emailTemplates');
const { checkEmailDomain } = require('../../emailValidation');
const { getEventTypeLabel } = require('../../../utils/eventTypes');
const { NotFoundError, ConflictError } = require('../../errors');
const { PUBLIC_SITE_URL } = require('../../urls');

const key = 'proposal_send_group';
const messageType = 'proposal_options_sent';
const defaultChannels = { email: true, sms: false };
const SMS_UNAVAILABLE = 'Compare sends have no text message.';

// Live client + group token + a representative event label (all options share the
// client + event). Rejects a solo proposal exactly like the legacy route.
async function load(proposalId) {
  const { rows } = await pool.query(
    `SELECT p.id AS proposal_id, p.group_id,
            g.token AS group_token, g.chosen_proposal_id,
            c.id AS client_id, c.name AS client_name, c.email AS live_email,
            c.email_status,
            m.event_type, m.event_type_custom
       FROM proposals p
       LEFT JOIN proposal_groups g ON g.id = p.group_id
       LEFT JOIN clients c ON c.id = g.client_id
       LEFT JOIN LATERAL (
         SELECT event_type, event_type_custom FROM proposals
          WHERE group_id = p.group_id ORDER BY created_at ASC LIMIT 1
       ) m ON true
      WHERE p.id = $1`,
    [proposalId]
  );
  if (!rows[0]) throw new NotFoundError('Proposal not found');
  if (!rows[0].group_id) throw new ConflictError('This proposal is not part of a comparison', 'NOT_GROUPED');
  return rows[0];
}

function resolveFromRow(row) {
  const email = row.live_email || null;
  // RFC-2606 import placeholders (CC import): sendEmail silently drops them, so
  // offering the channel would report a send that never happens (mirrors 937ba35).
  const isPlaceholder = Boolean(email && String(email).toLowerCase().endsWith('.invalid'));
  const warnings = [];
  if (row.email_status === 'bad') {
    warnings.push('A previous email to this address hard-bounced. Confirm the address before sending.');
  }
  if (email) {
    const typo = checkEmailDomain(email);
    if (typo.suspicious) warnings.push(typo.reason + (typo.suggestion ? ` Did you mean ${typo.suggestion}?` : ''));
  }
  if (!email) warnings.push('No email on file for this client.');
  if (isPlaceholder) warnings.push('Address is a CC-import placeholder (.invalid); no real email exists for this client.');

  // A placeholder can never be reported available (937ba35). Compare sends are
  // email-only, so there is no SMS token guard to mirror here.
  const emailAvailable = Boolean(email && row.group_token && !isPlaceholder);

  return {
    name: row.client_name || null,
    email,
    phone: null,
    source: 'client',
    warnings,
    channels: {
      email: {
        available: emailAvailable,
        default: defaultChannels.email && emailAvailable,
        unavailable_reason: !email ? 'No email on file.'
          : (isPlaceholder ? 'Placeholder address (.invalid) from the CC import; no real email exists.'
            : (!row.group_token ? 'Comparison has no share token.' : null)),
      },
      sms: {
        available: false,
        default: false,
        unavailable_reason: SMS_UNAVAILABLE,
      },
    },
  };
}

async function resolveRecipient(proposalId) {
  return resolveFromRow(await load(proposalId));
}

function defaultParts(row) {
  const eventTypeLabel = getEventTypeLabel({
    event_type: row.event_type,
    event_type_custom: row.event_type_custom,
  });
  return {
    email: proposalOptionsSentParts({
      clientName: row.client_name,
      eventTypeLabel,
      compareUrl: `${PUBLIC_SITE_URL}/compare/${row.group_token}`,
    }),
    sms: { body: null }, // no SMS for compare sends
  };
}

async function buildMessages(proposalId) {
  return defaultParts(await load(proposalId));
}

/**
 * Ports groupSend's transaction verbatim: FOR UPDATE on the group row (the
 * lock ordering that fixed the AB-BA compare deadlock), refuse a decided
 * comparison, transition every DRAFT member to 'sent' (all-or-nothing) with NO
 * per-option invoice (deferred to the winner) and NO per-option proposalSent
 * (suppressed in favor of the one compare email dispatch sends). Idempotent: a
 * re-run finds no draft members, flips nothing, and reports applied:false, so
 * the deprecated route skips the compare email exactly as groupSend's
 * "only-email-when-newly-sent" dedupe did. One pooled connection for the whole
 * transaction (no bare pool.query inside).
 */
async function ensureSideEffects(proposalId, ctx = {}) {
  const head = await load(proposalId); // NotFoundError / NOT_GROUPED guards
  const groupId = head.group_id;
  const actorUserId = ctx.sentBy || null;

  const db = await pool.connect();
  let sentIds = [];
  let groupToken;
  try {
    await db.query('BEGIN');
    const g = await db.query(
      'SELECT id, token, chosen_proposal_id FROM proposal_groups WHERE id = $1 FOR UPDATE',
      [groupId]
    );
    if (!g.rows[0]) throw new NotFoundError('Comparison not found');
    if (g.rows[0].chosen_proposal_id) throw new ConflictError('This comparison is already decided');
    groupToken = g.rows[0].token;

    const upd = await db.query(
      `UPDATE proposals SET status = 'sent', sent_at = COALESCE(sent_at, NOW())
        WHERE group_id = $1 AND status = 'draft' RETURNING id`,
      [groupId]
    );
    sentIds = upd.rows.map((r) => r.id);

    if (sentIds.length) {
      await db.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
         SELECT UNNEST($1::int[]), 'group_sent', 'admin', $2, $3`,
        [sentIds, actorUserId, JSON.stringify({ group_id: groupId })]
      );
    }
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }

  return { applied: sentIds.length > 0, groupToken, sentCount: sentIds.length };
}

async function dispatch(proposalId, message, channels, ctx = {}) {
  const row = await load(proposalId);
  const recipient = resolveFromRow(row);
  const defaults = defaultParts(row);
  const results = { email: 'skipped', sms: 'skipped', skip_reasons: {} };

  const wantEmail = channels.includes('email');
  // SMS is never a channel for compare sends; report it honestly.
  results.skip_reasons.sms = SMS_UNAVAILABLE;

  if (wantEmail && !recipient.channels.email.available) {
    results.skip_reasons.email = recipient.channels.email.unavailable_reason;
  } else if (!wantEmail) {
    results.skip_reasons.email = 'not selected';
  }

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

module.exports = {
  key, messageType, defaultChannels,
  resolveRecipient, buildMessages, ensureSideEffects, dispatch,
};
