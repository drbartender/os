require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('thumbtackAgent.replies.test.js refuses to run against production');
}
process.env.SEND_NOTIFICATIONS = 'false';
// Pin the offer knobs to their defaults BEFORE the router computes its consts
// (module-load reads, the HARVEST_COOLDOWN pattern).
delete process.env.MAX_FIRST_REPLY_ATTEMPTS;
delete process.env.FIRST_REPLY_COOLDOWN_INTERVAL;
delete process.env.FIRST_REPLY_CALL_MAX_AGE_MINUTES;

// Route-level tests for the TT auto first-reply endpoints (thumbtackAgent.js):
// GET /pending-first-replies, POST /first-reply-sent, POST /first-reply-failed.
// Harness mirrors admin/leadCalls.test.js (express app + real router + http
// helper); auth is the agent secret header (thumbtackAgent.queue.test.js
// precedent). triggerLeadCall is stubbed through the router's __setDeps seam,
// so nothing dials. Run ALONE (shared dev DB).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { toUsE164 } = require('../utils/usPhone');
const agentRouter = require('./thumbtackAgent');

const SECRET = `replies-secret-${Date.now()}-abcdefghijklmnop`;
const ORIG = {
  secret: process.env.THUMBTACK_AGENT_SECRET,
  autoreply: process.env.TT_AUTOREPLY_ENABLED,
  leadCall: process.env.LEAD_CALL_ENABLED,
};
const RUN = `fr-${Date.now()}`;
let server, baseUrl;
let seq = 0;

// Captured triggerLeadCall invocations (stub via the __setDeps seam).
const triggerCalls = [];
agentRouter.__setDeps({ triggerLeadCall: async (args) => { triggerCalls.push(args); } });

// Seeds a REAL snake_case lead row. frStatus/template/attempts drive the
// first_reply_* queue state; attemptedAgoMin/createdAgoMin backdate the lease
// and the lead age (cooldown, jitter, and freshness tests).
async function mkLead({ template, frStatus = 'pending', attempts = 0, attemptedAgoMin = null, createdAgoMin = 0, phone = '+17735550123' } = {}) {
  seq += 1;
  const neg = `${RUN}-${seq}`;
  const r = await pool.query(
    `INSERT INTO thumbtack_leads
       (negotiation_id, customer_name, customer_phone, status, raw_payload,
        first_reply_status, first_reply_template, first_reply_attempts,
        first_reply_attempted_at, created_at)
     VALUES ($1, $2, $3, 'new', '{}'::jsonb,
             $4, $5, $6,
             CASE WHEN $7::int IS NULL THEN NULL ELSE now() - ($7::int * interval '1 minute') END,
             now() - ($8::int * interval '1 minute'))
     RETURNING id`,
    [neg, `First Reply ${RUN} ${seq}`, phone, frStatus, template, attempts, attemptedAgoMin, createdAgoMin]
  );
  return { id: r.rows[0].id, neg };
}

function request(method, path, { body, secret = SECRET } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: {
          ...(secret === null ? {} : { 'x-thumbtack-agent-secret': secret }),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        } },
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
    if (payload) req.write(payload);
    req.end();
  });
}

const offer = (limit = 100) => request('GET', `/api/admin/thumbtack/pending-first-replies?limit=${limit}`);
const postSent = (neg, template) => request('POST', '/api/admin/thumbtack/first-reply-sent', { body: { negotiation_id: neg, template } });
const postFailed = (neg, reason) => request('POST', '/api/admin/thumbtack/first-reply-failed', { body: { negotiation_id: neg, reason } });
// The shared dev DB may hold other pending rows; assertions only read ours.
const mine = (rows) => (rows || []).filter((r) => String(r.negotiation_id).startsWith(`${RUN}-`));

