require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  triggerLeadCall, advanceChain, __setDeps,
  CALL_WINDOW_START_HOUR, CALL_WINDOW_END_HOUR,
} = require('./leadCallTrigger');

// ─── lead-call trigger + chain driver ────────────────────────────
// Shared dev DB (suite runs ALONE). Twilio + email are stubbed via __setDeps;
// the DB is real so the ON CONFLICT idempotency, the atomic cap statement,
// and the guarded claims are exercised for real.

const RUN = `lct-test-${Date.now()}`;
const leadIds = [];
let placed = [];   // captured placeBridgedCall calls
let emails = [];   // captured notifyAdminCategory calls
let placeImpl;     // per-test placeBridgedCall behavior

const ENV_KEYS = ['LEAD_CALL_ENABLED', 'LEAD_CALL_DAILY_CAP', 'ADMIN_PHONE', 'VA_CELL', 'TWILIO_PHONE_NUMBER'];
const savedEnv = {};

async function makeLead(i, phone = '+17735550100') {
  const r = await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, customer_name, customer_phone, raw_payload)
     VALUES ($1, $2, $3, '{}'::jsonb) RETURNING id`,
    [`${RUN}-${i}`, `Test Lead ${i}`, phone]
  );
  leadIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function attemptFor(leadId) {
  const r = await pool.query('SELECT * FROM lead_call_attempts WHERE lead_id = $1', [leadId]);
  return r.rows[0] || null;
}

/** Cap headroom: current non-skipped rows in the rolling 24h window. */
async function nonSkippedCount() {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM lead_call_attempts
     WHERE created_at > NOW() - INTERVAL '24 hours' AND status NOT LIKE 'skipped%'`
  );
  return r.rows[0].n;
}

before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ADMIN_PHONE = '+13125550100';
  process.env.VA_CELL = '+639171234567';
  process.env.TWILIO_PHONE_NUMBER = '+18885550000';
  delete process.env.LEAD_CALL_ENABLED;
  delete process.env.LEAD_CALL_DAILY_CAP;
});

beforeEach(() => {
  placed = [];
  emails = [];
  placeImpl = async (opts) => { placed.push(opts); return { sid: `CA_stub_${placed.length}` }; };
  __setDeps({
    placeBridgedCall: (opts) => placeImpl(opts),
    cancelBridgedCall: async () => ({}),
    notifyAdminCategory: async (opts) => { emails.push(opts); return { emailed: 1 }; },
    chicagoHourNow: () => 12,
    pool,
  });
});

after(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  // Attempts cascade with the leads.
  await pool.query(`DELETE FROM thumbtack_leads WHERE negotiation_id LIKE $1`, [`${RUN}-%`]);
  await pool.end();
});

test('kill switch: LEAD_CALL_ENABLED=false inserts nothing and dials nothing', async () => {
  const leadId = await makeLead('kill');
  process.env.LEAD_CALL_ENABLED = 'false';
  try {
    await triggerLeadCall({ lead: { customerPhone: '+17735550100' }, leadId });
  } finally {
    delete process.env.LEAD_CALL_ENABLED;
  }
  assert.equal(await attemptFor(leadId), null);
  assert.equal(placed.length, 0);
});

test('window boundaries: 7 and 21 skip after-hours; 8 and 20 open the chain', async () => {
  assert.equal(CALL_WINDOW_START_HOUR, 8);
  assert.equal(CALL_WINDOW_END_HOUR, 21);
  for (const [hour, opens] of [[7, false], [21, false], [8, true], [20, true]]) {
    const leadId = await makeLead(`win-${hour}`);
    __setDeps({ chicagoHourNow: () => hour });
    await triggerLeadCall({ lead: { customerPhone: '+17735550100' }, leadId });
    const row = await attemptFor(leadId);
    if (opens) {
      assert.equal(row.status, 'calling_admin', `hour ${hour} must open`);
    } else {
      assert.equal(row.status, 'skipped_after_hours', `hour ${hour} must skip`);
    }
  }
  assert.equal(placed.length, 2, 'exactly the two in-window leads dialed');
  assert.ok(placed.every(p => p.to === '+13125550100' && p.callerId === '+18885550000'));
  assert.ok(placed.every(p => p.timeout === 25 && p.url.includes('leg=admin')));
});

