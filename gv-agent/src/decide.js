// Pure decisions around one leased job: whether it may open a browser at all
// (spec laws 4, 7 and 9), the job budget, the Chicago day the box's cap rolls
// on, the rule that settles every report (plan decision 10), and the loop's
// two schedules: the daily attempt budget and the outage check back-off.
const { validateJob } = require('./validate');

// The server's report whitelist (plan Task 7, GV_PRECLICK_REASONS). A reason
// outside it would be a 400 there, so it is reported as ui_error_before_send.
const PRECLICK_REASONS = new Set([
  'no_thread', 'wrong_thread', 'invalid_body', 'invalid_number', 'session_expired',
  'challenge', 'cap', 'spacing', 'identity_mismatch', 'timeout', 'ui_error_before_send',
]);

// { action: 'report', outcome, reason? } or { action: 'run' }. The journal
// comes first: a journaled id is never driven again, whatever else is true.
function decideJob({ job, journal, sentToday, cap }) {
  if (journal.has(String(job && job.id))) return { action: 'report', outcome: 'clicked_unverified' };
  // A cap that is not a number fails closed.
  if (!(Number(sentToday) < Number(cap))) return { action: 'report', outcome: 'failed_preclick', reason: 'cap' };
  const v = validateJob(job || {});
  if (!v.ok) return { action: 'report', outcome: 'failed_preclick', reason: v.reason };
  return { action: 'run' };
}

// Strictly under; a clock that is not a number is never under.
function underBudget(startMs, nowMs, budgetMs) {
  const elapsed = Number(nowMs) - Number(startMs);
  return Number.isFinite(elapsed) && elapsed < Number(budgetMs);
}

const CHICAGO_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
});

// 'YYYY-MM-DD' in America/Chicago, so the box's daily cap rolls at Chicago midnight.
function chicagoDayKey(date = new Date()) {
  const p = {};
  for (const part of CHICAGO_DAY.formatToParts(date)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

// The report a job ends with, settled by whether its id is in the journal.
// Decision 10 is the null case: journaled means clicked_unverified, not
// journaled means failed_preclick ui_error_before_send. A journaled job can
// only ever be sent or clicked_unverified, and a click claimed without a
// journal entry is clicked_unverified: neither may ever draw the 888 fallback.
function finalResult(result, journaled) {
  const outcome = result && result.outcome;
  if (journaled) return outcome === 'sent' ? { outcome: 'sent' } : { outcome: 'clicked_unverified' };
  if (outcome === 'skipped_already_posted') return { outcome };
  if (outcome === 'failed_preclick') {
    return { outcome, reason: PRECLICK_REASONS.has(result.reason) ? result.reason : 'ui_error_before_send' };
  }
  if (outcome === 'sent' || outcome === 'clicked_unverified') return { outcome: 'clicked_unverified' };
  return { outcome: 'failed_preclick', reason: 'ui_error_before_send' };
}

// Room left under a daily budget. Strictly under; a count or a budget that is
// not a number has none.
function budgetLeft(used, budget) {
  return Number(used) < Number(budget);
}

// How long to wait between session checks while Google wants a human: fastMs
// for the first slowAfterMs of the outage, then slowMs, so a long outage opens
// Chrome on the profile 12 times an hour instead of 60. A broken clock takes
// the slow check.
function outageCheckDelay(sinceMs, nowMs, { fastMs, slowMs, slowAfterMs }) {
  const elapsed = Number(nowMs) - Number(sinceMs);
  if (!Number.isFinite(elapsed)) return slowMs;
  return elapsed < slowAfterMs ? fastMs : slowMs;
}

module.exports = {
  decideJob, underBudget, chicagoDayKey, finalResult, budgetLeft, outageCheckDelay, PRECLICK_REASONS,
};
