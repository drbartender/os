const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { publicLimiter } = require('../../middleware/rateLimiters');
const { sendEmail } = require('../../utils/email');
const emailTemplates = require('../../utils/emailTemplates');
const { ADMIN_URL } = require('../../utils/urls');
const { getEventTypeLabel } = require('../../utils/eventTypes');
const { getBookingWindow } = require('../../utils/bookingWindow');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../../utils/errors');
const { isVenueComplete, composeVenueLocation, validateVenue } = require('../../utils/venueAddress');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Public routes (token-based) ─────────────────────────────────

/** GET /api/proposals/t/:token — fetch proposal by token (public) */
router.get('/t/:token', publicLimiter, asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.token)) {
    throw new NotFoundError('This proposal is no longer available');
  }
  // Public-safe column allowlist — do NOT expose admin_notes, stripe_customer_id,
  // stripe_payment_method_id, client_signature_ip, client_signature_user_agent,
  // created_by, setup_minutes_before, or other internal fields. setup_minutes_before
  // (and any derived setup_time_display) is back-of-house only — clients/leads
  // must never see crew arrival/setup timing. Intentionally absent from both the
  // SELECT list and the res.json() payload below.
  const result = await pool.query(`
    SELECT
      p.id, p.token, p.client_id,
      p.event_date, p.event_start_time, p.event_duration_hours,
      p.event_location, p.event_type, p.event_type_category, p.event_type_custom,
      p.venue_name, p.venue_street, p.venue_city, p.venue_state, p.venue_zip,
      p.guest_count, p.package_id, p.num_bars, p.num_bartenders,
      p.pricing_snapshot, p.total_price, p.status,
      p.amount_paid, p.deposit_amount, p.payment_type, p.autopay_enrolled,
      p.balance_due_date,
      p.client_signed_name, p.client_signed_at, p.client_signature_method,
      p.client_signature_document_version, p.client_signature_data,
      p.view_count, p.last_viewed_at, p.created_at, p.updated_at,
      sp.name AS package_name, sp.slug AS package_slug, sp.category AS package_category,
      sp.includes AS package_includes,
      c.name AS client_name, c.email AS client_email
    FROM proposals p
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.token = $1
  `, [req.params.token]);

  if (!result.rows[0]) throw new NotFoundError('This proposal is no longer available');

  const proposal = result.rows[0];

  // Capture IP for view logging (no third-party geo lookup for privacy)
  const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  const ip = rawIp.replace(/^::ffff:/, ''); // strip IPv4-mapped prefix

  // Parallelize non-dependent queries: bump view counters + fetch addons + fetch drink plan
  const [, addonsRes, dpRes] = await Promise.all([
    pool.query(
      `UPDATE proposals
         SET view_count = COALESCE(view_count, 0) + 1,
             last_viewed_at = NOW(),
             status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END
       WHERE id = $1`,
      [proposal.id]
    ),
    pool.query(
      'SELECT id, proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant FROM proposal_addons WHERE proposal_id = $1 ORDER BY id',
      [proposal.id]
    ),
    pool.query(
      'SELECT token AS drink_plan_token FROM drink_plans WHERE proposal_id = $1 LIMIT 1',
      [proposal.id]
    ),
  ]);

  // Fire-and-forget activity log so a logging failure doesn't block the response
  pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'viewed', 'client', $2)`,
    [proposal.id, JSON.stringify({ ip: ip || null })]
  ).catch(err => console.error('Proposal view activity log failed:', err));

  const drinkPlanToken = dpRes.rows[0]?.drink_plan_token || null;

  // Server-computed booking-window policy. The client NEVER re-derives this
  // date math (avoids the ESM/CJS dual-maintenance trap); it only reads these
  // booleans to hide the deposit option and show the cancellation caveat.
  // setup_* fields stay excluded from the public payload (see allowlist note
  // above) — payment_policy carries only lead-time tier info, no crew timing.
  const win = getBookingWindow({
    eventDate: proposal.event_date,
    eventStartTime: proposal.event_start_time,
  });

  res.json({
    ...proposal,
    addons: addonsRes.rows,
    drink_plan_token: drinkPlanToken,
    venue_complete: isVenueComplete(proposal),
    status: proposal.status === 'sent' ? 'viewed' : proposal.status,
    payment_policy: {
      full_payment_required: win.fullPaymentRequired,
      last_minute_hold: win.lastMinuteHold,
      hours_until_event: win.hoursUntilEvent,
    },
  });
}));

const PROPOSAL_DOCUMENT_VERSION = 'event-services-agreement-v2';

/** POST /api/proposals/t/:token/sign — client signs and accepts proposal */
router.post('/t/:token/sign', publicLimiter, asyncHandler(async (req, res) => {
  const { client_signed_name, client_signature_data, client_signature_method,
    venue_name, venue_street, venue_city, venue_state, venue_zip } = req.body;
  const fieldErrors = {};
  if (!client_signed_name) fieldErrors.client_signed_name = 'Please enter your full name';
  if (!client_signature_data) fieldErrors.signature = 'Please sign before accepting';
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError(fieldErrors);
  }
  if (client_signature_method !== 'draw' && client_signature_method !== 'type') {
    throw new ValidationError({ signature: 'Invalid signature method' });
  }

  const lookup = await pool.query(
    `SELECT id, venue_name, venue_street, venue_city, venue_state, venue_zip
       FROM proposals WHERE token = $1`,
    [req.params.token]
  );
  if (!lookup.rows[0]) throw new NotFoundError('This proposal is no longer available');

  // Venue address gate: if the proposal doesn't already have a complete venue
  // address, the client must supply one now (street + city + state required).
  const storedVenue = lookup.rows[0];
  let venueToPersist = null;
  if (!isVenueComplete(storedVenue)) {
    const submitted = { venue_name, venue_street, venue_city, venue_state, venue_zip };
    const venueErrors = validateVenue(submitted, { requireStreet: true, requireCityState: true });
    if (Object.keys(venueErrors).length > 0) throw new ValidationError(venueErrors);
    venueToPersist = submitted;
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
  const userAgent = req.headers['user-agent'] || null;

  // Make the UPDATE itself the gate: WHERE clause re-asserts both that no
  // signature has been recorded yet AND that the status is still in a signable
  // state. This collapses the SELECT-then-UPDATE TOCTOU window so two parallel
  // requests on the same token can't both pass a check and overwrite each other.
  // When venueToPersist is set, also write the structured fields and the
  // recomposed event_location in the same atomic UPDATE. String-coerce values
  // (public endpoint — never trust req.body types).
  const mergedVenue = venueToPersist || storedVenue;
  const composedLocation = composeVenueLocation(mergedVenue);
  const vStr = (x) => String(x ?? '').trim();
  const upd = await pool.query(`
    UPDATE proposals SET
      client_signed_name = $1,
      client_signature_data = $2,
      client_signed_at = NOW(),
      client_signature_method = $3,
      client_signature_ip = $4,
      client_signature_user_agent = $5,
      client_signature_document_version = $6,
      status = 'accepted',
      venue_name  = COALESCE($8, venue_name),
      venue_street = COALESCE($9, venue_street),
      venue_city  = COALESCE($10, venue_city),
      venue_state = COALESCE($11, venue_state),
      venue_zip   = COALESCE($12, venue_zip),
      event_location = COALESCE($13, event_location)
    WHERE id = $7
      AND client_signed_at IS NULL
      AND status NOT IN ('accepted', 'deposit_paid', 'balance_paid', 'confirmed', 'completed', 'cancelled')
    RETURNING id
  `, [
    client_signed_name, client_signature_data, client_signature_method, ip, userAgent,
    PROPOSAL_DOCUMENT_VERSION, lookup.rows[0].id,
    venueToPersist ? (vStr(venue_name) || null) : null,
    venueToPersist ? vStr(venue_street) : null,
    venueToPersist ? vStr(venue_city) : null,
    venueToPersist ? vStr(venue_state) : null,
    venueToPersist ? (vStr(venue_zip) || null) : null,
    venueToPersist ? composedLocation : null,
  ]);
  if (!upd.rows[0]) {
    throw new ConflictError('This proposal has already been accepted', 'ALREADY_ACCEPTED');
  }
  const proposal = { id: lookup.rows[0].id };

  await pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'signed', 'client', $2)`,
    [proposal.id, JSON.stringify({ signed_name: client_signed_name, signature_method: client_signature_method })]
  );

  // Email notifications (non-blocking)
  // Skip sign-only emails when a payment intent is already in-flight for this
  // proposal — the Stripe webhook will send a combined "Signed & Paid" email
  // once the payment succeeds, so we avoid back-to-back sign + payment emails.
  const pendingPayment = await pool.query(
    `SELECT 1 FROM stripe_sessions
     WHERE proposal_id = $1 AND status = 'pending' AND created_at > NOW() - INTERVAL '30 minutes'
     LIMIT 1`,
    [proposal.id]
  );
  if (pendingPayment.rowCount === 0) {
    try {
      const fp = await pool.query(`
        SELECT p.id, p.event_type, p.event_type_custom, c.name AS client_name, c.email AS client_email
        FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1
      `, [proposal.id]);
      const pd = fp.rows[0];
      const eventTypeLabel = getEventTypeLabel({ event_type: pd?.event_type, event_type_custom: pd?.event_type_custom });
      if (pd?.client_email) {
        const tpl = emailTemplates.proposalSignedConfirmation({ clientName: pd.client_name, eventTypeLabel });
        await sendEmail({ to: pd.client_email, ...tpl });
      }
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail && pd) {
        const adminUrl = `${ADMIN_URL}/proposals/${pd.id}`;
        const tpl = emailTemplates.clientSignedAdmin({ clientName: pd.client_name, eventTypeLabel, proposalId: pd.id, adminUrl });
        await sendEmail({ to: adminEmail, ...tpl });
      }
    } catch (emailErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(emailErr, { tags: { route: 'proposals/sign', issue: 'email' } });
      }
      console.error('Proposal sign emails failed (non-blocking):', emailErr);
    }
  }

  res.json({ success: true, status: 'accepted' });
}));

module.exports = router;
