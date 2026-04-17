/**
 * Email templates for Dr. Bartender notifications.
 * Each template function returns { subject, html, text }.
 */

/** Escape HTML special characters to prevent XSS in email bodies */
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const BRAND = {
  dark: '#2d1810',
  primary: '#3b2314',
  secondary: '#6b4226',
  bg: '#f9f6f3',
  white: '#ffffff',
};

/**
 * Wrap inner HTML in the branded email layout.
 */
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

/**
 * Styled CTA button.
 */
function ctaButton(url, label) {
  return `<p style="text-align:center;margin:2rem 0;">
  <a href="${url}" style="display:inline-block;padding:14px 32px;background:${BRAND.primary};color:${BRAND.white};text-decoration:none;border-radius:6px;font-weight:bold;font-size:16px;">${label}</a>
</p>`;
}

// ─── Client-Facing Templates ─────────────────────────────────────

function proposalSent({ clientName, eventTypeLabel = 'event', proposalUrl, planUrl }) {
  const name = clientName || 'there';
  const planSection = planUrl
    ? `<p>We've also created a personalized drink planning questionnaire for your event. Use it to tell us your preferences &mdash; signature cocktails, mocktails, beer &amp; wine, and everything in between.</p>
       ${ctaButton(planUrl, 'Plan Your Drinks')}`
    : '';
  return {
    subject: `Your Proposal for your ${eventTypeLabel} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Your Proposal is Ready!</h2>
      <p>Hi ${name},</p>
      <p>We've put together a proposal for your <strong>${eventTypeLabel}</strong>. Take a look, review the details, and sign when you're ready.</p>
      ${ctaButton(proposalUrl, 'View Proposal')}
      ${planSection}
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, your proposal for your ${eventTypeLabel} is ready! View it here: ${proposalUrl}${planUrl ? ` Plan your drinks here: ${planUrl}` : ''} — The Dr. Bartender Team`,
  };
}

function proposalSignedConfirmation({ clientName, eventTypeLabel = 'event' }) {
  const name = clientName || 'there';
  return {
    subject: `Proposal Signed — your ${eventTypeLabel} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Thank You for Signing!</h2>
      <p>Hi ${name},</p>
      <p>We've received your signed proposal for your <strong>${eventTypeLabel}</strong>. We're excited to work with you!</p>
      <p><strong>Next step:</strong> Submit your deposit to lock in your date. You'll receive payment instructions shortly, or you can pay directly from the proposal page.</p>
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, thank you for signing the proposal for your ${eventTypeLabel}! Next step: submit your deposit to lock in your date. — The Dr. Bartender Team`,
  };
}

function paymentReceivedClient({ clientName, eventTypeLabel = 'event', amount, paymentType }) {
  const name = clientName || 'there';
  return {
    subject: `Payment Received — your ${eventTypeLabel} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Payment Received!</h2>
      <p>Hi ${name},</p>
      <p>We've received your <strong>${paymentType}</strong> of <strong>$${amount}</strong> for your <strong>${eventTypeLabel}</strong>.</p>
      <p>Thank you! We'll be in touch with next steps as your event date approaches.</p>
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, we've received your ${paymentType} of $${amount} for your ${eventTypeLabel}. Thank you! — The Dr. Bartender Team`,
  };
}

function drinkPlanLink({ clientName, eventTypeLabel = 'event', planUrl }) {
  const name = clientName || 'there';
  return {
    subject: `Your Drink Plan for your ${eventTypeLabel} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Your Drink Plan is Ready!</h2>
      <p>Hi ${name},</p>
      <p>Thank you for booking with Dr. Bartender! We're excited to help make your <strong>${eventTypeLabel}</strong> unforgettable.</p>
      <p>We've created a personalized drink planning questionnaire for your event. Use it to tell us your preferences &mdash; signature cocktails, mocktails, beer &amp; wine, and everything in between.</p>
      ${ctaButton(planUrl, 'Plan Your Drinks')}
      <p style="font-size:14px;color:${BRAND.secondary};">You can return to this link anytime to save your progress or make changes before submitting.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, your drink plan for your ${eventTypeLabel} is ready! Visit ${planUrl} to plan your drinks. You can return anytime to save progress. — The Dr. Bartender Team`,
  };
}

