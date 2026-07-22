require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('firstReplySweepScheduler.test.js refuses to run against production');
}
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { runFirstReplySweep, __setDeps } = require('./firstReplySweepScheduler');

// ─── first-reply fallback + hygiene sweep ────────────────────────
// Shared dev DB (suite runs ALONE). triggerLeadCall / enqueueFirstReply are
// stubbed via __setDeps; the DB is real so the eligibility predicates, the
// ON CONFLICT one-time stale mark, and the LIMIT drain are exercised for real.

const RUN = `frs-test-${Date.now()}`;
const leadIds = [];
let triggered = [];  // captured triggerLeadCall args
let enqueued = [];   // captured enqueueFirstReply args
let inFlight = 0;
let maxInFlight = 0; // > 1 would mean Arm A stopped awaiting sequentially

const ENV_KEYS = [
  'LEAD_CALL_ENABLED', 'TT_AUTOREPLY_ENABLED',
  'FIRST_REPLY_FALLBACK_MINUTES', 'FIRST_REPLY_CALL_MAX_AGE_MINUTES',
];
const savedEnv = {};

async function makeLead(tag, { status = 'pending', template = 'day', ageMinutes = 10, phone = '+17735550100' } = {}) {
  const r = await pool.query(
    `INSERT INTO thumbtack_leads
       (negotiation_id, customer_name, customer_phone, raw_payload,
        first_reply_status, first_reply_template, created_at)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, NOW() - make_interval(mins => $6))
     RETURNING id`,
    [`${RUN}-${tag}`, `Sweep Lead ${tag}`, phone, status, template, ageMinutes]
  );
  leadIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function insertAttempt(leadId, status = 'pending') {
  await pool.query(
    `INSERT INTO lead_call_attempts (lead_id, status) VALUES ($1, $2)
     ON CONFLICT (lead_id) DO NOTHING`,
    [leadId, status]
  );
}

async function attemptFor(leadId) {
  const r = await pool.query('SELECT * FROM lead_call_attempts WHERE lead_id = $1', [leadId]);
  return r.rows[0] || null;
}

/** Stub calls scoped to this run's leads (shared-DB hygiene for asserts). */
function oursTriggered() { return triggered.filter((t) => leadIds.includes(t.leadId)); }
function oursEnqueued() { return enqueued.filter((e) => leadIds.includes(e.leadId)); }

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k]; // defaults: fallback 3, max age 240

  // Count assertions below require equality, so the shared dev DB must hold
  // no sweep-eligible rows this suite did not create. Stray rows mean an
  // earlier suite failed to clean up; clean them and rerun.
  const pre = await pool.query(
    `SELECT COUNT(*)::int AS n FROM thumbtack_leads l
     WHERE ((l.first_reply_template = 'day' AND l.first_reply_status IN ('pending','sent','failed'))
            OR l.first_reply_status = 'pending'
            OR (l.first_reply_status = 'not_needed' AND l.created_at > NOW() - INTERVAL '60 minutes'))
       AND NOT EXISTS (SELECT 1 FROM lead_call_attempts a WHERE a.lead_id = l.id)`
  );
  assert.equal(pre.rows[0].n, 0, 'precondition: stray sweep-eligible thumbtack_leads rows on the dev DB');
});

beforeEach(async () => {
  // Neutralize the previous test's rows. Since the fleet fix widened Arm A to
  // rescue sent/failed strands, NO first_reply_status is invisible anymore;
  // the universal exclusion across every arm is an attempt row, so plant one
  // on any prior lead that lacks it (and retire its reply state for B2).
  await pool.query(
    `INSERT INTO lead_call_attempts (lead_id, status, detail)
     SELECT id, 'skipped_after_hours', 'test_neutralized'
     FROM thumbtack_leads WHERE negotiation_id LIKE $1
     ON CONFLICT (lead_id) DO NOTHING`,
    [`${RUN}-%`]
  );
  await pool.query(
    `UPDATE thumbtack_leads SET first_reply_status = 'sent' WHERE negotiation_id LIKE $1 AND first_reply_status = 'pending'`,
    [`${RUN}-%`]
  );
  triggered = [];
  enqueued = [];
  inFlight = 0;
  maxInFlight = 0;
  __setDeps({
    pool,
    triggerLeadCall: async (args) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      triggered.push(args);
      // Mirror the real trigger's chain open so a drained row stops being
      // offered (the sweep's NOT EXISTS is the only re-offer guard).
      await pool.query(
        `INSERT INTO lead_call_attempts (lead_id, status) VALUES ($1, 'pending')
         ON CONFLICT (lead_id) DO NOTHING`,
        [args.leadId]
      );
      await new Promise((res) => setTimeout(res, 5));
      inFlight -= 1;
    },
    enqueueFirstReply: async (args) => { enqueued.push(args); },
  });
});

