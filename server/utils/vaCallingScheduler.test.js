require('dotenv').config();
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const scheduler = require('./vaCallingScheduler');
const { checkTelegramWebhookHealth, pruneVaCallingRows, reapStaleLeadCallAttempts, reapUndeliveredVoicemails, __setDeps } = scheduler;

// Sentinel ids so the DB prune test never touches real rows on the shared dev DB.
const U_EXPIRED = 999000801;
const U_FRESH = 999000802;
const TG_OLD = 999000803;
const TG_FRESH = 999000804;
const AUDIT_TRIGGER = 999000805; // triggered_by sentinel for call_audit test rows

async function cleanup() {
  await pool.query('DELETE FROM pending_call WHERE user_id IN ($1, $2)', [U_EXPIRED, U_FRESH]);
  await pool.query('DELETE FROM telegram_update WHERE update_id IN ($1, $2)', [TG_OLD, TG_FRESH]);
  await pool.query('DELETE FROM call_audit WHERE triggered_by = $1', [AUDIT_TRIGGER]);
}

before(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});

// checkTelegramWebhookHealth is pure-unit; reset the injected deps after each so
// a stubbed dep never leaks into the DB-backed prune test.
// TELEGRAM_ALLOWED_USER_ID is set per-test by the sweep tests; snapshot it here
// so a throw mid-test cannot leak a value into the rest of the file.
const SAVED_TG_USER = process.env.TELEGRAM_ALLOWED_USER_ID;

afterEach(() => {
  if (SAVED_TG_USER === undefined) delete process.env.TELEGRAM_ALLOWED_USER_ID;
  else process.env.TELEGRAM_ALLOWED_USER_ID = SAVED_TG_USER;
  __setDeps({
    getTelegramWebhookInfo: require('./telegram').getTelegramWebhookInfo,
    setTelegramWebhook: require('./telegram').setTelegramWebhook,
    pruneVaCallingRows: require('./pendingCall').pruneVaCallingRows,
    notifyAdminCategory: require('./adminNotifications').notifyAdminCategory,
    // pool and the voicemail deps must be restored too: __setDeps MERGES, so a
    // stubbed pool would otherwise leak into every later DB-backed test.
    pool: require('../db').pool,
    deliverVoicemail: require('./voicemail').deliverVoicemail,
    sendTelegramMessage: require('./telegram').sendTelegramMessage,
    notificationsEnabled: require('./notificationsEnabled').notificationsEnabled,
  });
});

// ── checkTelegramWebhookHealth ────────────────────────────────────────────

test('healthy: url set, no recent error → no re-set, no alert', async () => {
  let setCalls = 0;
  let notifyCalls = 0;
  __setDeps({
    getTelegramWebhookInfo: async () => ({
      ok: true,
      result: { url: 'https://api.drbartender.com/api/telegram/secret', last_error_date: 0 },
    }),
    setTelegramWebhook: async () => { setCalls += 1; return { ok: true }; },
    notifyAdminCategory: async () => { notifyCalls += 1; },
  });

  const out = await checkTelegramWebhookHealth();
  assert.deepEqual(out, { healthy: true, reset: false });
  assert.equal(setCalls, 0, 'did not re-set a healthy webhook');
  assert.equal(notifyCalls, 0, 'did not alert on a healthy webhook');
});

test('unhealthy: empty url → re-sets webhook and alerts admin', async () => {
  let setCalls = 0;
  let notifyArg = null;
  __setDeps({
    getTelegramWebhookInfo: async () => ({ ok: true, result: { url: '' } }),
    setTelegramWebhook: async () => { setCalls += 1; return { ok: true }; },
    notifyAdminCategory: async (arg) => { notifyArg = arg; },
  });

  const out = await checkTelegramWebhookHealth();
  assert.equal(out.healthy, false);
  assert.equal(out.reset, true);
  assert.equal(setCalls, 1, 're-registered the missing webhook');
  assert.ok(notifyArg, 'admin was alerted');
  assert.equal(notifyArg.category, 'system_error');
});

test('unhealthy: last_error_date within the last hour → re-sets and alerts', async () => {
  let setCalls = 0;
  let notifyCalls = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  __setDeps({
    getTelegramWebhookInfo: async () => ({
      ok: true,
      result: {
        url: 'https://api.drbartender.com/api/telegram/secret',
        last_error_date: nowSec - 120, // 2 minutes ago
        last_error_message: 'Wrong response from the webhook: 500',
      },
    }),
    setTelegramWebhook: async () => { setCalls += 1; return { ok: true }; },
    notifyAdminCategory: async () => { notifyCalls += 1; },
  });

  const out = await checkTelegramWebhookHealth();
  assert.equal(out.reset, true);
  assert.equal(setCalls, 1);
  assert.equal(notifyCalls, 1);
});

