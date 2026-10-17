// The menu art daily cap and its reservations (spec 2026-10-01 section 5.5,
// Daily cap, Superseded runs, End-of-run sweep). menu_art_calls is the ledger:
// one row per provider call, reserved inside the request that asks for it.
//
// Lock order, the one rule every caller keeps:
// - lockCalls(client) is the FIRST statement of every reserving transaction
//   (Generate, re-roll, sync's short words transaction and its main one), before
//   any row lock. LOCK TABLE ... IN EXCLUSIVE MODE is transaction scoped, so it
//   works on the Neon pooler where advisory locks are a no-op.
// - reserveImages, reserveText, requireImageHeadroom, releaseReserved,
//   releaseProposalReserved and releasePieceReserved check pg_locks that this
//   backend holds that lock and throw a plain Error
//   when it does not, so a caller that forgets can neither pass the cap
//   concurrently nor take the ledger's row locks before the table lock.
//
// Deadlocks: with the lock first, 40P01 should not happen, but if it does it
// surfaces at whichever later statement of the caller's transaction closes the
// cycle, not necessarily at the LOCK. lockCalls maps one itself; the routes
// wrap their whole transaction: catch (err) { ROLLBACK; throw mapDeadlock(err) }.
// isDeadlock(err) is true for code 40P01; mapDeadlock(err) returns a 409
// MENU_DRAFT_CHANGED AppError for one and the error itself otherwise.
//
// Run match (authorizeCall): a reservation authorizes only while its run is
// current. A draft run (Generate's job, sync's words call) matches when
// menu_drafts.run_id for draftId equals the row's run_id. A piece run (re-roll,
// sync's added drinks) is chosen by passing pieceRunId and matches when the
// piece row (draftId, the row's piece_key) still carries that run_id. A NULL
// run_id never authorizes. One UPDATE does the move, so there is no window
// between the check and the call; Generate's release of the old reservations
// in its locked transaction is what makes a superseded run's next authorize
// fail (the UPDATE waits on the row and re-checks status = 'reserved').
//
// Generate releases with releaseProposalReserved (every reserved row of the
// proposal, which also frees re-roll and sync rows stranded by a restart)
// BEFORE it reserves its own run; releasing after would free the new run too.
// Re-roll and sync release by piece (releasePieceReserved: the proposal's
// reserved image rows for those piece keys, whatever their run), again before
// they reserve, so a stuck attempt's unspent row stops counting.
//
// Caps are read at call time through readEnvInt (MENU_ART_DAILY_IMAGE_CAP,
// default 60; MENU_ART_DAILY_TEXT_CAP, default 100). One image cap covers both
// providers. A row counts when created in the last 24 hours and not released.

const { pool } = require('../db');
const { AppError, ConflictError } = require('./errors');
const { readEnvInt } = require('./envInt');

const IMAGE_CAP_DEFAULT = 60;
const TEXT_CAP_DEFAULT = 100;
const ERROR_MAX = 300;
const MARK_STATUSES = new Set(['sent', 'ok', 'failed']);

function capLimits() {
  return {
    image: readEnvInt('MENU_ART_DAILY_IMAGE_CAP', IMAGE_CAP_DEFAULT),
    text: readEnvInt('MENU_ART_DAILY_TEXT_CAP', TEXT_CAP_DEFAULT),
  };
}

function isDeadlock(err) {
  return Boolean(err) && err.code === '40P01';
}

function mapDeadlock(err) {
  if (!isDeadlock(err)) return err;
  return new ConflictError('The draft changed. Try again.', 'MENU_DRAFT_CHANGED');
}

async function lockCalls(client) {
  try {
    await client.query('LOCK TABLE menu_art_calls IN EXCLUSIVE MODE');
  } catch (err) {
    throw mapDeadlock(err);
  }
}

async function assertLocked(client, fn) {
  const { rows } = await client.query(
    `SELECT 1 FROM pg_locks
      WHERE locktype = 'relation'
        AND relation = 'menu_art_calls'::regclass
        AND pid = pg_backend_pid()
        AND mode IN ('ExclusiveLock', 'AccessExclusiveLock')
        AND granted
      LIMIT 1`
  );
  if (!rows.length) {
    throw new Error(`menuArtCap.${fn}: call lockCalls(client) first in this transaction`);
  }
}

function requireRunId(runId, fn) {
  if (typeof runId !== 'string' || !runId) {
    throw new TypeError(`menuArtCap.${fn}: runId is required (a NULL run never authorizes)`);
  }
}

