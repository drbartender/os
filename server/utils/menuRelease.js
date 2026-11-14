// The held menu print file's release (spec 2026-10-19 section 10.3): the ONE place, besides the admin
// upload, that posts a print key for staff, behind the five release guards, plus Put it back and the v1 stamp.
//
// menu_print_key drives the $5 menu_print duty line (dutyLines.js), so this is
// a money seam. Approve and send holds the print file on
// menu_drafts.approved_print_key and never posts it; it reaches staff only
// through releaseHeldPrint, at the client's Looks great (the public answer
// route, via 'client') or the admin's Release for printing (via 'admin').
//
// releaseHeldPrint(client, { draftId, proposalId, via, actorId, afterEvent })
// runs on the caller's transaction client. It takes the draft and then the
// proposal FOR UPDATE (the lock order Approve, the mark, the upload, Close
// request and the answer route keep; re-taking a lock the caller already holds
// is a no-op), reads the latest proof, and releases only when every guard
// holds, in this order, each refusal a reason:
//   1. legal_hold    the legal-hold proposal (isLegalHold, which fails closed;
//                    money law 15), before any query;
//   2. marked        the no-menu mark is set. Dallas's mark always wins and a
//                    release never clears it (setMenuPrintKey would);
//   3. not_held      no held file: approved_print_key unset or already the
//                    released key ("already released"), or the latest proof is
//                    not for the approved pair or was withdrawn (isHeldFile);
//   4. file_changed  menu_print_key is neither null nor the released key: an
//                    admin upload is live and is never overwritten;
//   5. event_passed  the event day is before today in Chicago (event dates
//                    compare as YYYY-MM-DD text): always for via 'client', so
//                    no duty is paid for a menu nobody printed; for via
//                    'admin' unless afterEvent is true (the after-event confirm).
// It returns { released: false, reason } for a refusal and never throws for
// one, so the answer route always keeps the client's answer. On success:
// setMenuPrintKey, the release stamp (released_print_key, released_at,
// released_by, released_via) and the menu_released activity row (actor client
// or admin, details { draft_id, version, art_version, via }), and it returns
// { released: true, printKey }. The CALLER commits and only then fires
// reaccrueDuty and inboxCache.invalidate(): nothing here reaches past the
// transaction.
//
// restoreReleasedPrint(client, { draftId, proposalId, actorId, afterEvent }) is
// Put it back for staff (the admin release route only): in the removed state,
// it re-posts the menu's own released file, or a v1 approval's file (one with
// no release and no proof, which it also stamps as released, stampV1Release),
// with the same legal-hold, mark, upload and after-event guards; a held file is
// released, never restored. It returns as releaseHeldPrint does, and its
// activity row is menu_released with restored: true.
//
// stampV1Release(client, draftId) is Approve's first write (spec 10.3): a menu
// approved under v1, whose approved key is still the live print key with no
// release recorded, is stamped released at its approval (released_* from
// approved_*, via 'admin'), so a later release can replace that live file.

const { isLegalHold } = require('./legalHold');
const { chicagoTodayYmd } = require('./businessTime');
const { setMenuPrintKey } = require('./menuPrintFile');
const { isHeldFile } = require('./menuPrintState');

const VIAS = new Set(['client', 'admin']);

const DRAFT_LOCK_SQL = `
  SELECT id, proposal_id, approved_version, approved_art_version, approved_print_key, approved_at, approved_by,
         released_print_key
    FROM menu_drafts
   WHERE id = $1 AND proposal_id = $2
     FOR UPDATE`;

const PROPOSAL_LOCK_SQL = `
  SELECT id, menu_print_key, menu_not_required, to_char(event_date, 'YYYY-MM-DD') AS event_date
    FROM proposals
   WHERE id = $1
     FOR UPDATE`;

const LATEST_PROOF_SQL = `
  SELECT id, version, art_version, withdrawn_at
    FROM menu_proofs
   WHERE draft_id = $1 AND superseded_at IS NULL
   ORDER BY sent_at DESC, id DESC
   LIMIT 1`;

const STAMP_RELEASE_SQL = `
  UPDATE menu_drafts
     SET released_print_key = approved_print_key, released_at = NOW(), released_by = $2, released_via = $3
   WHERE id = $1`;

// The v1 stamp: only while the approved key is the live key with no release.
const STAMP_V1_SQL = `
  UPDATE menu_drafts d
     SET released_print_key = d.approved_print_key, released_at = d.approved_at,
         released_by = d.approved_by, released_via = 'admin'
    FROM proposals p
   WHERE d.id = $1
     AND p.id = d.proposal_id
     AND d.released_print_key IS NULL
     AND d.approved_print_key IS NOT NULL
     AND p.menu_print_key = d.approved_print_key
  RETURNING d.id`;

