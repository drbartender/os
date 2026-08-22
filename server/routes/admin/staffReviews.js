/**
 * Admin staff-review endpoints (spec 2026-08-06 §7), sibling to payrollDuty.js.
 * Mounted from ./index.js; routes declare FULL paths under /api/admin.
 *
 * Review money NEVER originates here: this file records the review and the
 * credits, then calls the dutyLines materializers, which own the uniqueness
 * keys (UNIQUE(staff_review_id, contractor_id) and UNIQUE(contest_quarter,
 * contractor_id)) that make a double-click unable to double-pay.
 *
 * Auth: admin-only, matching payroll. Every mutation releases its client,
 * AWAITS logAdminAction, then responds (payrollDuty ordering).
 */
const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { NotFoundError, ValidationError, ConflictError } = require('../../utils/errors');
const { recomputePayoutTotal } = require('../../utils/payrollProcessing');
const { materializeReviewLine, materializePendingReviewLines, REVIEW_BOUNTY_CENTS } = require('../../utils/dutyLines');
const { logAdminAction } = require('../../utils/adminAuditLog');

const router = express.Router();

const MAX_EXCERPT_CHARS = 2000;
const LIST_LIMIT = 200;

const NAME_EXPR = 'COALESCE(cp.display_name, cp.preferred_name, u.email)';
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function validYmd(s) {
  if (typeof s !== 'string' || !YMD_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * WHY a bounty line is locked, or null. The three frozen states are not equally
 * true and the copy has to say which: telling an admin a bounty is "already
 * paid" when the period is merely processing sends them looking for money that
 * has not moved (fix list, 2026-08-14). 'paid' outranks 'processing' because it
 * is the stronger fact about the same line.
 *
 * @returns {'paid'|'processing'|null}
 */
function lockReasonOf(row) {
  if (row.payout_status === 'paid' || row.period_status === 'paid') return 'paid';
  if (row.period_status === 'processing') return 'processing';
  return null;
}

/** True when the payout is paid or its period is processing/paid (spec §3.2).
 *  DERIVED from lockReasonOf so the gate and the reason cannot drift: this file
 *  refuses a dismiss on one and now labels the button with the other. */
function isFrozen(row) {
  return lockReasonOf(row) !== null;
}

/** The lock over a whole review's ACTIVE bounty lines, or null. `removed_at` is
 *  the payable filter, matching the refusal below and payrollProcessing.js. */
function reviewLockOf(lines) {
  const active = (lines || []).filter((l) => !l.removed_at);
  if (active.some((l) => lockReasonOf(l) === 'paid')) return 'paid';
  if (active.some((l) => lockReasonOf(l) === 'processing')) return 'processing';
  return null;
}

/**
 * A review pays ONLY while it is confirmed and carries five stars. Every
 * revive/materialize path gates on this, so a dismissed or downgraded review
 * can never be made to pay through a re-credit.
 */
function paysBounties(status, stars) {
  return status === 'confirmed' && Number(stars) === 5;
}

/**
 * A system tombstone (`removed_by IS NULL`) may be revived when the trigger
 * goes true again (spec §3.2). An ADMIN removal never is, and a frozen line is
 * never written at all.
 */
function isRevivable(line) {
  return !!line.removed_at && line.removed_by === null && !isFrozen(line);
}

/**
 * Bring one credited contractor's bounty into existence for a paying review.
 * Revives the system tombstone left by a dismiss or an un-credit, otherwise
 * materializes a fresh line. Callers MUST have checked paysBounties first.
 *
 * This is why a plain materializeReviewLine is not enough on its own: its
 * INSERT ... ON CONFLICT DO NOTHING hits the tombstoned row and silently pays
 * nothing, so dismiss-then-re-confirm would never pay again.
 * Returns 'restored' | 'materialized' | null.
 */
async function settleBounty(client, staffReviewId, contractorId) {
  const [line] = await pinBountyLines(client, staffReviewId, contractorId);
  if (line) {
    // Active, admin-removed, or frozen: leave it exactly as it is.
    if (!isRevivable(line)) return null;
    await client.query(
      `UPDATE payout_duty_lines
          SET removed_at = NULL, removed_by = NULL, note = 'credit restored', updated_at = NOW()
        WHERE id = $1`,
      [line.id]
    );
    await recomputePayoutTotal(client, line.payout_id);
    return 'restored';
  }
  const created = await materializeReviewLine(client, { staffReviewId, contractorId });
  return created ? 'materialized' : null;
}

/**
 * Pin every bounty line for a review (optionally one contractor's) together
 * with its payout and period, so the freeze decision cannot race a period
 * flipping to processing mid-transaction.
 */
async function pinBountyLines(client, staffReviewId, contractorId) {
  const params = [staffReviewId];
  let filter = '';
  if (contractorId !== undefined) {
    params.push(contractorId);
    filter = ' AND d.contractor_id = $2';
  }
  const { rows } = await client.query(
    `SELECT d.id, d.payout_id, d.contractor_id, d.amount_cents, d.removed_at, d.removed_by,
            po.status AS payout_status, pp.status AS period_status
       FROM payout_duty_lines d
       JOIN payouts po ON po.id = d.payout_id
       JOIN pay_periods pp ON pp.id = po.pay_period_id
      WHERE d.kind = 'review_bounty' AND d.staff_review_id = $1${filter}
      FOR UPDATE OF d, po, pp`,
    params
  );
  return rows;
}

async function loadReview(executor, id) {
  const { rows } = await executor.query(
    `SELECT r.*,
            COALESCE(
              json_agg(json_build_object('user_id', c.user_id, 'name', ${NAME_EXPR}))
                FILTER (WHERE c.user_id IS NOT NULL),
              '[]'
            ) AS credits
       FROM staff_reviews r
       LEFT JOIN staff_review_credits c ON c.staff_review_id = r.id
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = c.user_id
      WHERE r.id = $1
      GROUP BY r.id`,
    [id]
  );
  return rows[0] || null;
}

// GET /staff-reviews — pending first, then newest. Credits ride the payload.
router.get('/staff-reviews', auth, adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*,
            COALESCE(
              json_agg(json_build_object('user_id', c.user_id, 'name', ${NAME_EXPR}))
                FILTER (WHERE c.user_id IS NOT NULL),
              '[]'
            ) AS credits,
            bl.lock AS bounty_lock
       FROM staff_reviews r
       LEFT JOIN staff_review_credits c ON c.staff_review_id = r.id
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = c.user_id
       -- Per-review bounty lock, so the client can DISABLE Dismiss with the
       -- reason instead of only learning it from a 409 after the click (spec §7
       -- promised the disable and only the refusal was ever built). Mirrors
       -- lockReasonOf/reviewLockOf above and the refusal in the dismiss handler:
       -- ACTIVE lines only, 'paid' outranking 'processing'. Kept as SQL rather
       -- than a second round trip because the list is already one query.
       LEFT JOIN LATERAL (
         SELECT CASE
                  WHEN bool_or(po.status = 'paid' OR pp.status = 'paid') THEN 'paid'
                  WHEN bool_or(pp.status = 'processing') THEN 'processing'
                END AS lock
           FROM payout_duty_lines d
           JOIN payouts po ON po.id = d.payout_id
           JOIN pay_periods pp ON pp.id = po.pay_period_id
          WHERE d.kind = 'review_bounty'
            AND d.staff_review_id = r.id
            AND d.removed_at IS NULL
       ) bl ON TRUE
      GROUP BY r.id, bl.lock
      ORDER BY (r.status = 'pending') DESC, r.review_date DESC, r.id DESC
      LIMIT $1`,
    [LIST_LIMIT]
  );
  // The hub's footer reads the bounty and the all-time totals off this
  // envelope, so no client carries a money literal. All-time by design: the
  // list itself is capped at LIST_LIMIT.
  //
  // removed_at IS NULL is the payable filter (payrollProcessing.js:29-38): a
  // bounty line un-credited or dismissed is soft-removed and pays nothing, so
  // counting it here would overstate the money that actually went out.
  const totals = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM staff_reviews)::int AS total_logged,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM payout_duty_lines
        WHERE kind = 'review_bounty' AND removed_at IS NULL)::int AS bounties_paid_cents
  `);
  res.json({
    reviews: rows,
    bounty_cents: REVIEW_BOUNTY_CENTS,
    bounties_paid_cents: totals.rows[0].bounties_paid_cents,
    total_logged: totals.rows[0].total_logged,
  });
}));

