require('dotenv').config();
// Force notifications off regardless of local .env — this test never sends; it
// races the enrollment-step claim only.
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { claimSequenceStep } = require('./emailSequenceScheduler');

if (process.env.NODE_ENV === 'production') {
  throw new Error('emailSequenceScheduler.claim.test.js refuses to run against production');
}

// ── Optimistic per-step claim: exactly-once drip send under concurrent ticks ──
// Two scheduler ticks (or instances) can both read an enrollment as due at
// current_step = N and both send step N+1. The fix advances current_step
// N -> N+1 conditional on it still being N (UPDATE ... WHERE current_step = N
// RETURNING) BEFORE the send, so exactly one tick claims the step and sends.
//
// Gate/race, util-level: a gate connection holds an open transaction that has
// already claimed the step (advanced to N+1, uncommitted). The REAL
// claimSequenceStep is fired on the pool; its UPDATE blocks on the gate's row
// lock, the gate commits, and the real claim then re-evaluates its
// current_step = N predicate against the now-advanced row -> 0 rows -> it loses.
// Discrimination check: drop `AND current_step = $3` from claimSequenceStep and
// the real claim "succeeds" against the advanced row (returns 1) — this test then
// fails.

const PREFIX = 'esq-claim-test-';

let leadId, campaignId, enrollmentId;

before(async () => {
  const lead = await pool.query(
    `INSERT INTO email_leads (name, email) VALUES ($1, $2) RETURNING id`,
    ['Sequence Claim Test Lead', `${PREFIX}lead@example.com`]
  );
  leadId = lead.rows[0].id;

  const camp = await pool.query(
    `INSERT INTO email_campaigns (name, type, status) VALUES ($1, 'sequence', 'active') RETURNING id`,
    [`${PREFIX}campaign`]
  );
  campaignId = camp.rows[0].id;

  const enr = await pool.query(
    `INSERT INTO email_sequence_enrollments (campaign_id, lead_id, current_step, status, next_step_due_at)
     VALUES ($1, $2, 0, 'active', NOW()) RETURNING id`,
    [campaignId, leadId]
  );
  enrollmentId = enr.rows[0].id;
});

after(async () => {
  if (enrollmentId) await pool.query('DELETE FROM email_sequence_enrollments WHERE id = $1', [enrollmentId]);
  if (campaignId) await pool.query('DELETE FROM email_campaigns WHERE id = $1', [campaignId]);
  if (leadId) await pool.query('DELETE FROM email_leads WHERE id = $1', [leadId]);
  await pool.end();
});

test('a concurrent tick that already advanced the step wins; the real claim loses (step advances once)', async () => {
  const gate = await pool.connect();
  let realClaimed;
  let gateRowCount;
  try {
    await gate.query('BEGIN');
    // Gate = "the other worker": claim step 1 (advance 0 -> 1) and hold the row
    // lock without committing.
    const gateRes = await gate.query(
      `UPDATE email_sequence_enrollments SET current_step = 1, last_step_sent_at = NOW()
        WHERE id = $1 AND current_step = 0 RETURNING id`,
      [enrollmentId]
    );
    gateRowCount = gateRes.rowCount;

    // Fire the REAL claim WITHOUT awaiting. It reads nothing new; its UPDATE
    // (WHERE current_step = 0) parks on the gate's row lock.
    const pending = claimSequenceStep(enrollmentId, 0, 1, null);

    // Give it time to reach the lock wait, then let the gate commit.
    await new Promise((r) => setTimeout(r, 400));
    await gate.query('COMMIT');

    realClaimed = await pending;
  } finally {
    gate.release();
  }

  assert.equal(gateRowCount, 1, 'the gate (first worker) must win the claim');
  assert.equal(realClaimed, 0, 'the real claim must lose once the gate advanced the step');

  const { rows } = await pool.query(
    'SELECT current_step FROM email_sequence_enrollments WHERE id = $1',
    [enrollmentId]
  );
  assert.equal(rows[0].current_step, 1, 'current_step must advance exactly once (not skip to 2)');
});

