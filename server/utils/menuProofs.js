// The client menu proof's token life, state and reads (spec 2026-10-19 sections 10.6 and 12): the one
// expiry expression every proof reader uses, the state derivation, the loaders and the one withdraw.
//
// Token life (decision 15): a link works until the end of the event day in
// Chicago, computed live in SQL from the proposal's CURRENT event_date, so
// moving the event moves the end: expired when
// NOW() >= ((p.event_date + 1)::timestamp AT TIME ZONE 'America/Chicago').
// The date plus one is the next calendar day, its midnight read as Chicago wall
// time, so the end follows DST and never depends on the session's zone (GMT on
// dev and prod). With no event date the link lives 30 days from sent_at.
// proofExpiredSql is that expression; the public GET, the image route, the
// answer route's conditional UPDATE, the Inbox reader and the admin read model
// all build it here, never a copy.
//
// State precedence (Claude's call, from spec 12 and the answer route's
// refusals; reordered by lane menu-approve-send, carried item c), first match
// wins:
//   1. superseded  a newer approval replaced this link; even an answered or
//                  expired link points the client to the newest one.
//   2. withdrawn   Dallas marked the event no-menu, posted his own file or
//                  closed the change request (spec 10.3). The upload and Close
//                  request withdraw a proof answered changes, so the
//                  withdrawal outranks the answer: the client's page says the
//                  menu is no longer open for review.
//   3. approved or changes, the client's one answer, kept past the link's
//                  life: the page shows its thank-you lines with the picture
//                  off (proofShowsImage), and the Inbox's change request does
//                  not end when an undated link runs out.
//   4. expired     an unanswered link whose life is over.
//   5. open.
// A row the derivation cannot read (no expired flag, an unknown answer) throws:
// it never reads as open.
//
// The picture is served only while proofShowsImage holds: the state is open,
// approved or changes AND the link has not expired.
//
// withdrawLatestProof is the one withdraw (spec 10.3): the draft's latest
// proof gets withdrawn_at when it has no answer, or, for the admin upload and
// Close request, when it is answered changes too; a proof answered approved is
// never withdrawn. It runs on the caller's transaction client, after the
// caller holds the draft row lock (the lock order every proof writer keeps:
// the draft, then the proposal, then the proof).
//
// proofSeenChanged is the stale-page guard of lane menu-approve-send's fix
// round 1: the admin writes that act on the client's review compare the
// latest proof's id and answer with what the page last saw.
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
  if (row.superseded_at) return 'superseded';
  if (row.withdrawn_at) return 'withdrawn';
  if (row.answer) return row.answer;
  if (row.expired) return 'expired';
  return 'open';
}

/** Whether the proof picture is shown and served: an image state on a link still alive. */
function proofShowsImage(proof) {
  return Boolean(proof) && PROOF_IMAGE_STATES.includes(proof.state) && proof.expired === false;
}

const PROOF_COLUMNS = `mp.id, mp.draft_id, mp.proposal_id, mp.version, mp.art_version, mp.r2_key, mp.sent_at,
       mp.answer, mp.answer_note, mp.answered_at, mp.superseded_at, mp.withdrawn_at,
       ${proofExpiredSql()} AS expired`;

function withState(row) {
  return row ? { ...row, state: proofState(row) } : null;
}

// Whether the event day is before today in Chicago, compared as text (false
// with no date; the day Approve starts refusing a fresh link). The public page
// and the admin's proof block both read this one expression.
const EVENT_PASSED_SQL = "COALESCE(to_char(p.event_date, 'YYYY-MM-DD') < to_char(NOW() AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD'), false)";

// The public page's two extra facts (lane menu-approve-send, carried items d
// and g), read here and reduced to booleans by the route: the email's outcome,
// and event_passed.
const TOKEN_COLUMNS = `${PROOF_COLUMNS}, mp.email_status,
       ${EVENT_PASSED_SQL} AS event_passed`;

/**
 * The proof behind a public token, with `expired`, `state`, `email_status` and
 * `event_passed`, or null for a token that is not a UUID (no query runs), an
 * unknown token, a proof whose draft or proposal was deleted (the rows
 * cascade), or an archived proposal. `db` is the pool or the request's held
 * client.
 */
async function loadProofByToken(db, token) {
  if (!isUuid(token)) return null;
  const { rows } = await db.query(
    `SELECT ${TOKEN_COLUMNS}
       FROM menu_proofs mp
       JOIN proposals p ON p.id = mp.proposal_id
      WHERE mp.token = $1
        AND p.status IS DISTINCT FROM 'archived'`,
    [token]);
  return withState(rows[0] || null);
}

