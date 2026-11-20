'use strict';

// The Claude connector's daily cleanup (spec 2026-11-19 section 7.4): deletes call-log rows older than
// 90 days (withheld rows kept), expired authorize requests, revokes approvals never redeemed, spent or expired codes, and dead tokens, behind its own
// RUN_CONNECTOR_CLEANUP_SCHEDULER flag and its own scheduler_health row.
//
// Connector tables only, and never a grant: a grant is revoked by a timestamp
// and kept, so the log rows that survive keep the grant they name. A rotated
// refresh token is kept until its own expiry (the grant's end), because the
// replay check needs it: a copied token presented weeks later must still be
// recognised and revoke its grant. A code is kept a day after it is spent, for
// the same reason at a smaller scale. Default on, like the other cleanup
// schedulers (server/index.js), and so only where schedulers run at all.

const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const grants = require('./grants');

const SCHEDULER_NAME = 'connector_cleanup';
const INTERVAL_SECONDS = 86400;
const LOG_RETENTION_DAYS = 90;

// Withheld rows are kept: each one is the "once ever" record that
// callLog.recordWithheldOnce rests on (spec 7.6, emailed once).
const DELETE_OLD_CALLS = `DELETE FROM connector_calls
   WHERE called_at < NOW() - make_interval(days => $1) AND outcome <> 'withheld'`;
const DELETE_OLD_REQUESTS = 'DELETE FROM connector_auth_requests WHERE expires_at < NOW()';
const DELETE_OLD_CODES = `
  DELETE FROM connector_codes
   WHERE (used_at IS NOT NULL AND used_at < NOW() - INTERVAL '1 day')
      OR expires_at < NOW() - INTERVAL '1 day'`;
const DELETE_DEAD_TOKENS = `
  DELETE FROM connector_tokens
   WHERE expires_at < NOW()
      OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '1 day')`;

async function runConnectorCleanup() {
  try {
    // First, while their codes still exist to be checked: approvals whose code
    // expired or was spent without making them live.
    const unredeemed = await grants.revokeUnredeemed();
    const calls = await pool.query(DELETE_OLD_CALLS, [LOG_RETENTION_DAYS]);
    const requests = await pool.query(DELETE_OLD_REQUESTS);
    const codes = await pool.query(DELETE_OLD_CODES);
    const tokens = await pool.query(DELETE_DEAD_TOKENS);
    const counts = {
      unredeemed,
      calls: calls.rowCount, requests: requests.rowCount, codes: codes.rowCount, tokens: tokens.rowCount,
    };
    if (counts.unredeemed || counts.calls || counts.requests || counts.codes || counts.tokens) {
      console.log(`[${SCHEDULER_NAME}] unredeemed=${counts.unredeemed} deleted calls=${counts.calls} requests=${counts.requests} codes=${counts.codes} tokens=${counts.tokens}`);
    }
    return counts;
  } catch (err) {
    try {
      if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(err, { tags: { component: SCHEDULER_NAME } });
    } catch (_) { /* Sentry is best-effort; the throw below reports; static-checks: allow swallowed-catch */ }
    throw err; // wrapScheduler records the failed run
  }
}

// Called from server/index.js's start(), beside the other schedulers, with
// its helpers. Daily, staggered off every sibling's boot slot.
function register({ enabled, globalScheduleDisabled, wrapScheduler, clearHealthRow }) {
  if (enabled('RUN_CONNECTOR_CLEANUP_SCHEDULER')) {
    const wrapped = wrapScheduler(SCHEDULER_NAME, INTERVAL_SECONDS, runConnectorCleanup);
    setTimeout(wrapped, 230000);
    setInterval(wrapped, INTERVAL_SECONDS * 1000);
    return true;
  }
  if (!globalScheduleDisabled) clearHealthRow(SCHEDULER_NAME);
  return false;
}

module.exports = { SCHEDULER_NAME, LOG_RETENTION_DAYS, runConnectorCleanup, register };
