// Route-level tests for GET /api/proposals list FILTERS (lane mb-a-list-filters,
// task A2.1/A2.2). Exercises the new cohort / axis / status-CSV / event_type /
// balance / date-range params on the extracted list.js router.
//
// HARNESS: mirrors crud.test.js — no supertest/jest in this repo, so this stands
// up a minimal express() app mounting the real `list` router + real `auth` +
// the same AppError-aware error handler as server/index.js, then drives it over
// node's built-in http. Runs against the dev DB (DATABASE_URL from .env), seeds
// real rows into a fixed June-2026 window, asserts row ids AND the X-Total-Count
// header, and cleans up every row in after().
//
// The RECONCILIATION CONTRACT is the point of this suite: the cohort predicates
// must mirror metricsQueries (qSent/qAccepted/qLostValue/qOutstanding) exactly,
// because a WHERE mismatch is silent and would break funnel drill-out counts.
// June 2026 is a native-only window (post 2026-05-15 cutover), so the CC ledger
// legs the metric queries add are zero here and the counts reconcile 1:1.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const metrics = require('../../utils/metricsQueries');
const listRouter = require('./list');

// Fixed native-only window. Every seeded date lives inside it.
const FROM = '2026-06-01';
const TO = '2026-06-30';
const RANGE = `from=${FROM}&to=${TO}`;

let server;
let baseUrl;
let token;
let clientId;

// Seeded proposal ids by role.
let idSentArchived;    // sent + archived (quoted-included, lost-included)
let idAcceptedDeposit; // accepted_at set, deposit_paid, open balance
let idAcceptedOpen;    // accepted_at set, status 'accepted', open balance
let idDraftNeverSent;  // sent_at NULL, event_date in range
let idThumbtack;       // source = thumbtack, status sent
let idCustomType;      // custom event_type value, status sent
let idBoundary;        // sent_at 23:50 on the range-end day (half-open boundary)
let idHumanType;       // event_type stored as the Thumbtack human string "Wedding Reception"
let idNullType;        // event_type NULL (found via the __untyped sentinel)

const createdProposalIds = new Set();

