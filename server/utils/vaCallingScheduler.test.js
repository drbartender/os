require('dotenv').config();
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const scheduler = require('./vaCallingScheduler');
const { checkTelegramWebhookHealth, pruneVaCallingRows, reapStaleLeadCallAttempts, __setDeps } = scheduler;

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
afterEach(() => {
  __setDeps({
    getTelegramWebhookInfo: require('./telegram').getTelegramWebhookInfo,
    setTelegramWebhook: require('./telegram').setTelegramWebhook,
    pruneVaCallingRows: require('./pendingCall').pruneVaCallingRows,
    notifyAdminCategory: require('./adminNotifications').notifyAdminCategory,
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
