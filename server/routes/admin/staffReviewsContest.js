/**
 * Quarterly review contest: the leaderboard read model and the one-click
 * award (spec 2026-08-06 §7). Split out of staffReviews.js, which crossed the
 * 700-line soft cap; payrollTax.js set the extraction precedent.
 * Mounted from ./index.js; routes declare FULL paths under /api/admin.
 *
 * The award is the money write. It is permanently idempotent through
 * UNIQUE(contest_quarter, contractor_id), which is exactly why it refuses a
 * quarter that has not finished unless the admin forces it.
 */
const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError } = require('../../utils/errors');
const { findOpenPeriodForDate } = require('../../utils/payrollProcessing');
const { chicagoTodayYmd } = require('../../utils/businessTime');
const { CONTEST_POT_CENTS, materializeContestAward } = require('../../utils/dutyLines');
const { splitEvenly } = require('../../utils/payrollMath');
const { logAdminAction } = require('../../utils/adminAuditLog');

const router = express.Router();

// Contest floors (spec §7; admin knobs, these are the seeds).
const MIN_EVENTS_WORKED = 4;
const MIN_NAMED_FIVE_STARS = 2;

// Same display-name expression the review log uses (staffReviews.js).
const NAME_EXPR = 'COALESCE(cp.display_name, cp.preferred_name, u.email)';
const QUARTER_RE = /^\d{4}-Q[1-4]$/;

/** '2026-Q3' -> { start: '2026-07-01', end: '2026-09-30' }. */
function quarterRange(quarter) {
  const year = Number(quarter.slice(0, 4));
  const n = Number(quarter.slice(6));
  const startMonth = (n - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  const p2 = (x) => String(x).padStart(2, '0');
  return { start: `${year}-${p2(startMonth)}-01`, end: `${year}-${p2(endMonth)}-${p2(lastDay)}` };
}

// ─── Quarterly contest ────────────────────────────────────────────

/**
 * Leaderboard rows for a quarter. events_worked counts DISTINCT events the
 * staffer holds an approved, non-dropped shift request on; named_five_stars
 * counts credits on CONFIRMED 5-star reviews dated inside the quarter.
 * Eligible-first, then rate descending (spec §7).
 */
async function leaderboardRows(executor, quarter) {
  const { start, end } = quarterRange(quarter);
  const { rows } = await executor.query(
    `WITH worked AS (
       SELECT sr.user_id, COUNT(DISTINCT p.id) AS events_worked
         FROM shift_requests sr
         JOIN shifts s ON s.id = sr.shift_id
         JOIN proposals p ON p.id = s.proposal_id
        WHERE sr.status = 'approved' AND sr.dropped_at IS NULL
          -- Events already WORKED, so the window stops at today. Counting a
          -- shift booked later this quarter would deflate a mid-quarter rate
          -- and hide a qualifier behind events nobody has worked yet.
          AND p.event_date BETWEEN $1 AND LEAST($2::date, $3::date)
        GROUP BY sr.user_id
     ),
     named AS (
       SELECT c.user_id, COUNT(*) AS named_five_stars
         FROM staff_review_credits c
         JOIN staff_reviews r ON r.id = c.staff_review_id
        WHERE r.status = 'confirmed' AND r.stars = 5
          -- Same today-clamp as worked: a post-dated manual review must not
          -- count in the numerator while its event is absent from the
          -- denominator (rates over 100%, re-review residual).
          AND r.review_date BETWEEN $1 AND LEAST($2::date, $3::date)
        GROUP BY c.user_id
     )
     SELECT u.id AS user_id,
            ${NAME_EXPR} AS name,
            COALESCE(w.events_worked, 0)::int AS events_worked,
            COALESCE(n.named_five_stars, 0)::int AS named_five_stars
       FROM users u
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
       LEFT JOIN worked w ON w.user_id = u.id
       LEFT JOIN named n ON n.user_id = u.id
      WHERE COALESCE(w.events_worked, 0) > 0 OR COALESCE(n.named_five_stars, 0) > 0`,
    [start, end, chicagoTodayYmd()]
  );
  const enriched = rows.map((r) => {
    const events = Number(r.events_worked);
    const named = Number(r.named_five_stars);
    return {
      user_id: Number(r.user_id),
      name: r.name,
      events_worked: events,
      named_five_stars: named,
      rate: events > 0 ? named / events : 0,
      eligible: events >= MIN_EVENTS_WORKED && named >= MIN_NAMED_FIVE_STARS,
    };
  });
  enriched.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (b.rate !== a.rate) return b.rate - a.rate;
    return a.user_id - b.user_id;
  });
  return enriched;
}

/**
 * Winners are the eligible rows tied at the top rate. Compared by
 * cross-multiplication so a float rounding artifact can never split or merge
 * a tie. ONE implementation, shared by the leaderboard payload and the award,
 * so the dialog the admin confirms shows exactly what the award will write.
 */
