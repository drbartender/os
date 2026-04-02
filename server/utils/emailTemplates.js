/**
 * Email templates for Dr. Bartender notifications.
 * Each template function returns { subject, html, text }.
 */

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

function proposalSent({ clientName, eventName, proposalUrl, planUrl }) {
  const name = clientName || 'there';
  const event = eventName || 'your upcoming event';
  const planSection = planUrl
    ? `<p>We've also created a personalized drink planning questionnaire for your event. Use it to tell us your preferences &mdash; signature cocktails, mocktails, beer &amp; wine, and everything in between.</p>
       ${ctaButton(planUrl, 'Plan Your Drinks')}`
    : '';
  return {
    subject: `Your Proposal for ${event} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Your Proposal is Ready!</h2>
      <p>Hi ${name},</p>
      <p>We've put together a proposal for <strong>${event}</strong>. Take a look, review the details, and sign when you're ready.</p>
      ${ctaButton(proposalUrl, 'View Proposal')}
      ${planSection}
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, your proposal for ${event} is ready! View it here: ${proposalUrl}${planUrl ? ` Plan your drinks here: ${planUrl}` : ''} — The Dr. Bartender Team`,
  };
}

function proposalSignedConfirmation({ clientName, eventName }) {
  const name = clientName || 'there';
  const event = eventName || 'your upcoming event';
  return {
    subject: `Proposal Signed — ${event} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Thank You for Signing!</h2>
      <p>Hi ${name},</p>
      <p>We've received your signed proposal for <strong>${event}</strong>. We're excited to work with you!</p>
      <p><strong>Next step:</strong> Submit your deposit to lock in your date. You'll receive payment instructions shortly, or you can pay directly from the proposal page.</p>
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, thank you for signing the proposal for ${event}! Next step: submit your deposit to lock in your date. — The Dr. Bartender Team`,
  };
}

function paymentReceivedClient({ clientName, eventName, amount, paymentType }) {
  const name = clientName || 'there';
  const event = eventName || 'your upcoming event';
  return {
    subject: `Payment Received — ${event} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Payment Received!</h2>
      <p>Hi ${name},</p>
      <p>We've received your <strong>${paymentType}</strong> of <strong>$${amount}</strong> for <strong>${event}</strong>.</p>
      <p>Thank you! We'll be in touch with next steps as your event date approaches.</p>
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, we've received your ${paymentType} of $${amount} for ${event}. Thank you! — The Dr. Bartender Team`,
  };
}

function drinkPlanLink({ clientName, eventName, planUrl }) {
  const name = clientName || 'there';
  const event = eventName || 'your upcoming event';
  return {
    subject: `Your Drink Plan for ${event} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Your Drink Plan is Ready!</h2>
      <p>Hi ${name},</p>
      <p>Thank you for booking with Dr. Bartender! We're excited to help make <strong>${event}</strong> unforgettable.</p>
      <p>We've created a personalized drink planning questionnaire for your event. Use it to tell us your preferences &mdash; signature cocktails, mocktails, beer &amp; wine, and everything in between.</p>
      ${ctaButton(planUrl, 'Plan Your Drinks')}
      <p style="font-size:14px;color:${BRAND.secondary};">You can return to this link anytime to save your progress or make changes before submitting.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, your drink plan for ${event} is ready! Visit ${planUrl} to plan your drinks. You can return anytime to save progress. — The Dr. Bartender Team`,
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

// ─── Admin-Facing Templates ──────────────────────────────────────

function clientSignedAdmin({ clientName, eventName, proposalId, adminUrl }) {
  const name = clientName || 'A client';
  const event = eventName || `Proposal #${proposalId}`;
  return {
    subject: `Proposal Signed: ${name} — ${event}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Proposal Signed</h2>
      <p><strong>${name}</strong> has signed the proposal for <strong>${event}</strong>.</p>
      <p>The proposal status has been updated to <strong>accepted</strong>. Next step: collect the deposit.</p>
      ${ctaButton(adminUrl, 'View Proposal')}
    `),
    text: `${name} signed the proposal for ${event}. View it at: ${adminUrl}`,
  };
}

function paymentReceivedAdmin({ clientName, eventName, amount, paymentType, proposalId, adminUrl }) {
  const name = clientName || 'A client';
  const event = eventName || `Proposal #${proposalId}`;
  return {
    subject: `Payment Received: $${amount} — ${name}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Payment Received</h2>
      <p><strong>${name}</strong> paid <strong>$${amount}</strong> (${paymentType}) for <strong>${event}</strong>.</p>
      ${ctaButton(adminUrl, 'View Proposal')}
    `),
    text: `${name} paid $${amount} (${paymentType}) for ${event}. View: ${adminUrl}`,
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

function shiftRequestAdmin({ staffName, eventName, eventDate, position, adminUrl }) {
  const event = eventName || 'a shift';
  return {
    subject: `Shift Request: ${staffName} — ${event}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">New Shift Request</h2>
      <p><strong>${staffName}</strong> has requested to work as <strong>${position}</strong> for <strong>${event}</strong> on ${eventDate}.</p>
      ${ctaButton(adminUrl, 'View Shift Requests')}
    `),
    text: `${staffName} requested to work ${event} on ${eventDate} as ${position}. Review at: ${adminUrl}`,
  };
}

// ─── Staff-Facing Templates ─────────────────────────────────────

function shiftRequestApproved({ staffName, eventName, eventDate, startTime, endTime, location }) {
  const name = staffName || 'there';
  const event = eventName || 'an upcoming event';
  return {
    subject: `You're Confirmed: ${event} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">You're Confirmed!</h2>
      <p>Hi ${name},</p>
      <p>Great news — you've been confirmed to work <strong>${event}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};width:100px;">Date</td><td style="padding:8px 12px;">${eventDate}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Time</td><td style="padding:8px 12px;">${startTime} – ${endTime}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Location</td><td style="padding:8px 12px;">${location}</td></tr>
      </table>
      <p>Please arrive on time and in proper uniform. See you there!</p>
      <p>— The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, you're confirmed for ${event} on ${eventDate}, ${startTime} – ${endTime} at ${location}. Please arrive on time and in proper uniform. — The Dr. Bartender Team`,
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

module.exports = {
  wrapEmail,
  ctaButton,
  clientOtp,
  proposalSent,
  proposalSignedConfirmation,
  paymentReceivedClient,
  drinkPlanLink,
  clientSignedAdmin,
  paymentReceivedAdmin,
  newApplicationAdmin,
  shiftRequestAdmin,
  shiftRequestApproved,
  applicationReceivedConfirmation,
};