after(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  // Attempts cascade with the leads.
  await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id LIKE $1', [`${RUN}-%`]);
  await pool.end();
});

test('Arm A fires day rows (pending AND flipped strands) past-threshold, young-enough, no-attempt; Arm B retires + stale-marks the aged-out one', async () => {
  const eligible = await makeLead('a-elig', { ageMinutes: 10 });
  const tooFresh = await makeLead('a-fresh', { ageMinutes: 1 });
  const tooOld = await makeLead('a-old', { ageMinutes: 300 });
  const night = await makeLead('a-night', { template: 'night', ageMinutes: 10 });
  const sent = await makeLead('a-sent', { status: 'sent', ageMinutes: 10 });
  const hasAttempt = await makeLead('a-attempt', { ageMinutes: 10 });
  await insertAttempt(hasAttempt, 'pending');

  // TT_AUTOREPLY_ENABLED is unset here on purpose: the sweep must run with
  // the feature flag off (rollback drains in-flight leads).
  assert.equal(process.env.TT_AUTOREPLY_ENABLED, undefined);
  const counts = await runFirstReplySweep();

  // The 'sent' no-attempt-row strand is now rescued too (fleet fix: a crash
  // between the callback's flip and its trigger must not lose the call).
  assert.deepEqual(oursTriggered().map((t) => t.leadId), [eligible, sent]);
  assert.ok(oursTriggered().every((t) => t.skipWindowCheck === true));
  assert.deepEqual(counts, { calledBack: 2, retired: 1, staleMarked: 1, reEnqueued: 0 });

  const staleRow = await attemptFor(tooOld);
  assert.equal(staleRow.status, 'failed');
  assert.equal(staleRow.detail, 'reply_stale');

  for (const [tag, id] of [['fresh', tooFresh], ['night', night]]) {
    assert.equal(await attemptFor(id), null, `${tag} lead must be untouched`);
  }
  // Retirement flipped the aged-out row so a re-enable can never offer it.
  const retired = await pool.query('SELECT first_reply_status FROM thumbtack_leads WHERE id = $1', [tooOld]);
  assert.equal(retired.rows[0].first_reply_status, 'failed');
  // Arm A never touches first_reply_status.
  const r = await pool.query('SELECT first_reply_status FROM thumbtack_leads WHERE id = $1', [eligible]);
  assert.equal(r.rows[0].first_reply_status, 'pending');
});

test('kill switch: LEAD_CALL_ENABLED=false skips Arm A entirely; Arm B stale-mark still runs', async () => {
  const eligible = await makeLead('kill-elig', { ageMinutes: 10 });
  const stale = await makeLead('kill-stale', { ageMinutes: 300 });

  process.env.LEAD_CALL_ENABLED = 'false';
  let counts;
  try {
    counts = await runFirstReplySweep();
  } finally {
    delete process.env.LEAD_CALL_ENABLED;
  }

  assert.deepEqual(oursTriggered(), []);
  assert.deepEqual(counts, { calledBack: 0, retired: 1, staleMarked: 1, reEnqueued: 0 });
  assert.equal((await attemptFor(stale)).detail, 'reply_stale');
  assert.equal(await attemptFor(eligible), null, 'no call while killed; a later tick drains it');
});

test('LIMIT 3 per tick, sequential, oldest first; the second tick drains the remaining 2', async () => {
  const ids = [];
  for (const [i, age] of [[0, 239], [1, 235], [2, 230], [3, 225], [4, 220]]) {
    ids.push(await makeLead(`limit-${i}`, { ageMinutes: age }));
  }

  const first = await runFirstReplySweep();
  assert.equal(first.calledBack, 3);
  assert.deepEqual(oursTriggered().map((t) => t.leadId), ids.slice(0, 3), 'oldest three, in created_at order');
  assert.equal(maxInFlight, 1, 'triggers must be awaited sequentially, never in parallel');

  triggered = [];
  const second = await runFirstReplySweep();
  assert.equal(second.calledBack, 2);
  assert.deepEqual(oursTriggered().map((t) => t.leadId), ids.slice(3), 'second tick drains the rest');
});

