// Menu art Approve and send (spec 2026-10-01 sections 7, 8 and 12; amended by
// spec 2026-10-19 sections 10.2, 10.4 and 11, lane menu-approve-send):
//   POST /api/proposals/:id/menu-draft/approve
// Admin and manager (decision 9): auth, requireAdminOrManager, adminWriteLimiter
// and asyncHandler; :id must be digits (400) and the proposal and its draft
// must exist (404).
//
// Multipart: file (the print file the client rendered, 2400 x 3000), proof
// (the same render scaled to 1200 x 1500 with the 56 px proof band, 1200 x
// 1556), version and art_version (the draft it rendered), expected_print_key
// (the print key the client confirmed over; empty means none), seen_proof_id
// and seen_proof_answer (what the page showed of the latest proof at the
// press: its id as digits and approved or changes, each empty for none; both
// required) and, for a draft
// whose planner_image_role is logo, expected_planner_image_rev (the GET's
// brief.planner_image_rev the client rendered with; empty means it rendered
// with no logo; ignored for any other role). The order:
//   0. the legal-hold proposal is refused first, 409 LEGAL_HOLD
//      (assertNotLegalHold, isLegalHold failing closed), before any read,
//      upload or write, so it never gets a print file or a proof (money law 15);
//   1. the fields, then BOTH files, before anything is written: each a JPEG by
//      its magic bytes only, sharp reads the header as exactly its size, then
//      one bounded full decode (failOn warning, sharp's strictest, and
//      limitInputPixels at that size) so a header-only, cut or corrupt file is
//      refused even with an end marker appended; the proof at most 3 MB;
//   2. an event day before today in Chicago is 409 MENU_EVENT_PASSED (its link
//      would be born expired), checked again under the lock;
//   3. both R2 uploads, with no client held: the print file under
//      menu-print/<id>/<uuid>.jpg, the proof under menu-proof/<id>/<uuid>.jpg;
//   4. ONE transaction on one client: the draft row FOR UPDATE; 409
//      MENU_DRAFT_CHANGED when version or art_version moved; requireWords; 409
//      MENU_DRAFT_CHANGED when any layout piece is not done, or, for the logo
//      role only, when the plan's planner image rev is not the posted one; the
//      proposal row FOR UPDATE: 409 MENU_PROOF_ARCHIVED for an archived one
//      (the proof page would 404), MENU_EVENT_PASSED, MENU_MARKED_NONE while
//      the no-menu mark is set (Claude's call: a proof whose Looks great could
//      never release is not sent), MENU_PRINT_CHANGED when menu_print_key is
//      not expected_print_key (an admin upload from another tab),
//      MENU_UPLOAD_LIVE while the admin's own upload is live (the print state
//      replaced: a live key that is neither the draft's released key nor its
//      approved key), since release guard 4 would refuse the client's Looks
//      great beside it, before anything is superseded or inserted; then the v1
//      stamp (menuRelease.stampV1Release); 409 MENU_PROOF_ALREADY_SENT when the
//      latest live proof has this pair and went out under 10 minutes ago (the
//      client reads it as success, so a post retried by a page that never
//      refetched lands here first); 409 MENU_PROOF_CHANGED when the latest
//      proof's id or answer is not what the page saw (menuProofs
//      proofSeenChanged: the page does not poll, so a change request is never
//      superseded unseen); 429 MENU_PROOF_SEND_CAP at 5 proofs for the
//      proposal in a rolling 24 hours; the approved_* stamps (released_*
//      untouched); the old proof superseded; the new proof inserted, pending,
//      or no_address for no email or an .invalid placeholder; the activity
//      rows menu_approved and menu_proof_sent (never the email's outcome);
//      COMMIT, the transaction's last statement.
//   NO setMenuPrintKey and NO reaccrueDuty: the print file is HELD on
//   approved_print_key and reaches staff only through menuRelease.js
//   (releaseHeldPrint), so menu_print_key and the $5 menu_print duty line do
//   not move here.
//   5. after the release, outside any transaction: the email. The
//      immediate-send gate first (shouldSendImmediate: a bad address or an
//      archived proposal reads suppressed and sends nothing); then sendEmail
//      with menuProofReady to the live clients.email, meta { messageType
//      'menu_proof', clientId, proposalId } (the message log files it under
//      this event, never the client's newest proposal) and no sentBy (so the
//      Inbox never reads the send as a reply); then one pool.query writing email_status (sent;
//      skipped for an id sendEmail returns without sending; failed on a throw,
//      with a fixed Sentry line and no provider text) and sent_to (only when
//      sent). A failed or suppressed send never fails the request. A failed
//      status write is reported and leaves the proof pending, which the read
//      model shows as failed after 10 minutes.
//   6. inboxCache.invalidate(), then the response: { version, art_version,
//      proof, print }, the GET's two blocks re-read after the commit.
// A rollback orphans the uploaded objects (the menu-print precedent). A 40P01
// at any statement answers 409 MENU_DRAFT_CHANGED (mapDeadlock). No lockCalls:
// Approve reserves nothing, and it never waits on the cap's table lock.
//
// The piece read needs no row lock: a done piece leaves done only through
// re-roll or Generate, and both lock the draft row first, which this holds.

