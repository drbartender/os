'use strict';

// Backfill: close shifts stranded on a NON-TERMINAL status on proposals that are
// already 'completed', and — the part that actually needs a human — report the
// PAID events with nobody recorded on the roster.
//
// Nothing in this system ever closed a shift, so completed events accumulated
// permanently-open shift rows. Measured on prod 2026-08-14: 50 such shifts, 42
// actually worked (approved, non-dropped request; 31 with payout rows), 8 never
// staffed and never requested. They are invisible to staff because the
// open-shift feeds hide anything already finished; this is data honesty, not a
// live staff-facing bug.
//
// READ THIS BEFORE RUNNING --apply: you almost certainly do not need to. The
// hourly closure sweep (server/utils/shiftClosureSweep.js, wired in
// server/index.js behind RUN_SHIFT_CLOSURE_SWEEP_SCHEDULER) runs this exact
// query on a schedule and will drain the 50 stranded rows within an hour of
// deploy, using the same shared predicate. What this script adds is the DRY RUN
// — the per-row plan and the ROSTER GAP block — which is a report a human reads,
// not a write anybody is waiting on. --apply exists so the closure can be done
// deliberately and on the record if the scheduler is off.
//
// THE RULE: every candidate closes 'completed'. ALWAYS. Never 'cancelled',
// worked or not. shifts.status = 'cancelled' is OVERLOADED as an EVENT-LEVEL
// cancelled signal and two verified consumers read it that way straight off a
// shift row:
//   - client/src/components/adminos/shifts.js isCancelledEvent() returns true on
//     e.status === 'cancelled', and on the admin GET /shifts feed `status` IS the
//     shift status, so the Events dashboard renders a Cancelled chip.
//   - server/routes/calendar.js sets cancelled: s.status === 'closed' ||
//     s.status === 'cancelled', which becomes STATUS:CANCELLED in the iCal VEVENT
//     with a bumped SEQUENCE, so Google Calendar strikes or drops the event from
//     the owner's subscribed calendar.
// The event completed. A shift nobody was rostered on is an UNRECORDED ROSTER —
// a data gap — not a cancellation. Two of the eight never-staffed prod
// candidates (shift 31 / proposal 54, shift 19 / proposal 21) are real,
// delivered, paid-in-full events where the owner apparently worked the bar
// himself; an earlier round labelling those 'cancelled' nearly struck two real
// paid events off the owner's Google Calendar. Do not re-add a cancelled branch.
//
// Already-'cancelled' shifts are never candidates, so a genuinely reaped shift
// is never resurrected. shift_requests are deliberately untouched: payroll
// accrual and the tip clawback key on sr.status='approved' AND
// dropped_at IS NULL, and closing a shift must not change who worked it.
//
// ROSTER GAPS are reported, never silently closed. A candidate whose proposal
// took real money (amount_paid > 0) but has NO approved, non-dropped
// shift_request means a paid event ran with nobody recorded on it. That is not a
// reason to refuse the close ('completed' is the correct status either way), but
// a human must see it, so it prints as a prominent ROSTER GAP block in the dry
// run — including in --apply output. Payout rows on such a shift are extra
// evidence of the same gap and are called out on the line, not treated as a
// separate refusal: refusing on payout_events alone could not tell a real paid
// event from $0 seed junk, which is exactly the blind spot this replaces.
//
// "HAS IT FINISHED" IS THE SHARED PREDICATE, not a date gate this script owns.
// Eligibility is the shift's END INSTANT (server/utils/shiftEndInstant.js), the
// identical fragment the sweep and every visibility surface import. An earlier
// round hand-rolled `s.event_date >= CURRENT_DATE` here and got it wrong twice
// in one line: `>=` counted TODAY as future so a same-day completed event
// hard-refused the whole run, and CURRENT_DATE resolves in the GMT session zone
// so from 19:00 Chicago it was already tomorrow there. A still-unfinished shift
// on a completed proposal is NOT an error now — it is a normal state that closes
// on a later sweep pass — so it is listed as SKIPPED, never a refusal.
//
// Safe to re-run: closed shifts leave the candidate set, so a second run prints
// "nothing to do". The shifts updated_at trigger DOES restamp the rows this
// closes, and that is not inert — server/routes/calendar.js derives both the
// iCal SEQUENCE (:129, emitted at :237 alongside LAST-MODIFIED) and the feed's
// ETag / Last-Modified (:400-404) from shifts.updated_at. So the first run
// bumps the sequence on every shift it closes and the owner's subscribed
// calendar re-syncs those events once. Acceptable for a one-time backfill of
// past events, and the reason the candidate set EXCLUDES already-'completed'
// rows: a second run must touch nothing, or every run would churn the feed.
// (An earlier revision of this header claimed nothing keys on updated_at. It
// was wrong; the claim is corrected here rather than deleted, because "nothing
// reads this column" is exactly the kind of assertion that gets copied forward.)
//
// Usage:
//   node -r dotenv/config server/scripts/backfillShiftClosures.js           (dry run, default)
//   node -r dotenv/config server/scripts/backfillShiftClosures.js --apply   (write)

require('dotenv').config();
const { pool } = require('../db');
const { shiftEndInstantSql, shiftFinishedSql } = require('../utils/shiftEndInstant');

const APPLY = process.argv.includes('--apply');

