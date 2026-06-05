/**
 * Email templates for Dr. Bartender notifications.
 * Each template function returns { subject, html, text }.
 */

const { esc } = require('./htmlEscape');

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
      <p>Hi ${esc(name)},</p>
      <p>We've put together a proposal for your <strong>${esc(eventTypeLabel)}</strong>. Take a look, review the details, and sign when you're ready.</p>
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
      <p>Hi ${esc(name)},</p>
      <p>We've received your signed proposal for your <strong>${esc(eventTypeLabel)}</strong>. We're excited to work with you!</p>
      <p><strong>Next step:</strong> Submit your deposit to lock in your date. You'll receive payment instructions shortly, or you can pay directly from the proposal page.</p>
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, thank you for signing the proposal for your ${eventTypeLabel}! Next step: submit your deposit to lock in your date. — The Dr. Bartender Team`,
  };
}

// Conditional cancellation caveat appended to first-payment client emails when
// the booking is ≤72h out (passed lastMinute=true by the Stripe webhook
// notifier). Additive copy only — no behavior change when the flag is false.
function lastMinuteCaveatHtml(lastMinute) {
  return lastMinute
    ? `<p style="background:#fff4e5;border-left:4px solid #d9822b;padding:12px 16px;font-size:14px;">
         <strong>One quick note:</strong> because your event is less than 72 hours away, your booking is
         confirmed subject to staff availability. In the rare case we can't staff it in time, we'll
         cancel and fully refund you right away.
       </p>`
    : '';
}
function lastMinuteCaveatText(lastMinute) {
  return lastMinute
    ? ' Note: because your event is <72h away, your booking is confirmed subject to staff availability — in the rare case we cannot staff it we will cancel and fully refund you.'
    : '';
}

/**
 * Payment received — client confirmation.
 *
 * @param {Object} opts
 * @param {string} opts.clientName
 * @param {string} opts.eventTypeLabel
 * @param {string|number} opts.amount - dollar amount paid (string OK, formatted by caller)
 * @param {string} opts.paymentType - e.g. 'deposit', 'balance payment', 'autopay balance'
 * @param {boolean} [opts.lastMinute=false] - append the <72h cancellation caveat
 * @param {string} [opts.eventDateLabel] - optional formatted event date (e.g. "June 12")
 * @param {string} [opts.last4] - last 4 of card charged; rendered in autopay mode
 * @param {boolean} [opts.autopay=false] - autopay-success framing (tighter copy, you're-paid-in-full focus)
 */
function paymentReceivedClient({ clientName, eventTypeLabel = 'event', amount, paymentType, lastMinute = false, eventDateLabel, last4, autopay = false }) {
  const name = clientName || 'there';
  if (autopay) {
    const eventBit = eventDateLabel ? ` on ${esc(eventDateLabel)}` : '';
    const cardBit = last4 ? ` on the card ending in ${esc(String(last4))}` : ' on your card on file';
    return {
      subject: `Balance charged: you're paid in full${eventDateLabel ? ` for ${esc(eventDateLabel)}` : ''}`,
      html: wrapEmail(`
        <h2 style="color:${BRAND.primary};margin-top:0;">You're Paid in Full</h2>
        <p>Hi ${esc(name)},</p>
        <p>Your remaining balance of <strong>$${amount}</strong> for your <strong>${esc(eventTypeLabel)}</strong>${eventBit} just ran${cardBit}. You're paid in full.</p>
        <p>Looking forward to the event.</p>
        <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
        <p>Cheers,<br/>The Dr. Bartender Team</p>
      `),
      text: `Hi ${name}, your remaining balance of $${amount} for your ${eventTypeLabel}${eventBit} just ran${last4 ? ` on the card ending in ${last4}` : ' on your card on file'}. You're paid in full. Cheers, The Dr. Bartender Team`,
    };
  }
  // Default (non-autopay) flow — preserves the existing copy
  return {
    subject: `Payment Received — your ${eventTypeLabel} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Payment Received!</h2>
      <p>Hi ${esc(name)},</p>
      <p>We've received your <strong>${paymentType}</strong> of <strong>$${amount}</strong> for your <strong>${esc(eventTypeLabel)}</strong>.</p>
      ${lastMinuteCaveatHtml(lastMinute)}
      <p>Thank you! We'll be in touch with next steps as your event date approaches.</p>
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, we've received your ${paymentType} of $${amount} for your ${eventTypeLabel}.${lastMinuteCaveatText(lastMinute)} Thank you! — The Dr. Bartender Team`,
  };
}

