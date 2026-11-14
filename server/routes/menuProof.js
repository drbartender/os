// The client menu proof's public routes (spec 2026-10-19 sections 12, 18 and 20), gated by the proof's
// UUID token: the page state, the proof picture under menu-proof/<proposal_id>/, and the one answer.
//
//   GET  /:token          { state, answer, answer_note, answered_at, image }; 404 for an
//                         unknown token, an archived proposal or a cascaded row
//   GET  /:token/image    the proof JPEG, only while the state is open, approved
//                         or changes; Cache-Control private, no-cache
//   POST /:token/answer   { answer, note? } once; 200 { state, answered_at }
//
// The token is the only key: requireUuidToken runs before any query, then the
// limiters (spec 18). The GET answers no admin data, no client name, contact,
// event date, venue or amounts: only the state and, in the approved and
// changes states, the client's own answer, note and when (spec 18 lists those
// fields plus image; spec 20 omits image, so the union is answered, image a
// boolean that is true exactly where the picture is served). The picture is
// read only through sendR2Object with the prefix built from the row's own
// proposal_id, never from input, so nothing under menu-print/ or another
// event's prefix is reachable.
//
// The answer is one transaction on one pooled connection: the conditional
// one-shot UPDATE (no answer yet, not superseded, not withdrawn, not expired
// by the shared token-life expression, the proposal not archived) with a
// rowCount guard; zero rows re-reads the proof and refuses with 409
// MENU_PROOF_ANSWERED, MENU_PROOF_SUPERSEDED, MENU_PROOF_WITHDRAWN or
// MENU_PROOF_EXPIRED, or 404; then the activity row menu_proof_approved or
// menu_proof_changes (actor 'client', details proof_id, version, art_version,
// plus note_length for changes, never the note). The proposal under legal
// hold is refused as not found before anything is written (isLegalHold, which
// fails closed). No release runs here yet: the approve-and-send lane adds
// releaseHeldPrint, reaccrueDuty and the Inbox invalidation to this route.

const express = require('express');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const {
  publicLimiter, publicTokenIpLimiter, menuProofReadLimiter, menuProofAnswerLimiter,
} = require('../middleware/rateLimiters');
const { requireUuidToken } = require('../utils/tokens');
const { NotFoundError, ValidationError, ConflictError } = require('../utils/errors');
const { sendR2Object } = require('../utils/r2Proxy');
const { isLegalHold } = require('../utils/legalHold');
const { PROOF_IMAGE_STATES, proofExpiredSql, loadProofByToken } = require('../utils/menuProofs');

const router = express.Router();

const NOT_FOUND = "We couldn't find that menu.";
const NOTE_MAX = 1000;

// The one-shot answer: $1 the token, $2 the answer, $3 the note. Built once at
// load from the shared token-life fragment (proofExpiredSql, fixed text over
// its two aliases; no input reaches the statement but through the parameters).
const ANSWER_SQL = `
  UPDATE menu_proofs mp
     SET answer = $2, answer_note = $3, answered_at = NOW()
    FROM proposals p
   WHERE mp.token = $1
     AND p.id = mp.proposal_id
     AND p.status IS DISTINCT FROM 'archived'
     AND mp.answer IS NULL
     AND mp.superseded_at IS NULL
     AND mp.withdrawn_at IS NULL
     AND NOT ${proofExpiredSql({ proof: 'mp', proposal: 'p' })}
  RETURNING mp.id, mp.proposal_id, mp.version, mp.art_version, mp.answered_at`;

// The 409 for each state a refused answer re-reads. 'open' can only be read
// back when the proof's proposal moved between the UPDATE and the re-read (an
// event date pushed later, an archive undone); the page refetches either way.
const REFUSALS = {
  approved: ['MENU_PROOF_ANSWERED', "You've already answered this menu."],
  changes: ['MENU_PROOF_ANSWERED', "You've already answered this menu."],
  superseded: ['MENU_PROOF_SUPERSEDED', 'A newer version was sent.'],
  withdrawn: ['MENU_PROOF_WITHDRAWN', 'This menu is no longer open for review.'],
  expired: ['MENU_PROOF_EXPIRED', 'This link has expired.'],
  open: ['MENU_PROOF_CHANGED', "That didn't go through. Please try again."],
};

