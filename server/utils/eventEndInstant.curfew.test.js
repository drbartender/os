'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { maxDurationHoursBeforeCurfew, SERVICE_CURFEW_HOUR } = require('./eventEndInstant');
const {
  allowedAdditionalHours, computeExtensionDelta, MAX_EXTENSION_HOURS,
} = require('./serviceExtensionPricing');

// The 2:00 AM stop is an INSURANCE WARRANTY (liquor liability application
// PK810225-GLLL230810: "Do not have operations going past 2:00 AM"). Breaching
// it can void the policy, so these cases pin the arithmetic that keeps a
// same-night extension inside coverage.

const NONCE = `curfew-${Date.now()}`;
const made = [];
let clientId;
let pkgId;

// Seed a proposal at a chosen local start time and duration. event_start_time
// is free text in production, so the fixtures use the same display strings the
// app stores.
async function seed(startDisplay, durationHours, { date = '2026-09-12' } = {}) {
  const r = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone,
        pricing_snapshot, adjustments)
     VALUES ($1,$2,'balance_paid',100,$3,1,350,350,$4,$5,'America/Chicago','{}','[]')
     RETURNING id`,
    [clientId, pkgId, durationHours, date, startDisplay]
  );
  made.push(r.rows[0].id);
  return r.rows[0].id;
}

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id`,
    [`${NONCE} client`, `${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  // A real package, so computeExtensionDelta can actually price both legs.
  const p = await pool.query("SELECT id FROM service_packages WHERE slug = 'the-core-reaction'");
  pkgId = p.rows[0].id;
});

after(async () => {
  if (made.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('curfew is the FIRST 2:00 AM after the event start, not a fixed offset', async () => {
  // Evening start: curfew is the following morning.
  const evening = await seed('8:00 PM', 4);
  const a = await maxDurationHoursBeforeCurfew(pool, evening);
  assert.equal(a.maxHours, 6, '8pm -> 2am is six wall-clock hours');
  assert.equal(a.curfewDisplay, '2:00 AM');

  // Start already after midnight but BEFORE the curfew: it is TODAY's 2:00 AM,
  // one hour away, not 25 hours away. A naive "next day at 2am" gets this wrong.
  const afterMidnight = await seed('1:00 AM', 1);
  const b = await maxDurationHoursBeforeCurfew(pool, afterMidnight);
  assert.equal(b.maxHours, 1);
});

test('SERVICE_CURFEW_HOUR is what the math actually uses', async () => {
  // Not a constant-vs-literal change detector: drive the default and an
  // explicit override and prove the returned boundary moves with it.
  const id = await seed('9:30 PM', 3);
  const dflt = await maxDurationHoursBeforeCurfew(pool, id);
  assert.equal(dflt.maxHours, 4.5, '9:30pm -> 2:00am');
  const midnight = await maxDurationHoursBeforeCurfew(pool, id, 0);
  assert.equal(midnight.maxHours, 2.5, 'a midnight curfew is 2.5h from 9:30pm');
  assert.equal(midnight.curfewDisplay, '12:00 AM');
  assert.equal(SERVICE_CURFEW_HOUR, 2, 'and the shipped default is 2:00 AM');
});

test('a start of EXACTLY 2:00 AM has zero room, not twenty-four hours', async () => {
  // The boundary the whole module defends. An exclusive comparison here reads
  // the start as "before tomorrow's curfew" and fails OPEN by a full day.
  const id = await seed('2:00 AM', 4);
  const r = await maxDurationHoursBeforeCurfew(pool, id);
  assert.equal(r.maxHours, 0, 'at the curfew means no room left');
  const allowed = await allowedAdditionalHours(pool, id, 4);
  assert.equal(allowed.hours, 0);
  assert.equal(allowed.curfewBinds, true);
});

test('the 3-hour cap still binds when the curfew is far away', async () => {
  const id = await seed('5:00 PM', 4);           // contracted end 9pm, curfew 2am = 5h of room
  const r = await allowedAdditionalHours(pool, id, 4);
  assert.equal(r.hours, MAX_EXTENSION_HOURS, 'cap wins when it is the tighter limit');
  assert.equal(r.curfewBinds, false, 'the curfew is not what limited this one');
});

test('the curfew binds when it is tighter than the cap', async () => {
  // 10pm start, 4 hours -> contracted end 2:00 AM exactly. Zero room.
  const atCurfew = await seed('10:00 PM', 4);
  const none = await allowedAdditionalHours(pool, atCurfew, 4);
  assert.equal(none.hours, 0, 'an event contracted to the curfew sells no more time');
  assert.equal(none.curfewBinds, true);

  // 9pm start, 4 hours -> contracted end 1:00 AM. Exactly one hour remains,
  // even though the mis-scroll cap would allow three.
  const oneHour = await seed('9:00 PM', 4);
  const some = await allowedAdditionalHours(pool, oneHour, 4);
  assert.equal(some.hours, 1);
  assert.equal(some.curfewDisplay, '2:00 AM');
});

test('an event already contracted PAST the curfew never returns negative time', async () => {
  // 10pm start, 6 hours -> contracted end 4:00 AM, already outside the warranty.
  // The extension flow must refuse cleanly rather than offering negative steps.
  const id = await seed('10:00 PM', 6);
  const r = await allowedAdditionalHours(pool, id, 6);
  assert.equal(r.hours, 0, 'clamped to zero, not -2');
  // And the choke point refuses rather than pricing a negative-room request.
  const delta = await computeExtensionDelta({
    client: pool, proposalId: id, requestedDurationHours: 6.5,
  });
  assert.equal(delta.ok, false);
  assert.equal(delta.reason, 'past_curfew');
});

test('allowance floors to a whole 30-minute step', async () => {
  // 9:15pm start, 4 hours -> contracted end 1:15 AM. 45 minutes to the curfew,
  // which must offer 30 minutes, not 45.
  const id = await seed('9:15 PM', 4);
  const r = await allowedAdditionalHours(pool, id, 4);
  assert.equal(r.hours, 0.5, '45 minutes of room sells one 30-minute step');
});

// ── THE CHOKE POINT ────────────────────────────────────────────────────────
// computeExtensionDelta is the ONE function both the pre-flight check and the
// in-transaction repricing call. Everything above tests the arithmetic; these
// test the enforcement. Delete the curfew block in computeExtensionDelta and
// these must go red, or a future edit removes the ceiling with a green suite.

test('computeExtensionDelta REFUSES a request that would run past the curfew', async () => {
  // 9:00 PM + 4h contracted = 1:00 AM. One hour of room; ask for two.
  const id = await seed('9:00 PM', 4);
  const delta = await computeExtensionDelta({
    client: pool, proposalId: id, requestedDurationHours: 6,
  });
  assert.equal(delta.ok, false, 'selling an uninsured hour must fail');
  assert.equal(delta.reason, 'past_curfew');
  assert.equal(delta.curfewDisplay, '2:00 AM', 'the staffer can name the stop to the client');
  assert.equal(delta.allowedHours, 1);
});

test('computeExtensionDelta ALLOWS an extension ending exactly at the curfew', async () => {
  // The inclusive boundary. Without this, "hardening" > into >= silently kills
  // every legitimate 2:00 AM close and no test complains.
  const id = await seed('9:00 PM', 4);
  const delta = await computeExtensionDelta({
    client: pool, proposalId: id, requestedDurationHours: 5,
  });
  assert.equal(delta.ok, true, 'ending AT 2:00 AM is inside the warranty');
});

test('the curfew refusal survives even when the 3-hour cap would allow it', async () => {
  // 11:00 PM + 2h = 1:00 AM contracted. +2h is under the cap but past 2:00 AM,
  // so cap-only logic would sell it. This is the exact bug the lane fixes.
  const id = await seed('11:00 PM', 2);
  const delta = await computeExtensionDelta({
    client: pool, proposalId: id, requestedDurationHours: 4,
  });
  assert.equal(delta.ok, false);
  assert.equal(delta.reason, 'past_curfew');
});

test('every step the picker offers is a step the validator accepts', async () => {
  // The stated picker-subset-of-validator contract, pinned. create.js builds
  // stepLabels from allowedAdditionalHours; walk that same allowance and prove
  // each one prices, plus that the first step BEYOND it is refused.
  const id = await seed('9:15 PM', 4);        // 45 min of room -> one 0.5h step
  const allowed = await allowedAdditionalHours(pool, id, 4);
  assert.ok(allowed.hours > 0, 'fixture must offer at least one step');
  for (let added = 0.5; added <= allowed.hours + 1e-6; added += 0.5) {
    const d = await computeExtensionDelta({
      client: pool, proposalId: id, requestedDurationHours: 4 + added,
    });
    assert.equal(d.ok, true, `offered step +${added}h must be sellable`);
  }
  const past = await computeExtensionDelta({
    client: pool, proposalId: id, requestedDurationHours: 4 + allowed.hours + 0.5,
  });
  assert.equal(past.ok, false, 'the first unoffered step must be refused');
  assert.equal(past.reason, 'past_curfew');
});

test('spring-forward night: the bar still stops at the 2:00 AM boundary', async () => {
  // 2027-03-13 in America/Chicago: 1:59:59 CST jumps to 3:00:00 CDT. Wall-clock
  // math is what keeps this compliant, so pin it rather than trusting prose.
  const id = await seed('9:00 PM', 4, { date: '2027-03-13' });
  const r = await maxDurationHoursBeforeCurfew(pool, id);
  assert.equal(r.maxHours, 5, '9pm -> 2am is five wall-clock hours even on the short night');
  const ok = await computeExtensionDelta({
    client: pool, proposalId: id, requestedDurationHours: 5,
  });
  assert.equal(ok.ok, true);
  const no = await computeExtensionDelta({
    client: pool, proposalId: id, requestedDurationHours: 5.5,
  });
  assert.equal(no.ok, false);
  assert.equal(no.reason, 'past_curfew');
});

test('unparseable stored time returns null, never a silent zero', async () => {
  // Free text that is not a time. Short enough for the varchar(20) column,
  // which is itself why production stores strings like this.
  const id = await seed('TBD', 4);
  assert.equal(await maxDurationHoursBeforeCurfew(pool, id), null);
  assert.equal(await allowedAdditionalHours(pool, id, 4), null);
});
