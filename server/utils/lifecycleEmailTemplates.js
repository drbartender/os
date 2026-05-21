/**
 * Lifecycle email templates for Dr. Bartender — client-facing booking lifecycle
 * touches (signed & paid, drink plan link, balance update, shopping list ready,
 * post-consult). Carved out of emailTemplates.js to stay under the file-size cap
 * ahead of Plan 2b's template expansions.
 *
 * emailTemplates.js re-exports the templates below for backwards compatibility,
 * so consumers that access them by property (emailTemplates.signedAndPaidClient)
 * keep working unchanged.
 *
 * IMPORTANT — shared helpers are DUPLICATED here on purpose.
 *   esc / BRAND / wrapEmail / ctaButton / lastMinuteCaveatHtml /
 *   lastMinuteCaveatText also exist in emailTemplates.js.
 * They are copied (not imported) to break the require cycle: emailTemplates.js
 * requires this file for the templates, and importing the helpers back from it
 * would mean reading exports of a module that is still mid-load. If you edit the
 * BRAND palette or the email shell, update BOTH files. They are intentionally
 * byte-for-byte identical — keep them that way.
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

function signedAndPaidClient({
  clientName,
  eventTypeLabel = 'event',
  amount,
  paymentType,
  lastMinute = false,
  // New orientation fields (additive; old call shape still works without these)
  bookingBlock,
  receiptBlock,
  potionPlannerUrl,
  timelineLines,
}) {
  const name = clientName || 'there';

  // Fallback: old short-form behavior when caller hasn't migrated to the
  // orientation shape. Lets us ship the template change ahead of the route
  // rewire without breaking the existing send.
  if (!bookingBlock || !receiptBlock) {
    return {
      subject: `Signed & Paid — your ${eventTypeLabel} — Dr. Bartender`,
      html: wrapEmail(`
        <h2 style="color:${BRAND.primary};margin-top:0;">You're Locked In!</h2>
        <p>Hi ${name},</p>
        <p>We've received your signed proposal <em>and</em> your <strong>${paymentType}</strong> of <strong>$${amount}</strong> for your <strong>${eventTypeLabel}</strong>. Your date is officially on the books.</p>
        ${lastMinuteCaveatHtml(lastMinute)}
        <p>We'll be in touch with next steps as your event date approaches.</p>
        <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
        <p>Cheers,<br/>The Dr. Bartender Team</p>
      `),
      text: `Hi ${name}, we've received your signed proposal and your ${paymentType} of $${amount} for your ${eventTypeLabel}. Your date is officially on the books.${lastMinuteCaveatText(lastMinute)} — The Dr. Bartender Team`,
    };
  }

  // Full orientation rendering.
  const bb = bookingBlock;
  const rb = receiptBlock;

  const bookingTable = `
    <table style="width:100%;border-collapse:collapse;margin:1.25rem 0;">
      <tr><td style="padding:6px 12px;color:${BRAND.secondary};width:140px;">Date</td><td style="padding:6px 12px;font-weight:bold;">${esc(bb.formattedEventDate || 'TBD')}</td></tr>
      <tr><td style="padding:6px 12px;color:${BRAND.secondary};">Start time</td><td style="padding:6px 12px;font-weight:bold;">${esc(bb.formattedStartTime || 'TBD')}</td></tr>
      <tr><td style="padding:6px 12px;color:${BRAND.secondary};">Location</td><td style="padding:6px 12px;">${esc(bb.eventLocation || 'TBD')}</td></tr>
      <tr><td style="padding:6px 12px;color:${BRAND.secondary};">Guest count</td><td style="padding:6px 12px;">${esc(String(bb.guestCount || ''))}</td></tr>
      <tr><td style="padding:6px 12px;color:${BRAND.secondary};">Package</td><td style="padding:6px 12px;">${esc(bb.packageName || '')}</td></tr>
    </table>`;

  const receiptTable = rb.paidInFull
    ? `<p style="margin:1rem 0;font-weight:bold;color:${BRAND.primary};">Paid in full: $${esc(rb.depositPaid || amount || '')}</p>`
    : `
      <table style="width:100%;border-collapse:collapse;margin:1.25rem 0;">
        <tr><td style="padding:6px 12px;color:${BRAND.secondary};">${esc(paymentType || 'Deposit')} paid</td><td style="padding:6px 12px;text-align:right;font-weight:bold;">$${esc(rb.depositPaid || amount || '')}</td></tr>
        <tr><td style="padding:6px 12px;color:${BRAND.primary};font-weight:bold;">Balance remaining</td><td style="padding:6px 12px;text-align:right;font-weight:bold;">$${esc(rb.balanceRemaining || '')}</td></tr>
        ${rb.formattedBalanceDueDate ? `<tr><td style="padding:6px 12px;color:${BRAND.secondary};">Balance ${esc(rb.dueLabel || 'due on')}</td><td style="padding:6px 12px;text-align:right;">${esc(rb.formattedBalanceDueDate)}</td></tr>` : ''}
      </table>`;

  const plannerCta = potionPlannerUrl
    ? `<p>Next up: pick your drinks. The Potion Planner walks you through it in about 5 minutes.</p>${ctaButton(potionPlannerUrl, 'Pick your drinks')}`
    : '';

  const timelineHtml = Array.isArray(timelineLines) && timelineLines.length
    ? `<h3 style="color:${BRAND.primary};margin-top:1.5rem;">What to expect</h3>
       <ul style="line-height:1.7;color:${BRAND.primary};padding-left:1.25rem;">${timelineLines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`
    : '';

  const subject = bb.formattedEventDate
    ? `You're booked: ${bb.formattedEventDate} ${eventTypeLabel}`
    : `You're booked for your ${eventTypeLabel}`;

  const html = wrapEmail(`
    <h2 style="color:${BRAND.primary};margin-top:0;">You're booked!</h2>
    <p>Hi ${esc(name)},</p>
    <p>Thanks for booking with Dr. Bartender. Everything's locked in for your <strong>${esc(eventTypeLabel)}</strong>.</p>
    <h3 style="color:${BRAND.primary};margin-top:1.5rem;">Booking</h3>
    ${bookingTable}
    <h3 style="color:${BRAND.primary};margin-top:1.5rem;">Receipt</h3>
    ${receiptTable}
    ${plannerCta}
    ${timelineHtml}
    ${lastMinuteCaveatHtml(lastMinute)}
    <p style="font-size:14px;color:${BRAND.secondary};margin-top:1.5rem;">A calendar invite is attached. If you have any questions, just reply to this email.</p>
    <p>Cheers, Dallas</p>
  `);

  // Plain-text fallback.
  const textLines = [
    `Hi ${name}, you're booked for your ${eventTypeLabel}.`,
    bb.formattedEventDate ? `Date: ${bb.formattedEventDate}` : null,
    bb.formattedStartTime ? `Start time: ${bb.formattedStartTime}` : null,
    bb.eventLocation ? `Location: ${bb.eventLocation}` : null,
    bb.guestCount ? `Guest count: ${bb.guestCount}` : null,
    bb.packageName ? `Package: ${bb.packageName}` : null,
    '',
    rb.paidInFull
      ? `Paid in full: $${rb.depositPaid || amount || ''}`
      : `${paymentType || 'Deposit'} paid: $${rb.depositPaid || amount || ''}. Balance: $${rb.balanceRemaining || ''}${rb.formattedBalanceDueDate ? `, ${rb.dueLabel || 'due on'} ${rb.formattedBalanceDueDate}` : ''}.`,
    potionPlannerUrl ? `Pick your drinks: ${potionPlannerUrl}` : null,
    ...(timelineLines || []),
    lastMinuteCaveatText(lastMinute).trim(),
    '',
    'Cheers, Dallas',
  ].filter(Boolean);

  return { subject, html, text: textLines.join('\n') };
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

function drinkPlanBalanceUpdate({
  clientName,
  eventTypeLabel = 'event',
  barOption,
  balanceChanged,
  extrasAmount,
  newTotal,
  amountPaid,
  balanceDue,
  balanceDueDate,
}) {
  const name = clientName || 'there';
  const dueDate = balanceDueDate
    ? new Date(balanceDueDate).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  const balanceTable = balanceChanged
    ? `
      <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Extras Added</td><td style="padding:8px 12px;text-align:right;font-weight:bold;">$${Number(extrasAmount).toFixed(2)}</td></tr>
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Updated Event Total</td><td style="padding:8px 12px;text-align:right;font-weight:bold;">$${Number(newTotal).toFixed(2)}</td></tr>
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Amount Paid</td><td style="padding:8px 12px;text-align:right;">$${Number(amountPaid).toFixed(2)}</td></tr>
        <tr><td style="padding:8px 12px;color:${BRAND.primary};font-weight:bold;">Remaining Balance</td><td style="padding:8px 12px;text-align:right;font-weight:bold;color:${BRAND.primary};">$${Number(balanceDue).toFixed(2)}</td></tr>
      </table>
      ${dueDate ? `<p>Your remaining balance of <strong>$${Number(balanceDue).toFixed(2)}</strong> is due by <strong>${esc(dueDate)}</strong>.</p>` : ''}
    `
    : '';

  // BYOB-only freshness/return-window warning. Hosted events skip this entirely;
  // we do the shopping. Per spec section 7.6.
  const shoppingWarning = barOption === 'byob'
    ? `<p>We'll send your shopping list as soon as it's ready. When it lands, our recommendation is to hold off on the actual shopping until closer to your event date. That keeps ingredients at peak freshness and any unused items stay within most stores' return windows.</p>`
    : '';

  return {
    subject: `Got your drink list for your ${eventTypeLabel}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Got your drink list!</h2>
      <p>Hi ${esc(name)},</p>
      <p>Got your drink list. We're prepping for your <strong>${esc(eventTypeLabel)}</strong>.</p>
      ${shoppingWarning}
      ${balanceTable}
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions about your drink plan or balance, just reply to this email.</p>
      <p>Cheers, Dallas</p>
    `),
    text: [
      `Hi ${name}, got your drink list for your ${eventTypeLabel}.`,
      barOption === 'byob' ? "We'll send your shopping list as soon as it's ready. Best to hold off on actual shopping until closer to your event date for freshness and return windows." : null,
      balanceChanged ? `Updated total: $${Number(newTotal).toFixed(2)}. Amount paid: $${Number(amountPaid).toFixed(2)}. Balance due: $${Number(balanceDue).toFixed(2)}${dueDate ? ` by ${dueDate}` : ''}.` : null,
      'Cheers, Dallas',
    ].filter(Boolean).join('\n'),
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

// Placeholder — the real post-consult orientation email is implemented in a
// later Plan 2b task. Declared here now so the export list stays stable and an
// accidental call returns a valid { subject, html, text } shape instead of
// crashing. Do NOT build the real body here.
function postConsultClient({ clientName, eventTypeLabel = 'event' } = {}) {
  const name = clientName || 'there';
  return {
    subject: `Following up on your ${eventTypeLabel} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Thanks for Chatting</h2>
      <p>Hi ${esc(name)},</p>
      <p>We'll be in touch with next steps for your <strong>${esc(eventTypeLabel)}</strong>.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, thanks for chatting about your ${eventTypeLabel}. We'll be in touch with next steps. — The Dr. Bartender Team`,
  };
}

module.exports = {
  signedAndPaidClient,
  drinkPlanLink,
  drinkPlanBalanceUpdate,
  shoppingListReady,
  postConsultClient,
};