/** The public GET's body: the state, the client's own answer where it stands, and whether a picture is served. */
function publicProofView(proof) {
  const answered = proof.state === 'approved' || proof.state === 'changes';
  return {
    state: proof.state,
    answer: answered ? proof.answer : null,
    answer_note: answered ? proof.answer_note : null,
    answered_at: answered ? proof.answered_at : null,
    image: PROOF_IMAGE_STATES.includes(proof.state),
  };
}

/**
 * The answer body (spec 21): `answer` is approved or changes; `note` is a
 * trimmed string of 1 to 1,000 characters for changes, and absent, null or
 * blank for approved. Returns { answer, note } with note null for approved.
 */
function validateAnswer(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError({ answer: 'Choose Looks great or Request changes.' });
  }
  const { answer, note } = body;
  if (answer !== 'approved' && answer !== 'changes') {
    throw new ValidationError({ answer: 'Choose Looks great or Request changes.' });
  }
  if (note !== undefined && note !== null && typeof note !== 'string') {
    throw new ValidationError({ note: 'The note must be text.' });
  }
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (answer === 'approved') {
    if (trimmed) throw new ValidationError({ note: 'Looks great takes no note.' });
    return { answer, note: null };
  }
  if (!trimmed) throw new ValidationError({ note: "Tell us what you'd like changed." });
  if (trimmed.length > NOTE_MAX) throw new ValidationError({ note: 'Keep the note to 1,000 characters.' });
  return { answer, note: trimmed };
}

// The page state for a token.
router.get('/:token', requireUuidToken('token', NOT_FOUND), publicTokenIpLimiter, menuProofReadLimiter,
  asyncHandler(async (req, res) => {
    const proof = await loadProofByToken(pool, req.params.token);
    if (!proof) throw new NotFoundError(NOT_FOUND);
    res.set('Cache-Control', 'no-store');
    res.json(publicProofView(proof));
  }));

// The proof picture, under the row's own menu-proof/<proposal_id>/ prefix, while the state shows one.
router.get('/:token/image', requireUuidToken('token', NOT_FOUND), publicTokenIpLimiter, menuProofReadLimiter,
  asyncHandler(async (req, res) => {
    const proof = await loadProofByToken(pool, req.params.token);
    if (!proof || !PROOF_IMAGE_STATES.includes(proof.state) || !Number.isInteger(proof.proposal_id)) {
      throw new NotFoundError(NOT_FOUND);
    }
    await sendR2Object(res, proof.r2_key, { prefix: `menu-proof/${proof.proposal_id}/` });
  }));

// Looks great or Request changes, once per proof, in one transaction on one connection.
router.post('/:token/answer', requireUuidToken('token', NOT_FOUND), publicLimiter, menuProofAnswerLimiter,
  asyncHandler(async (req, res) => {
    const { answer, note } = validateAnswer(req.body);
    const { token } = req.params;
    const client = await pool.connect();
    let answered;
    try {
      await client.query('BEGIN');
      const proof = await loadProofByToken(client, token);
      if (!proof || isLegalHold(proof.proposal_id)) throw new NotFoundError(NOT_FOUND);

      const upd = await client.query(ANSWER_SQL, [token, answer, note]);
      if (upd.rowCount !== 1) {
        const now = await loadProofByToken(client, token);
        if (!now) throw new NotFoundError(NOT_FOUND);
        const [code, message] = REFUSALS[now.state];
        throw new ConflictError(message, code);
      }

      const row = upd.rows[0];
      const details = { proof_id: row.id, version: row.version, art_version: row.art_version };
      if (answer === 'changes') details.note_length = note.length;
      await client.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
         VALUES ($1, $2, 'client', $3)`,
        [row.proposal_id, answer === 'approved' ? 'menu_proof_approved' : 'menu_proof_changes', JSON.stringify(details)]);
      await client.query('COMMIT');
      answered = { state: answer, answered_at: row.answered_at };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.json(answered);
  }));

module.exports = router;
module.exports.publicProofView = publicProofView;
module.exports.validateAnswer = validateAnswer;
