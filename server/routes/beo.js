// Event-details read routes for staff + admin, proposal-keyed.
//
// GET /api/beo/:proposalId       — full event-details payload (shared builder).
// GET /api/beo/:proposalId/logo  — proxied download of the drink-plan logo (R2 stays private).
// POST /api/beo/:proposalId/acknowledge — a worker confirms they have read it.
//
// The staff portal calls the shift-keyed sibling (GET /api/shifts/:shiftId/
// event-details, server/routes/eventDetails.js); these paths stay for the admin
// "View event details" link and already-sent nudge links. Both share
// server/utils/eventDetailsPayload.js.
//
// Route paths and the `beo_*` column/key names are deliberately frozen: the
// 2026-07-22 spec renamed only the words staff read, never the identifiers.
//
// AUTHORIZATION. Reads: any ONBOARDED staffer may read an event that has a
// non-cancelled shift; contact fields are redacted for viewers who are not
// approved-and-active on it (see eventDetailsPayload.js). `requireOnboarded` is
// not optional here — registration is public, so plain `auth` would expose this
// to anyone who signed up. Writes (acknowledge): still assigned-only, enforced
// by the UPDATE predicates below.

const express = require('express');
const { pool } = require('../db');
const { auth, requireOnboarded } = require('../middleware/auth');
const { beoReadLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../middleware/asyncHandler');
const { NotFoundError, ConflictError, ExternalServiceError } = require('../utils/errors');
const { getSignedUrl } = require('../utils/storage');
const { authorizeEventRead, buildEventDetailsPayload } = require('../utils/eventDetailsPayload');

const router = express.Router();

router.get('/:proposalId', auth, requireOnboarded, beoReadLimiter, asyncHandler(async (req, res) => {
  const proposalId = parseInt(req.params.proposalId, 10);
  if (!Number.isFinite(proposalId)) throw new NotFoundError('Event not found.');
  await authorizeEventRead(req, proposalId);
  res.json(await buildEventDetailsPayload(req, proposalId));
}));

router.get('/:proposalId/logo', auth, requireOnboarded, beoReadLimiter, asyncHandler(async (req, res) => {
  const proposalId = parseInt(req.params.proposalId, 10);
  if (!Number.isFinite(proposalId)) throw new NotFoundError('Event not found.');
  await authorizeEventRead(req, proposalId);

  const r = await pool.query(
    `SELECT selections->>'_logoFilename' AS filename
       FROM drink_plans WHERE proposal_id = $1`,
    [proposalId]
  );
  const filename = r.rows[0] && r.rows[0].filename;
  if (!filename) throw new NotFoundError('No logo uploaded for this plan.');
  // Path-traversal guard. The upload pipeline always writes under
  // `drink-plan-logos/`; rejecting anything else means a tampered drink_plan row
  // can't trick us into proxying an arbitrary R2 object.
  if (!filename.startsWith('drink-plan-logos/')) throw new NotFoundError('No logo uploaded for this plan.');

  const url = await getSignedUrl(filename);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  let upstream;
  try {
    upstream = await fetch(url, { signal: ac.signal });
  } catch (err) {
    throw new ExternalServiceError('r2', err, 'Logo is temporarily unavailable.');
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) {
    throw new ExternalServiceError('r2', new Error(`Upstream returned ${upstream.status}`), 'Logo is temporarily unavailable.');
  }
  res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(await upstream.arrayBuffer()));
}));

