const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { publicLimiter, publicReadLimiter } = require('../middleware/rateLimiters');
const { calculateProposal } = require('../utils/pricingEngine');
const { createEventShifts, createDrinkPlan } = require('../utils/eventCreation');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');
const { createInvoiceOnSend, refreshUnlockedInvoices, createAdditionalInvoiceIfNeeded, linkPaymentToInvoice } = require('../utils/invoiceHelpers');
const { getEventTypeLabel } = require('../utils/eventTypes');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');
const { PUBLIC_SITE_URL, ADMIN_URL } = require('../utils/urls');
const Sentry = require('@sentry/node');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FORM_STATE_SIZE = 50 * 1024; // 50 KB

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

// ─── Public routes (token-based) ─────────────────────────────────

/** GET /api/proposals/t/:token — fetch proposal by token (public) */
router.get('/t/:token', publicLimiter, asyncHandler(async (req, res) => {
  // Public-safe column allowlist — do NOT expose admin_notes, stripe_customer_id,
  // stripe_payment_method_id, client_signature_ip, client_signature_user_agent,
  // created_by, or other internal fields.
  const result = await pool.query(`
    SELECT
      p.id, p.token, p.client_id,
      p.event_date, p.event_start_time, p.event_duration_hours,
      p.event_location, p.event_type, p.event_type_category, p.event_type_custom,
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

  res.json({
    ...proposal,
    addons: addonsRes.rows,
    drink_plan_token: drinkPlanToken,
    status: proposal.status === 'sent' ? 'viewed' : proposal.status,
  });
}));

const PROPOSAL_DOCUMENT_VERSION = 'event-services-agreement-v2';

/** POST /api/proposals/t/:token/sign — client signs and accepts proposal */
router.post('/t/:token/sign', publicLimiter, asyncHandler(async (req, res) => {
  const { client_signed_name, client_signature_data, client_signature_method } = req.body;
  const fieldErrors = {};
  if (!client_signed_name) fieldErrors.client_signed_name = 'Please enter your full name';
  if (!client_signature_data) fieldErrors.signature = 'Please sign before accepting';
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError(fieldErrors);
  }
  if (client_signature_method !== 'draw' && client_signature_method !== 'type') {
    throw new ValidationError({ signature: 'Invalid signature method' });
  }

  const result = await pool.query(
    "SELECT id, status FROM proposals WHERE token = $1",
    [req.params.token]
  );
  if (!result.rows[0]) throw new NotFoundError('This proposal is no longer available');

  const proposal = result.rows[0];
  if (['deposit_paid', 'balance_paid', 'confirmed'].includes(proposal.status)) {
    throw new ConflictError('This proposal has already been accepted', 'ALREADY_ACCEPTED');
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
  const userAgent = req.headers['user-agent'] || null;

  await pool.query(`
    UPDATE proposals SET
      client_signed_name = $1,
      client_signature_data = $2,
      client_signed_at = NOW(),
      client_signature_method = $3,
      client_signature_ip = $4,
      client_signature_user_agent = $5,
      client_signature_document_version = $6,
      status = 'accepted'
    WHERE id = $7
  `, [client_signed_name, client_signature_data, client_signature_method, ip, userAgent, PROPOSAL_DOCUMENT_VERSION, proposal.id]);

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
        const adminUrl = `${ADMIN_URL}/admin/proposals/${pd.id}`;
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

// ─── Public website endpoints (no auth) ─────────────────────────

/** GET /api/proposals/public/packages — list active packages (public, limited fields) */
router.get('/public/packages', publicLimiter, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, slug, category, bar_type, description, pricing_type, includes,
            base_rate_3hr, base_rate_4hr, base_rate_3hr_small, base_rate_4hr_small,
            extra_hour_rate, extra_hour_rate_small, min_guests, min_total,
            guests_per_bartender, bartenders_included, extra_bartender_hourly,
            first_bar_fee, additional_bar_fee
     FROM service_packages WHERE is_active = true ORDER BY sort_order`
  );
  res.json(result.rows);
}));

