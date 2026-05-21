// Post-commit, best-effort client email for a proposal that just entered the
// 'sent' state. NEVER throws — the proposal + invoice are already committed,
// so an email failure is recoverable (admin resends from the detail page).
// Invoice creation is NOT here — it runs inside the caller's DB transaction
// via createInvoiceOnSend. See the 2026-05-20 manual-proposal-overhaul spec.
const realSentry = require('@sentry/node');
const realSendEmail = require('./email').sendEmail;
const realEmailTemplates = require('./emailTemplates');
const { getEventTypeLabel } = require('./eventTypes');

const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || 'https://drbartender.com';

// Dependency seam for tests.
let _deps = { sendEmail: realSendEmail, emailTemplates: realEmailTemplates, Sentry: realSentry };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

async function sendProposalSentEmail(proposal, { actorType = 'admin' } = {}) {
  try {
    if (!proposal || !proposal.client_email) return;
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
    await _deps.sendEmail({ to: proposal.client_email, ...tpl });
  } catch (emailErr) {
    // Capture a SANITIZED error. A raw Resend/HTTP error's .message or .stack
    // can embed the recipient address — never hand the raw error to Sentry.
    // Only proposalId + actorType + a coarse cause code go in `extra`.
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
    // Log the proposal id, NOT emailErr.message (which may contain the email).
    console.error('Proposal sent email failed (non-blocking) for proposal',
      proposal && proposal.id);
    // Do NOT re-throw.
  }
}

module.exports = { sendProposalSentEmail, __setDeps };
