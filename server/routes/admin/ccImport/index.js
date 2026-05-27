// Composition router for /api/admin/cc-import/*.
//
// Single sub-router today (wrapUp.js); review.js + search.js follow in Batch 9.

const express = require('express');
const router = express.Router();

router.use('/', require('./wrapUp'));

module.exports = router;