function contestWinners(rows) {
  const eligible = rows.filter((r) => r.eligible);
  if (!eligible.length) return [];
  const best = eligible.reduce((a, b) => (
    b.named_five_stars * a.events_worked > a.named_five_stars * b.events_worked ? b : a
  ));
  return eligible
    .filter((r) => r.named_five_stars * best.events_worked === best.named_five_stars * r.events_worked)
    .sort((a, b) => a.user_id - b.user_id);
}

/** Remainder cents fall to the earlier user ids (payrollMath.splitEvenly). */
function contestShares(winners) {
  const queue = splitEvenly(CONTEST_POT_CENTS, winners.length);
  return winners.map((w) => ({
    user_id: w.user_id, name: w.name, amount_cents: queue.shift(),
  }));
}

async function loadContestAwards(executor, quarter) {
  const { rows } = await executor.query(
    `SELECT d.*, ${NAME_EXPR} AS name
       FROM payout_duty_lines d
       JOIN users u ON u.id = d.contractor_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = d.contractor_id
      WHERE d.kind = 'review_contest' AND d.contest_quarter = $1
      ORDER BY d.contractor_id`,
    [quarter]
  );
  return rows;
}

// GET /staff-reviews/leaderboard?quarter=2026-Q3
router.get('/staff-reviews/leaderboard', auth, adminOnly, asyncHandler(async (req, res) => {
  const quarter = String(req.query.quarter || '');
  if (!QUARTER_RE.test(quarter)) throw new ValidationError(null, 'quarter must look like 2026-Q3');
  const rows = await leaderboardRows(pool, quarter);
  const { start, end } = quarterRange(quarter);
  const winners = contestWinners(rows);
  res.json({
    quarter,
    start_date: start,
    end_date: end,
    in_progress: end >= chicagoTodayYmd(),
    min_events_worked: MIN_EVENTS_WORKED,
    min_named_five_stars: MIN_NAMED_FIVE_STARS,
    pot_cents: CONTEST_POT_CENTS,
    rows,
    // Server truth for the confirm dialog: the client renders these, it never
    // recomputes the winner set or the split.
    winners: winners.map((w) => w.user_id),
    shares: contestShares(winners),
  });
}));

// POST /staff-reviews/contest-award {quarter} — one-click, never automatic.
// Idempotent through UNIQUE(contest_quarter, contractor_id): a second click
// returns the existing rows and creates nothing (spec §7).
router.post('/staff-reviews/contest-award', auth, adminOnly, asyncHandler(async (req, res) => {
  const quarter = String(req.body.quarter || '');
  if (!QUARTER_RE.test(quarter)) throw new ValidationError(null, 'quarter must look like 2026-Q3');

  const force = req.body.force === true;

  const client = await pool.connect();
  let out;
  try {
    await client.query('BEGIN');
    const existing = await loadContestAwards(client, quarter);
    if (existing.length) {
      await client.query('COMMIT');
      out = {
        body: { quarter, awarded_already: true, awards: existing },
        audit: { quarter, awarded_already: true, existing: existing.length },
      };
    } else {
      // The award is permanently idempotent, so a mis-timed click on a quarter
      // that is still running locks in a winner nobody can revise. Refuse until
      // the quarter has closed, unless the admin deliberately forces it.
      const { end } = quarterRange(quarter);
      if (end >= chicagoTodayYmd() && !force) {
        // Machine-readable code: the client's force flow keys on err.code, so
        // a copy edit to this message can never disable the retry path.
        throw new ConflictError('quarter still in progress; pass force to award anyway', 'QUARTER_IN_PROGRESS');
      }

      const rows = await leaderboardRows(client, quarter);
      const winners = contestWinners(rows);
      if (!winners.length) throw new ConflictError('no eligible contractors this quarter');

      // No open period means the award would silently vanish (contest lines
      // have no catch-up pass), so refuse instead of writing nothing.
      const period = await findOpenPeriodForDate(client, chicagoTodayYmd());
      if (!period) throw new ConflictError('no open pay period; open one before awarding the contest');

      const shares = contestShares(winners);
      const awards = [];
      for (const share of shares) {
        const line = await materializeContestAward(client, {
          contractorId: share.user_id, quarter, amountCents: share.amount_cents,
        });
        if (line) awards.push({ ...line, name: share.name });
      }

      if (!awards.length) {
        // Concurrent loser: the probe above found nothing, but every insert hit
        // the contest index, so a parallel click paid this quarter first.
        // Report the rows that actually exist, never an empty award list.
        const actual = await loadContestAwards(client, quarter);
        await client.query('COMMIT');
        out = {
          body: { quarter, awarded_already: true, awards: actual },
          audit: { quarter, awarded_already: true, concurrent: true, existing: actual.length },
        };
      } else {
        await client.query('COMMIT');
        out = {
          body: { quarter, awarded_already: false, awards },
          audit: {
            quarter,
            force,
            winners: winners.map((w) => w.user_id),
            amounts_cents: shares.map((s) => s.amount_cents),
            created: awards.length,
          },
        };
      }
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
  await logAdminAction({
    actorUserId: req.user.id, targetUserId: null,
    action: 'staff_review_contest_award', metadata: out.audit,
  });
  return res.json(out.body);
}));

module.exports = router;
