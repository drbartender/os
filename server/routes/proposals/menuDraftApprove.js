// Menu art Approve (spec 2026-10-01 sections 7, 8 and 12; plan Task A3):
//   POST /api/proposals/:id/menu-draft/approve
// Admin and manager (decision 9): auth, requireAdminOrManager, adminWriteLimiter
// and asyncHandler; :id must be digits (400) and the proposal and its draft
// must exist (404).
//
// Multipart: file (the menu the client rendered), version and art_version (the
// draft it rendered), expected_print_key (the print key the client confirmed
// over; empty means none) and, for a draft whose planner_image_role is logo,
// expected_planner_image_rev (the GET's brief.planner_image_rev the client
// rendered with; empty means it rendered with no logo; ignored for any other
// role). The order is the money rule (spec 8):
//   1. the fields, then the file: JPEG by its magic bytes only, sharp reads the
//      header as exactly 2400 x 3000, then one bounded full decode (failOn
//      warning, sharp's strictest, and limitInputPixels at the print size) so
//      a header-only, cut or corrupt file is refused even with an end marker
//      appended ('truncated' accepts those);
//   2. the R2 upload under menu-print/<id>/<uuid>.jpg, with no client held;
//   3. ONE transaction on one client: the draft row FOR UPDATE; 409
//      MENU_DRAFT_CHANGED when version or art_version moved; requireWords (409
//      MENU_WORDS_PENDING or MENU_WORDS_NOT_WRITTEN); 409 MENU_DRAFT_CHANGED
//      when any piece the layout uses (the background and every visible
//      has_art drink) is not done with a stored key, or, for the logo role
//      only (the only time the plan is read), when the plan's planner image rev
//      is not the posted one; the proposal row FOR UPDATE and 409
//      MENU_PRINT_CHANGED when menu_print_key is not expected_print_key, so a
//      manual upload from another tab is never silently overwritten;
//      setMenuPrintKey on the client (which clears menu_not_required); the
//      approved_* stamps (the POSTED versions, the new key, and the planner
//      image key the rev was checked against when the role is logo, else
//      null); the menu_approved activity row; COMMIT, the transaction's last
//      statement;
//   4. release, then reaccrueDuty, so the $5 menu_print duty line is
//      re-reconciled from the committed key, and only then the response body,
//      so nothing after COMMIT can roll back or skip the reaccrual.
// A rollback orphans the uploaded object (the menu-print precedent). A 40P01
// at any statement answers 409 MENU_DRAFT_CHANGED (mapDeadlock). No lockCalls:
// Approve reserves nothing, and it never waits on the cap's table lock.
//
// The piece read needs no row lock: a done piece leaves done only through
// re-roll or Generate, and both lock the draft row first, which this holds.

const express = require('express');
const crypto = require('crypto');
const sharp = require('sharp');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { ConflictError, ValidationError, NotFoundError } = require('../../utils/errors');
const { uploadFile } = require('../../utils/storage');
const { isValidUpload, safeUploadExtension } = require('../../utils/fileValidation');
const { setMenuPrintKey, reaccrueDuty } = require('../../utils/menuPrintFile');
const { mapDeadlock } = require('../../utils/menuArtCap');
const { loadEventPlan, plannerImageKeyOf, plannerImageRev } = require('../../utils/menuDrinkSource');
const { derivePrintState } = require('../../utils/menuPrintState');
const {
  isObject, capList, parseId, parseVersion, requireProposal, noDraft, draftChanged, requireWords,
} = require('./menuDraftShared');

const router = express.Router();

// The printed menu is 8 x 10 in at 300 dpi: the 800 x 1000 canvas at scale 3.
const PRINT_WIDTH = 2400;
const PRINT_HEIGHT = 3000;
const INT4_MAX = 2147483647;
const DIGITS = /^\d{1,10}$/;
// A print key is server-made (menu-print/<id>/<uuid>.<ext>, about 60 characters).
const KEY_MAX = 512;
// plannerImageRev's shape: 16 lowercase hex.
const REV_RE = /^[0-9a-f]{16}$/;

