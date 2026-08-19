/**
 * Route-level tests for the staff-review surface (spec 2026-08-06 §7).
 * Express-over-HTTP + JWT harness copied from payrollDuty.test.js.
 *
 * Shared dev DB: owns a UNIQUE far-past fixture week (Tue 2018-11-06 .. Mon
 * 2018-11-12, all inside 2018-Q4) and 'srev-%@example.com' users. Review money
 * always materializes into the CURRENT open period (materializeReviewLine
 * calls findOpenPeriodForDate(chicagoTodayYmd())), so today's real period is
 * tracked-and-restored the way dutyLines.test.js does it, and its status is
 * the knob the "no open period" test turns.
 *
 * Run ALONE: node -r dotenv/config --test server/routes/admin/staffReviews.test.js
 */
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false'; // never fire real email/SMS from this suite
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { payPeriodForDate, computePayday } = require('../../utils/payrollPeriods');
const { chicagoTodayYmd } = require('../../utils/businessTime');
const { materializePendingReviewLines } = require('../../utils/dutyLines');
const staffReviewsRouter = require('./staffReviews');
const staffReviewsContestRouter = require('./staffReviewsContest');
const thumbtackRouter = require('../thumbtack');

if (process.env.NODE_ENV === 'production') {
  throw new Error('staffReviews.test.js refuses to run against production');
}

let adminId, adminToken, server, baseUrl;
let aId, bId, cId, dId, strangerId;
let todayPeriodId, todayPeriodPreExisted = false, todayPeriodOrigStatus = null;
let pairReviewId; // the two-credit review that the bounty tests drive

const EMAILS = "email LIKE 'srev-%@example.com'";
const TT_KEY = 'srev-tt-1';
const WEEK_START = '2018-11-06';
const QUARTER = '2018-Q4';

