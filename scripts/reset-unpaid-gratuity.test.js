require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../server/db');
const { resetUnpaidGratuity } = require('./reset-unpaid-gratuity');

if (process.env.NODE_ENV === 'production') {
  throw new Error('reset-unpaid-gratuity.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const ids = { clients: [], proposals: [] };
const SNAP = (g) => ({
  total: 450 + g, staff_noun: 'bartender',
  breakdown: [{ label: 'Pkg', amount: 450 }, ...(g ? [{ label: 'Gratuity', amount: g }] : [])],
  gratuity: { rate: g ? 50 : 0, tip_jar: !g, staff_count: 1, hours: 5, total: g },
});
async function seed({ amountPaid, gratuity }) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Grat Reset Test', $1) RETURNING id`,
    [`grat-reset-${NONCE}-${ids.clients.length}@example.com`]);
  ids.clients.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid,
                            tip_jar, gratuity_rate, event_duration_hours, pricing_snapshot, token)
     VALUES ($1, 'viewed', 'wedding', $2, $3, $4, $5, 5, $6, $7) RETURNING id`,
    [c.rows[0].id, 450 + gratuity, amountPaid, gratuity === 0, gratuity ? 50 : 0,
     JSON.stringify(SNAP(gratuity)), crypto.randomUUID()]);
  ids.proposals.push(p.rows[0].id);
  return p.rows[0].id;
}

test('resets unpaid gratuity rows, never paid ones; dry run writes nothing', async () => {
  const unpaidId = await seed({ amountPaid: 0, gratuity: 250 });
  const paidId = await seed({ amountPaid: 100, gratuity: 250 });

  const dry = await resetUnpaidGratuity({ apply: false });
  assert.ok(dry.changed.some(r => r.id === unpaidId));
  assert.ok(!dry.changed.some(r => r.id === paidId), 'paid row never listed');
  let row = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [unpaidId])).rows[0];
  assert.equal(Number(row.total_price), 700, 'dry run wrote nothing');

  await resetUnpaidGratuity({ apply: true });
  row = (await pool.query(
    'SELECT tip_jar, gratuity_rate, total_price, pricing_snapshot FROM proposals WHERE id = $1',
    [unpaidId])).rows[0];
  assert.equal(row.tip_jar, true);
  assert.equal(Number(row.gratuity_rate), 0);
  assert.equal(Number(row.total_price), 450);
  assert.ok(!row.pricing_snapshot.breakdown.some(l => l.label === 'Gratuity'));
  const paid = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [paidId])).rows[0];
  assert.equal(Number(paid.total_price), 700, 'paid row untouched');
});

// Raw seed for the drift-shaped fixtures below: the caller supplies the exact
// column values AND snapshot, because these cases are ABOUT the two disagreeing.
async function seedRaw({ totalPrice, tipJar, rate, hours = 5, snapshot }) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Grat Reset Test', $1) RETURNING id`,
    [`grat-reset-${NONCE}-${ids.clients.length}@example.com`]);
  ids.clients.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid,
                            tip_jar, gratuity_rate, event_duration_hours, pricing_snapshot, token)
     VALUES ($1, 'viewed', 'wedding', $2, 0, $3, $4, $5, $6, $7) RETURNING id`,
    [c.rows[0].id, totalPrice, tipJar, rate, hours, JSON.stringify(snapshot), crypto.randomUUID()]);
  ids.proposals.push(p.rows[0].id);
  return p.rows[0].id;
}
const columnsOf = async (id) => (await pool.query(
  'SELECT total_price, tip_jar, gratuity_rate FROM proposals WHERE id = $1', [id])).rows[0];
function assertUntouched(before, after, label) {
  assert.equal(String(after.total_price), String(before.total_price), `${label}: total_price untouched`);
  assert.equal(after.tip_jar, before.tip_jar, `${label}: tip_jar untouched`);
  assert.equal(String(after.gratuity_rate), String(before.gratuity_rate), `${label}: gratuity_rate untouched`);
}

// A legacy '{}' snapshot resolves no gratuity basis, so recomputeSnapshotGratuity
// returns total 0 — writing that would ZERO a real proposal's price. The script
// must refuse the row instead, mirroring the webhook's degenerate_snapshot guard.
test('degenerate snapshot: reported as skipped, never written', async () => {
  const id = await seedRaw({ totalPrice: 450, tipJar: false, rate: 50, snapshot: {} });
  const before = await columnsOf(id);

  const dry = await resetUnpaidGratuity({ apply: false });
  assert.equal(dry.skipped.find(r => r.id === id)?.reason, 'degenerate_snapshot');
  assert.ok(!dry.changed.some(r => r.id === id), 'never listed as changed');

  await resetUnpaidGratuity({ apply: true });
  assertUntouched(before, await columnsOf(id), 'degenerate snapshot');
});

// The snapshot's ONLY line is the gratuity, so stripping it would leave total 0.
// A $0 service total means the ROW is wrong, not that we should write $0.
test('degenerate result: gratuity-only snapshot is skipped, never zeroed', async () => {
  const id = await seedRaw({
    totalPrice: 250, tipJar: false, rate: 50, hours: 5,
    snapshot: { total: 250, staff_noun: 'bartender',
      breakdown: [{ label: 'Gratuity', amount: 250 }],
      gratuity: { rate: 50, tip_jar: false, staff_count: 1, hours: 5, total: 250 } },
  });
  const before = await columnsOf(id);

  const dry = await resetUnpaidGratuity({ apply: false });
  assert.equal(dry.skipped.find(r => r.id === id)?.reason, 'degenerate_result');
  assert.ok(!dry.changed.some(r => r.id === id), 'never listed as changed');

  await resetUnpaidGratuity({ apply: true });
  assertUntouched(before, await columnsOf(id), 'degenerate result');
});

// Proposal 580's shape: a ZERO column rate, but the snapshot and total_price both
// carry a $200 gratuity. The broadened WHERE exists for exactly this row.
test('580-shape: snapshot-carried gratuity with a zero column is reset', async () => {
  const id = await seedRaw({
    totalPrice: 650, tipJar: true, rate: 0, hours: 4,
    snapshot: { total: 650, staff_noun: 'bartender',
      breakdown: [{ label: 'Pkg', amount: 450 }, { label: 'Gratuity', amount: 200 }],
      gratuity: { rate: 50, tip_jar: false, staff_count: 1, hours: 4, total: 200 } },
  });

  const dry = await resetUnpaidGratuity({ apply: false });
  const line = dry.changed.find(r => r.id === id);
  assert.ok(line, 'snapshot-carried gratuity matched by the broadened WHERE');
  assert.equal(line.from, 650);
  assert.equal(line.to, 450, 'total drops by the snapshot gratuity');

  await resetUnpaidGratuity({ apply: true });
  const after = await columnsOf(id);
  assert.equal(Number(after.total_price), 450);
  assert.equal(after.tip_jar, true);
  assert.equal(Number(after.gratuity_rate), 0);
});

// Column/snapshot drift (archived #500's 300-vs-400 shape): the snapshot is not
// the authority for that row, so recomputing from it would write a wrong total.
test('total mismatch: snapshot total disagrees with total_price, skipped', async () => {
  const id = await seedRaw({
    totalPrice: 300, tipJar: false, rate: 50, hours: 5,
    snapshot: { total: 400, staff_noun: 'bartender',
      breakdown: [{ label: 'Pkg', amount: 150 }, { label: 'Gratuity', amount: 250 }],
      gratuity: { rate: 50, tip_jar: false, staff_count: 1, hours: 5, total: 250 } },
  });
  const before = await columnsOf(id);

  const dry = await resetUnpaidGratuity({ apply: false });
  assert.equal(dry.skipped.find(r => r.id === id)?.reason, 'total_mismatch');
  assert.ok(!dry.changed.some(r => r.id === id), 'never listed as changed');

  await resetUnpaidGratuity({ apply: true });
  assertUntouched(before, await columnsOf(id), 'total mismatch');
});

after(async () => {
  await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids.proposals]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [ids.clients]);
  await pool.end();
});
