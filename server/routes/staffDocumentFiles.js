// GET /files/staff/:docType/:userId/:basename, the admin and manager reader for a document a staffer
// replaced from the Account page: signs the R2 object under its staff/<doc_type>/<user_id>/ key, which
// the basename-only /api/files route in index.js cannot reach
//
// POST /api/me/documents/:doc_type/replace (staffPortal.js) stores its object at
// `staff/<doc_type>/<user_id>/<ts>_<slug>` (spec 2026-05-27 section 6.14, so
// re-uploads never collide) and, on the active record, the URL `/files/` plus
// that key: the shape every other document writer stores (`/files/<basename>`)
// and the one the admin Documents and Certifications tabs hand to api.get(url)
// verbatim. `/api/files/:filename` signs a bare basename only, so a replaced
// W-9 or alcohol certification could not be opened by any admin surface (audit
// 2026-11-05, POUT-05). This sibling signs exactly that prefix and nothing
// else: the doc type is allowlisted, the user id numeric, the basename stripped
// of any path, and r2Proxy's assertKeyUnder refuses `..` and `//` on top.

const express = require('express');
const path = require('path');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { NotFoundError } = require('../utils/errors');
const storage = require('../utils/storage');
const { assertKeyUnder } = require('../utils/r2Proxy');

const router = express.Router();

// Mirrors DOC_TYPES in staffPortal.js, the writer.
const STAFF_DOCUMENT_TYPES = new Set(['w9', 'alcohol_certification']);
const STAFF_DOCUMENT_PREFIX = 'staff/';

// The R2 key of a replaced staff document, or a NotFoundError for anything
// outside the exact shape the writer produces.
function staffDocumentKey(docType, userId, basename) {
  if (!STAFF_DOCUMENT_TYPES.has(docType) || !/^\d+$/.test(String(userId))) {
    throw new NotFoundError('File not found');
  }
  const name = path.basename(String(basename));
  if (!name || name !== String(basename)) throw new NotFoundError('File not found');
  const key = `${STAFF_DOCUMENT_PREFIX}${docType}/${userId}/${name}`;
  assertKeyUnder(key, STAFF_DOCUMENT_PREFIX);
  return key;
}

// Signed 15-minute R2 URL for a staffer's replaced document - admin and manager only, the same gate as
// /api/files/:filename (a manager never receives the W-9 URL: the user record withholds the payment row)
router.get('/staff/:docType/:userId/:basename', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const key = staffDocumentKey(req.params.docType, req.params.userId, req.params.basename);
  let url;
  try {
    // Through the module object, not a destructured binding, so a test can
    // swap the signer (storage.readFile reads it the same way).
    url = await storage.getSignedUrl(key);
  } catch (err) {
    console.error('Staff document access error:', err.message);
    throw new NotFoundError('File not found');
  }
  res.json({ url });
}));

module.exports = router;
module.exports.staffDocumentKey = staffDocumentKey;
