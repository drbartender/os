// Route-level tests for POST /api/proposals/t/:token/switch.
//
// This is a PUBLIC token-gated WRITE to package/total/snapshot, so the guard
// matrix and the money invariants matter more than the happy path. Harness
// mirrors publicOptions.test.js (fresh express() over the real routers, real
// HTTP, real seeded catalog, nonce'd fixtures purged in after). Stripe is
// faked through the getStripe seam BEFORE the router chain is required
// (stripeCreateIntent.test.js precedent), and refreshUnlockedInvoices gets a
// pass-through wrapper so ONE test can force it to throw (atomicity).

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const cancelCalls = [];
const scriptedIntents = new Map(); // id -> intent object returned by retrieve
const fakeStripe = {
  paymentIntents: {
    retrieve: async (id) => {
      if (scriptedIntents.has(id)) return scriptedIntents.get(id);
      const err = new Error(`No such payment_intent: ${id}`);
      err.code = 'resource_missing';
      throw err;
    },
    cancel: async (id) => {
      cancelCalls.push(id);
      return { id, status: 'canceled' };
    },
  },
};
require('../../utils/stripeClient').getStripe = () => fakeStripe;

// Pass-through wrapper so the atomicity test can make the in-tx invoice
// refresh throw. Must land before publicSwitch.js destructures it.
const invoiceLifecycle = require('../../utils/invoiceLifecycle');
const realRefresh = invoiceLifecycle.refreshUnlockedInvoices;
let refreshOverride = null;
invoiceLifecycle.refreshUnlockedInvoices = (...args) =>
  (refreshOverride || realRefresh)(...args);

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const publicTokenRouter = require('./publicToken');
const optionsRouter = require('./publicOptions');
const switchRouter = require('./publicSwitch');

if (process.env.NODE_ENV === 'production') {
  throw new Error('publicSwitch.test.js refuses to run against production');
}

let server;
let baseUrl;
let byobPkgId;
let hostedPkgId; // cheapest active hosted package, the usual switch target
const createdProposalIds = new Set();
const createdClientIds = new Set();
const createdInvoiceIds = new Set();
const stamp = `switchroute-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

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

/** A switchable BYOB proposal at 120 guests / 4 hours (above every floor). */
async function insertProposal(overrides = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    [`Switch Route ${stamp}`, `${stamp}-${crypto.randomBytes(3).toString('hex')}@test.local`]
  );
  createdClientIds.add(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, package_id, status, guest_count, event_duration_hours,
                            num_bars, event_date, event_start_time, total_price)
     VALUES ($1, $2, $3, 120, 4, 1, CURRENT_DATE + 90, '5:00 PM', 0)
     RETURNING id, token`,
    [c.rows[0].id, overrides.package_id || byobPkgId, overrides.status || 'sent']
  );
  createdProposalIds.add(p.rows[0].id);
  return p.rows[0];
}

async function quoteFor(token, sel = { extra_addon_ids: [], tier_addon_id: null }) {
  const res = await request('POST', `/api/proposals/t/${token}/options`, { body: sel });
  assert.equal(res.status, 200, `quote: expected 200, got ${res.status}: ${res.raw}`);
  assert.equal(res.body.comparable, true, `quote must be comparable: ${res.raw}`);
  return res.body;
}

function optionTotal(quote, packageId) {
  const o = quote.options.find((x) => x.package_id === packageId);
  assert.ok(o && o.available, `target package ${packageId} is offered`);
  return o.total;
}

async function addonIdBySlug(slug) {
  const r = await pool.query('SELECT id FROM service_addons WHERE slug = $1', [slug]);
  return r.rows[0] ? r.rows[0].id : null;
}

async function rowOf(id) {
  const r = await pool.query(
    `SELECT id, package_id, status, total_price, pricing_snapshot, num_bartenders,
            deposit_amount, amount_paid, updated_at
       FROM proposals WHERE id = $1`, [id]);
  return r.rows[0];
}

