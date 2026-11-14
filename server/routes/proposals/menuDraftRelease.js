// The held menu print file's admin release and Close request (spec 2026-10-19 sections 10.3, 10.5 and
// 20; lane menu-approve-send): Release for printing, Put it back for staff, and closing a change request.
//
//   POST /api/proposals/:id/menu-draft/release      { version, art_version, seen_proof_id, seen_proof_answer, after_event? }
//   POST /api/proposals/:id/menu-draft/proof/close  { proof_id }
//
// Admin and manager: auth, requireAdminOrManager, adminWriteLimiter and
// asyncHandler; :id must be digits (400), the legal-hold proposal is refused
// first with 409 LEGAL_HOLD before any read or write (assertNotLegalHold,
// isLegalHold failing closed; money law 15), and the proposal and its draft
// must exist (404). Both answer the GET's { proof, print } blocks, re-read
// after the commit (menuDraftRead.readReviewBlocks).
//
// Release: version and art_version are the approved pair the page showed
// (print.approved_version, print.approved_art_version), seen_proof_id and
// seen_proof_answer what it showed of the latest proof (an integer and
// approved or changes, each empty or null when it showed none; both
// required), after_event is an optional boolean, required true after the
// event day. One transaction on one client: the draft FOR UPDATE; 409
// MENU_NOT_HELD when nothing was ever approved; 409 MENU_DRAFT_CHANGED when the
// approved pair is not the posted one; 409 MENU_PROOF_CHANGED when the latest
// proof's id or answer is not what the page saw (menuProofs.proofSeenChanged:
// the page does not poll, so a change request asked since is never released
// over unseen); then menuRelease.releaseHeldPrint (via 'admin'), which locks the
// proposal and runs the five guards; when nothing is held it tries
// restoreReleasedPrint instead (Put it back for staff, the removed state). A
// refusal maps to its 409: legal_hold LEGAL_HOLD, marked MENU_MARKED_NONE,
// not_held MENU_NOT_HELD, file_changed MENU_PRINT_CHANGED, event_passed
// MENU_EVENT_PASSED. COMMIT; the client is released; then reaccrueDuty (the $5
// menu_print duty line re-reads the committed key) and inboxCache.invalidate().
// A release or Put it back posted with after_event true (lane menu-approve-send,
// fix round 1) instead awaits that same re-accrual (payrollAccrual
// maybeReaccrueForDuty, on its own connection, after the client's release),
// since its confirm names the duty, and the 200 adds duty, what it left:
//   added          a live (payable) menu_print duty line stands for the event
//                  now, written by this re-accrual or standing already;
//   pending        the event is not completed yet, so the completion job adds it;
//   not_added      its pay period is not open, or it is more than 21 days back
//                  (maybeReaccrueForDuty's window);
//   check_payroll  the re-accrual ran and wrote no menu_print line (no
//                  bartender attributed, not paid in full, no one on the
//                  roster), the event is archived and never completes, or the
//                  re-accrual threw (a fixed Sentry line with the proposal id
//                  only; a throw says nothing of the pay period, fix round 2).
// Every other release keeps the fire-and-forget call and carries no duty.
//
// Close request (the change request on a menu whose file was released before
// the client asked, so Release is not offered): proof_id is the proof the page
// showed. One transaction: the draft FOR UPDATE, the proposal FOR UPDATE (the
// release lock order); 409 MENU_PROOF_CHANGED unless that proof is the draft's
// latest, answered changes, not withdrawn, and the print state is not held
// (while a file is held, Release or approving again closes it); then its
// withdrawn_at, the menu_proof_closed activity row (details { proof_id,
// draft_id }, never the note), COMMIT, and inboxCache.invalidate(). The print
// key does not move, so no duty re-accrual. The proof's own state closes its
// Inbox task, and the client's page shows the withdrawn screen.

const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { ConflictError, ValidationError } = require('../../utils/errors');
const { mapDeadlock } = require('../../utils/menuArtCap');
const { reaccrueDuty } = require('../../utils/menuPrintFile');
const { releaseHeldPrint, restoreReleasedPrint } = require('../../utils/menuRelease');
const { readPrintState } = require('../../utils/menuPrintState');
const { proofSeenChanged } = require('../../utils/menuProofs');
const { readReviewBlocks } = require('../../utils/menuDraftRead');
const inboxCache = require('../../utils/inbox/cache');
const { assertNotLegalHold } = require('./patchGuards');
const { isObject, parseId, parseVersion, requireProposal, noDraft, draftChanged } = require('./menuDraftShared');

