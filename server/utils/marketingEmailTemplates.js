const { wrapMarketingEmail, wrapEmail } = require('./emailTemplates');

const BRAND_PRIMARY = '#3b2314';
const BRAND_SECONDARY = '#6b4226';
const BRAND_BG = '#f9f6f3';

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ctaButton(url, label) {
  return `<p style="text-align:center;margin:2rem 0;">
    <a href="${esc(url)}" style="display:inline-block;padding:14px 32px;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;font-size:16px;">${esc(label)}</a>
  </p>`;
}

function defaults(p) {
  return {
    clientFirstName: p.clientFirstName || p.clientName || 'there',
    clientName: p.clientName || p.clientFirstName || 'there',
    eventTypeLabel: p.eventTypeLabel || 'event',
    eventDateDisplay: p.eventDateDisplay || 'your upcoming event',
    proposalUrl: p.proposalUrl || '#',
    unsubscribeUrl: p.unsubscribeUrl || '',
  };
}

// ─── 1.3 Drip — Touch 2 (+7 days) ────────────────────────────────

function dripTouch2Client(params) {
  const d = defaults(params);
  return {
    subject: `Still thinking about your ${d.eventDateDisplay} event, ${d.clientFirstName}?`,
    html: wrapMarketingEmail(`
      <p>Hi ${esc(d.clientFirstName)},</p>
      <p>Just checking in on your <strong>${esc(d.eventTypeLabel)}</strong> coming up ${esc(d.eventDateDisplay)}. Your proposal is still good to go whenever you're ready.</p>
      ${ctaButton(d.proposalUrl, 'View your proposal')}
      <p>Let me know if you have any questions or want to talk anything through.</p>
      <p>Cheers,<br/>Dallas</p>
    `, d.unsubscribeUrl),
    text: `Hi ${d.clientFirstName}, just checking in on your ${d.eventTypeLabel} coming up ${d.eventDateDisplay}. Your proposal is still good to go: ${d.proposalUrl}. Let me know if you have any questions. Cheers, Dallas`,
  };
}

// ─── 1.3 Drip — Touch 4 (+14 days) ───────────────────────────────

function dripTouch4Client(params) {
  const d = defaults(params);
  return {
    subject: `Following up on your ${d.eventDateDisplay} booking, ${d.clientFirstName}`,
    html: wrapMarketingEmail(`
      <p>Hi ${esc(d.clientFirstName)},</p>
      <p>Wanted to check back in on your <strong>${esc(d.eventTypeLabel)}</strong>. Your proposal as written is still here.</p>
      ${ctaButton(d.proposalUrl, 'View your proposal')}
      <p>A few things worth knowing: if BYOB isn't quite right, we also offer <strong>Hosted</strong> packages where we handle the alcohol. Happy to send an updated quote if you want to see numbers on that side.</p>
      <p>Let me know if you have any questions or need any changes.</p>
      <p>Cheers,<br/>Dallas</p>
    `, d.unsubscribeUrl),
    text: `Hi ${d.clientFirstName}, checking back in on your ${d.eventTypeLabel}. Proposal: ${d.proposalUrl}. If BYOB isn't quite right, we also offer Hosted packages, happy to send numbers. Cheers, Dallas`,
  };
}

// ─── 1.3 Drip — Touch 5 (+21 days), email half ───────────────────

function dripTouch5Client(params) {
  const d = defaults(params);
  return {
    subject: `Last call to secure ${d.eventDateDisplay}, ${d.clientFirstName}`,
    html: wrapMarketingEmail(`
      <p>Hi ${esc(d.clientFirstName)},</p>
      <p>Wanted to do one last check-in on your <strong>${esc(d.eventTypeLabel)}</strong> on ${esc(d.eventDateDisplay)}. We're still holding the date, but other bookings come in regularly for that weekend.</p>
      ${ctaButton(d.proposalUrl, 'Lock it in')}
      <p>If you'd rather walk away, no hard feelings, just reply to let us know.</p>
      <p>Cheers,<br/>Dallas</p>
    `, d.unsubscribeUrl),
    text: `Hi ${d.clientFirstName}, one last check on your ${d.eventTypeLabel} on ${d.eventDateDisplay}. We're still holding the date but others come in for that weekend. Lock it in: ${d.proposalUrl}. Or reply to walk away. Cheers, Dallas`,
  };
}

