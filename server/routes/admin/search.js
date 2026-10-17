// GET /api/admin/search: global record search powering the Cmd/Ctrl+K
// command palette and the phone's full-screen search (lane ma-f3,
// client/src/pages/mobile/SearchPhone.js). Read-only; matches clients,
// proposals, events, and staff by partial name, email, or phone. Search logic
// lives in server/utils/globalSearch.js so it can be unit-tested directly.

const express = require('express');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { adminSearchLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { runGlobalSearch } = require('../../utils/globalSearch');

const router = express.Router();

router.get('/search', auth, requireAdminOrManager, adminSearchLimiter, asyncHandler(async (req, res) => {
  const results = await runGlobalSearch(req.query.q);
  res.json({ results });
}));

module.exports = router;