const router = express.Router();
const INT4_MAX = 2147483647;

// Each refusal reason of the release helper, as the admin's 409.
const REFUSALS = Object.freeze({
  legal_hold: ['This event is on hold and can\'t be changed.', 'LEGAL_HOLD'],
  marked: ['This event is marked as needing no printed menu. Clear the mark first.', 'MENU_MARKED_NONE'],
  not_held: ['There is no held menu to release.', 'MENU_NOT_HELD'],
  file_changed: ['A different print file is live now. Refresh to see it.', 'MENU_PRINT_CHANGED'],
  event_passed: ['This event has passed. Releasing now adds the $5 print duty for the staff on it if its pay period is still open.', 'MENU_EVENT_PASSED'],
});

// The after-event release's duty (header): a payable menu_print line on the
// event's shifts, and the event's status for a re-accrual that did not run.
const DUTY_LINE_SQL = `
  SELECT 1
    FROM payout_duty_lines dl
    JOIN shifts s ON s.id = dl.shift_id
   WHERE s.proposal_id = $1 AND dl.kind = 'menu_print' AND dl.removed_at IS NULL
     AND (dl.held_state IS NULL OR dl.held_state = 'confirmed')
   LIMIT 1`;
const STATUS_SQL = 'SELECT status FROM proposals WHERE id = $1';
// maybeReaccrueForDuty's skips that mean the event is not completed (or not recent).
const NOT_RUN = new Set(['not_recent_completed', 'not_completed']);

const DRAFT_LOCK_SQL = `
  SELECT id, version, art_version, approved_version, approved_art_version, approved_print_key, released_print_key
    FROM menu_drafts
   WHERE proposal_id = $1
     FOR UPDATE`;

const PROPOSAL_LOCK_SQL = 'SELECT id, menu_print_key, menu_not_required FROM proposals WHERE id = $1 FOR UPDATE';

const LATEST_PROOF_SQL = `
  SELECT id, version, art_version, answer, withdrawn_at
    FROM menu_proofs
   WHERE draft_id = $1 AND superseded_at IS NULL
   ORDER BY sent_at DESC, id DESC
   LIMIT 1`;

const CLOSE_SQL = 'UPDATE menu_proofs SET withdrawn_at = NOW() WHERE id = $1 AND withdrawn_at IS NULL RETURNING id';

const CLOSED_ACTIVITY_SQL = `
  INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
  VALUES ($1, 'menu_proof_closed', 'admin', $2, $3)`;

const ANSWERS = new Set(['approved', 'changes']);
const empty = (v) => v === '' || v === null;
const proofChanged = () => new ConflictError("The client's review changed. Refresh to see it.", 'MENU_PROOF_CHANGED');

// What the page last saw of the latest proof: { id, answer }, null each for none.
function parseSeen(b) {
  const id = b.seen_proof_id;
  if (!empty(id) && !(Number.isInteger(id) && id >= 1 && id <= INT4_MAX)) {
    throw new ValidationError({ seen_proof_id: 'Send the proof you saw, or an empty value for none.' });
  }
  const answer = b.seen_proof_answer;
  if (!empty(answer) && !ANSWERS.has(answer)) {
    throw new ValidationError({ seen_proof_answer: "Send the client's answer you saw, or an empty value for none." });
  }
  return { id: empty(id) ? null : id, answer: empty(answer) ? null : answer };
}

// The release body: the approved pair, the proof the page saw and the after-event confirm.
function parseRelease(body) {
  const b = isObject(body) ? body : {};
  const version = parseVersion(b.version);
  const artVersion = b.art_version;
  if (!Number.isInteger(artVersion) || artVersion < 0 || artVersion > INT4_MAX) {
    throw new ValidationError({ art_version: 'Send the art version you saw.' });
  }
  const seen = parseSeen(b);
  if (b.after_event !== undefined && typeof b.after_event !== 'boolean') {
    throw new ValidationError({ after_event: 'after_event is true or false.' });
  }
  return { version, artVersion, seen, afterEvent: b.after_event === true };
}

function parseProofId(body) {
  const raw = isObject(body) ? body.proof_id : undefined;
  if (!Number.isInteger(raw) || raw < 1 || raw > INT4_MAX) {
    throw new ValidationError({ proof_id: 'Send the proof you saw.' });
  }
  return raw;
}