const express = require('express');
const crypto = require('crypto');
const sharp = require('sharp');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { AppError, ConflictError, ValidationError, NotFoundError } = require('../../utils/errors');
const { uploadFile } = require('../../utils/storage');
const { isValidUpload, safeUploadExtension } = require('../../utils/fileValidation');
const { mapDeadlock } = require('../../utils/menuArtCap');
const { loadEventPlan, plannerImageKeyOf, plannerImageRev } = require('../../utils/menuDrinkSource');
const { readReviewBlocks } = require('../../utils/menuDraftRead');
const { stampV1Release } = require('../../utils/menuRelease');
const { proofSeenChanged } = require('../../utils/menuProofs');
const { chicagoTodayYmd } = require('../../utils/businessTime');
const { shouldSendImmediate } = require('../../utils/messageSuppression');
const { sendEmail } = require('../../utils/email');
const { menuProofReady } = require('../../utils/lifecycleEmailTemplates');
const { menuProofUrl } = require('../../utils/urls');
const { getEventTypeLabel } = require('../../utils/eventTypes');
const inboxCache = require('../../utils/inbox/cache');
const { assertNotLegalHold } = require('./patchGuards');
const {
  isObject, parseId, parseVersion, requireProposal, noDraft, draftChanged, requireWords, layoutPieceKeys,
} = require('./menuDraftShared');

const router = express.Router();

// The printed menu is 8 x 10 in at 300 dpi: the 800 x 1000 canvas at scale 3.
const PRINT = Object.freeze({ field: 'file', noun: 'menu', width: 2400, height: 3000, maxBytes: null });
// The proof: the render at 1200 x 1500 over the 56 px proof band (spec 10.1).
const PROOF = Object.freeze({ field: 'proof', noun: 'proof', width: 1200, height: 1556, maxBytes: 3 * 1024 * 1024 });
const INT4_MAX = 2147483647;
const DIGITS = /^\d{1,10}$/;
// A print key is server-made (menu-print/<id>/<uuid>.<ext>, about 60 characters).
const KEY_MAX = 512;
// plannerImageRev's shape: 16 lowercase hex.
const REV_RE = /^[0-9a-f]{16}$/;
// Spec 10.4: at most this many proofs per proposal in a rolling 24 hours.
const SEND_CAP = 5;

const changed = () => draftChanged('The draft changed. Approve again.');
const printChanged = () => new ConflictError(
  'The print file changed since you confirmed. Check it and approve again.', 'MENU_PRINT_CHANGED');
const eventPassed = () => new ConflictError("This event has passed, so there's nothing to send.", 'MENU_EVENT_PASSED');
const uploadLive = () => new ConflictError(
  'Your uploaded file is what staff print. Remove it first to send this menu.', 'MENU_UPLOAD_LIVE');
