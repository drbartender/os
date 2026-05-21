// Route-level tests for POST /api/proposals — the manual-proposal-overhaul
// send_now / in-transaction-invoice / rule-gate / quantity behavior (Task 7).
//
// HARNESS NOTES
// -------------
// The repo had no Express-route test harness when this file was written —
// every existing *.test.js exercises a pure util via node:test. There is also
// no supertest/jest/mocha dependency. So this file stands up a minimal harness
// itself: it mounts the real `crud` and `lifecycle` routers on a fresh express() app with the
// real `auth` middleware and the same AppError-aware error handler as
// server/index.js, then drives it over real HTTP via node's built-in `http`.
//
// It runs against the dev database (DATABASE_URL from .env) — the same DB the
// other suites' callers connect to. It creates real rows and cleans every one
// up in after(). createInvoiceOnSend and sendProposalSentEmail are stubbed via
// the __setDeps seam on the crud router so we can (a) count the client email
// and (b) force an invoice failure to prove the transaction rolls back.
//
// adminWriteLimiter keeps in-memory state for the whole process. Cases 1-9
// (excluding the rate-limit case) POST 9 times as ONE admin user — under the
// 10/min cap. The rate-limit case deliberately uses a SEPARATE admin user so
// its 11 POSTs get a clean bucket.
//
// adminWriteLimiter BUDGET: the shared `primaryToken` is capped at 10 POSTs/min
// — cases 1-6/8/9 already sit near that ceiling. Any NEW case that POSTs with
// `primaryToken` should mint a fresh token (a different admin/manager user)
// instead, or it risks a spurious 429 from a contended bucket.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const crudRouter = require('./crud');
const lifecycleRouter = require('./lifecycle');

// ─── Shared harness state ──────────────────────────────────────────────────
let server;
let baseUrl;
let primaryToken;     // JWT for the user that runs cases 1-6, 8, 9
let rateLimitToken;   // JWT for a DIFFERENT user — the rate-limit case only
let HOSTED_PKG_ID;    // a per_guest, non-class package
let CLASS_PKG_ID;     // a bar_type='class' package
let BYOB_BUNDLE_IDS;  // two distinct BYOB bundle addon ids (for the mutex case)
let ADDITIONAL_BARTENDER_ID;

// Email-stub call counter — reset per test that cares.
let emailCalls = 0;
// The proposal object the email stub last received. Case 1 inspects this to
// prove the handler ENRICHED the row (joined to `clients`) before sending —
// the bare proposals INSERT row has no client_email, so a false-green here
// would mean the client email never actually had a recipient.
let lastEmailProposal = null;
// When set, the createInvoiceOnSend stub throws this many more times then
// reverts to the real helper. Lets case 6 fail the first attempt and a retry
// succeed.
let invoiceThrowsRemaining = 0;
const realCreateInvoiceOnSend = require('../../utils/invoiceHelpers').createInvoiceOnSend;
const realSendProposalSentEmail = require('../../utils/sendProposalSentEmail').sendProposalSentEmail;

// Track every row this suite creates so after() can purge precisely.
const createdProposalIds = new Set();
const createdClientIds = new Set();
// Test admin users minted by makeFreshAdmin() — the PATCH /:id/status cases
// (10, 11) each need their OWN adminWriteLimiter bucket: primaryToken and
// rateLimitToken are both already at their 10/min ceiling from cases 1-9, and
// PATCH /:id/status is also adminWriteLimiter-gated. Purged in after().
const createdUserIds = new Set();

// ─── HTTP helper ────────────────────────────────────────────────────────────
function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = (body === null || body === undefined) ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
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
    if (payload) req.write(payload);
    req.end();
  });
}

// Count proposals rows — used by the rejection cases to prove zero were created.
async function proposalCount() {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM proposals');
  return r.rows[0].n;
}