// POST /staff-reviews — manual Google row. Google reviews carry no external
// key, so dedup is admin judgment: the response flags a same-date Thumbtack
// row rather than refusing (spec §7).
router.post('/staff-reviews', auth, adminOnly, asyncHandler(async (req, res) => {
  const reviewDate = req.body.review_date;
  const stars = Number(req.body.stars);
  const excerpt = req.body.excerpt === null || req.body.excerpt === undefined
    ? null : String(req.body.excerpt);
  const proposalId = req.body.proposal_id === null || req.body.proposal_id === undefined
    ? null : Number(req.body.proposal_id);
  if (!validYmd(reviewDate)) throw new ValidationError(null, 'review_date must be a valid YYYY-MM-DD date');
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new ValidationError(null, 'stars must be an integer from 1 to 5');
  }
  if (excerpt !== null && excerpt.length > MAX_EXCERPT_CHARS) {
    throw new ValidationError(null, `excerpt exceeds ${MAX_EXCERPT_CHARS} chars`);
  }
  if (proposalId !== null && !Number.isInteger(proposalId)) {
    throw new ValidationError(null, 'proposal_id must be an integer');
  }

  const dup = await pool.query(
    `SELECT 1 FROM staff_reviews WHERE source = 'thumbtack' AND review_date = $1 LIMIT 1`,
    [reviewDate]
  );
  const ins = await pool.query(
    `INSERT INTO staff_reviews (review_date, stars, source, excerpt, proposal_id, status, created_by)
     VALUES ($1, $2, 'google', $3, $4, 'pending', $5)
     RETURNING *`,
    [reviewDate, stars, excerpt, proposalId, req.user.id]
  );
  await logAdminAction({
    actorUserId: req.user.id, targetUserId: null,
    action: 'staff_review_create',
    metadata: { staff_review_id: ins.rows[0].id, review_date: reviewDate, stars, source: 'google' },
  });
  res.json({
    review: { ...ins.rows[0], credits: [] },
    duplicate_warning: dup.rowCount > 0,
  });
}));

