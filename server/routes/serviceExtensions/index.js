'use strict';

/**
 * Service-extension routes (spec 2026-07-25).
 *
 * Per-concern split behind a composition router, matching server/routes/proposals/.
 * Mounted at /api/service-extensions in server/index.js.
 *
 * Auth differs per file, so `auth` is applied inside each one rather than at
 * this router level:
 *   create.js       - staff, auth + assigned-to-this-shift predicate
 *   publicAccept.js - PUBLIC, invoice-token gated (no auth)
 *   admin.js        - auth + admin/manager
 */

const express = require('express');
const router = express.Router();

// publicAccept FIRST as belt-and-braces: even if a sibling ever regains a
// pathless `router.use(auth)`, the public client payment path is already
// matched. create.js applies `auth` per route, never at router level, which is
// the actual guarantee.
router.use('/', require('./publicAccept'));
router.use('/', require('./create'));
router.use('/', require('./admin'));

module.exports = router;