const ACTIVITY_SQL = `
  INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
  VALUES ($1, 'menu_released', $2, $3, $4)`;

const refuse = (reason) => ({ released: false, reason });

// Guards 1 and 2 and the locks: the locked draft, proposal and latest proof,
// or a refusal. A draft that is not this proposal's is not_held.
async function lockRows(client, { draftId, proposalId }) {
  if (isLegalHold(proposalId)) return { refusal: refuse('legal_hold') };
  const draft = (await client.query(DRAFT_LOCK_SQL, [draftId, proposalId])).rows[0];
  if (!draft) return { refusal: refuse('not_held') };
  const proposal = (await client.query(PROPOSAL_LOCK_SQL, [proposalId])).rows[0];
  if (!proposal) return { refusal: refuse('not_held') };
  if (proposal.menu_not_required === true) return { refusal: refuse('marked') };
  const latestProof = (await client.query(LATEST_PROOF_SQL, [draft.id])).rows[0] || null;
  return { draft, proposal, latestProof };
}

// Guard 5. event_date is YYYY-MM-DD text or null.
function eventPassed(proposal, via, afterEvent) {
  if (!proposal.event_date || proposal.event_date >= chicagoTodayYmd()) return false;
  return via === 'client' || afterEvent !== true;
}

async function writeActivity(client, { proposalId, via, actorId, details }) {
  await client.query(ACTIVITY_SQL, [proposalId, via, via === 'admin' ? actorId : null, JSON.stringify(details)]);
}

/** Release the held print file to staff (header). Returns { released: true, printKey } or { released: false, reason }. */
async function releaseHeldPrint(client, { draftId, proposalId, via, actorId = null, afterEvent = false }) {
  if (!VIAS.has(via)) throw new Error('menuRelease: via must be client or admin');
  const rows = await lockRows(client, { draftId, proposalId });
  if (rows.refusal) return rows.refusal;
  const { draft, proposal, latestProof } = rows;
  if (!isHeldFile(draft, latestProof)) return refuse('not_held');
  const releasedKey = draft.released_print_key || null;
  if (proposal.menu_print_key !== null && proposal.menu_print_key !== releasedKey) return refuse('file_changed');
  if (eventPassed(proposal, via, afterEvent)) return refuse('event_passed');

  await setMenuPrintKey(client, proposalId, draft.approved_print_key);
  await client.query(STAMP_RELEASE_SQL, [draft.id, via === 'admin' ? actorId : null, via]);
  await writeActivity(client, {
    proposalId, via, actorId,
    details: { draft_id: draft.id, version: draft.approved_version, art_version: draft.approved_art_version, via },
  });
  return { released: true, printKey: draft.approved_print_key };
}

/** Put it back for staff (header): re-post the menu's own removed file. Same return shape. */
async function restoreReleasedPrint(client, { draftId, proposalId, actorId = null, afterEvent = false }) {
  const rows = await lockRows(client, { draftId, proposalId });
  if (rows.refusal) return rows.refusal;
  const { draft, proposal, latestProof } = rows;
  if (isHeldFile(draft, latestProof)) return refuse('not_held');
  const releasedKey = draft.released_print_key || null;
  const approvedKey = draft.approved_print_key || null;
  // A v1 approval has no proof at all: every Approve since v1 leaves one
  // latest proof (superseded_at IS NULL), so none means none was ever sent.
  const v1 = !releasedKey && Boolean(approvedKey) && !latestProof;
  const key = releasedKey || (v1 ? approvedKey : null);
  if (!key) return refuse('not_held');
  if (proposal.menu_print_key !== null) return refuse(proposal.menu_print_key === key ? 'not_held' : 'file_changed');
  if (eventPassed(proposal, 'admin', afterEvent)) return refuse('event_passed');

  await setMenuPrintKey(client, proposalId, key);
  // The v1 file is live again, so the v1 stamp now applies: released at its approval.
  if (v1) await stampV1Release(client, draft.id);
  const ownPair = key === approvedKey;
  await writeActivity(client, {
    proposalId, via: 'admin', actorId,
    details: {
      draft_id: draft.id,
      version: ownPair ? draft.approved_version : null,
      art_version: ownPair ? draft.approved_art_version : null,
      via: 'admin',
      restored: true,
    },
  });
  return { released: true, printKey: key };
}

/** Approve's v1 stamp (header). Returns true when a v1 approval was stamped. */
async function stampV1Release(client, draftId) {
  const { rows } = await client.query(STAMP_V1_SQL, [draftId]);
  return rows.length > 0;
}

module.exports = { releaseHeldPrint, restoreReleasedPrint, stampV1Release };
