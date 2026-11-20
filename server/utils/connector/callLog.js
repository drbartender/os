'use strict';

// The Claude connector's call log (spec 2026-11-19 section 7.4): one row per authenticated MCP request,
// one per address, outcome and route per ten minutes for refused calls (bad token, outside the
// address range; no grant), and one per withheld piece of client-written text, and the settings block's read of it.
//
// No search text and no results are ever stored: the tool name, the record ids
// asked for, the client a detail tool read (the bulk-read tripwire counts
// different clients per grant per rolling hour on it), the result count, the
// duration, the outcome and the caller's address as req.ip reads it.
//
// Writing a row never fails the call it records: a failed insert goes to
// Sentry (the outcome and the error descriptor only) and the call goes on.
//
// recordCall writes one row (the tools write each call's own row through it).
// The tools' withheld rows are written by server/utils/connector/withheld.js
// with its own insert, which tells a failed insert from a piece already
// logged; recordWithheldOnce here is an older helper that no tool path calls.
// countRecentClients counts the clients a grant's detail calls read in the
// last hour; the tripwire (tripwire.js) reads the log with its own query.

const Sentry = require('@sentry/node');
const { pool } = require('../../db');

const OUTCOMES = Object.freeze([
  'ok', 'not_found', 'error', 'withheld', 'refused_token', 'refused_address', 'refused_tripwire',
]);

// Clamp a value to what its column holds.
function cap(v, n) { return v === null || v === undefined ? null : String(v).slice(0, n); }
function intOrNull(v) { return Number.isInteger(v) ? v : null; }

let captureException = (err, ctx) => {
  if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(err, ctx);
};
function __setCapture(fn) { captureException = fn; }

const INSERT_CALL = `
  INSERT INTO connector_calls
    (grant_id, caller_address, method, tool_name, record_ids, client_id, result_count, duration_ms, outcome, withheld_ref)
  VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10)
  ON CONFLICT (withheld_ref) WHERE outcome = 'withheld' DO NOTHING
  RETURNING id`;

function params(row) {
  return [
    intOrNull(row.grantId),
    cap(row.callerAddress, 64),
    cap(row.method, 64),
    cap(row.toolName, 64),
    (Array.isArray(row.recordIds) ? row.recordIds : []).slice(0, 50).map((x) => String(x).slice(0, 100)),
    intOrNull(row.clientId),
    intOrNull(row.resultCount),
    intOrNull(row.durationMs),
    row.outcome,
    cap(row.withheldRef, 128),
  ];
}

/**
 * Write one call-log row. Never throws: resolves the new row id, or null when
 * the insert failed (reported to Sentry) or a withheld row already existed.
 *
 * @param {{grantId?, callerAddress?, method?, toolName?, recordIds?, clientId?, resultCount?, durationMs?, outcome, withheldRef?}} row
 * @param {object} [db] a held client, when the caller holds one
 */
async function recordCall(row, db = pool) {
  try {
    if (!OUTCOMES.includes(row.outcome)) throw new Error(`connector call log: unknown outcome ${row.outcome}`);
    const r = await db.query(INSERT_CALL, params(row));
    return r.rows[0] ? Number(r.rows[0].id) : null;
  } catch (err) {
    try {
      captureException(err, {
        tags: { component: 'connector', op: 'call_log_insert', outcome: String(row && row.outcome) },
      });
    } catch (_) { /* telemetry must never break the call; static-checks: allow swallowed-catch */ }
    console.error('[connector] call log insert failed:', err && err.message);
    return null;
  }
}

// Refusals are logged at most once per address, outcome and route per window, so a
// flood from one address leaves a few rows, never one per request. In memory
// per process (the bound is per instance), pruned as it grows.
const REFUSAL_WINDOW_MS = 10 * 60 * 1000;
const REFUSAL_KEYS_MAX = 5000;
const lastRefusal = new Map();

