'use strict';

// shiftClosureSweep — close shifts that have FINISHED on a COMPLETED proposal.
//
// Spec: docs/superpowers/specs/2026-08-14-shift-lifecycle-design.md
//
// ─── WHY A SWEEP AND NOT A COMPLETION HOOK ──────────────────────────────────
//
// Nothing in this system had ever closed a shift when this was written: only 5
// shifts in prod had reached 'completed', 'filled' had never been used at all,
// and 50 sat 'open' on completed proposals, 31 of them with payout_events.
//
// Past tense on purpose, and dated, because those were point-in-time counts that
// this very sweep then changed. As of 2026-08-20 prod reads 51 completed (34 with
// payout_events), 19 open, 2 cancelled, zero 'filled', and ZERO open shifts on
// completed proposals. Do not re-derive the argument from the numbers above; they
// are the BEFORE picture and are kept only to show what the sweep was built for.
// Re-query if you need current state.
//
// The obvious fix — close a proposal's shifts when the proposal flips to
// 'completed' — was built and failed. A proposal can carry a shift dated LATER
// than the proposal's own event date (PUT /shifts/:id writes event_date straight
// from the body, syncShiftsFromProposal re-syncs only single-shift proposals,
// POST /shifts accepts an arbitrary date), so the hook needed a date gate to
// avoid stamping a still-upcoming shift terminal. And that gate had NO LATER
// PASS: processEventCompletions never re-selects an already-completed proposal,
// so a shift skipped once was skipped forever.
//
// A sweep has no such hole. It asks the two questions that actually matter —
// has this SHIFT finished, and did its event happen — every hour, forever. The
// future-dated case falls out for free, and a missed close heals itself on the
// next pass instead of stranding a row until somebody runs a script.
//
// ─── THE TERMINAL STATUS IS ALWAYS 'completed', NEVER 'cancelled' ───────────
//
// shifts.status = 'cancelled' is OVERLOADED as an EVENT-LEVEL cancelled signal
// and two verified consumers read it that way straight off a shift row:
//   - client/src/components/adminos/shifts.js isCancelledEvent() returns true
//     on e.status === 'cancelled', and on the admin GET /shifts feed `status` IS
//     the shift status, so the Events dashboard renders a Cancelled chip.
//   - server/routes/calendar.js sets cancelled: s.status === 'closed' ||
//     s.status === 'cancelled', which becomes STATUS:CANCELLED in the iCal
//     VEVENT with a bumped SEQUENCE — Google Calendar strikes or drops the
//     event from the owner's subscribed calendar.
// A shift with nobody rostered on it is an UNRECORDED ROSTER — a data gap — not
// a cancellation. Prod holds real, delivered, paid-in-full events (proposals 21
// and 54) where nobody was ever rostered because the owner worked the bar
// himself; an earlier round marking those 'cancelled' nearly struck two real
// paid events off the owner's Google Calendar. Do not add a 'cancelled' branch.
// server/scripts/backfillShiftClosures.js reports that combination as a
// prominent ROSTER GAP instead.
//
// ─── WHAT IS AND IS NOT A CANDIDATE ─────────────────────────────────────────
//
// EXCLUDE the terminal values; do not allowlist the live ones.
//
// CORRECTED 2026-08-20. This block used to argue from "`shifts.status` has NO
// CHECK constraint, so the value space is open-ended". That premise is FALSE on
// both databases: `shifts_status_check` permits {open, filled, completed,
// cancelled} and prod has carried it for a long time. The CONCLUSION survives
// the correction, on better grounds:
//
//   - That constraint has been ABSENT before, silently. Its DO-block ADD failed
//     forever on dev against three pre-existing rows carrying 'confirmed', a
//     value nothing writes and no definition permits, and the block swallowed
//     the error. Dev shift #16 was one of those rows: on a completed proposal,
//     meeting both questions that actually matter, and skipped by an allowlist
//     on every hourly tick. That episode is why `shifts_status_check` is now in
//     `CONSTRAINT_CONTRACT` (server/db/index.js) — so this filter must stay
//     correct in the world where the constraint is missing, because that world
//     has happened.
//   - The two lists fail in opposite directions. A missed entry in an allowlist
//     drops real rows silently; a stale entry in an exclude list is inert. And
//     backfillShiftClosures.js repeats this filter to build the PLAN a human
//     reads, so an allowlist made that report say "nothing to do" while unclosed
//     rows remained. A report that lies is worse than no report.
//
// 'closed' is not in the constraint today and so is unreachable while it holds;
// it stays in the exclude list because calendar.js reads it identically to
// 'cancelled', and an inert arm costs nothing.
//
// The excluded set is every value a downstream reader treats as TERMINAL:
//   'completed'  already closed; excluding it makes a repeat pass touch no row,
//                which also keeps the shifts updated_at trigger from restamping
//                (calendar.js derives the iCal SEQUENCE and the feed ETag from
//                that column, so a needless restamp churns the owner's calendar).
//   'cancelled'  the EVENT was cancelled — read as such by adminos/shifts.js
//                isCancelledEvent and by calendar.js.
//   'closed'     calendar.js:432 treats it identically to 'cancelled'. Sweeping
//                it to 'completed' would UN-cancel that event on the owner's
//                subscribed Google Calendar.
//
// This does mean an unknown status gets normalised to 'completed' once the shift
// has finished on a completed proposal. That is the right trade: those rows come
// from PUT /shifts/:id, which takes `status` off the request body with no
// allowlist (a known-open gap the spec records and this lane does not own), and
// leaving them stranded forever to avoid "papering over" it helps nobody — the
// gap is recorded in the fix list, where a reader will actually find it.
//
// A shift with no proposal is never a candidate: "the event happened" is a fact
// about the proposal, and there is nothing to read it from.