const proofChanged = () => new ConflictError("The client's review changed. Refresh to see it.", 'MENU_PROOF_CHANGED');
const ANSWERS = new Set(['approved', 'changes']);

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
  const seenId = b.seen_proof_id;
  if (typeof seenId !== 'string' || (seenId !== '' && !(DIGITS.test(seenId) && Number(seenId) >= 1 && Number(seenId) <= INT4_MAX))) {
    throw new ValidationError({ seen_proof_id: 'Send the proof you saw, or an empty value for none.' });
  }
  const seenAnswer = b.seen_proof_answer;
  if (typeof seenAnswer !== 'string' || (seenAnswer !== '' && !ANSWERS.has(seenAnswer))) {
    throw new ValidationError({ seen_proof_answer: "Send the client's answer you saw, or an empty value for none." });
  }
  let expectedRev;
  if (logo) {
    const r = b.expected_planner_image_rev;
    if (typeof r !== 'string' || (r !== '' && !REV_RE.test(r))) {
      throw new ValidationError({ expected_planner_image_rev: 'Send the client image you rendered with, or an empty value for none.' });
    }
    expectedRev = r === '' ? null : r;
  }
  const seen = { id: seenId === '' ? null : Number(seenId), answer: seenAnswer === '' ? null : seenAnswer };
  return { version, artVersion, expectedKey: raw === '' ? null : raw, expectedRev, seen };
}

// One posted JPEG's bytes, or a 400 on its field: one file, JPEG by its magic
// bytes only (the declared name and type are never trusted), at most maxBytes,
// exactly width x height, then one bounded full decode.
async function jpegOf(files, spec) {
  const { field, noun, width, height, maxBytes } = spec;
  const fail = (text) => new ValidationError({ [field]: text });
  const file = files && files[field]; // eslint-disable-line security/detect-object-injection -- field is one of two literal names
  if (!file || Array.isArray(file)) throw fail(`Attach the ${noun} as one JPEG.`);
  if (!isValidUpload(file) || safeUploadExtension(file) !== '.jpg') throw fail(`The ${noun} must be a JPEG.`);
  if (maxBytes !== null && file.data.length > maxBytes) throw fail(`The ${noun} must be 3 MB or smaller.`);
  let meta;
  try {
    meta = await sharp(file.data).metadata();
  } catch {
    throw fail(`The ${noun} image could not be read.`);
  }
  if (meta.format !== 'jpeg' || meta.width !== width || meta.height !== height) {
    throw fail(`The ${noun} must be exactly ${width} x ${height} pixels.`);
  }
  // The header alone can lie (a few hundred bytes can claim the size), so
  // decode it once, bounded to that size, on sharp's thread pool. failOn
  // 'warning': 'truncated' passes a cut file that ends in an FF D9 marker.
  try {
    await sharp(file.data, { failOn: 'warning', limitInputPixels: width * height }).stats();
  } catch {
    throw fail(`The ${noun} image could not be read.`);
  }
  return file.data;
}

// The draft's role and the event day, before any upload (the locked rows are
// what the transaction trusts).
const PRE_SQL = `
  SELECT d.inputs->>'planner_image_role' AS role, to_char(p.event_date, 'YYYY-MM-DD') AS event_date
    FROM menu_drafts d
    JOIN proposals p ON p.id = d.proposal_id
   WHERE d.proposal_id = $1`;

const DRAFT_LOCK_SQL = `
  SELECT id, version, art_version, inputs, content, approved_print_key, released_print_key, NOW() AS db_now
    FROM menu_drafts
   WHERE proposal_id = $1
     FOR UPDATE`;

const PIECES_SQL = `
  SELECT piece_key FROM menu_draft_pieces
   WHERE draft_id = $1 AND piece_key = ANY($2::text[]) AND status = 'done' AND r2_key IS NOT NULL`;

const PROPOSAL_LOCK_SQL = `
  SELECT id, client_id, status, menu_print_key, menu_not_required, event_type, event_type_custom,
         to_char(event_date, 'YYYY-MM-DD') AS event_date
    FROM proposals
   WHERE id = $1
     FOR UPDATE`;

// The double-submit guard (spec 10.2): the latest live proof of this pair, sent under 10 minutes ago.
const RECENT_SAME_SQL = `
  SELECT id FROM menu_proofs
   WHERE draft_id = $1 AND superseded_at IS NULL AND withdrawn_at IS NULL
     AND version = $2 AND art_version = $3
     AND sent_at > NOW() - INTERVAL '10 minutes'`;