// A valid baseline body for a hosted package above the 25-guest floor.
function validHostedBody(overrides = {}) {
  return {
    client_name: 'Route Test Client',
    client_email: `routetest+${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
    client_source: 'direct',
    package_id: HOSTED_PKG_ID,
    guest_count: 120,
    event_duration_hours: 4,
    num_bars: 1,
    event_type: 'Wedding',
    ...overrides,
  };
}

// Record the proposal id from a 201 response so cleanup can find it.
function trackResponse(res) {
  if (res.status === 201 && res.body && res.body.id) {
    createdProposalIds.add(res.body.id);
    if (res.body.client_id) createdClientIds.add(res.body.client_id);
  }
}

// Mint a brand-new admin user and return a signed JWT for it. The dev DB has
// only 2 admin/manager users (already spent on primaryToken / rateLimitToken),
// so cases that PATCH /:id/status — itself adminWriteLimiter-gated — need a
// fresh user to get a clean 10/min bucket. Each returned token is its own
// bucket. Tracked in createdUserIds for after() cleanup.
async function makeFreshAdmin() {
  const email = `routetest-admin+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version)
     VALUES ($1, $2, 'admin', 0) RETURNING id, token_version`,
    [email, 'x']
  );
  createdUserIds.add(u.rows[0].id);
  return jwt.sign(
    { userId: u.rows[0].id, tokenVersion: u.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
}

// Insert a draft proposal (and its client) directly — bypasses POST / so it
// does NOT consume an adminWriteLimiter slot. Gives the PATCH /:id/status
// cases a draft to transition. A minimal pricing_snapshot + total_price is
// enough for createInvoiceOnSend to build the first invoice on →sent.
async function insertDraftProposal(overrides = {}) {
  const client = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    [
      'PATCH Status Test Client',
      `patchstatus+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`,
    ]
  );
  createdClientIds.add(client.rows[0].id);
  const snapshot = JSON.stringify({ package: { name: 'Test Package', base_cost: 500 } });
  const prop = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, guest_count, event_duration_hours, num_bars,
        pricing_snapshot, total_price, payment_type, status, event_type, created_by)
     VALUES ($1, $2, 120, 4, 1, $3, $4, $5, $6, 'Wedding', $7)
     RETURNING id, status`,
    [
      client.rows[0].id,
      HOSTED_PKG_ID,
      snapshot,
      overrides.total_price ?? 500,
      overrides.payment_type ?? 'full',
      overrides.status ?? 'draft',
      overrides.created_by ?? null,
    ]
  );
  createdProposalIds.add(prop.rows[0].id);
  return prop.rows[0].id;
}

