require('dotenv').config();
// server/utils/refundLine.test.js
'use strict';
// The Refund line writer (spec 2026-10-16 section 6, plan Task R1). DB suite:
// synthetic bookings only. No Stripe object is created; the refund rows here
// are plain fixture inserts. A held booking is a synthetic id ADDED through
// __setLegalHoldIdsForTest; no real held booking is read or written.
//
// Run ALONE against the shared dev DB:
//   node --test server/utils/refundLine.test.js
const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const { appendRefundLine } = require('./refundLine');
const { validateAdjustments } = require('./adjustmentRules');
const { __setLegalHoldIdsForTest } = require('./legalHold');
const { GRATUITY_LABEL, SHARED_GRATUITY_LABEL } = require('./gratuityLabels');

if (process.env.NODE_ENV === 'production') {
  throw new Error('refundLine.test.js refuses to run against production');
}

const NONCE = `rl-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let seq = 0;
const seededClients = [];
const seededProposals = [];

afterEach(() => __setLegalHoldIdsForTest(null));

// adjustments / snapshot are stored as given (JSON text); adjustments null
// stores SQL NULL. updated_at starts a day back so any UPDATE shows.
async function seedBooking({ adjustments = [], snapshot = {}, totalPrice = 1240 } = {}) {
  seq += 1;
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`Refund Line Test ${NONCE}`, `${NONCE}-${seq}@example.com`]
  );
  seededClients.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, event_timezone,
                            event_date, event_start_time, event_duration_hours,
                            total_price, amount_paid, adjustments, pricing_snapshot,
                            autopay_enrolled, updated_at)
     VALUES ($1, 'balance_paid', 'wedding', 'America/Chicago',
             CURRENT_DATE + 30, '18:00', 4, $2, $2, $3::jsonb, $4::jsonb,
             false, NOW() - INTERVAL '1 day')
     RETURNING id`,
    [c.rows[0].id, totalPrice,
      adjustments === null ? null : JSON.stringify(adjustments), JSON.stringify(snapshot)]
  );
  const proposalId = p.rows[0].id;
  seededProposals.push(proposalId);
  return proposalId;
}