test('healthy: old last_error_date (>1h ago) with url set → no re-set', async () => {
  let setCalls = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  __setDeps({
    getTelegramWebhookInfo: async () => ({
      ok: true,
      result: {
        url: 'https://api.drbartender.com/api/telegram/secret',
        last_error_date: nowSec - 7200, // 2 hours ago — recovered
      },
    }),
    setTelegramWebhook: async () => { setCalls += 1; return { ok: true }; },
    notifyAdminCategory: async () => {},
  });

  const out = await checkTelegramWebhookHealth();
  assert.deepEqual(out, { healthy: true, reset: false });
  assert.equal(setCalls, 0, 'a stale-but-old error does not trigger a re-set');
});

// ── pruneVaCallingRows (delegation to Task 5's SQL) ────────────────────────

test('pruneVaCallingRows: deletes expired/old rows, leaves fresh rows', async () => {
  // Expired vs. live pending_call (purged by expires_at).
  await pool.query(
    `INSERT INTO pending_call (user_id, target_e164, status, expires_at, created_at)
     VALUES ($1, '+13120000001', 'awaiting_confirm', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')`,
    [U_EXPIRED]
  );
  await pool.query(
    `INSERT INTO pending_call (user_id, target_e164, status, expires_at, created_at)
     VALUES ($1, '+13120000002', 'awaiting_confirm', NOW() + INTERVAL '1 hour', NOW())`,
    [U_FRESH]
  );
  // Old vs. fresh telegram_update (purged by created_at retention). 400 days is
  // safely past any retention window Task 5 defines.
  await pool.query(
    `INSERT INTO telegram_update (update_id, created_at) VALUES ($1, NOW() - INTERVAL '400 days')`,
    [TG_OLD]
  );
  await pool.query(
    `INSERT INTO telegram_update (update_id, created_at) VALUES ($1, NOW())`,
    [TG_FRESH]
  );
  // Old vs. fresh call_audit (purged by created_at retention).
  await pool.query(
    `INSERT INTO call_audit (triggered_by, target_e164, status, created_at)
     VALUES ($1, '+13120000003', 'placed', NOW() - INTERVAL '400 days')`,
    [AUDIT_TRIGGER]
  );
  await pool.query(
    `INSERT INTO call_audit (triggered_by, target_e164, status, created_at)
     VALUES ($1, '+13120000004', 'placed', NOW())`,
    [AUDIT_TRIGGER]
  );

  const deleted = await pruneVaCallingRows();
  assert.ok(deleted >= 3, `expected the 3 stale rows pruned, got ${deleted}`);

  const pc = await pool.query('SELECT user_id FROM pending_call WHERE user_id IN ($1,$2)', [U_EXPIRED, U_FRESH]);
  const pcIds = pc.rows.map((r) => Number(r.user_id));
  assert.ok(pcIds.includes(U_FRESH), 'live pending_call survives');
  assert.ok(!pcIds.includes(U_EXPIRED), 'expired pending_call pruned');

  const tg = await pool.query('SELECT update_id FROM telegram_update WHERE update_id IN ($1,$2)', [TG_OLD, TG_FRESH]);
  const tgIds = tg.rows.map((r) => Number(r.update_id));
  assert.ok(tgIds.includes(TG_FRESH), 'fresh telegram_update survives');
  assert.ok(!tgIds.includes(TG_OLD), 'old telegram_update pruned');

  const audit = await pool.query(
    `SELECT COUNT(*)::int AS n FROM call_audit WHERE triggered_by = $1 AND created_at < NOW() - INTERVAL '200 days'`,
    [AUDIT_TRIGGER]
  );
  assert.equal(audit.rows[0].n, 0, 'old call_audit pruned');
});

// ─── lead-call stale reaper (spec 2026-07-18 §4.5) ───────────────