function clientOtp({ name, otp }) {
  const n = name || 'there';
  return {
    subject: 'Your Dr. Bartender login code',
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Your Login Code</h2>
      <p>Hi ${esc(n)},</p>
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

/**
 * Balance reminder T-3 days.
 *
 * @param {Object} opts
 * @param {string} opts.clientName
 * @param {string} opts.eventTypeLabel
 * @param {number} opts.balanceDue - dollars (number)
 * @param {string|Date} opts.balanceDueDate
 * @param {string} opts.proposalUrl
 * @param {'autopay'|'manual'} [opts.paymentMode='manual'] - autopay → "no action needed" copy; manual → "log in and pay"
 * @param {string} [opts.last4] - last 4 digits of saved card; only rendered in autopay mode when provided
 */
function paymentReminderClient({ clientName, eventTypeLabel = 'event', balanceDue, balanceDueDate, proposalUrl, paymentMode = 'manual', last4 }) {
  const name = clientName || 'there';
  const dueDate = balanceDueDate
    ? new Date(balanceDueDate).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })
    : 'before your event';
  const isAutopay = paymentMode === 'autopay';
  const subject = isAutopay
    ? `Heads up: balance for your ${eventTypeLabel} runs in 3 days`
    : `Balance due in 3 days for your ${eventTypeLabel}`;
  const cardLine = isAutopay && last4
    ? `<p>Your card ending in <strong>${esc(String(last4))}</strong> will be charged automatically. No action needed.</p>`
    : isAutopay
      ? `<p>Your card on file will be charged automatically. No action needed.</p>`
      : '';
  const cta = isAutopay
    ? ctaButton(proposalUrl, 'Use a different card or pay early')
    : ctaButton(proposalUrl, 'View &amp; Pay Balance');
  const intro = isAutopay
    ? `Your remaining balance of <strong>$${Number(balanceDue).toFixed(2)}</strong> for your <strong>${esc(eventTypeLabel)}</strong> runs on <strong>${dueDate}</strong>.`
    : `A heads up that your balance of <strong>$${Number(balanceDue).toFixed(2)}</strong> for your <strong>${esc(eventTypeLabel)}</strong> is due on <strong>${dueDate}</strong>.`;
  const footer = isAutopay
    ? `<p style="font-size:14px;color:${BRAND.secondary};">We'll send a receipt once it's charged. Reply with any questions.</p>`
    : `<p style="font-size:14px;color:${BRAND.secondary};">If you've already taken care of this or have any questions, just reply to this email.</p>`;
  const textIntro = isAutopay
    ? `Your remaining balance of $${Number(balanceDue).toFixed(2)} for your ${eventTypeLabel} runs on ${dueDate}${last4 ? ` on the card ending in ${last4}` : ' on your card on file'}.`
    : `A heads up that your balance of $${Number(balanceDue).toFixed(2)} for your ${eventTypeLabel} is due on ${dueDate}.`;
  return {
    subject,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Balance Reminder</h2>
      <p>Hi ${esc(name)},</p>
      <p>${intro}</p>
      ${cardLine}
      ${cta}
      ${footer}
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, ${textIntro} ${isAutopay ? 'No action needed. Pay early or change card: ' : 'View and pay: '}${proposalUrl}. Cheers, The Dr. Bartender Team`,
  };
}

/**
 * Late balance reminder (T+1 gentle, T+3 firmer). Only for non-autopay path —
 * autopay clients have the charge run automatically on the due date, so a "late"
 * touch doesn't apply.
 *
 * @param {Object} opts
 * @param {string} opts.clientName
 * @param {string} opts.eventTypeLabel
 * @param {number} opts.balanceDue - dollars
 * @param {string} opts.proposalUrl
 * @param {1|3} opts.daysLate - 1 → gentle, 3 → firmer
 */
function paymentReminderLate({ clientName, eventTypeLabel = 'event', balanceDue, proposalUrl, daysLate }) {
  const name = clientName || 'there';
  const firm = daysLate >= 3;
  const subject = firm
    ? `Balance ${daysLate} days past due for your ${eventTypeLabel}, please reach out`
    : `Balance now ${daysLate} day past due for your ${eventTypeLabel}`;
  const bodyOpen = firm
    ? `Your balance of <strong>$${Number(balanceDue).toFixed(2)}</strong> for your <strong>${esc(eventTypeLabel)}</strong> is now <strong>${daysLate} days past due</strong>.`
    : `Your balance of <strong>$${Number(balanceDue).toFixed(2)}</strong> for your <strong>${esc(eventTypeLabel)}</strong> is <strong>${daysLate} day past due</strong>.`;
  const closeLine = firm
    ? `<p>If something has changed or you need to talk through options, please reach out directly so we can sort this out together.</p>`
    : `<p>Reach out if you need help or want to talk this through.</p>`;
  return {
    subject,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">${firm ? 'Balance Past Due' : 'Balance Reminder'}</h2>
      <p>Hi ${esc(name)},</p>
      <p>${bodyOpen}</p>
      ${ctaButton(proposalUrl, 'View &amp; Pay Balance')}
      ${closeLine}
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, your balance of $${Number(balanceDue).toFixed(2)} for your ${eventTypeLabel} is ${daysLate} ${daysLate === 1 ? 'day' : 'days'} past due. Pay here: ${proposalUrl}. ${firm ? 'Please reach out so we can sort this out together.' : 'Reach out if you need help.'} Cheers, The Dr. Bartender Team`,
  };
}

