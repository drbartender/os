// Bar menu print file, admin CRUD (spec 2026-07-22).
//
// Staff are responsible for printing the bar menu and bringing it framed; this
// is where admin posts the file they print, or declares that this event needs
// no printed menu, and downloads it back (GET below). Staff download it through
// the authed proxy at GET /api/shifts/:shiftId/menu-print
// (server/routes/eventDetails.js); both stream through utils/menuPrintFile.js.
// The key itself is set only through menuPrintFile.setMenuPrintKey, here and in
// the held file's release (utils/menuRelease.js; Approve and send holds its
// file and never posts it), and reaccrueDuty fires after the write commits.
//
// Dallas's own print-file decisions withdraw the open menu proof (spec
// 2026-10-19 section 10.3; lane menu-approve-send), in the same transaction as
// their own write, so a client's Looks great can never undo them: the no-menu
// PATCH, when it sets the mark, withdraws the draft's latest proof that has no
// answer; the upload POST withdraws it when it has no answer or is answered
// changes (his file settles the request, and the proof's own state is what
// closes its Inbox task), never one answered approved. DELETE withdraws
// nothing: removing a file while a newer proof is out clears the old file for
// the new one; it names the file the page showed (expected_print_key) and
// answers 409 MENU_PRINT_CHANGED when another is live (lane menu-approve-send,
// fix round 1). The upload names it too, with the latest proof the page saw
// (seen_proof_id, seen_proof_answer), and answers 409 MENU_PRINT_CHANGED or
// MENU_PROOF_CHANGED before it writes the key or withdraws anything (fix round
// 2). Each write takes the draft row FOR UPDATE before the proposal
// row, the lock order Approve, Release and the answer route keep, and clears
// the Inbox cache after its commit (inboxCache.invalidate).
//
// Storage: R2 under menu-print/<proposalId>/<uuid>.<ext>. Replacing or removing
// a file ORPHANS the old object — storage.js exposes no delete, and this
// mirrors the drink-plan logo precedent rather than inventing a delete path.
//
// Tri-state (`ready` / `not_required` / `pending`) is DERIVED from the two
// columns, never stored, so the two can never disagree.
//
// Legal hold (money law 15): POST, PATCH and DELETE refuse the legal-hold
// proposal with 409 LEGAL_HOLD (assertNotLegalHold, isLegalHold failing
// closed) once the id is read, before any read, upload or write, so its
// print file and flag keep their state exactly.

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { adminWriteLimiter, beoReadLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { uploadFile } = require('../../utils/storage');
// reaccrueDuty is the duty-pay hook (spec 2026-08-06 §3.2): the $5 menu_print
// line keys on menu_print_key, so posting or unposting the file re-reconciles
// it. Both writes below fire it only after their UPDATE has landed.
const { sendMenuPrintFile, setMenuPrintKey, reaccrueDuty } = require('../../utils/menuPrintFile');
const { withdrawLatestProof, proofSeenChanged } = require('../../utils/menuProofs');
const inboxCache = require('../../utils/inbox/cache');
const { assertNotLegalHold } = require('./patchGuards');

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

const INT4_MAX = 2147483647;
// A print key is server-made (menu-print/<id>/<uuid>.<ext>, about 60 characters).
const KEY_MAX = 512;

// Bounded to int4: parseInt accepts '99999999999999999999', and pg would
// raise 22003 on the compare, a 500 that pages Sentry instead of a 404.
const inRange = (id) => Number.isInteger(id) && id > 0 && id <= INT4_MAX;

// A write's id: the route id as parseInt reads it, a 404 out of range, then
// the legal hold refused (409 LEGAL_HOLD) before anything is read.
function writableId(raw) {
  const id = parseInt(raw, 10);
  if (!inRange(id)) throw new NotFoundError('Proposal not found.');
  assertNotLegalHold(id);
  return id;
}

// The event's draft row, locked, or null when it has none (lock order: the
// draft before the proposal).
const DRAFT_LOCK_SQL = 'SELECT id FROM menu_drafts WHERE proposal_id = $1 FOR UPDATE';

const MARK_SQL = `
  UPDATE proposals SET menu_not_required = $2, menu_not_required_by = 'admin'
   WHERE id = $1 AND ($2 = false OR menu_print_key IS NULL)
  RETURNING menu_print_key, menu_not_required`;

// One transaction on one pooled client: BEGIN, fn(client, draftId), COMMIT; any
// error rolls back; the client is released before it returns.
async function inDraftTx(id, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const draft = (await client.query(DRAFT_LOCK_SQL, [id])).rows[0];
    const out = await fn(client, draft ? draft.id : null);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getProposalRow(id) {
  if (!inRange(id)) throw new NotFoundError('Proposal not found.');
  const r = await pool.query(
    'SELECT id, menu_print_key, menu_not_required FROM proposals WHERE id = $1',
    [id]
  );
  if (!r.rowCount) throw new NotFoundError('Proposal not found.');
  return r.rows[0];
}

// GET /:id/menu-print — download the posted file (admin/manager). Keyed by the
// proposal so an event with no shift row can still be read; the traversal guard
// and the R2 stream are the staff route's, shared through menuPrintFile.js.
// beoReadLimiter is the staff route's per-user read budget: every call presigns
// and streams up to 10 MB from R2, and a human never comes near 60 in 15 min.
router.get('/:id/menu-print', auth, requireAdminOrManager, beoReadLimiter, asyncHandler(async (req, res) => {
  const row = await getProposalRow(parseInt(req.params.id, 10));
  await sendMenuPrintFile(res, row.id, row.menu_print_key);
}));

const ANSWERS = new Set(['approved', 'changes']);

// What the upload's page showed of the latest proof (multipart strings, as
// Approve posts them): { id, answer }, null each for none.
function seenFields(body) {
  const b = body && typeof body === 'object' ? body : {};
  const id = b.seen_proof_id;
  if (typeof id !== 'string' || (id !== '' && !(/^\d{1,10}$/.test(id) && Number(id) >= 1 && Number(id) <= INT4_MAX))) {
    throw new ValidationError({ seen_proof_id: 'Send the proof you saw, or an empty value for none.' });
  }
  const answer = b.seen_proof_answer;
  if (typeof answer !== 'string' || (answer !== '' && !ANSWERS.has(answer))) {
    throw new ValidationError({ seen_proof_answer: "Send the client's answer you saw, or an empty value for none." });
  }
  return { id: id === '' ? null : Number(id), answer: answer === '' ? null : answer };
}

const DRAFT_ID_SQL = 'SELECT id FROM menu_drafts WHERE proposal_id = $1';
const LIVE_KEY_LOCK_SQL = 'SELECT menu_print_key FROM proposals WHERE id = $1 FOR UPDATE';

// The upload's page against the event as it stands: the 409 for a live key
// that is not the one it showed, or a latest proof (superseded_at null) whose
// id or answer it did not see; null when the page was current. With no draft
// there is no proof, so only empty seen fields are current.
async function staleUpload(db, { draftId, liveKey, expected, seen }) {
  if ((liveKey || null) !== expected) {
    return new ConflictError('A different print file is live now. Refresh to see it.', 'MENU_PRINT_CHANGED');
  }
  const changed = draftId ? await proofSeenChanged(db, draftId, seen) : seen.id !== null || seen.answer !== null;
  return changed ? new ConflictError("The client's review changed. Refresh to see it.", 'MENU_PROOF_CHANGED') : null;
}

// POST /:id/menu-print — upload or replace the print file.
// { file, expected_print_key, seen_proof_id, seen_proof_answer }: what the card
// showed, so a stale card never replaces a file a client's Looks great just
// released, nor closes a change request it never saw (409 MENU_PRINT_CHANGED or
// MENU_PROOF_CHANGED).
router.post('/:id/menu-print', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const id = writableId(req.params.id);
  const row = await getProposalRow(id);

  const file = req.files && req.files.file;
  if (!file) throw new ValidationError({ file: 'Attach the print file.' });
  const ext = menuPrintExt(file);
  if (!ext) throw new ValidationError({ file: 'PDF, PNG, or JPG only.' });
  const expected = expectedPrintKey(req.body);
  const seen = seenFields(req.body);

  // A stale page is refused before its file is stored (no lock: the
  // transaction below reads it all again under the locks, and a change that
  // lands in between is refused there, leaving the stored object orphaned).
  const pre = (await pool.query(DRAFT_ID_SQL, [id])).rows[0];
  const early = await staleUpload(pool, { draftId: pre ? pre.id : null, liveKey: row.menu_print_key, expected, seen });
  if (early) throw early;

  const key = `menu-print/${id}/${crypto.randomUUID()}.${ext}`;
  await uploadFile(file.data, key);
  // The order is R2, then one transaction: the draft lock, the proposal lock
  // and the page's view again (refused as above), the key (which also
  // clears menu_not_required, with the rowCount guard: a proposal deleted
  // between getProposalRow and here is a 404, never 'ready' over an orphaned
  // object) and the withdraw of an open or change-request proof (head); then
  // duty reaccrual, which reads the committed key, and the Inbox cache.
  await inDraftTx(id, async (client, draftId) => {
    const locked = (await client.query(LIVE_KEY_LOCK_SQL, [id])).rows[0];
    if (!locked) throw new NotFoundError('Proposal not found.');
    const late = await staleUpload(client, { draftId, liveKey: locked.menu_print_key, expected, seen });
    if (late) throw late;
    await setMenuPrintKey(client, id, key);
    if (draftId) await withdrawLatestProof(client, draftId, { andChanges: true });
  });
  reaccrueDuty(id);
  inboxCache.invalidate();
  res.json({ menu_print: { status: 'ready' } });
}));