function clientOtp({ name, otp }) {
  const n = name || 'there';
  return {
    subject: 'Your Dr. Bartender login code',
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Your Login Code</h2>
      <p>Hi ${n},</p>
      <p>Use the code below to sign in to your Dr. Bartender client portal:</p>
      <div style="text-align:center;margin:2rem 0;">
        <span style="display:inline-block;padding:16px 32px;background:${BRAND.bg};border:2px solid ${BRAND.secondary};border-radius:8px;font-size:32px;font-weight:bold;letter-spacing:8px;color:${BRAND.primary};">${otp}</span>
      </div>
      <p style="font-size:14px;color:${BRAND.secondary};">This code expires in 15 minutes. If you didn't request this, you can safely ignore this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${n}, your Dr. Bartender login code is: ${otp}. This code expires in 15 minutes. If you didn't request this, you can safely ignore this email. — The Dr. Bartender Team`,
  };
}

function drinkPlanBalanceUpdate({ clientName, eventTypeLabel = 'event', extrasAmount, newTotal, amountPaid, balanceDue, balanceDueDate }) {
  const name = clientName || 'there';
  const dueDate = balanceDueDate
    ? new Date(balanceDueDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'before your event';
  return {
    subject: `Drink Plan Submitted — Updated Balance for your ${eventTypeLabel}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Your Drink Plan is In!</h2>
      <p>Hi ${name},</p>
      <p>Thank you for submitting your drink plan for your <strong>${eventTypeLabel}</strong>! Your selections have been added to your event.</p>
      <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Extras Added</td><td style="padding:8px 12px;text-align:right;font-weight:bold;">$${Number(extrasAmount).toFixed(2)}</td></tr>
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Updated Event Total</td><td style="padding:8px 12px;text-align:right;font-weight:bold;">$${Number(newTotal).toFixed(2)}</td></tr>
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Amount Paid</td><td style="padding:8px 12px;text-align:right;">$${Number(amountPaid).toFixed(2)}</td></tr>
        <tr><td style="padding:8px 12px;color:${BRAND.primary};font-weight:bold;">Remaining Balance</td><td style="padding:8px 12px;text-align:right;font-weight:bold;color:${BRAND.primary};">$${Number(balanceDue).toFixed(2)}</td></tr>
      </table>
      <p>Your remaining balance of <strong>$${Number(balanceDue).toFixed(2)}</strong> is due by <strong>${dueDate}</strong>.</p>
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions about your balance or drink plan, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, your drink plan for your ${eventTypeLabel} has been submitted! Extras added: $${Number(extrasAmount).toFixed(2)}. Updated total: $${Number(newTotal).toFixed(2)}. Amount paid: $${Number(amountPaid).toFixed(2)}. Balance due: $${Number(balanceDue).toFixed(2)} by ${dueDate}. — The Dr. Bartender Team`,
  };
}

// ─── Admin-Facing Templates ──────────────────────────────────────

function clientSignedAdmin({ clientName, eventTypeLabel = 'event', proposalId, adminUrl }) {
  const name = clientName || 'A client';
  return {
    subject: `Proposal Signed: ${name} — ${eventTypeLabel} (#${proposalId})`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Proposal Signed</h2>
      <p><strong>${name}</strong> has signed the proposal for their <strong>${eventTypeLabel}</strong> (#${proposalId}).</p>
      <p>The proposal status has been updated to <strong>accepted</strong>. Next step: collect the deposit.</p>
      ${ctaButton(adminUrl, 'View Proposal')}
    `),
    text: `${name} signed the proposal for their ${eventTypeLabel} (#${proposalId}). View it at: ${adminUrl}`,
  };
}

function paymentReceivedAdmin({ clientName, eventTypeLabel = 'event', amount, paymentType, proposalId, adminUrl }) {
  const name = clientName || 'A client';
  return {
    subject: `Payment Received: $${amount} — ${name}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Payment Received</h2>
      <p><strong>${name}</strong> paid <strong>$${amount}</strong> (${paymentType}) for their <strong>${eventTypeLabel}</strong> (#${proposalId}).</p>
      ${ctaButton(adminUrl, 'View Proposal')}
    `),
    text: `${name} paid $${amount} (${paymentType}) for their ${eventTypeLabel} (#${proposalId}). View: ${adminUrl}`,
  };
}

function newApplicationAdmin({ applicantName, applicantEmail, adminUrl }) {
  return {
    subject: `New Application: ${applicantName}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">New Staff Application</h2>
      <p><strong>${applicantName}</strong> (${applicantEmail}) has submitted an application.</p>
      ${ctaButton(adminUrl, 'Review Applications')}
    `),
    text: `New application from ${applicantName} (${applicantEmail}). Review at: ${adminUrl}`,
  };
}

function shiftRequestAdmin({ staffName, eventTypeLabel = 'event', eventDate, position, adminUrl }) {
  return {
    subject: `Shift Request: ${staffName} — ${eventTypeLabel}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">New Shift Request</h2>
      <p><strong>${staffName}</strong> has requested to work ${position} at a <strong>${eventTypeLabel}</strong> on ${eventDate}.</p>
      ${ctaButton(adminUrl, 'View Shift Requests')}
    `),
    text: `${staffName} requested to work ${position} at a ${eventTypeLabel} on ${eventDate}. Review at: ${adminUrl}`,
  };
}

