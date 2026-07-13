require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const crypto = require('node:crypto');
const { pool } = require('../../db');
const proposalsRouter = require('./index');
const { addAlternative } = require('../../utils/proposalGroups');
const { AppError } = require('../../utils/errors');

if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const groupIds = [];
const clientIds = [];

async function seedGroup({ bothSent }) {
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ('CMP Test', $1) RETURNING id`,
    [`cmp-${NONCE}-${clientIds.length}@example.com`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, deposit_amount, view_count, event_type)
     VALUES ($1, $2, 100, 100, 5, 'wedding') RETURNING id, token, view_count`,
    [c.rows[0].id, bothSent ? 'sent' : 'draft']);
  proposalIds.push(p.rows[0].id);
  const { groupId, groupToken, newProposalId } = await addAlternative(p.rows[0].id, null, pool);
  groupIds.push(groupId);
  proposalIds.push(newProposalId);
  if (bothSent) {
    await pool.query(`UPDATE proposals SET status = 'sent' WHERE id = $1`, [newProposalId]);
  }
  return { groupId, groupToken, sourceId: p.rows[0].id, sourceToken: p.rows[0].token, cloneId: newProposalId };
}

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.end();
  });
}

before(async () => {
  const app = express();
  app.use('/api/proposals', proposalsRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode || 400).json({ error: err.message, code: err.code });
    console.error(err); return res.status(500).json({ error: 'server error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  const pids = proposalIds;
  if (pids.length) {
    await pool.query('UPDATE proposals SET group_id = NULL WHERE id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [pids]);
  }
  if (groupIds.length) await pool.query('DELETE FROM proposal_groups WHERE id = ANY($1::int[])', [groupIds]);
  if (pids.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [pids]);
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('resolver reports group membership WITHOUT mutating view_count', async () => {
  const { groupToken, sourceToken, sourceId } = await seedGroup({ bothSent: true });
  const before = (await pool.query('SELECT view_count FROM proposals WHERE id = $1', [sourceId])).rows[0].view_count;
  const r = await get(`/api/proposals/t/${sourceToken}/resolve`);
  assert.equal(r.status, 200, r.body);
  const j = JSON.parse(r.body);
  assert.equal(j.grouped, true);
  assert.equal(j.group_token, groupToken);
  assert.equal(j.decided, false);
  const after = (await pool.query('SELECT view_count FROM proposals WHERE id = $1', [sourceId])).rows[0].view_count;
  assert.equal(after, before, 'resolver must NOT bump view_count (it is the non-mutating path)');
});

test('compare GET returns visible options with a shared header and NO PII', async () => {
  const { groupToken } = await seedGroup({ bothSent: true });
  const r = await get(`/api/proposals/group/${groupToken}`);
  assert.equal(r.status, 200, r.body);
  const j = JSON.parse(r.body);
  assert.equal(j.options.length, 2, 'both sent options are visible');
  assert.ok(j.event_header && j.event_header.event_type === 'wedding', 'shared header present');
  for (const o of j.options) {
    for (const leaky of ['admin_notes', 'stripe_customer_id', 'stripe_payment_method_id', 'client_signature_data', 'client_signature_ip']) {
      assert.ok(!(leaky in o), `option must not expose ${leaky}`);
    }
    assert.ok('package_slug' in o && 'total_price' in o && 'pricing_type' in o, 'option has the compare fields');
    assert.ok('package_id' in o, 'option exposes package_id');
    // The compare matrix renders the STORED total (never a live reprice) and
    // derives the minimum note from the STORED snapshot's floor fields — the
    // keys are always present (null/false when the snapshot lacks them).
    assert.equal(Number(o.total_price), 100, 'stored total_price is threaded through as-is');
    for (const k of ['floor_reason', 'billed_guests', 'floor_applied']) {
      assert.ok(k in o, `option carries stored snapshot field ${k}`);
    }
    assert.equal(o.floor_reason, null, 'empty snapshot yields null floor_reason');
    assert.equal(o.floor_applied, false, 'empty snapshot yields floor_applied false');
  }
});

test('compare GET 404s while every option is an unsent draft', async () => {
  const { groupToken } = await seedGroup({ bothSent: false });
  const r = await get(`/api/proposals/group/${groupToken}`);
  assert.equal(r.status, 404, `all-draft group should 404, got ${r.status} ${r.body}`);
});

test('admin preview requires auth', async () => {
  const { groupToken } = await seedGroup({ bothSent: false });
  const r = await get(`/api/proposals/group/${groupToken}/preview`);
  assert.ok(r.status === 401 || r.status === 403, `preview must be blocked without a token, got ${r.status}`);
});