const { pool } = require('../db');
const { shiftFinishedSql } = require('./shiftEndInstant');

/**
 * Close every shift that has finished on a completed proposal.
 *
 * One statement, one autocommit round trip: an UPDATE ... FROM is atomic on its
 * own, and there is no second table to keep in step (shift_requests are
 * deliberately untouched — payroll accrual and the tip clawback key on
 * sr.status='approved' AND dropped_at IS NULL, and a closed shift must not
 * change who worked it).
 *
 * @param {import('pg').Pool|import('pg').PoolClient} [db] defaults to the shared pool
 * @returns {Promise<Array<{id:number, proposal_id:number}>>} rows actually closed
 */
async function sweepFinishedShiftClosures(db = pool) {
  const { rows } = await db.query(
    `UPDATE shifts s
        SET status = 'completed'
       FROM proposals p
      WHERE p.id = s.proposal_id
        AND p.status = 'completed'
        -- Exclude the TERMINAL values, do not allowlist the live ones. An
        -- earlier cut used IN ('open','filled') and silently skipped every
        -- other value forever: shift #16 on dev carried 'confirmed' on a
        -- completed proposal and met both questions that actually matter while
        -- being skipped on every hourly tick. shifts_status_check DOES exist
        -- (corrected 2026-08-20 — this comment used to say it did not), but it
        -- had failed to install on dev for exactly as long as those rows
        -- existed, which is the world this filter has to stay correct in. See
        -- WHAT IS AND IS NOT A CANDIDATE above.
        -- 'completed' is already closed; 'cancelled' AND 'closed' both mean the
        -- EVENT was cancelled (calendar.js:432 reads them identically) and must
        -- never be resurrected. See WHAT IS AND IS NOT A CANDIDATE above.
        AND s.status NOT IN ('completed', 'cancelled', 'closed')
        AND ${shiftFinishedSql('s', 'p')}
    RETURNING s.id, s.proposal_id`
  );
  return rows;
}

/** Scheduler entry point: sweep and log. Never throws past wrapScheduler. */
async function processShiftClosures() {
  const closed = await sweepFinishedShiftClosures();
  if (closed.length > 0) {
    console.log(
      `[shift_closure] Closed ${closed.length} finished shift(s): ` +
      closed.map((r) => `#${r.id}(p${r.proposal_id})`).join(', ')
    );
  }
  return closed;
}

module.exports = { sweepFinishedShiftClosures, processShiftClosures };