// The send cap (spec 10.4), counted inside the transaction under the draft lock.
const SENT_TODAY_SQL = `
  SELECT COUNT(*)::int AS n FROM menu_proofs
   WHERE proposal_id = $1 AND sent_at > NOW() - INTERVAL '24 hours'`;

const CLIENT_SQL = 'SELECT id, name, email, email_status, communication_preferences FROM clients WHERE id = $1';

const STAMP_SQL = `
  UPDATE menu_drafts
     SET approved_version = $2, approved_art_version = $3, approved_print_key = $4,
         approved_planner_image_key = $5, approved_at = NOW(), approved_by = $6
   WHERE id = $1
  RETURNING id, version, art_version`;

const SUPERSEDE_SQL = 'UPDATE menu_proofs SET superseded_at = NOW() WHERE draft_id = $1 AND superseded_at IS NULL';

const PROOF_INSERT_SQL = `
  INSERT INTO menu_proofs (draft_id, proposal_id, version, art_version, r2_key, sent_by, email_status)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  RETURNING id, token, email_status`;

const ACTIVITY_SQL = `
  INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
  VALUES ($1, $2, 'admin', $3, $4)`;

const EMAIL_STATUS_SQL = "UPDATE menu_proofs SET email_status = $2, sent_to = $3 WHERE id = $1 AND email_status = 'pending'";

// An address the proof can be emailed to: set, and not an RFC 2606 .invalid placeholder.
function mailable(client) {
  const email = client && typeof client.email === 'string' ? client.email.trim() : '';
  return email !== '' && !email.toLowerCase().endsWith('.invalid');
}

// Step 4. COMMIT is the try's last statement, so a failure can only ever roll
// back an uncommitted transaction. The client is released before it returns.
async function approveInTx({ id, userId, version, artVersion, expectedKey, expectedRev, seen, key, proofKey }) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const draft = (await db.query(DRAFT_LOCK_SQL, [id])).rows[0];
    if (!draft) throw noDraft();
    if (draft.version !== version || draft.art_version !== artVersion) throw changed();
    requireWords(draft.content, draft.db_now);
    const used = layoutPieceKeys(draft.content);
    const { rows: ready } = await db.query(PIECES_SQL, [draft.id, used]);
    if (ready.length !== used.length) throw changed();

    // The logo role prints the planner image, so the file is only right when
    // the client rendered the image the plan holds now. A role that turned
    // logo since the pre-check moved the version (refused above); undefined
    // here is still a change, never a pass.
    const logo = isObject(draft.inputs) && draft.inputs.planner_image_role === 'logo';
    let plannerImageKey = null;
    if (logo) {
      if (expectedRev === undefined) throw changed();
      plannerImageKey = plannerImageKeyOf(await loadEventPlan(id, db));
      if (plannerImageRev(plannerImageKey) !== expectedRev) throw changed();
    }

    const proposal = (await db.query(PROPOSAL_LOCK_SQL, [id])).rows[0];
    if (!proposal) throw new NotFoundError('Proposal not found.');
    if (proposal.status === 'archived') {
      throw new ConflictError('This event is archived, so there is no one to send it to.', 'MENU_PROOF_ARCHIVED');
    }
    if (proposal.event_date && proposal.event_date < chicagoTodayYmd()) throw eventPassed();
    if (proposal.menu_not_required === true) {
      throw new ConflictError('This event is marked as needing no printed menu. Clear the mark first.', 'MENU_MARKED_NONE');
    }
    const liveKey = proposal.menu_print_key || null;
    if (liveKey !== expectedKey) throw printChanged();
    if (liveKey !== null && liveKey !== (draft.released_print_key || null) && liveKey !== (draft.approved_print_key || null)) {
      throw uploadLive();
    }

    await stampV1Release(db, draft.id);
    if ((await db.query(RECENT_SAME_SQL, [draft.id, version, artVersion])).rows.length) {
      throw new ConflictError('This menu was just sent.', 'MENU_PROOF_ALREADY_SENT');
    }
    if (await proofSeenChanged(db, draft.id, seen)) throw proofChanged();
    if ((await db.query(SENT_TODAY_SQL, [id])).rows[0].n >= SEND_CAP) {
      throw new AppError("You've sent this menu 5 times today. Try again tomorrow.", 429, 'MENU_PROOF_SEND_CAP');
    }
    const client = proposal.client_id ? (await db.query(CLIENT_SQL, [proposal.client_id])).rows[0] || null : null;

    const stamped = (await db.query(STAMP_SQL,
      [draft.id, version, artVersion, key, logo ? plannerImageKey : null, userId])).rows[0];
    await db.query(SUPERSEDE_SQL, [draft.id]);
    const proof = (await db.query(PROOF_INSERT_SQL,
      [draft.id, id, version, artVersion, proofKey, userId, mailable(client) ? 'pending' : 'no_address'])).rows[0];
    await db.query(ACTIVITY_SQL, [id, 'menu_approved', userId,
      JSON.stringify({ draft_id: draft.id, version, art_version: artVersion, print_key: key })]);
    await db.query(ACTIVITY_SQL, [id, 'menu_proof_sent', userId,
      JSON.stringify({ proof_id: proof.id, draft_id: draft.id, version, art_version: artVersion })]);
    await db.query('COMMIT');
    return { stamped, proof, proposal, client };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw mapDeadlock(err);
  } finally {
    db.release();
  }
}