// The admin's columns besides the page's (carried item h): the token (the
// card's link), the email's outcome and address, the link's end, the database
// clock a pending email is aged against, and event_passed (a dated link ends
// with the event day, so the card stops offering a fresh one; fix round 1).
const ADMIN_COLUMNS = `${PROOF_COLUMNS}, mp.token, mp.email_status, mp.sent_to,
       ${proofLinkEndSql()} AS link_end, NOW() AS db_now, ${EVENT_PASSED_SQL} AS event_passed`;

const LATEST_SQL = `
  SELECT ${ADMIN_COLUMNS}
    FROM menu_proofs mp
    JOIN proposals p ON p.id = mp.proposal_id
   WHERE mp.draft_id = $1
     AND mp.superseded_at IS NULL
   ORDER BY mp.sent_at DESC, mp.id DESC
   LIMIT 1`;

// Every proof of a draft, newest first, for the Brief tab's Client review
// history (spec 14), capped at HISTORY_MAX.
const HISTORY_MAX = 50;
const HISTORY_SQL = `
  SELECT ${PROOF_COLUMNS}
    FROM menu_proofs mp
    JOIN proposals p ON p.id = mp.proposal_id
   WHERE mp.draft_id = $1
   ORDER BY mp.sent_at DESC, mp.id DESC
   LIMIT ${HISTORY_MAX}`;

/**
 * A draft's latest proof, the one row with superseded_at IS NULL, with
 * `expired` and `state`, plus the token, email_status, sent_to, link_end,
 * db_now and event_passed for the admin's proof block, or null when the draft has none.
 */
async function loadLatestProof(db, draftId) {
  const { rows } = await db.query(LATEST_SQL, [draftId]);
  return withState(rows[0] || null);
}

/** Every proof of a draft, newest first (at most HISTORY_MAX), each with `expired` and `state`. */
async function loadProofHistory(db, draftId) {
  const { rows } = await db.query(HISTORY_SQL, [draftId]);
  return rows.map(withState);
}

// $1 the draft; $2 true when a proof answered changes is withdrawn too (the
// upload and Close request), false for an unanswered one only (the mark).
const WITHDRAW_SQL = `
  UPDATE menu_proofs
     SET withdrawn_at = NOW()
   WHERE id = (SELECT id FROM menu_proofs
                WHERE draft_id = $1 AND superseded_at IS NULL
                ORDER BY sent_at DESC, id DESC
                LIMIT 1)
     AND withdrawn_at IS NULL
     AND (answer IS NULL OR ($2::boolean AND answer = 'changes'))
  RETURNING id`;

/**
 * Withdraw the draft's latest proof (header) on the caller's transaction
 * client. andChanges: also when it is answered changes. Returns the withdrawn
 * proof's id, or null when nothing was withdrawn.
 */
async function withdrawLatestProof(client, draftId, { andChanges = false } = {}) {
  const { rows } = await client.query(WITHDRAW_SQL, [draftId, andChanges === true]);
  return rows.length ? rows[0].id : null;
}

// The latest proof as the page's proof block shows it (superseded_at IS NULL, withdrawn or not).
const LATEST_SEEN_SQL = `
  SELECT id, answer FROM menu_proofs
   WHERE draft_id = $1 AND superseded_at IS NULL
   ORDER BY sent_at DESC, id DESC
   LIMIT 1`;

/**
 * Whether the draft's latest proof is not the one the page last saw (header).
 * seen is { id, answer }, each null when the page showed no proof (no answer).
 * Release, Put it back and Approve post it (seen_proof_id, seen_proof_answer)
 * and call this on their transaction client under the draft lock, which the
 * answer route takes first too, so a client's answer between the page's load
 * and the press is refused (409 MENU_PROOF_CHANGED) rather than acted over.
 */
async function proofSeenChanged(db, draftId, seen) {
  const { rows: [latest] } = await db.query(LATEST_SEEN_SQL, [draftId]);
  const id = latest ? latest.id : null;
  const answer = latest && latest.answer ? latest.answer : null;
  return id !== seen.id || answer !== seen.answer;
}

module.exports = {
  PROOF_STATES,
  PROOF_IMAGE_STATES,
  HISTORY_MAX,
  proofLinkEndSql,
  proofExpiredSql,
  proofState,
  proofShowsImage,
  loadProofByToken,
  loadLatestProof,
  loadProofHistory,
  withdrawLatestProof,
  proofSeenChanged,
};
