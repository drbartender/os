// contractor_profiles.hire_date — WHICH DAY gets stamped on a hire.
//
// THE DEFECT. The three hire_date defaults used SQL CURRENT_DATE. The Postgres
// session runs at GMT (verified in `before` below, not assumed), so CURRENT_DATE
// rolls over at 19:00 Chicago (18:00 in winter). Hiring a contractor on a
// weekday evening — the normal time to do admin for an event business — wrote a
// hire_date one calendar day in the FUTURE, and nothing ever recomputes it.
//
// WHY IT MATTERS. hire_date is not decorative. GET /users/:id/seniority derives
// tenure from it and tenure orders the roster, so a wrong date quietly outranks
// somebody for shift assignment.
//
// WHY THE DAY IS INJECTED rather than mocked. The UTC and Chicago days AGREE for
// about 19 hours out of 24, so a fixture derived from the real clock proves
// nothing for most of the day while staying green — it would pass against the
// very bug it exists to catch. So the module takes its day from `_deps.today`,
// the same seam routes/staffPortal.js already uses, and this suite pins it to a
// far-future date that CURRENT_DATE can never coincidentally equal. That is what
// makes the assertion mutation-proof: put CURRENT_DATE back and every hire_date
// assertion below fails by ~74 years rather than by one day.
//
//   TZ=UTC              node --test server/utils/contractorSeed.chicagoDay.test.js
//   TZ=America/Chicago  node --test server/utils/contractorSeed.chicagoDay.test.js

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const contractorSeed = require('./contractorSeed');
const { chicagoTodayYmd } = require('./businessTime');

if (process.env.NODE_ENV === 'production') {
  throw new Error('contractorSeed.chicagoDay.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `hiredate-chicago-${NONCE}@example.com`;

// Far-future and impossible: no real CURRENT_DATE, in any session timezone, can
// equal this. An assertion against it cannot pass by coincidence.
const PINNED = '2099-03-02';

let userId;

/** Run one seed with the module's day pinned, then always restore the real clock. */
async function withToday(ymd, fn) {
  contractorSeed.__setDeps({ today: () => ymd });
  try { return await fn(); }
  finally { contractorSeed.__setDeps({ today: chicagoTodayYmd }); }
}

async function seedFresh(existingHireDate = null) {
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [userId]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withToday(PINNED, () =>
      contractorSeed.seedContractorProfileFromApplication(client, userId, existingHireDate));
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
  // ::text in SQL, never String(jsDate): pg hands back a JS Date for a DATE
  // column and its default string form is 'Mon Mar 02 2099 ...', which silently
  // slices into nonsense and makes every assertion below unreadable.
  const r = await pool.query('SELECT hire_date::text AS d FROM contractor_profiles WHERE user_id = $1', [userId]);
  return r.rows[0] ? r.rows[0].d : null;
}

before(async () => {
  // The whole defect depends on this. Assert the premise instead of trusting it.
  const tz = (await pool.query("SELECT current_setting('TimeZone') AS tz")).rows[0].tz;
  assert.equal(tz, 'GMT', `test premise: the DB session must run at GMT (got ${tz})`);

  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'staff', 'approved', 0) RETURNING id`,
    [EMAIL]
  );
  userId = u.rows[0].id;

  await pool.query(
    `INSERT INTO applications (user_id, full_name, phone, city, state,
       travel_distance, reliable_transportation, positions_interested, why_dr_bartender)
     VALUES ($1, 'Chicago Day Fixture', '555-0100', 'Chicago', 'IL',
       '25', 'yes', 'bartender', 'fixture')`,
    [userId]
  );
});

after(async () => {
  contractorSeed.__setDeps({ today: chicagoTodayYmd });
  if (userId) {
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM applications WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
  await pool.end();
});

test('a fresh hire stamps the business day the app supplies, not the session CURRENT_DATE', async () => {
  assert.equal(await seedFresh(null), PINNED);
});

test('the stamped day is genuinely decoupled from the DB CURRENT_DATE', async () => {
  // Belt and braces for the assertion above: prove the two are actually
  // different values right now, so the equality test could not have passed by
  // the pinned date happening to be today.
  const dbToday = (await pool.query('SELECT CURRENT_DATE::text AS d')).rows[0].d;
  assert.notEqual(dbToday, PINNED, 'fixture is only meaningful while PINNED != CURRENT_DATE');
});

test('an existing hire_date still wins over the business day (re-hire stays anchored)', async () => {
  // The date-source fix must not disturb the re-hire rule: a caller passing a
  // previous hire_date keeps it, which is the whole reason $2 exists.
  assert.equal(await seedFresh('2020-06-15'), '2020-06-15');
});

test('the re-seed of an existing row does not drift the day forward', async () => {
  // Idempotence across two seeds: ON CONFLICT preserves the first value rather
  // than restamping, so running the hire path twice cannot move the date.
  const first = await seedFresh(null);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withToday('2099-12-31', () =>
      contractorSeed.seedContractorProfileFromApplication(client, userId, first));
    await client.query('COMMIT');
  } finally { client.release(); }
  const r = await pool.query('SELECT hire_date::text AS d FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(r.rows[0].d, PINNED);
});
