// Composition router for /api/admin/cc-import/*.
//
// Sub-routers:
//   wrapUp.js — Bucket B wrap-up worklist + enqueue (Task 18 / Batch 8)
//   search.js — Review-page typeaheads + link-preview (Task 19 / Batch 9)
//   review.js — Review-page GET + 10 action endpoints (Task 19 / Batch 9)

const express = require('express');
const router = express.Router();

router.use('/', require('./wrapUp'));
router.use('/', require('./search'));
router.use('/', require('./review'));

module.exports = router;