before(async () => {
  const byob = await pool.query(
    `SELECT id FROM service_packages WHERE category = 'byob' AND is_active = true ORDER BY id LIMIT 1`);
  byobPkgId = byob.rows[0].id;
  const hosted = await pool.query(
    `SELECT id FROM service_packages
      WHERE pricing_type = 'per_guest' AND is_active = true AND bar_type IS DISTINCT FROM 'class'
      ORDER BY id LIMIT 1`);
  hostedPkgId = hosted.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', publicTokenRouter);
  app.use('/api/proposals', optionsRouter);
  app.use('/api/proposals', switchRouter);
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
  if (server) await new Promise((r) => server.close(r));
  const pids = [...createdProposalIds];
  if (createdInvoiceIds.size > 0) {
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id = ANY($1)', [[...createdInvoiceIds]]);
    await pool.query('DELETE FROM invoices WHERE id = ANY($1)', [[...createdInvoiceIds]]);
  }
  if (pids.length > 0) {
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1)', [pids]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = ANY($1)', [pids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [pids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [pids]);
  }
  if (createdClientIds.size > 0) {
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [[...createdClientIds]]);
  }
  await pool.end();
});

// ─── Guard matrix ────────────────────────────────────────────────────────────

test('unknown and malformed tokens are 404, never 400', async () => {
  const unknown = await request('POST', `/api/proposals/t/${crypto.randomUUID()}/switch`, {
    body: { package_id: hostedPkgId, acknowledged_total: 1 },
  });
  assert.equal(unknown.status, 404);
  // requireUuidToken throws NotFoundError: a junk token is indistinguishable
  // from a missing proposal, and it never spends a limiter bucket.
  const junk = await request('POST', '/api/proposals/t/not-a-uuid/switch', {
    body: { package_id: hostedPkgId, acknowledged_total: 1 },
  });
  assert.equal(junk.status, 404);
});

