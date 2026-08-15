// The shift-closure sweep.
//
// Nothing in this system has ever closed a shift: only 5 prod shifts have ever
// reached 'completed', 'filled' has never been used, and 50 sit 'open' on
// completed proposals. The sweep closes a shift when the SHIFT has finished and
// its proposal is completed — the two facts that actually matter — rather than
// hanging off the proposal-completion doors, which fire once per proposal and
// therefore had no later pass for a shift their date gate skipped.
//
// The assertions that matter most are the ones about what it must NOT do:
//   - never write 'cancelled', which two consumers read as an EVENT-cancelled
//     signal (the Events dashboard chip, and STATUS:CANCELLED with a bumped
//     SEQUENCE in the iCal feed that the owner's Google Calendar subscribes to).
//     An earlier round nearly struck two real paid events off that calendar.
//   - never close a shift that has not finished, even on a completed proposal.
//   - never touch shift_requests, which payroll accrual and the tip clawback
//     read to decide who worked and gets paid.
//
// Run BOTH:
//   TZ=UTC              node --test server/utils/shiftClosureSweep.test.js
//   TZ=America/Chicago  node --test server/utils/shiftClosureSweep.test.js

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { sweepFinishedShiftClosures } = require('./shiftClosureSweep');
const { shiftFinishedSql } = require('./shiftEndInstant');

