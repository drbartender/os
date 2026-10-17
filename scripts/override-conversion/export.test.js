require('dotenv').config();
// The conversion's export and fresh compute (plan 2026-10-16-price-override-removal,
// Task V1 steps 2-3), against synthetic fixtures. Both only read: the export
// runs in a read-only snapshot, the fresh compute inside BEGIN ... ROLLBACK.
// The legal-hold refusal is by construction: a held id is dropped by the seam
// before any data query, and the fresh compute never loads one. No test here
// uses a real held booking; ids are injected through __setLegalHoldIdsForTest.
// Run ALONE (shared dev DB):
//   node --test scripts/override-conversion/export.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../../server/db');
const { __setLegalHoldIdsForTest } = require('../../server/utils/legalHold');
const fx = require('./fixtures');
const { exportConversion } = require('./export');
const { computeFresh } = require('./freshCompute');

if (process.env.NODE_ENV === 'production') {
  throw new Error('export.test.js refuses to run against production');
}

const NONCE = `convexp-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const MD5_SQL = `SELECT md5(row(total_price, amount_paid, status, total_price_override, adjustments, pricing_snapshot)::text) AS m
                   FROM proposals WHERE id = $1`;
let ctx;
const id = {};

before(async () => {
  ctx = await fx.createFixtureContext(pool, NONCE);
  const line = { type: 'discount', label: 'Test discount A', amount: '25.00', visible: true };
  id.live = await fx.insertProposal(pool, ctx, { status: 'confirmed', override: 2000, adjustments: [line], syrups: ['jalapeno'] });
  id.held = await fx.insertProposal(pool, ctx, { status: 'confirmed', override: 1500 });
  id.noPackage = await fx.insertProposal(pool, ctx, { status: 'deposit_paid', override: 900, packageId: null });
  id.terminal = await fx.insertProposal(pool, ctx, { status: 'archived', override: 1800 });
  id.refund = await fx.insertProposal(pool, ctx, { status: 'balance_paid', totalPrice: 1450 });
  id.overpayOnly = await fx.insertProposal(pool, ctx, { status: 'balance_paid' });
  id.none = await fx.insertProposal(pool, ctx, { status: 'confirmed' });
  await fx.insertRefund(pool, ctx, { proposalId: id.refund, amountCents: 5000, before: 1500, after: 1450 });
  await fx.insertRefund(pool, ctx, { proposalId: id.refund, amountCents: 2500, scope: 'overpayment', before: 1450, after: 1450 });
  await fx.insertRefund(pool, ctx, { proposalId: id.refund, amountCents: 1000, status: 'pending', before: 1450, after: 1440 });
  await fx.insertRefund(pool, ctx, { proposalId: id.overpayOnly, amountCents: 3000, scope: 'overpayment', before: 1000, after: 1000 });
  await fx.insertInvoice(pool, ctx, { proposalId: id.live, amountDue: 4200 });
  await fx.insertInvoice(pool, ctx, { proposalId: id.live, label: 'Deposit', amountDue: 10000 });
  await fx.insertChangeRequest(pool, ctx, { proposalId: id.live });
  await fx.insertChangeRequest(pool, ctx, { proposalId: id.live, status: 'declined' });
  __setLegalHoldIdsForTest([id.held]);
});

after(async () => {
  __setLegalHoldIdsForTest(null);
  await fx.cleanupFixtures(pool, ctx);
  await pool.end();
});

async function exportFixtures() {
  const client = await pool.connect();
  try {
    return await exportConversion(client, { onlyIds: ctx.proposalIds });
  } finally {
    client.release();
  }
}

test('the export holds every override booking and every contract-refund booking, and never a held one', async () => {
  const out = await exportFixtures();
  const ids = out.rows.map((r) => r.id);
  assert.deepEqual(ids, [id.live, id.noPackage, id.terminal, id.refund].sort((a, b) => a - b));
  assert.ok(!ids.includes(id.held), 'a held booking is never exported');
  assert.ok(!ids.includes(id.overpayOnly), 'an overpayment refund alone is not a candidate');
  assert.ok(!JSON.stringify(out).includes(`"id":${id.held},`), 'the held id appears nowhere in the export');
});

test('rows carry exact money, the guard md5 the database computes, and their nested records', async () => {
  const out = await exportFixtures();
  const live = out.rows.find((r) => r.id === id.live);
  assert.equal(live.total_price_override, '2000.00', 'numerics are exact strings');
  assert.equal(typeof live.total_price, 'string');
  assert.equal(live.status, 'confirmed');
  assert.equal(live.adjustments_type, 'array');
  assert.deepEqual(live.adjustments, [{ type: 'discount', label: 'Test discount A', amount: '25.00', visible: true }]);
  assert.equal(live.money_md5, (await pool.query(MD5_SQL, [id.live])).rows[0].m);
  assert.deepEqual(live.additional_services_invoices.map((i) => i.amount_due), [4200], 'only Additional Services invoices');
  assert.equal(live.pending_change_requests.length, 1, 'only pending change requests');
  assert.ok(!('guest_count' in live), 'the export is a column subset; the fresh compute loads whole rows');

  const refund = out.rows.find((r) => r.id === id.refund);
  assert.deepEqual(refund.refunds.map((r) => [r.total_scope, r.amount, r.total_price_before, r.total_price_after]),
    [['contract', 5000, '1500.00', '1450.00'], ['overpayment', 2500, '1450.00', '1450.00']], 'succeeded refunds only, oldest first');
  assert.equal(refund.total_price_override, null);
});

test('the fresh compute prices live override rows whole, inside a rollback, and never a held one', async () => {
  const out = await exportFixtures();
  const heldRow = { ...out.rows[0], id: id.held }; // planted: the compute must refuse it by construction
  const before = await Promise.all([id.live, id.noPackage].map(async (i) => (await pool.query(MD5_SQL, [i])).rows[0].m));
  const client = await pool.connect();
  let fresh;
  try {
    fresh = await computeFresh(client, [...out.rows, heldRow]);
  } finally {
    client.release();
  }
  assert.deepEqual(fresh.map((f) => f.id), [id.live, id.noPackage], 'live override rows only: no terminal, no refund-only, no held');
  const live = fresh.find((f) => f.id === id.live);
  assert.equal(live.error, undefined);
  assert.equal(live.snapshot.total_price_override, null, 'no override in the fresh compute');
  assert.equal(live.snapshot.inputs.guestCount, 120, 'priced from the whole row (guest_count is not exported)');
  assert.deepEqual(live.snapshot.syrups.selections, ['jalapeno']);
  assert.deepEqual(live.snapshot.adjustments, [{ type: 'discount', label: 'Test discount A', amount: '25.00', visible: true }]);
  assert.equal(live.freshServiceCents,
    Math.round(live.snapshot.total * 100) - Math.round((live.snapshot.gratuity.total || 0) * 100));
  assert.equal(live.money_md5, out.rows.find((r) => r.id === id.live).money_md5);
  const broken = fresh.find((f) => f.id === id.noPackage);
  assert.match(broken.error, /no package/, 'a row the compute refuses is recorded, not fatal');
  assert.equal(broken.snapshot, undefined);
  const afterMd5 = await Promise.all([id.live, id.noPackage].map(async (i) => (await pool.query(MD5_SQL, [i])).rows[0].m));
  assert.deepEqual(afterMd5, before, 'nothing written');
});

test('the fresh compute refuses a row that moved since the export', async () => {
  const out = await exportFixtures();
  const stale = out.rows.filter((r) => r.id === id.live).map((r) => ({ ...r, money_md5: '0'.repeat(32) }));
  const client = await pool.connect();
  try {
    const [f] = await computeFresh(client, stale);
    assert.match(f.error, /changed since the export/);
    assert.equal(f.snapshot, undefined);
  } finally {
    client.release();
  }
});
