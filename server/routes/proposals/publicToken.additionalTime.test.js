// The public proposal payload carries `additional_time`: what one added hour
// costs on this booking's package line. Agreement v4 Section 8.1 points the
// client at that number, so it has to be on the page they sign and it has to be
// the figure the on-site extension bills.
//
// Calls buildPublicProposalPayload directly (no HTTP, no sign POSTs, so it
// spends none of signLimiter's budget). Runs against the dev DB; creates real
// rows and purges them in after(). Expected figures are computed from the
// catalog row the test reads, never hard-coded: the dev catalog is not prod's.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../../db');
const { extraHourCharge, hostedRateTier } = require('../../utils/pricingEngine');
const { buildPublicProposalPayload } = require('./publicToken');

const createdProposalIds = new Set();
const createdClientIds = new Set();
let clientId;
const pkgs = {};

async function insertProposal({ packageId, guestCount }) {
  const token = crypto.randomUUID();
  const snapshot = JSON.stringify({ package: { name: 'Test', base_cost: 500 }, total: 500 });
  const { rows } = await pool.query(
    `INSERT INTO proposals
       (client_id, token, package_id, guest_count, event_duration_hours, num_bars,
        pricing_snapshot, total_price, payment_type, status, event_type,
        venue_street, venue_city, venue_state)
     VALUES ($1, $2, $3, $4, 4, 0, $5, 500, 'full', 'viewed', 'Wedding',
        '123 Test St', 'Rockford', 'IL')
     RETURNING id, token`,
    [clientId, token, packageId, guestCount, snapshot]
  );
  createdProposalIds.add(rows[0].id);
  return rows[0];
}

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    ['Added Time Test', `addedtime+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`]
  );
  clientId = c.rows[0].id;
  createdClientIds.add(clientId);

  const { rows } = await pool.query(
    `SELECT * FROM service_packages
      WHERE slug = ANY($1)`,
    [['the-core-reaction', 'the-carbon-suspension', 'mixology-101']]
  );
  for (const r of rows) pkgs[r.slug] = r;
  for (const slug of ['the-core-reaction', 'the-carbon-suspension', 'mixology-101']) {
    assert.ok(pkgs[slug], `dev catalog is missing ${slug}; this suite cannot prove anything without it`);
  }
});

after(async () => {
  for (const id of createdProposalIds) {
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
  for (const id of createdClientIds) {
    await pool.query('DELETE FROM clients WHERE id = $1', [id]);
  }
  await pool.end();
});

const dollars = (n) => Math.round(Number(n) * 100) / 100;

test('a service-only booking carries its hourly rate', async () => {
  const pkg = pkgs['the-core-reaction'];
  const p = await insertProposal({ packageId: pkg.id, guestCount: 160 });
  const payload = await buildPublicProposalPayload(p.token);
  assert.deepEqual(payload.additional_time, {
    hourly: dollars(pkg.extra_hour_rate), per_guest_rate: null, billed_guests: null,
  });
  assert.equal(payload.additional_time.hourly, dollars(extraHourCharge(pkg, 160, 1)));
});

test('a hosted booking carries the per-guest rate, the billed guests, and the hourly they make', async () => {
  const pkg = pkgs['the-carbon-suspension'];
  const p = await insertProposal({ packageId: pkg.id, guestCount: 100 });
  const payload = await buildPublicProposalPayload(p.token);
  assert.ok(payload.additional_time, 'a hosted package with an extra-hour rate shows one');
  assert.equal(payload.additional_time.hourly, dollars(extraHourCharge(pkg, 100, 1)));
  assert.equal(payload.additional_time.per_guest_rate, dollars(hostedRateTier(pkg, 100).extraRate));
  assert.equal(payload.additional_time.billed_guests, 100);
});

test('a small hosted booking is shown at the billed-guest minimum', async () => {
  const pkg = pkgs['the-carbon-suspension'];
  const min = Number(pkg.min_billed_guests || 0);
  assert.ok(min > 1, 'this case needs a package with a billed-guest minimum');
  const p = await insertProposal({ packageId: pkg.id, guestCount: min - 1 });
  const payload = await buildPublicProposalPayload(p.token);
  assert.equal(payload.additional_time.billed_guests, min);
  assert.equal(payload.additional_time.hourly, dollars(extraHourCharge(pkg, min - 1, 1)));
});

test('a class carries none, and neither does a proposal with no package', async () => {
  const klass = await insertProposal({ packageId: pkgs['mixology-101'].id, guestCount: 12 });
  assert.equal((await buildPublicProposalPayload(klass.token)).additional_time, null);
  const bare = await insertProposal({ packageId: null, guestCount: 120 });
  assert.equal((await buildPublicProposalPayload(bare.token)).additional_time, null);
});

test('the catalog columns read to compute it never reach the token holder', async () => {
  const p = await insertProposal({ packageId: pkgs['the-carbon-suspension'].id, guestCount: 100 });
  const payload = await buildPublicProposalPayload(p.token);
  const leaked = Object.keys(payload).filter((k) => k.startsWith('pkg_'));
  assert.deepEqual(leaked, []);
  assert.equal(payload.total_price_override, undefined, 'the existing strip still holds');
});
