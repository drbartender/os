const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { calculateProposal } = require('../../utils/pricingEngine');
const { createEventShifts, createDrinkPlan } = require('../../utils/eventCreation');
const { sendEmail } = require('../../utils/email');
const emailTemplates = require('../../utils/emailTemplates');
const { createInvoiceOnSend, refreshUnlockedInvoices, createAdditionalInvoiceIfNeeded, linkPaymentToInvoice } = require('../../utils/invoiceHelpers');
const { getEventTypeLabel } = require('../../utils/eventTypes');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError, ExternalServiceError } = require('../../utils/errors');
const { PUBLIC_SITE_URL, ADMIN_URL } = require('../../utils/urls');

const router = express.Router();

// Status state machine — enforced on PATCH /:id/status unless ?force=true (admin only).
// Transitions are one-way except for admin-backed corrections via force.
// `cancelled` is terminal: archive endpoint for duplicates/abandoned proposals before payment.
// Not reachable from paid statuses (deposit_paid/balance_paid/confirmed/completed) — those
// reflect real money and cancelling them via a state transition would desync the ledger.
// Admins can ?force=true to bypass for ledger-corrected refunds.
const STATUS_TRANSITIONS = {
  draft:        ['sent', 'archived', 'cancelled'],
  sent:         ['viewed', 'accepted', 'modified', 'draft', 'cancelled'],
  viewed:       ['accepted', 'modified', 'sent', 'cancelled'],
  modified:     ['sent', 'accepted', 'cancelled'],
  accepted:     ['deposit_paid', 'confirmed', 'cancelled'],
  deposit_paid: ['balance_paid', 'confirmed', 'completed'],
  balance_paid: ['completed'],
  confirmed:    ['completed', 'deposit_paid', 'balance_paid'],
  completed:    [],
  archived:     ['draft'],
  cancelled:    [],
};

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
           p.created_at, p.updated_at,
           c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
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
    query += ` AND p.status = 'cancelled'`;
  } else if (view === 'all') {
    query += ` AND p.status != 'cancelled'`;
  } else {
    // Default 'active' bucket — exclude paid (moved to Events) and cancelled (archive).
    query += ` AND p.status NOT IN ('deposit_paid', 'balance_paid', 'confirmed', 'completed', 'cancelled')`;
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

/** POST /api/proposals — create a new proposal */
router.post('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const {
    client_id, client_name, client_email, client_phone, client_source,
    event_date, event_start_time, event_duration_hours,
    event_location, guest_count, package_id, num_bars, num_bartenders, addon_ids,
    addon_variants, syrup_selections, event_type, event_type_category, event_type_custom
  } = req.body;

  const fieldErrors = {};
  if (!package_id) fieldErrors.package_id = 'Package is required';
  if (!client_id && !client_name) fieldErrors.client_name = 'Client name is required';
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError(fieldErrors);
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // Create or use existing client
    let finalClientId = client_id;
    if (!finalClientId && client_name) {
      const clientResult = await dbClient.query(
        `INSERT INTO clients (name, email, phone, source) VALUES ($1, $2, $3, $4) RETURNING id`,
        [client_name, client_email || null, client_phone || null, client_source || 'direct']
      );
      finalClientId = clientResult.rows[0].id;
    }

    // Fetch package
    const pkgResult = await dbClient.query('SELECT * FROM service_packages WHERE id = $1', [package_id]);
    if (!pkgResult.rows[0]) {
      throw new ValidationError({ package_id: 'Package not found' });
    }

    // Fetch add-ons
    let addons = [];
    if (addon_ids && addon_ids.length > 0) {
      const addonResult = await dbClient.query(
        'SELECT * FROM service_addons WHERE id = ANY($1) AND is_active = true',
        [addon_ids]
      );
      addons = addonResult.rows.map(a => ({
        ...a,
        variant: addon_variants?.[String(a.id)] || null,
      }));
    }

    // Calculate pricing
    const gc = guest_count || 50;
    const dh = event_duration_hours || 4;
    const nb = num_bars ?? 1;
    const snapshot = calculateProposal({
      pkg: pkgResult.rows[0],
      guestCount: gc,
      durationHours: dh,
      numBars: nb,
      numBartenders: num_bartenders,
      addons,
      syrupSelections: syrup_selections || [],
    });

    // Insert proposal
    const proposalResult = await dbClient.query(`
      INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
        event_location, guest_count, package_id, num_bars, num_bartenders, pricing_snapshot, total_price, created_by,
        event_type, event_type_category, event_type_custom)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `, [
      finalClientId, event_date || null, event_start_time || null, dh,
      event_location || null, gc, package_id, nb,
      snapshot.staffing.actual, JSON.stringify(snapshot), snapshot.total, req.user.id,
      event_type || null, event_type_category || null, event_type_custom || null
    ]);

    const proposal = proposalResult.rows[0];

    // Insert proposal add-ons — single bulk INSERT
    if (snapshot.addons.length) {
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
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, 'created', 'admin', $2, $3)`,
      [proposal.id, req.user.id, JSON.stringify({ total: snapshot.total, package: snapshot.package.name })]
    );

    await dbClient.query('COMMIT');
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
           sp.name AS package_name, sp.slug AS package_slug, sp.category AS package_category, sp.includes AS package_includes,
           u.email AS created_by_email
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

  res.json({ ...result.rows[0], addons: addons.rows, activity: activity.rows });
}));

/** PATCH /api/proposals/:id — update event details and recalculate */
router.patch('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const {
    event_date, event_start_time, event_duration_hours,
    event_location, guest_count, package_id, num_bars, num_bartenders, addon_ids,
    addon_variants, syrup_selections, event_type, event_type_category, event_type_custom,
    adjustments, total_price_override
  } = req.body;

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const existing = await dbClient.query('SELECT * FROM proposals WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) {
      throw new NotFoundError('Proposal not found');
    }
    const old = existing.rows[0];

    const pkgId = package_id || old.package_id;
    const pkgResult = await dbClient.query('SELECT * FROM service_packages WHERE id = $1', [pkgId]);
    if (!pkgResult.rows[0]) {
      throw new ValidationError({ package_id: 'Package not found' });
    }

    let addons = [];
    const ids = addon_ids || [];
    if (ids.length > 0) {
      const addonResult = await dbClient.query(
        'SELECT * FROM service_addons WHERE id = ANY($1) AND is_active = true', [ids]
      );
      addons = addonResult.rows.map(a => ({
        ...a,
        variant: addon_variants?.[String(a.id)] || null,
      }));
    }

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
    const snapshot = calculateProposal({
      pkg: pkgResult.rows[0], guestCount: gc, durationHours: dh, numBars: nb,
      numBartenders: num_bartenders, addons, syrupSelections: syrups,
      adjustments: adj, totalPriceOverride: tpo,
    });

    const updatedRow = await dbClient.query(`
      UPDATE proposals SET
        event_date = COALESCE($1, event_date),
        event_start_time = COALESCE($2, event_start_time), event_duration_hours = $3,
        event_location = COALESCE($4, event_location), guest_count = $5,
        package_id = $6, num_bars = $7, num_bartenders = $8,
        pricing_snapshot = $9, total_price = $10,
        event_type = COALESCE($12, event_type),
        event_type_category = COALESCE($13, event_type_category),
        event_type_custom = COALESCE($14, event_type_custom),
        adjustments = $15, total_price_override = $16
      WHERE id = $11
      RETURNING *
    `, [
      event_date, event_start_time, dh, event_location, gc,
      pkgId, nb, snapshot.staffing.actual,
      JSON.stringify(snapshot), snapshot.total, req.params.id,
      event_type || null, event_type_category || null, event_type_custom || null,
      JSON.stringify(adj), tpo ?? null
    ]);

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

    // Return updated proposal (from the UPDATE ... RETURNING * above)
    res.json(updatedRow.rows[0]);
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err;
  } finally {
    dbClient.release();
  }
}));

/** PATCH /api/proposals/:id/status — update status. Enforce state machine unless ?force=true (admin-only) */
router.patch('/:id/status', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { status } = req.body;
  const validStatuses = Object.keys(STATUS_TRANSITIONS);
  if (!validStatuses.includes(status)) {
    throw new ValidationError({ status: 'Invalid status' });
  }

  const force = req.query.force === 'true' && req.user.role === 'admin';

  // Fetch current status for transition check
  const current = await pool.query('SELECT status FROM proposals WHERE id = $1', [req.params.id]);
  if (!current.rows[0]) throw new NotFoundError('Proposal not found');
  const currentStatus = current.rows[0].status;

  if (!force && currentStatus !== status) {
    const allowed = STATUS_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(status)) {
      throw new ValidationError({
        status: `Cannot transition from '${currentStatus}' to '${status}'. Allowed: [${allowed.join(', ') || 'none'}]. Admins may use ?force=true.`,
      });
    }
  }

  const result = await pool.query(
    `UPDATE proposals SET
       status = $1,
       sent_at     = CASE WHEN $1::text = 'sent'     THEN COALESCE(sent_at, NOW())     ELSE sent_at END,
       accepted_at = CASE WHEN $1::text = 'accepted' THEN COALESCE(accepted_at, NOW()) ELSE accepted_at END
     WHERE id = $2 RETURNING *`,
    [status, req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Proposal not found');

  const action = force ? 'status_force_changed' : 'status_changed';
  await pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, $2, 'admin', $3, $4)`,
    [req.params.id, action, req.user.id, JSON.stringify({ from: currentStatus, to: status, forced: force })]
  );

  // Email client when proposal is sent (non-blocking)
  if (status === 'sent') {
    try {
      const pd = await pool.query(`
        SELECT p.token, p.event_type, p.event_type_custom, p.event_date, p.created_by,
               c.name AS client_name, c.email AS client_email
        FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1
      `, [req.params.id]);
      const p = pd.rows[0];
      if (p?.client_email && p?.token) {
        const proposalUrl = `${PUBLIC_SITE_URL}/proposal/${p.token}`;
        const eventTypeLabel = getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom });

        // Create drink plan and include link in email
        let planUrl = null;
        try {
          const drinkPlan = await createDrinkPlan(req.params.id, {
            client_name: p.client_name,
            client_email: p.client_email,
            event_type: p.event_type,
            event_type_custom: p.event_type_custom,
            event_date: p.event_date,
            created_by: p.created_by,
          }, { skipEmail: true });

          if (drinkPlan?.token) {
            planUrl = `${PUBLIC_SITE_URL}/plan/${drinkPlan.token}`;
          } else {
            // Already exists — look up existing token
            const existingPlan = await pool.query(
              'SELECT token FROM drink_plans WHERE proposal_id = $1 LIMIT 1',
              [req.params.id]
            );
            if (existingPlan.rows[0]?.token) {
              planUrl = `${PUBLIC_SITE_URL}/plan/${existingPlan.rows[0].token}`;
            }
          }
        } catch (planErr) {
          if (process.env.SENTRY_DSN_SERVER) {
            Sentry.captureException(planErr, { tags: { route: 'proposals/status', issue: 'drink-plan-creation' } });
          }
          console.error('Drink plan creation failed (non-blocking):', planErr);
        }

        const tpl = emailTemplates.proposalSent({ clientName: p.client_name, eventTypeLabel, proposalUrl, planUrl });
        await sendEmail({ to: p.client_email, ...tpl });
      }
    } catch (emailErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(emailErr, { tags: { route: 'proposals/status', issue: 'email' } });
      }
      console.error('Proposal sent email failed (non-blocking):', emailErr);
    }
  }

  // Auto-create first invoice when proposal is sent
  if (status === 'sent') {
    try {
      await createInvoiceOnSend(parseInt(req.params.id, 10));
    } catch (invErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(invErr, { tags: { route: 'proposals/status', issue: 'invoice-auto-create' } });
      }
      console.error('Invoice auto-creation failed (non-blocking):', invErr);
    }
  }

  res.json(result.rows[0]);
}));