/** GET /api/proposals/public/addons — list active add-ons (public, limited fields) */
router.get('/public/addons', publicLimiter, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, slug, description, billing_type, rate, extra_hour_rate, applies_to, category, requires_addon_slug, linked_package_id
     FROM service_addons WHERE is_active = true ORDER BY sort_order`
  );
  res.json(result.rows);
}));

/** POST /api/proposals/public/calculate — preview pricing (public, no save) */
router.post('/public/calculate', publicLimiter, asyncHandler(async (req, res) => {
  const { package_id, guest_count, duration_hours, num_bars, addon_ids, addon_quantities, syrup_selections } = req.body;
  if (!package_id) throw new ValidationError({ package_id: 'Package is required' });

  const pkgResult = await pool.query('SELECT * FROM service_packages WHERE id = $1 AND is_active = true', [package_id]);
  if (!pkgResult.rows[0]) throw new ValidationError({ package_id: 'Invalid package' });

  let addons = [];
  if (addon_ids && addon_ids.length > 0) {
    const addonResult = await pool.query(
      'SELECT * FROM service_addons WHERE id = ANY($1) AND is_active = true',
      [addon_ids]
    );
    addons = addonResult.rows.map(a => ({
      ...a,
      quantity: addon_quantities?.[String(a.id)] || 1,
    }));
  }

  const snapshot = calculateProposal({
    pkg: pkgResult.rows[0],
    guestCount: guest_count || 50,
    durationHours: duration_hours || 4,
    numBars: num_bars ?? 0,
    addons,
    syrupSelections: syrup_selections || [],
  });

  res.json(snapshot);
}));

/** POST /api/proposals/public/capture-lead — capture partial lead from quote wizard + create draft */
router.post('/public/capture-lead', publicLimiter, asyncHandler(async (req, res) => {
  const { name, email, phone, guest_count, event_date, source, form_state, current_step } = req.body;
  if (!email || !email.trim()) {
    throw new ValidationError({ email: 'Email is required' });
  }
  const cleanEmail = email.trim().toLowerCase();
  const dbClient = await pool.connect();
  try {
    const cleanName = name ? name.trim() : null;
    const safeStep = Math.max(0, Math.min(10, parseInt(current_step, 10) || 0));

    // Build notes JSON with any extra context from the wizard
    const notes = JSON.stringify({
      guest_count: guest_count || null,
      event_date: event_date || null,
      phone: phone ? phone.trim() : null,
    });

    await dbClient.query('BEGIN');

    // Upsert into email_leads — prefer existing name over new submission to prevent overwrite
    const leadResult = await dbClient.query(
      `INSERT INTO email_leads (email, name, lead_source, notes, status)
       VALUES ($1, $2, $3, $4, 'active')
       ON CONFLICT (email) DO UPDATE SET
         name = COALESCE(email_leads.name, EXCLUDED.name),
         notes = COALESCE(EXCLUDED.notes, email_leads.notes),
         updated_at = NOW()
       RETURNING id`,
      [
        cleanEmail,
        cleanName || 'Unknown',
        source || 'website',
        notes,
      ]
    );
    const leadId = leadResult.rows[0].id;

    // Upsert quote draft — one active draft per email
    let draftToken = null;
    const formStateStr = form_state && typeof form_state === 'object' ? JSON.stringify(form_state) : null;
    if (formStateStr && formStateStr.length <= MAX_FORM_STATE_SIZE) {
      const draftResult = await dbClient.query(
        `INSERT INTO quote_drafts (email, lead_id, form_state, current_step, status)
         VALUES ($1, $2, $3, $4, 'draft')
         ON CONFLICT (email) WHERE status = 'draft'
           DO UPDATE SET form_state = EXCLUDED.form_state, current_step = EXCLUDED.current_step, updated_at = NOW()
         RETURNING token`,
        [cleanEmail, leadId, formStateStr, safeStep]
      );
      draftToken = draftResult.rows[0].token;
    }

    await dbClient.query('COMMIT');

    // Auto-enroll in abandoned quote sequence (outside transaction — non-blocking)
    try {
      const hasProposal = await pool.query(
        `SELECT 1 FROM clients c JOIN proposals p ON p.client_id = c.id WHERE c.email = $1 LIMIT 1`,
        [cleanEmail]
      );
      if (!hasProposal.rows[0]) {
        const campaign = await pool.query(
          `SELECT id FROM email_campaigns WHERE name = 'Abandoned Quote Followup' AND type = 'sequence' AND status = 'active' LIMIT 1`
        );
        if (campaign.rows[0]) {
          const firstStep = await pool.query(
            'SELECT delay_days, delay_hours FROM email_sequence_steps WHERE campaign_id = $1 ORDER BY step_order LIMIT 1',
            [campaign.rows[0].id]
          );
          const { delay_days = 0, delay_hours = 2 } = firstStep.rows[0] || {};
          await pool.query(
            `INSERT INTO email_sequence_enrollments (campaign_id, lead_id, next_step_due_at)
             VALUES ($1, $2, NOW() + MAKE_INTERVAL(days => $3, hours => $4))
             ON CONFLICT (campaign_id, lead_id) DO NOTHING`,
            [campaign.rows[0].id, leadId, delay_days, delay_hours]
          );
        }
      }
    } catch (enrollErr) {
      Sentry.captureException(enrollErr, { tags: { route: 'proposals/public/capture-lead', phase: 'enrollment' } });
      console.error('Abandoned quote enrollment error (non-blocking):', enrollErr.message);
    }

    res.json({ ok: true, draft_token: draftToken });
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err;
  } finally {
    dbClient.release();
  }
}));

/** GET /api/proposals/public/quote-draft/:token — fetch saved draft for resume */
router.get('/public/quote-draft/:token', publicReadLimiter, asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.token)) throw new NotFoundError('This quote link is no longer valid');
  const result = await pool.query(
    `SELECT token, form_state, current_step FROM quote_drafts
     WHERE token = $1 AND status = 'draft' AND updated_at > NOW() - INTERVAL '30 days'`,
    [req.params.token]
  );
  if (!result.rows[0]) throw new NotFoundError('This quote link is no longer valid');
  res.json(result.rows[0]);
}));

/** PUT /api/proposals/public/quote-draft/:token — auto-save draft state */
router.put('/public/quote-draft/:token', publicReadLimiter, asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.token)) throw new NotFoundError('This quote link is no longer valid');
  const { form_state, current_step } = req.body;
  if (!form_state || typeof form_state !== 'object') {
    throw new ValidationError({ form_state: 'Invalid form state' });
  }
  const safeStep = Math.max(0, Math.min(10, parseInt(current_step, 10) || 0));
  const serialized = JSON.stringify(form_state);
  if (serialized.length > MAX_FORM_STATE_SIZE) {
    throw new ValidationError({ form_state: 'Form state too large' });
  }
  const result = await pool.query(
    `UPDATE quote_drafts SET form_state = $1, current_step = $2, updated_at = NOW()
     WHERE token = $3 AND status = 'draft'
     RETURNING token`,
    [serialized, safeStep, req.params.token]
  );
  if (!result.rows[0]) throw new NotFoundError('This quote link is no longer valid');
  res.json({ ok: true });
}));

/** POST /api/proposals/public/submit — create a proposal from the public website quote wizard */
router.post('/public/submit', publicLimiter, asyncHandler(async (req, res) => {
  const {
    client_name, client_email, client_phone,
    event_date, event_start_time, event_duration_hours,
    event_location, guest_count, package_id, num_bars, addon_ids,
    addon_quantities, syrup_selections,
    event_type, event_type_category, event_type_custom,
    client_provides_glassware,
    class_options
  } = req.body;

  const fieldErrors = {};
  if (!client_name || !client_name.trim()) fieldErrors.client_name = 'Name is required';
  if (!client_email || !client_email.trim()) fieldErrors.client_email = 'Email is required';
  if (!package_id) fieldErrors.package_id = 'Package is required';
  if (!guest_count || guest_count < 1) fieldErrors.guest_count = 'Guest count is required';
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);

  // Normalize class_options: only persist recognized keys and only for class bookings
  const isClassBooking = event_type_category === 'class';
  const cleanClassOptions = isClassBooking && class_options && typeof class_options === 'object'
    ? {
        spirit_category: ['whiskey_bourbon', 'tequila_mezcal'].includes(class_options.spirit_category) ? class_options.spirit_category : null,
        top_shelf_requested: class_options.top_shelf_requested === true,
      }
    : null;
  const isTopShelfClass = !!cleanClassOptions && cleanClassOptions.top_shelf_requested;

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // Create or find existing client by email
    const clientResult = await dbClient.query(
      'SELECT id FROM clients WHERE email = $1 LIMIT 1',
      [client_email.trim().toLowerCase()]
    );
    let finalClientId;
    if (clientResult.rows[0]) {
      finalClientId = clientResult.rows[0].id;
      // Update name/phone if provided
      await dbClient.query(
        'UPDATE clients SET name = COALESCE(NULLIF($1, name), name), phone = COALESCE($2, phone) WHERE id = $3',
        [client_name.trim(), client_phone || null, finalClientId]
      );
    } else {
      const newClient = await dbClient.query(
        'INSERT INTO clients (name, email, phone, source) VALUES ($1, $2, $3, $4) RETURNING id',
        [client_name.trim(), client_email.trim().toLowerCase(), client_phone || null, 'website']
      );
      finalClientId = newClient.rows[0].id;
    }

    // Fetch package
    const pkgResult = await dbClient.query('SELECT * FROM service_packages WHERE id = $1 AND is_active = true', [package_id]);
    if (!pkgResult.rows[0]) {
      try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
      throw new ValidationError({ package_id: 'Invalid package' });
    }

    // Top Shelf is a class-only flow. Reject any attempt to short-circuit
    // pricing against a non-class package (e.g. full-bar wedding) — otherwise
    // a scripted client could create $0 drafts for premium packages.
    if (isTopShelfClass && pkgResult.rows[0].bar_type !== 'class') {
      try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
      throw new ValidationError({ class_options: 'Top Shelf is only valid for class packages' });
    }

    // Fetch add-ons (skipped for Top Shelf — pricing is TBD, no addons billable yet)
    let addons = [];
    if (!isTopShelfClass && addon_ids && addon_ids.length > 0) {
      const addonResult = await dbClient.query(
        'SELECT * FROM service_addons WHERE id = ANY($1) AND is_active = true',
        [addon_ids]
      );
      addons = addonResult.rows.map(a => ({
        ...a,
        quantity: addon_quantities?.[String(a.id)] || 1,
      }));
    }

    // Calculate pricing (skipped for Top Shelf — draft with no total, admin prices later)
    const gc = Number(guest_count) || 50;
    const dh = Number(event_duration_hours) || 4;
    const nb = Number(num_bars) || 0;
    const snapshot = isTopShelfClass
      ? null
      : calculateProposal({
          pkg: pkgResult.rows[0],
          guestCount: gc,
          durationHours: dh,
          numBars: nb,
          addons,
          syrupSelections: syrup_selections || [],
        });

    const proposalStatus = isTopShelfClass ? 'draft' : 'sent';
    const snapshotJson = snapshot ? JSON.stringify(snapshot) : '{}';
    const totalPrice = snapshot ? snapshot.total : 0;
    const numBartenders = snapshot ? snapshot.staffing.actual : 1;

    // Insert proposal
    const glasswareNote = client_provides_glassware ? 'Client will provide their own glassware (for Flavor Blaster)' : null;
    const proposalResult = await dbClient.query(`
      INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
        event_location, guest_count, package_id, num_bars, num_bartenders, pricing_snapshot, total_price, status,
        event_type, event_type_category, event_type_custom, admin_notes, class_options)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *
    `, [
      finalClientId, event_date || null,
      event_start_time || null, dh, event_location || null, gc, package_id, nb,
      numBartenders, snapshotJson, totalPrice, proposalStatus,
      event_type || null, event_type_category || null, event_type_custom || null,
      glasswareNote,
      cleanClassOptions ? JSON.stringify(cleanClassOptions) : null
    ]);

    const proposal = proposalResult.rows[0];

    // Insert proposal add-ons — single bulk INSERT instead of N round-trips.
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
      ? { source: 'website_quote_wizard', total: snapshot.total, package: snapshot.package.name }
      : { source: 'website_quote_wizard', top_shelf_requested: true, package: pkgResult.rows[0].name, spirit_category: cleanClassOptions?.spirit_category || null };
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'created', 'client', $2)`,
      [proposal.id, JSON.stringify(logDetails)]
    );

    // Mark any active quote draft as completed
    await dbClient.query(
      `UPDATE quote_drafts SET status = 'completed', completed_at = NOW()
       WHERE email = $1 AND status = 'draft'`,
      [client_email.trim().toLowerCase()]
    );

    // Unenroll from abandoned quote sequence
    await dbClient.query(
      `UPDATE email_sequence_enrollments SET status = 'completed', completed_at = NOW()
       WHERE lead_id IN (SELECT id FROM email_leads WHERE email = $1)
         AND campaign_id IN (SELECT id FROM email_campaigns WHERE name = 'Abandoned Quote Followup' AND type = 'sequence')
         AND status = 'active'`,
      [client_email.trim().toLowerCase()]
    );

    await dbClient.query('COMMIT');

    // Send email notifications (non-blocking)
    try {
      const adminEmail = process.env.ADMIN_EMAIL;
      const adminUrl = `${ADMIN_URL}/admin/proposals/${proposal.id}`;

      if (isTopShelfClass) {
        // Top Shelf: admin-only alert (pricing is TBD). Client already saw
        // "we'll follow up with custom pricing" on the wizard success screen.
        if (adminEmail) {
          const tpl = emailTemplates.topShelfClassRequestAdmin({
            clientName: client_name.trim(),
            clientEmail: client_email.trim().toLowerCase(),
            clientPhone: client_phone || null,
            spiritCategory: cleanClassOptions?.spirit_category || null,
            guestCount: gc,
            eventDate: event_date || null,
            eventLocation: event_location || null,
            proposalId: proposal.id,
            adminUrl,
          });
          await sendEmail({ to: adminEmail, ...tpl });
        }
      } else {
        const proposalUrl = `${PUBLIC_SITE_URL}/proposal/${proposal.token}`;
        const eventTypeLabel = getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom });
        const tpl = emailTemplates.proposalSent({ clientName: client_name.trim(), eventTypeLabel, proposalUrl });
        await sendEmail({ to: client_email.trim().toLowerCase(), ...tpl });

        if (adminEmail) {
          const tpl2 = emailTemplates.clientSignedAdmin({
            clientName: client_name.trim(),
            eventTypeLabel,
            proposalId: proposal.id,
            adminUrl
          });
          await sendEmail({ to: adminEmail, subject: `New Website Quote: ${eventTypeLabel}`, html: tpl2.html });
        }
      }
    } catch (emailErr) {
      Sentry.captureException(emailErr, { tags: { route: 'proposals/public/submit', phase: 'email' } });
      console.error('Public proposal emails failed (non-blocking):', emailErr);
    }

    res.status(201).json({ token: proposal.token, total: snapshot ? snapshot.total : 0, top_shelf: isTopShelfClass });
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err;
  } finally {
    dbClient.release();
  }
}));

