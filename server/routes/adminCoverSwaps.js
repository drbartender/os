// Admin one-click cover-swap routes (spec section 6.5).
//
// Both endpoints are gated by:
//   1. router.use(auth) — staff JWT is required; URL tokens leak via
//      Referer headers, browser history, and admin email forwarding, so a
//      bare token in the URL is NOT enough.
//   2. router.use(requireAdminOrManager) — only admins / managers may act.
//   3. JWT verification on the URL `:swapToken` segment — the signed payload
//      ties the link to a specific (original_request_id, new_request_id) pair
//      and carries a 7-day expiry baked in at sign time.
//
// GET renders a confirm payload (original + new request shapes so the admin
// can see what they're approving). POST triggers the cover-approval cascade
// — wired through to PUT /api/shifts/requests/:requestId in Task 25 (Phase 5
// step 2). For now the POST is a 501 stub so the route shape is locked.

const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { approveAndCascade } = require('../utils/coverApprovalCascade');

const router = express.Router();
router.use(auth);
router.use(requireAdminOrManager);

// Verify a swap token. Returns the decoded payload on success, null on any
// JWT error (expired, malformed, bad signature). The route then maps null
// to a 410 with a stable reason string the client renders as an
// "expired link" page.
function verifySwapToken(token) {
  if (typeof token !== 'string' || !token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

// Pull the original + new shift_request rows referenced by a swap-token
// payload. Returns { original, neu, shift, original_user, new_user } or null
// if either request id is unknown. Both rows are needed by both routes
// (idempotency check + render payload).
async function loadSwapContext(decoded) {
  const originalId = decoded?.original_request_id;
  const newId = decoded?.new_request_id;
  if (!originalId || !newId) return null;

  // One round trip — pull both shift_request rows.
  const { rows } = await pool.query(
    `SELECT id, shift_id, user_id, position, status,
            cover_requested_at, cover_reason, dropped_at, drop_reason,
            replaced_by_request_id, created_at
       FROM shift_requests
      WHERE id = ANY($1::int[])`,
    [[originalId, newId]]
  );
  if (rows.length < 2) return null;
  const original = rows.find((r) => r.id === originalId);
  const neu = rows.find((r) => r.id === newId);
  if (!original || !neu) return null;
  // The two requests must point at the same shift (swap, not unrelated).
  if (original.shift_id !== neu.shift_id) return null;

  const shiftRes = await pool.query(
    `SELECT s.id AS shift_id, s.event_date, s.start_time, s.end_time,
            s.location, s.positions_needed, s.status,
            p.id AS proposal_id, p.event_type, p.event_type_custom,
            c.name AS client_name
       FROM shifts s
       LEFT JOIN proposals p ON p.id = s.proposal_id
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE s.id = $1`,
    [original.shift_id]
  );
  const shift = shiftRes.rows[0] || null;

  const usersRes = await pool.query(
    `SELECT u.id, u.email,
            cp.preferred_name, cp.phone, cp.position
       FROM users u
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE u.id = ANY($1::int[])`,
    [[original.user_id, neu.user_id]]
  );
  const originalUser = usersRes.rows.find((r) => r.id === original.user_id) || null;
  const newUser = usersRes.rows.find((r) => r.id === neu.user_id) || null;

  return { original, neu, shift, originalUser, newUser };
}

router.get('/cover-swaps/:swapToken', asyncHandler(async (req, res) => {
  const decoded = verifySwapToken(req.params.swapToken);
  if (!decoded) {
    return res.status(410).json({ status: 'expired_or_invalid', reason: 'expired_or_invalid' });
  }

  const ctx = await loadSwapContext(decoded);
  if (!ctx) {
    // Token decoded, but the referenced request rows are gone (deleted /
    // re-created with new ids). Same "expired/invalid" surface so the client
    // shows a single error state.
    return res.status(410).json({ status: 'expired_or_invalid', reason: 'expired_or_invalid' });
  }

  // Idempotency: spec section 6.5's cascade clears the original's
  // cover_requested_at at COMMIT. A second click on the same link should
  // surface a friendly "already resolved" state, not a re-run.
  if (ctx.original.cover_requested_at === null) {
    return res.json({ status: 'already_resolved' });
  }

  return res.json({
    status: 'pending',
    original_request: ctx.original,
    new_request: ctx.neu,
    shift: ctx.shift,
    original_user: ctx.originalUser,
    new_user: ctx.newUser,
  });
}));

router.post('/cover-swaps/:swapToken', asyncHandler(async (req, res) => {
  const decoded = verifySwapToken(req.params.swapToken);
  if (!decoded) {
    return res.status(410).json({ status: 'expired_or_invalid', reason: 'expired_or_invalid' });
  }

  const ctx = await loadSwapContext(decoded);
  if (!ctx) {
    return res.status(410).json({ status: 'expired_or_invalid', reason: 'expired_or_invalid' });
  }

  // Idempotent: replays after the cascade has run return the same surface as
  // GET so the admin's POST-to-confirm-from-button after a teammate's POST
  // doesn't re-fire the cascade.
  if (ctx.original.cover_requested_at === null) {
    return res.json({ status: 'already_resolved' });
  }

  // Cover-swap cascade (Task 25). Shared with the PUT approval branch in
  // shifts.js via coverApprovalCascade.approveAndCascade — single source of
  // truth for: approve the new request, deny+mark-covered the original,
  // suppress remaining cover_broadcast rows, schedule shift-day messages,
  // insert BEO ack nudge when the drink plan is finalized, COMMIT.
  await approveAndCascade(pool, ctx.original.id, ctx.neu.id);

  return res.json({
    status: 'approved',
    swap: {
      original_request_id: ctx.original.id,
      new_request_id: ctx.neu.id,
      shift_id: ctx.shift?.shift_id,
    },
  });
}));

module.exports = router;