function refusalDue(key, nowMs) {
  const prev = lastRefusal.get(key);
  if (prev !== undefined && nowMs - prev < REFUSAL_WINDOW_MS) return false;
  if (lastRefusal.size >= REFUSAL_KEYS_MAX) {
    for (const [k, t] of lastRefusal) if (nowMs - t >= REFUSAL_WINDOW_MS) lastRefusal.delete(k);
    if (lastRefusal.size >= REFUSAL_KEYS_MAX) lastRefusal.clear();
  }
  lastRefusal.set(key, nowMs);
  return true;
}
function __resetRefusalWindow() { lastRefusal.clear(); }

/**
 * A refused call (no grant): written once per address and outcome per
 * REFUSAL_WINDOW_MS, the rest dropped. Never throws. Resolves the row id, or
 * null when dropped or the insert failed.
 */
async function recordRefusal({ callerAddress, method = null, outcome }, { now = Date.now() } = {}) {
  if (!refusalDue(`${outcome}|${method}|${callerAddress}`, now)) return null;
  return recordCall({ callerAddress, method, outcome });
}

/**
 * The withheld row for one piece of client-written text, written at most once
 * (withheld_ref unique among withheld rows). Resolves true only for the call
 * that wrote it. No tool path calls it: withheld.js writes the tools' withheld
 * rows with its own insert.
 */
async function recordWithheldOnce({ grantId, toolName, withheldRef, recordIds, clientId, callerAddress }, db = pool) {
  if (!withheldRef) return false;
  const id = await recordCall({
    grantId, toolName, withheldRef, recordIds, clientId, callerAddress, method: 'tools/call', outcome: 'withheld',
  }, db);
  return id !== null;
}

// The number of different clients this grant's detail calls read in the
// window ending now (the tripwire, spec 7.6 guard 3). Only served calls count.
async function countRecentClients(grantId, { windowMs = 60 * 60 * 1000, now = new Date() } = {}, db = pool) {
  const r = await db.query(
    `SELECT COUNT(DISTINCT client_id)::int AS n FROM connector_calls
      WHERE grant_id = $1 AND called_at > $2 AND client_id IS NOT NULL AND outcome = 'ok'`,
    [grantId, new Date(now.getTime() - windowMs)]
  );
  return r.rows[0].n;
}

const LIST_CALLS = `
  SELECT id, called_at, grant_id, caller_address, method, tool_name, record_ids, client_id,
         result_count, duration_ms, outcome, withheld_ref
    FROM connector_calls
   WHERE ($1::text IS NULL OR outcome = $1)
     AND ($1::text IS NOT NULL OR $2::boolean
          OR tool_name IS NOT NULL OR outcome = 'withheld'
          OR ($3::boolean AND outcome LIKE 'refused%'))
   ORDER BY called_at DESC, id DESC
   LIMIT $4`;

/**
 * The settings block's list, newest first, and whether more rows exist past
 * `limit` (has_more), so nothing is cut silently. By default it is the tool
 * calls, the withheld pieces and the refused calls (bounded: one row per
 * address, outcome and route per ten minutes), so a wrong-address outage
 * shows its addresses; `refusals: false` is the tool-calls-only view, `all`
 * adds everything (the protocol traffic too), and `outcome` narrows to one
 * outcome.
 */
async function listCalls({ limit = 50, outcome = null, all = false, refusals = true } = {}) {
  const r = await pool.query(LIST_CALLS, [outcome, Boolean(all), Boolean(refusals), limit + 1]);
  const hasMore = r.rows.length > limit;
  const calls = r.rows.slice(0, limit).map((row) => ({
    id: Number(row.id),
    called_at: row.called_at,
    grant_id: row.grant_id,
    caller_address: row.caller_address,
    method: row.method,
    tool_name: row.tool_name,
    record_ids: row.record_ids,
    client_id: row.client_id,
    result_count: row.result_count,
    duration_ms: row.duration_ms,
    outcome: row.outcome,
    withheld_ref: row.withheld_ref,
  }));
  return { calls, has_more: hasMore };
}

module.exports = {
  OUTCOMES,
  REFUSAL_WINDOW_MS,
  recordCall,
  recordRefusal,
  recordWithheldOnce,
  countRecentClients,
  listCalls,
  __setCapture,
  __resetRefusalWindow,
};