// ─── Package & add-on listing (auth required) ────────────────────

/** GET /api/proposals/packages — list active packages */
router.get('/packages', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM service_packages WHERE is_active = true ORDER BY sort_order'
  );
  res.json(result.rows);
}));

/** GET /api/proposals/addons — list active add-ons */
router.get('/addons', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM service_addons WHERE is_active = true ORDER BY sort_order'
  );
  res.json(result.rows);
}));

/** POST /api/proposals/calculate — preview pricing without saving */
router.post('/calculate', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { package_id, guest_count, duration_hours, num_bars, num_bartenders, addon_ids, addon_variants, syrup_selections, adjustments, total_price_override } = req.body;
  if (!package_id) {
    throw new ValidationError({ package_id: 'Package is required' });
  }

  const pkgResult = await pool.query('SELECT * FROM service_packages WHERE id = $1', [package_id]);
  if (!pkgResult.rows[0]) {
    throw new ValidationError({ package_id: 'Package not found' });
  }

  let addons = [];
  if (addon_ids && addon_ids.length > 0) {
    const addonResult = await pool.query(
      'SELECT * FROM service_addons WHERE id = ANY($1) AND is_active = true',
      [addon_ids]
    );
    addons = addonResult.rows.map(a => ({
      ...a,
      variant: addon_variants?.[String(a.id)] || null,
    }));
  }

  const snapshot = calculateProposal({
    pkg: pkgResult.rows[0],
    guestCount: guest_count || 50,
    durationHours: duration_hours || 4,
    numBars: num_bars ?? 1,
    numBartenders: num_bartenders,
    addons,
    syrupSelections: syrup_selections || [],
    adjustments: adjustments || [],
    totalPriceOverride: total_price_override ?? null,
  });

  res.json(snapshot);
}));