async function countOpen(client, kind) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS used FROM menu_art_calls
      WHERE kind = $1 AND status <> 'released' AND created_at > NOW() - interval '24 hours'`,
    [kind]
  );
  return rows[0] ? rows[0].used : 0;
}

async function checkImageCap(client, count) {
  if ((await countOpen(client, 'image')) + count > capLimits().image) {
    throw new AppError('Daily menu art limit reached.', 429, 'MENU_ART_CAP_REACHED');
  }
}

// The image cap's 429 for count more images, reserving nothing. Update draft
// asks it in the short transaction that reserves its words row, so a sync at
// the cap spends no words call; reserveImages stays the real gate.
async function requireImageHeadroom(client, count) {
  await assertLocked(client, 'requireImageHeadroom');
  if (Number.isInteger(count) && count > 0) await checkImageCap(client, count);
}

// -> { [pieceKey]: id }. Duplicate keys reserve once.
async function reserveImages(client, { proposalId = null, runId, pieceKeys, provider, model = null } = {}) {
  await assertLocked(client, 'reserveImages');
  requireRunId(runId, 'reserveImages');
  if (!Array.isArray(pieceKeys) || pieceKeys.some((k) => typeof k !== 'string' || !k)) {
    throw new TypeError('menuArtCap.reserveImages: pieceKeys must be an array of piece keys');
  }
  const keys = [...new Set(pieceKeys)];
  if (!keys.length) return {};
  await checkImageCap(client, keys.length);
  const { rows } = await client.query(
    `INSERT INTO menu_art_calls (proposal_id, piece_key, run_id, kind, status, provider, model)
     SELECT $1, t.key, $2::uuid, 'image', 'reserved', $3, $4
       FROM unnest($5::text[]) WITH ORDINALITY AS t(key, ord)
      ORDER BY t.ord
     RETURNING id, piece_key`,
    [proposalId, runId, provider, model, keys]
  );
  const ids = {};
  for (const row of rows) ids[row.piece_key] = row.id;
  return ids;
}

// -> the reservation id. The words step always runs on OpenAI.
async function reserveText(client, { proposalId = null, runId, model = null } = {}) {
  await assertLocked(client, 'reserveText');
  requireRunId(runId, 'reserveText');
  const used = await countOpen(client, 'text');
  if (used + 1 > capLimits().text) {
    throw new AppError('Daily menu text limit reached.', 429, 'MENU_ART_TEXT_CAP_REACHED');
  }
  const { rows } = await client.query(
    `INSERT INTO menu_art_calls (proposal_id, piece_key, run_id, kind, status, provider, model)
     VALUES ($1, NULL, $2::uuid, 'text', 'reserved', 'openai', $3)
     RETURNING id`,
    [proposalId, runId, model]
  );
  return rows[0].id;
}

// reserved -> sent, only while the run is current (see the header). The job
// calls the provider only after true.
async function authorizeCall(id, { draftId, runId = null, pieceRunId = null } = {}) {
  const expected = pieceRunId || runId;
  if (!expected || !Number.isInteger(Number(id)) || !Number.isInteger(Number(draftId))) return false;
  const current = pieceRunId
    ? `EXISTS (SELECT 1 FROM menu_draft_pieces p
                WHERE p.draft_id = $2 AND p.run_id = c.run_id AND p.piece_key = c.piece_key)`
    : 'EXISTS (SELECT 1 FROM menu_drafts d WHERE d.id = $2 AND d.run_id = c.run_id)';
  const result = await pool.query(
    `UPDATE menu_art_calls c SET status = 'sent'
      WHERE c.id = $1 AND c.status = 'reserved' AND c.run_id = $3::uuid AND ${current}`,
    [id, draftId, expected]
  );
  return result.rowCount === 1;
}

// Inside Generate's locked transaction: the old run's reserved rows -> released.
// Its sent rows are untouched (the old job settles them). -> rows released.
async function releaseReserved(client, { proposalId, runId } = {}) {
  await assertLocked(client, 'releaseReserved');
  if (!runId) return 0;
  const result = await client.query(
    `UPDATE menu_art_calls SET status = 'released'
      WHERE run_id = $1::uuid AND proposal_id IS NOT DISTINCT FROM $2 AND status = 'reserved'`,
    [runId, proposalId === undefined ? null : proposalId]
  );
  return result.rowCount;
}

// Inside Generate's locked transaction, before it reserves its own run: every
// reserved row of the proposal -> released, whatever its run. -> rows released.
async function releaseProposalReserved(client, { proposalId } = {}) {
  await assertLocked(client, 'releaseProposalReserved');
  const result = await client.query(
    `UPDATE menu_art_calls SET status = 'released'
      WHERE proposal_id = $1 AND status = 'reserved'`,
    [proposalId]
  );
  return result.rowCount;
}

// Inside a re-roll's or sync's locked transaction, before it reserves: the
// proposal's reserved image rows for pieceKeys -> released, whatever their run
// (the unspent reservation of an attempt that is stuck, or of a drink being
// removed). Sent rows are left to their job. -> rows released.
async function releasePieceReserved(client, { proposalId, pieceKeys } = {}) {
  await assertLocked(client, 'releasePieceReserved');
  const keys = Array.isArray(pieceKeys) ? [...new Set(pieceKeys.filter((k) => typeof k === 'string' && k))] : [];
  if (!keys.length) return 0;
  const result = await client.query(
    `UPDATE menu_art_calls SET status = 'released'
      WHERE proposal_id = $1 AND kind = 'image' AND status = 'reserved' AND piece_key = ANY($2::text[])`,
    [proposalId, keys]
  );
  return result.rowCount;
}

// Standalone, for the job's finally. Each reservation settles by its OWN
// status: reserved (never sent) -> released; sent (billed) -> failed, which
// still counts. With pieceKeys, only those pieces' rows (never the run's text
// row), so sibling pieces sharing a sync run are left alone.
// -> { released, failed }.
async function settleRun({ runId, pieceKeys = null } = {}) {
  if (!runId) return { released: 0, failed: 0 };
  const keys = Array.isArray(pieceKeys) ? pieceKeys : null;
  const { rows } = await pool.query(
    `UPDATE menu_art_calls
        SET status = CASE WHEN status = 'reserved' THEN 'released' ELSE 'failed' END
      WHERE run_id = $1::uuid AND status IN ('reserved', 'sent')
        AND ($2::text[] IS NULL OR piece_key = ANY($2::text[]))
      RETURNING status`,
    [runId, keys]
  );
  return {
    released: rows.filter((r) => r.status === 'released').length,
    failed: rows.filter((r) => r.status === 'failed').length,
  };
}

// Standalone. Moves a sent row to sent, ok or failed and records what is
// given; a field left out keeps its value. A row that is not sent is never
// touched (a released or reserved row cannot become ok). error is the
// sanitized descriptor string (formatError), never an Error or SDK text.
// -> true when the row moved.
async function markCall(id, status, { error = null, requestId = null, model = null, size = null } = {}) {
  if (!MARK_STATUSES.has(status)) throw new TypeError(`menuArtCap.markCall: bad status ${status}`);
  if (error !== null && error !== undefined && typeof error !== 'string') {
    throw new TypeError('menuArtCap.markCall: error must be the sanitized descriptor string');
  }
  const text = (v) => (typeof v === 'string' && v ? v.slice(0, ERROR_MAX) : null);
  const result = await pool.query(
    `UPDATE menu_art_calls
        SET status = $2,
            error = COALESCE($3, error),
            provider_request_id = COALESCE($4, provider_request_id),
            model = COALESCE($5, model),
            size = COALESCE($6, size)
      WHERE id = $1 AND status = 'sent'`,
    [id, status, text(error), text(requestId), text(model), text(size)]
  );
  return result.rowCount === 1;
}

// -> { used, limit, remaining, resets_at }: images only. resets_at is when the
// oldest counted image ages out of the window (one image frees then), or null.
async function capUsage(db = pool) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS used, MIN(created_at) + interval '24 hours' AS resets_at
       FROM menu_art_calls
      WHERE kind = 'image' AND status <> 'released' AND created_at > NOW() - interval '24 hours'`
  );
  const row = rows[0] || {};
  const used = row.used || 0;
  const limit = capLimits().image;
  return { used, limit, remaining: Math.max(0, limit - used), resets_at: row.resets_at || null };
}

module.exports = {
  lockCalls,
  reserveImages,
  requireImageHeadroom,
  reserveText,
  authorizeCall,
  releaseReserved,
  releaseProposalReserved,
  releasePieceReserved,
  settleRun,
  markCall,
  capUsage,
  capLimits,
  isDeadlock,
  mapDeadlock,
  IMAGE_CAP_DEFAULT,
  TEXT_CAP_DEFAULT,
};