// ─── 4.1 Post-event review request (T+2 days) ────────────────────

function reviewRequestClient(params) {
  const d = defaults(params);
  const dayOfWeek = params.dayOfWeek || 'weekend';
  const feedbackUrl = params.feedbackUrl || '#';
  const bartenderName = params.bartenderName;
  const venmoHandle = params.venmoHandle;
  const cashappHandle = params.cashappHandle;
  // Zelle intentionally omitted — payment_profiles.zelle_handle does not
  // exist in the current schema (only venmo_handle, cashapp_handle,
  // paypal_url). Plan 2d defers Zelle support; add a migration later if
  // we want to introduce it.

  let tipSection = '';
  if (bartenderName) {
    const handles = [];
    if (venmoHandle) handles.push(`Venmo: <strong>${esc(venmoHandle)}</strong>`);
    if (cashappHandle) handles.push(`Cash App: <strong>${esc(cashappHandle)}</strong>`);
    if (handles.length > 0) {
      tipSection = `
        <p style="background:${BRAND_BG};padding:14px 18px;border-left:4px solid ${BRAND_SECONDARY};border-radius:4px;font-size:14px;">
          Also, in case you didn't get a chance to tip on the night, your bartender <strong>${esc(bartenderName)}</strong> takes tips at:<br/>
          ${handles.join('<br/>')}
        </p>
      `;
    }
  }

  // W6 fix: review_request is registered with `category: 'operational'`
  // (transactional CAN-SPAM follow-up). Use `wrapEmail` (no unsubscribe
  // footer) instead of `wrapMarketingEmail` — including an unsubscribe footer
  // on a transactional email would be inconsistent with the operational
  // classification and confuse clients.
  return {
    subject: `How was your ${d.eventDateDisplay} event?`,
    html: wrapEmail(`
      <p>Hi ${esc(d.clientFirstName)},</p>
      <p>Thanks again for having us at your <strong>${esc(d.eventTypeLabel)}</strong> last ${esc(dayOfWeek)}. Hope you and your guests had a great time.</p>
      <p>If you have a moment, we'd love to hear how it went:</p>
      ${ctaButton(feedbackUrl, 'Rate your experience')}
      ${tipSection}
      <p>Cheers,<br/>Dallas</p>
    `),
    text: `Hi ${d.clientFirstName}, thanks again for having us at your ${d.eventTypeLabel} last ${dayOfWeek}. Rate your experience: ${feedbackUrl}${bartenderName ? `. Tip ${bartenderName}${venmoHandle ? ` at Venmo ${venmoHandle}` : ''}${cashappHandle ? `, Cash App ${cashappHandle}` : ''}` : ''}. Cheers, Dallas`,
  };
}

// ─── 1.4 New Year touch ──────────────────────────────────────────

function newYearHelloClient(params) {
  const d = defaults(params);
  return {
    subject: `Happy new year, ${d.clientFirstName}, looking forward to your event`,
    html: wrapMarketingEmail(`
      <p>Hi ${esc(d.clientFirstName)}, happy new year from Dr. Bartender.</p>
      <p>Just a quick hello to say we're looking forward to your <strong>${esc(d.eventTypeLabel)}</strong> later this year on ${esc(d.eventDateDisplay)}. Everything's on the books and we'll be in touch with more details as we get closer.</p>
      <p>Reach out anytime with questions or changes.</p>
      <p>Cheers,<br/>Dallas</p>
    `, d.unsubscribeUrl),
    text: `Hi ${d.clientFirstName}, happy new year. Looking forward to your ${d.eventTypeLabel} on ${d.eventDateDisplay}. Reach out anytime. Cheers, Dallas`,
  };
}

// ─── 1.5 Six-months-out touch ────────────────────────────────────

