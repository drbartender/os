// Route-level tests for the archived door-close on the public proposal token.
//
// The defect: an archived proposal rendered its full LIVE page — Sign & Pay and
// all — to any client holding an emailed link, and signing then returned a
// misleading "already been accepted" 409. The stale-proposal sweep turned that
// from a manual-archive edge into ~160 live tokens at once.
//
// Two behaviours are pinned here and they pull in OPPOSITE directions, which is
// the whole reason this file exists:
//   1. GET /t/:token must NOT serve an archived proposal (404).
//   2. GET /t/:token/resolve MUST still answer for one, because that is how a
//      client holding a losing option's link gets redirected to the option they
//      actually chose. Filtering resolve too would strand exactly the clients
//      the redirect exists to rescue.
//
// Harness mirrors publicToken.test.js: a fresh express() app mounts the real
// router plus the AppError-aware error handler, driven over real HTTP against
// the dev DB (DATABASE_URL from .env). Creates real rows, purges them in after().

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const publicTokenRouter = require('./publicToken');

let server;
let baseUrl;
const createdProposalIds = new Set();
const createdClientIds = new Set();
const createdGroupIds = new Set();

function request(method, path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function insertClient(label) {
  const r = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    [label, `arch+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`]
  );
  createdClientIds.add(r.rows[0].id);
  return r.rows[0].id;
}

/** A complete, renderable proposal at whatever status/reason the caller wants. */
async function insertProposal({ status = 'viewed', archiveReason = null, groupId = null } = {}) {
  const clientId = await insertClient('Archived Door Test');
  const token = crypto.randomUUID();
  const snapshot = JSON.stringify({ package: { name: 'Test', base_cost: 500 }, total: 500 });
  const r = await pool.query(
    `INSERT INTO proposals
       (client_id, token, guest_count, event_duration_hours, num_bars,
        pricing_snapshot, total_price, payment_type, status, archive_reason,
        event_type, venue_street, venue_city, venue_state, group_id)
     VALUES ($1, $2, 120, 4, 1, $3, 500, 'full', $4, $5, 'Wedding',
        '123 Test St', 'Rockford', 'IL', $6)
     RETURNING id, token`,
    [clientId, token, snapshot, status, archiveReason, groupId]
  );
  createdProposalIds.add(r.rows[0].id);
  return r.rows[0];
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', publicTokenRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (createdProposalIds.size > 0) {
    const ids = [...createdProposalIds];
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('UPDATE proposal_groups SET chosen_proposal_id = NULL WHERE chosen_proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids]);
  }
  if (createdGroupIds.size > 0) {
    await pool.query('DELETE FROM proposal_groups WHERE id = ANY($1)', [[...createdGroupIds]]);
  }
  if (createdClientIds.size > 0) {
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [[...createdClientIds]]);
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// The negative control, and it is not ceremony: without it, a fixture that
// silently failed to insert would make every 404 assertion below pass for the
// wrong reason.
test('a LIVE proposal still serves its full payload', async () => {
  const p = await insertProposal({ status: 'viewed' });
  const res = await request('GET', `/api/proposals/t/${p.token}`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  assert.equal(res.body.token, p.token);
  assert.equal(res.body.total_price, '500.00');
});

test('an archived proposal 404s instead of rendering a live page', async () => {
  const p = await insertProposal({ status: 'archived', archiveReason: 'event_passed' });
  const res = await request('GET', `/api/proposals/t/${p.token}`);
  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${res.raw}`);
});

// The side-effect half. The bump is a separate statement running in the same
// Promise.all as the builder, so it does NOT inherit the builder's filter and
// had to be given the same one. Without it a 404 still records a view of a page
// nobody was shown. Two-sided on purpose: asserting the archived row alone would
// pass identically if the bump had simply been deleted.
test('a 404 does not record a view, while a real view still does', async () => {
  const archived = await insertProposal({ status: 'archived', archiveReason: 'event_passed' });
  const before = await pool.query(
    'SELECT view_count, last_viewed_at FROM proposals WHERE id = $1', [archived.id]
  );
  const res = await request('GET', `/api/proposals/t/${archived.token}`);
  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${res.raw}`);
  const after = await pool.query(
    'SELECT view_count, last_viewed_at FROM proposals WHERE id = $1', [archived.id]
  );
  assert.equal(after.rows[0].view_count, before.rows[0].view_count,
    'an archived 404 must not increment view_count');
  assert.deepEqual(after.rows[0].last_viewed_at, before.rows[0].last_viewed_at,
    'an archived 404 must not stamp last_viewed_at');

  const live = await insertProposal({ status: 'viewed' });
  const liveBefore = await pool.query('SELECT view_count FROM proposals WHERE id = $1', [live.id]);
  const liveRes = await request('GET', `/api/proposals/t/${live.token}`);
  assert.equal(liveRes.status, 200, `expected 200, got ${liveRes.status}: ${liveRes.raw}`);
  const liveAfter = await pool.query('SELECT view_count FROM proposals WHERE id = $1', [live.id]);
  assert.equal(Number(liveAfter.rows[0].view_count), Number(liveBefore.rows[0].view_count) + 1,
    'a real view must still increment view_count');
});

// Reason-blind on purpose: the door closes on STATUS. A reason-keyed filter
// would have let the 2 prod rows carrying a NULL archive_reason straight
// through, which is the exact shape that makes a guard look green and leak.
test('the close is status-driven, not reason-driven', async () => {
  for (const archiveReason of ['client_cancelled', 'no_hire', 'other', null]) {
    const p = await insertProposal({ status: 'archived', archiveReason });
    const res = await request('GET', `/api/proposals/t/${p.token}`);
    assert.equal(res.status, 404, `reason ${archiveReason}: expected 404, got ${res.status}`);
  }
});

// The opposite direction, and the one a future tidy-up is most likely to break.
test('resolve STILL answers for an archived losing option, so the client is redirected to the one they chose', async () => {
  const g = await pool.query(
    `INSERT INTO proposal_groups (token) VALUES ($1) RETURNING id`,
    [crypto.randomUUID()]
  );
  const groupId = g.rows[0].id;
  createdGroupIds.add(groupId);

  const chosen = await insertProposal({ status: 'accepted', groupId });
  const losing = await insertProposal({
    status: 'archived', archiveReason: 'option_not_chosen', groupId,
  });
  await pool.query('UPDATE proposal_groups SET chosen_proposal_id = $1 WHERE id = $2',
    [chosen.id, groupId]);

  const res = await request('GET', `/api/proposals/t/${losing.token}/resolve`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  assert.equal(res.body.decided, true);
  assert.equal(res.body.chosen_token, chosen.token,
    'resolve must hand back the chosen option, or the client lands on a dead end');

  // And the losing option's own payload is still closed — both halves at once,
  // which is the actual contract.
  const payload = await request('GET', `/api/proposals/t/${losing.token}`);
  assert.equal(payload.status, 404, `expected 404, got ${payload.status}: ${payload.raw}`);
});