// ─── Financials ─────────────────────────────────────────────────

/** GET /api/proposals/financials — aggregate financial data */
router.get('/financials', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  const [summaryResult, proposalsResult, paymentsResult] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(total_price), 0) AS total_revenue,
        COALESCE(SUM(amount_paid), 0) AS total_collected,
        COALESCE(SUM(total_price - COALESCE(amount_paid, 0)), 0) AS total_outstanding
      FROM proposals
      WHERE status IN ('deposit_paid', 'balance_paid', 'confirmed', 'completed')
    `),
    pool.query(`
      SELECT p.id, p.event_type, p.event_type_custom, p.event_date, p.total_price, p.amount_paid,
             p.deposit_amount, p.status, p.created_at,
             c.name AS client_name, c.email AS client_email,
             sp.name AS package_name
      FROM proposals p
      LEFT JOIN clients c ON c.id = p.client_id
      LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.status NOT IN ('draft')
      ORDER BY p.event_date DESC NULLS LAST
      LIMIT $1 OFFSET $2
    `, [limit, offset]),
    pool.query(`
      SELECT pp.id, pp.proposal_id, pp.payment_type, pp.amount, pp.status AS payment_status,
             pp.created_at, p.event_type, p.event_type_custom, c.name AS client_name,
             ip.invoice_id, i.token AS invoice_token
      FROM proposal_payments pp
      JOIN proposals p ON p.id = pp.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      LEFT JOIN invoice_payments ip ON ip.payment_id = pp.id
      LEFT JOIN invoices i ON i.id = ip.invoice_id
      WHERE pp.status = 'succeeded'
      ORDER BY pp.created_at DESC
      LIMIT 20
    `)
  ]);

  res.json({
    summary: summaryResult.rows[0],
    proposals: proposalsResult.rows,
    recentPayments: paymentsResult.rows
  });
}));

/** GET /api/proposals/dashboard-stats — aggregates that the admin home dashboard renders.
 *  Server-side so totals stay accurate past the 50-row default LIMIT on /api/proposals. */
router.get('/dashboard-stats', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const PAID_STATUSES = "('deposit_paid', 'balance_paid', 'confirmed', 'completed')";
  const PIPELINE_STATUSES = "('draft', 'sent', 'viewed', 'modified', 'accepted')";

  const [totalsResult, pipelineResult, revenueResult] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(total_price), 0)::float8 AS booked,
        COALESCE(SUM(amount_paid), 0)::float8 AS collected,
        COALESCE(SUM(GREATEST(total_price - COALESCE(amount_paid, 0), 0)), 0)::float8 AS outstanding,
        COUNT(*)::int AS events_count,
        COUNT(*) FILTER (WHERE total_price > COALESCE(amount_paid, 0))::int AS events_owing_balance
      FROM proposals
      WHERE status IN ${PAID_STATUSES}
    `),
    pool.query(`
      SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_price), 0)::float8 AS value
      FROM proposals
      WHERE status IN ${PIPELINE_STATUSES}
      GROUP BY status
    `),
    pool.query(`
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', NOW() - INTERVAL '11 months'),
          date_trunc('month', NOW()),
          INTERVAL '1 month'
        )::date AS month_start
      )
      SELECT
        to_char(m.month_start, 'YYYY-MM') AS key,
        to_char(m.month_start, 'Mon')     AS m,
        COALESCE(SUM(p.total_price), 0)::float8 AS booked,
        COALESCE(SUM(p.amount_paid), 0)::float8 AS collected
      FROM months m
      LEFT JOIN proposals p
        ON date_trunc('month', p.event_date)::date = m.month_start
        AND p.status IN ${PAID_STATUSES}
      GROUP BY m.month_start
      ORDER BY m.month_start
    `),
  ]);

  // Hydrate pipeline keys for any active status with no rows so the client always
  // receives the full set in display order.
  const PIPELINE_ORDER = [
    { key: 'draft',    label: 'Draft' },
    { key: 'sent',     label: 'Sent' },
    { key: 'viewed',   label: 'Viewed' },
    { key: 'modified', label: 'Modified' },
    { key: 'accepted', label: 'Accepted' },
  ];
  const pipelineByStatus = Object.fromEntries(
    pipelineResult.rows.map(r => [r.status, { count: r.count, value: r.value }])
  );
  const pipeline = PIPELINE_ORDER.map(b => ({
    key: b.key,
    label: b.label,
    count: pipelineByStatus[b.key]?.count || 0,
    value: pipelineByStatus[b.key]?.value || 0,
  }));

  res.json({
    totals: totalsResult.rows[0],
    pipeline,
    revenue: revenueResult.rows,
  });
}));

// ─── Admin CRUD ──────────────────────────────────────────────────

/** GET /api/proposals — list all proposals. Explicit column list — do NOT ship
 *  pricing_snapshot / admin_notes / questionnaire_data / signature_data / stripe_*
 *  to list responses (blobs, PII, can each be 10-50 KB × 50 rows = 2.5 MB). */
router.get('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { status, search, page = 1, limit = 50 } = req.query;
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

  if (status) {
    params.push(status);
    query += ` AND p.status = $${params.length}`;
  } else {
    // By default, exclude paid statuses (those appear in Events instead) and
    // cancelled (the archive endpoint — only reachable when explicitly filtered).
    query += ` AND p.status NOT IN ('deposit_paid', 'balance_paid', 'confirmed', 'cancelled')`;
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
       sent_at     = CASE WHEN $1 = 'sent'     THEN COALESCE(sent_at, NOW())     ELSE sent_at END,
       accepted_at = CASE WHEN $1 = 'accepted' THEN COALESCE(accepted_at, NOW()) ELSE accepted_at END
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
      const adminUrl = `${ADMIN_URL}/admin/proposals/${proposal.id}`;
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
