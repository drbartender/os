/**
 * Payroll-domain email templates for Dr. Bartender — admin-facing notifications
 * for the staff payment system (Phase 2+). Carved out of emailTemplates.js to
 * keep that file under the file-size cap. emailTemplates.js re-exports the
 * templates below for backwards compatibility, so consumers that access them
 * by property (emailTemplates.disputeWonAdminNotification) keep working.
 *
 * IMPORTANT — BRAND, wrapEmail, and ctaButton are DUPLICATED here on purpose.
 * They also exist in emailTemplates.js. emailTemplates.js requires this file
 * lazily inside its module.exports list, so this file's require of
 * emailTemplates.js would create a cycle. We duplicate those helpers rather
 * than import them. Mirrors the pattern in lifecycleEmailTemplates.js. esc is
 * the exception — it lives in ./htmlEscape and is imported by both.
 */

const { esc } = require('./htmlEscape');

const BRAND = {
  dark: '#2d1810',
  primary: '#3b2314',
  secondary: '#6b4226',
  bg: '#f9f6f3',
  white: '#ffffff',
};

function wrapEmail(innerHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:Georgia,serif;color:${BRAND.primary};">
  <div style="max-width:600px;margin:0 auto;background:${BRAND.white};">
    <div style="background:${BRAND.dark};padding:24px;text-align:center;">
      <span style="color:${BRAND.white};font-size:22px;font-weight:bold;letter-spacing:1px;">Dr. Bartender</span>
    </div>
    <div style="padding:32px 28px;">
      ${innerHtml}
    </div>
    <div style="border-top:1px solid #e0d6cf;padding:20px 28px;text-align:center;">
      <p style="margin:0;font-size:12px;color:${BRAND.secondary};">Dr. Bartender &middot; drbartender.com</p>
    </div>
  </div>
</body>
</html>`;
}

function ctaButton(url, label) {
  return `<p style="text-align:center;margin:2rem 0;">
  <a href="${url}" style="display:inline-block;padding:14px 32px;background:${BRAND.primary};color:${BRAND.white};text-decoration:none;border-radius:6px;font-weight:bold;font-size:16px;">${label}</a>
</p>`;
}

function disputeWonAdminNotification({
  amountDollars,
  perBartender,
  eventDateLabel,
  eventTypeLabel = 'event',
  clientName,
  disputeOpenedLabel,
  disputeWonLabel,
  payrollUrl,
}) {
  const subject = `Stripe dispute won: restore $${amountDollars} to ${perBartender.length} bartender${perBartender.length === 1 ? '' : 's'}`;
  const rows = perBartender.map(b =>
    `<tr><td style="padding:6px 12px">${esc(b.name)}</td><td style="padding:6px 12px;text-align:right">$${esc(b.shareDollars)}</td></tr>`
  ).join('');
  const innerHtml = `
    <h2 style="margin:0 0 12px 0">Stripe dispute won</h2>
    <p>We won the dispute on a $${esc(amountDollars)} card tip. Stripe has reinstated the funds. Because we already clawed the bartenders' shares back from their next payout when the dispute was opened, you'll need to manually add a positive adjustment on each affected payout so the staff get the money back.</p>
    <table style="border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:6px 12px;color:#666">Event</td><td style="padding:6px 12px">${esc(eventTypeLabel)} on ${esc(eventDateLabel)}</td></tr>
      ${clientName ? `<tr><td style="padding:6px 12px;color:#666">Client</td><td style="padding:6px 12px">${esc(clientName)}</td></tr>` : ''}
      <tr><td style="padding:6px 12px;color:#666">Dispute opened</td><td style="padding:6px 12px">${esc(disputeOpenedLabel)}</td></tr>
      <tr><td style="padding:6px 12px;color:#666">Dispute won</td><td style="padding:6px 12px">${esc(disputeWonLabel)}</td></tr>
    </table>
    <h3 style="margin:16px 0 8px 0">Per-bartender shares</h3>
    <table style="border-collapse:collapse;border:1px solid #ddd">
      <thead><tr><th style="padding:6px 12px;text-align:left;background:#f6f6f6">Bartender</th><th style="padding:6px 12px;text-align:right;background:#f6f6f6">Share to restore</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="margin:24px 0">${ctaButton(payrollUrl, 'Open payroll portal')}</div>
    <p style="color:#666;font-size:13px">Phase 2 of payroll doesn't auto-restore disputed funds because the original clawback may have already been paid out, mid-recompute, or partially adjusted. Add the positive adjustment on each bartender's next pending payout to close the loop.</p>
  `;
  const text = [
    `Stripe dispute won.`,
    `Reinstated amount: $${amountDollars}.`,
    `Event: ${eventTypeLabel} on ${eventDateLabel}${clientName ? ` (client ${clientName})` : ''}.`,
    `Dispute opened ${disputeOpenedLabel}, won ${disputeWonLabel}.`,
    ``,
    `Per-bartender shares:`,
    ...perBartender.map(b => `  ${b.name}: $${b.shareDollars}`),
    ``,
    `Add a positive adjustment on each bartender's next payout: ${payrollUrl}`,
  ].join('\n');
  return { subject, html: wrapEmail(innerHtml), text };
}

module.exports = {
  disputeWonAdminNotification,
};