// Step 5: the email and its outcome, after the commit, on the pool. Never throws.
async function sendProof({ proof, proposal, client }) {
  if (proof.email_status !== 'pending') return;
  let status;
  let sentTo = null;
  try {
    const gate = await shouldSendImmediate({ proposal, client, channel: 'email' });
    if (!gate.ok) {
      status = 'suppressed';
    } else {
      const mail = menuProofReady({
        clientName: client.name,
        eventTypeLabel: getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom }),
        proofUrl: menuProofUrl(proof.token),
        hasEventDate: Boolean(proposal.event_date),
      });
      const to = client.email.trim();
      // proposalId files the log entry under this event, never the client's newest one.
      const result = await sendEmail({ to, ...mail, meta: { messageType: 'menu_proof', clientId: client.id, proposalId: proposal.id } });
      const skipped = result && (result.id === 'dev-skipped' || result.id === 'skipped-invalid');
      status = skipped ? 'skipped' : 'sent';
      if (!skipped) sentTo = to;
    }
  } catch (err) {
    status = 'failed';
    // A fixed line: a provider message can carry the address.
    Sentry.captureException(new Error('menu proof email failed'), {
      tags: { area: 'menu-proof', step: 'email', quota: err && err.name === 'QuotaExceededError' ? 'yes' : 'no' },
      extra: { proof_id: proof.id },
    });
  }
  try {
    await pool.query(EMAIL_STATUS_SQL, [proof.id, status, sentTo]);
  } catch {
    Sentry.captureException(new Error('menu proof email status not written'), {
      tags: { area: 'menu-proof', step: 'email-status' }, extra: { proof_id: proof.id, status },
    });
  }
}

// Approve and send: hold the print file, write the proof, email the client.
router.post('/:id/menu-draft/approve', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  assertNotLegalHold(id);
  await requireProposal(id);
  // The role decides whether the planner image rev is required; the locked
  // row in the transaction is what the stamp trusts.
  const pre = (await pool.query(PRE_SQL, [id])).rows[0];
  if (!pre) throw noDraft();
  const fields = parseFields(req.body, { logo: pre.role === 'logo' });
  const bytes = await jpegOf(req.files, PRINT);
  const proofBytes = await jpegOf(req.files, PROOF);
  if (pre.event_date && pre.event_date < chicagoTodayYmd()) throw eventPassed();

  // R2 first, with no transaction open (step 3).
  const key = `menu-print/${id}/${crypto.randomUUID()}.jpg`;
  const proofKey = `menu-proof/${id}/${crypto.randomUUID()}.jpg`;
  await uploadFile(bytes, key);
  await uploadFile(proofBytes, proofKey);

  const committed = await approveInTx({ id, userId: req.user.id, ...fields, key, proofKey });
  await sendProof(committed);
  inboxCache.invalidate();
  const blocks = await readReviewBlocks(id);
  res.json({ version: committed.stamped.version, art_version: committed.stamped.art_version, ...blocks });
}));

module.exports = router;
