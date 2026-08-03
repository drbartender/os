// Bar menu print file, admin CRUD (spec 2026-07-22).
//
// Staff are responsible for printing the bar menu and bringing it framed; this
// is where admin posts the file they print, or declares that this event needs
// no printed menu. Staff download it through the authed proxy at
// GET /api/shifts/:shiftId/menu-print (server/routes/eventDetails.js).
//
// Storage: R2 under menu-print/<proposalId>/<uuid>.<ext>. Replacing or removing
// a file ORPHANS the old object — storage.js exposes no delete, and this
// mirrors the drink-plan logo precedent rather than inventing a delete path.
//
// Tri-state (`ready` / `not_required` / `pending`) is DERIVED from the two
// columns, never stored, so the two can never disagree.

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { uploadFile } = require('../../utils/storage');

const router = express.Router();

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Magic-byte sniff limited to what a print shop actually accepts. Returns the
 * canonical extension, or null when the bytes are not a PDF/PNG/JPEG — the
 * declared filename and content-type are never trusted.
 */
function menuPrintExt(file) {
  const buf = file && file.data;
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC)) return 'pdf';
  if (buf.length >= 3 && buf.subarray(0, 3).equals(JPEG_MAGIC)) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  return null;
}

function statusOf(row) {
  if (row.menu_print_key) return 'ready';
  if (row.menu_not_required) return 'not_required';
  return 'pending';
}

async function getProposalRow(id) {
  if (!Number.isFinite(id)) throw new NotFoundError('Proposal not found.');
  const r = await pool.query(
    'SELECT id, menu_print_key, menu_not_required FROM proposals WHERE id = $1',
    [id]
  );
  if (!r.rowCount) throw new NotFoundError('Proposal not found.');
  return r.rows[0];
}

// POST /:id/menu-print — upload or replace the print file.
router.post('/:id/menu-print', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await getProposalRow(id);

  const file = req.files && req.files.file;
  if (!file) throw new ValidationError({ file: 'Attach the print file.' });
  const ext = menuPrintExt(file);
  if (!ext) throw new ValidationError({ file: 'PDF, PNG, or JPG only.' });

  const key = `menu-print/${id}/${crypto.randomUUID()}.${ext}`;
  await uploadFile(file.data, key);
  // Uploading a file necessarily means a menu IS needed: clear the flag so the
  // tri-state cannot land in a contradictory place. Guard rowCount like DELETE
  // does: a proposal deleted between getProposalRow and here must not report
  // 'ready' while orphaning the R2 object.
  const upd = await pool.query(
    'UPDATE proposals SET menu_print_key = $1, menu_not_required = false WHERE id = $2',
    [key, id]
  );
  if (!upd.rowCount) throw new NotFoundError('Proposal not found.');
  res.json({ menu_print: { status: 'ready' } });
}));

// PATCH /:id/menu-print — flip the "no printed menu for this event" flag.
router.patch('/:id/menu-print', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await getProposalRow(id);
  const notRequired = !!(req.body && req.body.not_required === true);
  // The "no file while not_required" invariant is enforced IN the write, not by
  // a read-then-check: two admins racing (an upload interleaved with this PATCH)
  // could otherwise land key-set AND not_required, which later reads back as
  // "no printed menu for this event" the moment the file is removed.
  const upd = await pool.query(
    `UPDATE proposals SET menu_not_required = $2
      WHERE id = $1 AND ($2 = false OR menu_print_key IS NULL)
      RETURNING menu_print_key, menu_not_required`,
    [id, notRequired]
  );
  if (!upd.rowCount) throw new ConflictError('Remove the uploaded file first.');
  res.json({ menu_print: { status: statusOf(upd.rows[0]) } });
}));

// DELETE /:id/menu-print — unpost the file (R2 object orphaned, see head).
router.delete('/:id/menu-print', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await getProposalRow(id);
  // RETURNING the post-update row, so the reported status can never describe a
  // state that a concurrent write already replaced.
  const upd = await pool.query(
    `UPDATE proposals SET menu_print_key = NULL WHERE id = $1
      RETURNING menu_print_key, menu_not_required`,
    [id]
  );
  // Guard the race where the proposal is deleted between the read and this
  // write: statusOf(undefined) would 500 instead of reporting a clean 404.
  if (!upd.rowCount) throw new NotFoundError('Proposal not found.');
  res.json({ menu_print: { status: statusOf(upd.rows[0]) } });
}));

module.exports = router;