function sixMonthsOutClient(params) {
  const d = defaults(params);
  const potionPlannerUrl = params.potionPlannerUrl || null;
  const consultUrl = params.consultUrl || null;

  let plannerSection = '';
  if (potionPlannerUrl) {
    plannerSection += `<p>Whenever you're ready to start thinking about drinks, the Potion Planner is here:</p>${ctaButton(potionPlannerUrl, 'Open the Potion Planner')}`;
  }
  if (consultUrl) {
    plannerSection += `<p>Or if you'd rather walk through it together, you can <a href="${esc(consultUrl)}">book a 15-minute consult</a>.</p>`;
  }

  return {
    subject: `Six months out from your ${d.eventDateDisplay} event`,
    html: wrapMarketingEmail(`
      <p>Hi ${esc(d.clientFirstName)},</p>
      <p>We're now six months out from your <strong>${esc(d.eventTypeLabel)}</strong> on ${esc(d.eventDateDisplay)}. Mostly just saying hi.</p>
      ${plannerSection}
      <p>Cheers,<br/>Dallas</p>
    `, d.unsubscribeUrl),
    text: `Hi ${d.clientFirstName}, six months out from your ${d.eventTypeLabel} on ${d.eventDateDisplay}.${potionPlannerUrl ? ` Potion Planner: ${potionPlannerUrl}.` : ''}${consultUrl ? ` Book a consult: ${consultUrl}.` : ''} Cheers, Dallas`,
  };
}

// ─── 4.2 Retention nudge (T+11 months) ───────────────────────────

function retentionNudgeClient(params) {
  const d = defaults(params);
  const ctaUrl = params.ctaUrl || 'https://drbartender.com/quote';
  return {
    subject: `Almost a year since your ${d.eventTypeLabel}, ${d.clientFirstName}`,
    html: wrapMarketingEmail(`
      <p>Hi ${esc(d.clientFirstName)},</p>
      <p>It's been almost a year since your <strong>${esc(d.eventTypeLabel)}</strong> with us. If you're planning anything similar this year, we'd love to help. Same packages, same team.</p>
      ${ctaButton(ctaUrl, 'Get a quote')}
      <p>Reach out anytime.</p>
      <p>Cheers,<br/>Dallas</p>
    `, d.unsubscribeUrl),
    text: `Hi ${d.clientFirstName}, it's been almost a year since your ${d.eventTypeLabel}. If you're planning anything similar, we'd love to help. Quote: ${ctaUrl}. Cheers, Dallas`,
  };
}

// ─── Admin notification for low-rating feedback (sibling of tipFeedbackAdminNotification) ─────

function lowRatingAdminNotification(params) {
  const clientName = esc(params.clientName || 'A client');
  const eventDateDisplay = esc(params.eventDateDisplay || '');
  const eventTypeLabel = esc(params.eventTypeLabel || 'event');
  const rating = Number(params.rating) || 0;
  const comment = params.comment ? esc(params.comment) : null;
  const adminUrl = params.adminUrl || '';

  const commentBlock = comment
    ? `<div style="background:${BRAND_BG};padding:14px 18px;border-left:4px solid ${BRAND_SECONDARY};border-radius:4px;margin:12px 0;">${comment}</div>`
    : '<p style="color:#999;font-style:italic;">No comment provided.</p>';

  return {
    subject: `Low rating (${rating}/5) on ${eventTypeLabel} — ${clientName}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND_PRIMARY};margin-top:0;">Low post-event rating</h2>
      <p><strong>${clientName}</strong> just rated their <strong>${eventTypeLabel}</strong>${eventDateDisplay ? ` on ${eventDateDisplay}` : ''}:</p>
      <p style="font-size:24px;margin:0.5rem 0;"><strong>${rating} / 5</strong></p>
      ${commentBlock}
      ${adminUrl ? ctaButton(adminUrl, 'View proposal') : ''}
    `),
    text: `Low rating (${rating}/5) from ${clientName} on ${eventTypeLabel}${eventDateDisplay ? ` on ${eventDateDisplay}` : ''}.${comment ? ` Comment: "${comment}".` : ''}${adminUrl ? ` View: ${adminUrl}` : ''}`,
  };
}

module.exports = {
  dripTouch2Client,
  dripTouch4Client,
  dripTouch5Client,
  reviewRequestClient,
  newYearHelloClient,
  sixMonthsOutClient,
  retentionNudgeClient,
  lowRatingAdminNotification,
};