test('double-fire safety: a pre-existing attempt row (callback won) is never re-offered', async () => {
  const leadId = await makeLead('dbl', { ageMinutes: 10 });
  await insertAttempt(leadId, 'calling_admin');

  const c1 = await runFirstReplySweep();
  const c2 = await runFirstReplySweep();
  assert.deepEqual(oursTriggered(), []);
  assert.equal(c1.calledBack + c2.calledBack, 0);
});

test('Arm B stale-mark is one-time: the second tick inserts nothing', async () => {
  const leadId = await makeLead('stale-once', { ageMinutes: 400 });

  const c1 = await runFirstReplySweep();
  assert.equal(c1.staleMarked, 1);
  const c2 = await runFirstReplySweep();
  assert.equal(c2.staleMarked, 0);

  const rows = await pool.query('SELECT COUNT(*)::int AS n FROM lead_call_attempts WHERE lead_id = $1', [leadId]);
  assert.equal(rows.rows[0].n, 1);
});

test('Arm B re-enqueue: only under TT_AUTOREPLY_ENABLED, only younger than 60 min, only with no attempt row', async () => {
  const young = await makeLead('heal-young', { status: 'not_needed', template: null, ageMinutes: 5 });
  const old = await makeLead('heal-old', { status: 'not_needed', template: null, ageMinutes: 90 });
  const attempted = await makeLead('heal-attempted', { status: 'not_needed', template: null, ageMinutes: 5 });
  await insertAttempt(attempted, 'skipped_after_hours');

  // Flag off: no heal (deliberate flag-off leads stay untouched).
  const offCounts = await runFirstReplySweep();
  assert.deepEqual(oursEnqueued(), []);
  assert.equal(offCounts.reEnqueued, 0);

  process.env.TT_AUTOREPLY_ENABLED = 'true';
  let onCounts;
  try {
    onCounts = await runFirstReplySweep();
  } finally {
    delete process.env.TT_AUTOREPLY_ENABLED;
  }

  assert.deepEqual(oursEnqueued(), [{
    lead: { customerPhone: '+17735550100' },
    leadId: young,
  }]);
  assert.equal(onCounts.reEnqueued, 1);
  assert.ok(!oursEnqueued().some((e) => e.leadId === old), '60-min bound excludes older strands');
  assert.ok(!oursEnqueued().some((e) => e.leadId === attempted), 'an attempt row means the lead was handled');
});

test('Arm A rescues a fast-definitive-failure strand (failed day row, no attempt): the promised call fires (blocker fix)', async () => {
  const strand = await makeLead('failed-strand', { status: 'failed', ageMinutes: 10 });
  const counts = await runFirstReplySweep();
  assert.ok(oursTriggered().some((t) => t.leadId === strand), 'failed-state strand must still get its call');
  assert.ok(counts.calledBack >= 1);
});

test('retirement covers NIGHT pending rows too, with no fault row and no call', async () => {
  const nightOld = await makeLead('night-old', { template: 'night', ageMinutes: 300 });
  const counts = await runFirstReplySweep();
  assert.ok(counts.retired >= 1);
  const db = await pool.query('SELECT first_reply_status FROM thumbtack_leads WHERE id = $1', [nightOld]);
  assert.equal(db.rows[0].first_reply_status, 'failed', 'stale night row retires quietly');
  assert.equal(await attemptFor(nightOld), null, 'no fault row for a night lead (no call was ever promised)');
  assert.ok(!oursTriggered().some((t) => t.leadId === nightOld));
});

test('one arm failing does not mask the other; the tick still rethrows for schedulerHealth', async () => {
  const stale = await makeLead('mask-stale', { ageMinutes: 300 });
  const realQuery = pool.query.bind(pool);
  __setDeps({
    pool: {
      query: async (sql, params) => {
        // Kill only Arm A's SELECT; the stale-mark INSERT must still land.
        if (typeof sql === 'string' && sql.includes('LIMIT 3')) throw new Error('db blip on Arm A');
        return realQuery(sql, params);
      },
    },
  });
  try {
    await assert.rejects(runFirstReplySweep(), /db blip on Arm A/);
  } finally {
    __setDeps({ pool });
  }
  assert.equal((await attemptFor(stale)).detail, 'reply_stale', 'Arm B ran despite the Arm A failure');
});
