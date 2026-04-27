// Composition router for /api/proposals/*.
//
// Mount order matters: metadata before crud, because crud.js owns the `/:id`
// dynamic route and would shadow metadata's static paths (`/financials`,
// `/dashboard-stats`, `/packages`, `/addons`, `/calculate`) if mounted first.
// publicToken and public are mounted first too — they own specific path
// prefixes (`/t/:token`, `/public/*`) and never collide with `/:id`.

const express = require('express');
const router = express.Router();

router.use('/', require('./publicToken'));
router.use('/', require('./public'));
router.use('/', require('./metadata'));
router.use('/', require('./crud'));

module.exports = router;
