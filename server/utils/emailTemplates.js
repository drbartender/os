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

function signedAndPaidClient({ clientName, eventTypeLabel = 'event', amount, paymentType }) {
  const name = clientName || 'there';
  return {
    subject: `Signed & Paid — your ${eventTypeLabel} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">You're Locked In!</h2>
      <p>Hi ${name},</p>
      <p>We've received your signed proposal <em>and</em> your <strong>${paymentType}</strong> of <strong>$${amount}</strong> for your <strong>${eventTypeLabel}</strong>. Your date is officially on the books.</p>
      <p>We'll be in touch with next steps as your event date approaches.</p>
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, we've received your signed proposal and your ${paymentType} of $${amount} for your ${eventTypeLabel}. Your date is officially on the books. — The Dr. Bartender Team`,
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

function paymentReminderClient({ clientName, eventTypeLabel = 'event', balanceDue, balanceDueDate, proposalUrl }) {
  const name = clientName || 'there';
  const dueDate = balanceDueDate
    ? new Date(balanceDueDate).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })
    : 'before your event';
  return {
    subject: `Friendly reminder — balance due for your ${eventTypeLabel}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Balance Reminder</h2>
      <p>Hi ${esc(name)},</p>
      <p>Just a friendly reminder that the balance for your <strong>${esc(eventTypeLabel)}</strong> is still outstanding. You can review your event details and pay the balance directly from your proposal page.</p>
      <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
        <tr><td style="padding:8px 12px;color:${BRAND.primary};font-weight:bold;">Balance Due</td><td style="padding:8px 12px;text-align:right;font-weight:bold;color:${BRAND.primary};">$${Number(balanceDue).toFixed(2)}</td></tr>
        <tr><td style="padding:8px 12px;color:${BRAND.secondary};">Due By</td><td style="padding:8px 12px;text-align:right;">${dueDate}</td></tr>
      </table>
      ${ctaButton(proposalUrl, 'View &amp; Pay Balance')}
      <p style="font-size:14px;color:${BRAND.secondary};">If you've already taken care of this or have any questions, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, just a friendly reminder that your balance of $${Number(balanceDue).toFixed(2)} for your ${eventTypeLabel} is due by ${dueDate}. View and pay here: ${proposalUrl} — The Dr. Bartender Team`,
  };
}

function drinkPlanBalanceUpdate({ clientName, eventTypeLabel = 'event', extrasAmount, newTotal, amountPaid, balanceDue, balanceDueDate }) {
  const name = clientName || 'there';
  const dueDate = balanceDueDate
    ? new Date(balanceDueDate).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })
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

