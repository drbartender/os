/**
 * Admin-only payroll portal routes mounted at /api/admin/payroll/*.
 *
 * Auth: every route below is gated by `auth` + `adminOnly` (Section 13:
 * Payroll is admin-only in this version; managers do not have access).
 * Money-touching endpoints wrap multi-statement work in a transaction.
 */
const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');

const router = express.Router();

// Cheap liveness probe. Real endpoints follow in subsequent tasks.
router.get('/payroll/healthcheck', auth, adminOnly, asyncHandler(async (req, res) => {
  res.json({ ok: true, ts: Date.now() });
}));

module.exports = router;