// PATCH /staff-reviews/:id — edit the review AND set its credits (replace-style).
// Un-crediting a staffer whose bounty already materialized: system-remove the
// line while the period is open; once frozen, alert only and never write
// (spec §7 / §3.2).
router.patch('/staff-reviews/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ValidationError(null, 'invalid review id');

  const hasStars = 'stars' in req.body;
  const hasExcerpt = 'excerpt' in req.body;
  const hasProposal = 'proposal_id' in req.body;
  const hasCredits = 'credited_user_ids' in req.body;
  if (!hasStars && !hasExcerpt && !hasProposal && !hasCredits) {
    throw new ValidationError(null, 'no editable fields supplied');
  }

  let stars = null;
  if (hasStars) {
    stars = Number(req.body.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      throw new ValidationError(null, 'stars must be an integer from 1 to 5');
    }
  }
  let excerpt;
  if (hasExcerpt) {
    excerpt = req.body.excerpt === null || req.body.excerpt === undefined
      ? null : String(req.body.excerpt);
    if (excerpt !== null && excerpt.length > MAX_EXCERPT_CHARS) {
      throw new ValidationError(null, `excerpt exceeds ${MAX_EXCERPT_CHARS} chars`);
    }
  }
  let proposalId;
  if (hasProposal) {
    proposalId = req.body.proposal_id === null || req.body.proposal_id === undefined
      ? null : Number(req.body.proposal_id);
    if (proposalId !== null && !Number.isInteger(proposalId)) {
      throw new ValidationError(null, 'proposal_id must be an integer');
    }
  }
  let creditIds = null;
  if (hasCredits) {
    const raw = req.body.credited_user_ids;
    if (!Array.isArray(raw)) throw new ValidationError(null, 'credited_user_ids must be an array');
    creditIds = [...new Set(raw.map(Number))];
    if (creditIds.some((n) => !Number.isInteger(n))) {
      throw new ValidationError(null, 'credited_user_ids must be integers');
    }
  }

  const client = await pool.connect();
  let out;
  let starsBefore = null;
  try {
    await client.query('BEGIN');
    const pin = await client.query('SELECT * FROM staff_reviews WHERE id = $1 FOR UPDATE', [id]);
    if (!pin.rows[0]) throw new NotFoundError('staff review not found');
    starsBefore = Number(pin.rows[0].stars);

    // Stars is the money trigger and nothing reconciles it after the bounties
    // have been paid: a 5 downgraded to a 4 would leave live lines behind. So
    // stars is frozen once confirmed; the correction path is dismiss + re-log.
    if (hasStars && pin.rows[0].status === 'confirmed') {
      throw new ConflictError('stars cannot change on a confirmed review; dismiss it and log the review again');
    }

    if (hasStars || hasExcerpt || hasProposal) {
      await client.query(
        `UPDATE staff_reviews
            SET stars = CASE WHEN $2 THEN $3 ELSE stars END,
                excerpt = CASE WHEN $4 THEN $5 ELSE excerpt END,
                proposal_id = CASE WHEN $6 THEN $7 ELSE proposal_id END
          WHERE id = $1`,
        [id, hasStars, stars, hasExcerpt, excerpt ?? null, hasProposal, proposalId ?? null]
      );
    }

    const frozenCreditRemovals = [];
    let removedLines = 0;
    let restoredLines = 0;
    let materializedLines = 0;
    if (creditIds) {
      if (creditIds.length) {
        // Only people who can actually be paid may be credited. Admins stay
        // creditable BY DESIGN: the owner works events and earns bounties like
        // anyone else. Everyone else must be an onboarded staffer, matching the
        // active-staff roster the tagging UI offers.
        const known = await client.query(
          `SELECT u.id
             FROM users u
             LEFT JOIN onboarding_progress op ON op.user_id = u.id
            WHERE u.id = ANY($1)
              AND (u.role = 'admin'
                   OR (u.onboarding_status IN ('approved', 'reviewed', 'submitted')
                       AND op.onboarding_completed = true))`,
          [creditIds]
        );
        if (known.rowCount !== creditIds.length) {
          throw new ValidationError(null, 'credited_user_ids contains a user who is not an active staffer');
        }
      }
      const current = await client.query(
        'SELECT user_id FROM staff_review_credits WHERE staff_review_id = $1', [id]
      );
      const currentIds = current.rows.map((r) => Number(r.user_id));
      const dropped = currentIds.filter((uid) => !creditIds.includes(uid));
      const added = creditIds.filter((uid) => !currentIds.includes(uid));

      if (dropped.length) {
        await client.query(
          'DELETE FROM staff_review_credits WHERE staff_review_id = $1 AND user_id = ANY($2)',
          [id, dropped]
        );
      }
      for (const uid of added) {
        await client.query(
          `INSERT INTO staff_review_credits (staff_review_id, user_id) VALUES ($1, $2)
           ON CONFLICT (staff_review_id, user_id) DO NOTHING`,
          [id, uid]
        );
      }

      // Un-credited staffers: reverse the bounty while the money is still open.
      for (const uid of dropped) {
        const [line] = await pinBountyLines(client, id, uid);
        if (!line || line.removed_at) continue;
        if (isFrozen(line)) {
          frozenCreditRemovals.push({
            contractor_id: uid, duty_line_id: line.id, payout_id: line.payout_id,
          });
          continue;
        }
        await client.query(
          `UPDATE payout_duty_lines
              SET removed_at = NOW(), removed_by = NULL, note = 'credit removed', updated_at = NOW()
            WHERE id = $1`,
          [line.id]
        );
        await recomputePayoutTotal(client, line.payout_id);
        removedLines += 1;
      }

      // A credit ADDED to a review that already pays must pay immediately:
      // re-crediting revives the system tombstone (spec §3.2), and a name added
      // after confirm materializes a fresh line. Gated on the review actually
      // paying, so a dismissed or 4-star review can never be made to pay here.
      if (paysBounties(pin.rows[0].status, pin.rows[0].stars)) {
        for (const uid of added) {
          const settled = await settleBounty(client, id, uid);
          if (settled === 'restored') restoredLines += 1;
          if (settled === 'materialized') materializedLines += 1;
        }
      }
    }

    const review = await loadReview(client, id);
    await client.query('COMMIT');
    out = { review, frozenCreditRemovals, removedLines, restoredLines, materializedLines };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }

  for (const f of out.frozenCreditRemovals) {
    Sentry.captureMessage('staff review credit removed while its bounty line is frozen', {
      level: 'warning',
      tags: { area: 'duty_pay', kind: 'review_bounty' },
      extra: { staff_review_id: id, ...f },
    });
    console.warn(
      `[staffReviews] credit removed on review ${id} for user ${f.contractor_id} but duty line ${f.duty_line_id} is paid or frozen; no clawback written`
    );
  }
  await logAdminAction({
    actorUserId: req.user.id, targetUserId: null,
    action: 'staff_review_update',
    metadata: {
      staff_review_id: id,
      credited_user_ids: creditIds,
      stars_before: starsBefore,
      stars_after: hasStars ? stars : starsBefore,
      removed_lines: out.removedLines,
      restored_lines: out.restoredLines,
      materialized_lines: out.materializedLines,
      frozen_credit_removals: out.frozenCreditRemovals,
    },
  });
  res.json({
    review: out.review,
    removed_lines: out.removedLines,
    restored_lines: out.restoredLines,
    materialized_lines: out.materializedLines,
    frozen_credit_removals: out.frozenCreditRemovals,
  });
}));

