// Post-commit, best-effort client email + SMS for a proposal that just entered
// the 'sent' state. NEVER throws — the proposal + invoice are already
// committed, so a notification failure is recoverable (admin resends from the
// detail page). Resolves to { emailSent, smsSent } so a caller whose only
// delivery is this send (the wizard's matched-client path, audit 2026-11-05
// AUTH-12) can tell whether the link went out and how; the swallow-and-log
// behavior is unchanged. Invoice creation is NOT here — it runs inside the caller's DB
// transaction via createInvoiceOnSend. See the 2026-05-20 manual-proposal-
// overhaul spec and the 2026-05-22 comms Phase 3 plan (initial-proposal SMS).
const realSentry = require('@sentry/node');
const realSendEmail = require('./email').sendEmail;
const realEmailTemplates = require('./emailTemplates');
const realSendAndLogSms = require('./sms').sendAndLogSms;
const smsTemplates = require('./smsTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { shouldSendImmediate } = require('./messageSuppression');

const { proposalUrl: buildProposalUrl } = require('./urls');
const { formatEventDateForSms } = require('./smsEventDate');
const { routeProposalText: realRouteProposalText } = require('./gvPost/queue');

// Dependency seam for tests.
let _deps = {
  sendEmail: realSendEmail,
  emailTemplates: realEmailTemplates,
  sendAndLogSms: realSendAndLogSms,
  Sentry: realSentry,
  routeProposalText: realRouteProposalText,
};
function __setDeps(d) { _deps = { ..._deps, ...d }; }

// sentBy (Inbox spec 2026-10-06, section 9) is the admin who clicked Send, a
// VALUE from the route. The website quote wizard passes none, so its send
// ledgers sent_by NULL and never counts as a reply.
async function sendProposalSentEmail(proposal, { actorType = 'admin', sentBy = null } = {}) {
  let emailSent = false;
  // ── Email half (existing behavior) ──
  try {
    if (!proposal || !proposal.client_email) {
      // No email — fall through to the SMS attempt below anyway.
    } else {
      const proposalUrl = buildProposalUrl(proposal.token);
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
      await _deps.sendEmail({
        to: proposal.client_email, ...tpl,
        meta: { proposalId: proposal.id, clientId: proposal.client_id || null, messageType: 'proposal_sent', sentBy },
      });
      emailSent = true;
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

  // ── SMS half (Phase 3, spec 1.2). Never throws: an SMS failure never masks
  // a successful email and never reaches the request path. ──
  // 'sent' is a text Twilio took. A queued GV post is not a text (only an
  // admin send routes, and its callers ignore this value); 'skipped' is an
  // unparseable or missing phone: nothing went out.
  const smsSent = (await sendInitialProposalText(proposal, { sentBy, actorType })) === 'sent';
  return { emailSent, smsSent };
}

/**
 * The initial-proposal text (Phase 3, spec 1.2), and since 2026-10-17 its GV
 * routing (spec docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md):
 * after today's suppression passes, an admin send (the lifecycle and crud
 * sends, via 'auto') asks routeProposalText first, and a queued or merged GV
 * post into the Thumbtack thread replaces the toll-free text. The website
 * wizard (actorType 'client') never routes. The GV sender's toll-free fallback
 * calls back in with via 'twilio', which skips the router, so this stays the
 * one writer of the initial_proposal type. NEVER throws.
 *
 * @param {Object} proposal - the joined proposal row (token, event_type*, event_date, status,
 *   client_id, client_name, client_phone, communication_preferences, email_status, phone_status)
 * @param {{sentBy?:number|null, actorType?:'admin'|'client', via?:'auto'|'twilio'}} [opts]
 * @returns {Promise<'queued'|'sent'|'suppressed'|'skipped'|'failed'>} 'skipped' is no
 *   usable phone; 'failed' is a caught send throw
 */
async function sendInitialProposalText(proposal, { sentBy = null, actorType = 'admin', via = 'auto' } = {}) {
  try {
    if (!proposal) return 'skipped';
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
      return 'suppressed';
    }
    const eventTypeLabel = getEventTypeLabel({
      event_type: proposal.event_type,
      event_type_custom: proposal.event_type_custom,
    });
    const body = smsTemplates.initialProposalSms({
      eventTypeLabel,
      eventDate: formatEventDateForSms(proposal.event_date),
      link: buildProposalUrl(proposal.token),
    });
    if (via === 'auto' && actorType === 'admin' && await routedToGv(proposal, body, sentBy)) {
      return 'queued';
    }
    const result = await _deps.sendAndLogSms({
      to: proposal.client_phone,
      body,
      clientId: proposal.client_id || null,
      proposalId: proposal.id,
      messageType: 'initial_proposal',
      recipientName: proposal.client_name || null,
      sentBy,
    });
    return result && result.status === 'skipped' ? 'skipped' : 'sent';
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
    return 'failed';
  }
}

// True when the router queued a GV post or merged into the open one. The
// router never throws; if it ever did, this falls open to today's text.
async function routedToGv(proposal, body, sentBy) {
  try {
    const routed = await _deps.routeProposalText({
      proposalId: proposal.id, token: proposal.token, body, sentBy, sendPath: 'auto',
    });
    return routed.route === 'gv' || routed.route === 'merged';
  } catch (routeErr) {
    console.error('GV routing threw for proposal', proposal.id,
      (routeErr && (routeErr.code || routeErr.name)) || 'unknown', '; texting as today');
    return false;
  }
}

module.exports = { sendProposalSentEmail, sendInitialProposalText, __setDeps };
