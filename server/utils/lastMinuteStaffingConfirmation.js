const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { sendAndLogSms } = require('./sms');
const { shouldSendImmediate } = require('./messageSuppression');
const { formatPhoneDisplay } = require('./globalSearch');
const { formatEventDateLong } = require('./preEventHandlers');
const lifecycleEmail = require('./lifecycleEmailTemplates');
const smsTemplates = require('./smsTemplates');

// ─── Pure renderer ───────────────────────────────────────────────

/** Pick the most specific display name available, falling through to a generic label. */
function _resolveDisplayName(row) {
  return row.preferred_name || 'Your bartender';
}

/**
 * Render an approved-bartender list as a single human-readable string.
 *   1:  "Alex ((312) 555-1234)"   or   "Alex"  (no phone)
 *   2:  "Alex ((312) 555-1234) and Jordan ((312) 555-5678)"
 *   3+: "Alex (...), Jordan (...), and Sam (...)"   (Oxford comma)
 *
 * `phone` is the raw 10-digit value stored in `contractor_profiles.phone`
 * (per validatePhone in `phone.js`). `formatPhoneDisplay` returns
 * `(XXX) XXX-XXXX` for clean 10-digit storage and the empty string for
 * null/unparseable input; an empty display suppresses the parenthetical.
 *
 * `users` has no `first_name`/`last_name`; `contractor_profiles.preferred_name`
 * is the only name source, with `'Your bartender'` as the fallback for both
 * a null preferred_name AND a missing contractor_profiles row (LEFT JOIN null).
 */
function renderBartenderList(bartenders) {
  const parts = bartenders.map((b) => {
    const name = _resolveDisplayName(b);
    const display = formatPhoneDisplay(b.phone);
    return display ? `${name} (${display})` : name;
  });
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  const head = parts.slice(0, -1).join(', ');
  const tail = parts[parts.length - 1];
  return `${head}, and ${tail}`;
}

// ─── Notify fn ───────────────────────────────────────────────────

function _captureInfo(reason, extra) {
  if (!process.env.SENTRY_DSN_SERVER) return;
  Sentry.captureMessage(`[lastMinuteStaffingConfirmation] ${reason}`, {
    level: 'info',
    tags: { feature: 'staffing-confirmation', reason },
    extra,
  });
}

/**
 * Fire one client email + one client SMS announcing the bartender(s) for a
 * last-minute booking, the moment its shift becomes fully staffed. One-shot
 * per proposal: the caller guarantees this by gating on the atomic flip of
 * proposals.last_minute_hold true→false (see confirmStaffingIfFullyStaffed).
 * This function never throws; per-channel failures land in Sentry and the
 * other channel still attempts.
 */
async function notifyClientOfStaffingConfirmation(proposalId, shiftId) {
  // event_date::text — pg returns DATE as a JS Date object built at LOCAL
  // midnight, and formatEventDateLong's `String(event_date).slice(0,10)`
  // pattern produces "Sat Mar 21" (broken) instead of "2026-03-21" (the
  // YYYY-MM-DD the helper documents). Casting to text on the server side
  // gives the helper the input shape it expects without depending on a
  // helper bugfix outside this spec's scope.
  const proposalRows = await pool.query(
    `SELECT p.id, p.event_date::text AS event_date, p.event_start_time, p.event_timezone, p.status,
            c.id   AS client_id,
            c.name AS client_name,
            c.email AS client_email,
            c.phone AS client_phone,
            c.communication_preferences,
            c.email_status,
            c.phone_status
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );

  if (proposalRows.rows.length === 0) {
    _captureInfo('proposal_missing', { proposalId, shiftId });
    return;
  }
  const row = proposalRows.rows[0];
  if (row.client_id === null) {
    _captureInfo('orphan_proposal', { proposalId, shiftId });
    return;
  }
  if (row.status === 'archived') {
    _captureInfo('archived', { proposalId, shiftId });
    return;
  }
  if (row.event_date === null) {
    _captureInfo('event_date_null', { proposalId, shiftId });
    return;
  }

  const bartenderRows = await pool.query(
    `SELECT cp.preferred_name, cp.phone
       FROM shift_requests sr
       LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
      WHERE sr.shift_id = $1 AND sr.status = 'approved'
      ORDER BY sr.id ASC`,
    [shiftId]
  );

  if (bartenderRows.rows.length === 0) {
    _captureInfo('no_bartenders', { proposalId, shiftId });
    return;
  }

  const eventDate = formatEventDateLong(row);
  const bartenderList = renderBartenderList(bartenderRows.rows);
  const isPlural = bartenderRows.rows.length > 1;

  const proposalForSuppression = { status: row.status };
  const clientForSuppression = {
    communication_preferences: row.communication_preferences,
    email_status: row.email_status,
    phone_status: row.phone_status,
  };

  // Email send: independent try/catch. shouldSendImmediate is async; the
  // await is load-bearing (the Promise's .ok is undefined without it).
  try {
    const emailOk = await shouldSendImmediate({
      proposal: proposalForSuppression,
      client: clientForSuppression,
      channel: 'email',
    });
    if (emailOk.ok && row.client_email) {
      const rendered = lifecycleEmail.lastMinuteStaffingConfirmation({
        eventDate, bartenderList, isPlural,
      });
      await sendEmail({
        to: row.client_email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
    }
  } catch (emailErr) {
    console.error('[lastMinuteStaffingConfirmation] email send failed:', emailErr.message);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(emailErr, {
        tags: { feature: 'staffing-confirmation', channel: 'email' },
        extra: { proposalId, shiftId },
      });
    }
  }

  // SMS send: independent try/catch, same await requirement.
  try {
    const smsOk = await shouldSendImmediate({
      proposal: proposalForSuppression,
      client: clientForSuppression,
      channel: 'sms',
    });
    if (smsOk.ok && row.client_phone) {
      const body = smsTemplates.lastMinuteStaffingConfirmationSms({
        eventDate, bartenderList, isPlural,
      });
      await sendAndLogSms({
        to: row.client_phone,
        body,
        clientId: row.client_id,
        messageType: 'last_minute_staffing_confirmation',
        recipientName: row.client_name,
      });
    }
  } catch (smsErr) {
    console.error('[lastMinuteStaffingConfirmation] sms send failed:', smsErr.message);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(smsErr, {
        tags: { feature: 'staffing-confirmation', channel: 'sms' },
        extra: { proposalId, shiftId },
      });
    }
  }
}

module.exports = {
  renderBartenderList,
  _resolveDisplayName,
  notifyClientOfStaffingConfirmation,
};