if (process.env.NODE_ENV === 'production') {
  throw new Error('shiftClosureSweep.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const LABEL = `Closure ${NONCE}`;

const F = {};
let clock;
let clientId, staffId;
let completedProposalId, livePropo14dId;

// THE SWEEP IS RUN INSIDE A TRANSACTION THAT IS ROLLED BACK.
// sweepFinishedShiftClosures() is an unfiltered UPDATE over the whole table by
// design — the first draft of this file called it on the shared pool and
// permanently closed 34 unrelated shifts on the shared dev database. The
// fixtures are committed by the pool (so the sweep really sees them), every
// sweep call and every read-back rides `tx`, and after() rolls the whole thing
// away.
let tx;

async function seedShift(key, { date, endTime, status = 'open', proposal }) {
  const r = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name,
                         positions_needed, proposal_id)
     VALUES ($1::date, NULL, $2, $3, '1 Test St', $4, '["Bartender"]', $5) RETURNING id`,
    [date, endTime, status, `${LABEL} ${key}`, proposal]
  );
  F[key] = r.rows[0].id;
  return F[key];
}

async function statusOf(id) {
  return (await tx.query('SELECT status FROM shifts WHERE id = $1', [id])).rows[0].status;
}

before(async () => {
  const tz = (await pool.query(`SELECT current_setting('TimeZone') AS tz`)).rows[0].tz;
  assert.equal(tz, 'GMT', `test premise: the DB session must run at GMT (got ${tz})`);

  clock = (await pool.query(`
    WITH chi AS (SELECT NOW() AT TIME ZONE 'America/Chicago' AS n)
    SELECT to_char(n, 'HH24:MI') AS chi_now,
           to_char(GREATEST(n - INTERVAL '30 minutes',
                            date_trunc('day', n) + INTERVAL '1 minute'), 'YYYY-MM-DD') AS ended_d,
           to_char(GREATEST(n - INTERVAL '30 minutes',
                            date_trunc('day', n) + INTERVAL '1 minute'), 'HH24:MI')    AS ended_t,
           to_char(LEAST(n + INTERVAL '30 minutes',
                         date_trunc('day', n) + INTERVAL '23 hours 59 minutes'), 'YYYY-MM-DD') AS soon_d,
           to_char(LEAST(n + INTERVAL '30 minutes',
                         date_trunc('day', n) + INTERVAL '23 hours 59 minutes'), 'HH24:MI')    AS soon_t,
           to_char(n + INTERVAL '14 days', 'YYYY-MM-DD') AS far_d
      FROM chi
  `)).rows[0];

  clientId = (await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550000') RETURNING id`,
    [`Closure Client ${NONCE}`, `closure-${NONCE}@example.com`]
  )).rows[0].id;
  staffId = (await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
    [`closure-staff-${NONCE}@example.com`]
  )).rows[0].id;

  const mkProposal = async (status) => (await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                            event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE, '18:00', 4, 'America/Chicago', $2, 'birthday-party') RETURNING id`,
    [clientId, status]
  )).rows[0].id;

  completedProposalId = await mkProposal('completed');
  livePropo14dId = await mkProposal('confirmed');

  // The main candidate: finished, on a completed proposal.
  await seedShift('finishedCompleted', { date: clock.ended_d, endTime: clock.ended_t, proposal: completedProposalId });
  // Same, but 'filled' — the status that has never been used in prod but is a
  // legal non-terminal value.
  await seedShift('filledCompleted', { date: clock.ended_d, endTime: clock.ended_t, status: 'filled', proposal: completedProposalId });
  // On a completed proposal but NOT finished — the future-dated case the
  // completion-door hook had to gate for and then never revisited. shifts
  // .event_date is independent of the proposal's, so this is real.
  await seedShift('futureOnCompleted', { date: clock.far_d, endTime: '11:00 PM', proposal: completedProposalId });
  // Ends in half an hour, on a completed proposal: still running, hands off.
  await seedShift('runningOnCompleted', { date: clock.soon_d, endTime: clock.soon_t, proposal: completedProposalId });
  // Finished, but the event was never completed: not our business.
  await seedShift('finishedNotCompleted', { date: clock.ended_d, endTime: clock.ended_t, proposal: livePropo14dId });
  // Finished with NO proposal: "the event happened" is a fact about the
  // proposal, and there is nothing to read it from.
  await seedShift('finishedNoProposal', { date: clock.ended_d, endTime: clock.ended_t, proposal: null });
  // Already cancelled on a completed proposal: a genuinely reaped shift must
  // never be resurrected or restamped.
  await seedShift('alreadyCancelled', { date: clock.ended_d, endTime: clock.ended_t, status: 'cancelled', proposal: completedProposalId });
  // NOTE 2026-08-14: two fixtures were removed here, and the reason matters.
  // They seeded status='confirmed' and status='closed' — values
  // `shifts_status_check` REJECTS. This suite only ever passed because that
  // constraint was silently missing from the DEV database (its ADD had been
  // failing forever against three legacy rows). PROD has always carried the
  // constraint, with exactly ('open','filled','completed','cancelled') — so
  // against a prod-shaped database, including the `ci-smoke` branch the push
  // gate resets from the prod parent, these two fixtures would have 23514'd.
  // This file is not on money-smoke-list.txt, which is why nothing caught it.
  //
  // Dev was repaired 2026-08-14 and now matches prod, so the two states are
  // unreachable and cannot be seeded. Their coverage is preserved differently:
  //   - 'confirmed' (the old comment's "not hypothetical" case) is redundant
  //     anyway — `finishedCompleted` covers the 'open' non-terminal case and
  //     `filledCompleted` covers 'filled', which are now the ONLY non-terminal
  //     values that can exist.
  //   - 'closed' must still never be swept (calendar.js:432 and :539 read it
  //     exactly as 'cancelled', so closing it would un-cancel that event on the
  //     owner's subscribed Google Calendar). Since no row can carry it, that is
  //     pinned statically against the sweep's SQL in the test below instead.

  // A worked roster on the main candidate: closing must not disturb it.
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved')`,
    [F.finishedCompleted, staffId]
  );

  // Premises, re-derived from the database.
  const { rows } = await pool.query(
    `SELECT s.id, (${shiftFinishedSql('s', 'p')}) AS finished
       FROM shifts s LEFT JOIN proposals p ON p.id = s.proposal_id
      WHERE s.id = ANY($1::int[])`,
    [Object.values(F)]
  );
  const finished = Object.fromEntries(rows.map((r) => [r.id, r.finished]));
  const expectFinished = {
    finishedCompleted: true, filledCompleted: true, futureOnCompleted: false,
    runningOnCompleted: false, finishedNotCompleted: true, finishedNoProposal: true,
    alreadyCancelled: true,
  };
  for (const [key, want] of Object.entries(expectFinished)) {
    assert.equal(finished[F[key]], want,
      `test premise: fixture "${key}" should be ${want ? 'finished' : 'unfinished'} at Chicago ${clock.chi_now}`);
  }

  tx = await pool.connect();
  await tx.query('BEGIN');
});

