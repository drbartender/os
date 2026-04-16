const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { publicLimiter, publicReadLimiter } = require('../middleware/rateLimiters');
const { calculateProposal } = require('../utils/pricingEngine');
const { createEventShifts, createDrinkPlan } = require('../utils/eventCreation');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');
const { createInvoiceOnSend, refreshUnlockedInvoices, createAdditionalInvoiceIfNeeded, linkPaymentToInvoice } = require('../utils/invoiceHelpers');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FORM_STATE_SIZE = 50 * 1024; // 50 KB

// ─── Public routes (token-based) ─────────────────────────────────

/** GET /api/proposals/t/:token — fetch proposal by token (public) */
router.get('/t/:token', publicLimiter, async (req, res) => {
  try {
    // Public-safe column allowlist — do NOT expose admin_notes, stripe_customer_id,
    // stripe_payment_method_id, client_signature_ip, client_signature_user_agent,
    // created_by, or other internal fields.
    const result = await pool.query(`
      SELECT
        p.id, p.token, p.client_id,
        p.event_name, p.event_date, p.event_start_time, p.event_duration_hours,
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

    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });

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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

const PROPOSAL_DOCUMENT_VERSION = 'event-services-agreement-v2';

/** POST /api/proposals/t/:token/sign — client signs and accepts proposal */
router.post('/t/:token/sign', publicLimiter, async (req, res) => {
  const { client_signed_name, client_signature_data, client_signature_method } = req.body;
  if (!client_signed_name || !client_signature_data) {
    return res.status(400).json({ error: 'Name and signature are required.' });
  }
  if (client_signature_method !== 'draw' && client_signature_method !== 'type') {
    return res.status(400).json({ error: 'Invalid signature method.' });
  }
  try {
    const result = await pool.query(
      "SELECT id, status FROM proposals WHERE token = $1",
      [req.params.token]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });

    const proposal = result.rows[0];
    if (['deposit_paid', 'balance_paid', 'confirmed'].includes(proposal.status)) {
      return res.status(400).json({ error: 'Proposal has already been paid.' });
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
    try {
      const fp = await pool.query(`
        SELECT p.id, p.event_name, c.name AS client_name, c.email AS client_email
        FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1
      `, [proposal.id]);
      const pd = fp.rows[0];
      if (pd?.client_email) {
        const tpl = emailTemplates.proposalSignedConfirmation({ clientName: pd.client_name, eventName: pd.event_name });
        await sendEmail({ to: pd.client_email, ...tpl });
      }
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail && pd) {
        const clientUrl = process.env.CLIENT_URL || 'https://admin.drbartender.com';
        const adminUrl = `${clientUrl}/admin/proposals/${pd.id}`;
        const tpl = emailTemplates.clientSignedAdmin({ clientName: pd.client_name, eventName: pd.event_name, proposalId: pd.id, adminUrl });
        await sendEmail({ to: adminEmail, ...tpl });
      }
    } catch (emailErr) {
      console.error('Proposal sign emails failed (non-blocking):', emailErr);
    }

    res.json({ success: true, status: 'accepted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Public website endpoints (no auth) ─────────────────────────

/** GET /api/proposals/public/packages — list active packages (public, limited fields) */
router.get('/public/packages', publicLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, slug, category, bar_type, description, pricing_type, includes,
              base_rate_3hr, base_rate_4hr, base_rate_3hr_small, base_rate_4hr_small,
              extra_hour_rate, extra_hour_rate_small, min_guests, min_total,
              guests_per_bartender, bartenders_included, extra_bartender_hourly,
              first_bar_fee, additional_bar_fee
       FROM service_packages WHERE is_active = true ORDER BY sort_order`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/proposals/public/addons — list active add-ons (public, limited fields) */
router.get('/public/addons', publicLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, slug, description, billing_type, rate, extra_hour_rate, applies_to, category, requires_addon_slug
       FROM service_addons WHERE is_active = true ORDER BY sort_order`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/proposals/public/calculate — preview pricing (public, no save) */
router.post('/public/calculate', publicLimiter, async (req, res) => {
  const { package_id, guest_count, duration_hours, num_bars, addon_ids, addon_quantities, syrup_selections } = req.body;
  try {
    const pkgResult = await pool.query('SELECT * FROM service_packages WHERE id = $1 AND is_active = true', [package_id]);
    if (!pkgResult.rows[0]) return res.status(400).json({ error: 'Package not found.' });

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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/proposals/public/capture-lead — capture partial lead from quote wizard + create draft */
router.post('/public/capture-lead', publicLimiter, async (req, res) => {
  const dbClient = await pool.connect();
  try {
    const { name, email, phone, guest_count, event_date, source, form_state, current_step } = req.body;
    if (!email || !email.trim()) {
      dbClient.release();
      return res.status(400).json({ error: 'Email is required' });
    }
    const cleanEmail = email.trim().toLowerCase();
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
      console.error('Abandoned quote enrollment error (non-blocking):', enrollErr.message);
    }

    res.json({ ok: true, draft_token: draftToken });
  } catch (err) {
    await dbClient.query('ROLLBACK').catch(() => {});
    console.error('Lead capture error:', err.message);
    res.status(500).json({ ok: false });
  } finally {
    dbClient.release();
  }
});

/** GET /api/proposals/public/quote-draft/:token — fetch saved draft for resume */
router.get('/public/quote-draft/:token', publicReadLimiter, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.token)) return res.status(404).json({ error: 'Draft not found' });
    const result = await pool.query(
      `SELECT token, form_state, current_step FROM quote_drafts
       WHERE token = $1 AND status = 'draft' AND updated_at > NOW() - INTERVAL '30 days'`,
      [req.params.token]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Draft not found or expired' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fetch quote draft error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /api/proposals/public/quote-draft/:token — auto-save draft state */
router.put('/public/quote-draft/:token', publicReadLimiter, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.token)) return res.status(404).json({ error: 'Draft not found' });
    const { form_state, current_step } = req.body;
    if (!form_state || typeof form_state !== 'object') return res.status(400).json({ error: 'Invalid form state' });
    const safeStep = Math.max(0, Math.min(10, parseInt(current_step, 10) || 0));
    const serialized = JSON.stringify(form_state);
    if (serialized.length > MAX_FORM_STATE_SIZE) return res.status(400).json({ error: 'Form state too large' });
    const result = await pool.query(
      `UPDATE quote_drafts SET form_state = $1, current_step = $2, updated_at = NOW()
       WHERE token = $3 AND status = 'draft'
       RETURNING token`,
      [serialized, safeStep, req.params.token]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Draft not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Save quote draft error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/proposals/public/submit — create a proposal from the public website quote wizard */
router.post('/public/submit', publicLimiter, async (req, res) => {
  const {
    client_name, client_email, client_phone,
    event_name, event_date, event_start_time, event_duration_hours,
    event_location, guest_count, package_id, num_bars, addon_ids,
    addon_quantities, syrup_selections,
    event_type, event_type_category, event_type_custom,
    client_provides_glassware
  } = req.body;

  if (!client_name || !client_name.trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!client_email || !client_email.trim()) return res.status(400).json({ error: 'Email is required.' });
  if (!package_id) return res.status(400).json({ error: 'Package is required.' });
  if (!guest_count || guest_count < 1) return res.status(400).json({ error: 'Guest count is required.' });

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
      await dbClient.query('ROLLBACK');
      return res.status(400).json({ error: 'Package not found.' });
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
        quantity: addon_quantities?.[String(a.id)] || 1,
      }));
    }

    // Calculate pricing
    const gc = Number(guest_count) || 50;
    const dh = Number(event_duration_hours) || 4;
    const nb = Number(num_bars) || 0;
    const snapshot = calculateProposal({
      pkg: pkgResult.rows[0],
      guestCount: gc,
      durationHours: dh,
      numBars: nb,
      addons,
      syrupSelections: syrup_selections || [],
    });

    // Derive event_name from event type (client name is prepended at display time)
    const eventTypeLabel = event_type_custom || event_type || null;
    const derivedEventName = event_name || eventTypeLabel || `${client_name.trim()}'s Event`;

    // Insert proposal
    const glasswareNote = client_provides_glassware ? 'Client will provide their own glassware (for Flavor Blaster)' : null;
    const proposalResult = await dbClient.query(`
      INSERT INTO proposals (client_id, event_name, event_date, event_start_time, event_duration_hours,
        event_location, guest_count, package_id, num_bars, num_bartenders, pricing_snapshot, total_price, status,
        event_type, event_type_category, event_type_custom, admin_notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'sent',$13,$14,$15,$16)
      RETURNING *
    `, [
      finalClientId, derivedEventName, event_date || null,
      event_start_time || null, dh, event_location || null, gc, package_id, nb,
      snapshot.staffing.actual, JSON.stringify(snapshot), snapshot.total,
      eventTypeLabel || null, event_type_category || null, event_type_custom || null,
      glasswareNote
    ]);

    const proposal = proposalResult.rows[0];

    // Insert proposal add-ons
    for (const addon of snapshot.addons) {
      await dbClient.query(`
        INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [proposal.id, addon.id, addon.name, addon.billing_type, addon.rate, addon.quantity, addon.line_total, addon.variant || null]);
    }

    // Log creation
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'created', 'client', $2)`,
      [proposal.id, JSON.stringify({ source: 'website_quote_wizard', total: snapshot.total, package: snapshot.package.name })]
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
      const clientUrl = process.env.CLIENT_URL || 'https://www.drbartender.com';
      const proposalUrl = `${clientUrl}/proposal/${proposal.token}`;
      const tpl = emailTemplates.proposalSent({ clientName: client_name.trim(), eventName: proposal.event_name, proposalUrl });
      await sendEmail({ to: client_email.trim().toLowerCase(), ...tpl });

      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        const adminUrl = `${clientUrl}/admin/proposals/${proposal.id}`;
        const tpl2 = emailTemplates.clientSignedAdmin({
          clientName: client_name.trim(),
          eventName: proposal.event_name,
          proposalId: proposal.id,
          adminUrl
        });
        await sendEmail({ to: adminEmail, subject: `New Website Quote: ${proposal.event_name}`, html: tpl2.html });
      }
    } catch (emailErr) {
      console.error('Public proposal emails failed (non-blocking):', emailErr);
    }

    res.status(201).json({ token: proposal.token, total: snapshot.total });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    dbClient.release();
  }
});

// ─── Package & add-on listing (auth required) ────────────────────

/** GET /api/proposals/packages — list active packages */
router.get('/packages', auth, requireAdminOrManager, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM service_packages WHERE is_active = true ORDER BY sort_order'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/proposals/addons — list active add-ons */
router.get('/addons', auth, requireAdminOrManager, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM service_addons WHERE is_active = true ORDER BY sort_order'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/proposals/calculate — preview pricing without saving */
router.post('/calculate', auth, requireAdminOrManager, async (req, res) => {
  const { package_id, guest_count, duration_hours, num_bars, num_bartenders, addon_ids, addon_variants, syrup_selections, adjustments, total_price_override } = req.body;
  try {
    const pkgResult = await pool.query('SELECT * FROM service_packages WHERE id = $1', [package_id]);
    if (!pkgResult.rows[0]) return res.status(400).json({ error: 'Package not found.' });

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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Financials ─────────────────────────────────────────────────

/** GET /api/proposals/financials — aggregate financial data */
router.get('/financials', auth, requireAdminOrManager, async (req, res) => {
  try {
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
        SELECT p.id, p.event_name, p.event_date, p.total_price, p.amount_paid,
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
               pp.created_at, p.event_name, c.name AS client_name,
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
  } catch (err) {
    console.error('Financials error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin CRUD ──────────────────────────────────────────────────

/** GET /api/proposals — list all proposals */
router.get('/', auth, requireAdminOrManager, async (req, res) => {
  const { status, search, page = 1, limit = 50 } = req.query;
  try {
    let query = `
      SELECT p.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
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
      // By default, exclude paid statuses — those appear in Events instead
      query += ` AND p.status NOT IN ('deposit_paid', 'balance_paid', 'confirmed')`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (c.name ILIKE $${params.length} OR p.event_name ILIKE $${params.length} OR c.email ILIKE $${params.length})`;
    }

    query += ' ORDER BY p.created_at DESC';
    params.push(Number(limit));
    query += ` LIMIT $${params.length}`;
    params.push((Number(page) - 1) * Number(limit));
    query += ` OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/proposals — create a new proposal */
router.post('/', auth, requireAdminOrManager, async (req, res) => {
  const {
    client_id, client_name, client_email, client_phone, client_source,
    event_name, event_date, event_start_time, event_duration_hours,
    event_location, guest_count, package_id, num_bars, num_bartenders, addon_ids,
    addon_variants, syrup_selections, event_type, event_type_category, event_type_custom
  } = req.body;

  if (!package_id) return res.status(400).json({ error: 'Package is required.' });

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
      await dbClient.query('ROLLBACK');
      return res.status(400).json({ error: 'Package not found.' });
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
      INSERT INTO proposals (client_id, event_name, event_date, event_start_time, event_duration_hours,
        event_location, guest_count, package_id, num_bars, num_bartenders, pricing_snapshot, total_price, created_by,
        event_type, event_type_category, event_type_custom)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *
    `, [
      finalClientId, event_name || null, event_date || null, event_start_time || null, dh,
      event_location || null, gc, package_id, nb,
      snapshot.staffing.actual, JSON.stringify(snapshot), snapshot.total, req.user.id,
      event_type || null, event_type_category || null, event_type_custom || null
    ]);

    const proposal = proposalResult.rows[0];

    // Insert proposal add-ons
    for (const addon of snapshot.addons) {
      await dbClient.query(`
        INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [proposal.id, addon.id, addon.name, addon.billing_type, addon.rate, addon.quantity, addon.line_total, addon.variant || null]);
    }

    // Log creation
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, 'created', 'admin', $2, $3)`,
      [proposal.id, req.user.id, JSON.stringify({ total: snapshot.total, package: snapshot.package.name })]
    );

    await dbClient.query('COMMIT');
    res.status(201).json(proposal);
  } catch (err) {
    await dbClient.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    dbClient.release();
  }
});

/** GET /api/proposals/:id — get single proposal */
router.get('/:id', auth, requireAdminOrManager, async (req, res) => {
  try {
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

    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });

    const addons = await pool.query(
      'SELECT * FROM proposal_addons WHERE proposal_id = $1 ORDER BY id',
      [req.params.id]
    );
    // Cap activity log fetch at 100 entries (most recent) — an old proposal can
    // accumulate hundreds of view/update entries otherwise.
    const activity = await pool.query(
      'SELECT * FROM proposal_activity_log WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.params.id]
    );

    res.json({ ...result.rows[0], addons: addons.rows, activity: activity.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PATCH /api/proposals/:id — update event details and recalculate */
router.patch('/:id', auth, requireAdminOrManager, async (req, res) => {
  const {
    event_name, event_date, event_start_time, event_duration_hours,
    event_location, guest_count, package_id, num_bars, num_bartenders, addon_ids,
    addon_variants, syrup_selections, event_type, event_type_category, event_type_custom,
    adjustments, total_price_override
  } = req.body;

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const existing = await dbClient.query('SELECT * FROM proposals WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) {
      await dbClient.query('ROLLBACK');
      return res.status(404).json({ error: 'Proposal not found.' });
    }
    const old = existing.rows[0];

    const pkgId = package_id || old.package_id;
    const pkgResult = await dbClient.query('SELECT * FROM service_packages WHERE id = $1', [pkgId]);
    if (!pkgResult.rows[0]) {
      await dbClient.query('ROLLBACK');
      return res.status(400).json({ error: 'Package not found.' });
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
    const snapshot = calculateProposal({
      pkg: pkgResult.rows[0], guestCount: gc, durationHours: dh, numBars: nb,
      numBartenders: num_bartenders, addons, syrupSelections: syrups,
      adjustments: adj, totalPriceOverride: tpo,
    });

    await dbClient.query(`
      UPDATE proposals SET
        event_name = COALESCE($1, event_name), event_date = COALESCE($2, event_date),
        event_start_time = COALESCE($3, event_start_time), event_duration_hours = $4,
        event_location = COALESCE($5, event_location), guest_count = $6,
        package_id = $7, num_bars = $8, num_bartenders = $9,
        pricing_snapshot = $10, total_price = $11,
        event_type = COALESCE($13, event_type),
        event_type_category = COALESCE($14, event_type_category),
        event_type_custom = COALESCE($15, event_type_custom),
        adjustments = $16, total_price_override = $17
      WHERE id = $12
    `, [
      event_name, event_date, event_start_time, dh, event_location, gc,
      pkgId, nb, snapshot.staffing.actual,
      JSON.stringify(snapshot), snapshot.total, req.params.id,
      event_type || null, event_type_category || null, event_type_custom || null,
      JSON.stringify(adj), tpo ?? null
    ]);

    // Replace proposal add-ons
    await dbClient.query('DELETE FROM proposal_addons WHERE proposal_id = $1', [req.params.id]);
    for (const addon of snapshot.addons) {
      await dbClient.query(`
        INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [req.params.id, addon.id, addon.name, addon.billing_type, addon.rate, addon.quantity, addon.line_total, addon.variant || null]);
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
      await invClient.query('ROLLBACK');
      console.error('Invoice refresh failed (non-blocking):', invErr);
    } finally {
      invClient.release();
    }

    // Return updated proposal
    const updated = await pool.query('SELECT * FROM proposals WHERE id = $1', [req.params.id]);
    res.json(updated.rows[0]);
  } catch (err) {
    await dbClient.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    dbClient.release();
  }
});

/** PATCH /api/proposals/:id/status — update status */
router.patch('/:id/status', auth, requireAdminOrManager, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['draft', 'sent', 'viewed', 'modified', 'accepted', 'deposit_paid', 'balance_paid', 'confirmed', 'completed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  try {
    const result = await pool.query(
      'UPDATE proposals SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });

    await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, 'status_changed', 'admin', $2, $3)`,
      [req.params.id, req.user.id, JSON.stringify({ new_status: status })]
    );

    // Email client when proposal is sent (non-blocking)
    if (status === 'sent') {
      try {
        const pd = await pool.query(`
          SELECT p.token, p.event_name, p.event_date, p.created_by,
                 c.name AS client_name, c.email AS client_email
          FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
          WHERE p.id = $1
        `, [req.params.id]);
        const p = pd.rows[0];
        if (p?.client_email && p?.token) {
          const clientUrl = process.env.CLIENT_URL || 'https://admin.drbartender.com';
          const proposalUrl = `${clientUrl}/proposal/${p.token}`;

          // Create drink plan and include link in email
          let planUrl = null;
          try {
            const drinkPlan = await createDrinkPlan(req.params.id, {
              client_name: p.client_name,
              client_email: p.client_email,
              event_name: p.event_name,
              event_date: p.event_date,
              created_by: p.created_by,
            }, { skipEmail: true });

            if (drinkPlan?.token) {
              planUrl = `${clientUrl}/plan/${drinkPlan.token}`;
            } else {
              // Already exists — look up existing token
              const existingPlan = await pool.query(
                'SELECT token FROM drink_plans WHERE proposal_id = $1 LIMIT 1',
                [req.params.id]
              );
              if (existingPlan.rows[0]?.token) {
                planUrl = `${clientUrl}/plan/${existingPlan.rows[0].token}`;
              }
            }
          } catch (planErr) {
            console.error('Drink plan creation failed (non-blocking):', planErr);
          }

          const tpl = emailTemplates.proposalSent({ clientName: p.client_name, eventName: p.event_name, proposalUrl, planUrl });
          await sendEmail({ to: p.client_email, ...tpl });
        }
      } catch (emailErr) {
        console.error('Proposal sent email failed (non-blocking):', emailErr);
      }
    }

    // Auto-create first invoice when proposal is sent
    if (status === 'sent') {
      try {
        await createInvoiceOnSend(parseInt(req.params.id, 10));
      } catch (invErr) {
        console.error('Invoice auto-creation failed (non-blocking):', invErr);
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PATCH /api/proposals/:id/notes — update admin notes */
router.patch('/:id/notes', auth, requireAdminOrManager, async (req, res) => {
  const { admin_notes } = req.body;
  try {
    const result = await pool.query(
      'UPDATE proposals SET admin_notes = $1 WHERE id = $2 RETURNING id, admin_notes',
      [admin_notes || '', req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/proposals/:id/create-shift — manually create event shift from a proposal */
router.post('/:id/create-shift', auth, requireAdminOrManager, async (req, res) => {
  try {
    const proposal = await pool.query('SELECT id, status FROM proposals WHERE id = $1', [req.params.id]);
    if (!proposal.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });
    if (!['deposit_paid', 'balance_paid', 'confirmed'].includes(proposal.rows[0].status)) {
      return res.status(400).json({ error: 'Proposal must have deposit paid before creating a shift.' });
    }
    const shift = await createEventShifts(req.params.id);
    if (!shift) return res.status(409).json({ error: 'Shift already exists for this proposal.' });
    res.status(201).json(shift);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PATCH /api/proposals/:id/balance-due-date — override balance due date */
router.patch('/:id/balance-due-date', auth, requireAdminOrManager, async (req, res) => {
  const { balance_due_date } = req.body;
  if (!balance_due_date) {
    return res.status(400).json({ error: 'balance_due_date is required.' });
  }
  try {
    const result = await pool.query(
      'UPDATE proposals SET balance_due_date = $1 WHERE id = $2 RETURNING id, balance_due_date',
      [balance_due_date, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });

    await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, 'balance_due_date_changed', 'admin', $2, $3)`,
      [req.params.id, req.user.id, JSON.stringify({ balance_due_date })]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/proposals/:id/record-payment — manually record an outside payment (cash, Venmo, etc.) */
router.post('/:id/record-payment', auth, requireAdminOrManager, async (req, res) => {
  const { amount, paid_in_full, method } = req.body;

  try {
    const result = await pool.query(
      'SELECT id, total_price, amount_paid, deposit_amount, status FROM proposals WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });

    const proposal = result.rows[0];
    if (['balance_paid', 'confirmed'].includes(proposal.status)) {
      return res.status(400).json({ error: 'Proposal is already fully paid.' });
    }

    const totalPrice = Number(proposal.total_price);
    const currentPaid = Number(proposal.amount_paid || 0);
    const paymentAmount = paid_in_full ? totalPrice - currentPaid : Number(amount);

    if (!paymentAmount || paymentAmount <= 0) {
      return res.status(400).json({ error: 'Invalid payment amount.' });
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
      await dbClient.query('ROLLBACK');
      throw txErr;
    } finally {
      dbClient.release();
    }

    // Email notifications for payment (non-blocking)
    try {
      const payData = await pool.query(`
        SELECT p.event_name, c.name AS client_name, c.email AS client_email
        FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1
      `, [proposal.id]);
      const pd = payData.rows[0];
      const amountFormatted = paymentAmount.toFixed(2);
      const payType = isFullyPaid ? 'full payment' : 'deposit';

      if (pd?.client_email) {
        const tpl = emailTemplates.paymentReceivedClient({ clientName: pd.client_name, eventName: pd.event_name, amount: amountFormatted, paymentType: payType });
        await sendEmail({ to: pd.client_email, ...tpl });
      }
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        const clientUrl = process.env.CLIENT_URL || 'https://admin.drbartender.com';
        const adminUrl = `${clientUrl}/admin/proposals/${proposal.id}`;
        const tpl = emailTemplates.paymentReceivedAdmin({ clientName: pd?.client_name, eventName: pd?.event_name, amount: amountFormatted, paymentType: payType, proposalId: proposal.id, adminUrl });
        await sendEmail({ to: adminEmail, ...tpl });
      }
    } catch (emailErr) {
      console.error('Payment email failed (non-blocking):', emailErr);
    }

    // Auto-create event shift
    try {
      const shift = await createEventShifts(proposal.id);
      if (shift) console.log(`Shift #${shift.id} created for proposal ${proposal.id} (manual payment)`);
    } catch (shiftErr) {
      console.error('Shift auto-creation failed (non-blocking):', shiftErr);
    }

    res.json({ success: true, status: newStatus, amount_paid: newAmountPaid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /api/proposals/:id — delete a proposal */
router.delete('/:id', auth, requireAdminOrManager, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM proposals WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
