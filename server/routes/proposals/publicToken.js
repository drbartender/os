const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { signLimiter, proposalCheckoutLimiter, proposalPollLimiter, publicTokenIpLimiter } = require('../../middleware/rateLimiters');
const { sendEmail } = require('../../utils/email');
const emailTemplates = require('../../utils/emailTemplates');
const { notifyAdminCategory } = require('../../utils/adminNotifications');
const { ADMIN_URL } = require('../../utils/urls');
const { getEventTypeLabel } = require('../../utils/eventTypes');
const { getBookingWindow } = require('../../utils/bookingWindow');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../../utils/errors');
const { isVenueComplete, composeVenueLocation, validateVenue, normalizeVenueState } = require('../../utils/venueAddress');
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
router.get('/t/:token/resolve', requireUuidToken, publicTokenIpLimiter, proposalCheckoutLimiter, asyncHandler(async (req, res) => {
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

/** GET /api/proposals/t/:token/payment-state — NON-mutating. The poll target
 *  for the post-checkout settle state (spec 2026-08-28 §3c). Returns only the
 *  row's payment state, in dollars, and touches NOTHING: no view_count bump,
 *  no last_viewed_at, no sent->viewed flip, no activity row. The full GET does
 *  all four on every call, and a thirteen-attempt poll against it would record
 *  thirteen views of a page the client is staring at once. 404 on archived is
 *  stated here on its own; /resolve above is deliberately status-blind. */
router.get('/t/:token/payment-state', requireUuidToken, publicTokenIpLimiter, proposalPollLimiter, asyncHandler(async (req, res) => {
  const { rows: [row] } = await pool.query(
    `SELECT status, amount_paid, total_price, payment_type
       FROM proposals
      WHERE token = $1 AND status <> 'archived'`,
    [req.params.token]
  );
  if (!row) throw new NotFoundError('This proposal is no longer available');
  res.json({
    status: row.status,
    amount_paid: Number(row.amount_paid || 0),
    total_price: Number(row.total_price || 0),
    payment_type: row.payment_type || null,
  });
}));

/** GET /api/proposals/t/:token — fetch proposal by token (public) */
/** The COMPLETE public payload for one proposal, shared by the GET below and
 *  the switch endpoint's 200 response (publicSwitch.js) so the two can never
 *  drift: everything ProposalView renders from is built here, and ONLY the
 *  public-safe shape ever leaves this function. Side effects (the view-count
 *  bump, activity logging) deliberately live with the GET, not here.
 *  Returns null when the token matches nothing. */
async function buildPublicProposalPayload(token, db = pool) {
  // Public-safe column allowlist — do NOT expose admin_notes, stripe_customer_id,
  // stripe_payment_method_id, client_signature_ip, client_signature_user_agent,
  // created_by, setup_minutes_before, or other internal fields. setup_minutes_before
  // (and any derived setup_time_display) is back-of-house only — clients/leads
  // must never see crew arrival/setup timing. Intentionally absent from both the
  // SELECT list and the returned payload below.
  const result = await db.query(`
    SELECT
      p.id, p.token, p.client_id,
      p.event_date, p.event_start_time, p.event_duration_hours,
      p.event_location, p.event_type, p.event_type_category, p.event_type_custom,
      p.venue_name, p.venue_street, p.venue_city, p.venue_state, p.venue_zip,
      p.guest_count, p.package_id, p.num_bars, p.num_bartenders,
      p.pricing_snapshot, p.total_price, p.status,
      p.total_price_override, p.group_id,
      p.amount_paid, p.deposit_amount, p.payment_type, p.autopay_enrolled,
      p.balance_due_date,
      p.client_signed_name, p.client_signed_at, p.client_signature_method,
      p.client_signature_document_version, p.client_signature_data,
      p.view_count, p.last_viewed_at, p.created_at, p.updated_at,
      sp.name AS package_name, sp.slug AS package_slug, sp.category AS package_category,
      sp.includes AS package_includes,
      c.name AS client_name, c.email AS client_email,
      c.phone AS client_phone_raw, c.source AS client_source,
      oi.open_invoice_token,
      -- options_available inputs, folded in rather than fetched separately:
      -- this is the public page's critical path, and these were two extra
      -- serial round trips on every load. Both are strip-before-return.
      pg.chosen_proposal_id AS group_chosen_proposal_id,
      (SELECT COUNT(*) FROM service_packages
        WHERE (is_active = true AND bar_type IS DISTINCT FROM 'class') OR id = p.package_id
      ) AS comparable_pkg_count
    FROM proposals p
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN proposal_groups pg ON pg.id = p.group_id
    -- Oldest still-payable invoice for THIS proposal (client-owned token for the
    -- client's own invoice; no PII widening). Lets ProposalView's paid-state card
    -- link "Pay balance" straight to /invoice/:token.
    LEFT JOIN LATERAL (
      SELECT token AS open_invoice_token
      FROM invoices WHERE proposal_id = p.id AND status IN ('sent','partially_paid')
      ORDER BY created_at ASC LIMIT 1
    ) oi ON true
    WHERE p.token = $1
      -- An archived proposal is NOT REACHABLE by its own token, deliberately.
      -- Without this the page rendered its full live layout — Sign & Pay and
      -- all — for a booking that no longer exists, and signing then returned a
      -- misleading "already been accepted" 409. The stale-proposal sweep turned
      -- that from a manual-archive edge into ~160 live tokens at once.
      -- This mirrors the voided-invoice precedent exactly (routes/invoices.js
      -- puts AND i.status != 'void' on its own public token lookup): the row
      -- simply is not found, and the client gets the ordinary not-found page rather
      -- than a bespoke surface. Dallas, 2026-08-24: an event_passed quote
      -- expired because the event happened without us, so there is nothing to
      -- offer that client and no re-quote page to build.
      -- The switch endpoint shares this function and is unaffected: it mutates
      -- the proposal in place and never writes 'archived'.
      --
      -- DO NOT copy this filter up to /t/:token/resolve. That endpoint is
      -- deliberately status-blind, and it is what makes the GROUPED
      -- option-group case correct: commitGroupChoice archives the losing
      -- siblings 'option_not_chosen' and sets chosen_proposal_id in the same
      -- transaction, so resolve reports decided + a chosen_token and
      -- ProposalView redirects to the option the client actually chose. That
      -- runs BEFORE this payload, so a GROUPED loser is redirected rather than
      -- 404'd. Filtering resolve would strand exactly those clients.
      --
      -- Scoped deliberately, because the obvious wider claim is FALSE:
      -- 'option_not_chosen' has a SECOND producer, sweepClientAlternatives
      -- (proposalGroupCommit.js), which archives a client's other open unpaid
      -- proposals on first payment selected by client_id alone, with NO
      -- group_id predicate. Those carry group_id NULL, so resolve reports
      -- grouped:false / decided:false, no redirect fires, and they DO land on
      -- the not-found page. That is correct — a quote the client did not take
      -- should close — but do not read the paragraph above as covering them.
      -- Prod at 2026-08-25: 7 grouped, 3 ungrouped. Pinned by
      -- publicToken.archived.test.js.
      AND p.status <> 'archived'
  `, [token]);

  if (!result.rows[0]) return null;

  const proposal = result.rows[0];

  // Parallelize the non-dependent fetches: addons + drink plan
  const [addonsRes, dpRes] = await Promise.all([
    db.query(
      'SELECT id, proposal_id, addon_id, addon_name, billing_type, rate, quantity::float8 AS quantity, line_total, variant FROM proposal_addons WHERE proposal_id = $1 ORDER BY id',
      [proposal.id]
    ),
    db.query(
      'SELECT token AS drink_plan_token FROM drink_plans WHERE proposal_id = $1 LIMIT 1',
      [proposal.id]
    ),
  ]);

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
  // Whether the "See other packages" entry link has anywhere to go (spec
  // 2026-08-14). A cheap predicate, NOT an engine run: the same states the
  // switch endpoint refuses, plus a catalog count proving a comparison exists.
  // False for draft/modified (the quote's blacklist admits them, but the
  // switch's whitelist does not, and a link into a refusal is the apology
  // state this flag exists to prevent) and for grouped-undecided proposals
  // (the compare page owns that client; a switch would corrupt the set).
  const optionsAvailable = ['sent', 'viewed'].includes(proposal.status)
    && proposal.total_price_override === null
    && !proposal.client_signed_at
    // Grouped-and-undecided belongs to the compare page; a decided group
    // behaves like any other proposal. A group_id pointing at nothing fails
    // closed (the LEFT JOIN yields NULL).
    && (proposal.group_id === null || proposal.group_chosen_proposal_id !== null)
    // Money already on the row refuses at the switch (SWITCH_NOT_AVAILABLE),
    // so without this the flag renders the entry card into a guaranteed
    // apology. "Paid is unreachable on sent/viewed" is NOT airtight: a forced
    // status rewind and an external_paid import both leave money on a sent row,
    // which is the same class publicSwitch's own reconcile guard exists for.
    && Number(proposal.amount_paid || 0) === 0
    && Number(proposal.comparable_pkg_count) >= 2;

  // Strip the internal lookup fields (delete-on-copy, not rest-destructure,
  // so eslint's no-unused-vars stays quiet). The two gate columns selected for
  // the flag above must never leak to a token holder.
  const publicProposal = { ...proposal };
  delete publicProposal.client_phone_raw;
  delete publicProposal.client_source;
  delete publicProposal.total_price_override;
  delete publicProposal.group_id;
  delete publicProposal.group_chosen_proposal_id;
  delete publicProposal.comparable_pkg_count;

  return {
    options_available: optionsAvailable,
    ...publicProposal,
    addons: addonsRes.rows,
    drink_plan_token: drinkPlanToken,
    venue_complete: isVenueComplete(proposal),
    client_phone_prefill: clientPhonePrefill,
    // Display flip. The GET's own side effect flips the row sent->viewed, so
    // for that caller this matches the row. The switch endpoint reuses this
    // builder WITHOUT bumping, so a switch on a still-'sent' row reports
    // 'viewed' before the row says so. Harmless (the drawer is only reachable
    // after a GET, which already flipped it, and both values are switchable),
    // but the flip is a display convention here, not a row guarantee.
    status: proposal.status === 'sent' ? 'viewed' : proposal.status,
    payment_policy: {
      full_payment_required: win.fullPaymentRequired,
      last_minute_hold: win.lastMinuteHold,
      hours_until_event: win.hoursUntilEvent,
    },
  };
}

router.get('/t/:token', requireUuidToken, publicTokenIpLimiter, proposalCheckoutLimiter, asyncHandler(async (req, res) => {
  // Capture IP for view logging (no third-party geo lookup for privacy)
  const rawIp = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || '';
  const ip = rawIp.replace(/^::ffff:/, ''); // strip IPv4-mapped prefix

  // Side effects live HERE, not in the builder. The bump is keyed on TOKEN
  // rather than id so it does not depend on the builder's SELECT and can run
  // in the same wave, which is how it behaved before the extraction. A race
  // where the builder reads the already-bumped row is immaterial: the payload
  // coerces 'sent' to 'viewed' anyway and both are switchable. An unknown
  // token makes the UPDATE a harmless no-op and the builder returns null.
  //
  // THREE cases now, not two: the archived one is why this carries the same
  // status predicate as the builder. Without it a request that 404s still
  // bumps view_count and last_viewed_at, recording a view of a page nobody
  // was shown. The status CASE arm is inert on an archived row either way,
  // so this is engagement-metric honesty rather than a status hazard — but
  // the two predicates must move together, or the bump starts describing
  // rows the payload refuses to serve. (Found by the cross-LLM push review,
  // 2026-08-25.) The activity-log INSERT below needs no guard: it already
  // sits after the null check.
  const [payload] = await Promise.all([
    buildPublicProposalPayload(req.params.token),
    pool.query(
      `UPDATE proposals
         SET view_count = COALESCE(view_count, 0) + 1,
             last_viewed_at = NOW(),
             status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END
       WHERE token = $1 AND status <> 'archived'`,
      [req.params.token]
    ),
  ]);
  if (!payload) throw new NotFoundError('This proposal is no longer available');
  pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'viewed', 'client', $2)`,
    [payload.id, JSON.stringify({ ip: ip || null })]
  ).catch(err => console.error('Proposal view activity log failed:', err));

  res.json(payload);
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

  // req.ip FIRST: express runs behind `trust proxy`, so req.ip is the
  // proxy-validated address while the first x-forwarded-for entry is
  // attacker-supplied. A signature IP is the strongest artifact in a payment
  // dispute, so it must not be the forgeable one. Matches publicSwitch.js.
  const ip = (req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress || null);
  const userAgent = req.headers['user-agent'] || null;

  // Sign-time total assertion (spec 2026-08-14, proposal options drawer). The
  // switch endpoint made pre-signature rewrites a routine event, and this
  // endpoint binds NO configuration: without the assertion, a switch landing
  // between render and sign-click (the client's own second tab, or a leaked
  // token stuffing add-ons onto a total someone else pays) would commit a
  // signature to a configuration the signer never saw. The client echoes the
  // total rendered above the signature; the UPDATE's WHERE re-asserts it
  // (same TOCTOU-collapse as the status guard). REQUIRED since 2026-08-28:
  // the absent-field path existed for a cached bundle mid-flight on
  // 2026-08-14, that population is gone, and publicSwitch.js has required the
  // field since it shipped. A stale bundle gets one "refresh" 400 and works.
  if (req.body.acknowledged_total === undefined || req.body.acknowledged_total === null) {
    throw new ValidationError({ acknowledged_total: 'Please refresh the page and try again.' });
  }
  const ackGiven = true;
  const ackTotal = ackGiven ? Number(req.body.acknowledged_total) : null;
  if (ackGiven && !Number.isFinite(ackTotal)) {
    throw new ValidationError({ acknowledged_total: 'Please refresh the page and try again.' });
  }

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
      AND ($14::numeric IS NULL OR ABS(total_price - $14::numeric) < 0.005)
    RETURNING id
  `, [
    client_signed_name, client_signature_data, client_signature_method, ip, userAgent,
    documentVersion, lookup.rows[0].id,
    venueToPersist ? (vStr(venue_name) || null) : null,
    venueToPersist ? vStr(venue_street) : null,
    venueToPersist ? vStr(venue_city) : null,
    venueToPersist ? normalizeVenueState(vStr(venue_state)) : null,
    venueToPersist ? (vStr(venue_zip) || null) : null,
    venueToPersist ? composedLocation : null,
    ackGiven ? ackTotal : null,
  ]);
  if (!upd.rows[0]) {
    // Disambiguate: a still-signable row can only have failed the total
    // assertion, so tell the client to re-review rather than lying that it
    // was already accepted.
    let code = 'ALREADY_ACCEPTED';
    let message = 'This proposal has already been accepted';
    if (ackGiven) {
      const re = await pool.query(
        'SELECT client_signed_at, status FROM proposals WHERE id = $1',
        [lookup.rows[0].id]
      );
      const r = re.rows[0];
      const stillSignable = r && !r.client_signed_at
        && !['accepted', 'deposit_paid', 'balance_paid', 'confirmed', 'completed', 'archived'].includes(r.status);
      if (stillSignable) {
        code = 'TOTAL_CHANGED';
        message = 'The total for this proposal has changed. Please review the updated price and sign again.';
      }
    }
    // A blocked signature must never be silent (spec 2026-08-28 §3e). For a
    // week in August every gratuity-electing client 409'd here and the only
    // trace was a run of 'viewed' rows from the recovery refetch, which read
    // as engagement. Breadcrumb it as what it is, and page Sentry.
    // Fire-and-forget like the 'viewed' insert: the 409 does not wait on it.
    // The proxy-validated ip rides along so a run of these rows can be told
    // apart as one client retrying versus a leaked token being probed.
    pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'sign_failed', 'client', $2)`,
      [lookup.rows[0].id, JSON.stringify({ code, acknowledged_total: ackGiven ? ackTotal : null, ip })]
    ).catch((err) => console.error('sign_failed activity log failed (non-blocking):', err.message));
    if (process.env.SENTRY_DSN_SERVER) {
      // TOTAL_CHANGED is the state worth paging on; ALREADY_ACCEPTED is a
      // benign double-submit or replay and only needs to be countable.
      Sentry.captureMessage('proposal_sign_failed', {
        level: code === 'TOTAL_CHANGED' ? 'warning' : 'info',
        tags: { route: 'proposals/sign', code, proposal_id: String(lookup.rows[0].id) },
        extra: { acknowledged_total: ackGiven ? ackTotal : null },
      });
    }
    throw new ConflictError(message, code);
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
    [proposal.id, JSON.stringify({ signed_name: client_signed_name, signature_method: client_signature_method, phone_updated: phoneUpdated, acknowledged_total: ackGiven ? ackTotal : null })]
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
// The switch endpoint reuses the builder so its 200 response is shape-identical
// to the GET by construction, never a hand-rebuilt (or raw-row) payload.
module.exports.buildPublicProposalPayload = buildPublicProposalPayload;