test('malformed bodies are 400 ValidationError with a usable fieldErrors object', async () => {
  const p = await insertProposal();
  for (const body of [
    {},
    { package_id: 0, acknowledged_total: 100 },
    { package_id: 'abc', acknowledged_total: 100 },
    { package_id: hostedPkgId },
    { package_id: hostedPkgId, acknowledged_total: 'abc' },
  ]) {
    const res = await request('POST', `/api/proposals/t/${p.token}/switch`, { body });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${res.status}`);
    assert.equal(res.body.code, 'VALIDATION_ERROR', JSON.stringify(body));
    // ValidationError's FIRST argument is fieldErrors, not the message. Passing
    // copy positionally silently discards it and hands the client a string
    // where the contract is a field->message map, so a drawer iterating it
    // gets one entry per character. Pin the shape, not just the status.
    assert.equal(typeof res.body.fieldErrors, 'object', `fieldErrors must be an object: ${res.raw}`);
    assert.ok(res.body.fieldErrors && !Array.isArray(res.body.fieldErrors));
    const keys = Object.keys(res.body.fieldErrors);
    assert.ok(keys.length > 0 && keys.every((k) => /^[a-z_]+$/.test(k)),
      `fieldErrors keys must be field names, got ${keys.slice(0, 3).join(',')}`);
  }
});

test('a package the quote would not offer is refused', async () => {
  const p = await insertProposal();
  const cls = await pool.query(
    `SELECT id FROM service_packages WHERE bar_type = 'class' LIMIT 1`);
  // Assert the fixture exists rather than silently skipping: a seed change
  // that removed class packages would turn this into a green no-test.
  assert.ok(cls.rows[0], 'the seeded catalog carries a class package to reject');
  const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: { package_id: cls.rows[0].id, acknowledged_total: 100 },
  });
  assert.equal(res.status, 400, 'a class package is never an option');
  const bogus = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: { package_id: 999999999, acknowledged_total: 100 },
  });
  assert.equal(bogus.status, 400);
});

test('SWITCH_NOT_AVAILABLE: status, signature, override, paid, grouped-undecided', async () => {
  const cases = [];
  for (const status of ['draft', 'modified', 'accepted']) {
    const p = await insertProposal({ status });
    cases.push([p, `status ${status}`]);
  }
  const signed = await insertProposal();
  await pool.query('UPDATE proposals SET client_signed_at = NOW() WHERE id = $1', [signed.id]);
  cases.push([signed, 'signed']);

  const custom = await insertProposal();
  await pool.query('UPDATE proposals SET total_price_override = 4321 WHERE id = $1', [custom.id]);
  cases.push([custom, 'custom-priced']);

  // The force-rewound fixture: money on a 'sent' row (PATCH force=true,
  // external_paid imports). "Paid is unreachable" has been wrong before; the
  // guard refuses rather than trusting the status ladder.
  const rewound = await insertProposal();
  await pool.query('UPDATE proposals SET amount_paid = 100 WHERE id = $1', [rewound.id]);
  cases.push([rewound, 'amount_paid > 0']);

  const grouped = await insertProposal();
  const g = await pool.query(
    'INSERT INTO proposal_groups (token) VALUES ($1) RETURNING id', [crypto.randomUUID()]);
  await pool.query('UPDATE proposals SET group_id = $1 WHERE id = $2', [g.rows[0].id, grouped.id]);
  cases.push([grouped, 'grouped-undecided']);

  try {
    for (const [p, label] of cases) {
      const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
        body: { package_id: hostedPkgId, acknowledged_total: 100 },
      });
      assert.equal(res.status, 409, `${label}: expected 409, got ${res.status}: ${res.raw}`);
      assert.equal(res.body.code, 'SWITCH_NOT_AVAILABLE', label);
      const row = await rowOf(p.id);
      assert.notEqual(row.package_id, hostedPkgId, `${label}: row must be untouched`);
    }
  } finally {
    await pool.query('UPDATE proposals SET group_id = NULL WHERE id = $1', [grouped.id]);
    await pool.query('DELETE FROM proposal_groups WHERE id = $1', [g.rows[0].id]);
  }
});

test('PAYMENT_IN_FLIGHT: a processing or settled-unrecorded intent blocks the switch', async () => {
  for (const status of ['processing', 'succeeded']) {
    const p = await insertProposal();
    const piId = `pi_inflight_${status}_${crypto.randomBytes(4).toString('hex')}`;
    scriptedIntents.set(piId, { id: piId, status });
    await pool.query(
      `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
       VALUES ($1, $2, 35000, 'pending')`, [p.id, piId]);
    const quote = await quoteFor(p.token);
    const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
      body: {
        package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [],
        acknowledged_total: optionTotal(quote, hostedPkgId),
      },
    });
    assert.equal(res.status, 409, `${status}: ${res.raw}`);
    assert.equal(res.body.code, 'PAYMENT_IN_FLIGHT');
    const row = await rowOf(p.id);
    assert.equal(row.package_id, byobPkgId, 'row untouched while money is in flight');
    assert.ok(!cancelCalls.includes(piId), 'a settling intent is never canceled');
  }
});

test("a declined card's intent is still live: a 'failed' mirror row must be cancelled too", async () => {
  // paymentIntentFailed.js flips the mirror row to 'failed' and makes NO Stripe
  // call, so the intent stays alive at Stripe in requires_payment_method with a
  // client_secret still valid in the client's open tab. Scanning 'pending'
  // alone let this through: checkout for the old total, decline, switch, retry
  // the card in that tab, old amount recorded against the new configuration.
  const p = await insertProposal();
  const piId = `pi_failed_${crypto.randomBytes(4).toString('hex')}`;
  scriptedIntents.set(piId, { id: piId, status: 'requires_payment_method' });
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 35000, 'failed')`, [p.id, piId]);

  const quote = await quoteFor(p.token);
  const ack = optionTotal(quote, hostedPkgId);
  const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: { package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [], acknowledged_total: ack },
  });
  assert.equal(res.status, 200, `switch: ${res.raw}`);

  assert.ok(cancelCalls.includes(piId),
    "the retryable intent behind a 'failed' mirror row was cancelled server-side");
  const sess = await pool.query(
    'SELECT status FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.rows[0].status, 'canceled', "the 'failed' mirror row was healed");
});

