// Composition router for /api/admin/*. Mount order is irrelevant here because
// each sub-router's paths are non-overlapping (no two sub-routers share a path
// or a `/:id` catch-all that could shadow another's specific path).

const express = require('express');
const router = express.Router();

router.use('/', require('./users'));
router.use('/', require('./contractorTipPage'));
router.use('/', require('./applications'));
router.use('/', require('./managers'));
router.use('/', require('./blog'));
router.use('/', require('./settings'));
router.use('/', require('./hiring'));
router.use('/', require('./search'));
router.use('/', require('./payroll'));
router.use('/', require('./payrollTax'));
router.use('/', require('./presence'));
router.use('/', require('./leadCalls'));
// proposalActions lives in ccImport/ but mounts at /api/admin (not /cc-import/) so
// the URLs read /api/admin/proposals/:id/... — these are proposal-level admin
// actions whose "cc" nature is incidental.
router.use('/', require('./ccImport/proposalActions'));

module.exports = router;