// ─── Marketing suppression (review finding H2) ─────────────────────

const { pool: seqPool } = require('../db');
const { clientOptedOutByEmail } = require('./marketingAudience');

// These drive the SHARED predicate the scheduler interpolates, not a re-typed
// copy of it. The first draft of these tests pasted the SQL into the test, so
// deleting the clause from the scheduler would have left them green.

async function wouldSend(leadId) {
  const { rows } = await seqPool.query(
    `SELECT NOT ${clientOptedOutByEmail('l.email')} AS would_send
       FROM email_leads l WHERE l.id = $1`, [leadId]);
  return rows[0].would_send;
}

test('the scheduler query text actually contains the suppression clause', async () => {
  // Guards the case the previous draft missed: the predicate could be correct
  // and simply not wired into the query the scheduler runs.
  const src = require('fs').readFileSync(__dirname + '/emailSequenceScheduler.js', 'utf8');
  assert.match(src, /clientOptedOutByEmail\('l\.email'\)/,
    'emailSequenceScheduler must gate its due-enrollment query on the client identity');
});

test('a due enrollment is skipped when the matching client is excluded', async () => {
  // Before lane mkt-f this scheduler honored NOTHING: it joins email_leads, and
  // the house do-not-contact flag lives on clients.marketing_excluded. It is
  // also reachable with nobody clicking: the PUBLIC capture-lead handler
  // auto-enrols new leads into 'Abandoned Quote Followup'.
  const nonce = `seqsupp-${Date.now()}`;
  const addr = `${nonce}@mkt-test.example`;
  const c = await seqPool.query(
    `INSERT INTO clients (name, email, marketing_excluded, marketing_excluded_reason)
     VALUES ($1,$2,true,'sequence gate test') RETURNING id`, [nonce, addr]);
  const l = await seqPool.query(
    `INSERT INTO email_leads (name,email,status,lead_source)
     VALUES ($1,$2,'active','quote_wizard') RETURNING id`, [nonce, addr]);
  try {
    assert.strictEqual(await wouldSend(l.rows[0].id), false,
      'an excluded client must not be drip-mailed through the lead identity');
  } finally {
    await seqPool.query('DELETE FROM email_leads WHERE id=$1', [l.rows[0].id]);
    await seqPool.query('DELETE FROM clients WHERE id=$1', [c.rows[0].id]);
  }
});

test('whitespace around a stored address does not defeat the gate', async () => {
  // The whole lane matches on lower(btrim(...)) for this reason.
  const nonce = `seqws-${Date.now()}`;
  const addr = `${nonce}@mkt-test.example`;
  const c = await seqPool.query(
    `INSERT INTO clients (name, email, marketing_excluded, marketing_excluded_reason)
     VALUES ($1,$2,true,'whitespace test') RETURNING id`, [nonce, `  ${addr.toUpperCase()} `]);
  const l = await seqPool.query(
    `INSERT INTO email_leads (name,email,status,lead_source)
     VALUES ($1,$2,'active','quote_wizard') RETURNING id`, [nonce, addr]);
  try {
    assert.strictEqual(await wouldSend(l.rows[0].id), false,
      'a padded, differently-cased client address must still suppress');
  } finally {
    await seqPool.query('DELETE FROM email_leads WHERE id=$1', [l.rows[0].id]);
    await seqPool.query('DELETE FROM clients WHERE id=$1', [c.rows[0].id]);
  }
});

test('an ordinary lead with no excluded client still sends', async () => {
  const nonce = `seqok-${Date.now()}`;
  const l = await seqPool.query(
    `INSERT INTO email_leads (name,email,status,lead_source)
     VALUES ($1,$2,'active','quote_wizard') RETURNING id`, [nonce, `${nonce}@mkt-test.example`]);
  try {
    assert.strictEqual(await wouldSend(l.rows[0].id), true, 'the gate must not over-suppress');
  } finally {
    await seqPool.query('DELETE FROM email_leads WHERE id=$1', [l.rows[0].id]);
  }
});