test("a 'failed' mirror row whose intent is already succeeded refuses the switch", async () => {
  // Same widened scan, opposite verdict: money that actually landed must block.
  const p = await insertProposal();
  const piId = `pi_failedsucc_${crypto.randomBytes(4).toString('hex')}`;
  scriptedIntents.set(piId, { id: piId, status: 'succeeded' });
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 35000, 'failed')`, [p.id, piId]);

  const quote = await quoteFor(p.token);
  const ack = optionTotal(quote, hostedPkgId);
  const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: { package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [], acknowledged_total: ack },
  });
  assert.equal(res.status, 409, `expected PAYMENT_IN_FLIGHT: ${res.raw}`);
  assert.equal(res.body.code, 'PAYMENT_IN_FLIGHT');
  assert.ok(!cancelCalls.includes(piId), 'a succeeded intent is never cancelled');
});

test('an explicit null acknowledged_total is a 400, never a priced-as-zero 409', async () => {
  const p = await insertProposal();
  const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: { package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [], acknowledged_total: null },
  });
  assert.equal(res.status, 400, `expected a validation 400: ${res.raw}`);
});

test('a refusal cancels NOTHING: the decision precedes every cancel', async () => {
  // The window this pins: with a per-row retrieve-cancel-next loop, a
  // cancelable intent ahead of an in-flight one gets canceled at Stripe and
  // THEN the switch refuses, rolling the DB back while Stripe stays canceled.
  // No rollback can undo a Stripe cancel, so the decision has to come first.
  const p = await insertProposal();
  const cancelable = `pi_cancelable_${crypto.randomBytes(4).toString('hex')}`;
  const inFlight = `pi_settling_${crypto.randomBytes(4).toString('hex')}`;
  scriptedIntents.set(cancelable, { id: cancelable, status: 'requires_payment_method' });
  scriptedIntents.set(inFlight, { id: inFlight, status: 'processing' });
  // Insert the cancelable one FIRST so a serial loop would reach it first.
  for (const piId of [cancelable, inFlight]) {
    await pool.query(
      `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
       VALUES ($1, $2, 35000, 'pending')`, [p.id, piId]);
  }
  const quote = await quoteFor(p.token);
  const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: {
      package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [],
      acknowledged_total: optionTotal(quote, hostedPkgId),
    },
  });
  assert.equal(res.status, 409, res.raw);
  assert.equal(res.body.code, 'PAYMENT_IN_FLIGHT');
  assert.ok(!cancelCalls.includes(cancelable),
    'the cancelable intent must survive a refusal: Stripe cannot be rolled back');
  const sess = await pool.query(
    `SELECT status FROM stripe_sessions WHERE proposal_id = $1`, [p.id]);
  assert.ok(sess.rows.every((r) => r.status === 'pending'),
    'no mirror row is flipped when the switch refuses');
});

test('a NULL-intent payment-link row is ignored, not treated as money in flight', async () => {
  // Admin payment-link mirrors carry no intent id. They must not be retrieved
  // (the SDK throws before any network call) and must not block a switch.
  const p = await insertProposal();
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, NULL, 35000, 'pending')`, [p.id]);
  const quote = await quoteFor(p.token);
  const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: {
      package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [],
      acknowledged_total: optionTotal(quote, hostedPkgId),
    },
  });
  assert.equal(res.status, 200, `a NULL-intent mirror row must not block: ${res.raw}`);
});

// ─── The happy path and the money invariants ────────────────────────────────