async function preClean() {
  const userSel = `SELECT id FROM users WHERE ${EMAILS}`;
  const reviewSel = `SELECT id FROM staff_reviews
                      WHERE tt_review_id LIKE 'srev-tt-%'
                         OR excerpt LIKE 'srev-fixture%'
                         OR created_by IN (${userSel})`;
  await pool.query(
    `DELETE FROM payout_duty_lines
      WHERE contractor_id IN (${userSel})
         OR staff_review_id IN (${reviewSel})
         OR contest_quarter = '${QUARTER}'`
  );
  await pool.query(`DELETE FROM staff_review_credits WHERE user_id IN (${userSel})`);
  await pool.query(`DELETE FROM staff_reviews WHERE id IN (${reviewSel})`);
  await pool.query(`DELETE FROM thumbtack_reviews WHERE review_id LIKE 'srev-tt-%'`);
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN (${userSel}))`);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN (${userSel})`);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN (${userSel})`);
  await pool.query(`DELETE FROM shifts WHERE proposal_id IN (SELECT id FROM proposals WHERE event_type = 'srev-fixture')`);
  await pool.query(`DELETE FROM proposals WHERE event_type = 'srev-fixture'`);
  await pool.query(
    `DELETE FROM pay_periods
      WHERE start_date = '${WEEK_START}'
        AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pay_periods.id)`
  );
  await pool.query(`DELETE FROM admin_audit_log WHERE actor_user_id IN (${userSel})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (${userSel})`);
  await pool.query(`DELETE FROM onboarding_progress WHERE user_id IN (${userSel})`);
  await pool.query(`DELETE FROM users WHERE ${EMAILS}`);
}

before(async () => {
  await preClean();

  // Track-and-restore today's real period (dutyLines.test.js hooks). Review
  // money lands HERE, not in the far-past fixture week.
  //
  // Deviation from dutyLines.test.js, deliberate: that suite looks the period
  // up by `start_date = payPeriodForDate(today)`, which on a dev DB whose live
  // period does not sit on the canonical week boundary INSERTS a second,
  // overlapping open period. findOpenPeriodForDate then resolves by date
  // coverage (ORDER BY start_date DESC), so the suite would fight the
  // materializer over which period is "today". Adopt whatever period covers
  // today by the same rule the materializer uses, and only fall back to
  // creating the canonical week when nothing covers today at all.
  const { startDate, endDate } = payPeriodForDate(chicagoTodayYmd());
  const payday = computePayday(endDate);
  const existing = await pool.query(
    `SELECT id, status FROM pay_periods
      WHERE $1::date BETWEEN start_date AND end_date
      ORDER BY start_date DESC LIMIT 1`,
    [chicagoTodayYmd()]
  );
  if (existing.rows[0]) {
    todayPeriodId = existing.rows[0].id;
    todayPeriodPreExisted = true;
    todayPeriodOrigStatus = existing.rows[0].status;
    if (todayPeriodOrigStatus !== 'open') {
      await pool.query("UPDATE pay_periods SET status='open' WHERE id = $1", [todayPeriodId]);
    }
  } else {
    const r = await pool.query(
      `INSERT INTO pay_periods (start_date, end_date, payday, status)
       VALUES ($1, $2, $3, 'open') RETURNING id`,
      [startDate, endDate, payday]
    );
    todayPeriodId = r.rows[0].id;
  }

  // Claim the far-past fixture week so no other suite reuses it.
  await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, '2018-11-12', '2018-11-13', 'open')
     ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START]
  );

  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('srev-admin@example.com','x','admin') RETURNING id"
  );
  adminId = u.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const mk = async (email) => (await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1,'x','staff') RETURNING id`, [email]
  )).rows[0].id;
  aId = await mk('srev-a@example.com');
  bId = await mk('srev-b@example.com');
  cId = await mk('srev-c@example.com');
  dId = await mk('srev-d@example.com');
  for (const uid of [aId, bId, cId, dId]) {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
       ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
      [uid]
    );
    // Credit eligibility now requires an onboarded staffer (or an admin), so
    // the fixtures must look like real active staff.
    await pool.query(
      `INSERT INTO onboarding_progress (user_id, onboarding_completed) VALUES ($1, true)
       ON CONFLICT (user_id) DO UPDATE SET onboarding_completed = true`,
      [uid]
    );
    await pool.query("UPDATE users SET onboarding_status = 'approved' WHERE id = $1", [uid]);
  }
  // A staffer who never finished onboarding: never creditable.
  strangerId = await mk('srev-stranger@example.com');

  const app = express();
  app.use(express.json());
  // Same order as routes/admin/index.js: contest first, review log second.
  app.use('/api/admin', staffReviewsContestRouter);
  app.use('/api/admin', staffReviewsRouter);
  app.use('/api/thumbtack', thumbtackRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(r => server.close(r));
  await preClean();
  if (todayPeriodPreExisted) {
    await pool.query('UPDATE pay_periods SET status = $1 WHERE id = $2', [todayPeriodOrigStatus, todayPeriodId]);
  } else {
    await pool.query(
      'DELETE FROM pay_periods WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = $1)',
      [todayPeriodId]
    );
  }
  await pool.end();
});

