const express = require('express');
const { pool } = require('../../db');
const asyncHandler = require('../../middleware/asyncHandler');
const { NotFoundError, ValidationError, ConflictError } = require('../../utils/errors');
const { clientPortalWriteLimiter } = require('../../middleware/rateLimiters');
const {
  computeEditWindow, filterToAllowlist, buildPreview, buildDiff,
} = require('../../utils/changeRequests');

const router = express.Router();

// Defense in depth: express.json already caps total body size, but bound the
// add-on maps explicitly so a hostile client cannot push a huge object into the
// pricing path. Real catalogs are dozens of add-ons, so 50 is generous.
const MAX_ADDON_KEYS = 50;
function assertAddonPayloadBounded(body) {
  if (body.addon_ids !== undefined && !Array.isArray(body.addon_ids)) {
    throw new ValidationError({ addon_ids: 'Add-ons must be a list.' }, 'Invalid add-on selection.');
  }
  for (const f of ['addon_variants', 'addon_quantities']) {
    if (body[f] !== undefined && (body[f] === null || typeof body[f] !== 'object' || Array.isArray(body[f]))) {
      throw new ValidationError({ [f]: 'Invalid add-on data.' }, 'Invalid add-on selection.');
    }
  }
  const over = (v) => Array.isArray(v) ? v.length > MAX_ADDON_KEYS
    : (v && typeof v === 'object') ? Object.keys(v).length > MAX_ADDON_KEYS : false;
  if (over(body.addon_ids) || over(body.addon_variants) || over(body.addon_quantities)) {
    throw new ValidationError({ addon_ids: 'Too many add-ons in one request.' }, 'Too many add-ons in one request.');
  }
}

// Load a proposal by token scoped to the logged-in client. Throws 404 otherwise.
async function loadOwnedProposal(token, clientId, db = pool) {
  const r = await db.query('SELECT * FROM proposals WHERE token = $1 AND client_id = $2', [token, clientId]);
  if (!r.rows[0]) throw new NotFoundError('Proposal not found.');
  return r.rows[0];
}

// Eligibility (spec 3.3): non-archived, non-completed, priced baseline.
function assertEditable(proposal) {
  if (proposal.status === 'archived' || proposal.status === 'completed') {
    throw new ConflictError('This event can no longer be changed online.', 'NOT_EDITABLE');
  }
  // Priced baseline = pricing_snapshot non-empty (spec 3.3 exactly). NOT
  // `total_price > 0 OR snapshot`: priceProposedState later reads
  // pricing_snapshot.syrups / .staffing, so an empty snapshot must be excluded
  // even when total_price happens to be set.
  const snap = proposal.pricing_snapshot;
  const priced = snap && typeof snap === 'object' && Object.keys(snap).length > 0;
  if (!priced) throw new ConflictError('This quote is not finalized yet. Please contact us.', 'UNPRICED');
}

// POST /calculate, price an in-progress edit (no write).
router.post('/proposals/:token/calculate', clientPortalWriteLimiter, asyncHandler(async (req, res) => {
  const proposal = await loadOwnedProposal(req.params.token, req.user.id);
  assertEditable(proposal);
  assertAddonPayloadBounded(req.body);
  const proposed = filterToAllowlist(req.body);
  const { price_preview } = await buildPreview(proposal, proposed);
  res.json({ price_preview });
}));

