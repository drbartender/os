const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { auth, requireAdminOrManager, adminOnly } = require('../../middleware/auth');
const { calculateProposal, deriveGratuityRate, computeGratuityBasis } = require('../../utils/pricingEngine');
const { reconcileProposalPaymentStatus } = require('../../utils/proposalStatus');
const { createEventShifts, syncShiftsFromProposal } = require('../../utils/eventCreation');
const { composeVenueLocation, validateVenue } = require('../../utils/venueAddress');
const { sendEmail } = require('../../utils/email');
const emailTemplates = require('../../utils/emailTemplates');
const { createInvoiceOnSend, refreshUnlockedInvoices, createAdditionalInvoiceIfNeeded } = require('../../utils/invoiceHelpers');
const { getEventTypeLabel } = require('../../utils/eventTypes');
const { setupTimeDisplay } = require('../../utils/setupTime');
const { validateProposalRules, stripIncludedAddons } = require('../../utils/proposalRules');
const { sendProposalSentEmail } = require('../../utils/sendProposalSentEmail');
const { rescheduleProposalInTx, sendRescheduleEmail } = require('../../utils/rescheduleProposal');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError, ExternalServiceError } = require('../../utils/errors');
const { PUBLIC_SITE_URL, ADMIN_URL } = require('../../utils/urls');
const { findOrCreateClient } = require('../../utils/clientDedup');

const router = express.Router();

// Dependency seam for tests, shared by POST / and PATCH /:id/status.
// createInvoiceOnSend runs INSIDE each route's transaction; sendProposalSentEmail
// runs AFTER commit. Tests stub these via __setDeps to (a) assert the email
// fires exactly once per send and (b) force createInvoiceOnSend to throw and
// verify the txn rolls back.
let _deps = { createInvoiceOnSend, sendProposalSentEmail };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

// Coerce a client-supplied addon quantity into a bounded positive integer.
// Mirrors public.js safeAddonQty — untrusted body input (admin cockpit), so a
// negative/fractional/NaN/non-scalar value must not flow into pricing money
// math. Cap at 20 to bound any single addon line.
const MAX_ADDON_QTY = 20;
function safeAddonQty(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return 1;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_ADDON_QTY, n);
}

const TOTAL_PRICE_OVERRIDE_MAX = 1_000_000;

// ─── Admin CRUD ──────────────────────────────────────────────────

/** GET /api/proposals — list all proposals. Explicit column list — do NOT ship
 *  pricing_snapshot / admin_notes / questionnaire_data / signature_data / stripe_*
 *  to list responses (blobs, PII, can each be 10-50 KB × 50 rows = 2.5 MB). */
router.get('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { status, view = 'active', search, page = 1, limit = 50 } = req.query;
  let query = `
    SELECT p.id, p.token, p.client_id, p.event_type, p.event_type_custom,
           p.event_type_category, p.event_date, p.event_start_time,
           p.event_duration_hours, p.event_location, p.guest_count, p.num_bars,
           p.num_bartenders, p.package_id, p.status, p.total_price, p.amount_paid,
           p.deposit_amount, p.balance_due_date, p.payment_type, p.autopay_enrolled,
           p.sent_at, p.accepted_at, p.client_signed_at, p.last_viewed_at,
           p.created_at, p.updated_at, p.cc_id AS proposal_cc_id,
           c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
           c.cc_id AS client_cc_id,
           sp.name AS package_name, sp.slug AS package_slug
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    WHERE 1=1
  `;
  const params = [];

  // An explicit `status` param overrides `view` — used by drill-downs that
  // pin a specific status. Otherwise `view` selects a status bucket so paid
  // proposals (which "graduate" to the Events tab) are still discoverable
  // here under the Paid tab without requiring callers to enumerate statuses.
  if (status) {
    params.push(status);
    query += ` AND p.status = $${params.length}`;
  } else if (view === 'paid') {
    query += ` AND p.status IN ('deposit_paid', 'balance_paid', 'confirmed', 'completed')`;
  } else if (view === 'archive') {
    query += ` AND p.status = 'archived'`;
  } else if (view === 'all') {
    query += ` AND p.status != 'archived'`;
  } else {
    // Default 'active' bucket — exclude paid (moved to Events) and archived.
    query += ` AND p.status NOT IN ('deposit_paid', 'balance_paid', 'confirmed', 'completed', 'archived')`;
  }
  if (search) {
    params.push(`%${search}%`);
    query += ` AND (c.name ILIKE $${params.length} OR c.email ILIKE $${params.length})`;
  }

  query += ' ORDER BY p.created_at DESC';
  params.push(Number(limit));
  query += ` LIMIT $${params.length}`;
  params.push((Number(page) - 1) * Number(limit));
  query += ` OFFSET $${params.length}`;

  const result = await pool.query(query, params);
  res.json(result.rows);
}));