before(async () => {
  process.env.THUMBTACK_AGENT_SECRET = SECRET;
  process.env.TT_AUTOREPLY_ENABLED = 'true';
  delete process.env.LEAD_CALL_ENABLED; // calls on (not 'false') unless a test flips it

  // The offer CTE WRITES (lease stamp + attempts bump + downgrade) with
  // limit up to 100: the shared dev DB must hold no offerable rows this
  // suite did not create, or real queued work gets leased/bumped/downgraded
  // by test runs (fleet finding; the sweep suite's precondition precedent).
  const pre = await pool.query(
    `SELECT COUNT(*)::int AS n FROM thumbtack_leads
     WHERE first_reply_status = 'pending'`
  );
  assert.equal(pre.rows[0].n, 0, 'precondition: stray pending first_reply rows on the dev DB; clean them and rerun');

  const app = express();
  app.use(express.json());
  app.use('/api/admin/thumbtack', agentRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const [k, v] of [
    ['THUMBTACK_AGENT_SECRET', ORIG.secret],
    ['TT_AUTOREPLY_ENABLED', ORIG.autoreply],
    ['LEAD_CALL_ENABLED', ORIG.leadCall],
  ]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (server) await new Promise((r) => server.close(r));
  // lead_call_attempts rows cascade with the leads.
  await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id LIKE $1', [`${RUN}-%`]);
  await pool.end();
});

test('auth: missing and wrong agent secret are 401', async () => {
  assert.equal((await request('GET', '/api/admin/thumbtack/pending-first-replies', { secret: null })).status, 401);
  assert.equal((await request('GET', '/api/admin/thumbtack/pending-first-replies', { secret: 'wrong-secret' })).status, 401);
});

test('kill switch: TT_AUTOREPLY_ENABLED not true returns [] and leases nothing', async () => {
  const lead = await mkLead({ template: 'day' });
  process.env.TT_AUTOREPLY_ENABLED = 'false';
  try {
    const r = await offer();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  } finally {
    process.env.TT_AUTOREPLY_ENABLED = 'true';
  }
  const db = await pool.query('SELECT first_reply_attempts, first_reply_attempted_at FROM thumbtack_leads WHERE id = $1', [lead.id]);
  assert.equal(db.rows[0].first_reply_attempts, 0, 'kill switch must not lease');
  assert.equal(db.rows[0].first_reply_attempted_at, null);
  // Neutralize so later offers do not keep re-leasing this row.
  await pool.query(`UPDATE thumbtack_leads SET first_reply_status = 'not_needed' WHERE id = $1`, [lead.id]);
});

test('offer: leases + bumps attempts offer-side; cap-flips to failed and NEVER offers those', async () => {
  const fresh = await mkLead({ template: 'day' });               // attempts 0 -> offer 1
  const capped = await mkLead({ template: 'day', attempts: 3 }); // pre-bump 3 >= MAX 3 -> failed
  const r = await offer();
  assert.equal(r.status, 200);
  const got = mine(r.body);
  const negs = got.map((x) => x.negotiation_id);
  assert.ok(negs.includes(fresh.neg), 'fresh pending day row is offered');
  assert.ok(!negs.includes(capped.neg), 'cap-flipped row is never handed to the agent');

  const offered = got.find((x) => x.negotiation_id === fresh.neg);
  for (const k of ['negotiation_id', 'customer_name', 'first_reply_template', 'created_at']) {
    assert.ok(k in offered, `offer field ${k}`);
  }
  assert.equal(offered.first_reply_template, 'day');

  const a = await pool.query('SELECT first_reply_status, first_reply_attempts, first_reply_attempted_at FROM thumbtack_leads WHERE id = $1', [fresh.id]);
  assert.equal(a.rows[0].first_reply_status, 'pending', 'offered row stays pending');
  assert.equal(a.rows[0].first_reply_attempts, 1, 'the OFFER bumps the counter');
  assert.ok(a.rows[0].first_reply_attempted_at, 'lease stamped');

  const b = await pool.query('SELECT first_reply_status, first_reply_attempts FROM thumbtack_leads WHERE id = $1', [capped.id]);
  assert.equal(b.rows[0].first_reply_status, 'failed', 'at the cap the offer flips to failed');
  assert.equal(b.rows[0].first_reply_attempts, 4, 'the flipping offer still bumps');
});

test('cooldown: a freshly leased row is withheld; past-cooldown re-offers and bumps again', async () => {
  const inCooldown = await mkLead({ template: 'day', attempts: 1, attemptedAgoMin: 1 });
  const pastCooldown = await mkLead({ template: 'day', attempts: 1, attemptedAgoMin: 11 });
  const r = await offer();
  const negs = mine(r.body).map((x) => x.negotiation_id);
  assert.ok(!negs.includes(inCooldown.neg), 'inside the 10 minute cooldown: withheld');
  assert.ok(negs.includes(pastCooldown.neg), 'past cooldown: re-offered');
  const db = await pool.query('SELECT first_reply_attempts FROM thumbtack_leads WHERE id = $1', [pastCooldown.id]);
  assert.equal(db.rows[0].first_reply_attempts, 2, 're-offer bumps again');
});

test('night jitter: too-fresh night row withheld, older than 15 min offers; day offers immediately', async () => {
  const freshNight = await mkLead({ template: 'night', createdAgoMin: 0 });
  // Jitter max is 2 + (id % 13) = 14 minutes, so 16 always clears it.
  const oldNight = await mkLead({ template: 'night', createdAgoMin: 16 });
  const freshDay = await mkLead({ template: 'day', createdAgoMin: 0 });
  const r = await offer();
  const negs = mine(r.body).map((x) => x.negotiation_id);
  assert.ok(!negs.includes(freshNight.neg), 'night row inside its jitter window is withheld');
  assert.ok(negs.includes(oldNight.neg), 'night row past the max jitter offers');
  assert.ok(negs.includes(freshDay.neg), 'day rows offer immediately (call ordering dominates)');
});

test('offer downgrades day to night while LEAD_CALL_ENABLED=false (never promise a call we will not place)', async () => {
  const lead = await mkLead({ template: 'day' });
  process.env.LEAD_CALL_ENABLED = 'false';
  let r;
  try {
    r = await offer();
  } finally {
    delete process.env.LEAD_CALL_ENABLED;
  }
  const got = mine(r.body).find((x) => x.negotiation_id === lead.neg);
  assert.ok(got, 'downgraded row is still offered');
  assert.equal(got.first_reply_template, 'night', 'offered as night');
  const db = await pool.query('SELECT first_reply_template FROM thumbtack_leads WHERE id = $1', [lead.id]);
  assert.equal(db.rows[0].first_reply_template, 'night', 'downgrade persisted in the DB');
});

test('sent flip (day, fresh): fires the trigger once with the constructed camelCase lead shape', async () => {
  const lead = await mkLead({ template: 'day', phone: '+17735550188' });
  triggerCalls.length = 0;
  const r = await postSent(lead.neg, 'day');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'ok' });
  assert.equal(triggerCalls.length, 1, 'flip winner dials exactly once');
  const call = triggerCalls[0];
  // Lead-shape law regression (gaps blocker): camelCase customerPhone built
  // explicitly from the REAL snake_case row, and it passes dial validation.
  assert.deepEqual(call.lead, { customerPhone: '+17735550188' });
  assert.ok(toUsE164(call.lead.customerPhone), 'dial-target validation passes on the constructed shape');
  assert.equal(typeof call.leadId, 'number');
  assert.equal(call.leadId, Number(lead.id));
  assert.equal(call.skipWindowCheck, true);
  const db = await pool.query('SELECT first_reply_status, first_reply_sent_at FROM thumbtack_leads WHERE id = $1', [lead.id]);
  assert.equal(db.rows[0].first_reply_status, 'sent');
  assert.ok(db.rows[0].first_reply_sent_at);
});