test('unconfigured: no ADMIN_PHONE and no VA_CELL records skipped_unconfigured', async () => {
  const leadId = await makeLead('uncfg');
  delete process.env.ADMIN_PHONE;
  delete process.env.VA_CELL;
  try {
    await triggerLeadCall({ lead: { customerPhone: '+17735550100' }, leadId });
  } finally {
    process.env.ADMIN_PHONE = '+13125550100';
    process.env.VA_CELL = '+639171234567';
  }
  assert.equal((await attemptFor(leadId)).status, 'skipped_unconfigured');
  assert.equal(placed.length, 0);
});

test('dial-target validation: non-US, premium, and missing phones never open a chain', async () => {
  for (const [tag, phone, detail] of [
    ['uk', '+442071234567', 'invalid_phone'],
    ['premium', '+19005551234', 'invalid_phone'],
    ['none', null, 'no_phone'],
  ]) {
    const leadId = await makeLead(`phone-${tag}`, phone);
    await triggerLeadCall({ lead: { customerPhone: phone }, leadId });
    const row = await attemptFor(leadId);
    assert.equal(row.status, 'skipped_invalid_phone', tag);
    assert.equal(row.detail, detail, tag);
  }
  assert.equal(placed.length, 0);
});

test('duplicate webhook: second trigger is silent, one row, one dial', async () => {
  const leadId = await makeLead('dup');
  await triggerLeadCall({ lead: { customerPhone: '+17735550100' }, leadId });
  await triggerLeadCall({ lead: { customerPhone: '+17735550100' }, leadId });
  const rows = await pool.query('SELECT COUNT(*)::int AS n FROM lead_call_attempts WHERE lead_id = $1', [leadId]);
  assert.equal(rows.rows[0].n, 1);
  assert.equal(placed.length, 1);
  assert.equal(emails.length, 0);
});

test('cap: over-cap lead logs failed/cap_tripped; only the first trip emails', async () => {
  process.env.LEAD_CALL_DAILY_CAP = String((await nonSkippedCount())); // zero headroom
  try {
    const lead1 = await makeLead('cap-1');
    await triggerLeadCall({ lead: { customerPhone: '+17735550100' }, leadId: lead1 });
    const row1 = await attemptFor(lead1);
    assert.equal(row1.status, 'failed');
    assert.equal(row1.detail, 'cap_tripped');
    assert.equal(emails.length, 1, 'first trip emails');
    assert.ok(emails[0].subject.includes('daily cap tripped'));
    assert.equal(emails[0].category, 'lead_call');

    const lead2 = await makeLead('cap-2');
    await triggerLeadCall({ lead: { customerPhone: '+17735550100' }, leadId: lead2 });
    assert.equal((await attemptFor(lead2)).detail, 'cap_tripped');
    assert.equal(emails.length, 1, 'second trip within 24h must not email');
  } finally {
    delete process.env.LEAD_CALL_DAILY_CAP;
    // cap_tripped rows would suppress cap emails in later tests; clear them.
    await pool.query(`DELETE FROM lead_call_attempts WHERE detail = 'cap_tripped' AND lead_id = ANY($1)`, [leadIds]);
  }
  assert.equal(placed.length, 0);
});

test('unset LEAD_CALL_DAILY_CAP falls back to 25, never NaN', async () => {
  delete process.env.LEAD_CALL_DAILY_CAP;
  assert.ok((await nonSkippedCount()) < 25, 'precondition: test volume stays under the default cap');
  const leadId = await makeLead('capdefault');
  await triggerLeadCall({ lead: { customerPhone: '+17735550100' }, leadId });
  assert.equal((await attemptFor(leadId)).status, 'calling_admin', 'default cap must admit the lead');
});