// ─── Staff-Facing Templates ─────────────────────────────────────

function shiftRequestApproved({ staffName, eventTypeLabel = 'event', eventDate, startTime, endTime, location }) {
  const name = staffName || 'there';
  return {
    subject: `You're Confirmed: ${eventTypeLabel} on ${eventDate} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">You're Confirmed!</h2>
      <p>Hi ${name},</p>
      <p>Great news — you've been confirmed to work at an upcoming <strong>${eventTypeLabel}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};width:100px;">Date</td><td style="padding:8px 12px;">${eventDate}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Time</td><td style="padding:8px 12px;">${startTime} – ${endTime}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Location</td><td style="padding:8px 12px;">${location}</td></tr>
      </table>
      <p>Please arrive on time and in proper uniform. See you there!</p>
      <p>— The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, you're confirmed for an upcoming ${eventTypeLabel} on ${eventDate}, ${startTime} – ${endTime} at ${location}. Please arrive on time and in proper uniform. — The Dr. Bartender Team`,
  };
}

function applicationReceivedConfirmation({ applicantName }) {
  const name = applicantName || 'there';
  return {
    subject: `Application Received — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Application Received!</h2>
      <p>Hi ${name},</p>
      <p>Thank you for applying to join the Dr. Bartender team! We've received your application and will review it shortly.</p>
      <p>We'll reach out with next steps once our team has had a chance to go over your information.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, thank you for applying to Dr. Bartender! We've received your application and will review it shortly. — The Dr. Bartender Team`,
  };
}

// ─── Abandoned Quote Email ──────────────────────────────────────────

/**
 * Reference template for abandoned quote followup emails.
 * The actual email content is stored in the email_sequence_steps table
 * for the "Abandoned Quote Followup" campaign, using {{name}} and
 * {{resume_url}} placeholders that the scheduler replaces at send time.
 */
function abandonedQuote({ clientName, resumeUrl }) {
  const name = clientName || 'there';
  return {
    subject: 'Still planning your event? Your quote is waiting',
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Pick Up Where You Left Off</h2>
      <p>Hi ${name},</p>
      <p>We noticed you started putting together a quote for your event but didn't finish.
         No worries — your progress is saved and ready for you!</p>
      ${ctaButton(resumeUrl, 'Continue Your Quote')}
      <p style="margin-top:24px;">If you have any questions, just reply to this email — we'd love to help.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, your quote is waiting! Continue where you left off: ${resumeUrl}`,
  };
}

// ─── Marketing Email Template ──────────────────────────────────────

/**
 * Wrap marketing email content in branded layout with unsubscribe footer.
 * @param {string} innerHtml - The email body content
 * @param {string} [unsubscribeUrl] - Unsubscribe link URL
 */