const changed = () => draftChanged('The draft changed. Approve again.');
const printChanged = () => new ConflictError(
  'The print file changed since you confirmed. Check it and approve again.', 'MENU_PRINT_CHANGED');

// Multipart fields arrive as strings. version is a positive int4 (the lane 2
// parseVersion rule); art_version starts at 0, so it may be 0. The planner
// image rev is read only for the logo role: undefined otherwise, null for an
// empty value (rendered with no logo).
function parseFields(body, { logo }) {
  const b = isObject(body) ? body : {};
  const version = parseVersion(typeof b.version === 'string' && DIGITS.test(b.version) ? Number(b.version) : NaN);
  const artVersion = typeof b.art_version === 'string' && DIGITS.test(b.art_version) ? Number(b.art_version) : NaN;
  if (!Number.isInteger(artVersion) || artVersion > INT4_MAX) {
    throw new ValidationError({ art_version: 'Send the art version you saw.' });
  }
  const raw = b.expected_print_key;
  if (typeof raw !== 'string' || raw.length > KEY_MAX) {
    throw new ValidationError({ expected_print_key: 'Send the print file you confirmed over, or an empty value for none.' });
  }
  let expectedRev;
  if (logo) {
    const r = b.expected_planner_image_rev;
    if (typeof r !== 'string' || (r !== '' && !REV_RE.test(r))) {
      throw new ValidationError({ expected_planner_image_rev: 'Send the client image you rendered with, or an empty value for none.' });
    }
    expectedRev = r === '' ? null : r;
  }
  return { version, artVersion, expectedKey: raw === '' ? null : raw, expectedRev };
}

// The rendered menu's bytes, or a 400: one file, JPEG by its magic bytes only
// (the declared name and type are never trusted), exactly 2400 x 3000.
async function menuImage(files) {
  const file = files && files.file;
  if (!file || Array.isArray(file)) throw new ValidationError({ file: 'Attach the menu as one JPEG.' });
  if (!isValidUpload(file) || safeUploadExtension(file) !== '.jpg') {
    throw new ValidationError({ file: 'The menu must be a JPEG.' });
  }
  let meta;
  try {
    meta = await sharp(file.data).metadata();
  } catch {
    throw new ValidationError({ file: 'The menu image could not be read.' });
  }
  if (meta.format !== 'jpeg' || meta.width !== PRINT_WIDTH || meta.height !== PRINT_HEIGHT) {
    throw new ValidationError({ file: `The menu must be exactly ${PRINT_WIDTH} x ${PRINT_HEIGHT} pixels.` });
  }
  // The header alone can lie (a few hundred bytes can claim 2400 x 3000), so
  // decode it once, bounded to the print size, on sharp's thread pool. failOn
  // 'warning': 'truncated' passes a cut file that ends in an FF D9 marker.
  try {
    await sharp(file.data, { failOn: 'warning', limitInputPixels: PRINT_WIDTH * PRINT_HEIGHT }).stats();
  } catch {
    throw new ValidationError({ file: 'The menu image could not be read.' });
  }
  return file.data;
}

// The pieces the printed layout uses: the background and every visible drink
// with art. Zero illustrated drinks is a real menu (beer and wine only).
function layoutPieceKeys(content) {
  const keys = new Set(['background']);
  for (const d of capList(isObject(content) ? content.drinks : null)) {
    if (isObject(d) && d.hidden !== true && d.has_art === true && typeof d.key === 'string') keys.add(d.key);
  }
  return [...keys];
}

const STAMP_SQL = `
  UPDATE menu_drafts
     SET approved_version = $2, approved_art_version = $3, approved_print_key = $4,
         approved_planner_image_key = $5, approved_at = NOW(), approved_by = $6
   WHERE id = $1
  RETURNING id, version, art_version, approved_version, approved_art_version, approved_print_key,
            approved_planner_image_key, inputs, approved_at,
            (SELECT COALESCE(cp.display_name, cp.preferred_name, u.email)
               FROM users u LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
              WHERE u.id = $6) AS approved_by_name`;

