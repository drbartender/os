// Composition router for /api/email-marketing/*.
//
// Extracted from a single 987-line emailMarketing.js, which sat 13 lines under
// the 1000-line hard cap and blocked every phase 2 feature. This split is
// behavior-inert: same paths, same middleware, same order.
//
// MOUNT ORDER MIRRORS THE ORIGINAL FILE ORDER, and that is not decoration.
// designer.js owns POST /campaigns/:id/test and sequences.js owns
// /campaigns/:id/steps; both are more specific than campaigns.js's
// /campaigns/:id, and Express matches in registration order. Reordering these
// lines is a behavior change even though every path is spelled the same.
//
// scripts/route-inventory.js prints the registered table for exactly this
// reason: run it before and after any change here and diff.

const express = require('express');
const router = express.Router();

router.use('/', require('./leads'));
router.use('/', require('./campaigns'));
router.use('/', require('./designer'));      // /campaigns/:id/test, /preview, /upload-image
router.use('/', require('./sequences'));     // /campaigns/:id/steps*, activate, pause
router.use('/', require('./enrollment'));
router.use('/', require('./analytics'));
router.use('/', require('./conversations'));
router.use('/', require('./unsubscribe'));   // PUBLIC, no auth: the JWT is the credential

module.exports = router;
