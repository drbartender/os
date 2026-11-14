// The client menu proof's token life, state and reads (spec 2026-10-19 sections 10.6 and 12): the one
// expiry expression every proof reader uses, the state derivation, and the by-token and latest-proof loaders.
//
// Token life (decision 15): a link works until the end of the event day in
// Chicago, computed live in SQL from the proposal's CURRENT event_date, so
// moving the event moves the end: expired when
// NOW() >= ((p.event_date + 1)::timestamp AT TIME ZONE 'America/Chicago').
// The date plus one is the next calendar day, its midnight read as Chicago wall
// time, so the end follows DST and never depends on the session's zone (GMT on
// dev and prod). With no event date the link lives 30 days from sent_at.
// proofExpiredSql is that expression; the public GET, the image route, the
// answer route's conditional UPDATE and (later) the admin read model all build
// it here, never a copy.
//
// State precedence (Claude's call, from spec 12 and the answer route's
// refusals), first match wins:
//   1. expired     the link's life is over; nothing on the page is actionable
//                  and the image is no longer served, whatever else is true.
//   2. superseded  a newer approval replaced this link; even an answered link
//                  points the client to the newest one.
//   3. withdrawn   Dallas marked the event no-menu or posted his own file. The
//                  writers set it only on an unanswered proof, so it never
//                  meets an answer; if it ever did, the withdrawal wins, since
//                  the release guard refuses it anyway.
//   4. approved or changes, the client's one answer.
//   5. open.
// A row the derivation cannot read (no expired flag, an unknown answer) throws:
// it never reads as open.

const { isUuid } = require('./tokens');

const PROOF_STATES = Object.freeze(['open', 'approved', 'changes', 'superseded', 'expired', 'withdrawn']);
// The states in which the proof picture is shown and served.
const PROOF_IMAGE_STATES = Object.freeze(['open', 'approved', 'changes']);
const ANSWERS = Object.freeze(['approved', 'changes']);

const ALIAS_RE = /^[a-z_][a-z0-9_]*$/;
// NOW() in every route; a pinned timestamptz placeholder only in the tests.
const NOW_RE = /^(NOW\(\)|\$\d+::timestamptz)$/;

function alias(name, value) {
  if (typeof value !== 'string' || !ALIAS_RE.test(value)) {
    throw new Error(`menuProofs: ${name} alias must be a plain identifier`);
  }
  return value;
}

/**
 * The instant the link stops working, as SQL over a proof alias (sent_at) and a
 * proposal alias (event_date): the Chicago midnight after the event day, or 30
 * days from sent_at with no event date.
 */
function proofLinkEndSql({ proof = 'mp', proposal = 'p' } = {}) {
  const mp = alias('proof', proof);
  const p = alias('proposal', proposal);
  return `COALESCE(((${p}.event_date + 1)::timestamp AT TIME ZONE 'America/Chicago'), ${mp}.sent_at + INTERVAL '30 days')`;
}

/** True once the link's life is over, as SQL. `now` is NOW() outside the tests. */
function proofExpiredSql({ proof = 'mp', proposal = 'p', now = 'NOW()' } = {}) {
  if (typeof now !== 'string' || !NOW_RE.test(now)) {
    throw new Error('menuProofs: now must be NOW() or a $n::timestamptz placeholder');
  }
  return `(${now} >= ${proofLinkEndSql({ proof, proposal })})`;
}

/** The page state of a proof row carrying `expired`, `superseded_at`, `withdrawn_at` and `answer`. */
function proofState(row) {
  if (!row || typeof row !== 'object') throw new Error('menuProofs: no proof row to read');
  if (typeof row.expired !== 'boolean') throw new Error('menuProofs: the row has no expired flag');
  if (row.answer !== null && row.answer !== undefined && !ANSWERS.includes(row.answer)) {
    throw new Error('menuProofs: the row holds an unknown answer');
  }
  if (row.expired) return 'expired';
  if (row.superseded_at) return 'superseded';
  if (row.withdrawn_at) return 'withdrawn';
  if (row.answer) return row.answer;
  return 'open';
}

const PROOF_COLUMNS = `mp.id, mp.draft_id, mp.proposal_id, mp.version, mp.art_version, mp.r2_key, mp.sent_at,
       mp.answer, mp.answer_note, mp.answered_at, mp.superseded_at, mp.withdrawn_at,
       ${proofExpiredSql()} AS expired`;

function withState(row) {
  return row ? { ...row, state: proofState(row) } : null;
}

/**
 * The proof behind a public token, with `expired` and `state`, or null for a
 * token that is not a UUID (no query runs), an unknown token, a proof whose
 * draft or proposal was deleted (the rows cascade), or an archived proposal.
 * `db` is the pool or the request's held client.
 */
async function loadProofByToken(db, token) {
  if (!isUuid(token)) return null;
  const { rows } = await db.query(
    `SELECT ${PROOF_COLUMNS}
       FROM menu_proofs mp
       JOIN proposals p ON p.id = mp.proposal_id
      WHERE mp.token = $1
        AND p.status IS DISTINCT FROM 'archived'`,
    [token]);
  return withState(rows[0] || null);
}

/**
 * A draft's latest proof, the one row with superseded_at IS NULL, with
 * `expired` and `state`, or null when the draft has none.
 */
async function loadLatestProof(db, draftId) {
  const { rows } = await db.query(
    `SELECT ${PROOF_COLUMNS}
       FROM menu_proofs mp
       JOIN proposals p ON p.id = mp.proposal_id
      WHERE mp.draft_id = $1
        AND mp.superseded_at IS NULL
      ORDER BY mp.sent_at DESC, mp.id DESC
      LIMIT 1`,
    [draftId]);
  return withState(rows[0] || null);
}

module.exports = {
  PROOF_STATES,
  PROOF_IMAGE_STATES,
  proofLinkEndSql,
  proofExpiredSql,
  proofState,
  loadProofByToken,
  loadLatestProof,
};