// PATCH /:id/menu-print — flip the "no printed menu for this event" flag.
router.patch('/:id/menu-print', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const id = writableId(req.params.id);
  await getProposalRow(id);
  const notRequired = !!(req.body && req.body.not_required === true);
  // The "no file while not_required" invariant is enforced IN the write, not by
  // a read-then-check: two admins racing (an upload interleaved with this PATCH)
  // could otherwise land key-set AND not_required, which later reads back as
  // "no printed menu for this event" the moment the file is removed.
  // The admin's decision carries its provenance (spec 2026-10-19 section 15):
  // 'admin' whether it sets or clears the mark, so a client's later Custom or
  // Standard submit never undoes a set (utils/menuAutoStart.js clears only
  // 'planner'), and a later Skip the Menu never re-marks a cleared row.
  // Setting the mark withdraws the draft's unanswered proof in the same
  // transaction (head), so a Looks great already in flight is refused. A file
  // live (a release can post one between the card's load and the mark) is 409
  // MENU_PRINT_CHANGED, which the fold refetches on.
  const row = await inDraftTx(id, async (client, draftId) => {
    const upd = await client.query(MARK_SQL, [id, notRequired]);
    if (!upd.rowCount) throw new ConflictError('A print file is live now. Refresh to see it.', 'MENU_PRINT_CHANGED');
    if (notRequired && draftId) await withdrawLatestProof(client, draftId);
    return upd.rows[0];
  });
  inboxCache.invalidate();
  res.json({ menu_print: { status: statusOf(row) } });
}));

