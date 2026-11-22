require('dotenv').config();

// GET /api/proposals/:id, pinned whole (lane connector-shared-reads, plan
// 2026-11-19). The read moves out of the route into a shared function the
// Claude connector also calls; this suite was written and committed BEFORE the
// move, passed on the code as it stood, and must pass untouched after it. It
// is the proof the proposal detail page and its phone twin keep the answer
// they get today.
//
// What is pinned: every column of the proposals row (SELECT p.*), the joined
// client, package, creator and Thumbtack budget fields by name, the derived
// money and hours fields, the attachments (add-ons with a numeric quantity,
// the activity log newest first, the message log, the lead and consult calls,
// the first reply); a held proposal still answers, marked legal_hold; an
// unknown id is a 404.
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

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { __setLegalHoldIdsForTest } = require('../../utils/legalHold');
const { setupTimeDisplay } = require('../../utils/setupTime');
const getOneRouter = require('./getOne');

if (process.env.NODE_ENV === 'production') throw new Error('getOne.detail.test.js refuses to run against production');

let server;
let baseUrl;
let adminToken;

const RUN = `go-pin-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const made = { users: [], clients: [], proposals: [], leads: [] };
const fx = {};

// The joined fields beside p.*, and the derived fields after them, captured
// from the code before the move.
const JOINED_KEYS = ['adjustments_token', 'budget_max', 'budget_min', 'budget_raw', 'client_cc_id', 'client_email',
  'client_name', 'client_phone', 'client_source', 'created_by_email', 'package_category', 'package_includes',
  'package_name', 'package_slug', 'user_cc_id'];
const DERIVED_KEYS = ['activity', 'addons', 'consult_call', 'contract_floor_hours', 'first_reply', 'gv_post', 'lead_call', 'legal_hold',
  'max_overpayment_refundable_cents', 'max_refundable_cents', 'messageLog', 'off_contract_paid_cents', 'overpayment_cents',
  'settled_extension_hours', 'setup_time_display'];

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

const asJson = (row) => JSON.parse(JSON.stringify(row));
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

before(async () => {
  const passwordHash = await bcrypt.hash('x', 4);
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id, token_version`,
    [`${RUN}-admin@example.test`, passwordHash]
  );
  made.users.push(u.id);
  fx.admin = u.id;
  adminToken = jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const { rows: [c] } = await pool.query(
    `INSERT INTO clients (name, email, phone, source) VALUES ($1, $2, '(312) 555-0143', 'website') RETURNING id`,
    [`Proposal Pin ${RUN}`, `${RUN}-client@example.test`]
  );
  made.clients.push(c.id);
  fx.client = c.id;

  const pkg = await pool.query('SELECT id, name, slug, category, includes FROM service_packages ORDER BY id LIMIT 1');
  fx.pkg = pkg.rows[0] || null;
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, event_date, event_start_time, event_duration_hours,
                            guest_count, total_price, amount_paid, package_id, created_by, admin_notes)
     VALUES ($1, 'deposit_paid', 'birthday-party', '2026-12-12', '6:00 PM', 4, 80, 1850.25, 500, $2, $3, 'Gate code on file')
     RETURNING id`,
    [fx.client, fx.pkg ? fx.pkg.id : null, fx.admin]
  );
  made.proposals.push(p.id);
  fx.proposal = p.id;

  await pool.query(
    `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
     VALUES ($1, NULL, 'Pin add-on', 'per_hour', 50, 2.5, 125)`,
    [fx.proposal]
  );
  await pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details, created_at)
     VALUES ($1, 'created', 'admin', '{"n":1}', NOW() - INTERVAL '2 hours'),
            ($1, 'viewed', 'client', '{"n":2}', NOW() - INTERVAL '1 hour')`,
    [fx.proposal]
  );
  const { rows: [l] } = await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, proposal_id, status, raw_payload,
                                  budget_min, budget_max, budget_raw, first_reply_status, first_reply_template)
     VALUES ($1, $2, $3, 'converted', '{}'::jsonb, 1000, 2000, 'Between 1000 and 2000', 'pending', 'day')
     RETURNING id`,
    [`${RUN}-lead`, fx.client, fx.proposal]
  );
  made.leads.push(l.id);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/proposals', getOneRouter);
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

test('the body is every proposals column, the joined fields by name and the derived fields, nothing else', async () => {
  const res = await get(`/api/proposals/${fx.proposal}`, adminToken);
  assert.equal(res.status, 200);
  const row = asJson((await pool.query('SELECT * FROM proposals WHERE id = $1', [fx.proposal])).rows[0]);
  assert.deepEqual(Object.keys(res.body).sort(), [...new Set([...Object.keys(row), ...JOINED_KEYS, ...DERIVED_KEYS])].sort());
  assert.deepEqual(pick(res.body, Object.keys(row)), row, 'every column of the row as stored');
});

test('the joined fields carry the client, package, creator and lead budget', async () => {
  const res = await get(`/api/proposals/${fx.proposal}`, adminToken);
  const token = (await pool.query("SELECT md5(COALESCE(adjustments, '[]'::jsonb)::text) AS t FROM proposals WHERE id = $1", [fx.proposal])).rows[0].t;
  assert.deepEqual(pick(res.body, JOINED_KEYS), {
    adjustments_token: token, budget_max: 2000, budget_min: 1000, budget_raw: 'Between 1000 and 2000',
    client_cc_id: null, client_email: `${RUN}-client@example.test`, client_name: `Proposal Pin ${RUN}`,
    client_phone: '(312) 555-0143', client_source: 'website', created_by_email: `${RUN}-admin@example.test`,
    package_category: fx.pkg ? fx.pkg.category : null, package_includes: fx.pkg ? asJson(fx.pkg).includes : null,
    package_name: fx.pkg ? fx.pkg.name : null, package_slug: fx.pkg ? fx.pkg.slug : null, user_cc_id: null,
  });
});

test('the derived fields and attachments', async () => {
  const res = await get(`/api/proposals/${fx.proposal}`, adminToken);
  const b = res.body;
  const row = (await pool.query('SELECT * FROM proposals WHERE id = $1', [fx.proposal])).rows[0];
  assert.deepEqual(pick(b, ['setup_time_display', 'legal_hold', 'settled_extension_hours', 'contract_floor_hours',
    'overpayment_cents', 'off_contract_paid_cents', 'max_refundable_cents', 'max_overpayment_refundable_cents',
    'lead_call', 'consult_call', 'messageLog']), {
    setup_time_display: setupTimeDisplay(row), legal_hold: false, settled_extension_hours: 0, contract_floor_hours: null,
    overpayment_cents: 0, off_contract_paid_cents: 0, max_refundable_cents: 0, max_overpayment_refundable_cents: 0,
    lead_call: null, consult_call: null, messageLog: [],
  });
  assert.deepEqual(b.first_reply, { status: 'pending', template: 'day', sent_at: null });
  assert.equal(b.addons.length, 1);
  assert.deepEqual({ ...b.addons[0], id: undefined, created_at: undefined }, {
    id: undefined, proposal_id: fx.proposal, addon_id: null, addon_name: 'Pin add-on', billing_type: 'per_hour',
    rate: '50.00', quantity: 2.5, line_total: '125.00', created_at: undefined, variant: null,
  });
  assert.deepEqual(b.activity.map((a) => [a.action, a.actor_type, a.details]), [['viewed', 'client', { n: 2 }], ['created', 'admin', { n: 1 }]]);
  assert.deepEqual(Object.keys(b.activity[0]).sort(), ['action', 'actor_id', 'actor_type', 'created_at', 'details', 'id', 'proposal_id']);
});

test('a held proposal still answers the admin, marked legal_hold', async () => {
  __setLegalHoldIdsForTest([fx.proposal]);
  try {
    const res = await get(`/api/proposals/${fx.proposal}`, adminToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, fx.proposal);
    assert.equal(res.body.legal_hold, true);
  } finally {
    __setLegalHoldIdsForTest(null);
  }
});

test('an unknown proposal is a 404; no token is a 401', async () => {
  const missing = await get('/api/proposals/987654', adminToken);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Proposal not found', code: 'NOT_FOUND' });
  assert.equal((await get(`/api/proposals/${fx.proposal}`)).status, 401);
});
