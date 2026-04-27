// Composition router for /api/admin/*. Mount order is irrelevant here because
// each sub-router's paths are non-overlapping (no two sub-routers share a path
// or a `/:id` catch-all that could shadow another's specific path).

const express = require('express');
const router = express.Router();

router.use('/', require('./users'));
router.use('/', require('./applications'));
router.use('/', require('./managers'));
router.use('/', require('./blog'));
router.use('/', require('./settings'));

module.exports = router;
