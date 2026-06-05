// Post-commit, best-effort client email + SMS for a proposal that just entered
// the 'sent' state. NEVER throws — the proposal + invoice are already
// committed, so a notification failure is recoverable (admin resends from the
// detail page). Invoice creation is NOT here — it runs inside the caller's DB
// transaction via createInvoiceOnSend. See the 2026-05-20 manual-proposal-
// overhaul spec and the 2026-05-22 comms Phase 3 plan (initial-proposal SMS).
const realSentry = require('@sentry/node');
const realSendEmail = require('./email').sendEmail;
const realEmailTemplates = require('./emailTemplates');
const realSendAndLogSms = require('./sms').sendAndLogSms;
const smsTemplates = require('./smsTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { shouldSendImmediate } = require('./messageSuppression');

const { PUBLIC_SITE_URL } = require('./urls');

// Dependency seam for tests.
let _deps = {
  sendEmail: realSendEmail,
  emailTemplates: realEmailTemplates,
  sendAndLogSms: realSendAndLogSms,
  Sentry: realSentry,
};
function __setDeps(d) { _deps = { ..._deps, ...d }; }

/** Format a YYYY-MM-DD / Date event_date as "August 15" for SMS copy. */
function formatSmsDate(eventDate) {
  if (!eventDate) return 'your event';
  const ymd = String(eventDate).slice(0, 10);
  const parsed = new Date(ymd + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) return 'your event';
  return parsed.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

async function sendProposalSentEmail(proposal, { actorType = 'admin' } = {}) {
  // ── Email half (existing behavior) ──
  try {
    if (!proposal || !proposal.client_email) {
      // No email — fall through to the SMS attempt below anyway.
    } else {
      const proposalUrl = `${PUBLIC_SITE_URL}/proposal/${proposal.token}`;
      const eventTypeLabel = getEventTypeLabel({
        event_type: proposal.event_type,
        event_type_custom: proposal.event_type_custom,
      });
      const tpl = _deps.emailTemplates.proposalSent({
        clientName: proposal.client_name,
        eventTypeLabel,
        proposalUrl,
        planUrl: null,
      });
      await _deps.sendEmail({ to: proposal.client_email, ...tpl, meta: { proposalId: proposal.id, messageType: 'proposal_sent' } });
    }
  } catch (emailErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      _deps.Sentry.captureException(new Error('proposalSent email failed'), {
        tags: { route: 'proposals/sent', issue: 'email' },
        extra: {
          proposalId: proposal && proposal.id,
          actorType,
          cause: (emailErr && (emailErr.code || emailErr.name)) || 'unknown',
        },
      });
    }
    console.error('Proposal sent email failed (non-blocking) for proposal',
      proposal && proposal.id);
  }

  // ── SMS half (Phase 3, spec 1.2) — separate try/catch so an SMS failure
  // never masks a successful email and never throws into the request path. ──
  try {
    if (!proposal) return;
    const sendCheck = await shouldSendImmediate({
      proposal: { id: proposal.id, status: proposal.status },
      client: {
        communication_preferences: proposal.communication_preferences,
        email_status: proposal.email_status,
        phone_status: proposal.phone_status,
      },
      channel: 'sms',
    });
    if (!sendCheck.ok) {
      console.log(`[initialProposalSms] suppressed for proposal ${proposal.id}: ${sendCheck.reason}`);
      return;
    }
    const eventTypeLabel = getEventTypeLabel({
      event_type: proposal.event_type,
      event_type_custom: proposal.event_type_custom,
    });
    const body = smsTemplates.initialProposalSms({
      eventTypeLabel,
      eventDate: formatSmsDate(proposal.event_date),
      link: `${PUBLIC_SITE_URL}/proposal/${proposal.token}`,
    });
    await _deps.sendAndLogSms({
      to: proposal.client_phone,
      body,
      clientId: proposal.client_id || null,
      proposalId: proposal.id,
      messageType: 'initial_proposal',
      recipientName: proposal.client_name || null,
    });
  } catch (smsErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      _deps.Sentry.captureException(new Error('initialProposalSms failed'), {
        tags: { route: 'proposals/sent', issue: 'sms' },
        extra: {
          proposalId: proposal && proposal.id,
          actorType,
          cause: (smsErr && (smsErr.code || smsErr.name)) || 'unknown',
        },
      });
    }
    console.error('Initial-proposal SMS failed (non-blocking) for proposal',
      proposal && proposal.id);
  }
}

module.exports = { sendProposalSentEmail, __setDeps };