test('reapStaleLeadCallAttempts: reaps only stale non-terminal rows, never connected, emails each', async () => {
  const RUN = `vcs-reap-${Date.now()}`;
  const emails = [];
  __setDeps({ pool, sendLeadCallChainEmail: async (args) => { emails.push(args); } });

  const mkLead = async (i) => (await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, customer_name, customer_phone, raw_payload)
     VALUES ($1, 'Reap Test', '+17735550100', '{}'::jsonb) RETURNING id`, [`${RUN}-${i}`]
  )).rows[0].id;
  const mkAttempt = async (leadId, status, ageMinutes) => (await pool.query(
    `INSERT INTO lead_call_attempts (lead_id, status, created_at)
     VALUES ($1, $2, NOW() - ($3 || ' minutes')::interval) RETURNING id`, [leadId, status, ageMinutes]
  )).rows[0].id;

  try {
    const stalePending = await mkAttempt(await mkLead('p'), 'pending', 45);
    const staleAdmin = await mkAttempt(await mkLead('a'), 'calling_admin', 45);
    const staleVa = await mkAttempt(await mkLead('v'), 'calling_va', 45);
    const freshAdmin = await mkAttempt(await mkLead('f'), 'calling_admin', 10);
    const staleConnected = await mkAttempt(await mkLead('c'), 'connected', 45);
    const staleMissed = await mkAttempt(await mkLead('m'), 'missed', 45);

    const reapedHere = [stalePending, staleAdmin, staleVa].map(Number);
    await reapStaleLeadCallAttempts();

    const rows = await pool.query(
      `SELECT id, status, detail FROM lead_call_attempts WHERE id = ANY($1)`,
      [[stalePending, staleAdmin, staleVa, freshAdmin, staleConnected, staleMissed]]
    );
    const byId = Object.fromEntries(rows.rows.map(r => [Number(r.id), r]));
    for (const id of reapedHere) {
      assert.equal(byId[id].status, 'failed', `stale row ${id} reaped`);
      assert.equal(byId[id].detail, 'stale_reaped');
    }
    assert.equal(byId[Number(freshAdmin)].status, 'calling_admin', 'fresh row untouched (30-minute floor)');
    assert.equal(byId[Number(staleConnected)].status, 'connected', 'a live bridge is NEVER reaped');
    assert.equal(byId[Number(staleMissed)].status, 'missed', 'terminal rows untouched');

    const emailedIds = emails.map(e => e.attemptId).filter(id => reapedHere.includes(id));
    assert.equal(emailedIds.length, 3, 'one email per reaped row (of this run)');
    assert.ok(emails.filter(e => reapedHere.includes(e.attemptId)).every(e => e.reason === 'call failed'));
  } finally {
    await pool.query(`DELETE FROM thumbtack_leads WHERE negotiation_id LIKE $1`, [`${RUN}-%`]);
  }
});

// ── reapUndeliveredVoicemails (spec 2026-07-22) ─────────────────────────────
// Twilio does not redeliver a recording status callback it already answered
// with a 2xx, so this sweep is the ONLY rescue for a crash between the delivery
// claim and the upload.

function vmRow(over) {
  return {
    call_sid: 'CAsweep0000000000000000000000000',
    from_e164: '+13125550147',
    recording_sid: 'RE' + 'a'.repeat(32),
    duration_sec: 9,
    attempts: 1,
    ...over,
  };
}

// Models the atomic claim: the UPDATE ... RETURNING attempts is what the sweep
// now uses instead of a bare SELECT plus an unconditional bump.
function sweepPool(row, { claimWins = true, postBumpAttempts = null } = {}) {
  return {
    query: async (sql) => {
      if (/^\s*SELECT/i.test(sql)) return { rows: row ? [row] : [] };
      if (/attempts = attempts \+ 1/i.test(sql)) {
        if (!claimWins) return { rows: [] };
        return { rows: [{ attempts: postBumpAttempts ?? (row.attempts + 1) }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

test('reapUndeliveredVoicemails retries a stuck row and counts a recovery', async () => {
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
  const seen = { jobs: [] };
  __setDeps({
    notificationsEnabled: () => true,
    pool: sweepPool(vmRow()),
    deliverVoicemail: async (job) => { seen.jobs.push(job); return 'delivered'; },
  });
  const n = await reapUndeliveredVoicemails();
  assert.equal(n, 1);
  assert.equal(seen.jobs.length, 1);
  assert.equal(seen.jobs[0].redelivered, true, 'the caption must say so');
});

test('reapUndeliveredVoicemails skips a row another pass already claimed', async () => {
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
  let delivered = 0;
  __setDeps({
    notificationsEnabled: () => true,
    pool: sweepPool(vmRow(), { claimWins: false }),
    deliverVoicemail: async () => { delivered += 1; return 'delivered'; },
  });
  const n = await reapUndeliveredVoicemails();
  assert.equal(n, 0);
  assert.equal(delivered, 0, 'the claim is what makes a second instance safe');
});

test('reapUndeliveredVoicemails does not run at all when notifications are gated off', async () => {
  // Sweeping while gated would burn every row's retry budget on sends that
  // never leave the box, and the give-up alert would be swallowed too.
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
  let queried = 0;
  __setDeps({
    notificationsEnabled: () => false,
    pool: { query: async () => { queried += 1; return { rows: [] }; } },
    deliverVoicemail: async () => 'skipped',
  });
  assert.equal(await reapUndeliveredVoicemails(), 0);
  assert.equal(queried, 0, 'it must not even look');
});

test('reapUndeliveredVoicemails leaves a skipped outcome retryable and never alerts', async () => {
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
  const seen = { messages: [] };
  __setDeps({
    notificationsEnabled: () => true,
    pool: sweepPool(vmRow({ attempts: 3 }), { postBumpAttempts: 4 }),
    deliverVoicemail: async () => 'skipped',
    sendTelegramMessage: async (_c, t) => { seen.messages.push(t); return { ok: true }; },
  });
  await reapUndeliveredVoicemails();
  assert.equal(seen.messages.length, 0, 'a gated send is not a delivery failure');
});

test('reapUndeliveredVoicemails alerts exactly once past the attempt ceiling', async () => {
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
  const seen = { messages: [] };
  __setDeps({
    notificationsEnabled: () => true,
    pool: sweepPool(vmRow({ attempts: 3 }), { postBumpAttempts: 4 }),
    deliverVoicemail: async () => 'failed',
    sendTelegramMessage: async (_c, t) => { seen.messages.push(t); return { ok: true }; },
  });
  await reapUndeliveredVoicemails();
  assert.equal(seen.messages.length, 1);
  assert.match(seen.messages[0], /Twilio console/);
});

test('reapUndeliveredVoicemails stays quiet below the ceiling', async () => {
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
  const seen = { messages: [] };
  __setDeps({
    notificationsEnabled: () => true,
    pool: sweepPool(vmRow({ attempts: 1 }), { postBumpAttempts: 2 }),
    deliverVoicemail: async () => 'failed',
    sendTelegramMessage: async (_c, t) => { seen.messages.push(t); return { ok: true }; },
  });
  await reapUndeliveredVoicemails();
  assert.equal(seen.messages.length, 0);
});

test('reapUndeliveredVoicemails no-ops in bootstrap mode (no allowlisted user)', async () => {
  delete process.env.TELEGRAM_ALLOWED_USER_ID;
  let queried = 0;
  __setDeps({
    notificationsEnabled: () => true,
    pool: { query: async () => { queried += 1; return { rows: [] }; } },
  });
  assert.equal(await reapUndeliveredVoicemails(), 0);
  assert.equal(queried, 0);
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
});

// ── sweep SQL against the REAL database ─────────────────────────────────────
// The stubbed-pool tests above cover the sweep's control flow but return their
// fixture row unconditionally, so they constrain NONE of the query's predicates:
// a re-review proved the entire WHERE clause could be deleted with every one of
// them still green. These tests run the actual SQL against the dev DB.

const VMPREFIX = 'CAsweepsql';
const vmSid = (n) => `${VMPREFIX}${String(n).padStart(22, '0')}`;

async function seedVm(n, over = {}) {
  const row = {
    status: 'recorded',
    recording_sid: 'RE' + 'a'.repeat(32),
    duration_sec: 9,
    attempts: 1,
    age: '30 minutes',
    delivered_at: null,
    ...over,
  };
  await pool.query(
    `INSERT INTO voicemail_delivery
       (call_sid, from_e164, recording_sid, duration_sec, status, attempts, delivered_at, created_at)
     VALUES ($1, '+13125550147', $2, $3, $4, $5, $6, NOW() - $7::interval)
     ON CONFLICT (call_sid) DO NOTHING`,
    [vmSid(n), row.recording_sid, row.duration_sec, row.status, row.attempts, row.delivered_at, row.age]
  );
}

// reapUndeliveredVoicemails' SELECT is deliberately unscoped (it is a global
// maintenance job), so on the SHARED dev DB it will happily pick up a real
// undelivered voicemail and burn its retry budget — and the stub returns
// 'delivered' without writing the ledger, so the damage is invisible. Three
// suite runs would push a real row past attempts=3, where it is never swept,
// never pruned, and never alerted on again. So: park every foreign eligible row
// out of the window first, run, then put them back exactly as they were.
async function sweepPicked() {
  const { pool: realPool } = require('../db');
  const { rows: foreign } = await realPool.query(
    `SELECT call_sid, attempts FROM voicemail_delivery
      WHERE status IN ('recorded','failed') AND recording_sid IS NOT NULL
        AND call_sid NOT LIKE $1`,
    [`${VMPREFIX}%`]
  );
  if (foreign.length > 0) {
    await realPool.query(
      `UPDATE voicemail_delivery SET attempts = 99
        WHERE call_sid = ANY($1::text[])`,
      [foreign.map((r) => r.call_sid)]
    );
  }
  const picked = [];
  try {
    __setDeps({
      notificationsEnabled: () => true,
      pool: realPool,
      deliverVoicemail: async (job) => { picked.push(job.callSid); return 'delivered'; },
    });
    process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
    await reapUndeliveredVoicemails();
  } finally {
    for (const r of foreign) {
      await realPool.query('UPDATE voicemail_delivery SET attempts = $2 WHERE call_sid = $1', [r.call_sid, r.attempts]);
    }
  }
  return picked;
}

test('sweep SQL: each WHERE predicate actually excludes what it claims to', async () => {
  await pool.query('DELETE FROM voicemail_delivery WHERE call_sid LIKE $1', [`${VMPREFIX}%`]);
  try {
    await seedVm(1);                                     // eligible
    await seedVm(2, { status: 'delivered' });            // terminal
    await seedVm(3, { recording_sid: null });            // nothing to fetch
    await seedVm(4, { duration_sec: 1 });                // too short to be real
    await seedVm(5, { age: '2 minutes' });               // still inside MIN_AGE
    await seedVm(6, { age: '30 days' });                 // past MAX_AGE (14d)
    await seedVm(7, { attempts: 9 });                    // past the ceiling
    await seedVm(8, { delivered_at: new Date().toISOString() }); // already delivered

    const picked = await sweepPicked();
    assert.deepEqual(picked, [vmSid(1)], 'only the eligible row may be swept');
  } finally {
    await pool.query('DELETE FROM voicemail_delivery WHERE call_sid LIKE $1', [`${VMPREFIX}%`]);
  }
});

test('sweep SQL: a stale concurrent pass cannot re-take a row (drives the real sweep)', async () => {
  // Round two shipped `AND attempts <= $2`, which is a ceiling and not a mutex:
  // a blocked second updater re-evaluates under READ COMMITTED and still
  // matches, so BOTH passes delivered. This test must FAIL if that regresses,
  // which means it has to call reapUndeliveredVoicemails, not retype its SQL.
  await pool.query('DELETE FROM voicemail_delivery WHERE call_sid LIKE $1', [`${VMPREFIX}%`]);
  try {
    await seedVm(10);
    // Simulate the losing pass: it read attempts BEFORE the winner bumped it.
    // Under the CAS this matches zero rows; under a ceiling it would win.
    await pool.query('UPDATE voicemail_delivery SET attempts = attempts + 1 WHERE call_sid = $1', [vmSid(10)]);
    const picked = await sweepPicked();
    assert.deepEqual(
      picked, [vmSid(10)],
      'the sweep must still claim it exactly once on its own read'
    );
    const { rows } = await pool.query('SELECT attempts FROM voicemail_delivery WHERE call_sid = $1', [vmSid(10)]);
    assert.equal(rows[0].attempts, 3, 'exactly one bump from the sweep itself');
  } finally {
    await pool.query('DELETE FROM voicemail_delivery WHERE call_sid LIKE $1', [`${VMPREFIX}%`]);
  }
});

test('sweep SQL: a row whose attempts moved under it is skipped, not re-delivered', async () => {
  // The concurrency case stated directly: the sweep SELECTs, something else
  // bumps attempts, and the CAS must then find nothing.
  await pool.query('DELETE FROM voicemail_delivery WHERE call_sid LIKE $1', [`${VMPREFIX}%`]);
  try {
    await seedVm(11);
    const { pool: realPool } = require('../db');
    let claimed = 0;
    __setDeps({
      notificationsEnabled: () => true,
      deliverVoicemail: async () => { claimed += 1; return 'delivered'; },
      pool: {
        query: async (sql, params) => {
          const r = await realPool.query(sql, params);
          // Between the SELECT and the CAS, a concurrent pass bumps the row.
          if (/^\s*SELECT/i.test(sql) && r.rows.some((x) => x.call_sid === vmSid(11))) {
            await realPool.query('UPDATE voicemail_delivery SET attempts = attempts + 1 WHERE call_sid = $1', [vmSid(11)]);
          }
          return r;
        },
      },
    });
    process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
    await reapUndeliveredVoicemails();
    assert.equal(claimed, 0, 'a stale claim must lose, or two passes deliver the same audio');
  } finally {
    await pool.query('DELETE FROM voicemail_delivery WHERE call_sid LIKE $1', [`${VMPREFIX}%`]);
  }
});