function request(method, path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const idsOf = (res) => (Array.isArray(res.body) ? res.body.map((r) => r.id) : []);
const totalOf = (res) => Number(res.headers['x-total-count']);

// Insert a proposal directly (no POST — avoids the adminWriteLimiter and lets
// us pin sent_at/accepted_at/status precisely). Only nullable columns omitted.
async function seed({ status, sentAt = null, acceptedAt = null, eventDate = null,
  source = null, eventType = null, eventTypeCustom = null, total = 0, paid = 0 }) {
  const r = await pool.query(
    `INSERT INTO proposals
       (client_id, status, sent_at, accepted_at, event_date, source,
        event_type, event_type_custom, total_price, amount_paid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [clientId, status, sentAt, acceptedAt, eventDate, source,
      eventType, eventTypeCustom, total, paid]
  );
  const id = r.rows[0].id;
  createdProposalIds.add(id);
  return id;
}

before(async () => {
  const users = await pool.query(
    `SELECT id, COALESCE(token_version, 0) AS token_version
       FROM users WHERE role IN ('admin', 'manager') ORDER BY id LIMIT 1`
  );
  assert.ok(users.rows[0], 'test harness needs an admin/manager user in the dev DB');
  token = jwt.sign(
    { userId: users.rows[0].id, tokenVersion: users.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    ['Filters Test Client', `filters+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`]
  );
  clientId = c.rows[0].id;

  idSentArchived = await seed({
    status: 'archived', sentAt: '2026-06-10', eventDate: '2026-06-15',
    eventType: 'wedding-reception', total: 1000, paid: 0,
  });
  idAcceptedDeposit = await seed({
    status: 'deposit_paid', sentAt: '2026-06-05', acceptedAt: '2026-06-12',
    eventDate: '2026-06-20', eventType: 'birthday-party', total: 2000, paid: 100,
  });
  idAcceptedOpen = await seed({
    status: 'accepted', sentAt: '2026-06-06', acceptedAt: '2026-06-13',
    eventDate: '2026-06-21', eventType: 'corporate-event', total: 3000, paid: 500,
  });
  idDraftNeverSent = await seed({
    status: 'draft', sentAt: null, eventDate: '2026-06-18',
    eventType: 'cocktail-party', total: 0, paid: 0,
  });
  idThumbtack = await seed({
    status: 'sent', sentAt: '2026-06-08', eventDate: '2026-06-22',
    source: 'thumbtack', eventType: 'holiday-party', total: 1500, paid: 0,
  });
  idCustomType = await seed({
    status: 'sent', sentAt: '2026-06-09', eventDate: '2026-06-23',
    eventType: 'gala-custom-xyz', eventTypeCustom: 'My Custom Gala', total: 1200, paid: 0,
  });
  // 23:50 on the range-end day. Passed as a bare timestamp string so Postgres
  // frames BOTH this value and the dateClause boundary ('2026-07-01'::date) in
  // the same session timezone: half-open (< to+1) INCLUDES it; an inclusive
  // (<= to::date, = range-end midnight) would DROP it. That drop is the exact
  // silent reconciliation break the half-open dateClause guards against.
  idBoundary = await seed({
    status: 'sent', sentAt: '2026-06-30 23:50:00', eventDate: '2026-06-30',
    eventType: 'dinner-party', total: 900, paid: 0,
  });
  // Thumbtack-draft human-string vocabulary. Normalizes to the `wedding-reception`
  // slug, so `event_type=wedding-reception` must find it (split-by lane, A2.2).
  idHumanType = await seed({
    status: 'sent', sentAt: '2026-06-03', eventDate: '2026-06-24',
    eventType: 'Wedding Reception', total: 1100, paid: 0,
  });
  // Untyped row: the `__untyped` sentinel must match NULL/empty event_type.
  idNullType = await seed({
    status: 'sent', sentAt: '2026-06-02', eventDate: '2026-06-25',
    eventType: null, total: 800, paid: 0,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', listRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
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
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [[...createdProposalIds]]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── cohort=quoted mirrors qSent ─────────────────────────────────────────────
test('cohort=quoted mirrors qSent: sent_at in range, archived included', async () => {
  const res = await request('GET', `/api/proposals?cohort=quoted&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  const ids = idsOf(res);
  // Every sent-in-June seed is included, archived among them.
  for (const id of [idSentArchived, idAcceptedDeposit, idAcceptedOpen, idThumbtack, idCustomType, idBoundary]) {
    assert.ok(ids.includes(id), `quoted cohort should include ${id}`);
  }
  // Never-sent draft excluded (sent_at NULL).
  assert.ok(!ids.includes(idDraftNeverSent), 'quoted cohort excludes never-sent rows');
});

// ─── cohort=won mirrors qAccepted ────────────────────────────────────────────
test('cohort=won mirrors qAccepted: accepted_at in range, paid statuses included', async () => {
  const res = await request('GET', `/api/proposals?cohort=won&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  const ids = idsOf(res);
  assert.ok(ids.includes(idAcceptedDeposit), 'won cohort includes a paid (deposit_paid) row');
  assert.ok(ids.includes(idAcceptedOpen), 'won cohort includes an accepted row');
  assert.ok(!ids.includes(idSentArchived), 'won cohort excludes rows with no accepted_at');
  assert.ok(!ids.includes(idThumbtack), 'won cohort excludes a sent-but-not-accepted row');
  // Count reconciles with qAccepted's NATIVE leg. includeCc='exclude' zeroes the
  // CC ledger legs — the native-only list cannot show CC ledger rows (they have
  // no proposals row), and qAccepted's booked_at leg CAN carry a CC booking dated
  // into a native window, so the reconcilable surface is the native leg (spec §9:
  // CC-inclusive numbers expose only their native portion as the drill-out).
  const q = metrics.qAccepted({ from: FROM, to: TO, basis: 'booked', includeCc: 'exclude' });
  const r = await pool.query(q.sql, q.params);
  assert.equal(totalOf(res), r.rows[0].count, 'won X-Total-Count === qAccepted native-leg count');
});

// ─── cohort=lost mirrors qLostValue ──────────────────────────────────────────
test('cohort=lost mirrors qLostValue: sent_at in range AND status=archived', async () => {
  const res = await request('GET', `/api/proposals?cohort=lost&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  const ids = idsOf(res);
  assert.ok(ids.includes(idSentArchived), 'lost cohort includes the sent+archived row');
  for (const id of [idAcceptedDeposit, idAcceptedOpen, idThumbtack, idCustomType, idBoundary, idDraftNeverSent]) {
    assert.ok(!ids.includes(id), `lost cohort excludes non-archived / never-sent ${id}`);
  }
  // Predicate mirror check: X-Total-Count === COUNT with qLostValue's predicate.
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM proposals
      WHERE sent_at IS NOT NULL AND status = 'archived'
        AND sent_at >= $1::date AND sent_at < ($2::date + 1)`, [FROM, TO]);
  assert.equal(totalOf(res), r.rows[0].n, 'lost X-Total-Count === qLostValue-predicate count');
});

// ─── cohort supersedes status/view ───────────────────────────────────────────
test('cohort supersedes status/view when both present', async () => {
  const res = await request('GET', `/api/proposals?cohort=won&view=draft&status=sent&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  const ids = idsOf(res);
  // deposit_paid would be excluded by both view=draft and status=sent, but cohort wins.
  assert.ok(ids.includes(idAcceptedDeposit), 'cohort ignores the status/view bucket entirely');
});

// ─── axis=sent excludes NULL sent_at ─────────────────────────────────────────
test('axis=sent filters sent_at and excludes NULL sent_at', async () => {
  const res = await request('GET', `/api/proposals?view=all&axis=sent&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  const ids = idsOf(res);
  assert.ok(ids.includes(idCustomType), 'axis=sent includes a sent row in range');
  assert.ok(!ids.includes(idDraftNeverSent), 'axis=sent excludes NULL sent_at');
});

// ─── axis=event is the default ───────────────────────────────────────────────
test('axis=event filters event_date (default) and keeps never-sent rows', async () => {
  const res = await request('GET', `/api/proposals?view=all&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  const ids = idsOf(res);
  // Never-sent draft has an in-range event_date, so the event axis keeps it.
  assert.ok(ids.includes(idDraftNeverSent), 'event axis keeps a never-sent row with an in-range event_date');
});

// ─── status CSV whitelist ────────────────────────────────────────────────────
test('status CSV whitelists and drops unknown values silently', async () => {
  const res = await request('GET', `/api/proposals?view=all&status=${encodeURIComponent("sent,bogus,DROP TABLE proposals")}&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  const ids = idsOf(res);
  for (const id of [idThumbtack, idCustomType, idBoundary]) {
    assert.ok(ids.includes(id), `status=sent should include the sent row ${id}`);
  }
  assert.ok(!ids.includes(idAcceptedOpen), 'unknown values dropped: accepted not matched');
  assert.ok(!ids.includes(idDraftNeverSent), 'unknown values dropped: draft not matched');
});

// ─── single-value status backward compat ─────────────────────────────────────
test('single-value status keeps working (backward compat)', async () => {
  const res = await request('GET', `/api/proposals?status=draft&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  const ids = idsOf(res);
  assert.ok(ids.includes(idDraftNeverSent), 'status=draft returns drafts');
  assert.ok(!ids.includes(idThumbtack), 'status=draft excludes non-drafts');
});

// ─── balance=open mirrors qOutstanding predicate ─────────────────────────────
test('balance=open mirrors qOutstanding predicate', async () => {
  const res = await request('GET', '/api/proposals?view=all&balance=open');
  assert.equal(res.status, 200, res.raw);
  const ids = idsOf(res);
  assert.ok(ids.includes(idAcceptedDeposit), 'open balance includes an accepted deposit_paid row still owing');
  assert.ok(ids.includes(idAcceptedOpen), 'open balance includes an accepted row still owing');
  assert.ok(!ids.includes(idThumbtack), 'open balance excludes a row with no accepted_at');
  assert.ok(!ids.includes(idDraftNeverSent), 'open balance excludes a never-accepted draft');
  // X-Total-Count === COUNT with qOutstanding's row predicate.
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM proposals
      WHERE accepted_at IS NOT NULL AND status <> 'archived'
        AND (total_price - COALESCE(amount_paid,0)) > 0 AND status <> 'archived'`);
  assert.equal(totalOf(res), r.rows[0].n, 'balance=open count === qOutstanding-predicate count');
});

// ─── malformed dates ignored ─────────────────────────────────────────────────
test('malformed from/to ignored, no 500', async () => {
  const bad = await request('GET', '/api/proposals?view=all&from=2026-13-99&to=notadate');
  assert.equal(bad.status, 200, `malformed range must not 500: ${bad.raw}`);
  const one = await request('GET', '/api/proposals?view=all&from=2026-06-01&to=xx');
  assert.equal(one.status, 200, `half-malformed range must not 500: ${one.raw}`);
});

// ─── event_type parameterized ────────────────────────────────────────────────
test('event_type parameterized, custom value safe', async () => {
  const res = await request('GET', '/api/proposals?view=all&event_type=gala-custom-xyz');
  assert.equal(res.status, 200, res.raw);
  const ids = idsOf(res);
  assert.ok(ids.includes(idCustomType), 'event_type equality matches the custom value');
  assert.ok(!ids.includes(idThumbtack), 'event_type equality excludes other types');
  // Injection-shaped value is a parameterized literal, not SQL — no 500.
  const inj = await request('GET', `/api/proposals?view=all&event_type=${encodeURIComponent("' OR 1=1--")}`);
  assert.equal(inj.status, 200, `event_type must be parameterized: ${inj.raw}`);
});

// ─── event_type normalized on BOTH sides (twin-vocabulary drill-out) ──────────
test('event_type=<slug> matches the human-string vocabulary too', async () => {
  const res = await request('GET', '/api/proposals?view=all&event_type=wedding-reception');
  assert.equal(res.status, 200, res.raw);
  const ids = idsOf(res);
  // The "Wedding Reception" row normalizes to the wedding-reception slug and is found.
  assert.ok(ids.includes(idHumanType), 'slug param finds the human-string row');
  // Other typed rows are excluded.
  assert.ok(!ids.includes(idThumbtack), 'a holiday-party row is excluded');
  assert.ok(!ids.includes(idCustomType), 'a gala-custom row is excluded');
});

test('event_type=<HumanString> matches the slug vocabulary too (symmetric)', async () => {
  const res = await request('GET', `/api/proposals?view=all&event_type=${encodeURIComponent('Wedding Reception')}`);
  assert.equal(res.status, 200, res.raw);
  const ids = idsOf(res);
  // Symmetric: the human-string param normalizes and finds its own visible row.
  assert.ok(ids.includes(idHumanType), 'human-string param normalizes and matches');
  assert.ok(!ids.includes(idThumbtack), 'unrelated types excluded');
});

// ─── __untyped sentinel matches NULL/empty event_type ────────────────────────
test('event_type=__untyped matches the NULL-type row and excludes typed rows', async () => {
  const res = await request('GET', '/api/proposals?view=all&event_type=__untyped');
  assert.equal(res.status, 200, res.raw);
  const ids = idsOf(res);
  assert.ok(ids.includes(idNullType), '__untyped finds the NULL event_type row');
  for (const id of [idHumanType, idCustomType, idThumbtack, idBoundary]) {
    assert.ok(!ids.includes(id), `__untyped excludes the typed row ${id}`);
  }
});

// ─── exact-slug match still works (backward compat) ──────────────────────────
test('exact-slug event_type still matches after normalization (backward compat)', async () => {
  const res = await request('GET', '/api/proposals?view=all&event_type=holiday-party');
  assert.equal(res.status, 200, res.raw);
  const ids = idsOf(res);
  assert.ok(ids.includes(idThumbtack), 'exact slug still matches its own row');
  assert.ok(!ids.includes(idHumanType), 'the wedding row is not a holiday-party');
});

// ─── existing responses unchanged with no new params ─────────────────────────
test('existing responses unchanged when no new params sent', async () => {
  const res = await request('GET', '/api/proposals');
  assert.equal(res.status, 200, res.raw);
  assert.ok(Array.isArray(res.body), 'body is still a bare array');
  assert.ok(Number.isFinite(totalOf(res)), 'X-Total-Count header still present');
  const ids = idsOf(res);
  // Default active bucket: sent/draft/accepted in, deposit_paid + archived out.
  assert.ok(ids.includes(idThumbtack), 'default active bucket includes a sent row');
  assert.ok(!ids.includes(idAcceptedDeposit), 'default active bucket excludes deposit_paid');
  assert.ok(!ids.includes(idSentArchived), 'default active bucket excludes archived');
  const row = res.body.find((r) => r.id === idThumbtack);
  assert.ok(row && 'token' in row && 'client_name' in row && 'status' in row,
    'row shape unchanged (token / client_name / status present)');
});

// ─── half-open boundary + qSent reconciliation ───────────────────────────────
test('range end includes same-day 23:50 row (half-open) and cohort count === qSent count', async () => {
  const res = await request('GET', `/api/proposals?cohort=quoted&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  const ids = idsOf(res);
  assert.ok(ids.includes(idBoundary),
    'the 23:50 same-day timestamptz row lands inside the range (half-open dateClause)');
  // Native-leg reconciliation (includeCc='exclude' zeroes the CC ledger legs):
  // the list is native-only, and this pins that cohort=quoted uses the SAME
  // half-open dateClause as qSent so no row drifts across the range boundary.
  const q = metrics.qSent({ from: FROM, to: TO, basis: 'booked', includeCc: 'exclude' });
  const r = await pool.query(q.sql, q.params);
  assert.equal(totalOf(res), r.rows[0].count,
    'quoted X-Total-Count === qSent native-leg count (dateClause drift check)');
});