// POST /:proposalId/acknowledge — a worker stamps beo_acknowledged_at on every
// approved, non-cancelled shift_request they hold on this event. Admins (and
// managers who are only VIEWING, not staffed) get a 200 no-op (acknowledged:false)
// so the same UI button is safe for every audience. Requires the drink plan to be
// finalized — pre-finalize acknowledgement would let staff confirm details that
// admin may still revise.
//
// This is a WRITE and stays assigned-only even though the READ ungated in the
// 2026-07-22 spec: the UPDATE's own predicates (approved + not dropped + shift
// not cancelled) are the enforcement, so a browsing staffer matches zero rows.
router.post('/:proposalId/acknowledge', auth, requireOnboarded, beoReadLimiter, asyncHandler(async (req, res) => {
  const proposalId = parseInt(req.params.proposalId, 10);
  if (!Number.isFinite(proposalId)) throw new NotFoundError('Event not found.');
  await authorizeEventRead(req, proposalId);

  // Admin: pure no-op. Admins view the BEO but are never staffed on a shift
  // (POST /shifts/:id/assign rejects role='admin'), so there is nothing to ack.
  if (req.user.role === 'admin') {
    return res.json({ acknowledged: false });
  }

  // Manager: a manager can be a pure BEO viewer OR an assigned worker (audit 3c
  // W1 — managers are assignable to shifts and ARE scheduled for the unack nudge).
  // Only a manager who actually holds an approved active shift acknowledges; a
  // viewing manager no-ops like admin so the shared button stays safe for them.
  if (req.user.role === 'manager') {
    const staffed = await pool.query(
      `SELECT 1 FROM shift_requests sr
         JOIN shifts s ON s.id = sr.shift_id
        WHERE s.proposal_id = $1 AND sr.user_id = $2
          AND sr.status = 'approved' AND sr.dropped_at IS NULL
          AND s.status != 'cancelled' LIMIT 1`,
      [proposalId, req.user.id]
    );
    if (!staffed.rows[0]) return res.json({ acknowledged: false });
  }

  // Single UPDATE…FROM. Covers staffers with multiple approved shifts on the
  // same proposal (multi-bar events) by stamping every matching row at once.
  // Joining drink_plans inside the UPDATE means the finalized_at gate runs
  // atomically — no TOCTOU between read and write.
  const result = await pool.query(
    `UPDATE shift_requests sr
        SET beo_acknowledged_at = NOW()
       FROM shifts s
       JOIN drink_plans dp ON dp.proposal_id = s.proposal_id
      WHERE sr.shift_id = s.id
        AND s.proposal_id = $1
        AND sr.user_id = $2
        AND sr.status = 'approved'
        AND sr.dropped_at IS NULL
        AND s.status != 'cancelled'
        AND dp.finalized_at IS NOT NULL
      RETURNING sr.id, sr.shift_id, sr.beo_acknowledged_at`,
    [proposalId, req.user.id]
  );

  if (result.rowCount === 0) {
    // Discriminator. Read auth no longer proves assignment (2026-07-22 ungating),
    // so a browsing staffer can reach this line. Check assignment FIRST: telling
    // someone who is not on the event that "the plan is not finalized" would send
    // them back to wait for a confirm button that is never theirs.
    const staffed = await pool.query(
      `SELECT 1 FROM shift_requests sr
         JOIN shifts s ON s.id = sr.shift_id
        WHERE s.proposal_id = $1 AND sr.user_id = $2
          AND sr.status = 'approved' AND sr.dropped_at IS NULL
          AND s.status != 'cancelled' LIMIT 1`,
      [proposalId, req.user.id]
    );
    if (!staffed.rowCount) {
      throw new ConflictError('No approved active shift for you on this event.');
    }
    const dp = await pool.query('SELECT finalized_at FROM drink_plans WHERE proposal_id = $1', [proposalId]);
    if (!dp.rows[0] || !dp.rows[0].finalized_at) {
      throw new ConflictError('Plan is not finalized.');
    }
    throw new ConflictError('No approved active shift for you on this event.');
  }

  console.log(`[beo] acknowledge proposal=${proposalId} user=${req.user.id} rows=${result.rowCount}`);
  res.json({
    acknowledged: true,
    beo_acknowledged_at: result.rows[0].beo_acknowledged_at,
    request_ids: result.rows.map((r) => r.id),
  });
}));

module.exports = router;
