const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { calculateProposal } = require('../utils/pricingEngine');
const { createEventShifts, createDrinkPlan } = require('../utils/eventCreation');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'manager') return next();
  return res.status(403).json({ error: 'Admin access required.' });
}

// ─── Public routes (token-based) ─────────────────────────────────

/** GET /api/proposals/t/:token — fetch proposal by token (public) */
router.get('/t/:token', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, sp.name AS package_name, sp.slug AS package_slug, sp.category AS package_category,
             sp.includes AS package_includes, c.name AS client_name, c.email AS client_email, c.phone AS client_phone
      FROM proposals p
      LEFT JOIN service_packages sp ON sp.id = p.package_id
      LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.token = $1
    `, [req.params.token]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });

    const proposal = result.rows[0];

    // Track views and flip status
    const updates = ['view_count = view_count + 1', 'last_viewed_at = NOW()'];
    if (proposal.status === 'sent') updates.push("status = 'viewed'");
    await pool.query(`UPDATE proposals SET ${updates.join(', ')} WHERE id = $1`, [proposal.id]);

    // Fetch add-ons
    const addons = await pool.query(
      'SELECT * FROM proposal_addons WHERE proposal_id = $1 ORDER BY id',
      [proposal.id]
    );

    // Capture IP and attempt geo lookup
    const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
    const ip = rawIp.replace(/^::ffff:/, ''); // strip IPv4-mapped prefix
    let location = null;
    if (ip && ip !== '::1' && ip !== '127.0.0.1') {
      try {
        const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName`);
        const geo = await geoRes.json();
        if (geo.status === 'success' && geo.city) {
          location = `${geo.city}, ${geo.regionName}`;
        }
      } catch { /* geo lookup is best-effort */ }
    }

    // Log view
    await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'viewed', 'client', $2)`,
      [proposal.id, JSON.stringify({ ip: ip || null, location })]
    );

    res.json({ ...proposal, addons: addons.rows, status: proposal.status === 'sent' ? 'viewed' : proposal.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

const PROPOSAL_DOCUMENT_VERSION = 'event-services-agreement-v2';

/** POST /api/proposals/t/:token/sign — client signs and accepts proposal */
router.post('/t/:token/sign', async (req, res) => {
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
router.get('/public/packages', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, slug, category, description, pricing_type, includes,
              base_rate_3hr, base_rate_4hr, base_rate_3hr_small, base_rate_4hr_small,
              extra_hour_rate, extra_hour_rate_small, min_guests,
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
router.get('/public/addons', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, slug, billing_type, rate, extra_hour_rate, minimum_hours, applies_to
       FROM service_addons WHERE is_active = true ORDER BY sort_order`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/proposals/public/calculate — preview pricing (public, no save) */