test('duplicate sent report: noop, no second dial', async () => {
  const lead = await mkLead({ template: 'day' });
  triggerCalls.length = 0;
  await postSent(lead.neg, 'day');
  const dup = await postSent(lead.neg, 'day');
  assert.equal(dup.status, 200);
  assert.deepEqual(dup.body, { status: 'noop' });
  assert.equal(triggerCalls.length, 1, 'only the flip winner dials');
});

test('stale sent (past the freshness bound): inserts reply_confirmed_late, never dials', async () => {
  const lead = await mkLead({ template: 'day', createdAgoMin: 300 }); // > 240 default
  triggerCalls.length = 0;
  const r = await postSent(lead.neg, 'day');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'ok' });
  assert.equal(triggerCalls.length, 0, 'no surprise late call');
  const att = await pool.query('SELECT status, detail FROM lead_call_attempts WHERE lead_id = $1', [lead.id]);
  assert.equal(att.rowCount, 1);
  assert.equal(att.rows[0].status, 'failed');
  assert.equal(att.rows[0].detail, 'reply_confirmed_late');
  const db = await pool.query('SELECT first_reply_status FROM thumbtack_leads WHERE id = $1', [lead.id]);
  assert.equal(db.rows[0].first_reply_status, 'sent', 'the reply still counts as sent');
});