/**
 * Refund issued — client confirmation. Always fires when admin issues a refund
 * (full or partial), no suppression (rare touch, money out, never want it skipped).
 *
 * @param {Object} opts
 * @param {string} opts.clientName
 * @param {number} opts.refundAmount - dollars
 * @param {string} [opts.last4] - last 4 of card refunded to (omit line if not available)
 * @param {number|null} opts.newBalance - dollars; if null or <= 0, render "no balance remaining" line
 */
function refundNotificationClient({ clientName, refundAmount, last4, newBalance }) {
  const name = clientName || 'there';
  const cardLine = last4
    ? ` to your card ending in <strong>${esc(String(last4))}</strong>`
    : '';
  const cardLineText = last4 ? ` to your card ending in ${last4}` : '';
  const balanceLine = (newBalance === null || newBalance === undefined || Number(newBalance) <= 0)
    ? `<p>This refund covers the full amount; no balance remaining.</p>`
    : `<p>New balance: <strong>$${Number(newBalance).toFixed(2)}</strong>.</p>`;
  const balanceLineText = (newBalance === null || newBalance === undefined || Number(newBalance) <= 0)
    ? 'This refund covers the full amount; no balance remaining.'
    : `New balance: $${Number(newBalance).toFixed(2)}.`;
  return {
    subject: `Refund issued for your account`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Refund Issued</h2>
      <p>Hi ${esc(name)},</p>
      <p>We've refunded <strong>$${Number(refundAmount).toFixed(2)}</strong>${cardLine}. It should arrive in 5-10 business days depending on your bank.</p>
      ${balanceLine}
      <p style="font-size:14px;color:${BRAND.secondary};">Let me know if you have any questions, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, we've refunded $${Number(refundAmount).toFixed(2)}${cardLineText}. It should arrive in 5-10 business days. ${balanceLineText} Cheers, The Dr. Bartender Team`,
  };
}