// One transaction on one pooled client; any error rolls back and goes through
// mapDeadlock; the client is released before it returns.
async function inTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw mapDeadlock(err);
  } finally {
    client.release();
  }
}

// The after-event release's re-accrual, awaited, and what it left (header).
// Runs on the pool after the route's client is released; never throws.
async function dutyAfterRelease(proposalId) {
  try {
    // The same re-accrual reaccrueDuty fires, read lazily as menuPrintFile does.
    const out = await require('../../utils/payrollAccrual').maybeReaccrueForDuty(proposalId);
    if ((await pool.query(DUTY_LINE_SQL, [proposalId])).rows.length) return 'added';
    const reason = out && out.skipped === true ? out.reason : null;
    if (reason === 'pay_period_not_open') return 'not_added';
    if (NOT_RUN.has(reason)) {
      const row = (await pool.query(STATUS_SQL, [proposalId])).rows[0];
      const status = row ? row.status : null;
      if (status === 'completed') return 'not_added';
      return status === 'archived' ? 'check_payroll' : 'pending';
    }
    return 'check_payroll';
  } catch {
    // A fixed line: the accrual's own error can carry payroll detail.
    Sentry.captureException(new Error('menu release duty re-accrual failed'), {
      tags: { area: 'menu-release', step: 'duty' }, extra: { proposal_id: proposalId },
    });
    // Not known to be a closed pay period: the owner checks the duty lines.
    return 'check_payroll';
  }
}

// Release for printing, or Put it back for staff: the held file (or the menu's own removed one) to staff.
router.post('/:id/menu-draft/release', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  assertNotLegalHold(id);
  const { version, artVersion, seen, afterEvent } = parseRelease(req.body);
  await requireProposal(id);
  await inTx(async (client) => {
    const draft = (await client.query(DRAFT_LOCK_SQL, [id])).rows[0];
    if (!draft) throw noDraft();
    if (!draft.approved_print_key) throw new ConflictError(...REFUSALS.not_held);
    if (draft.approved_version !== version || draft.approved_art_version !== artVersion) {
      throw draftChanged('The menu changed since this page loaded. Refresh to see it.');
    }
    if (await proofSeenChanged(client, draft.id, seen)) throw proofChanged();
    const args = { draftId: draft.id, proposalId: id, actorId: req.user.id, afterEvent };
    let out = await releaseHeldPrint(client, { ...args, via: 'admin' });
    if (!out.released && out.reason === 'not_held') out = await restoreReleasedPrint(client, args);
    if (!out.released) throw new ConflictError(...REFUSALS[out.reason]); // eslint-disable-line security/detect-object-injection -- reason is one of the helper's five literals
  });
  // Committed and released: the accrual reads the key this request posted.
  if (!afterEvent) {
    reaccrueDuty(id);
    inboxCache.invalidate();
    res.json(await readReviewBlocks(id));
    return;
  }
  inboxCache.invalidate();
  const duty = await dutyAfterRelease(id);
  res.json({ ...(await readReviewBlocks(id)), duty });
}));

// Close request: withdraw a change request on a menu already released, leaving the file live.
router.post('/:id/menu-draft/proof/close', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  assertNotLegalHold(id);
  const proofId = parseProofId(req.body);
  await requireProposal(id);
  await inTx(async (client) => {
    const draft = (await client.query(DRAFT_LOCK_SQL, [id])).rows[0];
    if (!draft) throw noDraft();
    const proposal = (await client.query(PROPOSAL_LOCK_SQL, [id])).rows[0];
    const latest = (await client.query(LATEST_PROOF_SQL, [draft.id])).rows[0] || null;
    if (!proposal || !latest || latest.id !== proofId || latest.answer !== 'changes' || latest.withdrawn_at) {
      throw proofChanged();
    }
    const { state } = readPrintState({
      menuPrintKey: proposal.menu_print_key, menuNotRequired: proposal.menu_not_required === true, draft, latestProof: latest,
    });
    if (state === 'held') throw proofChanged();
    if (!(await client.query(CLOSE_SQL, [latest.id])).rows.length) throw proofChanged();
    await client.query(CLOSED_ACTIVITY_SQL, [id, req.user.id, JSON.stringify({ proof_id: latest.id, draft_id: draft.id })]);
  });
  inboxCache.invalidate();
  res.json(await readReviewBlocks(id));
}));

module.exports = router;
