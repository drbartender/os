require('dotenv').config();

// GET /api/clients/:id, pinned whole (lane connector-shared-reads, plan
// 2026-11-19). The read moves out of the route into a shared function the
// Claude connector also calls; this suite was written and committed BEFORE the
// move, passed on the code as it stood, and must pass untouched after it. It
// is the proof the admin clients page keeps the answer it gets today.
//
// What is pinned: the body is every column of the clients row (SELECT *), the
// client's proposals newest first with exactly the listed keys, the latest
// non-terminal Thumbtack lead's negotiation id, and consult_calls; a held
// proposal is still in the admin answer (the admin screen shows it read-only);
// an unknown id is a 404.
//
// Shared dev DB (run through scripts/run-suites.js). Fixtures are deleted by
// recorded id in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { __setLegalHoldIdsForTest } = require('../utils/legalHold');
const clientsRouter = require('./clients');

if (process.env.NODE_ENV === 'production') throw new Error('clients.detail.test.js refuses to run against production');

let server;
let baseUrl;
let adminToken;

const RUN = `cd-pin-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const made = { users: [], clients: [], proposals: [], leads: [] };
const fx = {};

// The keys of each row in body.proposals, captured from the code before the move.
const PROPOSAL_KEYS = ['amount_paid', 'cc_id', 'client_id', 'created_at', 'event_date', 'event_type',
  'event_type_custom', 'group_id', 'id', 'package_name', 'package_slug', 'status', 'token', 'total_price'];

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// A row as the route's res.json would serialize it.
const asJson = (row) => JSON.parse(JSON.stringify(row));

before(async () => {
  const passwordHash = await bcrypt.hash('x', 4);
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id, token_version`,
    [`${RUN}-admin@example.test`, passwordHash]
  );
  made.users.push(u.id);
  adminToken = jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const { rows: [c] } = await pool.query(
    `INSERT INTO clients (name, email, phone, source, notes)
     VALUES ($1, $2, '(312) 555-0142', 'referral', 'A note on file') RETURNING id`,
    [`Detail Pin ${RUN}`, `${RUN}-client@example.test`]
  );
  made.clients.push(c.id);
  fx.client = c.id;

  const pkg = await pool.query('SELECT id, name, slug FROM service_packages ORDER BY id LIMIT 1');
  fx.pkg = pkg.rows[0] || null;
  const addProposal = async (cols) => {
    const { rows: [p] } = await pool.query(
      `INSERT INTO proposals (client_id, status, event_type, event_type_custom, event_date, total_price, amount_paid,
                              package_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - $9::interval) RETURNING id`,
      [fx.client, cols.status, cols.eventType, cols.custom || null, cols.date, cols.total, cols.paid,
        cols.pkg ? fx.pkg.id : null, cols.ago]
    );
    made.proposals.push(p.id);
    return p.id;
  };
  fx.older = await addProposal({ status: 'confirmed', eventType: 'wedding-reception', date: '2026-12-05', total: 2400.5, paid: 600, pkg: true, ago: '3 days' });
  fx.newer = await addProposal({ status: 'sent', eventType: 'other', custom: 'Retirement party', date: null, total: 900, paid: 0, ago: '1 day' });

  // Two Thumbtack leads: the newest non-terminal one is the answer; a newer
  // converted one is skipped.
  const addLead = async (status, ago) => {
    const { rows: [l] } = await pool.query(
      `INSERT INTO thumbtack_leads (negotiation_id, client_id, status, raw_payload, created_at)
       VALUES ($1, $2, $3, '{}'::jsonb, NOW() - $4::interval) RETURNING id, negotiation_id`,
      [`${RUN}-${status}`, fx.client, status, ago]
    );
    made.leads.push(l.id);
    return l.negotiation_id;
  };
  fx.openLead = await addLead('new', '2 days');
  await addLead('converted', '1 hour');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/clients', clientsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  __setLegalHoldIdsForTest(null);
  if (made.leads.length) await pool.query('DELETE FROM thumbtack_leads WHERE id = ANY($1::int[])', [made.leads]);
  if (made.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made.proposals]);
  if (made.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [made.clients]);
  if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [made.users]);
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

test('the body is the whole clients row plus proposals, the open lead and consult_calls', async () => {
  const res = await get(`/api/clients/${fx.client}`, adminToken);
  assert.equal(res.status, 200);
  const row = asJson((await pool.query('SELECT * FROM clients WHERE id = $1', [fx.client])).rows[0]);
  const { proposals, thumbtack_negotiation_id: lead, consult_calls: calls, ...rest } = res.body;
  assert.deepEqual(rest, row, 'every column of the clients row, and nothing else beside the three attachments');
  assert.deepEqual(Object.keys(res.body).sort(), [...Object.keys(row), 'consult_calls', 'proposals', 'thumbtack_negotiation_id'].sort());
  assert.equal(lead, fx.openLead, 'the newest non-terminal lead');
  assert.deepEqual(calls, []);
  assert.deepEqual(proposals.map((p) => p.id), [fx.newer, fx.older], 'newest first');
  for (const p of proposals) assert.deepEqual(Object.keys(p).sort(), PROPOSAL_KEYS);
});

test('each proposal row carries its values as stored, the package joined', async () => {
  const res = await get(`/api/clients/${fx.client}`, adminToken);
  const byId = new Map(res.body.proposals.map((p) => [p.id, p]));
  const tokens = (await pool.query('SELECT id, token, created_at FROM proposals WHERE id = ANY($1::int[])', [made.proposals])).rows;
  const tok = new Map(tokens.map((t) => [t.id, asJson(t)]));
  const older = byId.get(fx.older);
  assert.deepEqual({ ...older, created_at: undefined }, {
    id: fx.older, token: tok.get(fx.older).token, client_id: fx.client, event_type: 'wedding-reception', event_type_custom: null,
    event_date: older.event_date, status: 'confirmed', total_price: '2400.50', amount_paid: '600.00', created_at: undefined,
    cc_id: null, group_id: null, package_name: fx.pkg ? fx.pkg.name : null, package_slug: fx.pkg ? fx.pkg.slug : null,
  });
  assert.match(older.event_date, /^2026-12-0[45]T/, 'a DATE serializes as the driver hands it back');
  assert.equal(older.created_at, tok.get(fx.older).created_at);
  const newer = byId.get(fx.newer);
  assert.deepEqual([newer.event_type, newer.event_type_custom, newer.event_date, newer.total_price, newer.package_name],
    ['other', 'Retirement party', null, '900.00', null]);
});

test('a held proposal is still in the admin answer', async () => {
  __setLegalHoldIdsForTest([fx.older]);
  try {
    const res = await get(`/api/clients/${fx.client}`, adminToken);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.proposals.map((p) => p.id), [fx.newer, fx.older]);
  } finally {
    __setLegalHoldIdsForTest(null);
  }
});

test('an unknown client is a 404; no token is a 401', async () => {
  const missing = await get('/api/clients/987654', adminToken);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Client not found.', code: 'NOT_FOUND' });
  const anon = await get(`/api/clients/${fx.client}`);
  assert.equal(anon.status, 401);
});
