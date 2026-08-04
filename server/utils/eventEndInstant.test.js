'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { eventEndInstant, eventEndInstantForDuration } = require('./eventEndInstant');

const NONCE = `eei-${Date.now()}`;
let clientId, pkgId, proposalId, tzProposalId, badProposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id",
    [`${NONCE} client`, `${NONCE}@example.test`]
  );
  clientId = c.rows[0].id;
  // Pinned by slug, never LIMIT 1 on a rate: these suites also run against a
  // fresh Neon branch via the money-smoke gate.
  const p = await pool.query("SELECT id FROM service_packages WHERE slug = 'the-core-reaction'");
  pkgId = p.rows[0].id;

  // 8:00 PM Chicago on 2026-09-12, 4 hours -> midnight Chicago = 05:00 UTC on 9/13 (CDT, UTC-5).
  const ins = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot)
     VALUES ($1,$2,'deposit_paid',100,4,1,350,350,'2026-09-12','8:00 PM','America/Chicago','{}')
     RETURNING id`,
    [clientId, pkgId]
  );
  proposalId = ins.rows[0].id;

  // Same wall clock, New York (UTC-4 in September) -> midnight NY = 04:00 UTC.
  const tz = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot)
     VALUES ($1,$2,'deposit_paid',100,4,1,350,350,'2026-09-12','8:00 PM','America/New_York','{}')
     RETURNING id`,
    [clientId, pkgId]
  );
  tzProposalId = tz.rows[0].id;

  const bad = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot)
     VALUES ($1,$2,'deposit_paid',100,4,1,350,350,'2026-09-12','whenever','America/Chicago','{}')
     RETURNING id`,
    [clientId, pkgId]
  );
  badProposalId = bad.rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('composes the end instant in the event timezone, crossing midnight', async () => {
  const r = await eventEndInstant(pool, proposalId);
  assert.equal(r.endInstant.toISOString(), '2026-09-13T05:00:00.000Z');
});

test('a different event_timezone yields a different instant for the same wall clock', async () => {
  const r = await eventEndInstant(pool, tzProposalId);
  assert.equal(r.endInstant.toISOString(), '2026-09-13T04:00:00.000Z');
});

test('eventEndInstantForDuration prices an arbitrary duration without persisting it', async () => {
  const r = await eventEndInstantForDuration(pool, proposalId, 4.5);
  assert.equal(r.endInstant.toISOString(), '2026-09-13T05:30:00.000Z');
  const unchanged = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [proposalId]);
  assert.equal(Number(unchanged.rows[0].event_duration_hours), 4);
});

test('returns null when the start time is unparseable', async () => {
  assert.equal(await eventEndInstant(pool, badProposalId), null);
});

test('returns null for a missing proposal', async () => {
  assert.equal(await eventEndInstant(pool, 999999999), null);
});
