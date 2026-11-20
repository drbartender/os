require('dotenv').config();

// GET /api/proposals, its response pinned (lane connector-shared-reads, plan
// 2026-11-19). The list query moves out of the route into a shared read the
// Claude connector's money-owed tool also calls; this suite was written and
// committed BEFORE the move, passed on the code as it stood, and must pass
// untouched after it. crud.filters.test.js pins which rows each filter keeps
// (balance=open against qOutstanding's predicate among them) and
// list.sort.test.js and list.phone.test.js the order and the phone envelope;
// this one pins the row itself, column by column, on the open-balance path
// the Overview money tile drills into, and the X-Total-Count header.
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
const listRouter = require('./list');

if (process.env.NODE_ENV === 'production') throw new Error('list.response.test.js refuses to run against production');

let server;
let baseUrl;
let adminToken;

const RUN = `lr-pin-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const TAG = `ListPin${crypto.randomBytes(4).toString('hex')}`;
const made = { users: [], clients: [], proposals: [] };
const fx = {};

// The row's columns, captured from the code before the move.
const ROW_KEYS = ['accepted_at', 'amount_paid', 'archive_reason', 'autopay_enrolled', 'balance_due_date', 'client_cc_id',
  'client_email', 'client_id', 'client_name', 'client_phone', 'client_signed_at', 'created_at', 'deposit_amount',
  'event_date', 'event_duration_hours', 'event_location', 'event_start_time', 'event_type', 'event_type_category',
  'event_type_custom', 'group_id', 'guest_count', 'id', 'last_viewed_at', 'num_bars', 'num_bartenders', 'package_id',
  'package_name', 'package_slug', 'payment_type', 'proposal_cc_id', 'sent_at', 'source', 'status', 'token',
  'total_price', 'updated_at', 'view_count'];
const ENVELOPE_KEYS = ['bucket_total', 'has_more', 'limit', 'page', 'rows', 'total', 'unviewed_total'];

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const asJson = (row) => JSON.parse(JSON.stringify(row));

async function seed(cols) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (client_id, status, sent_at, accepted_at, event_date, event_type, total_price, amount_paid,
                            balance_due_date, autopay_enrolled, package_id, guest_count, created_at)
     VALUES ($1, $2, $3, $4, $5, 'wedding-reception', $6, $7, $8, $9, $10, $11, NOW() - $12::interval) RETURNING id`,
    [fx.client, cols.status, cols.sent || null, cols.accepted || null, cols.date || null, cols.total, cols.paid,
      cols.due || null, Boolean(cols.autopay), cols.pkg ? fx.pkg.id : null, cols.guests || 50, cols.ago]
  );
  made.proposals.push(p.id);
  return p.id;
}

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
    `INSERT INTO clients (name, email, phone, source) VALUES ($1, $2, '(312) 555-0144', 'direct') RETURNING id`,
    [`${TAG} Client`, `${RUN}-client@example.test`]
  );
  made.clients.push(c.id);
  fx.client = c.id;
  fx.pkg = (await pool.query('SELECT id, name, slug FROM service_packages ORDER BY id LIMIT 1')).rows[0] || null;

  fx.open = await seed({ status: 'deposit_paid', sent: '2026-10-01', accepted: '2026-10-03', date: '2026-12-20', total: 1000, paid: 400,
    due: '2026-12-06', autopay: true, pkg: true, guests: 120, ago: '5 days' });
  fx.paidUp = await seed({ status: 'balance_paid', sent: '2026-10-01', accepted: '2026-10-02', date: '2026-12-21', total: 500, paid: 500, ago: '4 days' });
  fx.dead = await seed({ status: 'archived', sent: '2026-10-01', accepted: '2026-10-02', date: '2026-12-22', total: 800, paid: 0, ago: '3 days' });
  fx.notAccepted = await seed({ status: 'sent', sent: '2026-10-05', date: '2026-12-23', total: 600, paid: 0, ago: '2 days' });
  fx.noDue = await seed({ status: 'confirmed', sent: '2026-10-01', accepted: '2026-10-04', date: '2026-12-24', total: 700, paid: 100, ago: '1 day' });

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/proposals', listRouter);
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
  if (made.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made.proposals]);
  if (made.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [made.clients]);
  if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [made.users]);
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

