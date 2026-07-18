'use strict';

// Comms action: invoice_send (spec 4.4). NEW capability — there was no existing
// "send this invoice to the client" seam; the UI wave calls POST /api/comms
// directly (no legacy route to rewire).
//
// ENTITY-ID NOTE: for this action, entityId is the INVOICE id (invoices.id),
// NOT a proposal or drink-plan id. The comms registry contract is
// entity-agnostic — each action decides what its entityId means — so every
// resolve/build/side-effect/dispatch here reads server/db invoices by id, then
// joins out to the proposal and client for the live recipient.
//
// Email only. Recipient is the LIVE client email via invoice -> proposal ->
// client (invoices carry no snapshot email, so there is nothing stale to guard
// against). dispatch OWNS its ledger write (sendEmail called with skipLog) so a
// provider throw still lands a 'failed' row.
const { pool } = require('../../../db');
const { sendEmail } = require('../../email');
const { logClientMessage } = require('../../messageLog');
const { renderPartsEmail } = require('../render');
const { invoiceReadyParts } = require('../../emailTemplates');
const { checkEmailDomain } = require('../../emailValidation');
const { getEventTypeLabel } = require('../../../utils/eventTypes');
const { PUBLIC_SITE_URL } = require('../../urls');
const { NotFoundError } = require('../../errors');

const key = 'invoice_send';
const messageType = 'invoice_sent';
const defaultChannels = { email: true, sms: false };

// One row fetch shared by resolve/build/dispatch. entityId is the INVOICE id.
async function load(invoiceId) {
  const { rows } = await pool.query(
    `SELECT i.id, i.token, i.proposal_id, i.status,
            i.amount_due, i.amount_paid, i.invoice_number, i.label,
            p.event_type, p.event_type_custom,
            c.id AS client_id, c.name AS client_name, c.email AS live_email,
            c.email_status
       FROM invoices i
       LEFT JOIN proposals p ON p.id = i.proposal_id
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE i.id = $1`,
    [invoiceId]
  );
  if (!rows[0]) throw new NotFoundError('Invoice not found.');
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

  const emailReason = !email
    ? 'No email on file.'
    : (isPlaceholder
      ? 'Placeholder address (.invalid) from the CC import; no real email exists.'
      : (!row.token
        ? 'Invoice has no share token.'
        : (row.status === 'void'
          ? 'This invoice is void.'
          : (row.status === 'paid' ? 'This invoice is already paid.' : null))));
  const emailAvailable = !emailReason;

  return {
    name: row.client_name || null,
    email,
    phone: null,
    source: email ? 'client' : null,
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
        unavailable_reason: 'Invoices are sent by email only.',
      },
    },
  };
}

async function resolveRecipient(invoiceId) {
  return resolveFromRow(await load(invoiceId));
}

function defaultParts(row) {
  const eventTypeLabel = getEventTypeLabel({
    event_type: row.event_type,
    event_type_custom: row.event_type_custom,
  });
  // Invoice amounts are INTEGER CENTS (server/db/schema.sql: invoices.amount_due
  // INTEGER). Render the REMAINING balance (amount_due - amount_paid), not the
  // gross total — a re-send of a partially-paid invoice must never tell the
  // client the full amount is still due. Same posture as paymentReminder's
  // balanceDue math; the paid case is blocked upstream in resolveFromRow.
  const remainingCents = Math.max(0, Number(row.amount_due) - Number(row.amount_paid || 0));
  const amountDue = `$${(remainingCents / 100).toFixed(2)}`;
  const invoiceUrl = `${PUBLIC_SITE_URL}/invoice/${encodeURIComponent(row.token)}`;
  return {
    email: invoiceReadyParts({
      clientName: row.client_name,
      eventTypeLabel,
      amountDue,
      invoiceUrl,
    }),
    sms: null,
  };
}

async function buildMessages(invoiceId) {
  return defaultParts(await load(invoiceId));
}

/**
 * Idempotent side effect. MONEY RULE: this flips invoices.status 'draft' ->
 * 'sent' and NOTHING else. It NEVER touches amount_due, amount_paid, locked, or
 * any line item — sending an invoice changes its lifecycle state, not the money
 * owed. The WHERE status = 'draft' guard makes every non-draft state (sent,
 * paid, partially_paid, void) a clean no-op, so a second send (or a retry after
 * a failed dispatch) can never re-flip or disturb a paid/void invoice.
 */
async function ensureSideEffects(invoiceId) {
  const upd = await pool.query(
    `UPDATE invoices
        SET status = 'sent', updated_at = NOW()
      WHERE id = $1 AND status = 'draft'
      RETURNING id`,
    [invoiceId]
  );
  if (upd.rows[0]) return { applied: true };
  const check = await pool.query('SELECT id FROM invoices WHERE id = $1', [invoiceId]);
  if (!check.rows[0]) throw new NotFoundError('Invoice not found.');
  return { applied: false }; // already sent/paid/void — idempotent no-op
}

/**
 * Sends the invoice-ready email and writes one ledger row (success or failure).
 * sendEmail gets skipLog so this action's ledger write is authoritative and a
 * thrown provider error still lands a 'failed' row.
 */
async function dispatch(invoiceId, message, channels, ctx = {}) {
  const row = await load(invoiceId);
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

// dispatchWithoutSideEffects: the draft->sent flip is idempotent (WHERE
// status='draft' no-ops on every non-draft state), and the payment panel offers
// LEGITIMATE re-sends of an already-'sent' invoice — which the /send route's
// concurrent-confirm dispatch guard (05d3ebd) would otherwise skip, because
// ensureSideEffects returns applied:false on a non-draft. The flag lets those
// re-sends dispatch. TRADEOFF: double-click protection drops to the modal's
// in-flight lockout + adminWriteLimiter — exactly the level the legacy send path
// had. Inert in-lane (this branch's comms.js predates the guard), active on merge.
module.exports = {
  key, messageType, defaultChannels,
  resolveRecipient, buildMessages, ensureSideEffects, dispatch,
  dispatchWithoutSideEffects: true,
};