test('happy path: cancels the stale intent, rewrites the row, audits, returns the public payload', async () => {
  const p = await insertProposal();
  // A hand-set mandate must survive the snapshot rewrite (gratuity law: every
  // persisting snapshot writer carries floor_rate).
  await pool.query('UPDATE proposals SET gratuity_floor_rate = 60 WHERE id = $1', [p.id]);
  // A cancelable stale intent for the old configuration.
  const piId = `pi_stale_${crypto.randomBytes(4).toString('hex')}`;
  scriptedIntents.set(piId, { id: piId, status: 'requires_payment_method' });
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 35000, 'pending')`, [p.id, piId]);
  // An unlocked send-time invoice with a deliberately wrong amount.
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, status, locked)
     VALUES ($1, $2, 'Full Payment', 1, 'sent', false) RETURNING id`,
    [p.id, `T${Date.now()}${crypto.randomBytes(2).toString('hex')}`.slice(0, 20)]);
  createdInvoiceIds.add(inv.rows[0].id);

  const quote = await quoteFor(p.token);
  const ack = optionTotal(quote, hostedPkgId);
  const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: { package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [], acknowledged_total: ack },
  });
  assert.equal(res.status, 200, `switch: ${res.raw}`);

  // The response is the public allowlist payload, never the raw row.
  assert.equal(res.body.package_id, hostedPkgId);
  assert.equal(Number(res.body.total_price), ack, 'response total is the acknowledged total');
  assert.ok('options_available' in res.body, 'payload shape matches the GET (flag present)');
  for (const secret of ['admin_notes', 'client_signature_ip', 'client_signature_user_agent',
    'stripe_customer_id', 'stripe_payment_method_id', 'setup_minutes_before',
    'total_price_override', 'group_id']) {
    assert.ok(!(secret in res.body), `${secret} must not leak`);
  }

  // Row: package, total, snapshot (with the mandate carried), deposit untouched.
  const row = await rowOf(p.id);
  assert.equal(row.package_id, hostedPkgId);
  assert.equal(Number(row.total_price), ack, 'committed total is the acknowledged total');
  assert.equal(Number(row.pricing_snapshot.total), ack, 'snapshot total matches');
  assert.equal(Number(row.pricing_snapshot.gratuity.floor_rate), 60,
    'the gratuity mandate floor rides the new snapshot');
  assert.equal(Number(row.deposit_amount), 100, 'deposit_amount is never written');

  // Stale intent canceled, mirror row flipped.
  assert.ok(cancelCalls.includes(piId), 'the cancelable stale intent was canceled server-side');
  const sess = await pool.query(
    'SELECT status FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.rows[0].status, 'canceled');

  // Addon rows replaced from engine output.
  const addonRows = await pool.query(
    'SELECT addon_id, quantity, line_total FROM proposal_addons WHERE proposal_id = $1', [p.id]);
  const snapAddons = row.pricing_snapshot.addons || [];
  assert.equal(addonRows.rows.length, snapAddons.length,
    'proposal_addons mirrors the committed snapshot');

  // Invoice re-derived to the committed total (Full Payment = total cents).
  const invRow = await pool.query('SELECT amount_due FROM invoices WHERE id = $1', [inv.rows[0].id]);
  assert.equal(Number(invRow.rows[0].amount_due), Math.round(ack * 100),
    'the send-time invoice matches the committed total');

  // Audit row.
  const log = await pool.query(
    `SELECT details FROM proposal_activity_log
      WHERE proposal_id = $1 AND action = 'package_switched'`, [p.id]);
  assert.equal(log.rows.length, 1, 'exactly one audit row');
  const d = log.rows[0].details;
  assert.equal(d.from_package_id, byobPkgId);
  assert.equal(d.to_package_id, hostedPkgId);
  assert.equal(Number(d.new_total), ack);
});

test('a discounted proposal switches cleanly (the SELECT carries adjustments)', async () => {
  const p = await insertProposal();
  await pool.query(
    `UPDATE proposals SET adjustments = '[{"type":"discount","label":"Fixture discount","amount":50,"visible":true}]'::jsonb
      WHERE id = $1`, [p.id]);
  const quote = await quoteFor(p.token);
  const ack = optionTotal(quote, hostedPkgId);
  const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: { package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [], acknowledged_total: ack },
  });
  assert.equal(res.status, 200,
    `a discounted proposal must not 409 against its own quote: ${res.raw}`);
  const row = await rowOf(p.id);
  assert.equal(Number(row.total_price), ack);
});

test('TOTAL_CHANGED: cents-strict, carries a fresh quote, writes nothing', async () => {
  const p = await insertProposal();
  const quote = await quoteFor(p.token);
  const ack = optionTotal(quote, hostedPkgId);
  const before = await rowOf(p.id);

  const off = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: { package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [], acknowledged_total: ack + 0.01 },
  });
  assert.equal(off.status, 409, off.raw);
  assert.equal(off.body.code, 'TOTAL_CHANGED');
  assert.ok(off.body.quote && off.body.quote.comparable === true,
    'the 409 carries a fresh, real quote');
  assert.equal(optionTotal(off.body.quote, hostedPkgId), ack,
    'the fresh quote shows the real number to re-acknowledge');

  const after = await rowOf(p.id);
  assert.equal(after.package_id, before.package_id, 'nothing written on a price conflict');
  assert.equal(Number(after.total_price), Number(before.total_price));
  assert.equal(String(after.updated_at), String(before.updated_at));

  // Sub-cent noise is not a conflict: a float-serialized total that rounds to
  // the same cents passes.
  const fuzz = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: { package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [], acknowledged_total: ack + 0.004999 },
  });
  assert.equal(fuzz.status, 200, `sub-cent noise must not 409: ${fuzz.raw}`);
});