// Name the database this run will touch, BEFORE touching it (same banner as
// refreshDisplayNames.js / applySeniorityBackfill.js dbTarget). Host + database
// only, never the URL's credentials.
function dbTarget() {
  const url = process.env.DATABASE_URL;
  if (!url) return '(DATABASE_URL not set)';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main() {
  console.log(`[backfillShiftClosures] ${APPLY ? 'APPLY' : 'DRY RUN'}  db=${dbTarget()}`);

  // Every open/filled shift on a completed proposal, tagged with whether it has
  // finished. Unfinished rows are carried through so the run can SAY it left
  // them rather than silently narrowing.
  const { rows } = await pool.query(`
    SELECT s.id, s.proposal_id, s.status,
           to_char(s.event_date, 'YYYY-MM-DD') AS event_date,
           s.start_time, s.end_time,
           ${shiftEndInstantSql('s', 'p')} AS end_instant,
           ${shiftFinishedSql('s', 'p')} AS finished,
           COALESCE(c.name, s.client_name, '(no client)') AS client_name,
           COALESCE(p.total_price, 0) AS total_price,
           COALESCE(p.amount_paid, 0) AS amount_paid,
           EXISTS (SELECT 1 FROM shift_requests sr
                    WHERE sr.shift_id = s.id
                      AND sr.status = 'approved'
                      AND sr.dropped_at IS NULL) AS worked,
           EXISTS (SELECT 1 FROM payout_events pe
                    WHERE pe.shift_id = s.id) AS has_payouts
      FROM shifts s
      JOIN proposals p ON p.id = s.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
     WHERE p.status = 'completed'
       -- Exclude the TERMINAL values rather than allowlisting the live ones, and
       -- keep this IDENTICAL to shiftClosureSweep.js. An allowlist silently drops
       -- real rows (dev shift #16 was 'confirmed') — and because this same filter
       -- feeds the PLAN a human reads, the report would have said "nothing to do"
       -- while unclosed rows remained. That is worse than not running it.
       -- Corrected 2026-08-20: this used to say shifts.status has no CHECK
       -- constraint. It does. What is true is that the constraint had failed to
       -- install on dev for as long as those out-of-range rows existed, silently,
       -- which is why shiftClosureSweep.js's header now argues from that instead.
       AND s.status NOT IN ('completed', 'cancelled', 'closed')
     ORDER BY s.id
  `);

  const candidates = rows.filter((r) => r.finished);
  const notYet = rows.filter((r) => !r.finished);

  if (notYet.length) {
    console.log(`\nSKIPPED — ${notYet.length} shift(s) on a completed proposal have NOT finished yet.`);
    console.log('Normal, not an error: they close on a later sweep pass once their end instant passes.');
    for (const r of notYet) {
      console.log(`  shift #${r.id}  proposal #${r.proposal_id}  ${r.event_date} ${r.start_time || '?'}-${r.end_time || '?'}  ends ${new Date(r.end_instant).toISOString()}`);
    }
    console.log('');
  }

  if (candidates.length === 0) {
    console.log('Nothing to do: no FINISHED open/filled shifts on completed proposals.');
    await pool.end();
    return;
  }

  for (const r of candidates) {
    const why = r.worked
      ? `worked (approved request${r.has_payouts ? ', payout rows' : ''})`
      : `no roster recorded${r.has_payouts ? ', payout rows exist' : ''}`;
    console.log(`  shift #${r.id}  proposal #${r.proposal_id}  ${r.event_date}  ${r.status} -> completed  (${why})`);
  }
  console.log(`\n${candidates.length} shift(s) -> completed. 0 -> cancelled (this script never emits 'cancelled').`);

  // Roster gaps: real money in, nobody recorded on the roster. Reported, not
  // refused — 'completed' is right either way, but this must never pass silently.
  const rosterGaps = candidates.filter((r) => !r.worked && Number(r.amount_paid) > 0);
  if (rosterGaps.length) {
    console.log(`\n${'!'.repeat(72)}`);
    console.log(`ROSTER GAP — ${rosterGaps.length} PAID event(s) with nobody recorded on the shift.`);
    console.log('A real, paid event ran and no approved non-dropped shift_request exists for');
    console.log('it. The shift still closes \'completed\' (the event happened), but somebody');
    console.log('should find out who actually worked it — payroll has no record.');
    for (const r of rosterGaps) {
      console.log(`  shift #${r.id}  proposal #${r.proposal_id}  ${r.event_date}  ${r.client_name}  total ${r.total_price}  paid ${r.amount_paid}${r.has_payouts ? '  [has payout_events]' : ''}`);
    }
    console.log(`${'!'.repeat(72)}\n`);
  } else {
    console.log('No roster gaps: every unworked candidate is on a $0 proposal.\n');
  }

  if (!APPLY) {
    console.log('DRY RUN — nothing written. Re-run with --apply to write.');
    await pool.end();
    return;
  }

  const ids = candidates.map((r) => r.id);
  const client = await pool.connect();
  let mismatch = null;
  try {
    await client.query('BEGIN');
    // Re-assert the status guard in the WHERE so a row that moved since the
    // SELECT (closed by the sweep, reaped, hand-edited) is skipped — and then
    // FAIL on any skip: a count mismatch means the plan printed above is not the
    // write that would happen, so nothing is written at all.
    const done = await client.query(
      `UPDATE shifts SET status = 'completed'
        WHERE id = ANY($1) AND status NOT IN ('completed', 'cancelled', 'closed')`,
      [ids]
    );
    if (done.rowCount !== ids.length) {
      await client.query('ROLLBACK');
      mismatch = done.rowCount;
    } else {
      await client.query('COMMIT');
      console.log(`APPLIED: ${done.rowCount} shift(s) -> completed.`);
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rbErr) {
      console.error(`ROLLBACK also failed: ${rbErr.message}`);
    }
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
  if (mismatch !== null) {
    console.error(`REFUSING: counts moved between plan and write (completed ${mismatch}/${ids.length}). Rolled back — nothing written. Re-run to re-plan.`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