// A succeeded refund row, so refund_id is the raw id pg returns for it.
async function seedRefundRow(proposalId, amountCents = 28500) {
  const r = await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, stripe_refund_id, amount, reason, total_price_before,
        total_price_after, status, total_scope)
     VALUES ($1, $2, $3, 'test refund', 0, 0, 'succeeded', 'contract')
     RETURNING id`,
    [proposalId, `re_${NONCE}_${seq}_${crypto.randomBytes(2).toString('hex')}`, amountCents]
  );
  return r.rows[0].id;
}

// appendRefundLine as the reconciliation runs it: inside a transaction.
async function append(args) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await appendRefundLine(client, args);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function readRow(proposalId) {
  const r = await pool.query(
    'SELECT adjustments, pricing_snapshot, total_price, updated_at FROM proposals WHERE id = $1',
    [proposalId]
  );
  return r.rows[0];
}

// Runs fn with console.error captured (the writer's report of an unexpected
// skip; Sentry rides the same call when configured).
async function withErrorsCaptured(fn) {
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  try {
    return { out: await fn(), logged };
  } finally {
    console.error = original;
  }
}

const refundLine = (refundId, amount = 285) => ({
  type: 'discount', label: 'Refund', amount, visible: true, source: 'refund', refund_id: refundId,
});
const refundRow = (amount = 285) => ({ label: 'Refund', amount: -amount, visible: true });

// Package, a staffing Shared Gratuity row, one add-on, an ordinary discount and
// the client Gratuity row (gratuity 40), in the engine's order.
const DISCOUNT_A = { type: 'discount', label: 'Test discount A', amount: 50, visible: true };
const fullSnapshot = () => ({
  package: { name: 'Test Package', base_cost: 1000 },
  breakdown: [
    { label: 'Test Package (4hrs, 120 guests)', amount: 1000 },
    { label: SHARED_GRATUITY_LABEL, amount: 100 },
    { label: 'Test Add-on A', amount: 150 },
    { label: 'Test discount A', amount: -50 },
    { label: GRATUITY_LABEL, amount: 40 },
  ],
  adjustments: [DISCOUNT_A],
  gratuity: { rate: 10, tip_jar: true, staff_count: 1, hours: 4, staff_noun: 'bartender', total: 40, floor_rate: null },
  subtotal: 1250,
  total: 1240,
});

after(async () => {
  if (seededProposals.length) {
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = ANY($1::int[])', [seededProposals]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [seededProposals]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [seededProposals]);
  }
  if (seededClients.length) {
    await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [seededClients]);
  }
  await pool.end();
});

test('appends the line to the row and the snapshot, its row just before the client Gratuity row, and lowers the snapshot total', async () => {
  const id = await seedBooking({ adjustments: [DISCOUNT_A], snapshot: fullSnapshot() });
  const refundId = await seedRefundRow(id);
  assert.equal(typeof refundId, 'number'); // proposal_refunds.id is int4: pg returns a number

  const out = await append({ proposalId: id, refundId, contractCents: 28500 });
  assert.equal(out.written, true);

  const row = await readRow(id);
  assert.deepEqual(row.adjustments, [DISCOUNT_A, refundLine(refundId)]);
  assert.equal(typeof row.adjustments[1].refund_id, 'number'); // never a string

  const want = fullSnapshot();
  want.adjustments = [DISCOUNT_A, refundLine(refundId)];
  want.breakdown = [...want.breakdown.slice(0, 4), refundRow(), want.breakdown[4]];
  want.total = 955; // 1240 - 285; every other snapshot key untouched
  assert.deepEqual(row.pricing_snapshot, want);

  // The next editor save reads this list through the one validator unchanged.
  const v = validateAdjustments(row.adjustments);
  assert.equal(v.error, null);
  assert.deepEqual(v.value, row.adjustments);

  // The money columns belong to the caller's own UPDATE.
  assert.equal(Number(row.total_price), 1240);
});

test('the snapshot total floors at 0, and with no client gratuity the row is appended', async () => {
  const snapshot = {
    breakdown: [{ label: 'Test Package (2hrs, 20 guests)', amount: 100 }],
    adjustments: [],
    gratuity: { total: 0 },
    subtotal: 100,
    total: 100,
  };
  const id = await seedBooking({ snapshot, totalPrice: 100 });
  const refundId = await seedRefundRow(id);
  assert.equal((await append({ proposalId: id, refundId, contractCents: 28500 })).written, true);
  const row = await readRow(id);
  assert.deepEqual(row.pricing_snapshot.breakdown, [snapshot.breakdown[0], refundRow()]);
  assert.equal(row.pricing_snapshot.total, 0);
});

test('a snapshot with no breakdown gains the line in its adjustments only: never a Refund-only breakdown, never a total', async () => {
  // {} is the column default; the legacy shape stands for older stored rows.
  // A NULL adjustments column reads as empty.
  const legacy = { package_total: 1000, bartender_total: 240 };
  for (const [adjustments, snapshot] of [[[], {}], [null, {}], [[], legacy]]) {
    const id = await seedBooking({ adjustments, snapshot });
    const refundId = await seedRefundRow(id);
    assert.equal((await append({ proposalId: id, refundId, contractCents: 28500 })).written, true);
    const row = await readRow(id);
    assert.deepEqual(row.adjustments, [refundLine(refundId)]);
    assert.deepEqual(row.pricing_snapshot, { ...snapshot, adjustments: [refundLine(refundId)] });
  }
});

test('writes nothing for a zero or negative contract amount, silently', async () => {
  const id = await seedBooking({ adjustments: [DISCOUNT_A], snapshot: fullSnapshot() });
  const refundId = await seedRefundRow(id);
  const before = await readRow(id);
  for (const contractCents of [0, -100]) {
    const { out, logged } = await withErrorsCaptured(() => append({ proposalId: id, refundId, contractCents }));
    assert.deepEqual(out, { written: false, reason: 'no_contract_amount' });
    assert.deepEqual(logged, []); // an expected skip
  }
  assert.deepEqual(await readRow(id), before); // no UPDATE at all: updated_at unmoved
});

test('writes nothing on a legal-hold booking, read from the loaded row however its id is spelled, silently', async () => {
  const id = await seedBooking({ adjustments: [DISCOUNT_A], snapshot: fullSnapshot() });
  const refundId = await seedRefundRow(id);
  const before = await readRow(id);
  __setLegalHoldIdsForTest([id]);
  // Postgres reads '1_2345' as 12345, where Number() gives NaN.
  const spelled = String(id).replace(/^(\d)(\d)/, '$1_$2');
  for (const proposalId of [id, String(id), spelled]) {
    const { out, logged } = await withErrorsCaptured(() => append({ proposalId, refundId, contractCents: 28500 }));
    assert.deepEqual(out, { written: false, reason: 'legal_hold' });
    assert.deepEqual(logged, []); // the hold is known; nothing to report
  }
  assert.deepEqual(await readRow(id), before);
});

test('a hold check that throws counts as held: no line, reported, never thrown', async () => {
  // The scenario: a refactor moves the list out of staleProposalSweep.js, so
  // isLegalHold throws. The line is skipped; the caller's money must not be.
  const sweep = require('./staleProposalSweep');
  const real = sweep.LEGAL_HOLD_PROPOSAL_IDS;
  const id = await seedBooking({ adjustments: [DISCOUNT_A], snapshot: fullSnapshot() });
  const refundId = await seedRefundRow(id);
  const before = await readRow(id);
  sweep.LEGAL_HOLD_PROPOSAL_IDS = undefined;
  let result;
  try {
    result = await withErrorsCaptured(() => append({ proposalId: id, refundId, contractCents: 28500 }));
  } finally {
    sweep.LEGAL_HOLD_PROPOSAL_IDS = real;
  }
  assert.deepEqual(result.out, { written: false, reason: 'legal_hold_unknown' });
  assert.ok(result.logged.some((m) => m.includes('legal_hold_unknown')), result.logged.join('\n'));
  assert.deepEqual(await readRow(id), before);
});

test('a second call for the same refund writes nothing (found by refund_id) and is reported', async () => {
  const id = await seedBooking({ adjustments: [DISCOUNT_A], snapshot: fullSnapshot() });
  const refundId = await seedRefundRow(id);
  assert.equal((await append({ proposalId: id, refundId, contractCents: 28500 })).written, true);
  const once = await readRow(id);
  const { out, logged } = await withErrorsCaptured(() => append({ proposalId: id, refundId, contractCents: 28500 }));
  assert.deepEqual(out, { written: false, reason: 'already_written' });
  // No real path reaches this (the reconciler returns first), so it is never silent.
  assert.ok(logged.some((m) => m.includes('already_written') && m.includes(String(refundId))), logged.join('\n'));
  const twice = await readRow(id);
  assert.deepEqual(twice, once);
  assert.equal(twice.adjustments.filter((a) => a.refund_id === refundId).length, 1);
  assert.equal(twice.pricing_snapshot.breakdown.filter((r) => r.label === 'Refund').length, 1);
  assert.equal(twice.pricing_snapshot.total, 955); // lowered once
});

test('a line planted with the refund\'s id (any source, even as a string) never silently suppresses its line', async () => {
  const planted = [
    { type: 'discount', label: 'Test planted A', amount: 0, visible: false, refund_id: 0 },
    { type: 'discount', label: 'Test planted B', amount: 0, visible: false, source: 'agreed_price', refund_id: 0 },
  ];
  for (const plant of planted) {
    const id = await seedBooking({ adjustments: [DISCOUNT_A], snapshot: fullSnapshot() });
    const refundId = await seedRefundRow(id);
    for (const spelledId of [refundId, String(refundId)]) {
      await pool.query('UPDATE proposals SET adjustments = $2::jsonb WHERE id = $1',
        [id, JSON.stringify([DISCOUNT_A, { ...plant, refund_id: spelledId }])]);
      const { out, logged } = await withErrorsCaptured(() => append({ proposalId: id, refundId, contractCents: 28500 }));
      assert.deepEqual(out, { written: false, reason: 'already_written' });
      assert.ok(logged.some((m) => m.includes('already_written')), logged.join('\n'));
    }
  }
});

test('never stores a line the editor would refuse: a string or out-of-range refund id, a fraction of a cent (reported)', async () => {
  const id = await seedBooking({ adjustments: [DISCOUNT_A], snapshot: fullSnapshot() });
  const refundId = await seedRefundRow(id);
  const before = await readRow(id);
  const bad = [
    { refundId: String(refundId), contractCents: 28500 },
    { refundId: 0, contractCents: 28500 },
    { refundId: 2 ** 31, contractCents: 28500 },
    { refundId, contractCents: 28500.5 },
  ];
  for (const b of bad) {
    const { out, logged } = await withErrorsCaptured(() => append({ proposalId: id, ...b }));
    assert.deepEqual(out, { written: false, reason: 'invalid_line' }, JSON.stringify(b));
    assert.ok(logged.some((m) => m.includes('invalid_line')), JSON.stringify(b));
  }
  assert.deepEqual(await readRow(id), before);
});

test('never overwrites a stored shape it cannot read (reported)', async () => {
  const shapes = [
    { adjustments: { not: 'a list' }, snapshot: fullSnapshot() },
    { adjustments: [DISCOUNT_A], snapshot: [] },
    { adjustments: [DISCOUNT_A], snapshot: { ...fullSnapshot(), adjustments: 'x' } },
    { adjustments: [DISCOUNT_A], snapshot: { ...fullSnapshot(), breakdown: { not: 'a list' } } },
  ];
  for (const s of shapes) {
    const id = await seedBooking(s);
    const refundId = await seedRefundRow(id);
    const before = await readRow(id);
    const { out, logged } = await withErrorsCaptured(() => append({ proposalId: id, refundId, contractCents: 28500 }));
    assert.deepEqual(out, { written: false, reason: 'unreadable' }, JSON.stringify(s).slice(0, 80));
    assert.ok(logged.some((m) => m.includes('unreadable')), JSON.stringify(s).slice(0, 80));
    assert.deepEqual(await readRow(id), before);
  }
});