test('idempotent replay: the same switch twice changes nothing the second time', async () => {
  const p = await insertProposal();
  const quote = await quoteFor(p.token);
  const ack = optionTotal(quote, hostedPkgId);
  const body = { package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [], acknowledged_total: ack };

  const first = await request('POST', `/api/proposals/t/${p.token}/switch`, { body });
  assert.equal(first.status, 200, first.raw);
  const afterFirst = await rowOf(p.id);
  const addonsFirst = await pool.query(
    'SELECT addon_id, quantity, line_total FROM proposal_addons WHERE proposal_id = $1 ORDER BY addon_id', [p.id]);

  const second = await request('POST', `/api/proposals/t/${p.token}/switch`, { body });
  assert.equal(second.status, 200, second.raw);
  const afterSecond = await rowOf(p.id);
  const addonsSecond = await pool.query(
    'SELECT addon_id, quantity, line_total FROM proposal_addons WHERE proposal_id = $1 ORDER BY addon_id', [p.id]);

  // Identical excluding updated_at (the switch stamps it on every 200) and the
  // snapshot's own calculated_at (the engine stamps each run).
  const stripStamp = (snap) => ({ ...snap, calculated_at: null });
  assert.equal(afterSecond.package_id, afterFirst.package_id);
  assert.equal(Number(afterSecond.total_price), Number(afterFirst.total_price));
  assert.deepEqual(stripStamp(afterSecond.pricing_snapshot), stripStamp(afterFirst.pricing_snapshot));
  assert.deepEqual(addonsSecond.rows, addonsFirst.rows);
});

test('staffing: a stale derivation re-derives at the switch call site; a true override survives', async () => {
  // Stale derivation: snapshot written when the event derived 3; at 120 guests
  // everything derives 2 today. The quote strips it (Task 1); the switch has
  // its OWN overrideOnlyBartenders call and must strip identically or the two
  // disagree and this 409s.
  const stale = await insertProposal();
  await pool.query(
    `UPDATE proposals SET num_bartenders = 3,
       pricing_snapshot = '{"staffing":{"required":3,"actual":3}}'::jsonb
     WHERE id = $1`, [stale.id]);
  const staleQuote = await quoteFor(stale.token);
  const staleAck = optionTotal(staleQuote, hostedPkgId);
  const staleRes = await request('POST', `/api/proposals/t/${stale.token}/switch`, {
    body: { package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [], acknowledged_total: staleAck },
  });
  assert.equal(staleRes.status, 200, `stale derivation must not 409: ${staleRes.raw}`);
  const staleRow = await rowOf(stale.id);
  assert.equal(Number(staleRow.num_bartenders), Number(staleRow.pricing_snapshot.staffing.actual),
    'the column is synced to what was actually priced, so the phantom cannot return');

  // True override: snapshot proves actual != required; the override carries
  // through the switch and the committed column keeps it.
  const overridden = await insertProposal();
  await pool.query(
    `UPDATE proposals SET num_bartenders = 4,
       pricing_snapshot = '{"staffing":{"required":2,"actual":4}}'::jsonb
     WHERE id = $1`, [overridden.id]);
  const ovQuote = await quoteFor(overridden.token);
  const ovAck = optionTotal(ovQuote, hostedPkgId);
  assert.ok(ovAck > staleAck, 'an over-ratio crew prices higher than the derived crew');
  const ovRes = await request('POST', `/api/proposals/t/${overridden.token}/switch`, {
    body: { package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [], acknowledged_total: ovAck },
  });
  assert.equal(ovRes.status, 200, `override must not 409: ${ovRes.raw}`);
  const ovRow = await rowOf(overridden.id);
  assert.equal(Number(ovRow.num_bartenders), 4, 'the true override survives the switch');
});

test('hidden add-ons follow the proposal; incompatible ones drop and are audited', async () => {
  const hidden = await addonIdBySlug('parking-fee');
  const garnish = await addonIdBySlug('garnish-package-only');
  assert.ok(hidden && garnish, 'seeded add-ons exist');
  const { rows: [pf] } = await pool.query(
    'SELECT rate, billing_type FROM service_addons WHERE id = $1', [hidden]);

  const p = await insertProposal();
  await pool.query(
    `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
     VALUES ($1, $2, 'Parking Fee', $3, $4, 1, $4)`,
    [p.id, hidden, pf.billing_type, Number(pf.rate)]);

  // The client also selects the byob-only garnish package, then switches to
  // hosted: the garnish cannot ride and must be dropped VISIBLY (audit).
  const sel = { extra_addon_ids: [garnish], tier_addon_id: null };
  const quote = await quoteFor(p.token, sel);
  const ack = optionTotal(quote, hostedPkgId);
  const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: { package_id: hostedPkgId, ...sel, acknowledged_total: ack },
  });
  assert.equal(res.status, 200, res.raw);

  const committedAddons = await pool.query(
    'SELECT addon_id FROM proposal_addons WHERE proposal_id = $1', [p.id]);
  const ids = committedAddons.rows.map((r) => r.addon_id);
  assert.ok(ids.includes(hidden), 'the parking fee follows the proposal onto the new package');
  assert.ok(!ids.includes(garnish), 'the byob-only extra cannot ride a hosted package');

  const log = await pool.query(
    `SELECT details FROM proposal_activity_log
      WHERE proposal_id = $1 AND action = 'package_switched'`, [p.id]);
  assert.ok(log.rows[0].details.dropped.some((n) => /garnish/i.test(n)),
    'the dropped extra is named in the audit row');
});

