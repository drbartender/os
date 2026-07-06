// Pure-function tests for the presence helpers (no DB, no env).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  derivePointer, leadsAfterTransition, isNudgeDue, isFlipDue,
  sumOverlapMs, centralWindows, NUDGE_AFTER_MS, FLIP_GRACE_MS,
} = require('./presence');

const zul = (state, taking) => ({ id: 2, presence_state: state, presence_taking_leads: taking, presence_lead_rank: 1 });
const dal = (state, taking) => ({ id: 1, presence_state: state, presence_taking_leads: taking, presence_lead_rank: 2 });

test('pointer: Zul desk-and-taking wins when the owner is not taking', () => {
  assert.equal(derivePointer([zul('desk', true), dal('desk', false)]), 2);
});
test('pointer: Zul available + taking wins when the owner is not taking', () => {
  assert.equal(derivePointer([zul('available', true), dal('desk', false)]), 2);
});
test('pointer: dibs. owner online-and-taking beats the chain', () => {
  assert.equal(derivePointer([zul('desk', true), dal('desk', true)]), 1);
  assert.equal(derivePointer([zul('desk', true), dal('available', true)]), 1);
});
test('pointer: owner away with toggle stuck true still falls back normally', () => {
  // away is never eligible; stale taking_leads on an away owner must not grab
  assert.equal(derivePointer([zul('desk', true), dal('away', true)]), 2);
});
test('pointer: Zul opted out -> Dallas', () => {
  assert.equal(derivePointer([zul('desk', false), dal('away', false)]), 1);
});
test('pointer: Zul away -> Dallas', () => {
  assert.equal(derivePointer([zul('away', false), dal('available', true)]), 1);
});
test('pointer: both away -> Dallas (fallback = max rank)', () => {
  assert.equal(derivePointer([zul('away', false), dal('away', false)]), 1);
});
test('pointer: untracked rows ignored; empty -> null', () => {
  assert.equal(derivePointer([{ id: 9, presence_state: 'desk', presence_taking_leads: true, presence_lead_rank: null }]), null);
  assert.equal(derivePointer([]), null);
});

test('leads transition matrix', () => {
  assert.equal(leadsAfterTransition('away', 'desk', false), true);       // coming online resets on
  assert.equal(leadsAfterTransition('away', 'available', false), true);
  assert.equal(leadsAfterTransition('desk', 'available', false), false); // opt-out survives
  assert.equal(leadsAfterTransition('available', 'desk', true), true);   // preserved
  assert.equal(leadsAfterTransition('desk', 'away', true), false);       // away wipes
});

// The spec's "both away unchanged" case stays covered by the EXISTING test
// 'pointer: both away -> Dallas (fallback = max rank)' above.
test('leads transition: owner online default is OFF, chain user stays ON', () => {
  assert.equal(leadsAfterTransition('away', 'desk', false, true), false);      // owner sits down: no dibs
  assert.equal(leadsAfterTransition('away', 'available', false, true), false);
  assert.equal(leadsAfterTransition('away', 'desk', false, false), true);      // chain user unchanged
  assert.equal(leadsAfterTransition('desk', 'available', true, true), true);   // dibs survives desk<->available
  assert.equal(leadsAfterTransition('available', 'desk', true, true), true);
  assert.equal(leadsAfterTransition('desk', 'away', true, true), false);       // away wipes dibs
});

test('nudge due only for open, un-nudged desk past threshold', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  const base = { state: 'desk', ended_at: null, nudged_at: null };
  const started = (msAgo) => new Date(now.getTime() - msAgo).toISOString();
  assert.equal(isNudgeDue({ ...base, started_at: started(NUDGE_AFTER_MS + 1000) }, now), true);
  assert.equal(isNudgeDue({ ...base, started_at: started(NUDGE_AFTER_MS - 1000) }, now), false);
  assert.equal(isNudgeDue({ ...base, state: 'available', started_at: started(NUDGE_AFTER_MS * 2) }, now), false);
  assert.equal(isNudgeDue({ ...base, nudged_at: started(1000), started_at: started(NUDGE_AFTER_MS * 2) }, now), false);
});

test('flip due after grace with no sign of life since nudge', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  const nudged = new Date(now.getTime() - FLIP_GRACE_MS - 1000);
  const iv = { state: 'desk', ended_at: null, started_at: new Date(now.getTime() - 8 * 3600e3).toISOString(), nudged_at: nudged.toISOString() };
  assert.equal(isFlipDue(iv, null, now), true);
  assert.equal(isFlipDue(iv, nudged.getTime() - 5000, now), true);   // last seen BEFORE nudge
  assert.equal(isFlipDue(iv, nudged.getTime() + 5000, now), false);  // touch after nudge cancels
  assert.equal(isFlipDue({ ...iv, nudged_at: new Date(now.getTime() - FLIP_GRACE_MS + 60000).toISOString() }, null, now), false); // inside grace
});

test('sumOverlapMs splits at window boundaries and clips open intervals to now', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  const winStart = new Date('2026-07-01T00:00:00Z');
  const intervals = [
    // 22:00 Jun 30 -> 02:00 Jul 1: only 2h inside the window
    { state: 'desk', started_at: '2026-06-30T22:00:00Z', ended_at: '2026-07-01T02:00:00Z' },
    // open available interval since 10:00 -> clips to now (2h)
    { state: 'available', started_at: '2026-07-02T10:00:00Z', ended_at: null },
    // entirely before window: ignored
    { state: 'desk', started_at: '2026-06-29T00:00:00Z', ended_at: '2026-06-29T04:00:00Z' },
  ];
  const t = sumOverlapMs(intervals, winStart, now, now);
  assert.equal(t.desk, 2 * 3600e3);
  assert.equal(t.available, 2 * 3600e3);
});

test('centralWindows: Thu Jul 2 2026 -> week starts Mon Jun 29 05:00Z (CDT), month Jul 1 05:00Z', () => {
  const { weekStart, monthStart } = centralWindows(new Date('2026-07-02T15:00:00Z'));
  assert.equal(weekStart.toISOString(), '2026-06-29T05:00:00.000Z');
  assert.equal(monthStart.toISOString(), '2026-07-01T05:00:00.000Z');
});

test('centralWindows: winter (CST, UTC-6) and week crossing a month edge', () => {
  // Thu Jan 1 2026: week starts Mon Dec 29 2025 06:00Z (CST).
  const { weekStart, monthStart } = centralWindows(new Date('2026-01-01T18:00:00Z'));
  assert.equal(weekStart.toISOString(), '2025-12-29T06:00:00.000Z');
  assert.equal(monthStart.toISOString(), '2026-01-01T06:00:00.000Z');
});