/**
 * Payment failure — client notification. Fires immediately on Stripe
 * `payment_intent.payment_failed`. Separate from the existing admin throttled
 * email. Throttle (one per 24h per proposal) is enforced by the caller, not
 * the template.
 *
 * @param {Object} opts
 * @param {string} opts.clientName
 * @param {string} opts.eventTypeLabel
 * @param {string} [opts.last4] - last 4 of card that failed (omit if unavailable)
 * @param {string} opts.proposalUrl - link for the client to update payment method
 */
function paymentFailedClient({ clientName, eventTypeLabel = 'event', last4, proposalUrl }) {
  const name = clientName || 'there';
  const cardClause = last4
    ? ` on the card ending in <strong>${esc(String(last4))}</strong>`
    : '';
  const cardClauseText = last4 ? ` on the card ending in ${last4}` : '';
  return {
    subject: `Payment didn't go through for your ${eventTypeLabel}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Payment Didn't Go Through</h2>
      <p>Hi ${esc(name)},</p>
      <p>Your payment for the <strong>${esc(eventTypeLabel)}</strong> didn't go through${cardClause}.</p>
      ${ctaButton(proposalUrl, 'Update Payment Method')}
      <p>If you have any questions or need help, reply to this email or call me.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, your payment for the ${eventTypeLabel} didn't go through${cardClauseText}. Update payment method: ${proposalUrl}. Reach out if you need help. Cheers, The Dr. Bartender Team`,
  };
}

// ─── Admin-Facing Templates ──────────────────────────────────────

