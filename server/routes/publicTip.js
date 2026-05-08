const express = require('express');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { publicLimiter } = require('../middleware/rateLimiters');
const { NotFoundError } = require('../utils/errors');

const router = express.Router();
router.use(publicLimiter);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/public/tip/:token — fetch tip-page display data (public, token-gated) */
router.get('/:token', asyncHandler(async (req, res) => {
  const { token } = req.params;
  if (!UUID_RE.test(token)) throw new NotFoundError('Tip page not found');

  // Public-safe column allowlist — do NOT expose payment_username, routing_number,
  // account_number, preferred_payment_method, internal IDs, stripe_payment_link_id,
  // or tip_page_token. The response shape below is the complete allowed set.
  const { rows } = await pool.query(`
    SELECT
      cp.preferred_name AS display_name,
      cp.headshot_file_url AS headshot_url,
      pp.venmo_handle,
      pp.cashapp_handle,
      pp.paypal_url,
      pp.stripe_payment_link_url,
      pp.tip_page_active
    FROM payment_profiles pp
    JOIN users u ON u.id = pp.user_id
    JOIN contractor_profiles cp ON cp.user_id = u.id
    WHERE pp.tip_page_token = $1
  `, [token]);

  const row = rows[0];
  // 404 message is intentionally identical for both miss and deactivated cases
  // to prevent enumeration of valid-but-deactivated tokens.
  if (!row || !row.tip_page_active) throw new NotFoundError('Tip page not found');

  res.json({
    display_name: row.display_name || 'your bartender',
    headshot_url: row.headshot_url || null,
    venmo_handle: row.venmo_handle || null,
    cashapp_handle: row.cashapp_handle || null,
    paypal_url: row.paypal_url || null,
    stripe_payment_link_url: row.stripe_payment_link_url || null,
  });
}));

module.exports = router;