// The file the page showed (print.print_key): a server-made key, '' for none.
function expectedPrintKey(body) {
  const raw = body && typeof body === 'object' ? body.expected_print_key : undefined;
  if (typeof raw !== 'string' || raw.length > KEY_MAX) {
    throw new ValidationError({ expected_print_key: 'Send the print file you saw, or an empty value for none.' });
  }
  return raw === '' ? null : raw;
}

// Clears the key only when it is the one the page showed, or when none is
// live (today's answer); RETURNING the post-update row, so the reported status
// can never describe a state that a concurrent write already replaced.
const REMOVE_SQL = `
  UPDATE proposals SET menu_print_key = NULL
   WHERE id = $1 AND (menu_print_key IS NULL OR menu_print_key = $2)
  RETURNING menu_print_key, menu_not_required`;

// DELETE /:id/menu-print: unpost the file the page showed (R2 object orphaned, see head).
// { expected_print_key }: a Remove pressed on a card that showed an older file,
// after a client's Looks great released a newer one, is 409 MENU_PRINT_CHANGED
// and never unposts the file the client just approved.
router.delete('/:id/menu-print', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const id = writableId(req.params.id);
  await getProposalRow(id);
  const expected = expectedPrintKey(req.body);
  const upd = await pool.query(REMOVE_SQL, [id, expected]);
  if (!upd.rowCount) {
    // Guard the race where the proposal is deleted between the read and this
    // write: statusOf(undefined) would 500 instead of reporting a clean 404.
    const now = await pool.query('SELECT 1 FROM proposals WHERE id = $1', [id]);
    if (!now.rowCount) throw new NotFoundError('Proposal not found.');
    throw new ConflictError('A different print file is live now. Refresh to see it.', 'MENU_PRINT_CHANGED');
  }
  reaccrueDuty(id);
  // A removed upload changes a no-answer task's words (readMenuTasks.js).
  inboxCache.invalidate();
  res.json({ menu_print: { status: statusOf(upd.rows[0]) } });
}));

module.exports = router;
