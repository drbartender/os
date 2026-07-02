'use strict';

// Run: DOTENV_CONFIG_PATH=<os>/.env node -r dotenv/config --test server/utils/proposalGroupCommit.test.js
const { test, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { addAlternative } = require('./proposalGroups');
const { commitGroupChoice, sweepClientAlternatives } = require('./proposalGroupCommit');

const proposalIds = new Set();
const groupIds = new Set();
const invoiceIds = new Set();
const clientIds = new Set();
let invSeq = 0;

async function insertClient() {
  const { rows: [c] } = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Sweep Test', $1) RETURNING id`,
    [`sweep-${Date.now()}-${clientIds.size}@example.com`]);
  clientIds.add(c.id);
  return c.id;
}

async function insertProposal(fields = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (status, amount_paid, pricing_snapshot, total_price, client_id)
     VALUES ($1, $2, '{}'::jsonb, 1000, $3) RETURNING *`,
    [fields.status || 'sent', fields.amount_paid || 0, fields.client_id || null]);
  proposalIds.add(p.id);
  return p;
}

async function insertInvoice(proposalId, { status = 'sent', amount_paid = 0, amount_due = 10000 } = {}) {
  invSeq += 1;
  const { rows: [i] } = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [proposalId, `TEST-VC-${invSeq}`, amount_due, amount_paid, status]);
  invoiceIds.add(i.id);
  return i;
}

// Seed a 2-option group via the (already-merged) addAlternative helper.
async function seedGroup() {
  const src = await insertProposal({ status: 'sent' });
  const { groupId, newProposalId } = await addAlternative(src.id, 1, pool);
  groupIds.add(groupId);
  proposalIds.add(newProposalId);
  return { groupId, winnerId: src.id, loserId: newProposalId };
}

async function inTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally {
    client.release();
  }
}

after(async () => {
  const pids = [...proposalIds];
  if (invoiceIds.size) await pool.query('DELETE FROM invoices WHERE id = ANY($1)', [[...invoiceIds]]);
  if (pids.length) {
    await pool.query('UPDATE proposals SET group_id = NULL WHERE id = ANY($1)', [pids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [pids]);
  }
  for (const gid of groupIds) await pool.query('DELETE FROM proposal_groups WHERE id = $1', [gid]);
  if (pids.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [pids]);
  if (clientIds.size) await pool.query('DELETE FROM clients WHERE id = ANY($1)', [[...clientIds]]);
  await pool.end();
});

test('solo proposal is a no-op', async () => {
  const solo = await insertProposal({ status: 'sent' });
  const res = await inTx((c) => commitGroupChoice(solo.id, c));
  assert.deepStrictEqual(res, { committed: false, conflict: false, archivedLoserIds: [] });
});

test('winner commit: chosen set, loser archived + invoice voided', async () => {
  const { groupId, winnerId, loserId } = await seedGroup();
  await insertInvoice(loserId, { status: 'sent', amount_paid: 0 }); // retroactive dangling invoice

  const res = await inTx((c) => commitGroupChoice(winnerId, c));
  assert.strictEqual(res.committed, true);
  assert.strictEqual(res.conflict, false);
  assert.deepStrictEqual(res.archivedLoserIds, [loserId]);

  const { rows: [g] } = await pool.query('SELECT chosen_proposal_id FROM proposal_groups WHERE id = $1', [groupId]);
  assert.strictEqual(g.chosen_proposal_id, winnerId, 'group is decided to the winner');
  const { rows: [loser] } = await pool.query('SELECT status, archive_reason FROM proposals WHERE id = $1', [loserId]);
  assert.strictEqual(loser.status, 'archived');
  assert.strictEqual(loser.archive_reason, 'option_not_chosen');
  const { rows: [inv] } = await pool.query('SELECT status FROM invoices WHERE proposal_id = $1', [loserId]);
  assert.strictEqual(inv.status, 'void', "loser's unpaid invoice is voided");
});

test('second option paying after decision is a conflict, no re-archive', async () => {
  const { winnerId, loserId } = await seedGroup();
  await inTx((c) => commitGroupChoice(winnerId, c));           // winner decides
  const res = await inTx((c) => commitGroupChoice(loserId, c)); // loser tries to pay
  assert.strictEqual(res.conflict, true);
  assert.strictEqual(res.committed, false);
});

test('idempotent replay of the same winner does not re-commit', async () => {
  const { winnerId } = await seedGroup();
  await inTx((c) => commitGroupChoice(winnerId, c));
  const res = await inTx((c) => commitGroupChoice(winnerId, c));
  assert.deepStrictEqual(res, { committed: false, conflict: false, archivedLoserIds: [] });
});

// ── sweepClientAlternatives (ungrouped same-client sweep) ────────────────────

test('sweep archives the same-client open alternative and voids its invoice', async () => {
  const clientId = await insertClient();
  const winner = await insertProposal({ status: 'sent', client_id: clientId });
  const alt = await insertProposal({ status: 'draft', client_id: clientId });
  await insertInvoice(alt.id, { status: 'sent', amount_paid: 0 });

  const { sweptIds } = await inTx((c) => sweepClientAlternatives(winner.id, c));
  assert.deepStrictEqual(sweptIds, [alt.id]);

  const { rows: [swept] } = await pool.query('SELECT status, archive_reason FROM proposals WHERE id = $1', [alt.id]);
  assert.strictEqual(swept.status, 'archived');
  assert.strictEqual(swept.archive_reason, 'option_not_chosen');
  const { rows: [inv] } = await pool.query('SELECT status FROM invoices WHERE proposal_id = $1', [alt.id]);
  assert.strictEqual(inv.status, 'void', "swept alternative's unpaid invoice is voided");
});

test('sweep never touches other clients, paid siblings, or converted siblings', async () => {
  const clientId = await insertClient();
  const otherClientId = await insertClient();
  const winner = await insertProposal({ status: 'sent', client_id: clientId });
  const paidSibling = await insertProposal({ status: 'sent', amount_paid: 100, client_id: clientId });
  const converted = await insertProposal({ status: 'deposit_paid', client_id: clientId });
  const otherClients = await insertProposal({ status: 'draft', client_id: otherClientId });

  const { sweptIds } = await inTx((c) => sweepClientAlternatives(winner.id, c));
  assert.deepStrictEqual(sweptIds, [], 'nothing eligible to sweep');

  for (const [id, expected] of [[paidSibling.id, 'sent'], [converted.id, 'deposit_paid'], [otherClients.id, 'draft']]) {
    const { rows: [p] } = await pool.query('SELECT status FROM proposals WHERE id = $1', [id]);
    assert.strictEqual(p.status, expected, `proposal ${id} must be untouched`);
  }
});

test('sweep is a no-op for a clientless winner', async () => {
  const winner = await insertProposal({ status: 'sent' });
  const { sweptIds } = await inTx((c) => sweepClientAlternatives(winner.id, c));
  assert.deepStrictEqual(sweptIds, []);
});
