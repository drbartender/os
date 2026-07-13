// Connection-lifecycle regression test for POST /api/proposals/public/capture-lead.
//
// The bug: the handler checked out a pooled client (pool.connect) for its BEGIN..COMMIT
// and then, still holding it, ran the abandoned-quote enrollment through bare
// pool.query() calls — each of which checks out a SECOND pooled connection. Under a
// quote-wizard spike, enough concurrent requests each holding one connection while
// waiting on another exhaust the pool and deadlock it: nobody can release until they get
// a connection nobody can free. Every request app-wide then starves for the full
// connectionTimeoutMillis. Because this is the public, unauthenticated wizard endpoint,
// a single IP burst is enough to trigger it.
//
// The invariant this locks in: capture-lead takes exactly ONE pooled connection and
// holds at most one at any instant, from connect to release. We assert it by
// instrumenting pool.connect (pg's pool.query() routes through it too) and recording
// both the peak simultaneous checkouts and the total checkouts across one real request.
// Pre-fix the peak is 2; post-fix both must be 1.
//
// To make this cover ALL FOUR converted queries, before() seeds its own ACTIVE
// "Abandoned Quote Followup" sequence campaign (email_campaigns.name has no unique
// constraint, and the dev DB's copy is 'paused' while the route filters status='active',
// so without this seed only the FIRST of the four queries would ever execute). The POST
// also sends form_state so the quote_drafts branch runs. Everything created is purged in
// after().
//
// Mirrors the harness in publicToken.test.js: a fresh express() app mounts the real
// router over real HTTP, running against the dev DB (DATABASE_URL from .env).

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const publicRouter = require('./public');

let server;
let baseUrl;
let campaignId;
const testEmail = `conn-lifecycle-${crypto.randomUUID()}@example.test`;

// --- pool.connect instrumentation -------------------------------------------------
// pg's Pool.query() internally calls this.connect(), so patching connect observes BOTH
// the handler's explicit pool.connect() and every implicit checkout a pool.query() makes.
// Supports the callback form as well as the promise form, because pg's internal
// Pool.query uses the callback form.
let liveCheckouts = 0;
let peakCheckouts = 0;
let totalCheckouts = 0;
let originalConnect = null;

function trackClient(client) {
  liveCheckouts += 1;
  totalCheckouts += 1;
  peakCheckouts = Math.max(peakCheckouts, liveCheckouts);
  const originalRelease = client.release.bind(client);
  let released = false;
  client.release = (...args) => {
    if (!released) {
      released = true;
      liveCheckouts -= 1;
    }
    return originalRelease(...args);
  };
  return client;
}

function installProbe() {
  if (originalConnect) return; // never nest the probe
  originalConnect = pool.connect.bind(pool);
  pool.connect = function connectProbe(cb) {
    if (typeof cb === 'function') {
      return originalConnect((err, client, release) => {
        if (!err && client) trackClient(client);
        return cb(err, client, release);
      });
    }
    return originalConnect().then(trackClient);
  };
}

function removeProbe() {
  if (!originalConnect) return;
  delete pool.connect; // restore the prototype method rather than shadowing it
  originalConnect = null;
}

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (_) { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  // Seed an ACTIVE sequence campaign so the route's enrollment branch runs end to end
  // (all four converted queries), not just its first lookup.
  const camp = await pool.query(
    `INSERT INTO email_campaigns (name, type, status, subject)
     VALUES ('Abandoned Quote Followup', 'sequence', 'active', 'conn-lifecycle test')
     RETURNING id`
  );
  campaignId = camp.rows[0].id;
  await pool.query(
    `INSERT INTO email_sequence_steps (campaign_id, step_order, subject, html_body, delay_days, delay_hours)
     VALUES ($1, 1, 'conn-lifecycle test step', '<p>test</p>', 0, 2)`,
    [campaignId]
  );

  const app = express();
  app.use(express.json());
  app.use('/', publicRouter);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode || 400).json({ error: err.message, fields: err.fields });
    }
    return res.status(500).json({ error: 'Server error' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  removeProbe();
  // Purge everything this test created. Enrollments reference the lead (and the campaign,
  // ON DELETE CASCADE), and quote_drafts.lead_id is ON DELETE SET NULL — so drafts must be
  // deleted explicitly, by email, before the lead.
  const { rows } = await pool.query('SELECT id FROM email_leads WHERE email = $1', [testEmail]);
  for (const row of rows) {
    await pool.query('DELETE FROM email_sequence_enrollments WHERE lead_id = $1', [row.id]);
  }
  await pool.query('DELETE FROM quote_drafts WHERE email = $1', [testEmail]);
  await pool.query('DELETE FROM email_leads WHERE email = $1', [testEmail]);
  if (campaignId) {
    // CASCADE takes the steps and any straggler enrollment with it.
    await pool.query('DELETE FROM email_campaigns WHERE id = $1', [campaignId]);
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('capture-lead takes exactly one pooled connection and never holds two', async () => {
  installProbe();
  liveCheckouts = 0;
  peakCheckouts = 0;
  totalCheckouts = 0;

  const res = await request('POST', '/public/capture-lead', {
    body: {
      email: testEmail,
      name: 'Conn Lifecycle Probe',
      guest_count: 80,
      source: 'website',
      current_step: 2,
      // Drives the quote_drafts upsert branch as well as the enrollment branch.
      form_state: { package_id: null, guest_count: 80, step: 2 },
    },
  });

  removeProbe();

  // The route must actually have succeeded, and must have gone down the draft path —
  // otherwise a peak of 1 could be vacuous (an early throw before the enrollment block).
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.draft_token, 'expected a draft_token — the quote_drafts branch did not run');

  // Prove the enrollment branch actually executed all the way to the INSERT, so this test
  // covers all four of the converted queries rather than just the first lookup.
  const enrolled = await pool.query(
    `SELECT 1 FROM email_sequence_enrollments e
       JOIN email_leads l ON l.id = e.lead_id
      WHERE l.email = $1 AND e.campaign_id = $2`,
    [testEmail, campaignId]
  );
  assert.equal(
    enrolled.rows.length, 1,
    'enrollment INSERT did not run — the deepest converted query was never exercised'
  );

  // The invariant. Pre-fix, the post-COMMIT enrollment pool.query() calls each grabbed a
  // second connection while the handler still held its first, so this peaked at 2.
  assert.equal(
    peakCheckouts, 1,
    `capture-lead held ${peakCheckouts} pooled connections at once; it must hold at most 1 ` +
    '(a request that holds one connection while waiting for another can deadlock the pool)'
  );

  // Peak alone would still pass if someone reintroduced a checkout AFTER a release, so
  // pin the total too: the whole request is served by exactly one connection.
  assert.equal(
    totalCheckouts, 1,
    `capture-lead checked out ${totalCheckouts} pooled connections in total; it must use exactly 1`
  );

  // And it must not leak: everything it took, it gave back.
  assert.equal(liveCheckouts, 0, `capture-lead leaked ${liveCheckouts} unreleased connection(s)`);
});
