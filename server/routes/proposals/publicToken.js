const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { publicLimiter, signLimiter } = require('../../middleware/rateLimiters');
const { sendEmail } = require('../../utils/email');
const emailTemplates = require('../../utils/emailTemplates');
const { notifyAdminCategory } = require('../../utils/adminNotifications');
const { ADMIN_URL } = require('../../utils/urls');
const { getEventTypeLabel } = require('../../utils/eventTypes');
const { getBookingWindow } = require('../../utils/bookingWindow');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../../utils/errors');
const { isVenueComplete, composeVenueLocation, validateVenue } = require('../../utils/venueAddress');
const { KNOWN_AGREEMENT_VERSIONS, LEGACY_AGREEMENT_VERSION } = require('../../utils/agreementVersions');
const { findThumbtackProxyLead } = require('../../utils/smsInbound');
const { validatePhone } = require('../../utils/phone');

const router = express.Router();

const { UUID_RE } = require('../../utils/tokens');

// Reject malformed tokens before ANY downstream work — placed ahead of
// signLimiter on /sign so a junk token can't consume the per-IP signing bucket
// (and never reaches the DB). Synchronous: routes errors via next().
function requireUuidToken(req, res, next) {
  if (!UUID_RE.test(req.params.token)) {
    return next(new NotFoundError('This proposal is no longer available'));
  }
  next();
}

// ─── Public routes (token-based) ─────────────────────────────────

/** GET /api/proposals/t/:token/resolve — NON-mutating. Tells the client whether
 *  this proposal is one option in a comparison group, and whether the group is
 *  already decided, so ProposalView can redirect to /compare/:token WITHOUT
 *  bumping view_count or flipping sent->viewed (which the full GET below does —
 *  merely landing on a link that will be bounced must not inflate that option's
 *  engagement). */
router.get('/t/:token/resolve', publicLimiter, requireUuidToken, asyncHandler(async (req, res) => {
  const { rows: [row] } = await pool.query(
    `SELECT p.group_id, g.token AS group_token, g.chosen_proposal_id, cp.token AS chosen_token
       FROM proposals p
       LEFT JOIN proposal_groups g ON g.id = p.group_id
       LEFT JOIN proposals cp ON cp.id = g.chosen_proposal_id
      WHERE p.token = $1`,
    [req.params.token]
  );
  if (!row) throw new NotFoundError('This proposal is no longer available');
  res.json({
    grouped: row.group_id !== null,
    group_token: row.group_token || null,
    decided: row.chosen_proposal_id !== null,
    chosen_token: row.chosen_token || null,
  });
}));