function wrapMarketingEmail(innerHtml, unsubscribeUrl) {
  const unsubscribeSection = unsubscribeUrl
    ? `<p style="margin:8px 0 0;font-size:11px;"><a href="${unsubscribeUrl}" style="color:${BRAND.secondary};text-decoration:underline;">Unsubscribe</a> from future emails</p>`
    : '';

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
      ${unsubscribeSection}
    </div>
  </div>
</body>
</html>`;
}

// ─── Thumbtack Admin Notifications ──────────────────────────────

function newThumbtackLeadAdmin({ customerName, customerPhone, category, description, location, eventDate, details, adminUrl }) {
  const name = esc(customerName) || 'Unknown';
  const detailRows = (details || [])
    .map(d => `<tr><td style="padding:6px 12px;font-weight:bold;color:${BRAND.secondary};vertical-align:top;width:140px;">${esc(d.question)}</td><td style="padding:6px 12px;">${esc(d.answer)}</td></tr>`)
    .join('');
  const detailsTable = detailRows
    ? `<table style="width:100%;border-collapse:collapse;margin:1rem 0;">${detailRows}</table>`
    : '';
  const dateStr = eventDate ? new Date(eventDate).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'Not specified';

  return {
    subject: `New Thumbtack Lead: ${esc(customerName) || 'Unknown'}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">New Thumbtack Lead</h2>
      <p style="background:#fff3cd;border:1px solid #ffc107;padding:12px;border-radius:6px;font-weight:bold;">
        Action needed: Grab the customer's email from Thumbtack (lead &rarr; three dots &rarr; create estimate/invoice).
      </p>
      <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};width:120px;">Name</td><td style="padding:8px 12px;">${name}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Phone</td><td style="padding:8px 12px;">${esc(customerPhone) || 'N/A'}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Category</td><td style="padding:8px 12px;">${esc(category) || 'N/A'}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Location</td><td style="padding:8px 12px;">${esc(location) || 'N/A'}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Event Date</td><td style="padding:8px 12px;">${dateStr}</td></tr>
      </table>
      ${description ? `<p><strong>Description:</strong> ${esc(description)}</p>` : ''}
      ${detailsTable}
      ${adminUrl ? ctaButton(adminUrl, 'View Client') : ''}
    `),
    text: `New Thumbtack lead: ${customerName || 'Unknown'} — ${customerPhone || 'no phone'}. Category: ${category || 'N/A'}. Location: ${location || 'N/A'}. Date: ${dateStr}. ACTION: Grab email from Thumbtack.${adminUrl ? ` View: ${adminUrl}` : ''}`,
  };
}

function newThumbtackMessageAdmin({ customerName, text, adminUrl }) {
  const name = esc(customerName) || 'A customer';
  const rawPreview = text && text.length > 300 ? text.slice(0, 300) + '...' : (text || '(no text)');
  return {
    subject: `Thumbtack Message from ${esc(customerName) || 'A customer'}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">New Thumbtack Message</h2>
      <p><strong>${name}</strong> sent a message via Thumbtack:</p>
      <div style="background:${BRAND.bg};padding:16px;border-radius:6px;margin:1rem 0;border-left:4px solid ${BRAND.secondary};">
        ${esc(rawPreview)}
      </div>
      ${adminUrl ? ctaButton(adminUrl, 'View Client') : ''}
    `),
    text: `Thumbtack message from ${customerName || 'A customer'}: ${rawPreview}${adminUrl ? ` View: ${adminUrl}` : ''}`,
  };
}

function newThumbtackReviewAdmin({ reviewerName, rating, reviewText }) {
  const name = esc(reviewerName) || 'A customer';
  const stars = rating !== null && rating !== undefined ? '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating)) : 'N/A';
  return {
    subject: `New Thumbtack Review: ${stars} from ${esc(reviewerName) || 'A customer'}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">New Thumbtack Review</h2>
      <p style="font-size:24px;margin:0.5rem 0;">${stars}</p>
      <p><strong>${name}</strong> left a ${rating !== null && rating !== undefined ? rating + '/5' : ''} review on Thumbtack:</p>
      ${reviewText ? `<div style="background:${BRAND.bg};padding:16px;border-radius:6px;margin:1rem 0;border-left:4px solid ${BRAND.secondary};">${esc(reviewText)}</div>` : '<p style="color:#999;"><em>No review text</em></p>'}
    `),
    text: `New Thumbtack review from ${reviewerName || 'A customer'}: ${rating}/5 — ${reviewText || '(no text)'}`,
  };
}

module.exports = {
  wrapEmail,
  wrapMarketingEmail,
  ctaButton,
  clientOtp,
  proposalSent,
  proposalSignedConfirmation,
  paymentReceivedClient,
  drinkPlanLink,
  drinkPlanBalanceUpdate,
  clientSignedAdmin,
  paymentReceivedAdmin,
  newApplicationAdmin,
  shiftRequestAdmin,
  shiftRequestApproved,
  applicationReceivedConfirmation,
  abandonedQuote,
  newThumbtackLeadAdmin,
  newThumbtackMessageAdmin,
  newThumbtackReviewAdmin,
};
