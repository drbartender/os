'use strict';

// Run: DOTENV_CONFIG_PATH=<os>/.env node -r dotenv/config --test server/utils/groupSend.test.js
process.env.SEND_NOTIFICATIONS = 'false';
const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { addAlternative } = require('./proposalGroups');
const { sendGroup } = require('./groupSend');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const proposalIds = new Set();
const groupIds = new Set();
const clientIds = new Set();

async function seedGroup() {
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ('GS Test', $1) RETURNING id`,
    [`gs-${NONCE}-${clientIds.size}@example.com`]);
  clientIds.add(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, deposit_amount, pricing_snapshot)
     VALUES ($1, 'draft', 100, 100, '{}'::jsonb) RETURNING id`, [c.rows[0].id]);
  proposalIds.add(p.rows[0].id);
  const { groupId, newProposalId } = await addAlternative(p.rows[0].id, null, pool);
  groupIds.add(groupId);
  proposalIds.add(newProposalId);
  return { groupId, ids: [p.rows[0].id, newProposalId] };
}

after(async () => {
  const pids = [...proposalIds];
  if (pids.length) {
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('UPDATE proposals SET group_id = NULL WHERE id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [pids]);
  }
  for (const gid of groupIds) await pool.query('DELETE FROM proposal_groups WHERE id = $1', [gid]);
  if (pids.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [pids]);
  if (clientIds.size) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [[...clientIds]]);
  await pool.end();
});

test('sendGroup transitions all draft members to sent and creates NO invoices (deferred)', async () => {
  const { groupId, ids } = await seedGroup();
  const { sentCount } = await sendGroup(groupId, { actorUserId: null });
  assert.strictEqual(sentCount, 2, 'both draft options were sent');
  const { rows } = await pool.query('SELECT status FROM proposals WHERE id = ANY($1::int[])', [ids]);
  assert.ok(rows.every((r) => r.status === 'sent'), 'every option is now sent');
  const inv = await pool.query('SELECT COUNT(*)::int AS n FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
  assert.strictEqual(inv.rows[0].n, 0, 'no per-option invoices at group send (deferred to the winner)');
});

test('sendGroup is idempotent — a resend with no new draft options sends nothing', async () => {
  const { groupId } = await seedGroup();
  await sendGroup(groupId, {});
  const second = await sendGroup(groupId, {});
  assert.strictEqual(second.sentCount, 0, 'no newly-sent members on the second call');
});
