const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { calculateProposal } = require('../utils/pricingEngine');
const { createEventShifts } = require('../utils/eventCreation');

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

/** POST /api/proposals/t/:token/sign — client signs and accepts proposal */
router.post('/t/:token/sign', async (req, res) => {
  const { client_signed_name, client_signature_data } = req.body;
  if (!client_signed_name || !client_signature_data) {
    return res.status(400).json({ error: 'Name and signature are required.' });
  }
  try {
    const result = await pool.query(
      "SELECT id, status FROM proposals WHERE token = $1",
      [req.params.token]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });

    const proposal = result.rows[0];
    if (['deposit_paid', 'confirmed'].includes(proposal.status)) {
      return res.status(400).json({ error: 'Proposal has already been paid.' });
    }

    await pool.query(`
      UPDATE proposals SET
        client_signed_name = $1,
        client_signature_data = $2,
        client_signed_at = NOW(),
        status = 'accepted'
      WHERE id = $3
    `, [client_signed_name, client_signature_data, proposal.id]);

    await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'signed', 'client', $2)`,
      [proposal.id, JSON.stringify({ signed_name: client_signed_name })]
    );

    res.json({ success: true, status: 'accepted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
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
      numBars: num_bars || 1,
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
    const nb = num_bars || 1;
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
  const validStatuses = ['draft', 'sent', 'viewed', 'modified', 'accepted', 'deposit_paid', 'confirmed'];
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
    if (!['deposit_paid', 'confirmed'].includes(proposal.rows[0].status)) {
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