after(async () => {
  if (tx) {
    // Undo every close the sweep performed, ours and anybody else's.
    try { await tx.query('ROLLBACK'); } finally { tx.release(); }
  }
  const ids = Object.values(F);
  if (ids.length) {
    await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [ids]);
  }
  for (const id of [completedProposalId, livePropo14dId]) {
    if (id) await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
  if (staffId) await pool.query('DELETE FROM users WHERE id = $1', [staffId]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('the sweep closes exactly the finished shifts of completed proposals', async () => {
  const closed = await sweepFinishedShiftClosures(tx);
  const closedIds = new Set(closed.map((r) => r.id));

  assert.ok(closedIds.has(F.finishedCompleted), 'a finished shift on a completed proposal must close');
  assert.ok(closedIds.has(F.filledCompleted), "'filled' is non-terminal and closes the same way");
  assert.ok(!closedIds.has(F.futureOnCompleted), 'a still-upcoming shift must be left alone — it closes on a later pass');
  assert.ok(!closedIds.has(F.runningOnCompleted), 'a shift still running must be left alone');
  assert.ok(!closedIds.has(F.finishedNotCompleted), 'the event has not been completed, so nothing closes');
  assert.ok(!closedIds.has(F.finishedNoProposal), 'no proposal means no way to know the event happened');
  assert.ok(!closedIds.has(F.alreadyCancelled), 'a reaped shift must never be resurrected');

  assert.equal(await statusOf(F.finishedCompleted), 'completed');
  assert.equal(await statusOf(F.filledCompleted), 'completed');
  assert.equal(await statusOf(F.futureOnCompleted), 'open');
  assert.equal(await statusOf(F.runningOnCompleted), 'open');
  assert.equal(await statusOf(F.finishedNotCompleted), 'open');
  assert.equal(await statusOf(F.finishedNoProposal), 'open');
  assert.equal(await statusOf(F.alreadyCancelled), 'cancelled');
});

test("the sweep NEVER writes 'cancelled' — that value means the EVENT was cancelled", async () => {
  // Two consumers read shifts.status = 'cancelled' as an event-level signal:
  // adminos/shifts.js isCancelledEvent (the Events dashboard Cancelled chip) and
  // calendar.js (STATUS:CANCELLED with a bumped SEQUENCE, which strikes the
  // event off the owner's subscribed Google Calendar). An unworked shift on a
  // delivered event is an unrecorded ROSTER, not a cancellation — prod holds
  // real paid-in-full events where the owner worked the bar himself.
  const { rows } = await tx.query(
    `SELECT COUNT(*)::int AS n FROM shifts WHERE client_name LIKE $1 AND status = 'cancelled'`,
    [`${LABEL}%`]
  );
  assert.equal(rows[0].n, 1, "only the pre-existing 'cancelled' fixture may carry that status");

  // Assert on the WRITE, not on any mention of the word. The module legitimately
  // names 'cancelled' in its candidate filter — `status NOT IN ('completed',
  // 'cancelled')` is what stops a cancelled shift being resurrected — so a bare
  // grep for the literal fails on the guard that exists to protect this very
  // invariant. What must never appear is an assignment of it.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'shiftClosureSweep.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|--|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/SET\s+status\s*=\s*'cancelled'/i.test(code),
    'the sweep must never SET status to cancelled');
  assert.ok(!/status\s*=\s*'cancelled'\s*(,|$|\n)/im.test(code.replace(/NOT IN \([^)]*\)/g, '')),
    'no assignment of cancelled anywhere outside the exclusion filter');
  // And the one write it does perform is the terminal value we intend.
  assert.ok(/SET\s+status\s*=\s*'completed'/i.test(code),
    'the sweep must still write completed');
});

test('closing a shift does not touch who worked it', async () => {
  // payroll accrual and the tip clawback key on sr.status='approved' AND
  // dropped_at IS NULL. A closure that edited those would silently change pay.
  const { rows } = await tx.query(
    `SELECT status, dropped_at FROM shift_requests WHERE shift_id = $1 AND user_id = $2`,
    [F.finishedCompleted, staffId]
  );
  assert.equal(rows[0].status, 'approved');
  assert.equal(rows[0].dropped_at, null);
});

test('a second pass is a no-op, so nothing is restamped', async () => {
  const closed = await sweepFinishedShiftClosures(tx);
  const mine = new Set(Object.values(F));
  assert.equal(closed.filter((r) => mine.has(r.id)).length, 0,
    'the candidates left the set on the first pass');
});

test('a closed shift disappears from the visibility family too', async () => {
  // Belt and braces: the end instant already hid it, and now the status guard
  // does as well. That second line only became meaningful once something
  // actually closed shifts — which, before this sweep, nothing ever did.
  const { rows } = await tx.query(
    `SELECT COUNT(*)::int AS n FROM shifts WHERE id = $1 AND status = 'open'`,
    [F.finishedCompleted]
  );
  assert.equal(rows[0].n, 0);
});

// Replaces the deleted `alreadyClosed` fixture. 'closed' is a value calendar.js
// reads exactly as 'cancelled' (`:432` and `:539`), so sweeping one to
// 'completed' would UN-cancel that event on the owner's subscribed Google
// Calendar — a near-miss an earlier round already had. No row can carry 'closed'
// (shifts_status_check forbids it on prod and, since 2026-08-14, on dev), so it
// cannot be seeded; the exclusion is pinned against the SQL text instead. Static
// is weaker than behavioural, and it is the strongest pin available for a branch
// that guards an unreachable state — the branch is worth keeping because dev
// spent months proving a constraint can go missing.
test('the sweep SQL still excludes every terminal status, including unreachable "closed"', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'shiftClosureSweep.js'), 'utf8');
  const notIn = /status\s+NOT\s+IN\s*\(([^)]*)\)/i.exec(src);
  assert.ok(notIn, 'the sweep no longer has a terminal-status exclusion list at all');
  for (const value of ['completed', 'cancelled', 'closed']) {
    assert.match(notIn[1], new RegExp(`'${value}'`),
      `'${value}' dropped from the sweep's exclusion list`);
  }
});
