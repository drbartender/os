// Pure presence helpers: derivation, predicates, and time bucketing.
// No DB calls (mirror pricingEngine.js) so every rule is unit-testable.
// Spec: docs/superpowers/specs/2026-07-02-presence-tracker-design.md

const PRESENCE_STATES = ['desk', 'available', 'away'];
const NUDGE_AFTER_MS = 6 * 60 * 60 * 1000;  // continuous desk before the nudge
const FLIP_GRACE_MS = 30 * 60 * 1000;       // silence after the nudge before auto-flip
const ACTIVITY_FLUSH_MS = 60 * 1000;        // max cadence of last-seen DB writes

/**
 * Who answers the next lead. Rows are users (any mix of tracked/untracked).
 * eligible = tracked, not away, taking leads. The fallback owner (highest
 * rank, Dallas) eligible = dibs and wins outright; otherwise lowest eligible
 * rank wins (the chain); otherwise the fallback owner owns leads
 * unconditionally. Returns a user id or null when nobody is tracked.
 * Spec: docs/superpowers/specs/2026-07-06-presence-dibs-design.md
 */
function derivePointer(users) {
  const tracked = (users || []).filter(
    (u) => u.presence_lead_rank !== null && u.presence_lead_rank !== undefined
  );
  if (!tracked.length) return null;
  const fallback = tracked.reduce((a, b) => (b.presence_lead_rank > a.presence_lead_rank ? b : a));
  const eligible = tracked
    .filter((u) => u.presence_state !== 'away' && u.presence_taking_leads)
    .sort((a, b) => a.presence_lead_rank - b.presence_lead_rank);
  if (eligible.some((u) => u.id === fallback.id)) return fallback.id; // dibs
  if (eligible.length) return eligible[0].id;
  return fallback.id;
}

/**
 * Taking-leads value after a state transition: away wipes it; coming online
 * from away resets it on for chain users but OFF for the fallback owner (he
 * never takes dibs just by sitting down); desk<->available preserves the
 * explicit choice (dibs survives).
 */
function leadsAfterTransition(prevState, nextState, currentTaking, isFallbackOwner) {
  if (nextState === 'away') return false;
  if (prevState === 'away') return !isFallbackOwner;
  return !!currentTaking;
}

function isNudgeDue(interval, now) {
  return interval.state === 'desk'
    && !interval.ended_at
    && !interval.nudged_at
    && now.getTime() - new Date(interval.started_at).getTime() >= NUDGE_AFTER_MS;
}

function isFlipDue(interval, lastSeenMs, now) {
  if (interval.state !== 'desk' || interval.ended_at || !interval.nudged_at) return false;
  const nudgedMs = new Date(interval.nudged_at).getTime();
  if (now.getTime() - nudgedMs < FLIP_GRACE_MS) return false;
  return lastSeenMs === null || lastSeenMs === undefined || lastSeenMs < nudgedMs;
}

/**
 * Per-state milliseconds of overlap between each interval and [winStart,
 * winEnd]. Open intervals (ended_at null) clip to `now`. Boundary-spanning
 * intervals contribute only their in-window slice, so totals always sum to
 * wall-clock time (spec: Totals bucketing).
 */
function sumOverlapMs(intervals, winStart, winEnd, now) {
  const totals = { desk: 0, available: 0, away: 0 };
  const ws = winStart.getTime();
  const we = winEnd.getTime();
  for (const iv of intervals || []) {
    const s = new Date(iv.started_at).getTime();
    const e = iv.ended_at ? new Date(iv.ended_at).getTime() : now.getTime();
    const overlap = Math.min(e, we) - Math.max(s, ws);
    if (overlap > 0 && totals[iv.state] !== undefined) totals[iv.state] += overlap;
  }
  return totals;
}

// ─── Central-time window math (no deps; Chicago is always UTC-5 or UTC-6,
// and DST shifts at 2am so midnight always exists) ─────────────────────────
const CT = 'America/Chicago';

function centralParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CT, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    y: Number(get('year')), m: Number(get('month')), d: Number(get('day')),
    hour: Number(get('hour')), weekday: get('weekday'),
  };
}

/** UTC instant of midnight Central on calendar day y-m-d. */
function centralMidnightUtc(y, m, d) {
  for (const off of [5, 6]) {
    const t = new Date(Date.UTC(y, m - 1, d, off, 0, 0));
    const p = centralParts(t);
    if (p.y === y && p.m === m && p.d === d && p.hour === 0) return t;
  }
  return new Date(Date.UTC(y, m - 1, d, 6, 0, 0)); // unreachable safety net
}

const DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Week (Monday 00:00 Central) and month (1st 00:00 Central) starts for `now`. */
function centralWindows(now) {
  const p = centralParts(now);
  const back = DOW[p.weekday] ?? 0;
  // Date.UTC normalizes negative day-of-month, so month/year rollovers are free.
  const wk = new Date(Date.UTC(p.y, p.m - 1, p.d - back, 12));
  const weekStart = centralMidnightUtc(wk.getUTCFullYear(), wk.getUTCMonth() + 1, wk.getUTCDate());
  const monthStart = centralMidnightUtc(p.y, p.m, 1);
  return { weekStart, monthStart };
}

module.exports = {
  PRESENCE_STATES, NUDGE_AFTER_MS, FLIP_GRACE_MS, ACTIVITY_FLUSH_MS,
  derivePointer, leadsAfterTransition, isNudgeDue, isFlipDue,
  sumOverlapMs, centralWindows,
};
