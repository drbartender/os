const { pool } = require('../db');

// Retention for the audit + de-dupe tables. call_audit holds dialed-number PII
// (spec §Security #10), so it is purged on a window; the daily-cap count only
// needs the last 24h, so 30 days is generous headroom for spend/abuse forensics.
const RETENTION_DAYS = 30;
// Chunked DELETE bounds lock-hold time and WAL growth (mirror of
// webhookEventsPruneScheduler.js). These tables are tiny, but the pattern is
// free insurance against a long-quiet-period backlog.
const PRUNE_BATCH_SIZE = 5000;

// INSERT-or-REPLACE the single pending row for a user. A new target sent before
// confirming replaces the old one and resets status/call_sid/expiry (spec §4).
// ttlSeconds is an integer; make_interval keeps it out of string coercion.
async function upsertPending({ userId, targetE164, ttlSeconds }) {
  await pool.query(
    `INSERT INTO pending_call (user_id, target_e164, status, call_sid, expires_at, created_at)
     VALUES ($1, $2, 'awaiting_confirm', NULL, NOW() + make_interval(secs => $3::int), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       target_e164 = EXCLUDED.target_e164,
       status      = 'awaiting_confirm',
       call_sid    = NULL,
       expires_at  = NOW() + make_interval(secs => $3::int),
       created_at  = NOW()`,
    [userId, targetE164, ttlSeconds]
  );
}

// Atomic claim-then-call primitive (spec §Security #5). A single conditional
// UPDATE is atomic on its own row: at most one caller flips awaiting_confirm ->
// dialing, so at most one dial fires. A Telegram retry / crash-retry finds no
// claimable row and is a no-op. NOT wrapped in a transaction on purpose —
// calls.create is an external HTTP call that must run AFTER this commits.
async function claimForDial(userId) {
  const { rows } = await pool.query(
    `UPDATE pending_call
        SET status = 'dialing'
      WHERE user_id = $1
        AND status = 'awaiting_confirm'
        AND expires_at > NOW()
      RETURNING id, target_e164`,
    [userId]
  );
  if (rows.length === 0) return null;
  // id is BIGSERIAL; node-postgres returns BIGINT as a string. The contract
  // (pendingCall.test.js) requires a JS number; coerce here. Safe at this scale
  // (well under Number.MAX_SAFE_INTEGER) and it is only ever used as a bind
  // parameter downstream (attachCallSid).
  return { id: Number(rows[0].id), targetE164: rows[0].target_e164 };
}

// Store the Twilio CallSid on the claimed row so the bridge webhook can resolve
// the target by CallSid (never from a request param — spec §6).
async function attachCallSid(id, callSid) {
  await pool.query('UPDATE pending_call SET call_sid = $2 WHERE id = $1', [id, callSid]);
}

async function lookupTargetByCallSid(callSid) {
  const { rows } = await pool.query(
    'SELECT target_e164 FROM pending_call WHERE call_sid = $1 LIMIT 1',
    [callSid]
  );
  return rows.length ? rows[0].target_e164 : null;
}

// DB-backed spend cap (spec §Security #6). Pass a Postgres interval literal
// ('24 hours' for the daily cap, '1 minute' for the per-minute cap). Counts
// only successfully PLACED calls — rejects/failures never consume the budget.
async function countPlacedSince(intervalSql) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM call_audit
      WHERE status = 'placed'
        AND created_at > NOW() - ($1)::interval`,
    [intervalSql]
  );
  return rows[0].n;
}

// Append an audit row. status: 'placed' | 'rejected_cap' | 'rejected_validation'
// | 'failed' | a raw Twilio call status. triggeredBy is the Telegram user id.
async function recordAudit({ triggeredBy, targetE164, callSid, status }) {
  await pool.query(
    `INSERT INTO call_audit (triggered_by, target_e164, call_sid, status)
     VALUES ($1, $2, $3, $4)`,
    [triggeredBy ?? null, targetE164 ?? null, callSid ?? null, status]
  );
}

// Chunked DELETE loop (mirror of webhookEventsPruneScheduler.js:10-34).
async function batchedDelete(sql, params) {
  let total = 0;
  let batch;
  do {
    const result = await pool.query(sql, params);
    batch = result.rowCount;
    total += batch;
    if (batch === PRUNE_BATCH_SIZE) {
      await new Promise((r) => setTimeout(r, 50));
    }
  } while (batch === PRUNE_BATCH_SIZE);
  return total;
}

// Purge: unclaimable pending_call rows, plus call_audit and telegram_update rows
// past retention. PII lifetime bound (spec §Security #10). NOTE: an in-flight
// status='dialing' row can have expires_at in the past (its TTL was for the
// confirm window, not the call), yet the /bridge webhook still resolves the
// target FROM that row by CallSid. Pruning on expires_at alone would delete it
// mid-call. So only prune expired rows still awaiting confirmation, plus any row
// older than a hard 2h backstop (covers a dialing row whose call has long ended).
async function pruneVaCallingRows() {
  let total = 0;

  total += await batchedDelete(
    `DELETE FROM pending_call
      WHERE ctid IN (
        SELECT ctid FROM pending_call
        WHERE (status = 'awaiting_confirm' AND expires_at < NOW())
           OR (created_at < NOW() - INTERVAL '2 hours')
        LIMIT $1
      )`,
    [PRUNE_BATCH_SIZE]
  );

  total += await batchedDelete(
    `DELETE FROM call_audit
      WHERE ctid IN (
        SELECT ctid FROM call_audit
        WHERE created_at < NOW() - ($1 || ' days')::interval
        LIMIT $2
      )`,
    [String(RETENTION_DAYS), PRUNE_BATCH_SIZE]
  );

  total += await batchedDelete(
    `DELETE FROM telegram_update
      WHERE ctid IN (
        SELECT ctid FROM telegram_update
        WHERE created_at < NOW() - ($1 || ' days')::interval
        LIMIT $2
      )`,
    [String(RETENTION_DAYS), PRUNE_BATCH_SIZE]
  );

  return total;
}

module.exports = {
  upsertPending,
  claimForDial,
  attachCallSid,
  lookupTargetByCallSid,
  countPlacedSince,
  recordAudit,
  pruneVaCallingRows,
  RETENTION_DAYS,
  PRUNE_BATCH_SIZE,
};
