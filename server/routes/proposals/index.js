// Composition router for /api/proposals/*.
//
// Mount order matters: getOne.js owns the greedy GET `/:id` route and mounts
// LAST, so every static GET path (`/financials`, `/dashboard-stats`,
// `/packages`, `/addons`, `/calculate`, `/change-requests`) wins first.
// publicToken and public are mounted first too — they own specific path
// prefixes (`/t/:token`, `/public/*`) and never collide with `/:id`.

const express = require('express');
const router = express.Router();

router.use('/', require('./publicToken'));
router.use('/', require('./compareGroup'));
router.use('/', require('./public'));
router.use('/', require('./metadata'));
router.use('/', require('./lifecycle'));
router.use('/', require('./actions'));
router.use('/', require('./changeRequests'));
router.use('/', require('./groups'));
router.use('/', require('./crud'));
router.use('/', require('./list'));
router.use('/', require('./metricsSplit'));
router.use('/', require('./getOne'));

module.exports = router;