// POST /staff-reviews/:id/confirm — the money moment. One held client, one
// transaction: flip the status, materialize each credited staffer's bounty
// (5 stars only), then run the catch-up pass for anything that was waiting on
// an open period.
router.post('/staff-reviews/:id/confirm', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ValidationError(null, 'invalid review id');

  const client = await pool.connect();
  let out;
  try {
    await client.query('BEGIN');
    const pin = await client.query('SELECT * FROM staff_reviews WHERE id = $1 FOR UPDATE', [id]);
    if (!pin.rows[0]) throw new NotFoundError('staff review not found');
    await client.query("UPDATE staff_reviews SET status = 'confirmed' WHERE id = $1", [id]);

    const stars = Number(pin.rows[0].stars);
    const credits = await client.query(
      'SELECT user_id FROM staff_review_credits WHERE staff_review_id = $1 ORDER BY user_id', [id]
    );
    const creditedUserIds = credits.rows.map((r) => Number(r.user_id));
    let materialized = 0;
    let restored = 0;
    if (stars === 5) {
      // settleBounty, not a bare materialize: a dismissed-then-re-confirmed
      // review (or a re-credited staffer) already carries a system tombstone,
      // and INSERT ... ON CONFLICT DO NOTHING would hit it and pay nothing.
      for (const uid of creditedUserIds) {
        const settled = await settleBounty(client, id, uid);
        if (settled === 'restored') restored += 1;
        if (settled === 'materialized') materialized += 1;
      }
    }
    // Catch-up: anything confirmed while no period was open (spec §3.2).
    const catchUp = await materializePendingReviewLines(client);
    const review = await loadReview(client, id);
    await client.query('COMMIT');
    out = {
      body: {
        review,
        materialized,
        restored,
        catch_up_materialized: catchUp.materialized,
      },
      audit: {
        staff_review_id: id,
        stars,
        credited_user_ids: creditedUserIds,
        materialized,
        restored,
      },
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
  await logAdminAction({
    actorUserId: req.user.id, targetUserId: null,
    action: 'staff_review_confirm', metadata: out.audit,
  });
  res.json(out.body);
}));