function signedAndPaidAdmin({ clientName, eventTypeLabel = 'event', amount, paymentType, proposalId, adminUrl }) {
  const name = clientName || 'A client';
  return {
    subject: `Signed & Paid ($${amount}): ${name} — ${eventTypeLabel} (#${proposalId})`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Signed & Paid</h2>
      <p><strong>${name}</strong> signed the proposal and paid <strong>$${amount}</strong> (${paymentType}) for their <strong>${eventTypeLabel}</strong> (#${proposalId}).</p>
      ${ctaButton(adminUrl, 'View Proposal')}
    `),
    text: `${name} signed the proposal and paid $${amount} (${paymentType}) for their ${eventTypeLabel} (#${proposalId}). View: ${adminUrl}`,
  };
}

function topShelfClassRequestAdmin({ clientName, clientEmail, clientPhone, spiritCategory, guestCount, eventDate, eventLocation, proposalId, adminUrl }) {
  const name = clientName || 'A client';
  const category = spiritCategory === 'whiskey_bourbon' ? 'Whiskey & Bourbon' : spiritCategory === 'tequila_mezcal' ? 'Tequila & Mezcal' : 'Spirits Tasting';
  return {
    subject: `[Top Shelf Class Quote] ${esc(name)} — ${esc(category)}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Top Shelf Class Request</h2>
      <p><strong>${esc(name)}</strong> has requested a Top Shelf <strong>${esc(category)}</strong> class. They expect a custom quote — the draft proposal has no pricing yet.</p>
      <p style="background:${BRAND.bg};padding:12px;border-radius:4px;margin:16px 0;">
        <strong>Contact:</strong> ${esc(clientEmail || 'no email')}${clientPhone ? ` &middot; ${esc(clientPhone)}` : ''}<br/>
        <strong>Guests:</strong> ${esc(guestCount || '?')} &middot; <strong>Event:</strong> ${esc(eventDate || 'TBD')}${eventLocation ? ` &middot; ${esc(eventLocation)}` : ''}
      </p>
      <p>Open the draft, set the custom total, then send to the client.</p>
      ${ctaButton(adminUrl, 'Open Draft Proposal')}
    `),
    text: `Top Shelf class request from ${name} (${clientEmail || 'no email'}${clientPhone ? `, ${clientPhone}` : ''}): ${category}, ${guestCount || '?'} guests, ${eventDate || 'date TBD'}. Draft #${proposalId}. Open: ${adminUrl}`,
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
  const eventPhrase = eventTypeLabel === 'event' ? 'an upcoming event' : `an upcoming ${eventTypeLabel} event`;
  return {
    subject: `Shift Request: ${staffName} — ${eventTypeLabel}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">New Shift Request</h2>
      <p><strong>${staffName}</strong> has requested to work as <strong>${position}</strong> at ${eventPhrase} on ${eventDate}.</p>
      ${ctaButton(adminUrl, 'View Shift Requests')}
    `),
    text: `${staffName} requested to work ${position} at ${eventPhrase} on ${eventDate}. Review at: ${adminUrl}`,
  };
}

// ─── Staff-Facing Templates ─────────────────────────────────────

function shiftRequestApproved({ staffName, eventTypeLabel = 'event', eventDate, startTime, endTime, location }) {
  const name = staffName || 'there';
  const eventPhrase = eventTypeLabel === 'event' ? 'an upcoming event' : `an upcoming ${eventTypeLabel} event`;
  return {
    subject: `You're Confirmed: ${eventTypeLabel} on ${eventDate} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">You're Confirmed!</h2>
      <p>Hi ${name},</p>
      <p>Great news — you've been confirmed to work ${eventPhrase}.</p>
      <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};width:100px;">Date</td><td style="padding:8px 12px;">${eventDate}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Time</td><td style="padding:8px 12px;">${startTime} – ${endTime}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Location</td><td style="padding:8px 12px;">${location}</td></tr>
      </table>
      <p>Please arrive on time and in proper uniform. See you there!</p>
      <p>— The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, you're confirmed to work ${eventPhrase} on ${eventDate}, ${startTime} – ${endTime} at ${location}. Please arrive on time and in proper uniform. — The Dr. Bartender Team`,
  };
}

function applicationReceivedConfirmation({ applicantName }) {
  const name = applicantName || 'there';
  return {
    subject: `Application Received — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Application Received!</h2>
      <p>Hi ${esc(name)},</p>
      <p>Thank you for applying to join the Dr. Bartender team! We've received your application and will review it shortly.</p>
      <p>We'll reach out with next steps once our team has had a chance to go over your information.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, thank you for applying to Dr. Bartender! We've received your application and will review it shortly. — The Dr. Bartender Team`,
  };
}

// ─── Application Status Progression ─────────────────────────────
// Sent automatically by PUT /admin/users/:id/status when the admin transitions
// an applicant through the hiring pipeline. Internal-only states (in_progress,
// reviewed, approved) skip emails by design.

function customMessageBlock(customMessage) {
  if (!customMessage) return '';
  // Preserve line breaks while escaping HTML to prevent injection.
  const safe = esc(customMessage).replace(/\n/g, '<br/>');
  return `<div style="background:${BRAND.bg};border-left:3px solid ${BRAND.secondary};padding:12px 16px;margin:1rem 0;font-style:italic;">${safe}</div>`;
}

function applicationInterviewInvite({ applicantName, customMessage }) {
  const name = applicantName || 'there';
  const note = customMessageBlock(customMessage);
  return {
    subject: `We'd like to interview you — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Let's Chat!</h2>
      <p>Hi ${esc(name)},</p>
      <p>Thanks for applying to Dr. Bartender — we liked what we saw and we'd like to set up a quick interview.</p>
      ${note}
      <p>Our team will reach out shortly with scheduling details. Feel free to reply to this email with any times that work for you.</p>
      <p>Talk soon,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, we'd like to interview you. Our team will reach out with scheduling details. ${customMessage ? `Note from the team: ${customMessage}` : ''} — The Dr. Bartender Team`,
  };
}

function applicationHired({ applicantName, customMessage, staffPortalUrl }) {
  const name = applicantName || 'there';
  const note = customMessageBlock(customMessage);
  const cta = staffPortalUrl ? ctaButton(staffPortalUrl, 'Open Staff Portal') : '';
  return {
    subject: `Welcome to the Dr. Bartender team!`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">You're Hired!</h2>
      <p>Hi ${esc(name)},</p>
      <p>Welcome to the team! We're excited to have you. Here's what to do next:</p>
      <ol style="color:${BRAND.primary};line-height:1.6;">
        <li>Log into the staff portal to review your contractor agreement</li>
        <li>Complete your contractor profile (payment info, equipment, emergency contact)</li>
        <li>Browse upcoming events and request shifts you'd like to work</li>
      </ol>
      ${cta}
      ${note}
      <p>If you have any questions getting set up, just reply to this email — we're here to help.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, welcome to the Dr. Bartender team! Log into the staff portal to complete your onboarding: ${staffPortalUrl || 'https://staff.drbartender.com'}${customMessage ? ` Note: ${customMessage}` : ''} — The Dr. Bartender Team`,
  };
}

function applicationRejected({ applicantName, customMessage }) {
  const name = applicantName || 'there';
  const note = customMessageBlock(customMessage);
  return {
    subject: `About your application — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Thank You for Applying</h2>
      <p>Hi ${esc(name)},</p>
      <p>Thank you for your interest in joining the Dr. Bartender team and for taking the time to apply. After careful review, we've decided to move forward with other candidates at this time.</p>
      ${note}
      <p>We genuinely appreciate the effort you put into your application, and we wish you the best in your search.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, thank you for applying to Dr. Bartender. After review, we've decided to move forward with other candidates at this time. ${customMessage ? `Note: ${customMessage}` : ''} We wish you the best. — The Dr. Bartender Team`,
  };
}

function shoppingListReady({ clientName, eventTypeLabel = 'event', shoppingListUrl }) {
  const name = clientName || 'there';
  return {
    subject: `Your shopping list is ready — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Your Shopping List is Ready</h2>
      <p>Hi ${esc(name)},</p>
      <p>We've finalized the shopping list for your <strong>${esc(eventTypeLabel)}</strong>. Bring this with you when you stock up — quantities are scaled to your guest count.</p>
      ${ctaButton(shoppingListUrl, 'View Shopping List')}
      <p style="font-size:14px;color:${BRAND.secondary};">Have questions or need to adjust anything? Just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, your shopping list for your ${eventTypeLabel} is ready. View it here: ${shoppingListUrl}`,
  };
}

function applicationDeactivated({ applicantName, customMessage }) {
  const name = applicantName || 'there';
  const note = customMessageBlock(customMessage);
  return {
    subject: `Your Dr. Bartender account has been deactivated`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Account Deactivated</h2>
      <p>Hi ${esc(name)},</p>
      <p>This is a notice that your Dr. Bartender staff account has been deactivated. You will no longer receive shift requests or be able to log into the staff portal.</p>
      ${note}
      <p>If you believe this was done in error, or if you have questions, please reply to this email.</p>
      <p>Best,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, your Dr. Bartender staff account has been deactivated. ${customMessage ? `Note: ${customMessage}` : ''} If this was in error, please reply to this email. — The Dr. Bartender Team`,
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

// ─── Hiring redesign (2026-04-28) ───────────────────────────────
// Two new templates plus DB-lookup wrappers used by the application detail
// page's interview-scheduling and paperwork-reminder flows.

function interviewConfirmation({ applicantName, interviewAt }) {
  const name = applicantName || 'there';
  const dt = new Date(interviewAt);
  const dateStr = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const timeStr = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return {
    subject: `Interview confirmed — ${dateStr}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Interview confirmed</h2>
      <p>Hi ${esc(name)},</p>
      <p>Your interview with Dr. Bartender is confirmed for <strong>${esc(dateStr)} at ${esc(timeStr)}</strong>.</p>
      <p>If anything changes on your end, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, your interview with Dr. Bartender is confirmed for ${dateStr} at ${timeStr}. If anything changes, reply to this email. — Dr. Bartender`,
  };
}

function paperworkReminder({ applicantName, staffUrl }) {
  const name = applicantName || 'there';
  const url = staffUrl || 'https://staff.drbartender.com';
  return {
    subject: 'Quick nudge — finish your onboarding',
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Just a friendly nudge</h2>
      <p>Hi ${esc(name)},</p>
      <p>This is a quick reminder to finish your Dr. Bartender onboarding paperwork. The portal saves your progress so you can pick up where you left off:</p>
      <p>${ctaButton(url, 'Continue onboarding →')}</p>
      <p>Reply if you hit a snag — happy to help.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, just a friendly nudge to finish your Dr. Bartender onboarding paperwork: ${url} — Dr. Bartender`,
  };
}

// Wrapper: looks up applicant email + name, builds the template, sends via
// Resend. Used by PUT /admin/applications/:id/interview when send_email=true.
async function sendInterviewConfirmationEmail({ userId, interview_at }) {
  const { pool } = require('../db');
  const { sendEmail } = require('./email');
  const r = await pool.query(`
    SELECT u.email, a.full_name
    FROM users u
    INNER JOIN applications a ON a.user_id = u.id
    WHERE u.id = $1
  `, [userId]);
  if (r.rowCount === 0) return;
  const { email, full_name } = r.rows[0];
  const tpl = interviewConfirmation({ applicantName: full_name, interviewAt: interview_at });
  return sendEmail({ to: email, ...tpl });
}

// Wrapper: looks up applicant email + preferred name, sends paperwork-reminder
// email pointing them at the staff portal.
async function sendPaperworkReminderEmail({ userId }) {
  const { pool } = require('../db');
  const { sendEmail } = require('./email');
  const { STAFF_URL } = require('./urls');
  const r = await pool.query(`
    SELECT u.email,
           COALESCE(cp.preferred_name, a.full_name) AS display_name
    FROM users u
    LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
    LEFT JOIN applications a ON a.user_id = u.id
    WHERE u.id = $1
  `, [userId]);
  if (r.rowCount === 0) return;
  const { email, display_name } = r.rows[0];
  const tpl = paperworkReminder({
    applicantName: display_name,
    staffUrl: typeof STAFF_URL === 'function' ? STAFF_URL() : STAFF_URL,
  });
  return sendEmail({ to: email, ...tpl });
}

module.exports = {
  wrapEmail,
  wrapMarketingEmail,
  ctaButton,
  clientOtp,
  proposalSent,
  proposalSignedConfirmation,
  paymentReceivedClient,
  signedAndPaidClient,
  drinkPlanLink,
  drinkPlanBalanceUpdate,
  paymentReminderClient,
  clientSignedAdmin,
  paymentReceivedAdmin,
  signedAndPaidAdmin,
  topShelfClassRequestAdmin,
  newApplicationAdmin,
  shiftRequestAdmin,
  shiftRequestApproved,
  applicationReceivedConfirmation,
  applicationInterviewInvite,
  applicationHired,
  applicationRejected,
  applicationDeactivated,
  shoppingListReady,
  abandonedQuote,
  newThumbtackLeadAdmin,
  newThumbtackMessageAdmin,
  newThumbtackReviewAdmin,
  // Hiring redesign
  interviewConfirmation,
  paperworkReminder,
  sendInterviewConfirmationEmail,
  sendPaperworkReminderEmail,
};