/** POST /api/proposals — create a new proposal.
 *  send_now decides status and is fail-safe: ONLY an explicit `send_now: true`
 *  → 'sent' (creates the first invoice inside the txn + emails the client after
 *  commit). Omitted / false / null → 'draft'. A Top Shelf class request always
 *  lands as a draft regardless of send_now — pricing is TBD, so no invoice and
 *  no client email. */
router.post('/', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const {
    client_id, client_name, client_email, client_phone, client_source,
    event_date, event_start_time, event_duration_hours,
    event_location, guest_count, package_id, num_bars, num_bartenders, addon_ids,
    addon_variants, addon_quantities, syrup_selections, class_options, client_provides_glassware,
    send_now, event_type, event_type_category, event_type_custom,
    venue_name, venue_street, venue_city, venue_state, venue_zip,
  } = req.body;

  const fieldErrors = {};
  if (!package_id) fieldErrors.package_id = 'Package is required';
  if (!client_id && !client_name) fieldErrors.client_name = 'Client name is required';
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError(fieldErrors);
  }

  // Venue is optional at create-time (admin may add the address later via edit).
  // Validate only the shape — match PATCH's requireStreet:false, requireCityState:false.
  const venueErrors = validateVenue(
    { venue_name, venue_street, venue_city, venue_state, venue_zip },
    { requireStreet: false, requireCityState: false }
  );
  if (Object.keys(venueErrors).length > 0) throw new ValidationError(venueErrors);
  // Compose event_location from the structured fields (source of truth). Fall back
  // to the legacy single-string event_location for callers that still send it.
  const composedLocation = composeVenueLocation({
    venue_name, venue_street, venue_city, venue_state, venue_zip,
  }) || event_location || null;

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // Create or use existing client
    let finalClientId = client_id;
    if (!finalClientId && client_name) {
      // Dedupes on email OR phone (backfill-only, never overwrites) — see clientDedup.js.
      finalClientId = await findOrCreateClient(dbClient, {
        name: client_name, email: client_email, phone: client_phone, source: client_source || 'direct',
      });
    }

    // Fetch package
    const pkgResult = await dbClient.query('SELECT * FROM service_packages WHERE id = $1', [package_id]);
    if (!pkgResult.rows[0]) {
      throw new ValidationError({ package_id: 'Package not found' });
    }
    const pkg = pkgResult.rows[0];

    // Fetch the FULL active add-on set once — needed both for the validator
    // (requires_addon_slug parent lookups, bundle detection) and for the
    // bundle-strip below.
    const allAddonsResult = await dbClient.query(
      'SELECT * FROM service_addons WHERE is_active = true'
    );
    const allActiveAddons = allAddonsResult.rows;

    // Strip bundle-covered add-ons SERVER-SIDE. The wizard client strips before
    // submit, but a stale tab or scripted POST may not — without this, e.g.
    // the-formula + signature-mixers-only both get priced even though Formula
    // already includes signature mixers (double-charge).
    const strippedIds = stripIncludedAddons(addon_ids || [], allActiveAddons);
    const selectedAddons = allActiveAddons
      .filter(a => strippedIds.includes(a.id))
      .map(a => ({
        ...a,
        variant: addon_variants?.[String(a.id)] || null,
        quantity: safeAddonQty(addon_quantities?.[String(a.id)]),
      }));

    // Calculate pricing inputs
    const gc = guest_count || 50;
    const dh = event_duration_hours || 4;
    const nb = num_bars ?? 1;

    // Top Shelf is a class-only flow: a draft with no pricing that the admin
    // prices later. Reject any attempt to flag Top Shelf against a non-class
    // package — otherwise a scripted POST could mint $0 drafts for premium
    // packages.
    const isTopShelfClass =
      pkg.bar_type === 'class'
      && !!class_options && class_options.top_shelf_requested === true;

    if (class_options && class_options.top_shelf_requested === true
        && pkg.bar_type !== 'class') {
      throw new ValidationError({ class_options: 'Top Shelf is only valid for class packages' });
    }

    // Authoritative rule gate — re-checks every rule the wizard UI enforces
    // (a stale tab / scripted POST bypasses the client). Skipped for Top Shelf
    // (no pricing inputs yet). A thrown ValidationError triggers the catch →
    // ROLLBACK below; harmless since only SELECTs have run so far.
    if (!isTopShelfClass) {
      validateProposalRules({
        pkg,
        guestCount: gc,
        addonIds: strippedIds,
        addons: allActiveAddons,
        clientProvidesGlassware: !!client_provides_glassware,
      });
    }

    // Normalize class_options — only persist recognized keys, only for class
    // bookings. Mirrors public.js cleanClassOptions: spirit_category is
    // allowlisted, top_shelf_requested coerced to a strict boolean. The raw
    // request body is never persisted.
    const isClassBooking = pkg.bar_type === 'class';
    const cleanClassOptions = isClassBooking && class_options && typeof class_options === 'object'
      ? {
          spirit_category: ['whiskey_bourbon', 'tequila_mezcal'].includes(class_options.spirit_category)
            ? class_options.spirit_category : null,
          top_shelf_requested: class_options.top_shelf_requested === true,
        }
      : null;

    // Status branch — send_now is fail-safe: ONLY an explicit `send_now: true`
    // triggers the send path. Omitted / false / null all create a 'draft', so
    // an un-flagged caller never silently mints a 'sent' proposal with an
    // invoice + client email. Top Shelf always forces 'draft' regardless
    // (pricing TBD: no invoice, no client email).
    const sendNow = send_now === true;
    const proposalStatus = (sendNow && !isTopShelfClass) ? 'sent' : 'draft';

    // Snapshot — skipped for Top Shelf (pricing TBD; admin prices later).
    const snapshot = isTopShelfClass
      ? null
      : calculateProposal({
          pkg,
          guestCount: gc,
          durationHours: dh,
          numBars: nb,
          numBartenders: num_bartenders,
          addons: selectedAddons,
          syrupSelections: syrup_selections || [],
          gratuityRate: 0, tipJar: true,
        });
    const snapshotJson = snapshot ? JSON.stringify(snapshot) : '{}';
    const totalPrice = snapshot ? snapshot.total : 0;
    const numBartenders = snapshot ? snapshot.staffing.actual : 1;
    const sentAt = proposalStatus === 'sent' ? new Date() : null;

    // Insert proposal
    const proposalResult = await dbClient.query(`
      INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
        event_location, guest_count, package_id, num_bars, num_bartenders, pricing_snapshot, total_price, created_by,
        status, sent_at, class_options, client_provides_glassware,
        event_type, event_type_category, event_type_custom,
        venue_name, venue_street, venue_city, venue_state, venue_zip)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      RETURNING *
    `, [
      finalClientId, event_date || null, event_start_time || null, dh,
      composedLocation, gc, package_id, nb,
      numBartenders, snapshotJson, totalPrice, req.user.id,
      proposalStatus, sentAt, cleanClassOptions ? JSON.stringify(cleanClassOptions) : null,
      !!client_provides_glassware,
      event_type || null, event_type_category || null, event_type_custom || null,
      venue_name || null, venue_street || null, venue_city || null,
      venue_state || null, venue_zip || null,
    ]);

    const proposal = proposalResult.rows[0];

    // Insert proposal add-ons — single bulk INSERT
    if (snapshot && snapshot.addons.length) {
      const placeholders = snapshot.addons.map((_, i) => {
        const b = i * 8;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`;
      }).join(',');
      const values = snapshot.addons.flatMap(a =>
        [proposal.id, a.id, a.name, a.billing_type, a.rate, a.quantity, a.line_total, a.variant || null]
      );
      await dbClient.query(
        `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant) VALUES ${placeholders}`,
        values
      );
    }

    // Log creation
    const logDetails = snapshot
      ? { total: snapshot.total, package: snapshot.package.name }
      : { top_shelf_requested: true, package: pkg.name, spirit_category: cleanClassOptions?.spirit_category || null };
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, 'created', 'admin', $2, $3)`,
      [proposal.id, req.user.id, JSON.stringify(logDetails)]
    );

    // Auto-create the first invoice when the proposal is sent. Runs INSIDE this
    // transaction (unlike PATCH /:id/status, where the proposal already exists)
    // so a proposal is never committed in the 'sent' state without its invoice.
    // If invoice creation throws, the catch below rolls back the whole insert.
    if (proposalStatus === 'sent') {
      await _deps.createInvoiceOnSend(proposal.id, dbClient);
    }

    await dbClient.query('COMMIT');

    // Email the client AFTER commit — best-effort. The bare INSERT ... RETURNING
    // row has no client_email / client_name (those live on `clients`, not
    // `proposals`), and sendProposalSentEmail early-returns without an email —
    // so we must re-fetch joined to `clients` first. Wrapped in its own
    // try/catch: this runs post-COMMIT, so a failed SELECT here must never 500
    // a request whose proposal + invoice are already durably committed (admin
    // resends from the detail page). Mirrors the clients-JOIN email step in
    // PATCH /:id/status.
    if (proposalStatus === 'sent') {
      try {
        const enriched = await pool.query(
          `SELECT p.*, c.id AS client_id, c.name AS client_name, c.email AS client_email,
                  c.phone AS client_phone, c.communication_preferences,
                  c.email_status, c.phone_status, c.cc_id AS client_cc_id
             FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
            WHERE p.id = $1`, [proposal.id]);
        if (enriched.rows[0]) {
          await _deps.sendProposalSentEmail(enriched.rows[0], { actorType: 'admin' });
        }
      } catch (e) {
        console.error('Post-send email step failed (non-blocking) for proposal', proposal.id);
      }
    }

    // Plan 2d: enroll the unsigned-proposal drip for a born-sent proposal.
    if (proposalStatus === 'sent') {
      try {
        const { scheduleDripForProposal } = require('../../utils/marketingHandlers');
        await scheduleDripForProposal(proposal.id);
      } catch (dripErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(dripErr, { tags: { route: 'proposals/create', issue: 'drip-enroll' } });
        }
        console.error('Drip enrollment failed (non-blocking):', dripErr);
      }
    }

    res.status(201).json(proposal);
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err;
  } finally {
    dbClient.release();
  }
}));

