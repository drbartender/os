const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendSMS, normalizePhone } = require('./sms');
const { getEventTypeLabel } = require('./eventTypes');
const { ADMIN_URL } = require('./urls');
const { notifyAdminCategory } = require('./adminNotifications');
const { esc } = require('./htmlEscape');

/**
 * SMS blast for a ≤72h "staffing hold" booking. Admin gets a verify-staffing
 * alert; every active staffer with a phone gets a "grab it" broadcast.
 * Fully non-blocking — callers wrap in try/catch but this also self-guards.
 * Volume is bounded: ≤72h bookings are exception-only.
 */
async function notifyLastMinuteBooking(proposalId) {
  try {
    const { rows } = await pool.query(`
      SELECT p.id, p.event_date, p.event_start_time, p.event_location,
             p.event_type, p.event_type_custom, c.name AS client_name
      FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1
    `, [proposalId]);
    const p = rows[0];
    if (!p) return;

    const label = getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom });
    const date = p.event_date
      ? new Date(p.event_date).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
      : 'TBD';
    const time = p.event_start_time || 'TBD';
    const loc = p.event_location || 'location TBD';

    // Admin leg: fan out to every admin/manager subscribed to urgent_booking,
    // both email and SMS. No em dashes in the copy.
    try {
      const lmBody = `Last-minute booking: ${label} ${date} ${time}, ${loc}. Verify staffing now. ${ADMIN_URL}/proposals/${p.id}`;
      await notifyAdminCategory({
        category: 'urgent_booking',
        subject: `Last-minute booking: ${label} on ${date}`,
        emailHtml: `<p>${esc(lmBody)}</p>`,
        emailText: lmBody,
        smsBody: lmBody,
      });
    } catch (e) {
      console.error('[lastMinuteAlert] admin notification failed:', e.message);
    }

    // Staff broad net — every approved contractor with a phone. Sequential
    // send (Twilio throttle), same pattern as autoAssign.
    const staff = await pool.query(`
      SELECT cp.phone, cp.preferred_name
      FROM users u
      JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE u.onboarding_status = 'approved' AND cp.phone IS NOT NULL
    `);
    for (const s of staff.rows) {
      const phone = normalizePhone(s.phone);
      if (!phone) continue;
      try {
        await sendSMS({
          to: phone,
          body: `Last-minute gig ${date} ${time}, ${loc} (${label}). Open the app to grab it ASAP — Dr. Bartender`,
        });
      } catch (e) {
        console.error(`[lastMinuteAlert] staff SMS failed (${phone}):`, e.message);
      }
    }
  } catch (err) {
    console.error('[lastMinuteAlert] failed:', err.message);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { feature: 'last-minute-alert', proposalId } });
    }
  }
}

module.exports = { notifyLastMinuteBooking };