test('night flip never dials, even when the posted body forges day (DB template wins)', async () => {
  const lead = await mkLead({ template: 'night' });
  triggerCalls.length = 0;
  const r = await postSent(lead.neg, 'day'); // forged: the DB says night
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'ok' });
  assert.equal(triggerCalls.length, 0, 'night template never dials');
  const att = await pool.query('SELECT 1 FROM lead_call_attempts WHERE lead_id = $1', [lead.id]);
  assert.equal(att.rowCount, 0, 'no fault row for a night reply');
  const db = await pool.query('SELECT first_reply_status FROM thumbtack_leads WHERE id = $1', [lead.id]);
  assert.equal(db.rows[0].first_reply_status, 'sent');
});

test('sent validation: unknown template 400, missing negotiation_id 400', async () => {
  assert.equal((await postSent(`${RUN}-nonexistent`, 'brunch')).status, 400);
  assert.equal((await postSent('', 'day')).status, 400);
});

test('failed: valid reason flips pending to failed; duplicate is a noop', async () => {
  const lead = await mkLead({ template: 'night' });
  const r = await postFailed(lead.neg, 'template_not_found');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'ok' });
  const db = await pool.query('SELECT first_reply_status FROM thumbtack_leads WHERE id = $1', [lead.id]);
  assert.equal(db.rows[0].first_reply_status, 'failed');
  const dup = await postFailed(lead.neg, 'template_not_found');
  assert.equal(dup.status, 200);
  assert.deepEqual(dup.body, { status: 'noop' });
});

test('failed validation: unknown reason 400 and the row stays pending', async () => {
  const lead = await mkLead({ template: 'night' });
  assert.equal((await postFailed(lead.neg, 'dog_ate_it')).status, 400);
  const db = await pool.query('SELECT first_reply_status FROM thumbtack_leads WHERE id = $1', [lead.id]);
  assert.equal(db.rows[0].first_reply_status, 'pending', 'a 400 must not flip the row');
});

// ─── Fleet-fix regression tests (2026-07-22 review round) ────────

test('failed callback on a FRESH day lead still fires the promised call (blocker fix)', async () => {
  const lead = await mkLead({ template: 'day', createdAgoMin: 2 });
  triggerCalls.length = 0;
  const res = await postFailed(lead.neg, 'template_not_found');
  assert.equal(res.status, 200);
  assert.equal(triggerCalls.length, 1, 'a fast definitive reply failure must not kill the call');
  assert.deepEqual(triggerCalls[0].lead, { customerPhone: '+17735550123' });
  assert.equal(triggerCalls[0].skipWindowCheck, true);
  const db = await pool.query('SELECT first_reply_status FROM thumbtack_leads WHERE id = $1', [lead.id]);
  assert.equal(db.rows[0].first_reply_status, 'failed');
});

test('failed callback on a STALE day lead inserts the fault row instead of dialing', async () => {
  const lead = await mkLead({ template: 'day', createdAgoMin: 300 });
  triggerCalls.length = 0;
  assert.equal((await postFailed(lead.neg, 'lead_not_found')).status, 200);
  assert.equal(triggerCalls.length, 0, 'promise expired: no surprise late call');
  const a = await pool.query('SELECT status, detail FROM lead_call_attempts WHERE lead_id = $1', [lead.id]);
  assert.equal(a.rows[0].status, 'failed');
  assert.equal(a.rows[0].detail, 'reply_stale');
});

test('failed callback on a night lead never dials', async () => {
  const lead = await mkLead({ template: 'night', createdAgoMin: 30 });
  triggerCalls.length = 0;
  assert.equal((await postFailed(lead.neg, 'send_unverified')).status, 200);
  assert.equal(triggerCalls.length, 0);
});

test('offer excludes rows older than the freshness bound (never a weeks-late reply)', async () => {
  const stale = await mkLead({ template: 'day', createdAgoMin: 300 });
  const fresh = await mkLead({ template: 'day', createdAgoMin: 5 });
  const res = await offer();
  const negs = res.body.map((r) => r.negotiation_id);
  assert.ok(negs.includes(fresh.neg), 'fresh row offered');
  assert.ok(!negs.includes(stale.neg), 'over-age row never offered');
  const db = await pool.query('SELECT first_reply_status, first_reply_attempts FROM thumbtack_leads WHERE id = $1', [stale.id]);
  assert.equal(db.rows[0].first_reply_status, 'pending', 'retirement belongs to the sweep, not the offer');
  assert.equal(db.rows[0].first_reply_attempts, 0, 'no lease burn on an excluded row');
});