function req(method, path, token, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(extraHeaders || {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const ttHeaders = () => (process.env.THUMBTACK_WEBHOOK_SECRET
  ? { 'x-thumbtack-secret': process.env.THUMBTACK_WEBHOOK_SECRET }
  : {});

async function setTodayPeriod(status) {
  await pool.query('UPDATE pay_periods SET status = $1 WHERE id = $2', [status, todayPeriodId]);
}

async function bountyLine(staffReviewId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM payout_duty_lines
      WHERE kind = 'review_bounty' AND staff_review_id = $1 AND contractor_id = $2`,
    [staffReviewId, userId]
  );
  return rows[0] || null;
}

async function payoutTotal(userId) {
  const { rows } = await pool.query(
    'SELECT total_cents FROM payouts WHERE pay_period_id = $1 AND contractor_id = $2',
    [todayPeriodId, userId]
  );
  return rows[0] ? Number(rows[0].total_cents) : null;
}

async function makeReview({ stars, credits, status = 'pending', reviewDate = null }) {
  const r = await pool.query(
    `INSERT INTO staff_reviews (review_date, stars, source, excerpt, status, created_by)
     VALUES (COALESCE($1::date, CURRENT_DATE), $2, 'google', 'srev-fixture review', $3, $4)
     RETURNING id`,
    [reviewDate, stars, status, adminId]
  );
  const id = r.rows[0].id;
  for (const uid of credits) {
    await pool.query(
      'INSERT INTO staff_review_credits (staff_review_id, user_id) VALUES ($1,$2)', [id, uid]
    );
  }
  return id;
}

// ─── Task 16 ──────────────────────────────────────────────────────

test('TT webhook replay creates exactly one staff_reviews row', async () => {
  const payload = {
    event: 'review.created',
    data: {
      reviewID: TT_KEY,
      negotiationID: 'srev-neg-1',
      rating: 5,
      reviewText: 'srev-fixture Ada was dope behind the bar',
      reviewerName: 'Fixture Guest',
    },
  };
  const first = await req('POST', '/api/thumbtack/reviews', null, payload, ttHeaders());
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.status, 'ok');

  const replay = await req('POST', '/api/thumbtack/reviews', null, payload, ttHeaders());
  assert.equal(replay.status, 200);
  assert.equal(replay.body.status, 'duplicate', 'the existing replay early-return still fires');

  const rows = await pool.query(
    `SELECT id, stars, source, status, excerpt, review_date::text AS review_date
       FROM staff_reviews WHERE tt_review_id = $1`, [TT_KEY]
  );
  assert.equal(rows.rowCount, 1, 'exactly one staff_reviews row survives the replay');
  assert.equal(rows.rows[0].stars, 5);
  assert.equal(rows.rows[0].source, 'thumbtack');
  assert.equal(rows.rows[0].status, 'pending');
  assert.match(rows.rows[0].excerpt, /Ada was dope/);
  // Chicago date, not the UTC CURRENT_DATE: an evening review must not book
  // itself onto tomorrow (and out of its own quarter).
  assert.equal(rows.rows[0].review_date, chicagoTodayYmd());

  // The ON CONFLICT (tt_review_id) guard itself, exercised directly: even if
  // the thumbtack_reviews early-return were bypassed, no second row appears.
  await pool.query(
    `INSERT INTO staff_reviews (review_date, stars, source, tt_review_id, excerpt, status)
     VALUES (CURRENT_DATE, 5, 'thumbtack', $1, 'srev-fixture dupe attempt', 'pending')
     ON CONFLICT (tt_review_id) DO NOTHING`,
    [TT_KEY]
  );
  const after2 = await pool.query('SELECT COUNT(*)::int AS n FROM staff_reviews WHERE tt_review_id = $1', [TT_KEY]);
  assert.equal(after2.rows[0].n, 1);
});

test('GET list is pending-first and carries credits; manual create validates and warns on a same-date TT row', async () => {
  let r = await req('POST', '/api/admin/staff-reviews', adminToken, {
    review_date: '2026-13-45', stars: 5, excerpt: 'srev-fixture bad date',
  });
  assert.equal(r.status, 400, 'invalid date refused');
  r = await req('POST', '/api/admin/staff-reviews', adminToken, {
    review_date: '2026-01-15', stars: 6, excerpt: 'srev-fixture bad stars',
  });
  assert.equal(r.status, 400, 'stars out of 1..5 refused');
  r = await req('POST', '/api/admin/staff-reviews', adminToken, {
    review_date: '2026-01-15', stars: 5, excerpt: `srev-fixture${'x'.repeat(2100)}`,
  });
  assert.equal(r.status, 400, 'excerpt over 2000 chars refused');

  // The TT row above is dated CURRENT_DATE, so a same-date Google row warns.
  const today = chicagoTodayYmd();
  r = await req('POST', '/api/admin/staff-reviews', adminToken, {
    review_date: today, stars: 5, excerpt: 'srev-fixture google same day',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.duplicate_warning, true, 'a thumbtack row shares this review_date');
  assert.equal(r.body.review.source, 'google');
  assert.equal(r.body.review.status, 'pending');

  r = await req('POST', '/api/admin/staff-reviews', adminToken, {
    review_date: '2019-03-04', stars: 4, excerpt: 'srev-fixture no clash',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.duplicate_warning, false);

  const list = await req('GET', '/api/admin/staff-reviews', adminToken);
  assert.equal(list.status, 200);
  const mine = list.body.reviews.filter(x => (x.excerpt || '').startsWith('srev-fixture'));
  assert.ok(mine.length >= 3);
  assert.ok(Array.isArray(mine[0].credits), 'credits ride the list payload');
});

test('confirm with NO open period leaves it confirmed-unmaterialized; the catch-up pass pays it later', async () => {
  await setTodayPeriod('processing');
  const reviewId = await makeReview({ stars: 5, credits: [cId] });

  const r = await req('POST', `/api/admin/staff-reviews/${reviewId}/confirm`, adminToken, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.review.status, 'confirmed');
  assert.equal(r.body.materialized, 0, 'no open period, so nothing materializes');
  assert.equal(await bountyLine(reviewId, cId), null);

  // Period opens: the catch-up pass finds the waiting credit (spec §3.2).
  await setTodayPeriod('open');
  const client = await pool.connect();
  try {
    const out = await materializePendingReviewLines(client);
    assert.ok(out.materialized >= 1, 'catch-up materialized the waiting bounty');
  } finally {
    client.release();
  }
  const line = await bountyLine(reviewId, cId);
  assert.ok(line, 'the confirmed review paid once a period opened');
  assert.equal(Number(line.amount_cents), 1000);
  assert.equal(line.origin, 'auto');
});

test('confirm pays each credited staffer exactly once; a double-confirm cannot double-pay', async () => {
  pairReviewId = await makeReview({ stars: 5, credits: [aId, bId] });

  let r = await req('POST', `/api/admin/staff-reviews/${pairReviewId}/confirm`, adminToken, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.materialized, 2, 'both named staffers paid');
  assert.equal(Number((await bountyLine(pairReviewId, aId)).amount_cents), 1000);
  assert.equal(Number((await bountyLine(pairReviewId, bId)).amount_cents), 1000);
  const aTotal = await payoutTotal(aId);
  assert.ok(aTotal >= 1000, 'the payout total includes the bounty');

  r = await req('POST', `/api/admin/staff-reviews/${pairReviewId}/confirm`, adminToken, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.materialized, 0, 'UNIQUE(staff_review_id, contractor_id) blocks the second pay');
  assert.equal(r.body.catch_up_materialized, 0);
  const count = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payout_duty_lines
      WHERE kind = 'review_bounty' AND staff_review_id = $1`, [pairReviewId]
  );
  assert.equal(count.rows[0].n, 2, 'still exactly two lines');
  assert.equal(await payoutTotal(aId), aTotal, 'total unmoved by the re-confirm');
});

test('a 4-star confirm pays nothing', async () => {
  const reviewId = await makeReview({ stars: 4, credits: [dId] });
  const r = await req('POST', `/api/admin/staff-reviews/${reviewId}/confirm`, adminToken, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.materialized, 0);
  assert.equal(r.body.review.status, 'confirmed');
  assert.equal(await bountyLine(reviewId, dId), null, '4 stars count for nothing');
});

test('un-crediting removes the open-period line and the payout total drops', async () => {
  const before = await payoutTotal(bId);
  const r = await req('PATCH', `/api/admin/staff-reviews/${pairReviewId}`, adminToken, {
    credited_user_ids: [aId],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.removed_lines, 1);
  assert.equal(r.body.frozen_credit_removals.length, 0);
  assert.deepEqual(r.body.review.credits.map(c => c.user_id), [aId]);

  const line = await bountyLine(pairReviewId, bId);
  assert.ok(line.removed_at, 'the line is system-removed, never deleted');
  assert.equal(line.removed_by, null, 'system removal carries a NULL actor');
  assert.equal(line.note, 'credit removed');
  assert.equal(await payoutTotal(bId), before - 1000, 'the total dropped by the bounty');
});

test('un-crediting a PAID bounty alerts and writes nothing', async () => {
  const payout = await pool.query(
    'SELECT id, total_cents FROM payouts WHERE pay_period_id = $1 AND contractor_id = $2',
    [todayPeriodId, aId]
  );
  const before = Number(payout.rows[0].total_cents);
  await pool.query("UPDATE payouts SET status = 'paid' WHERE id = $1", [payout.rows[0].id]);

  const r = await req('PATCH', `/api/admin/staff-reviews/${pairReviewId}`, adminToken, {
    credited_user_ids: [],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.removed_lines, 0, 'no clawback is ever written after payment');
  assert.equal(r.body.frozen_credit_removals.length, 1);
  assert.equal(r.body.frozen_credit_removals[0].contractor_id, aId);

  const line = await bountyLine(pairReviewId, aId);
  assert.equal(line.removed_at, null, 'the paid line is untouched');
  assert.equal(Number((await pool.query('SELECT total_cents FROM payouts WHERE id = $1', [payout.rows[0].id])).rows[0].total_cents), before);

  await pool.query("UPDATE payouts SET status = 'pending' WHERE id = $1", [payout.rows[0].id]);
});

test('dismiss refuses while a bounty is paid, and system-removes open ones otherwise', async () => {
  const payout = await pool.query(
    'SELECT id FROM payouts WHERE pay_period_id = $1 AND contractor_id = $2', [todayPeriodId, aId]
  );
  await pool.query("UPDATE payouts SET status = 'paid' WHERE id = $1", [payout.rows[0].id]);
  let r = await req('POST', `/api/admin/staff-reviews/${pairReviewId}/dismiss`, adminToken, {});
  assert.equal(r.status, 409, 'a paid bounty blocks dismissal');
  await pool.query("UPDATE payouts SET status = 'pending' WHERE id = $1", [payout.rows[0].id]);

  const before = await payoutTotal(aId);
  r = await req('POST', `/api/admin/staff-reviews/${pairReviewId}/dismiss`, adminToken, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.review.status, 'dismissed');
  assert.equal(r.body.removed_lines, 1);
  assert.equal(await payoutTotal(aId), before - 1000);
});

test('re-crediting a DISMISSED review pays nothing; re-confirming revives the tombstone', async () => {
  // pairReviewId is dismissed and aId's bounty is a system tombstone.
  const before = await payoutTotal(aId);
  let r = await req('PATCH', `/api/admin/staff-reviews/${pairReviewId}`, adminToken, {
    credited_user_ids: [aId],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.restored_lines, 0, 'a dismissed review can never be made to pay by re-crediting');
  assert.equal(r.body.materialized_lines, 0);
  assert.ok((await bountyLine(pairReviewId, aId)).removed_at, 'the tombstone stands');
  assert.equal(await payoutTotal(aId), before, 'total unmoved');

  // Re-confirm revives it. A bare materializeReviewLine would ON CONFLICT DO
  // NOTHING against the tombstone here and silently pay nothing.
  r = await req('POST', `/api/admin/staff-reviews/${pairReviewId}/confirm`, adminToken, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.restored, 1);
  assert.equal(r.body.materialized, 0);
  assert.equal((await bountyLine(pairReviewId, aId)).removed_at, null);
  assert.equal(await payoutTotal(aId), before + 1000, 'the money came back');
});

test('a credit added to an already-confirmed 5-star review pays without a re-confirm', async () => {
  const before = await payoutTotal(dId);
  const r = await req('PATCH', `/api/admin/staff-reviews/${pairReviewId}`, adminToken, {
    credited_user_ids: [aId, dId],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.materialized_lines, 1, 'the newly named staffer is paid on the spot');
  const line = await bountyLine(pairReviewId, dId);
  assert.ok(line, 'a fresh bounty line exists');
  assert.equal(Number(line.amount_cents), 1000);
  assert.equal(await payoutTotal(dId), (before || 0) + 1000);
});

test('stars cannot change on a confirmed review, but an unconfirmed one edits freely', async () => {
  let r = await req('PATCH', `/api/admin/staff-reviews/${pairReviewId}`, adminToken, { stars: 4 });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /dismiss/i);
  const row = await pool.query('SELECT stars FROM staff_reviews WHERE id = $1', [pairReviewId]);
  assert.equal(Number(row.rows[0].stars), 5, 'the money trigger is untouched');

  const pending = await makeReview({ stars: 3, credits: [] });
  r = await req('PATCH', `/api/admin/staff-reviews/${pending}`, adminToken, { stars: 5 });
  assert.equal(r.status, 200);
  assert.equal(Number(r.body.review.stars), 5);
});

test('a confirmed 4-star review never pays however its credits are edited', async () => {
  const reviewId = await makeReview({ stars: 4, credits: [] });
  await req('POST', `/api/admin/staff-reviews/${reviewId}/confirm`, adminToken, {});
  const r = await req('PATCH', `/api/admin/staff-reviews/${reviewId}`, adminToken, {
    credited_user_ids: [cId],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.materialized_lines, 0, 'four stars carry no bounty');
  assert.equal(await bountyLine(reviewId, cId), null);
});

test('credits are limited to onboarded staff; admins stay creditable by design', async () => {
  const reviewId = await makeReview({ stars: 5, credits: [] });
  let r = await req('PATCH', `/api/admin/staff-reviews/${reviewId}`, adminToken, {
    credited_user_ids: [strangerId],
  });
  assert.equal(r.status, 400, 'a user who never onboarded cannot be credited');
  assert.match(r.body.error, /active staffer/);

  // The owner works events too, so an admin is creditable on purpose.
  r = await req('PATCH', `/api/admin/staff-reviews/${reviewId}`, adminToken, {
    credited_user_ids: [adminId],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.review.credits.map(c => c.user_id), [adminId]);
});

test('every mutation audit-logs, with the money-relevant fields', async () => {
  const { rows } = await pool.query(
    `SELECT DISTINCT action FROM admin_audit_log WHERE actor_user_id = $1`, [adminId]
  );
  const actions = rows.map(r => r.action);
  for (const expected of [
    'staff_review_create', 'staff_review_update', 'staff_review_confirm', 'staff_review_dismiss',
  ]) {
    assert.ok(actions.includes(expected), `audit log carries ${expected}`);
  }

  const confirmMeta = await pool.query(
    `SELECT metadata FROM admin_audit_log
      WHERE actor_user_id = $1 AND action = 'staff_review_confirm' ORDER BY id DESC LIMIT 1`,
    [adminId]
  );
  assert.ok(
    Array.isArray(confirmMeta.rows[0].metadata.credited_user_ids),
    'the confirm audit records exactly who was credited at pay time'
  );

  const updateMeta = await pool.query(
    `SELECT metadata FROM admin_audit_log
      WHERE actor_user_id = $1 AND action = 'staff_review_update' ORDER BY id DESC LIMIT 1`,
    [adminId]
  );
  assert.ok('stars_before' in updateMeta.rows[0].metadata);
  assert.ok('stars_after' in updateMeta.rows[0].metadata);
});

// ─── Task 17 ──────────────────────────────────────────────────────

// Quarter fixtures, all inside 2018-Q4 (the far-past fixture week):
//   A: 4 events, 2 confirmed 5-stars  -> rate 0.50, eligible
//   B: 4 events, 2 confirmed 5-stars  -> rate 0.50, eligible (ties A)
//   C: 4 events, 1 confirmed + 1 PENDING 5-star -> 1 named, below the floor
//   D: 2 events, 2 confirmed 5-stars  -> rate 1.00 but below the events floor
async function seedQuarter() {
  const shiftIds = [];
  for (const day of ['2018-11-06', '2018-11-07', '2018-11-08', '2018-11-09']) {
    const pr = await pool.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                              event_duration_hours, total_price, amount_paid)
       VALUES (NULL, $1, 'completed', 'srev-fixture', '6:00 PM', 4, 500, 500) RETURNING id`,
      [day]
    );
    const s = await pool.query(
      `INSERT INTO shifts (event_date, start_time, status, proposal_id)
       VALUES ($1,'6:00 PM','open',$2) RETURNING id`,
      [day, pr.rows[0].id]
    );
    shiftIds.push(s.rows[0].id);
  }
  const approve = async (shiftId, uid) => pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [shiftId, uid]
  );
  for (const sid of shiftIds) {
    await approve(sid, aId);
    await approve(sid, bId);
    await approve(sid, cId);
  }
  await approve(shiftIds[0], dId);
  await approve(shiftIds[1], dId);
  // A dropped request must never count as an event worked.
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status, dropped_at)
     VALUES ($1,$2,'Bartender','approved', NOW())`,
    [shiftIds[2], dId]
  );

  const q = '2018-11-10';
  await makeReview({ stars: 5, credits: [aId, bId], status: 'confirmed', reviewDate: q });
  await makeReview({ stars: 5, credits: [aId, bId], status: 'confirmed', reviewDate: q });
  await makeReview({ stars: 5, credits: [cId], status: 'confirmed', reviewDate: q });
  await makeReview({ stars: 5, credits: [cId], status: 'pending', reviewDate: q });
  await makeReview({ stars: 4, credits: [aId], status: 'confirmed', reviewDate: q });
  await makeReview({ stars: 5, credits: [dId], status: 'confirmed', reviewDate: q });
  await makeReview({ stars: 5, credits: [dId], status: 'confirmed', reviewDate: q });
}

test('leaderboard: floors filter, only CONFIRMED 5-stars count, eligible-first by rate', async () => {
  await seedQuarter();

  let r = await req('GET', '/api/admin/staff-reviews/leaderboard?quarter=nope', adminToken);
  assert.equal(r.status, 400, 'quarter shape validated');

  r = await req('GET', `/api/admin/staff-reviews/leaderboard?quarter=${QUARTER}`, adminToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.start_date, '2018-10-01');
  assert.equal(r.body.end_date, '2018-12-31');
  assert.equal(r.body.pot_cents, 10000);

  const byId = Object.fromEntries(r.body.rows.map(x => [x.user_id, x]));
  assert.deepEqual(
    [byId[aId].events_worked, byId[aId].named_five_stars, byId[aId].eligible],
    [4, 2, true]
  );
  assert.deepEqual(
    [byId[bId].events_worked, byId[bId].named_five_stars, byId[bId].eligible],
    [4, 2, true]
  );
  // C's second 5-star is pending, so it does not count and C misses the floor.
  assert.deepEqual(
    [byId[cId].events_worked, byId[cId].named_five_stars, byId[cId].eligible],
    [4, 1, false]
  );
  // D's dropped request does not count; 2 events is below the events floor
  // even though the rate is the highest on the board.
  assert.deepEqual(
    [byId[dId].events_worked, byId[dId].named_five_stars, byId[dId].eligible],
    [2, 2, false]
  );
  assert.equal(byId[dId].rate, 1);
  assert.equal(byId[aId].rate, 0.5);

  const idx = (uid) => r.body.rows.findIndex(x => x.user_id === uid);
  assert.ok(idx(aId) < idx(dId), 'eligible rows sort ahead of a higher-rate ineligible one');
  assert.ok(idx(bId) < idx(dId));
  assert.ok(idx(dId) < idx(cId), 'inside the ineligible block, rate still ranks');

  // Server truth for the confirm dialog: the winner set and the split ride the
  // leaderboard payload, so the client never recomputes them.
  assert.deepEqual([...r.body.winners].sort((x, y) => x - y), [aId, bId].sort((x, y) => x - y));
  assert.deepEqual(r.body.shares.map(s => s.amount_cents), [5000, 5000]);
  assert.deepEqual(
    r.body.shares.map(s => s.user_id).sort((x, y) => x - y),
    [aId, bId].sort((x, y) => x - y)
  );
  assert.equal(r.body.in_progress, false, '2018-Q4 is long closed');
});

function quarterOf(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

function quarterEndOf(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  const endMonth = Math.floor((m - 1) / 3) * 3 + 3;
  const last = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
  return `${y}-${String(endMonth).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

async function mkWorkedEvent(day, userId) {
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid)
     VALUES (NULL, $1, 'completed', 'srev-fixture', '6:00 PM', 4, 500, 500) RETURNING id`,
    [day]
  );
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ($1,'6:00 PM','open',$2) RETURNING id`,
    [day, pr.rows[0].id]
  );
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [s.rows[0].id, userId]
  );
}

test('leaderboard: events_worked stops at today, so a future booking cannot deflate a live rate', async () => {
  const today = chicagoTodayYmd();
  const quarter = quarterOf(today);
  const quarterEnd = quarterEndOf(today);

  await makeReview({ stars: 5, credits: [bId], status: 'confirmed', reviewDate: today });
  await mkWorkedEvent(today, bId);

  let r = await req('GET', `/api/admin/staff-reviews/leaderboard?quarter=${quarter}`, adminToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.in_progress, true, 'the running quarter is flagged');
  assert.equal(r.body.rows.find(x => x.user_id === bId).events_worked, 1, "today's event counts");

  if (quarterEnd > today) {
    await mkWorkedEvent(quarterEnd, bId);
    r = await req('GET', `/api/admin/staff-reviews/leaderboard?quarter=${quarter}`, adminToken);
    assert.equal(
      r.body.rows.find(x => x.user_id === bId).events_worked, 1,
      'a shift booked later this quarter is not an event worked'
    );
  }
});

test('contest award refuses a quarter that is still running unless it is forced', async () => {
  const quarter = quarterOf(chicagoTodayYmd());
  let r = await req('POST', '/api/admin/staff-reviews/contest-award', adminToken, { quarter });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /still in progress/);

  // force clears the in-progress guard and lands on the real eligibility check,
  // proving the guard is what blocked the first call.
  r = await req('POST', '/api/admin/staff-reviews/contest-award', adminToken, { quarter, force: true });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no eligible contractors/);
});

test('contest award: tie splits the pot, a second click is idempotent, empty quarters 409', async () => {
  let r = await req('POST', '/api/admin/staff-reviews/contest-award', adminToken, { quarter: 'nope' });
  assert.equal(r.status, 400);

  r = await req('POST', '/api/admin/staff-reviews/contest-award', adminToken, { quarter: '2017-Q1' });
  assert.equal(r.status, 409, 'no eligible contractors');

  r = await req('POST', '/api/admin/staff-reviews/contest-award', adminToken, { quarter: QUARTER });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.awarded_already, false);
  assert.equal(r.body.awards.length, 2, 'the tie produces two winners');
  assert.deepEqual(r.body.awards.map(x => Number(x.amount_cents)), [5000, 5000]);
  assert.deepEqual(r.body.awards.map(x => x.contractor_id).sort((x, y) => x - y), [aId, bId].sort((x, y) => x - y));

  const rows = await pool.query(
    `SELECT contractor_id, amount_cents FROM payout_duty_lines
      WHERE kind = 'review_contest' AND contest_quarter = $1`, [QUARTER]
  );
  assert.equal(rows.rowCount, 2);

  r = await req('POST', '/api/admin/staff-reviews/contest-award', adminToken, { quarter: QUARTER });
  assert.equal(r.status, 200);
  assert.equal(r.body.awarded_already, true, 'a second click pays nothing');
  assert.equal(r.body.awards.length, 2);
  const after2 = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payout_duty_lines
      WHERE kind = 'review_contest' AND contest_quarter = $1`, [QUARTER]
  );
  assert.equal(after2.rows[0].n, 2, 'no new rows created');

  // The no-op second click audit-logs too: "who tried to award this quarter"
  // is exactly the question an audit trail has to answer.
  const audit = await pool.query(
    `SELECT metadata FROM admin_audit_log
      WHERE actor_user_id = $1 AND action = 'staff_review_contest_award' ORDER BY id`,
    [adminId]
  );
  assert.ok(audit.rowCount >= 2, 'both the award and the repeat click audit-log');
  assert.equal(audit.rows[audit.rowCount - 1].metadata.awarded_already, true);
});

// ─── Staff hub: the list envelope ────────────────────────────────

test('the list envelope carries the bounty figure and the all-time totals', async () => {
  const r = await req('GET', '/api/admin/staff-reviews', adminToken);
  assert.equal(r.status, 200);
  // The hub renders the bounty from the envelope, never from a client literal.
  assert.equal(r.body.bounty_cents, 1000);
  assert.equal(typeof r.body.bounties_paid_cents, 'number');
  assert.equal(typeof r.body.total_logged, 'number');
  // The list is capped at LIST_LIMIT, so the all-time count can only be larger.
  assert.ok(r.body.total_logged >= r.body.reviews.length);
  // This suite has paid and un-credited bounties by now, so the sum is a real
  // read: it must count payable lines only (removed_at IS NULL), the same
  // filter the payout total uses. The two sums differ here, which is the point.
  const payable = await pool.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::int AS s FROM payout_duty_lines
      WHERE kind = 'review_bounty' AND removed_at IS NULL`
  );
  const everything = await pool.query(
    "SELECT COALESCE(SUM(amount_cents), 0)::int AS s FROM payout_duty_lines WHERE kind = 'review_bounty'"
  );
  assert.equal(r.body.bounties_paid_cents, payable.rows[0].s);
  assert.ok(everything.rows[0].s > payable.rows[0].s,
    'this suite removed at least one bounty line, so the filter is load-bearing');
});