// Step 3. COMMIT is the try's last statement, so a failure can only ever roll
// back an uncommitted transaction. Returns the committed stamp and the planner
// image key it was checked against; the client is released before it returns.
async function approveInTx({ id, userId, version, artVersion, expectedKey, expectedRev, key }) {
  const client = await pool.connect();
  let stamped;
  let plannerImageKey = null;
  try {
    await client.query('BEGIN');
    const draft = (await client.query(
      'SELECT id, version, art_version, inputs, content, NOW() AS db_now FROM menu_drafts WHERE proposal_id = $1 FOR UPDATE',
      [id])).rows[0];
    if (!draft) throw noDraft();
    if (draft.version !== version || draft.art_version !== artVersion) throw changed();
    requireWords(draft.content, draft.db_now);
    const used = layoutPieceKeys(draft.content);
    const { rows: ready } = await client.query(
      `SELECT piece_key FROM menu_draft_pieces
        WHERE draft_id = $1 AND piece_key = ANY($2::text[]) AND status = 'done' AND r2_key IS NOT NULL`,
      [draft.id, used]);
    if (ready.length !== used.length) throw changed();

    // The logo role prints the planner image, so the file is only right when
    // the client rendered the image the plan holds now. A role that turned
    // logo since the pre-check moved the version (refused above); undefined
    // here is still a change, never a pass.
    const logo = isObject(draft.inputs) && draft.inputs.planner_image_role === 'logo';
    if (logo) {
      if (expectedRev === undefined) throw changed();
      plannerImageKey = plannerImageKeyOf(await loadEventPlan(id, client));
      if (plannerImageRev(plannerImageKey) !== expectedRev) throw changed();
    }

    const proposal = (await client.query('SELECT menu_print_key FROM proposals WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!proposal) throw new NotFoundError('Proposal not found.');
    if ((proposal.menu_print_key || null) !== expectedKey) throw printChanged();

    await setMenuPrintKey(client, id, key);
    stamped = (await client.query(STAMP_SQL,
      [draft.id, version, artVersion, key, logo ? plannerImageKey : null, userId])).rows[0];
    await client.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'menu_approved', 'admin', $2, $3)`,
      [id, userId, JSON.stringify({ draft_id: draft.id, version, art_version: artVersion, print_key: key })]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw mapDeadlock(err);
  } finally {
    client.release();
  }
  return { stamped, plannerImageKey };
}

// The response, shaped as the GET's print block, from the committed stamp.
function approvedBody({ stamped, plannerImageKey }, key) {
  return {
    version: stamped.version,
    art_version: stamped.art_version,
    print: {
      state: derivePrintState({ menuPrintKey: key, menuNotRequired: false, draft: stamped, plannerImageKey }),
      approved_at: stamped.approved_at,
      approved_by_name: stamped.approved_by_name || null,
      print_key: key,
      approved_file_in_use: stamped.approved_print_key === key,
    },
  };
}

router.post('/:id/menu-draft/approve', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  await requireProposal(id);
  // The role decides whether the planner image rev is required; the locked
  // row in the transaction is what the stamp trusts.
  const pre = (await pool.query(
    "SELECT inputs->>'planner_image_role' AS role FROM menu_drafts WHERE proposal_id = $1", [id])).rows[0];
  if (!pre) throw noDraft();
  const fields = parseFields(req.body, { logo: pre.role === 'logo' });
  const bytes = await menuImage(req.files);

  // R2 first, with no transaction open (spec 8, step 2).
  const key = `menu-print/${id}/${crypto.randomUUID()}.jpg`;
  await uploadFile(bytes, key);

  const committed = await approveInTx({ id, userId: req.user.id, ...fields, key });
  // Committed and released: the accrual reads the key this request posted,
  // and it fires before anything else can throw.
  reaccrueDuty(id);
  res.json(approvedBody(committed, key));
}));

module.exports = router;