// POST /staff-reviews/:id/dismiss — refuse while any bounty for this review is
// paid or frozen; otherwise system-remove the open ones and dismiss.
router.post('/staff-reviews/:id/dismiss', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ValidationError(null, 'invalid review id');

  const client = await pool.connect();
  let out;
  try {
    await client.query('BEGIN');
    const pin = await client.query('SELECT * FROM staff_reviews WHERE id = $1 FOR UPDATE', [id]);
    if (!pin.rows[0]) throw new NotFoundError('staff review not found');

    const lines = await pinBountyLines(client, id);
    const active = lines.filter((l) => !l.removed_at);
    // Say which state, not "already paid" for all three. A period that is only
    // PROCESSING has not paid anyone yet, and an admin told otherwise goes
    // looking for money that has not moved.
    const lock = reviewLockOf(lines);
    if (lock) {
      throw new ConflictError(lock === 'paid'
        ? 'a review bounty for this review is already paid; dismiss is refused'
        : 'a review bounty for this review is in a pay run that is processing; dismiss is refused until it finishes');
    }
    let removedLines = 0;
    for (const line of active) {
      await client.query(
        `UPDATE payout_duty_lines
            SET removed_at = NOW(), removed_by = NULL, note = 'review dismissed', updated_at = NOW()
          WHERE id = $1`,
        [line.id]
      );
      await recomputePayoutTotal(client, line.payout_id);
      removedLines += 1;
    }
    await client.query("UPDATE staff_reviews SET status = 'dismissed' WHERE id = $1", [id]);
    const review = await loadReview(client, id);
    await client.query('COMMIT');
    out = { body: { review, removed_lines: removedLines }, audit: { staff_review_id: id, removed_lines: removedLines } };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
  await logAdminAction({
    actorUserId: req.user.id, targetUserId: null,
    action: 'staff_review_dismiss', metadata: out.audit,
  });
  res.json(out.body);
}));

module.exports = router;