/** GET /api/proposals/:id — get single proposal */
router.get('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT p.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone, c.source AS client_source,
           c.cc_id AS client_cc_id,
           sp.name AS package_name, sp.slug AS package_slug, sp.category AS package_category, sp.includes AS package_includes,
           u.email AS created_by_email, u.cc_id AS user_cc_id
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    LEFT JOIN users u ON u.id = p.created_by
    WHERE p.id = $1
  `, [req.params.id]);

  if (!result.rows[0]) throw new NotFoundError('Proposal not found');

  // Fetch addons + activity log in parallel — both depend only on proposal id.
  // Cap activity log fetch at 100 entries (most recent) — an old proposal can
  // accumulate hundreds of view/update entries otherwise.
  const [addons, activity] = await Promise.all([
    pool.query(
      'SELECT * FROM proposal_addons WHERE proposal_id = $1 ORDER BY id',
      [req.params.id]
    ),
    pool.query(
      'SELECT * FROM proposal_activity_log WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.params.id]
    ),
  ]);

  // setup_time_display: server-derived clock time (service start − effective
  // minutes) for back-of-house display. Raw setup_minutes_before already flows
  // via SELECT p.* (NULL until an admin overrides; null display when unparseable
  // start time). Back-of-house only — never added to the public token response.
  const row = result.rows[0];
  res.json({
    ...row,
    setup_time_display: setupTimeDisplay(row),
    addons: addons.rows,
    activity: activity.rows,
  });
}));

/** GET /api/proposals/:id/legacy-cc-payments — admin-only fetch of
 *  Check-Cherry-imported payment rows for this proposal (those with a
 *  non-null `legacy_charge_id`, i.e. a Stripe charge ID like `ch_...`).
 *  Drives the LegacyCcPaymentsPanel which warns the operator that the
 *  built-in Refund button cannot reach these payments and a manual
 *  Stripe-dashboard refund is required (spec §11). */
router.get('/:id/legacy-cc-payments', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new ValidationError(undefined, 'id must be an integer');
  const { rows } = await pool.query(
    `SELECT id, amount, payment_method, legacy_charge_id, created_at
       FROM proposal_payments
      WHERE proposal_id = $1 AND legacy_charge_id IS NOT NULL
      ORDER BY created_at ASC`,
    [id]
  );
  res.json({ payments: rows });
}));

/** PATCH /api/proposals/:id — update event details and recalculate */
router.patch('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const {
    event_date, event_start_time, event_duration_hours,
    event_location, guest_count, package_id, num_bars, num_bartenders, addon_ids,
    addon_variants, addon_quantities, syrup_selections, event_type, event_type_category, event_type_custom,
    venue_name, venue_street, venue_city, venue_state, venue_zip,
    adjustments, total_price_override, setup_minutes_before,
    class_options, client_provides_glassware,
    tip_jar, gratuity_total,
    notify_assigned_staff, notify_staff_sms, notify_staff_email
  } = req.body;

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // FOR UPDATE: lock the row for the duration of the edit tx so two concurrent
    // PATCHes (or a webhook) can't lose-update gratuity_rate/tip_jar/status and so
    // the reconcile + overpayment checks below read a consistent amount_paid.
    const existing = await dbClient.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!existing.rows[0]) {
      throw new NotFoundError('Proposal not found');
    }
    const old = existing.rows[0];

    // Hoisted so the post-COMMIT reschedule-email block (outside this inner
    // try) can read whether the in-tx re-anchor decided an email is warranted.
    let shouldSendRescheduleEmail = false;
    // Hoisted for the post-COMMIT gratuity staffing-change email (§7).
    let notifyStaffingGratuity = false;

    const venueProvided = [venue_name, venue_street, venue_city, venue_state, venue_zip]
      .some(v => v !== undefined);
    if (venueProvided) {
      const venueErrors = validateVenue(
        { venue_name, venue_street, venue_city, venue_state, venue_zip },
        { requireStreet: false, requireCityState: false }
      );
      if (Object.keys(venueErrors).length > 0) throw new ValidationError(venueErrors);
    }
    const mergedVenue = {
      venue_name:   venue_name   ?? old.venue_name,
      venue_street: venue_street ?? old.venue_street,
      venue_city:   venue_city   ?? old.venue_city,
      venue_state:  venue_state  ?? old.venue_state,
      venue_zip:    venue_zip    ?? old.venue_zip,
    };
    const recomposedLocation = venueProvided
      ? composeVenueLocation(mergedVenue)
      : null;

    const pkgId = package_id || old.package_id;
    const pkgResult = await dbClient.query('SELECT * FROM service_packages WHERE id = $1', [pkgId]);
    if (!pkgResult.rows[0]) {
      throw new ValidationError({ package_id: 'Package not found' });
    }
    const pkg = pkgResult.rows[0];

    // Mirror POST: fetch the full active add-on set (the bundle strip and the
    // rule gate need bundle parents / requires_addon_slug parents), then strip
    // bundle-covered add-ons. The edit path previously skipped both — an edit
    // could double-charge a bundle-included add-on or land a rule-violating set.
    const allAddonsResult = await dbClient.query(
      'SELECT * FROM service_addons WHERE is_active = true'
    );
    const allActiveAddons = allAddonsResult.rows;
    const strippedIds = stripIncludedAddons(addon_ids || [], allActiveAddons);
    const addons = allActiveAddons
      .filter(a => strippedIds.includes(a.id))
      .map(a => ({
        ...a,
        variant: addon_variants?.[String(a.id)] || null,
        quantity: safeAddonQty(addon_quantities?.[String(a.id)]),
      }));

    // Use provided syrup selections, or fall back to existing snapshot syrups
    const oldSnapshot = old.pricing_snapshot || {};
    const syrups = syrup_selections ?? (oldSnapshot.syrups?.selections || []);

    const gc = guest_count ?? old.guest_count;
    const dh = event_duration_hours ?? Number(old.event_duration_hours);
    const nb = num_bars ?? old.num_bars;
    const adj = adjustments ?? (old.adjustments || []);
    const tpo = total_price_override !== undefined ? total_price_override : old.total_price_override;

    // Validate total_price_override bounds when explicitly supplied
    if (total_price_override !== undefined && total_price_override !== null) {
      const n = Number(total_price_override);
      if (!Number.isFinite(n) || n < 0 || n >= TOTAL_PRICE_OVERRIDE_MAX) {
        throw new ValidationError({
          total_price_override: `Must be between 0 and ${TOTAL_PRICE_OVERRIDE_MAX - 1}`,
        });
      }
    }

    // setup_minutes_before — undefined/null sentinel, mirrored on the
    // total_price_override handling directly above. A time-only PATCH omits this
    // key (undefined → keep old). Explicit null resets to the package-derived
    // default (90 hosted / 60 else, resolved at read time). A number is
    // validated 0–600 inclusive. Bound DIRECTLY in the UPDATE below (NOT via
    // COALESCE — COALESCE would make reset-to-default impossible). This is not a
    // pricing input — it never touches calculateProposal/total_price/snapshot.
    const setupMinutes = setup_minutes_before !== undefined ? setup_minutes_before : old.setup_minutes_before;
    if (setup_minutes_before !== undefined && setup_minutes_before !== null) {
      const sm = Number(setup_minutes_before);
      if (!Number.isInteger(sm) || sm < 0 || sm > 600) {
        throw new ValidationError({
          setup_minutes_before: 'Must be a whole number of minutes between 0 and 600',
        });
      }
    }
    // Resolve class_options + glassware from the body, falling back to the
    // persisted values when an event-only edit omits them.
    const resolvedClassOptions = class_options !== undefined ? class_options : old.class_options;
    const resolvedGlassware = client_provides_glassware !== undefined
      ? !!client_provides_glassware
      : old.client_provides_glassware;
    const isClassBooking = pkg.bar_type === 'class';
    const isTopShelfClass = isClassBooking
      && !!resolvedClassOptions && resolvedClassOptions.top_shelf_requested === true;
    // Top Shelf is class-only — reject the flag against a non-class package.
    if (resolvedClassOptions && resolvedClassOptions.top_shelf_requested === true && !isClassBooking) {
      throw new ValidationError({ class_options: 'Top Shelf is only valid for class packages' });
    }
    // Authoritative rule gate — mirrors POST. Skipped for Top Shelf (priced
    // later, no rule inputs yet), exactly as the create path skips it.
    if (!isTopShelfClass) {
      validateProposalRules({
        pkg,
        guestCount: gc,
        addonIds: strippedIds,
        addons: allActiveAddons,
        clientProvidesGlassware: resolvedGlassware,
      });
    }
    // Normalize class_options for persistence — allowlist recognized keys, class
    // bookings only. Mirrors POST / public.js cleanClassOptions.
    const cleanClassOptions = isClassBooking && resolvedClassOptions && typeof resolvedClassOptions === 'object'
      ? {
          spirit_category: ['whiskey_bourbon', 'tequila_mezcal'].includes(resolvedClassOptions.spirit_category)
            ? resolvedClassOptions.spirit_category : null,
          top_shelf_requested: resolvedClassOptions.top_shelf_requested === true,
        }
      : null;

    // Gratuity (§3/§4/§7): admin may pass tip_jar + a dollar gratuity_total; else
    // keep the stored rate/jar. staffCount+hours are independent of gratuity, so
    // compute the basis first, derive the rate, then snapshot with that rate.
    const resolvedTipJar = tip_jar !== undefined ? (tip_jar !== false) : (old.tip_jar !== false);
    let persistTipJar = resolvedTipJar;
    let resolvedGratuityRate = Number(old.gratuity_rate) || 0;
    let gratuityOrigin = old.gratuity_rate_change_origin || null;
    if (tip_jar !== undefined || gratuity_total !== undefined) {
      const { staffCount, hours } = computeGratuityBasis({
        pkg, guestCount: gc, durationHours: dh, numBartenders: num_bartenders, addons,
      });
      // Can't skip the jar with no crew/hours — force it on so the DB CHECK passes.
      persistTipJar = (staffCount * hours) <= 0 ? true : resolvedTipJar;
      const enteredTotal = gratuity_total !== undefined
        ? gratuity_total
        : resolvedGratuityRate * staffCount * hours; // re-derive total from the stored rate
      const g = deriveGratuityRate({ enteredTotal, staffCount, hours, tipJar: persistTipJar });
      if (!g.ok) throw new ValidationError({ gratuity: g.message });
      if (g.rate !== resolvedGratuityRate) gratuityOrigin = 'admin'; // direct rate change
      resolvedGratuityRate = g.rate;
    }

    // Post-payment gratuity guard (§7). Once money is collected (amount_paid > 0)
    // a DIRECT admin RATE increase is a new charge → rejected (a separate
    // client-consented flow is out of scope). A staffing-driven increase at the
    // SAME rate is allowed and triggers a client notice.
    const isPaidForGratuity = Number(old.amount_paid || 0) > 0;
    const priorGratuityRate = Number(old.gratuity_rate) || 0;
    if (isPaidForGratuity && gratuityOrigin === 'admin' && resolvedGratuityRate > priorGratuityRate) {
      throw new ValidationError({
        gratuity: 'Gratuity rate cannot be increased after payment. Adjust staffing, or arrange a separate client-consented charge.',
      });
    }

    const snapshot = calculateProposal({
      pkg, guestCount: gc, durationHours: dh, numBars: nb,
      numBartenders: num_bartenders, addons, syrupSelections: syrups,
      adjustments: adj, totalPriceOverride: tpo,
      gratuityRate: resolvedGratuityRate, tipJar: persistTipJar,
    });

    // Flag a staffing-driven post-payment gratuity rise for a client notice (§7).
    const oldGratuityTotal = Number(old.pricing_snapshot?.gratuity?.total) || 0;
    const newGratuityTotal = Number(snapshot.gratuity?.total) || 0;
    // A staffing change moves the gratuity amount at the SAME rate. Stamp origin
    // 'staffing' only when the amount actually changed (not on an unrelated edit),
    // and notify the client only on an increase (§7).
    if (isPaidForGratuity && gratuityOrigin !== 'admin' && newGratuityTotal !== oldGratuityTotal) {
      gratuityOrigin = 'staffing';
      if (newGratuityTotal > oldGratuityTotal) notifyStaffingGratuity = true;
    }

    const updatedRow = await dbClient.query(`
      UPDATE proposals SET
        event_date = COALESCE($1, event_date),
        event_start_time = COALESCE($2, event_start_time), event_duration_hours = $3,
        event_location = COALESCE($17, COALESCE($4, event_location)), guest_count = $5,
        package_id = $6, num_bars = $7, num_bartenders = $8,
        pricing_snapshot = $9, total_price = $10,
        event_type = COALESCE($12, event_type),
        event_type_category = COALESCE($13, event_type_category),
        event_type_custom = COALESCE($14, event_type_custom),
        adjustments = $15, total_price_override = $16,
        venue_name  = COALESCE($18, venue_name),
        venue_street = COALESCE($19, venue_street),
        venue_city  = COALESCE($20, venue_city),
        venue_state = COALESCE($21, venue_state),
        venue_zip   = COALESCE($22, venue_zip),
        setup_minutes_before = $23,
        client_provides_glassware = $24,
        class_options = $25,
        tip_jar = $26,
        gratuity_rate = $27,
        gratuity_rate_change_origin = $28
      WHERE id = $11
      RETURNING *
    `, [
      event_date, event_start_time, dh, event_location, gc,
      pkgId, nb, snapshot.staffing.actual,
      JSON.stringify(snapshot), snapshot.total, req.params.id,
      event_type || null, event_type_category || null, event_type_custom || null,
      JSON.stringify(adj), tpo ?? null,
      recomposedLocation,
      venue_name ?? null, venue_street ?? null, venue_city ?? null,
      venue_state ?? null, venue_zip ?? null,
      setupMinutes ?? null,
      resolvedGlassware, cleanClassOptions ? JSON.stringify(cleanClassOptions) : null,
      persistTipJar, resolvedGratuityRate, gratuityOrigin
    ]);

    // Re-evaluate payment status when a price increase outruns what's been paid
    // (CLAUDE.md: never leave a proposal marked paid when it isn't). A fully-paid
    // proposal whose new total exceeds amount_paid is no longer paid in full —
    // demote balance_paid -> deposit_paid so the UI stops showing "Paid in full"
    // and re-enables the "Record outside payment" action. The matching $325-style
    // "Additional Services" invoice is created post-commit by
    // createAdditionalInvoiceIfNeeded (below) and is the client's pay surface.
    // MANUAL ONLY: if autopay was enrolled, clear it so the balance scheduler
    // cannot charge the saved card off an admin price edit.
    // Keep payment status honest after a price move in EITHER direction (§6),
    // and surface a durable overpayment signal for the admin refund flow.
    const rec = reconcileProposalPaymentStatus({
      status: old.status, amountPaid: old.amount_paid, totalPrice: snapshot.total,
    });
    if (rec.changed) {
      const demoted = await dbClient.query(
        rec.autopayDisarmed
          ? `UPDATE proposals SET status = $1, autopay_enrolled = false, autopay_status = NULL WHERE id = $2 RETURNING *`
          : `UPDATE proposals SET status = $1 WHERE id = $2 RETURNING *`,
        [rec.status, req.params.id]
      );
      // Keep the row we return (and hand to the reschedule hooks) in sync with the
      // demotion, so the PATCH response doesn't report a stale status.
      updatedRow.rows[0] = demoted.rows[0];
      await dbClient.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
         VALUES ($1, 'status_changed', 'admin', $2, $3)`,
        [req.params.id, req.user.id, JSON.stringify({
          from: old.status, to: rec.status,
          reason: 'price change reconciled', new_total: snapshot.total,
        })]
      );
    }
    if (rec.overpaid) {
      await dbClient.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
         VALUES ($1, 'overpayment_detected', 'admin', $2, $3)`,
        [req.params.id, req.user.id, JSON.stringify({
          amount_paid: Number(old.amount_paid), total_price: snapshot.total, overpaid_cents: rec.overpaidCents,
        })]
      );
    }

    // Replace proposal add-ons — single bulk INSERT
    await dbClient.query('DELETE FROM proposal_addons WHERE proposal_id = $1', [req.params.id]);
    if (snapshot.addons.length) {
      const placeholders = snapshot.addons.map((_, i) => {
        const b = i * 8;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`;
      }).join(',');
      const values = snapshot.addons.flatMap(a =>
        [req.params.id, a.id, a.name, a.billing_type, a.rate, a.quantity, a.line_total, a.variant || null]
      );
      await dbClient.query(
        `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant) VALUES ${placeholders}`,
        values
      );
    }

    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, 'updated', 'admin', $2, $3)`,
      [req.params.id, req.user.id, JSON.stringify({ new_total: snapshot.total })]
    );

    // Keep the converted event's shift in lockstep with its proposal — date,
    // time, location, client, and event type. No-op until the proposal is
    // converted (0 shifts) and skipped for hand-built multi-shift events.
    // Runs in this transaction so the shift never commits out of sync.
    await syncShiftsFromProposal(req.params.id, dbClient);

    // Gemini Finding 2: reschedule re-anchor runs INSIDE the same tx as the
    // proposal UPDATE so DB state is atomic (proposal row + scheduled_messages
    // rows commit together). The email fires after COMMIT (best-effort,
    // non-blocking). A failure here ROLLs BACK the whole PATCH so DB state
    // stays consistent — re-throw to land in the existing catch block.
    try {
      const rescheduleResult = await rescheduleProposalInTx(dbClient, {
        proposalId: parseInt(req.params.id, 10),
        old,                          // pre-UPDATE row
        updated: updatedRow.rows[0],  // post-UPDATE row
      });
      shouldSendRescheduleEmail = rescheduleResult.shouldSendEmail;
    } catch (rescheduleErr) {
      throw rescheduleErr;
    }

    await dbClient.query('COMMIT');

    // Refresh unlocked invoices with new pricing (own transaction for isolation)
    const oldTotalCents = Math.round(Number(old.total_price || 0) * 100);
    const invClient = await pool.connect();
    try {
      await invClient.query('BEGIN');
      await refreshUnlockedInvoices(parseInt(req.params.id, 10), invClient);
      await createAdditionalInvoiceIfNeeded(parseInt(req.params.id, 10), oldTotalCents, invClient);
      await invClient.query('COMMIT');
    } catch (invErr) {
      try { await invClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(invErr, { tags: { route: 'proposals/update', issue: 'invoice-refresh' } });
      }
      console.error('Invoice refresh failed (non-blocking):', invErr);
    } finally {
      invClient.release();
    }

    // COMMIT already succeeded above. The reschedule email is best-effort,
    // post-commit. Inner try/catch is mandatory — we must NEVER rethrow into
    // the outer catch (which would 500 the PATCH response even though the DB
    // committed successfully). A Resend failure happens after the DB is
    // already consistent; admin can manually re-send.
    if (shouldSendRescheduleEmail) {
      try {
        await sendRescheduleEmail({
          proposalId: parseInt(req.params.id, 10),
          old,
          updated: updatedRow.rows[0],
        });
      } catch (emailErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(emailErr, {
            tags: { route: 'proposals/update', issue: 'reschedule-email' },
            extra: { proposalId: req.params.id },
          });
        }
        console.error('Reschedule email failed (non-blocking, DB already committed):', emailErr);
      }
    }

    // Staffing-driven gratuity change (§7): the crew grew, so the gratuity total
    // rose at the SAME rate the client agreed to. Notify by email (not SMS),
    // best-effort, post-commit — a failure must NEVER 500 the committed PATCH.
    if (notifyStaffingGratuity) {
      try {
        const full = await pool.query(
          `SELECT p.total_price, p.pricing_snapshot, c.email AS client_email, c.name AS client_name
             FROM proposals p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1`,
          [req.params.id]
        );
        const row = full.rows[0];
        if (row && row.client_email) {
          await sendEmail({
            to: row.client_email,
            ...emailTemplates.gratuityStaffingChange({
              name: row.client_name,
              newTotal: Number(row.total_price),
              gratuity: (row.pricing_snapshot && row.pricing_snapshot.gratuity) || null,
            }),
          });
        }
      } catch (mailErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(mailErr, { tags: { route: 'proposals/update', issue: 'gratuity-staffing-email' } });
        }
        console.error('Gratuity staffing-change email failed (non-blocking):', mailErr);
      }
    }

    // Plan 2d / W2: re-anchor the New Year touch after a reschedule.
    // new_year_hello has a computed Jan-2 anchor (offsetFromEventDate null), so
    // reanchorPendingMessages (the in-transaction generic offset cascade) skips
    // it. recomputeNewYearHelloForProposal uses the module-level pool, so it
    // runs here: post-commit and best-effort, alongside the reschedule email.
    // shouldSendRescheduleEmail is true exactly when a signed proposal was
    // rescheduled, which is the only time a new_year_hello row can exist.
    if (shouldSendRescheduleEmail) {
      try {
        const { recomputeNewYearHelloForProposal } = require('../../utils/marketingHandlers');
        await recomputeNewYearHelloForProposal(parseInt(req.params.id, 10));
      } catch (recomputeErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(recomputeErr, {
            tags: { route: 'proposals/update', issue: 'new-year-recompute' },
            extra: { proposalId: req.params.id },
          });
        }
        console.error('new_year_hello recompute failed (non-blocking):', recomputeErr);
      }
    }

    // Phase 4a: post-commit staff reschedule hooks. Gated on a real reschedule
    // (shouldSendRescheduleEmail). The helper re-anchors pending staff SMS rows
    // AND, when notify_assigned_staff is set, sends the schedule-change SMS/email.
    if (shouldSendRescheduleEmail) {
      try {
        const { runRescheduleStaffHooks } = require('../../utils/staffShiftHandlers');
        await runRescheduleStaffHooks({
          proposalId: parseInt(req.params.id, 10),
          updated: updatedRow.rows[0],
          notifyStaff: notify_assigned_staff === true,
          notifyStaffSms: notify_staff_sms === true,
          notifyStaffEmail: notify_staff_email === true,
        });
      } catch (staffHookErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(staffHookErr, {
            tags: { route: 'proposals/update', issue: 'staff-reschedule-hooks' },
            extra: { proposalId: req.params.id },
          });
        }
        console.error('Staff reschedule hooks failed (non-blocking):', staffHookErr);
      }
    }

    // Return updated proposal (from the UPDATE ... RETURNING * above)
    res.json(updatedRow.rows[0]);
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err;
  } finally {
    dbClient.release();
  }
}));

/** DELETE /api/proposals/:id — delete a proposal */
router.delete('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  // Existence probe BEFORE the transaction so the 404 path doesn't open a
  // connection / spurious BEGIN/ROLLBACK pair. scheduled_messages has no FK
  // on entity_id (polymorphic across proposal/shift/client/consult), so the
  // DB won't cascade for us — clear them explicitly in the same transaction
  // so a deleted proposal can't trigger post-delete sends from the comms
  // scheduler.
  const probe = await pool.query('SELECT 1 FROM proposals WHERE id = $1', [req.params.id]);
  if (!probe.rows[0]) throw new NotFoundError('Proposal not found');

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    await dbClient.query(
      `DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1`,
      [req.params.id]
    );
    await dbClient.query('DELETE FROM proposals WHERE id = $1', [req.params.id]);
    await dbClient.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err;
  } finally {
    dbClient.release();
  }
}));

module.exports = router;
// Dependency seam for tests — attached to the router export so the proposals
// composition router still mounts cleanly (Express ignores extra properties).
module.exports.__setDeps = __setDeps;