// ─── Setup ──────────────────────────────────────────────────────────────────
before(async () => {
  // Two distinct admin/manager users — primary for the bulk of cases, the
  // other reserved for the rate-limit case so its bucket is uncontended.
  const users = await pool.query(
    `SELECT id, COALESCE(token_version, 0) AS token_version
       FROM users WHERE role IN ('admin', 'manager') ORDER BY id LIMIT 2`
  );
  assert.ok(users.rows.length >= 2,
    'test harness needs >=2 admin/manager users in the dev DB');
  primaryToken = jwt.sign(
    { userId: users.rows[0].id, tokenVersion: users.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
  rateLimitToken = jwt.sign(
    { userId: users.rows[1].id, tokenVersion: users.rows[1].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  // A hosted (per_guest, non-class) package and a class package.
  const hosted = await pool.query(
    `SELECT id FROM service_packages
      WHERE is_active = true AND pricing_type = 'per_guest' AND bar_type <> 'class'
      ORDER BY id LIMIT 1`
  );
  const klass = await pool.query(
    `SELECT id FROM service_packages
      WHERE is_active = true AND bar_type = 'class' ORDER BY id LIMIT 1`
  );
  assert.ok(hosted.rows[0], 'need a hosted package');
  assert.ok(klass.rows[0], 'need a class package');
  HOSTED_PKG_ID = hosted.rows[0].id;
  CLASS_PKG_ID = klass.rows[0].id;

  // Two BYOB bundle addons (for the bundle-mutex case) + additional-bartender.
  const bundles = await pool.query(
    `SELECT id FROM service_addons
      WHERE is_active = true AND slug IN ('the-foundation', 'the-formula', 'the-full-compound')
      ORDER BY id LIMIT 2`
  );
  assert.ok(bundles.rows.length >= 2, 'need >=2 BYOB bundle addons');
  BYOB_BUNDLE_IDS = bundles.rows.map((r) => r.id);
  const bartender = await pool.query(
    `SELECT id FROM service_addons WHERE slug = 'additional-bartender' AND is_active = true`
  );
  assert.ok(bartender.rows[0], 'need the additional-bartender addon');
  ADDITIONAL_BARTENDER_ID = bartender.rows[0].id;

  // Stub the dependency seam: count emails; optionally fail invoice creation.
  // Applied to BOTH routers — POST / lives in crud, PATCH /:id/status in
  // lifecycle, and each carries its own _deps seam.
  const stubDeps = {
    // Capture-and-inspect stub — does NOT delegate to the real
    // sendProposalSentEmail. The real function early-returns when client_email
    // is missing, so delegating would let a false-green slip through (counter
    // ticks, zero emails produced). Instead we capture the proposal the handler
    // passed so Case 1 can assert it was enriched (has a real recipient).
    sendProposalSentEmail: (proposal) => {
      emailCalls += 1;
      lastEmailProposal = proposal;
      return Promise.resolve();
    },
    createInvoiceOnSend: (...args) => {
      if (invoiceThrowsRemaining > 0) {
        invoiceThrowsRemaining -= 1;
        return Promise.reject(new Error('simulated invoice failure'));
      }
      return realCreateInvoiceOnSend(...args);
    },
  };
  crudRouter.__setDeps(stubDeps);
  lifecycleRouter.__setDeps(stubDeps);

  // Minimal app: real router + real AppError-aware error handler (mirrors
  // server/index.js so a thrown ValidationError becomes a 400 with fieldErrors).
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', crudRouter);
  app.use('/api/proposals', lifecycleRouter);
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

// ─── Teardown ───────────────────────────────────────────────────────────────
after(async () => {
  // invoices.proposal_id is ON DELETE RESTRICT — invoices (and their CASCADE
  // children) must go BEFORE the proposals. proposal_addons / activity_log
  // CASCADE on proposal delete, so deleting proposals clears them.
  if (createdProposalIds.size > 0) {
    const ids = [...createdProposalIds];
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids]);
  }
  if (createdClientIds.size > 0) {
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [[...createdClientIds]]);
  }
  // Test admin users minted by makeFreshAdmin(). proposals.created_by is
  // ON DELETE SET NULL, so order vs. proposals doesn't matter — but the
  // proposals are already gone above. proposal_activity_log.actor_id is a
  // plain integer (no FK), so a deleted user leaves no dangling reference.
  if (createdUserIds.size > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[...createdUserIds]]);
  }
  // Restore real deps and close the server / pool.
  const realDeps = {
    sendProposalSentEmail: realSendProposalSentEmail,
    createInvoiceOnSend: realCreateInvoiceOnSend,
  };
  crudRouter.__setDeps(realDeps);
  lifecycleRouter.__setDeps(realDeps);
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── Case 1 — send_now:true on a valid payload ──────────────────────────────
test('Case 1: send_now true → 201 sent, invoice row exists, email sent once with a real recipient', async () => {
  emailCalls = 0;
  lastEmailProposal = null;
  const res = await request('POST', '/api/proposals', {
    token: primaryToken,
    body: validHostedBody({ send_now: true }),
  });
  trackResponse(res);
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${res.raw}`);
  assert.equal(res.body.status, 'sent');

  const inv = await pool.query(
    'SELECT id FROM invoices WHERE proposal_id = $1', [res.body.id]
  );
  assert.equal(inv.rows.length, 1, 'exactly one invoice row should exist');
  assert.equal(emailCalls, 1, 'sendProposalSentEmail should fire exactly once');

  // The email layer must receive an ENRICHED proposal — a non-empty
  // client_email string. The bare proposals INSERT row has no client_email
  // (that column lives on `clients`), so this assertion FAILS if the handler
  // hands the email step the un-joined row. This is the guard that catches the
  // "email never sends" bug a counter-only check missed.
  assert.ok(lastEmailProposal, 'the email stub should have captured a proposal');
  assert.equal(typeof lastEmailProposal.client_email, 'string',
    'the enriched proposal must carry a client_email string');
  assert.ok(lastEmailProposal.client_email.length > 0,
    'client_email must be non-empty — the handler must enrich the row before sending');
});

// ─── Case 2 — send_now:false ────────────────────────────────────────────────
test('Case 2: send_now false → 201 draft, no invoice, no email', async () => {
  emailCalls = 0;
  const res = await request('POST', '/api/proposals', {
    token: primaryToken,
    body: validHostedBody({ send_now: false }),
  });
  trackResponse(res);
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${res.raw}`);
  assert.equal(res.body.status, 'draft');

  const inv = await pool.query(
    'SELECT id FROM invoices WHERE proposal_id = $1', [res.body.id]
  );
  assert.equal(inv.rows.length, 0, 'no invoice should exist for a draft');
  assert.equal(emailCalls, 0, 'no email should fire for a draft');
});

// ─── Case 3 — Top Shelf class with send_now:true ────────────────────────────
test('Case 3: Top Shelf class + send_now true → 201 draft, no invoice, no email', async () => {
  emailCalls = 0;
  const res = await request('POST', '/api/proposals', {
    token: primaryToken,
    body: validHostedBody({
      package_id: CLASS_PKG_ID,
      guest_count: 12,
      event_type_category: 'class',
      class_options: { top_shelf_requested: true, spirit_category: 'whiskey_bourbon' },
      send_now: true,
    }),
  });
  trackResponse(res);
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${res.raw}`);
  assert.equal(res.body.status, 'draft', 'Top Shelf forces draft even with send_now true');

  const inv = await pool.query(
    'SELECT id FROM invoices WHERE proposal_id = $1', [res.body.id]
  );
  assert.equal(inv.rows.length, 0, 'no invoice for a Top Shelf draft');
  assert.equal(emailCalls, 0, 'no client email for a Top Shelf draft');

  // The normalized class_options must be persisted, not the raw body.
  const p = await pool.query('SELECT class_options, total_price FROM proposals WHERE id = $1', [res.body.id]);
  assert.equal(p.rows[0].class_options.top_shelf_requested, true);
  assert.equal(p.rows[0].class_options.spirit_category, 'whiskey_bourbon');
  assert.equal(Number(p.rows[0].total_price), 0, 'Top Shelf total_price is 0');
});

// ─── Case 4 — hosted package below the 25-guest floor ───────────────────────
test('Case 4: hosted package, guest_count 10 → 400, zero proposals created', async () => {
  const before = await proposalCount();
  const res = await request('POST', '/api/proposals', {
    token: primaryToken,
    body: validHostedBody({ guest_count: 10 }),
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.raw}`);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  const after = await proposalCount();
  assert.equal(after, before, 'no proposal row should be created on a rule violation');
});

// ─── Case 5 — two BYOB bundles (bundle mutex) ───────────────────────────────
test('Case 5: two BYOB bundle ids → 400, zero proposals created', async () => {
  const before = await proposalCount();
  const res = await request('POST', '/api/proposals', {
    token: primaryToken,
    body: validHostedBody({ addon_ids: BYOB_BUNDLE_IDS }),
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.raw}`);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  const after = await proposalCount();
  assert.equal(after, before, 'no proposal row should be created on the bundle mutex');
});

// ─── Case 6 — createInvoiceOnSend throws → txn rolls back ────────────────────
test('Case 6: invoice failure rolls back the whole insert; retry yields exactly one', async () => {
  const before = await proposalCount();

  // Fail the first invoice attempt. NOTE: the rolled-back attempt still BURNS
  // an invoice_number_seq value (sequences are non-transactional in Postgres) —
  // invoice numbers are allowed to have gaps, so this is expected, not a bug.
  invoiceThrowsRemaining = 1;
  const failBody = validHostedBody({ send_now: true });
  const failRes = await request('POST', '/api/proposals', {
    token: primaryToken, body: failBody,
  });
  trackResponse(failRes); // no-op on a non-201, but harmless
  assert.notEqual(failRes.status, 201, 'the request must error when the invoice fails');
  const afterFail = await proposalCount();
  assert.equal(afterFail, before,
    'the proposal insert must roll back when createInvoiceOnSend throws');

  // A clean retry (invoice stub no longer throwing) succeeds exactly once.
  invoiceThrowsRemaining = 0;
  const okRes = await request('POST', '/api/proposals', {
    token: primaryToken, body: validHostedBody({ send_now: true }),
  });
  trackResponse(okRes);
  assert.equal(okRes.status, 201, `retry expected 201, got ${okRes.status}: ${okRes.raw}`);
  const inv = await pool.query(
    'SELECT id FROM invoices WHERE proposal_id = $1', [okRes.body.id]
  );
  assert.equal(inv.rows.length, 1, 'the retry should create exactly one invoice');
});

// ─── Case 8 — addon quantity flows to proposal_addons + snapshot ────────────
// NOTE ON THE SPEC: case 8 in the plan asserts the persisted proposal_addons
// row "has quantity 2" for the additional-bartender addon. The real
// pricingEngine sets a per_hour addon's snapshot/persisted `quantity` to
// durationHours * inputQty (hours, not bartender count) — so for
// additional-bartender quantity is 8 at dh=4, qty=2, NOT 2. line_total IS the
// unambiguous "reflects x2" signal (2 bartenders -> double the x1 cost). This
// test therefore verifies the genuine quantity-flow contract: the persisted
// proposal_addons row carries the snapshot quantity through, and the snapshot
// line_total doubles vs the x1 baseline.
test('Case 8: addon_quantities x2 doubles the addon line and persists quantity', async () => {
  // Baseline: same addon at the default quantity (1). send_now:true keeps both
  // POSTs on the send path — quantity persistence is identical either way, and
  // staying on one path is consistent with the other send-path cases.
  const baseRes = await request('POST', '/api/proposals', {
    token: primaryToken,
    body: validHostedBody({ send_now: true, addon_ids: [ADDITIONAL_BARTENDER_ID] }),
  });
  trackResponse(baseRes);
  assert.equal(baseRes.status, 201, `baseline expected 201, got ${baseRes.status}: ${baseRes.raw}`);
  const baseSnap = baseRes.body.pricing_snapshot;
  const baseAddon = baseSnap.addons.find((a) => a.id === ADDITIONAL_BARTENDER_ID);
  assert.ok(baseAddon, 'baseline snapshot should contain the bartender addon');

  // x2.
  const x2Res = await request('POST', '/api/proposals', {
    token: primaryToken,
    body: validHostedBody({
      send_now: true,
      addon_ids: [ADDITIONAL_BARTENDER_ID],
      addon_quantities: { [String(ADDITIONAL_BARTENDER_ID)]: 2 },
    }),
  });
  trackResponse(x2Res);
  assert.equal(x2Res.status, 201, `x2 expected 201, got ${x2Res.status}: ${x2Res.raw}`);
  const x2Snap = x2Res.body.pricing_snapshot;
  const x2Addon = x2Snap.addons.find((a) => a.id === ADDITIONAL_BARTENDER_ID);
  assert.ok(x2Addon, 'x2 snapshot should contain the bartender addon');

  // Snapshot reflects x2: the line total is double the x1 baseline.
  assert.equal(x2Addon.line_total, baseAddon.line_total * 2,
    'x2 quantity should double the addon line total in the snapshot');

  // The persisted proposal_addons row carries the snapshot quantity through.
  const persisted = await pool.query(
    'SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1 AND addon_id = $2',
    [x2Res.body.id, ADDITIONAL_BARTENDER_ID]
  );
  assert.equal(persisted.rows.length, 1, 'one proposal_addons row should be persisted');
  assert.equal(persisted.rows[0].quantity, x2Addon.quantity,
    'persisted quantity should equal the snapshot addon quantity');
  assert.equal(Number(persisted.rows[0].line_total), x2Addon.line_total,
    'persisted line_total should equal the snapshot addon line_total');
});

// ─── Case 9 — Top Shelf flag on a NON-class package ─────────────────────────
test('Case 9: top_shelf on a non-class package → 400, zero proposals created', async () => {
  const before = await proposalCount();
  const res = await request('POST', '/api/proposals', {
    token: primaryToken,
    body: validHostedBody({
      class_options: { top_shelf_requested: true },
    }),
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.raw}`);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  const after = await proposalCount();
  assert.equal(after, before, 'no proposal row should be created when Top Shelf hits a non-class package');
});

// ─── Case 10 — PATCH /:id/status → 'sent' on a draft ────────────────────────
// Fresh admin token (its own adminWriteLimiter bucket — primaryToken is spent).
test('Case 10: PATCH status draft→sent → sent, invoice row exists, email sent once', async () => {
  emailCalls = 0;
  lastEmailProposal = null;
  const token = await makeFreshAdmin();
  const proposalId = await insertDraftProposal();

  const res = await request('PATCH', `/api/proposals/${proposalId}/status`, {
    token, body: { status: 'sent' },
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  assert.equal(res.body.status, 'sent');

  const inv = await pool.query(
    'SELECT id FROM invoices WHERE proposal_id = $1', [proposalId]
  );
  assert.equal(inv.rows.length, 1, 'exactly one invoice row should exist after →sent');
  assert.equal(emailCalls, 1, 'sendProposalSentEmail should fire exactly once on →sent');

  // The email step must receive an ENRICHED proposal — the bare proposals row
  // has no client_email (that column lives on `clients`), so a non-empty
  // client_email proves the handler re-fetched joined to `clients`.
  assert.ok(lastEmailProposal, 'the email stub should have captured a proposal');
  assert.equal(typeof lastEmailProposal.client_email, 'string',
    'the enriched proposal must carry a client_email string');
  assert.ok(lastEmailProposal.client_email.length > 0,
    'client_email must be non-empty — the handler must JOIN clients before sending');
});

// ─── Case 11 — PATCH /:id/status re-send: sent→modified→sent ────────────────
// The email must fire on EVERY →sent transition (no sent_at skip), so a
// modified→sent re-send still notifies the client. Fresh admin token: this
// case makes 4 PATCH calls, well under a clean bucket's 10/min.
test('Case 11: draft→sent→modified→sent re-sends the email (no sent_at gate)', async () => {
  const token = await makeFreshAdmin();
  const proposalId = await insertDraftProposal();

  // draft → sent (first send): email #1, invoice created.
  emailCalls = 0;
  const r1 = await request('PATCH', `/api/proposals/${proposalId}/status`, {
    token, body: { status: 'sent' },
  });
  assert.equal(r1.status, 200, `draft→sent expected 200, got ${r1.status}: ${r1.raw}`);
  assert.equal(emailCalls, 1, 'first →sent should fire the email once');

  // sent → modified.
  const r2 = await request('PATCH', `/api/proposals/${proposalId}/status`, {
    token, body: { status: 'modified' },
  });
  assert.equal(r2.status, 200, `sent→modified expected 200, got ${r2.status}: ${r2.raw}`);

  // modified → sent (re-send): the proposal's sent_at is ALREADY set from the
  // first send. The email must fire AGAIN — there is no sent_at skip.
  emailCalls = 0;
  lastEmailProposal = null;
  const r3 = await request('PATCH', `/api/proposals/${proposalId}/status`, {
    token, body: { status: 'sent' },
  });
  assert.equal(r3.status, 200, `modified→sent expected 200, got ${r3.status}: ${r3.raw}`);
  assert.equal(r3.body.status, 'sent');
  assert.equal(emailCalls, 1,
    're-send (modified→sent) must fire the email again — no sent_at skip');
  assert.ok(lastEmailProposal && lastEmailProposal.client_email,
    'the re-send email must still receive an enriched proposal');

  // Still exactly one invoice — createInvoiceOnSend is idempotent on proposal_id.
  const inv = await pool.query(
    'SELECT id FROM invoices WHERE proposal_id = $1', [proposalId]
  );
  assert.equal(inv.rows.length, 1, 'the re-send must not create a second invoice');
});

// ─── Case 12 — PATCH /:id/status invoice failure rolls back the status ──────
// The PATCH-side mirror of Case 6. createInvoiceOnSend runs INSIDE the status
// transaction, so a throw must roll back the status change too — the proposal
// must NOT be left half-'sent' and no orphan invoice may remain. This pins the
// headline correctness property of the in-transaction-invoice refactor.
// Fresh admin token (its own adminWriteLimiter bucket).
test('Case 12: PATCH status invoice failure rolls back — proposal stays draft, no invoice', async () => {
  const token = await makeFreshAdmin();
  const proposalId = await insertDraftProposal();

  // Arm the stub: the next createInvoiceOnSend call throws. NOTE: the rolled-
  // back attempt still BURNS an invoice_number_seq value (sequences are non-
  // transactional in Postgres) — invoice number gaps are expected, not a bug.
  invoiceThrowsRemaining = 1;
  const res = await request('PATCH', `/api/proposals/${proposalId}/status`, {
    token, body: { status: 'sent' },
  });
  // Reset the arm in case the assertions below throw before the next case runs.
  invoiceThrowsRemaining = 0;

  // The request must error — the invoice failure propagates out of the txn.
  assert.notEqual(res.status, 201, `the request must error; got ${res.status}: ${res.raw}`);
  assert.ok(res.status >= 400, `expected a non-2xx error, got ${res.status}: ${res.raw}`);

  // The status change must have rolled back — re-SELECT proves it is STILL
  // 'draft', not left at 'sent'. This is the core property Task 8 must hold.
  const after = await pool.query(
    'SELECT status FROM proposals WHERE id = $1', [proposalId]
  );
  assert.equal(after.rows[0].status, 'draft',
    'the status change must roll back when createInvoiceOnSend throws');

  // No orphan invoice — the rolled-back txn must leave zero invoice rows.
  const inv = await pool.query(
    'SELECT id FROM invoices WHERE proposal_id = $1', [proposalId]
  );
  assert.equal(inv.rows.length, 0,
    'no invoice row should exist after the txn rolls back');
});

// ─── Case 7 — adminWriteLimiter (run LAST; uses its own user) ───────────────
// Placed last so the 11-POST burst can't starve the other cases' shared
// budget. Uses rateLimitToken (a different admin user) so its bucket is clean.
test('Case 7: 11 rapid POSTs from one user → the 11th is 429', async () => {
  const statuses = [];
  for (let i = 0; i < 11; i += 1) {
    // send_now:false keeps each call cheap (no invoice / no email) — the
    // rate limiter runs before the handler body either way.
    const res = await request('POST', '/api/proposals', {
      token: rateLimitToken,
      body: validHostedBody({ send_now: false }),
    });
    trackResponse(res);
    statuses.push(res.status);
  }
  // First 10 succeed (201); the 11th is rejected by adminWriteLimiter.
  assert.equal(statuses[10], 429,
    `the 11th POST should be 429; got statuses ${JSON.stringify(statuses)}`);
  assert.ok(statuses.slice(0, 10).every((s) => s === 201),
    `the first 10 POSTs should all be 201; got ${JSON.stringify(statuses)}`);
});