test('SAME-package switch (extras only) agrees with its own card and keeps hidden add-ons', async () => {
  // The drawer sends package AND extras together, so a client who changes only
  // an extra lands on a same-package switch. That path must reproduce the
  // quote's CURRENT-package branch exactly, which carries the proposal's own
  // invisible add-ons unfiltered ("Dallas's invisible ones always ride
  // along"). Applying the cross-package applies_to filter here would drop one
  // the acknowledged card had priced in, so engine total could never equal
  // acknowledged total and every such switch would 409 forever while
  // noteConflict paged it as drift.
  const hidden = await addonIdBySlug('parking-fee');   // invisible on every package
  const toast = await addonIdBySlug('champagne-toast'); // a normal client-visible extra
  assert.ok(hidden && toast, 'seeded hidden + visible add-ons exist');
  const p = await insertProposal();
  const { rows: [pf] } = await pool.query(
    'SELECT rate, billing_type FROM service_addons WHERE id = $1', [hidden]);
  await pool.query(
    `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
     VALUES ($1, $2, 'Parking Fee', $3, $4, 1, $4)`,
    [p.id, hidden, pf.billing_type, Number(pf.rate)]);

  // Client stays on their own package and adds an extra.
  const sel = { extra_addon_ids: [toast], tier_addon_id: null };
  const quote = await quoteFor(p.token, sel);
  const ack = optionTotal(quote, byobPkgId); // their own card, re-priced
  const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: { package_id: byobPkgId, ...sel, acknowledged_total: ack },
  });
  assert.equal(res.status, 200,
    `a same-package switch must agree with the card it quoted: ${res.raw}`);

  const ids = (await pool.query(
    'SELECT addon_id FROM proposal_addons WHERE proposal_id = $1', [p.id])).rows.map((r) => r.addon_id);
  assert.ok(ids.includes(hidden), 'the hidden fee survives a same-package switch');
  assert.ok(ids.includes(toast), 'the newly chosen extra is committed');
  const row = await rowOf(p.id);
  assert.equal(Number(row.total_price), ack, 'committed total is the acknowledged total');
});

test('no-invoice branch: a proposal with nothing minted switches cleanly', async () => {
  const p = await insertProposal();
  const quote = await quoteFor(p.token);
  const ack = optionTotal(quote, hostedPkgId);
  const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: { package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [], acknowledged_total: ack },
  });
  assert.equal(res.status, 200, `no invoice to refresh must be a clean no-op: ${res.raw}`);
});

test('atomicity: a failing invoice refresh rolls back the ENTIRE switch', async () => {
  const p = await insertProposal();
  const quote = await quoteFor(p.token);
  const ack = optionTotal(quote, hostedPkgId);
  const before = await rowOf(p.id);

  refreshOverride = async () => { throw new Error('fixture: invoice refresh exploded'); };
  try {
    const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
      body: { package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [], acknowledged_total: ack },
    });
    assert.equal(res.status, 500, res.raw);
  } finally {
    refreshOverride = null;
  }

  const after = await rowOf(p.id);
  assert.equal(after.package_id, before.package_id, 'package rolled back');
  assert.equal(Number(after.total_price), Number(before.total_price), 'total rolled back');
  assert.deepEqual(after.pricing_snapshot, before.pricing_snapshot, 'snapshot rolled back');
  const log = await pool.query(
    `SELECT 1 FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'package_switched'`, [p.id]);
  assert.equal(log.rows.length, 0, 'no audit row for a rolled-back switch');
});
