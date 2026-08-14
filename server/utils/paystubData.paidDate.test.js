// The paystub "Paid on" date is the CHICAGO calendar day of payouts.paid_at.
//
// payouts.paid_at is a TIMESTAMPTZ (schema.sql:3112) stamped by NOW() at
// mark-paid (server/routes/admin/payroll.js:581), i.e. a true instant. The
// local ymd() helper in paystubData.js does toISOString().slice(0,10), which
// yields the GMT day — so a payout marked paid on a Chicago evening printed
// the NEXT day on a real pay document. 9 of 25 paid prod payouts were wrong.
//
// These cases are pinned at fixed instants (not "now"), so they discriminate
// the bug identically under TZ=UTC and TZ=America/Chicago. Run BOTH:
//   TZ=UTC              node --test server/utils/paystubData.paidDate.test.js
//   TZ=America/Chicago  node --test server/utils/paystubData.paidDate.test.js
//
// Also pins the DATE columns (start_date / end_date / payday) as UNCHANGED:
// those are bare SQL DATEs and ymd() is correct for them on any machine at or
// west of UTC, so this suite fails if someone "fixes" them too.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { assemblePaystubData } = require('./paystubData');

if (process.env.NODE_ENV === 'production') {
  throw new Error('paystubData.paidDate.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `paystub-paiddate-${NONCE}@example.com`;

// Far-future period dates so the UNIQUE(start_date) on pay_periods cannot
// collide with a real (or another lane's) row in the shared dev DB.
const PERIODS = {
  // Summer CDT (UTC-5): 01:30Z on Aug 14 is 20:30 on Aug 13 in Chicago.
  summer: { start: '2031-08-01', end: '2031-08-15', payday: '2031-08-16', paidAt: '2031-08-14T01:30:00Z', chicago: '2031-08-13', utc: '2031-08-14' },
  // Winter CST (UTC-6): 04:30Z on Jan 6 is 22:30 on Jan 5 in Chicago.
  winter: { start: '2031-01-01', end: '2031-01-15', payday: '2031-01-16', paidAt: '2031-01-06T04:30:00Z', chicago: '2031-01-05', utc: '2031-01-06' },
  // Unpaid payout: paid_at IS NULL must stay null, never the epoch day.
  unpaid: { start: '2031-03-01', end: '2031-03-15', payday: '2031-03-16', paidAt: null },
};

let contractorId;
const periodIds = {};

before(async () => {
  contractorId = (await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
    [EMAIL]
  )).rows[0].id;

  for (const [key, p] of Object.entries(PERIODS)) {
    const pp = await pool.query(
      `INSERT INTO pay_periods (start_date, end_date, payday, status)
       VALUES ($1::date, $2::date, $3::date, 'paid')
       ON CONFLICT (start_date) DO UPDATE SET end_date = EXCLUDED.end_date
       RETURNING id`,
      [p.start, p.end, p.payday]
    );
    periodIds[key] = pp.rows[0].id;

    await pool.query(
      `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents, payment_method, paid_at)
       VALUES ($1, $2, $3, 12345, 'venmo', $4::timestamptz)`,
      [periodIds[key], contractorId, p.paidAt ? 'paid' : 'pending', p.paidAt]
    );
  }
});

after(async () => {
  if (contractorId) {
    await pool.query('DELETE FROM payouts WHERE contractor_id = $1', [contractorId]);
    await pool.query('DELETE FROM users WHERE id = $1', [contractorId]);
  }
  const ids = Object.values(periodIds);
  if (ids.length) await pool.query('DELETE FROM pay_periods WHERE id = ANY($1::int[])', [ids]);
  await pool.end();
});

test('paid.at is the Chicago day of paid_at, not the UTC day (summer CDT evening)', async () => {
  const p = PERIODS.summer;
  const data = await assemblePaystubData(contractorId, periodIds.summer);
  assert.ok(data, 'expected paystub data');
  assert.notEqual(data.paid.at, p.utc, 'rendered the UTC day — the toISOString() trap');
  assert.equal(data.paid.at, p.chicago);
});

test('paid.at is the Chicago day of paid_at, not the UTC day (winter CST evening)', async () => {
  const p = PERIODS.winter;
  const data = await assemblePaystubData(contractorId, periodIds.winter);
  assert.notEqual(data.paid.at, p.utc, 'rendered the UTC day — the toISOString() trap');
  assert.equal(data.paid.at, p.chicago);
});

test('paid.at stays null when paid_at is null (never the epoch day)', async () => {
  const data = await assemblePaystubData(contractorId, periodIds.unpaid);
  assert.equal(data.paid.at, null);
});

test('period DATE columns are untouched — start_date / end_date / payday still render literally', async () => {
  const p = PERIODS.summer;
  const data = await assemblePaystubData(contractorId, periodIds.summer);
  assert.deepEqual(data.period, { start_date: p.start, end_date: p.end, payday: p.payday });
});