const ids = (res) => res.body.map((r) => r.id);

test('balance=open: the accepted, live, still-owing rows, newest first, with the total in the header', async () => {
  const res = await get(`/api/proposals?view=all&balance=open&search=${TAG}`, adminToken);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body), 'a bare array');
  assert.deepEqual(ids(res), [fx.noDue, fx.open]);
  assert.equal(res.headers['x-total-count'], '2');
  assert.equal(res.headers['access-control-expose-headers'], 'X-Total-Count');
});

test('each row is exactly the listed columns, every value as stored', async () => {
  const res = await get(`/api/proposals?view=all&balance=open&search=${TAG}`, adminToken);
  for (const r of res.body) assert.deepEqual(Object.keys(r).sort(), ROW_KEYS);
  const row = res.body.find((r) => r.id === fx.open);
  const stored = asJson((await pool.query('SELECT * FROM proposals WHERE id = $1', [fx.open])).rows[0]);
  const fromProposal = ROW_KEYS.filter((k) => k in stored);
  assert.deepEqual(Object.fromEntries(fromProposal.map((k) => [k, row[k]])), Object.fromEntries(fromProposal.map((k) => [k, stored[k]])));
  assert.deepEqual({
    proposal_cc_id: row.proposal_cc_id, client_name: row.client_name, client_email: row.client_email,
    client_phone: row.client_phone, client_cc_id: row.client_cc_id, package_name: row.package_name, package_slug: row.package_slug,
  }, {
    proposal_cc_id: stored.cc_id, client_name: `${TAG} Client`, client_email: `${RUN}-client@example.test`,
    client_phone: '(312) 555-0144', client_cc_id: null, package_name: fx.pkg ? fx.pkg.name : null, package_slug: fx.pkg ? fx.pkg.slug : null,
  });
  assert.deepEqual([row.total_price, row.amount_paid, row.autopay_enrolled, row.status, row.guest_count],
    ['1000.00', '400.00', true, 'deposit_paid', 120]);
  assert.match(row.balance_due_date, /^2026-12-0[56]T/);
  assert.equal(res.body.find((r) => r.id === fx.noDue).balance_due_date, null);
});

test('the default bucket, a sort and the phone envelope answer as before', async () => {
  const active = await get(`/api/proposals?search=${TAG}`, adminToken);
  assert.deepEqual(ids(active), [fx.notAccepted], 'active leaves out paid, archived and booked');
  const sorted = await get(`/api/proposals?view=all&search=${TAG}&sort=event_date&dir=asc`, adminToken);
  assert.deepEqual(ids(sorted), [fx.open, fx.paidUp, fx.notAccepted, fx.noDue]);
  const env = await get(`/api/proposals?view=all&balance=open&search=${TAG}&envelope=1&limit=1`, adminToken);
  assert.deepEqual(Object.keys(env.body).sort(), ENVELOPE_KEYS);
  assert.deepEqual({ ...env.body, rows: env.body.rows.map((r) => r.id) },
    { rows: [fx.noDue], total: 2, bucket_total: 2, unviewed_total: 0, page: 1, limit: 1, has_more: true });
  assert.deepEqual(Object.keys(env.body.rows[0]).sort(), ROW_KEYS.filter((k) => !['token', 'client_email', 'client_phone'].includes(k)));
});

test('a held proposal is still in the admin list', async () => {
  __setLegalHoldIdsForTest([fx.open]);
  try {
    const res = await get(`/api/proposals?view=all&balance=open&search=${TAG}`, adminToken);
    assert.deepEqual(ids(res), [fx.noDue, fx.open]);
  } finally {
    __setLegalHoldIdsForTest(null);
  }
});