function clientSignedAdmin({ clientName, eventTypeLabel = 'event', proposalId, adminUrl }) {
  const name = clientName || 'A client';
  return {
    subject: `Proposal Signed: ${name} — ${eventTypeLabel} (#${proposalId})`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Proposal Signed</h2>
      <p><strong>${esc(name)}</strong> has signed the proposal for their <strong>${esc(eventTypeLabel)}</strong> (#${proposalId}).</p>
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
      <p><strong>${esc(name)}</strong> paid <strong>$${amount}</strong> (${paymentType}) for their <strong>${esc(eventTypeLabel)}</strong> (#${proposalId}).</p>
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
      <p><strong>${esc(name)}</strong> signed the proposal and paid <strong>$${amount}</strong> (${paymentType}) for their <strong>${esc(eventTypeLabel)}</strong> (#${proposalId}).</p>
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
      <p><strong>${esc(applicantName)}</strong> (${esc(applicantEmail)}) has submitted an application.</p>
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
      <p><strong>${esc(staffName)}</strong> has requested to work as <strong>${esc(position)}</strong> at ${esc(eventPhrase)} on ${esc(eventDate)}.</p>
      ${ctaButton(adminUrl, 'View Shift Requests')}
    `),
    text: `${staffName} requested to work ${position} at ${eventPhrase} on ${eventDate}. Review at: ${adminUrl}`,
  };
}

// ─── Staff-Facing Templates ─────────────────────────────────────

// setupTime is back-of-house only — this is a STAFF confirmation email, never
// sent to clients/leads. The "arrive by" row/line renders ONLY when setupTime
// is truthy (caller passes null when start time is missing/unparseable).
function shiftRequestApproved({ staffName, eventTypeLabel = 'event', eventDate, startTime, endTime, location, setupTime }) {
  const name = staffName || 'there';
  const eventPhrase = eventTypeLabel === 'event' ? 'an upcoming event' : `an upcoming ${eventTypeLabel} event`;
  const setupRow = setupTime
    ? `<tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Setup / arrive by</td><td style="padding:8px 12px;">${esc(setupTime)}</td></tr>`
    : '';
  const setupText = setupTime ? ` Setup / arrive by ${setupTime}.` : '';
  return {
    subject: `You're Confirmed: ${eventTypeLabel} on ${eventDate} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">You're Confirmed!</h2>
      <p>Hi ${esc(name)},</p>
      <p>Great news — you've been confirmed to work ${esc(eventPhrase)}.</p>
      <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};width:100px;">Date</td><td style="padding:8px 12px;">${esc(eventDate)}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Time</td><td style="padding:8px 12px;">${esc(startTime)} – ${esc(endTime)}</td></tr>
        ${setupRow}
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Location</td><td style="padding:8px 12px;">${esc(location)}</td></tr>
      </table>
      <p>Please arrive on time and in proper uniform. See you there!</p>
      <p>— The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, you're confirmed to work ${eventPhrase} on ${eventDate}, ${startTime} – ${endTime} at ${location}.${setupText} Please arrive on time and in proper uniform. — The Dr. Bartender Team`,
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
      <p>Hi ${esc(name)},</p>
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
  const name = esc(customerName || 'Unknown');
  const detailRows = (details || [])
    .map(d => `<tr><td style="padding:6px 12px;font-weight:bold;color:${BRAND.secondary};vertical-align:top;width:140px;">${esc(d.question)}</td><td style="padding:6px 12px;">${esc(d.answer)}</td></tr>`)
    .join('');
  const detailsTable = detailRows
    ? `<table style="width:100%;border-collapse:collapse;margin:1rem 0;">${detailRows}</table>`
    : '';
  const dateStr = eventDate ? new Date(eventDate).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'Not specified';

  return {
    subject: `New Thumbtack Lead: ${esc(customerName || 'Unknown')}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">New Thumbtack Lead</h2>
      <p style="background:#fff3cd;border:1px solid #ffc107;padding:12px;border-radius:6px;font-weight:bold;">
        Action needed: Grab the customer's email from Thumbtack (lead &rarr; three dots &rarr; create estimate/invoice).
      </p>
      <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};width:120px;">Name</td><td style="padding:8px 12px;">${name}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Phone</td><td style="padding:8px 12px;">${esc(customerPhone || 'N/A')}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Category</td><td style="padding:8px 12px;">${esc(category || 'N/A')}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Location</td><td style="padding:8px 12px;">${esc(location || 'N/A')}</td></tr>
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
  const name = esc(customerName || 'A customer');
  const rawPreview = text && text.length > 300 ? text.slice(0, 300) + '...' : (text || '(no text)');
  return {
    subject: `Thumbtack Message from ${esc(customerName || 'A customer')}`,
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
  const name = esc(reviewerName || 'A customer');
  const stars = rating !== null && rating !== undefined ? '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating)) : 'N/A';
  return {
    subject: `New Thumbtack Review: ${stars} from ${esc(reviewerName || 'A customer')}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">New Thumbtack Review</h2>
      <p style="font-size:24px;margin:0.5rem 0;">${stars}</p>
      <p><strong>${name}</strong> left a ${rating !== null && rating !== undefined ? rating + '/5' : ''} review on Thumbtack:</p>
      ${reviewText ? `<div style="background:${BRAND.bg};padding:16px;border-radius:6px;margin:1rem 0;border-left:4px solid ${BRAND.secondary};">${esc(reviewText)}</div>` : '<p style="color:#999;"><em>No review text</em></p>'}
    `),
    text: `New Thumbtack review from ${reviewerName || 'A customer'}: ${rating}/5 — ${reviewText || '(no text)'}`,
  };
}

// ─── Tip-page feedback (1-3★ negative-rating notification) ──────

function labratBugReportAdmin({ bugId, kind, missionId, stepIndex, testerName, where, didWhat, happened, expected, browser, reportedAt }) {
  let kindLabel = kind || 'Report';
  if (kind === 'bug') kindLabel = 'Bug';
  else if (kind === 'confusion') kindLabel = 'Confusion';
  else if (kind === 'mission-stale') kindLabel = 'Stale mission';
  // Strip CR/LF/tab and cap length before interpolating into the email subject —
  // Resend / SMTP would reject header-significant chars, but defense-in-depth.
  const subjectSafe = (v, max = 80) => (v ? String(v).replace(/[\r\n\t]/g, ' ').slice(0, max) : '');
  const subjectName = testerName ? ` from ${subjectSafe(testerName)}` : '';
  const subjectMission = missionId ? ` — ${subjectSafe(missionId, 60)}` : '';
  const formatBlock = (label, value) => value
    ? `<p style="margin:0.5rem 0;"><strong>${label}:</strong><br/>${esc(value).replace(/\n/g, '<br/>')}</p>`
    : '';
  return {
    subject: `[Lab Rat] ${kindLabel}${subjectName}${subjectMission}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Lab Rat ${kindLabel.toLowerCase()} report</h2>
      <p style="color:${BRAND.secondary};margin:0 0 1rem;">${esc(reportedAt || new Date().toISOString())}</p>
      <p><strong>Tester:</strong> ${esc(testerName || 'anonymous')}</p>
      ${missionId ? `<p><strong>Mission:</strong> ${esc(missionId)}${Number.isFinite(stepIndex) ? ` (step ${stepIndex + 1})` : ''}</p>` : ''}
      ${where ? `<p><strong>Where:</strong> ${esc(where)}</p>` : ''}
      <div style="background:${BRAND.bg};padding:16px;border-radius:6px;margin:1rem 0;border-left:4px solid ${BRAND.secondary};">
        ${formatBlock('What they did', didWhat)}
        ${formatBlock(kind === 'mission-stale' ? "What's wrong" : 'What happened', happened)}
        ${formatBlock('What they expected', expected)}
      </div>
      <p style="color:${BRAND.secondary};font-size:12px;margin-top:1.5rem;">Bug ID: ${esc(bugId || '—')}<br/>Browser: ${esc(browser || 'unknown')}</p>
    `),
    text: `Lab Rat ${kindLabel} from ${testerName || 'anonymous'}${missionId ? ` (mission ${missionId}${Number.isFinite(stepIndex) ? `, step ${stepIndex + 1}` : ''})` : ''}\n\nWhere: ${where || '—'}\nDid: ${didWhat || '—'}\nHappened: ${happened || '—'}${expected ? `\nExpected: ${expected}` : ''}\n\nBug ID: ${bugId || '—'}\nReported: ${reportedAt || new Date().toISOString()}`,
  };
}

function tipFeedbackAdminNotification({ displayName, rating, comment, submitterEmail, adminUrl }) {
  const name = displayName || 'a bartender';
  const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
  const commentHtml = comment ? esc(comment).replace(/\n/g, '<br/>') : '<em>(no comment)</em>';
  return {
    subject: `${rating}-star tip-page feedback for ${esc(name)}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Tip-page feedback</h2>
      <p style="font-size:24px;margin:0.5rem 0;">${stars}</p>
      <p><strong>Bartender:</strong> ${esc(name)}</p>
      <p><strong>Rating:</strong> ${rating} / 5</p>
      <div style="background:${BRAND.bg};padding:16px;border-radius:6px;margin:1rem 0;border-left:4px solid ${BRAND.secondary};">
        <strong>Comment:</strong><br/>${commentHtml}
      </div>
      ${submitterEmail ? `<p><strong>Submitter email:</strong> ${esc(submitterEmail)}</p>` : ''}
      ${ctaButton(adminUrl, 'Review in admin')}
    `),
    text: `${rating}-star tip-page feedback for ${name}. Comment: ${comment || '(no comment)'}${submitterEmail ? ` Submitter: ${submitterEmail}` : ''}. Review: ${adminUrl}`,
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

// Lifecycle templates live in a sibling file to keep this one under the
// file-size cap. Re-exported below for backwards compatibility — existing
// consumers that access them by property (emailTemplates.signedAndPaidClient)
// keep working unchanged. lifecycleEmailTemplates.js is a leaf module (no
// require back into this file — it duplicates the shared helpers on purpose),
// so it is fully loaded here and the re-exports below are plain references.
const lifecycle = require('./lifecycleEmailTemplates');
const payroll = require('./payrollEmailTemplates');

// ─── Pre-event Reminder Emails (Plan 2c) ────────────────────────

/**
 * Event-week reminder (T-7 days). Email-only touch, fires from the
 * scheduled-message dispatcher.
 */
function eventWeekReminderClient({
  clientName, clientFirstName, eventDateLocal, startTimeLocal,
  location, guestCount, packageName, proposalUrl,
}) {
  const first = clientFirstName || clientName || 'there';
  return {
    subject: `One week until your ${eventDateLocal} event`,
    html: wrapEmail(`
      <p>Hi ${esc(first)}, can't wait for next week. Here's what we have on file:</p>
      <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Date</td><td style="padding:8px 12px;text-align:right;">${esc(eventDateLocal)}</td></tr>
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Time</td><td style="padding:8px 12px;text-align:right;">${esc(startTimeLocal)}</td></tr>
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Location</td><td style="padding:8px 12px;text-align:right;">${esc(location || 'TBD')}</td></tr>
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Guest count</td><td style="padding:8px 12px;text-align:right;">${esc(String(guestCount ?? ''))}</td></tr>
        <tr><td style="padding:8px 12px;color:${BRAND.secondary};">Package</td><td style="padding:8px 12px;text-align:right;">${esc(packageName || '')}</td></tr>
      </table>
      <p>Anything changed? Reply here or call.</p>
      ${proposalUrl ? ctaButton(proposalUrl, 'View your proposal') : ''}
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${first}, can't wait for next week. Here's what we have on file:\n\nDate: ${eventDateLocal}\nTime: ${startTimeLocal}\nLocation: ${location || 'TBD'}\nGuest count: ${guestCount ?? ''}\nPackage: ${packageName || ''}\n\nAnything changed? Reply here or call.\n\n${proposalUrl ? `View your proposal: ${proposalUrl}\n\n` : ''}Cheers, Dallas`,
  };
}

/**
 * Reschedule notification — fires immediately when admin updates event_date,
 * event_start_time, or event_location on a post-sign+pay proposal.
 */
function rescheduleNotificationClient({
  clientName, clientFirstName,
  oldDateLocal, oldStartTimeLocal, oldLocation,
  newDateLocal, newStartTimeLocal, newLocation,
  packageName, guestCount, totalFormatted,
  balanceDueDateLocal, autopayEnrolled,
}) {
  const first = clientFirstName || clientName || 'there';
  const balanceLine = balanceDueDateLocal
    ? `<li><strong>${autopayEnrolled ? 'Balance auto-charges' : 'Balance due'}</strong> on ${esc(balanceDueDateLocal)}</li>`
    : '';
  const balanceLineText = balanceDueDateLocal
    ? `${autopayEnrolled ? 'Balance auto-charges' : 'Balance due'} on ${balanceDueDateLocal}\n`
    : '';
  return {
    subject: 'Updated details for your event',
    html: wrapEmail(`
      <p>Hi ${esc(first)}, your event has been moved.</p>
      <p style="margin:1.5rem 0;"><strong>Old details:</strong> ${esc(oldDateLocal)} at ${esc(oldStartTimeLocal)}, ${esc(oldLocation || 'TBD')}<br/>
         <strong>New details:</strong> ${esc(newDateLocal)} at ${esc(newStartTimeLocal)}, ${esc(newLocation || 'TBD')}</p>
      <p>Everything else stays the same:</p>
      <ul>
        <li>Package: ${esc(packageName || '')}</li>
        <li>Guest count: ${esc(String(guestCount ?? ''))}</li>
        <li>Total: $${esc(String(totalFormatted))}</li>
        ${balanceLine}
      </ul>
      <p>Let me know if you have any questions or need to discuss anything.</p>
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${first}, your event has been moved.\n\nOld details: ${oldDateLocal} at ${oldStartTimeLocal}, ${oldLocation || 'TBD'}\nNew details: ${newDateLocal} at ${newStartTimeLocal}, ${newLocation || 'TBD'}\n\nEverything else stays the same:\nPackage: ${packageName || ''}\nGuest count: ${guestCount ?? ''}\nTotal: $${totalFormatted}\n${balanceLineText}\nLet me know if you have any questions or need to discuss anything.\n\nCheers, Dallas`,
  };
}

/**
 * Long-lead T-30 recap — fires at T-30 days for proposals whose booking lead
 * time was 90+ days. BYOB variant includes the shopping-list reminder; Hosted
 * variant omits it (caller passes barOption).
 */
function longLeadT30RecapClient({
  clientName, clientFirstName, eventDateLocal, drinksSummary,
  shoppingListUrl, barOption,
}) {
  const first = clientFirstName || clientName || 'there';
  // BYOB recap includes the shopping-list reminder; the link line renders only
  // when shoppingListUrl is truthy (mirrors how eventWeekReminderClient guards
  // proposalUrl) so an empty value never emits <a href="">. The freshness
  // reminder still reads sensibly without the link.
  const shoppingLinkHtml = shoppingListUrl
    ? `<p><strong>Shopping list:</strong> <a href="${esc(shoppingListUrl)}">${esc(shoppingListUrl)}</a></p>\n       `
    : '';
  const shoppingBlockHtml = barOption === 'byob'
    ? `${shoppingLinkHtml}<p>Reminder: best to do the actual shopping in the days leading up to the event so things stay fresh and unused items are still returnable.</p>`
    : '';
  const shoppingLinkText = shoppingListUrl ? `\nShopping list: ${shoppingListUrl}\n` : '';
  const shoppingBlockText = barOption === 'byob'
    ? `${shoppingLinkText}\nReminder: best to do the actual shopping in the days leading up to the event so things stay fresh and unused items are still returnable.\n`
    : '';
  return {
    subject: `Three weeks out from your ${eventDateLocal} event`,
    html: wrapEmail(`
      <p>Hi ${esc(first)}, your event is in about 3 weeks. Quick recap of what you've got teed up:</p>
      <p><strong>Drinks:</strong> ${esc(drinksSummary || 'Drink plan submitted')}</p>
      ${shoppingBlockHtml}
      <p>Anything change? Reply here.</p>
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${first}, your event is in about 3 weeks. Quick recap of what you've got teed up:\n\nDrinks: ${drinksSummary || 'Drink plan submitted'}\n${shoppingBlockText}\nAnything change? Reply here.\n\nCheers, Dallas`,
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
  paymentReminderClient,
  paymentReminderLate,
  refundNotificationClient,
  paymentFailedClient,
  clientSignedAdmin,
  paymentReceivedAdmin,
  disputeWonAdminNotification: payroll.disputeWonAdminNotification,
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
  abandonedQuote,
  newThumbtackLeadAdmin,
  newThumbtackMessageAdmin,
  newThumbtackReviewAdmin,
  // Tip-page feedback
  tipFeedbackAdminNotification,
  // Lab Rat bug reports
  labratBugReportAdmin,
  // Hiring redesign
  interviewConfirmation,
  paperworkReminder,
  sendInterviewConfirmationEmail,
  sendPaperworkReminderEmail,
  // Shared helpers — exported so sibling template files / callers can reuse the
  // BRAND palette and email shell. (lifecycleEmailTemplates.js keeps its own
  // copies to stay a leaf module; see the note in that file.)
  esc,
  BRAND,
  lastMinuteCaveatHtml,
  lastMinuteCaveatText,
  // Lifecycle templates re-exported from the sibling file for backwards compat.
  signedAndPaidClient: lifecycle.signedAndPaidClient,
  drinkPlanLink: lifecycle.drinkPlanLink,
  drinkPlanBalanceUpdate: lifecycle.drinkPlanBalanceUpdate,
  shoppingListReady: lifecycle.shoppingListReady,
  postConsultClient: lifecycle.postConsultClient,
  lastMinuteStaffingConfirmation: lifecycle.lastMinuteStaffingConfirmation,
  gratuityStaffingChange: lifecycle.gratuityStaffingChange,
  // Pre-event reminder emails (Plan 2c)
  eventWeekReminderClient,
  rescheduleNotificationClient,
  longLeadT30RecapClient,
};