/** PATCH /api/proposals/:id/notes — update admin notes */
router.patch('/:id/notes', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { admin_notes } = req.body;
  const result = await pool.query(
    'UPDATE proposals SET admin_notes = $1 WHERE id = $2 RETURNING id, admin_notes',
    [admin_notes || '', req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Proposal not found');
  res.json(result.rows[0]);
}));

/** POST /api/proposals/:id/create-shift — manually create event shift from a proposal */
router.post('/:id/create-shift', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const proposal = await pool.query('SELECT id, status FROM proposals WHERE id = $1', [req.params.id]);
  if (!proposal.rows[0]) throw new NotFoundError('Proposal not found');
  if (!['deposit_paid', 'balance_paid', 'confirmed'].includes(proposal.rows[0].status)) {
    throw new ConflictError('Proposal must have deposit paid before creating a shift.', 'DEPOSIT_REQUIRED');
  }
  const shift = await createEventShifts(req.params.id);
  if (!shift) throw new ConflictError('Shift already exists for this proposal.', 'SHIFT_EXISTS');
  res.status(201).json(shift);
}));

/** PATCH /api/proposals/:id/balance-due-date — override balance due date */
router.patch('/:id/balance-due-date', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { balance_due_date } = req.body;
  if (!balance_due_date) {
    throw new ValidationError({ balance_due_date: 'Balance due date is required' });
  }
  const result = await pool.query(
    'UPDATE proposals SET balance_due_date = $1 WHERE id = $2 RETURNING id, balance_due_date',
    [balance_due_date, req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Proposal not found');

  await pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, 'balance_due_date_changed', 'admin', $2, $3)`,
    [req.params.id, req.user.id, JSON.stringify({ balance_due_date })]
  );

  res.json(result.rows[0]);
}));

/** POST /api/proposals/:id/send-reminder — admin sends a balance reminder email to the client */
router.post('/:id/send-reminder', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const proposalId = req.params.id;
  const { rows } = await pool.query(`
    SELECT p.id, p.token, p.total_price, p.amount_paid, p.balance_due_date,
           p.event_type, p.event_type_custom,
           c.email AS client_email, c.name AS client_name
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.id = $1
  `, [proposalId]);

  if (!rows[0]) throw new NotFoundError('Proposal not found');
  const proposal = rows[0];

  if (!proposal.client_email) {
    throw new ValidationError({ client: 'Client has no email on file.' });
  }

  const total = Number(proposal.total_price || 0);
  const paid = Number(proposal.amount_paid || 0);
  const balanceDue = total - paid;
  if (balanceDue <= 0) {
    throw new ConflictError('Proposal has no outstanding balance.', 'NO_BALANCE_DUE');
  }

  const eventTypeLabel = getEventTypeLabel({
    event_type: proposal.event_type,
    event_type_custom: proposal.event_type_custom,
  });
  const proposalUrl = `${PUBLIC_SITE_URL}/proposal/${proposal.token}`;
  const tpl = emailTemplates.paymentReminderClient({
    clientName: proposal.client_name,
    eventTypeLabel,
    balanceDue: balanceDue.toFixed(2),
    balanceDueDate: proposal.balance_due_date,
    proposalUrl,
  });

  try {
    await sendEmail({ to: proposal.client_email, ...tpl });
  } catch (emailErr) {
    Sentry.captureException(emailErr, { tags: { route: 'proposals/send-reminder' }, extra: { proposalId } });
    throw new ExternalServiceError('email', emailErr, 'Failed to send reminder email.');
  }

  // Activity log is best-effort — the email already went out, so a transient
  // INSERT failure must not surface as a 5xx to the admin (which would prompt
  // a retry and double-send the reminder).
  try {
    await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'reminder_sent', 'admin', $2, $3)`,
      [proposalId, req.user.id, JSON.stringify({ to: proposal.client_email, balance_due: balanceDue })]
    );
  } catch (logErr) {
    Sentry.captureException(logErr, {
      tags: { route: 'proposals/send-reminder', step: 'activity-log' },
      extra: { proposalId },
    });
  }

  res.json({ ok: true });
}));