test('admin create-failure fails over to the VA leg', async () => {
  const leadId = await makeLead('failover');
  placeImpl = async (opts) => {
    placed.push(opts);
    if (opts.url.includes('leg=admin')) { const e = new Error('twilio down'); e.code = 20500; throw e; }
    return { sid: 'CA_va_ok' };
  };
  await triggerLeadCall({ lead: { customerPhone: '+17735550100' }, leadId });
  const row = await attemptFor(leadId);
  assert.equal(row.status, 'calling_va');
  assert.equal(row.admin_call_status, 'create_failed');
  assert.equal(row.va_call_sid, 'CA_va_ok');
  assert.equal(emails.length, 0, 'chain still live: no email yet');
});

test('both legs failing to place ends failed with exactly one call-failed email', async () => {
  const leadId = await makeLead('bothfail');
  placeImpl = async (opts) => { placed.push(opts); throw new Error('twilio down'); };
  await triggerLeadCall({ lead: { customerPhone: '+17735550100' }, leadId });
  const row = await attemptFor(leadId);
  assert.equal(row.status, 'failed');
  assert.equal(emails.length, 1);
  assert.ok(emails[0].subject.includes('call failed'));
});

test('advanceChain from admin terminal claims the VA leg exactly once under a duplicate callback', async () => {
  const leadId = await makeLead('advance');
  await triggerLeadCall({ lead: { customerPhone: '+17735550100' }, leadId });
  const attemptId = (await attemptFor(leadId)).id;
  await Promise.all([
    advanceChain({ attemptId, fromLeg: 'admin' }),
    advanceChain({ attemptId, fromLeg: 'admin' }),
  ]);
  const row = await attemptFor(leadId);
  assert.equal(row.status, 'calling_va');
  assert.equal(placed.length, 2, 'admin leg + exactly one VA leg');
});

test('admin terminal with no VA configured ends missed quietly (no email; 2026-07-20 change)', async () => {
  const leadId = await makeLead('novacell');
  await triggerLeadCall({ lead: { customerPhone: '+17735550100' }, leadId });
  const attemptId = (await attemptFor(leadId)).id;
  delete process.env.VA_CELL;
  try {
    await advanceChain({ attemptId, fromLeg: 'admin' });
    await advanceChain({ attemptId, fromLeg: 'admin' }); // duplicate callback
  } finally {
    process.env.VA_CELL = '+639171234567';
  }
  const row = await attemptFor(leadId);
  assert.equal(row.status, 'missed');
  assert.equal(emails.length, 0, 'missed is a log state, never an alert');
});

test('two truly concurrent triggers for the SAME lead open one chain and dial once', async () => {
  // The lead_id UNIQUE + ON CONFLICT is the guard; this is the deterministic
  // race (unlike cross-lead cap overshoot, which is a bounded backstop by
  // design and not asserted).
  const leadId = await makeLead('race-same');
  await Promise.all([
    triggerLeadCall({ lead: { customerPhone: '+17735550100' }, leadId }),
    triggerLeadCall({ lead: { customerPhone: '+17735550100' }, leadId }),
  ]);
  const rows = await pool.query('SELECT COUNT(*)::int AS n FROM lead_call_attempts WHERE lead_id = $1', [leadId]);
  assert.equal(rows.rows[0].n, 1);
  assert.equal(placed.length, 1, 'exactly one admin leg dialed');
});

test('triggerLeadCall never throws to the webhook tail, even on a dead pool', async () => {
  __setDeps({ pool: { query: async () => { throw new Error('db down'); } } });
  await assert.doesNotReject(
    triggerLeadCall({ lead: { customerPhone: '+17735550100' }, leadId: 999999999 })
  );
});
