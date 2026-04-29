const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { publicLimiter, publicReadLimiter } = require('../../middleware/rateLimiters');
const { calculateProposal } = require('../../utils/pricingEngine');
const { sendEmail } = require('../../utils/email');
const emailTemplates = require('../../utils/emailTemplates');
const { PUBLIC_SITE_URL, ADMIN_URL } = require('../../utils/urls');
const { getEventTypeLabel } = require('../../utils/eventTypes');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FORM_STATE_SIZE = 50 * 1024; // 50 KB

// Mirrors schema CHECK on email_leads.lead_source and emailMarketing.js
// VALID_LEAD_SOURCES. Untrusted public input — anything outside this set
// must be coerced to 'website' or the INSERT 500s on the constraint.
const VALID_LEAD_SOURCES = new Set([
  'manual', 'csv_import', 'website', 'quote_wizard', 'potion_lab',
  'thumbtack', 'referral', 'instagram', 'facebook', 'google', 'other',
]);

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
    const safeSource = VALID_LEAD_SOURCES.has(source) ? source : 'website';
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
        safeSource,
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
      const adminUrl = `${ADMIN_URL}/proposals/${proposal.id}`;

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

module.exports = router;