/** GET /api/proposals/t/:token — fetch proposal by token (public) */
router.get('/t/:token', publicLimiter, requireUuidToken, asyncHandler(async (req, res) => {
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
      c.name AS client_name, c.email AS client_email,
      c.phone AS client_phone_raw, c.source AS client_source,
      oi.open_invoice_token
    FROM proposals p
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    LEFT JOIN clients c ON c.id = p.client_id
    -- Oldest still-payable invoice for THIS proposal (client-owned token for the
    -- client's own invoice; no PII widening). Lets ProposalView's paid-state card
    -- link "Pay balance" straight to /invoice/:token.
    LEFT JOIN LATERAL (
      SELECT token AS open_invoice_token
      FROM invoices WHERE proposal_id = p.id AND status IN ('sent','partially_paid')
      ORDER BY created_at ASC LIMIT 1
    ) oi ON true
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
      'SELECT id, proposal_id, addon_id, addon_name, billing_type, rate, quantity::float8 AS quantity, line_total, variant FROM proposal_addons WHERE proposal_id = $1 ORDER BY id',
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

  // Optional-phone prefill (spec 2026-06-11 Component 4). A Thumbtack proxy
  // number must never show in the signing form: blank it so the client is
  // invited to provide a real one. The proxy lookup runs only for
  // thumbtack-sourced clients (a proxy can only live on a row clientDedup
  // created with source 'thumbtack'), keeping the extra query off the common
  // public-page path. Fail closed to blank: never show a proxy.
  let clientPhonePrefill = proposal.client_phone_raw || '';
  if (clientPhonePrefill && proposal.client_source === 'thumbtack') {
    try {
      if (await findThumbtackProxyLead(clientPhonePrefill)) clientPhonePrefill = '';
    } catch (err) {
      console.error('[proposals/public] proxy prefill check failed (blanking):', err.message);
      clientPhonePrefill = '';
    }
  }
  // Strip the internal lookup fields (delete-on-copy, not rest-destructure,
  // so eslint's no-unused-vars stays quiet).
  const publicProposal = { ...proposal };
  delete publicProposal.client_phone_raw;
  delete publicProposal.client_source;

  res.json({
    ...publicProposal,
    addons: addonsRes.rows,
    drink_plan_token: drinkPlanToken,
    venue_complete: isVenueComplete(proposal),
    client_phone_prefill: clientPhonePrefill,
    status: proposal.status === 'sent' ? 'viewed' : proposal.status,
    payment_policy: {
      full_payment_required: win.fullPaymentRequired,
      last_minute_hold: win.lastMinuteHold,
      hours_until_event: win.hoursUntilEvent,
    },
  });
}));

/** POST /api/proposals/t/:token/sign — client signs and accepts proposal */
router.post('/t/:token/sign', requireUuidToken, signLimiter, asyncHandler(async (req, res) => {
  const { client_signed_name, client_signature_data, client_signature_method,
    venue_name, venue_street, venue_city, venue_state, venue_zip } = req.body;
  const fieldErrors = {};
  if (!client_signed_name) fieldErrors.client_signed_name = 'Please enter your full name';
  if (!client_signature_data) fieldErrors.signature = 'Please sign before accepting';
  // Optional real-number capture (spec 2026-06-11 Component 4). validatePhone
  // is the save-time helper (10-digit storage), NOT sms.js#normalizePhone
  // (send-time E.164). Empty input is valid and never overwrites.
  const phoneCheck = validatePhone(req.body.client_phone);
  if (phoneCheck.error) fieldErrors.client_phone = phoneCheck.error;
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError(fieldErrors);
  }
  if (client_signature_method !== 'draw' && client_signature_method !== 'type') {
    throw new ValidationError({ signature: 'Invalid signature method' });
  }

  // Version recording (spec section 4.4). The client sends the version it
  // actually rendered; we validate against the allowlist and record exactly that
  // value so the column provably matches what was shown.
  const sentVersion = req.body.document_version;
  let documentVersion;
  if (sentVersion === undefined || sentVersion === null) {
    // A pre-feature cached client OMITS the field entirely AND still renders the
    // abridged v2 text — so v2 is the truthful record. A present-but-empty or
    // otherwise-unknown value is NOT a legitimate omission; it falls through to
    // the reject branch below. Surface a warning so a FUTURE regression (a
    // current client that stops sending the field) is visible, not silent.
    documentVersion = LEGACY_AGREEMENT_VERSION;
    console.warn('[proposals/sign] document_version missing; recorded legacy v2', {
      tokenTail: String(req.params.token).slice(-6),
    });
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage('proposal sign POST missing document_version', {
        level: 'warning',
        tags: { route: 'proposals/sign', issue: 'missing_document_version' },
      });
    }
  } else if (typeof sentVersion === 'string' && KNOWN_AGREEMENT_VERSIONS.includes(sentVersion)) {
    documentVersion = sentVersion;
  } else {
    // Tampering, an unknown value, or an empty string — never record a version
    // we can't account for.
    throw new ValidationError({ document_version: 'Please refresh the page and try again.' });
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
      -- Stamp acceptance time so the financial dashboard (metricsQueries filters
      -- accepted_at IS NOT NULL) counts public sign-and-pay bookings. COALESCE so
      -- a re-sign never moves the original acceptance timestamp.
      accepted_at = COALESCE(accepted_at, NOW()),
      venue_name  = COALESCE($8, venue_name),
      venue_street = COALESCE($9, venue_street),
      venue_city  = COALESCE($10, venue_city),
      venue_state = COALESCE($11, venue_state),
      venue_zip   = COALESCE($12, venue_zip),
      event_location = COALESCE($13, event_location)
    WHERE id = $7
      AND client_signed_at IS NULL
      AND status NOT IN ('accepted', 'deposit_paid', 'balance_paid', 'confirmed', 'completed', 'archived')
    RETURNING id
  `, [
    client_signed_name, client_signature_data, client_signature_method, ip, userAgent,
    documentVersion, lookup.rows[0].id,
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

  // Phone write is gated on the sign UPDATE having returned a row (the
  // client_signed_at IS NULL TOCTOU gate above): a replayed sign POST that hit
  // ALREADY_ACCEPTED never reaches this point, so a leaked token cannot mutate
  // the phone after acceptance. Best-effort: a phone-write failure must never
  // 500 a successful signature. phone_status resets to 'ok' whenever the client
  // confirms a number, even an unchanged one: a stale 'bad' verdict (earned by
  // the old proxy or a transient delivery failure) must not mute a number the
  // client just vouched for (channelFallback suppresses all automated SMS on
  // phone_status 'bad').
  let phoneUpdated = false;
  if (phoneCheck.value) {
    try {
      const pu = await pool.query(
        `UPDATE clients SET phone = $1, phone_status = 'ok'
          WHERE id = (SELECT client_id FROM proposals WHERE id = $2)
            AND (phone IS DISTINCT FROM $1 OR phone_status IS DISTINCT FROM 'ok')`,
        [phoneCheck.value, proposal.id]
      );
      phoneUpdated = pu.rowCount > 0;
    } catch (phoneErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(phoneErr, { tags: { route: 'proposals/sign', issue: 'phone_capture' } });
      }
      console.error('Sign-time phone capture failed (non-blocking):', phoneErr.message);
    }
  }

  await pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'signed', 'client', $2)`,
    [proposal.id, JSON.stringify({ signed_name: client_signed_name, signature_method: client_signature_method, phone_updated: phoneUpdated })]
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
      if (pd) {
        const adminUrl = `${ADMIN_URL}/proposals/${pd.id}`;
        const tpl = emailTemplates.clientSignedAdmin({ clientName: pd.client_name, eventTypeLabel, proposalId: pd.id, adminUrl });
        await notifyAdminCategory({
          category: 'urgent_booking',
          subject: tpl.subject,
          emailHtml: tpl.html,
          emailText: tpl.text,
        });
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
