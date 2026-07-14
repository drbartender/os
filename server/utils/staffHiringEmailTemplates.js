/**
 * Staff / hiring / application email templates for Dr. Bartender — the
 * recruiting and staffing lifecycle touches (new-application admin alerts,
 * shift-request admin alerts + staff confirmation, application-received
 * confirmation, the application-status progression emails, and the hiring
 * redesign interview-confirmation / paperwork-reminder templates plus their
 * DB-lookup send wrappers). Carved out of emailTemplates.js to keep that file
 * under the file-size cap, mirroring lifecycleEmailTemplates.js /
 * marketingEmailTemplates.js.
 *
 * emailTemplates.js re-exports the templates below for backwards compatibility
 * (one spread line), so consumers that access them by property
 * (emailTemplates.applicationHired) keep working unchanged.
 *
 * IMPORTANT — BRAND / wrapEmail / ctaButton are DUPLICATED here on purpose.
 * They also exist in emailTemplates.js. They are copied (not imported) to break
 * the require cycle: emailTemplates.js requires this file for the templates, so
 * importing the helpers back from it would mean reading exports of a module that
 * is still mid-load. If you edit the BRAND palette or the email shell, update
 * BOTH files. They are intentionally byte-for-byte identical — keep them that
 * way. (esc is the exception — it lives in ./htmlEscape and is imported by both.)
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

// ─── Staff/Hiring Admin Notifications ────────────────────────────

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
    subject: `Shift Request: ${staffName}, ${eventTypeLabel}`,
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
    subject: `You're Confirmed: ${eventTypeLabel} on ${eventDate} - Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">You're Confirmed!</h2>
      <p>Hi ${esc(name)},</p>
      <p>Great news, you've been confirmed to work ${esc(eventPhrase)}.</p>
      <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};width:100px;">Date</td><td style="padding:8px 12px;">${esc(eventDate)}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Time</td><td style="padding:8px 12px;">${esc(startTime)} – ${esc(endTime)}</td></tr>
        ${setupRow}
        <tr><td style="padding:8px 12px;font-weight:bold;color:${BRAND.secondary};">Location</td><td style="padding:8px 12px;">${esc(location)}</td></tr>
      </table>
      <p>Please arrive on time and in proper uniform. See you there!</p>
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${name}, you're confirmed to work ${eventPhrase} on ${eventDate}, ${startTime} – ${endTime} at ${location}.${setupText} Please arrive on time and in proper uniform. Cheers, Dallas`,
  };
}

function applicationReceivedConfirmation({ applicantName }) {
  const name = applicantName || 'there';
  return {
    subject: `Application Received - Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Application Received!</h2>
      <p>Hi ${esc(name)},</p>
      <p>Thank you for applying to join the Dr. Bartender team! We've received your application and will review it shortly.</p>
      <p>We'll reach out with next steps once our team has had a chance to go over your information.</p>
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${name}, thank you for applying to Dr. Bartender! We've received your application and will review it shortly. Cheers, Dallas`,
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
    subject: `We'd like to interview you - Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Let's Chat!</h2>
      <p>Hi ${esc(name)},</p>
      <p>Thanks for applying to Dr. Bartender, we liked what we saw and we'd like to set up a quick interview.</p>
      ${note}
      <p>Our team will reach out shortly with scheduling details. Feel free to reply to this email with any times that work for you.</p>
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${name}, we'd like to interview you. Our team will reach out with scheduling details. ${customMessage ? `Note from the team: ${customMessage}` : ''} Cheers, Dallas`,
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
      <p>If you have any questions getting set up, just reply to this email, we're here to help.</p>
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${name}, welcome to the Dr. Bartender team! Log into the staff portal to complete your onboarding: ${staffPortalUrl || 'https://staff.drbartender.com'}${customMessage ? ` Note: ${customMessage}` : ''}. Cheers, Dallas`,
  };
}

function applicationRejected({ applicantName, customMessage }) {
  const name = applicantName || 'there';
  const note = customMessageBlock(customMessage);
  return {
    subject: `About your application - Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Thank You for Applying</h2>
      <p>Hi ${esc(name)},</p>
      <p>Thank you for your interest in joining the Dr. Bartender team and for taking the time to apply. After careful review, we've decided to move forward with other candidates at this time.</p>
      ${note}
      <p>We genuinely appreciate the effort you put into your application, and we wish you the best in your search.</p>
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${name}, thank you for applying to Dr. Bartender. After review, we've decided to move forward with other candidates at this time. ${customMessage ? `Note: ${customMessage}` : ''} We wish you the best. Cheers, Dallas`,
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
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${name}, your Dr. Bartender staff account has been deactivated. ${customMessage ? `Note: ${customMessage}` : ''} If this was in error, please reply to this email. Cheers, Dallas`,
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
    subject: `Interview confirmed: ${dateStr}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Interview confirmed</h2>
      <p>Hi ${esc(name)},</p>
      <p>Your interview with Dr. Bartender is confirmed for <strong>${esc(dateStr)} at ${esc(timeStr)}</strong>.</p>
      <p>If anything changes on your end, just reply to this email.</p>
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${name}, your interview with Dr. Bartender is confirmed for ${dateStr} at ${timeStr}. If anything changes, reply to this email. Cheers, Dallas`,
  };
}

function paperworkReminder({ applicantName, staffUrl }) {
  const name = applicantName || 'there';
  const url = staffUrl || 'https://staff.drbartender.com';
  return {
    subject: 'Quick nudge: finish your onboarding',
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Just a friendly nudge</h2>
      <p>Hi ${esc(name)},</p>
      <p>This is a quick reminder to finish your Dr. Bartender onboarding paperwork. The portal saves your progress so you can pick up where you left off:</p>
      <p>${ctaButton(url, 'Continue onboarding →')}</p>
      <p>Reply if you hit a snag, happy to help.</p>
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${name}, just a friendly nudge to finish your Dr. Bartender onboarding paperwork: ${url}. Cheers, Dallas`,
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
  newApplicationAdmin,
  shiftRequestAdmin,
  shiftRequestApproved,
  applicationReceivedConfirmation,
  applicationInterviewInvite,
  applicationHired,
  applicationRejected,
  applicationDeactivated,
  interviewConfirmation,
  paperworkReminder,
  sendInterviewConfirmationEmail,
  sendPaperworkReminderEmail,
};
