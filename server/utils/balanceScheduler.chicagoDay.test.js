// Autopay balance charge — WHICH DAY makes a balance due.
//
// THE DEFECT. The atomic claim selected on `balance_due_date <= CURRENT_DATE`.
// The Postgres session runs at GMT (asserted in `before`, not assumed), so from
// 19:00 Chicago CURRENT_DATE is already TOMORROW. A balance due tomorrow was
// claimed and charged TONIGHT: a real card charge, on an unattended hourly
// scheduler, up to five hours before the date the client agreed to.
//
// WHY THIS SUITE NEVER TOUCHES STRIPE. Both fixtures are seeded with
// amount_paid == total_price, so `balanceCents <= 0` returns before any Stripe
// call on every path this suite can reach. That matters on this box: dev talks
// to LIVE Stripe by design, so a test that reached the charge would be a real
// charge attempt, not a rehearsal.
//
// WHAT IS ASSERTED, AND WHY IT IS autopay_attempted_at RATHER THAN
// autopay_status. The zero-balance path CLEARS autopay_status back to NULL after
// claiming, so status alone cannot distinguish "never selected" from "selected
// and then released" — a first cut asserted on status and was green against the
// bug. autopay_attempted_at is stamped by the claim and is never cleared, so it
// is the honest record of whether the row was picked up at all.
//
//   TZ=UTC              node --test server/utils/balanceScheduler.chicagoDay.test.js
//   TZ=America/Chicago  node --test server/utils/balanceScheduler.chicagoDay.test.js

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const balanceScheduler = require('./balanceScheduler');
const { chicagoTodayYmd } = require('./businessTime');

if (process.env.NODE_ENV === 'production') {
  throw new Error('balanceScheduler.chicagoDay.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `autopay-chicago-${NONCE}@example.com`;

const PINNED = '2099-03-02';       // the business day we pin the scheduler to
const DUE_TOMORROW = '2099-03-03'; // a balance the client has NOT agreed to pay yet

let clientId; let dueTodayId; let dueTomorrowId;

async function withToday(ymd, fn) {
  balanceScheduler.__setDeps({ today: () => ymd });
  try { return await fn(); }
  finally { balanceScheduler.__setDeps({ today: chicagoTodayYmd }); }
}

async function seedProposal(balanceDue) {
  // amount_paid == total_price: the claim can happen, but balanceCents <= 0
  // short-circuits before Stripe. See the header.
  const r = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, total_price, amount_paid,
       guest_count, event_type, balance_due_date, autopay_enrolled,
       stripe_customer_id, stripe_payment_method_id)
     VALUES ($1, '2099-04-01'::date, 'deposit_paid', 500, 500, 50, 'wedding',
             $2::date, true, 'cus_fixtureNeverCharged', 'pm_fixtureNeverCharged')
     RETURNING id`,
    [clientId, balanceDue]
  );
  return r.rows[0].id;
}

async function attemptedAt(id) {
  const r = await pool.query('SELECT autopay_attempted_at FROM proposals WHERE id = $1', [id]);
  return r.rows[0].autopay_attempted_at;
}

before(async () => {
  const tz = (await pool.query("SELECT current_setting('TimeZone') AS tz")).rows[0].tz;
  assert.equal(tz, 'GMT', `test premise: the DB session must run at GMT (got ${tz})`);

  const c = await pool.query(
    `INSERT INTO clients (name, email, phone, source) VALUES ('Autopay Day Fixture', $1, '555-0102', 'direct')
     RETURNING id`, [EMAIL]
  );
  clientId = c.rows[0].id;
  dueTodayId = await seedProposal(PINNED);
  dueTomorrowId = await seedProposal(DUE_TOMORROW);
});

after(async () => {
  balanceScheduler.__setDeps({ today: chicagoTodayYmd });
  const ids = [dueTodayId, dueTomorrowId].filter(Boolean);
  if (ids.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('a balance due TODAY is claimed — proves the query actually ran', async () => {
  // Non-vacuity guard. processAutopayCharges returns early when getStripe() is
  // null, in which case every "not charged" assertion below would pass without
  // the claim SQL ever executing. This test fails loudly in that world.
  assert.equal(await attemptedAt(dueTodayId), null, 'fixture must start unclaimed');
  await withToday(PINNED, () => balanceScheduler.processAutopayCharges());
  assert.notEqual(await attemptedAt(dueTodayId), null,
    'a balance due on the pinned business day must be claimed (if this is null, Stripe was unavailable and the whole suite is vacuous)');
});

test('a balance due TOMORROW is NOT claimed on tonight of the day before', async () => {
  // The defect, stated directly. With CURRENT_DATE back, the GMT day is already
  // 2099-03-03 for the last five hours of the Chicago day, so this row was
  // selected and the client's card charged a day early.
  assert.equal(await attemptedAt(dueTomorrowId), null,
    "a balance the client owes TOMORROW must not be claimed today");
});

test('the same balance IS claimed once its own day arrives', async () => {
  await withToday(DUE_TOMORROW, () => balanceScheduler.processAutopayCharges());
  assert.notEqual(await attemptedAt(dueTomorrowId), null,
    'the balance must be claimed on the day it is actually due');
});
