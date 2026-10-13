// The AI read's status for the feed line (spec 4.6: off, paused at its daily
// cap, failing at 3 or more error reads in the last hour, else on) and the
// daily-cap count the read job gates on. One definition with two readers, the
// read job (whether to read) and the inbox engine's ai.status (what the feed
// line says), so the line can never say "on" while the job is paused.

const { pool } = require('../../db');
const { isConfigured } = require('../anthropicClient');

const DEFAULT_DAILY_CAP = 300;
const FAILING_ERRORS = 3;

// The LEAD_CALL_DAILY_CAP precedent: 0, blank or nonsense falls back to the
// default. The off switches are the key and RUN_INBOX_READ_SCHEDULER=false.
function dailyCap() {
  const n = Number.parseInt(String(process.env.INBOX_AI_DAILY_CAP || ''), 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_CAP;
}

// The same rule as enabled('RUN_INBOX_READ_SCHEDULER') in server/index.js:
// schedulers run only in production unless RUN_SCHEDULERS=true, never with
// RUN_SCHEDULERS=false, and this one not with its own flag at 'false'.
function readSchedulerEnabled() {
  if (process.env.RUN_SCHEDULERS === 'false') return false;
  if (process.env.NODE_ENV !== 'production' && process.env.RUN_SCHEDULERS !== 'true') return false;
  return process.env.RUN_INBOX_READ_SCHEDULER !== 'false';
}

// Attempts, not rows: a read retried in the window counts every attempt it
// has made, so the cap bounds calls, not subjects (an over-count of at most
// two per retried row, never an under-count).
async function readStats(db = pool) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(attempts), 0)::int AS attempts_24h,
            (COUNT(*) FILTER (WHERE status = 'error' AND updated_at > NOW() - INTERVAL '1 hour'))::int AS errors_1h
       FROM inbox_reads
      WHERE updated_at > NOW() - INTERVAL '24 hours'`
  );
  return { attempts24h: rows[0].attempts_24h, errors1h: rows[0].errors_1h };
}

function statusFrom({ configured, schedulerEnabled, attempts24h, cap, errors1h }) {
  if (!configured || !schedulerEnabled) return 'off';
  if (attempts24h >= cap) return 'paused';
  if (errors1h >= FAILING_ERRORS) return 'failing';
  return 'on';
}

/**
 * 'on' | 'off' | 'paused' | 'failing', for GET /api/admin/inbox's ai.status.
 * The engine calls this on every list request, outside its cache, so it never
 * throws: a count it cannot read is itself the AI read failing, and the list
 * must still load.
 */
async function aiReadStatus(db = pool) {
  const configured = isConfigured();
  const schedulerEnabled = readSchedulerEnabled();
  if (!configured || !schedulerEnabled) return 'off';
  try {
    const stats = await readStats(db);
    return statusFrom({ configured, schedulerEnabled, ...stats, cap: dailyCap() });
  } catch (err) {
    console.warn(`[inbox_ai_read] status unreadable (${err && err.code ? err.code : 'error'}); reporting failing`);
    return 'failing';
  }
}

module.exports = {
  DEFAULT_DAILY_CAP,
  FAILING_ERRORS,
  dailyCap,
  readSchedulerEnabled,
  readStats,
  statusFrom,
  aiReadStatus,
};
