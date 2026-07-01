'use strict';

// Run: DOTENV_CONFIG_PATH=<os>/.env node -r dotenv/config --test server/utils/proposalGroups.test.js
// (the lane worktree has no .env of its own; point dotenv at the os checkout)

const { test, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const {
  addAlternative, removeAlternative, getGroupMembers, MAX_OPTIONS,
} = require('./proposalGroups');

const createdProposalIds = new Set();
const createdGroupIds = new Set();

async function insertSource(fields = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (status, amount_paid, pricing_snapshot, total_price)
     VALUES ($1, $2, '{}'::jsonb, 1000) RETURNING *`,
    [fields.status || 'sent', fields.amount_paid || 0]);
  createdProposalIds.add(p.id);
  return p;
}

after(async () => {
  // Clean up everything created, FK-safe: null out group links, drop activity
  // rows, then delete proposals and groups.
  for (const gid of createdGroupIds) {
    const { rows } = await pool.query('SELECT id FROM proposals WHERE group_id = $1', [gid]);
    rows.forEach((r) => createdProposalIds.add(r.id));
  }
  const ids = [...createdProposalIds];
  if (ids.length) {
    await pool.query('UPDATE proposals SET group_id = NULL WHERE id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [ids]);
  }
  for (const gid of createdGroupIds) {
    await pool.query('DELETE FROM proposal_groups WHERE id = $1', [gid]);
  }
  if (ids.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids]);
  await pool.end();
});

test('addAlternative clones a groupable proposal into a new 2-member group', async () => {
  const src = await insertSource({ status: 'sent' });
  const { groupId, groupToken, newProposalId } = await addAlternative(src.id, 1, pool);
  createdGroupIds.add(groupId);
  createdProposalIds.add(newProposalId);

  assert.ok(groupToken, 'returns a group token');
  const members = await getGroupMembers(groupId);
  assert.strictEqual(members.length, 2, 'source + clone are both in the group');
  assert.ok(members.find((m) => m.id === src.id), 'source is a member');
  assert.ok(members.find((m) => m.id === newProposalId), 'clone is a member');

  const { rows: [clone] } = await pool.query('SELECT group_id FROM proposals WHERE id = $1', [newProposalId]);
  assert.strictEqual(clone.group_id, groupId, 'clone.group_id was set (insertProposalRecord does not set it)');
});

test('addAlternative rejects a paid source', async () => {
  const src = await insertSource({ status: 'deposit_paid', amount_paid: 100 });
  await assert.rejects(() => addAlternative(src.id, 1, pool), /can no longer take alternatives/i);
});

test('addAlternative rejects a non-groupable status', async () => {
  const src = await insertSource({ status: 'completed' });
  await assert.rejects(() => addAlternative(src.id, 1, pool), /can no longer take alternatives/i);
});

test(`addAlternative enforces the ${MAX_OPTIONS}-option cap`, async () => {
  const src = await insertSource({ status: 'sent' });
  const first = await addAlternative(src.id, 1, pool);   // -> 2 members
  createdGroupIds.add(first.groupId);
  createdProposalIds.add(first.newProposalId);
  const second = await addAlternative(src.id, 1, pool);  // -> 3 members
  createdProposalIds.add(second.newProposalId);
  await assert.rejects(() => addAlternative(src.id, 1, pool), /at most/i, 'the 4th option is rejected');
});

test('removeAlternative dissolves a 2-member group and frees the survivor', async () => {
  const src = await insertSource({ status: 'sent' });
  const { groupId, newProposalId } = await addAlternative(src.id, 1, pool);
  createdGroupIds.add(groupId);
  createdProposalIds.add(newProposalId);

  const { dissolved } = await removeAlternative(newProposalId, 1, pool);
  assert.strictEqual(dissolved, true, 'dropping to one member dissolves the group');

  const { rows: [survivor] } = await pool.query('SELECT group_id FROM proposals WHERE id = $1', [src.id]);
  assert.strictEqual(survivor.group_id, null, 'survivor reverts to solo');
  const { rows: grp } = await pool.query('SELECT id FROM proposal_groups WHERE id = $1', [groupId]);
  assert.strictEqual(grp.length, 0, 'the group row is deleted');
});