/** POST /api/proposals/:id/record-payment — manually record an outside payment (cash, Venmo, etc.) */
router.post('/:id/record-payment', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { amount, paid_in_full, method } = req.body;

  const result = await pool.query(
    'SELECT id, total_price, amount_paid, deposit_amount, status FROM proposals WHERE id = $1',
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Proposal not found');

  const proposal = result.rows[0];
  if (['balance_paid', 'confirmed'].includes(proposal.status)) {
    throw new ConflictError('Proposal is already fully paid.', 'ALREADY_PAID_IN_FULL');
  }

  const totalPrice = Number(proposal.total_price);
  const currentPaid = Number(proposal.amount_paid || 0);
  const paymentAmount = paid_in_full ? totalPrice - currentPaid : Number(amount);

  if (!paymentAmount || paymentAmount <= 0) {
    throw new ValidationError({ amount: 'Enter a valid payment amount' });
  }

  const newAmountPaid = Math.min(currentPaid + paymentAmount, totalPrice);
  const isFullyPaid = newAmountPaid >= totalPrice;
  const newStatus = isFullyPaid ? 'balance_paid' : 'deposit_paid';

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    await dbClient.query(
      'UPDATE proposals SET amount_paid = $1, status = $2 WHERE id = $3',
      [newAmountPaid, newStatus, proposal.id]
    );

    // Record in proposal_payments. Use the capped delta (newAmountPaid - currentPaid)
    // so an over-payment request doesn't inflate the ledger beyond the proposal total.
    await dbClient.query(
      `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status)
       VALUES ($1, $2, $3, 'succeeded')`,
      [proposal.id, isFullyPaid ? 'full' : 'deposit', Math.round((newAmountPaid - currentPaid) * 100)]
    );

    // Log activity
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, $2, 'admin', $3, $4)`,
      [proposal.id, isFullyPaid ? 'paid_in_full' : 'deposit_paid', req.user.id,
        JSON.stringify({ amount: paymentAmount, method: method || 'manual', new_total_paid: newAmountPaid })]
    );

    // Link payment to the oldest open invoice
    const openInvoice = await dbClient.query(
      "SELECT id FROM invoices WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid') ORDER BY created_at ASC LIMIT 1",
      [proposal.id]
    );
    if (openInvoice.rows[0]) {
      const paymentRow = await dbClient.query(
        'SELECT id FROM proposal_payments WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 1',
        [proposal.id]
      );
      if (paymentRow.rows[0]) {
        const payAmountCents = Math.round(paymentAmount * 100);
        await linkPaymentToInvoice(openInvoice.rows[0].id, paymentRow.rows[0].id, payAmountCents, dbClient);
      }
    }

    await dbClient.query('COMMIT');
  } catch (txErr) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw txErr;
  } finally {
    dbClient.release();
  }

  // Email notifications for payment (non-blocking)
  try {
    const payData = await pool.query(`
      SELECT p.event_type, p.event_type_custom, c.name AS client_name, c.email AS client_email
      FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1
    `, [proposal.id]);
    const pd = payData.rows[0];
    const amountFormatted = paymentAmount.toFixed(2);
    const payType = isFullyPaid ? 'full payment' : 'deposit';
    const eventTypeLabel = getEventTypeLabel({ event_type: pd?.event_type, event_type_custom: pd?.event_type_custom });

    if (pd?.client_email) {
      const tpl = emailTemplates.paymentReceivedClient({ clientName: pd.client_name, eventTypeLabel, amount: amountFormatted, paymentType: payType });
      await sendEmail({ to: pd.client_email, ...tpl });
    }
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      const adminUrl = `${ADMIN_URL}/proposals/${proposal.id}`;
      const tpl = emailTemplates.paymentReceivedAdmin({ clientName: pd?.client_name, eventTypeLabel, amount: amountFormatted, paymentType: payType, proposalId: proposal.id, adminUrl });
      await sendEmail({ to: adminEmail, ...tpl });
    }
  } catch (emailErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(emailErr, { tags: { route: 'proposals/payment', issue: 'email' } });
    }
    console.error('Payment email failed (non-blocking):', emailErr);
  }

  // Auto-create event shift
  try {
    const shift = await createEventShifts(proposal.id);
    if (shift) console.log(`Shift #${shift.id} created for proposal ${proposal.id} (manual payment)`);
  } catch (shiftErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(shiftErr, { tags: { route: 'proposals/payment', issue: 'shift-auto-create' } });
    }
    console.error('Shift auto-creation failed (non-blocking):', shiftErr);
  }

  res.json({ success: true, status: newStatus, amount_paid: newAmountPaid });
}));

/** DELETE /api/proposals/:id — delete a proposal */
router.delete('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query('DELETE FROM proposals WHERE id = $1 RETURNING id', [req.params.id]);
  if (!result.rows[0]) throw new NotFoundError('Proposal not found');
  res.json({ success: true });
}));

module.exports = router;