router.post('/public/calculate', async (req, res) => {
  const { package_id, guest_count, duration_hours, num_bars, addon_ids } = req.body;
  try {
    const pkgResult = await pool.query('SELECT * FROM service_packages WHERE id = $1 AND is_active = true', [package_id]);
    if (!pkgResult.rows[0]) return res.status(400).json({ error: 'Package not found.' });

    let addons = [];
    if (addon_ids && addon_ids.length > 0) {
      const addonResult = await pool.query(
        'SELECT * FROM service_addons WHERE id = ANY($1) AND is_active = true',
        [addon_ids]
      );
      addons = addonResult.rows;
    }

    const snapshot = calculateProposal({
      pkg: pkgResult.rows[0],
      guestCount: guest_count || 50,
      durationHours: duration_hours || 4,
      numBars: num_bars ?? 0,
      addons
    });

    res.json(snapshot);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/proposals/public/submit — create a proposal from the public website quote wizard */
router.post('/public/submit', async (req, res) => {
  const {
    client_name, client_email, client_phone,
    event_name, event_date, event_start_time, event_duration_hours,
    event_location, guest_count, package_id, num_bars, addon_ids
  } = req.body;

  if (!client_name || !client_name.trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!client_email || !client_email.trim()) return res.status(400).json({ error: 'Email is required.' });
  if (!package_id) return res.status(400).json({ error: 'Package is required.' });
  if (!guest_count || guest_count < 1) return res.status(400).json({ error: 'Guest count is required.' });

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // Create or find existing client by email
    let clientResult = await dbClient.query(
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
      addons = addonResult.rows;
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
      addons
    });

    // Insert proposal
    const proposalResult = await dbClient.query(`
      INSERT INTO proposals (client_id, event_name, event_date, event_start_time, event_duration_hours,
        event_location, guest_count, package_id, num_bars, num_bartenders, pricing_snapshot, total_price, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'sent')
      RETURNING *
    `, [
      finalClientId, event_name || `${client_name.trim()}'s Event`, event_date || null,
      event_start_time || null, dh, event_location || null, gc, package_id, nb,
      snapshot.staffing.actual, JSON.stringify(snapshot), snapshot.total
    ]);

    const proposal = proposalResult.rows[0];

    // Insert proposal add-ons
    for (const addon of snapshot.addons) {
      await dbClient.query(`
        INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [proposal.id, addon.id, addon.name, addon.billing_type, addon.rate, addon.quantity, addon.line_total]);
    }

    // Log creation
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'created', 'client', $2)`,
      [proposal.id, JSON.stringify({ source: 'website_quote_wizard', total: snapshot.total, package: snapshot.package.name })]
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
router.get('/packages', auth, requireAdmin, async (req, res) => {
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
router.get('/addons', auth, requireAdmin, async (req, res) => {
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
router.post('/calculate', auth, requireAdmin, async (req, res) => {
  const { package_id, guest_count, duration_hours, num_bars, num_bartenders, addon_ids } = req.body;
  try {
    const pkgResult = await pool.query('SELECT * FROM service_packages WHERE id = $1', [package_id]);
    if (!pkgResult.rows[0]) return res.status(400).json({ error: 'Package not found.' });

    let addons = [];
    if (addon_ids && addon_ids.length > 0) {
      const addonResult = await pool.query(
        'SELECT * FROM service_addons WHERE id = ANY($1) AND is_active = true',
        [addon_ids]
      );
      addons = addonResult.rows;
    }

    const snapshot = calculateProposal({
      pkg: pkgResult.rows[0],
      guestCount: guest_count || 50,
      durationHours: duration_hours || 4,
      numBars: num_bars ?? 1,
      numBartenders: num_bartenders,
      addons
    });

    res.json(snapshot);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin CRUD ──────────────────────────────────────────────────

/** GET /api/proposals — list all proposals */
router.get('/', auth, requireAdmin, async (req, res) => {
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
router.post('/', auth, requireAdmin, async (req, res) => {
  const {
    client_id, client_name, client_email, client_phone, client_source,
    event_name, event_date, event_start_time, event_duration_hours,
    event_location, guest_count, package_id, num_bars, num_bartenders, addon_ids
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
      addons = addonResult.rows;
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
      addons
    });

    // Insert proposal
    const proposalResult = await dbClient.query(`
      INSERT INTO proposals (client_id, event_name, event_date, event_start_time, event_duration_hours,
        event_location, guest_count, package_id, num_bars, num_bartenders, pricing_snapshot, total_price, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [
      finalClientId, event_name || null, event_date || null, event_start_time || null, dh,
      event_location || null, gc, package_id, nb,
      snapshot.staffing.actual, JSON.stringify(snapshot), snapshot.total, req.user.id
    ]);

    const proposal = proposalResult.rows[0];

    // Insert proposal add-ons
    for (const addon of snapshot.addons) {
      await dbClient.query(`
        INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [proposal.id, addon.id, addon.name, addon.billing_type, addon.rate, addon.quantity, addon.line_total]);
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
router.get('/:id', auth, requireAdmin, async (req, res) => {
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
    const activity = await pool.query(
      'SELECT * FROM proposal_activity_log WHERE proposal_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );

    res.json({ ...result.rows[0], addons: addons.rows, activity: activity.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PATCH /api/proposals/:id — update event details and recalculate */
router.patch('/:id', auth, requireAdmin, async (req, res) => {
  const {
    event_name, event_date, event_start_time, event_duration_hours,
    event_location, guest_count, package_id, num_bars, num_bartenders, addon_ids
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
      addons = addonResult.rows;
    }

    const gc = guest_count ?? old.guest_count;
    const dh = event_duration_hours ?? Number(old.event_duration_hours);
    const nb = num_bars ?? old.num_bars;
    const snapshot = calculateProposal({
      pkg: pkgResult.rows[0], guestCount: gc, durationHours: dh, numBars: nb,
      numBartenders: num_bartenders, addons
    });

    await dbClient.query(`
      UPDATE proposals SET
        event_name = COALESCE($1, event_name), event_date = COALESCE($2, event_date),
        event_start_time = COALESCE($3, event_start_time), event_duration_hours = $4,
        event_location = COALESCE($5, event_location), guest_count = $6,
        package_id = $7, num_bars = $8, num_bartenders = $9,
        pricing_snapshot = $10, total_price = $11
      WHERE id = $12
    `, [
      event_name, event_date, event_start_time, dh, event_location, gc,
      pkgId, nb, snapshot.staffing.actual,
      JSON.stringify(snapshot), snapshot.total, req.params.id
    ]);

    // Replace proposal add-ons
    await dbClient.query('DELETE FROM proposal_addons WHERE proposal_id = $1', [req.params.id]);
    for (const addon of snapshot.addons) {
      await dbClient.query(`
        INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [req.params.id, addon.id, addon.name, addon.billing_type, addon.rate, addon.quantity, addon.line_total]);
    }

    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, 'updated', 'admin', $2, $3)`,
      [req.params.id, req.user.id, JSON.stringify({ new_total: snapshot.total })]
    );

    await dbClient.query('COMMIT');

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
router.patch('/:id/status', auth, requireAdmin, async (req, res) => {
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

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PATCH /api/proposals/:id/notes — update admin notes */
router.patch('/:id/notes', auth, requireAdmin, async (req, res) => {
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
router.post('/:id/create-shift', auth, requireAdmin, async (req, res) => {
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
router.patch('/:id/balance-due-date', auth, requireAdmin, async (req, res) => {
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
router.post('/:id/record-payment', auth, requireAdmin, async (req, res) => {
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

    await pool.query(
      'UPDATE proposals SET amount_paid = $1, status = $2 WHERE id = $3',
      [newAmountPaid, newStatus, proposal.id]
    );

    // Record in proposal_payments
    await pool.query(
      `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status)
       VALUES ($1, $2, $3, 'succeeded')`,
      [proposal.id, isFullyPaid ? 'full' : 'deposit', Math.round(paymentAmount * 100)]
    );

    // Log activity
    await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, $2, 'admin', $3, $4)`,
      [proposal.id, isFullyPaid ? 'paid_in_full' : 'deposit_paid', req.user.id,
        JSON.stringify({ amount: paymentAmount, method: method || 'manual', new_total_paid: newAmountPaid })]
    );

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
router.delete('/:id', auth, requireAdmin, async (req, res) => {
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