// POST /change-requests, create. Enforces the create-time consent contract.
router.post('/proposals/:token/change-requests', clientPortalWriteLimiter, asyncHandler(async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const pr = await dbClient.query('SELECT * FROM proposals WHERE token = $1 AND client_id = $2 FOR UPDATE', [req.params.token, req.user.id]);
    if (!pr.rows[0]) throw new NotFoundError('Proposal not found.');
    const proposal = pr.rows[0];
    assertEditable(proposal);
    assertAddonPayloadBounded(req.body);

    const proposed = filterToAllowlist(req.body);
    if (Object.keys(proposed).length === 0) throw new ValidationError({ _: 'No changes requested.' }, 'Pick at least one change.');

    // Lenient venue revalidation (spec 3.3), matching the admin PATCH
    // (requireStreet:false, requireCityState:false), so a client can correct one
    // venue field without re-entering the whole address. Only runs when a venue
    // field is actually being changed.
    const venueTouched = ['venue_name', 'venue_street', 'venue_city', 'venue_state', 'venue_zip'].some(k => proposed[k] !== undefined);
    if (venueTouched) {
      const { validateVenue } = require('../../utils/venueAddress');
      const venueErrors = validateVenue(proposed, { requireStreet: false, requireCityState: false });
      if (Object.keys(venueErrors).length > 0) throw new ValidationError(venueErrors);
    }

    const { price_preview } = await buildPreview(proposal, proposed, dbClient);

    // Create-time consent contract (spec 3.3): the stored acknowledged_total is
    // always a server number the client saw. If their number is stale, 409 with
    // the fresh preview so they re-confirm.
    const ackClient = Number(req.body.acknowledged_total);
    if (!Number.isFinite(ackClient) || Math.round(ackClient * 100) !== Math.round(price_preview.estimated_total * 100)) {
      await dbClient.query('ROLLBACK');
      return res.status(409).json({ code: 'PRICE_CHANGED', price_preview });
    }

    const { requested, baseline } = await buildDiff(proposal, proposed, dbClient);
    const editWindow = computeEditWindow(proposal);
    const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.socket?.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;

    let inserted;
    try {
      inserted = await dbClient.query(
        `INSERT INTO proposal_change_requests
           (proposal_id, client_id, status, edit_window, requested_changes, baseline, note,
            price_preview, acknowledged_total, request_ip, request_user_agent)
         VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [proposal.id, req.user.id, editWindow, JSON.stringify(requested), JSON.stringify(baseline),
         (req.body.note || '').trim().slice(0, 2000) || null, JSON.stringify(price_preview),
         price_preview.estimated_total, ip, ua]
      );
    } catch (e) {
      if (e.code === '23505') { // partial-unique: a request is already open
        await dbClient.query('ROLLBACK');
        throw new ConflictError('You already have a pending change request for this event.', 'ALREADY_OPEN');
      }
      throw e;
    }
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'change_requested', 'client', $2, $3)`,
      [proposal.id, req.user.id, JSON.stringify({ change_request_id: inserted.rows[0].id, edit_window: editWindow, estimated_total: price_preview.estimated_total })]
    );
    await dbClient.query('COMMIT');

    // Best-effort admin notification (Group F wires the real send here).
    try {
      const { notifyAdminOfChangeRequest } = require('../../utils/changeRequestNotifications');
      await notifyAdminOfChangeRequest(inserted.rows[0], proposal);
    } catch (e) { console.error('change-request admin notify failed (non-blocking):', e.message); }

    res.status(201).json({ change_request: inserted.rows[0] });
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    dbClient.release();
  }
}));

// GET /change-requests, open request + bounded history.
router.get('/proposals/:token/change-requests', asyncHandler(async (req, res) => {
  const proposal = await loadOwnedProposal(req.params.token, req.user.id);
  const r = await pool.query(
    `SELECT id, status, edit_window, requested_changes, baseline, note, price_preview,
            acknowledged_total, decision_note, decided_at, cancelled_by, created_at
       FROM proposal_change_requests WHERE proposal_id = $1
      ORDER BY created_at DESC LIMIT 20`,
    [proposal.id]
  );
  res.json({ requests: r.rows });
}));

// POST /change-requests/:id/cancel, client withdraws a pending request.
router.post('/proposals/:token/change-requests/:id/cancel', clientPortalWriteLimiter, asyncHandler(async (req, res) => {
  const proposal = await loadOwnedProposal(req.params.token, req.user.id);
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const r = await dbClient.query(
      `UPDATE proposal_change_requests SET status = 'cancelled', cancelled_by = 'client', updated_at = NOW()
        WHERE id = $1 AND proposal_id = $2 AND status = 'pending' RETURNING id`,
      [req.params.id, proposal.id]
    );
    if (!r.rows[0]) throw new NotFoundError('No pending request to cancel.');
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'change_cancelled', 'client', $2, $3)`,
      [proposal.id, req.user.id, JSON.stringify({ change_request_id: Number(req.params.id) })]
    );
    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    dbClient.release();
  }
  res.json({ ok: true });
}));

module.exports = router;
