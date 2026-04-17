const express = require('express');
const { pool } = require('../db');
const { clientAuth } = require('../middleware/auth');

const router = express.Router();

// All routes require client auth
router.use(clientAuth);

// GET /api/client-portal/proposals — list client's proposals
router.get('/proposals', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, token, event_type, event_type_custom, event_date, status, total_price, amount_paid, created_at
      FROM proposals
      WHERE client_id = $1
      ORDER BY created_at DESC
    `, [req.user.id]);

    res.json({ proposals: result.rows });
  } catch (err) {
    console.error('Client portal proposals error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/client-portal/proposals/:token — full proposal detail
router.get('/proposals/:token', async (req, res) => {
  try {
    // Public-safe column allowlist — even the client themselves should not see
    // admin_notes, stripe_customer_id, stripe_payment_method_id, or signature IP/UA.
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
        c.name AS client_name, c.email AS client_email, c.phone AS client_phone
      FROM proposals p
      LEFT JOIN service_packages sp ON sp.id = p.package_id
      LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.token = $1 AND p.client_id = $2
    `, [req.params.token, req.user.id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });

    const proposal = result.rows[0];

    // Fetch add-ons (explicit columns — no SELECT *)
    const addons = await pool.query(
      'SELECT id, proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total FROM proposal_addons WHERE proposal_id = $1 ORDER BY id',
      [proposal.id]
    );

    // Fetch payments (explicit columns — no SELECT *)
    const payments = await pool.query(
      `SELECT id, proposal_id, payment_type, amount, status, created_at
       FROM proposal_payments
       WHERE proposal_id = $1
       ORDER BY created_at DESC`,
      [proposal.id]
    );

    res.json({
      proposal: { ...proposal, addons: addons.rows, payments: payments.rows },
    });
  } catch (err) {
    console.error('Client portal proposal detail error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
