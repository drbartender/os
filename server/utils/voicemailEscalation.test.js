require('dotenv').config();
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');

const esc = require('./voicemailEscalation');

// Every row this suite writes uses a recognizable CallSid prefix so cleanup can
// never touch a real row in the shared dev DB.
// A REAL-SHAPED sid, because this suite's subject is isCallSid-gated.
// `markEscalationAccepted` early-returns on anything failing /^CA[0-9a-f]{32}$/,
// so a readable prefix like 'CAtestesc' (non-hex letters, and only 32 chars
// total) silently writes nothing and the accept-gate assertions fail. 34 chars:
// 'CA' + exactly 32 lowercase hex. Verified against isCallSid before use.
// (voicemail.test.js's 'CAtestvm' helper is fine because nothing there is
// isCallSid-gated; do not copy that shape here.)
const sid = (n) => `CA${String(n).padStart(32, '0')}`;

async function cleanup() {
  // sid() is now all-numeric after 'CA', so clean up on the zero-padded run
  // this suite occupies rather than a readable prefix.
  await pool.query("DELETE FROM voicemail_delivery WHERE call_sid LIKE 'CA0000000000000000000000%'");
}
async function seed(n, line) {
  await pool.query(
    'INSERT INTO voicemail_delivery (call_sid, from_e164, line) VALUES ($1, $2, $3)',
    [sid(n), '+13125550147', line]
  );
}

beforeEach(cleanup);
after(async () => { await cleanup(); await pool.end(); });

test('claimEscalation wins once and returns the line, then loses', async () => {
  await seed(1, 'primary');
  const first = await esc.claimEscalation(sid(1));
  const second = await esc.claimEscalation(sid(1));
  assert.deepEqual(first, { line: 'primary' });
  // Twilio delivers a <Gather action> at least once. The second claim losing is
  // what stops a redelivered callback from placing a SECOND billed leg.
  assert.equal(second, null);
});

test('claimEscalation stamps escalated_at', async () => {
  await seed(2, 'zul');
  await esc.claimEscalation(sid(2));
  const { rows } = await pool.query('SELECT escalated_at FROM voicemail_delivery WHERE call_sid = $1', [sid(2)]);
  assert.ok(rows[0].escalated_at instanceof Date);
});

test('claimEscalation returns null for a call that was never registered', async () => {
  assert.equal(await esc.claimEscalation(sid(3)), null);
});

test('countEscalationsSince counts only escalated rows in the window', async () => {
  const before = await esc.countEscalationsSince(24);
  await seed(4, 'zul');
  assert.equal(await esc.countEscalationsSince(24), before, 'a missed call is not an escalation');
  await esc.claimEscalation(sid(4));
  assert.equal(await esc.countEscalationsSince(24), before + 1);
});

test('markEscalationAccepted then wasEscalationAccepted is the accept gate', async () => {
  await seed(7, 'zul');
  await esc.claimEscalation(sid(7));
  assert.equal(await esc.wasEscalationAccepted(sid(7)), false, 'not accepted until a keypress');
  await esc.markEscalationAccepted(sid(7));
  assert.equal(await esc.wasEscalationAccepted(sid(7)), true);
});

test('wasEscalationAccepted is false for an unknown call and a bad sid', async () => {
  // escalate/done must never mistake "row missing" for "a human took the call",
  // because that would hang up on a caller instead of recording them.
  assert.equal(await esc.wasEscalationAccepted(sid(8)), false);
  assert.equal(await esc.wasEscalationAccepted('not-a-sid'), false);
  assert.equal(await esc.wasEscalationAccepted(null), false);
});

test('markEscalationAccepted is idempotent and keeps the first timestamp', async () => {
  await seed(9, 'zul');
  await esc.claimEscalation(sid(9));
  await esc.markEscalationAccepted(sid(9));
  const { rows: first } = await pool.query('SELECT escalation_accepted_at FROM voicemail_delivery WHERE call_sid = $1', [sid(9)]);
  await esc.markEscalationAccepted(sid(9));
  const { rows: second } = await pool.query('SELECT escalation_accepted_at FROM voicemail_delivery WHERE call_sid = $1', [sid(9)]);
  assert.deepEqual(second[0].escalation_accepted_at, first[0].escalation_accepted_at);
});

test('isCallSid gates what may be echoed back through a query string', () => {
  assert.equal(esc.isCallSid('CA' + 'a'.repeat(32)), true);
  assert.equal(esc.isCallSid('CA' + 'A'.repeat(32)), false, 'lowercase hex only');
  assert.equal(esc.isCallSid('CA' + 'a'.repeat(31)), false);
  assert.equal(esc.isCallSid('../../etc/passwd'), false);
  assert.equal(esc.isCallSid(''), false);
  assert.equal(esc.isCallSid(undefined), false);
});

test('recordEscalationOutcome writes an allowed outcome', async () => {
  await seed(5, 'zul');
  await esc.claimEscalation(sid(5));
  await esc.recordEscalationOutcome({ callSid: sid(5), outcome: 'no_answer' });
  const { rows } = await pool.query('SELECT escalation_outcome FROM voicemail_delivery WHERE call_sid = $1', [sid(5)]);
  assert.equal(rows[0].escalation_outcome, 'no_answer');
});

test('recordEscalationOutcome refuses an off-list outcome instead of failing the row', async () => {
  await seed(6, 'zul');
  await esc.claimEscalation(sid(6));
  await esc.recordEscalationOutcome({ callSid: sid(6), outcome: 'banana' });
  const { rows } = await pool.query('SELECT escalation_outcome FROM voicemail_delivery WHERE call_sid = $1', [sid(6)]);
  assert.equal(rows[0].escalation_outcome, null, 'clamped to no write, never a CHECK violation');
});

test('claimEscalation is single-winner under simultaneous claims', async () => {
  // Sequential win-then-lose is also satisfied by a non-atomic SELECT-then-
  // UPDATE; only real concurrency pins the claim guarantee.
  await seed(10, 'primary');
  const results = await Promise.all(
    Array.from({ length: 10 }, () => esc.claimEscalation(sid(10)))
  );
  assert.equal(results.filter(Boolean).length, 1, 'exactly one billed leg');
});

test('countEscalationsSince honors the window unit and boundary', async () => {
  const before = await esc.countEscalationsSince(24);
  await seed(11, 'zul');
  await pool.query(
    `UPDATE voicemail_delivery SET escalated_at = NOW() - INTERVAL '25 hours' WHERE call_sid = $1`,
    [sid(11)]
  );
  assert.equal(await esc.countEscalationsSince(24), before, 'a 25h-old claim is outside a 24h window');
  assert.equal(await esc.countEscalationsSince(26), before + 1, 'and inside a 26h one (pins hours, not minutes)');
});

test('countEscalationsSince throws on a non-positive window instead of failing open', async () => {
  // A negative interval flips the predicate to the future and counts zero,
  // which would let the cap never trip.
  await assert.rejects(() => esc.countEscalationsSince(0), TypeError);
  await assert.rejects(() => esc.countEscalationsSince(-24), TypeError);
});

test('markEscalationAccepted refuses a never-claimed row', async () => {
  await seed(12, 'zul');
  await esc.markEscalationAccepted(sid(12));
  assert.equal(await esc.wasEscalationAccepted(sid(12)), false,
    'accepted-without-claimed must be unrepresentable');
});

test('claimEscalationUnderCap refuses to claim once the window is full', async () => {
  const base = await esc.countEscalationsSince(24);
  process.env.VM_ESCALATION_DAILY_CAP = String(base + 1);
  try {
    await seed(20, 'zul');
    await seed(21, 'zul');
    const first = await esc.claimEscalationUnderCap(sid(20));
    assert.deepEqual(first, { capped: false, claim: { line: 'zul' } });
    const second = await esc.claimEscalationUnderCap(sid(21));
    assert.deepEqual(second, { capped: true, claim: null });
    const { rows } = await pool.query(
      'SELECT escalated_at FROM voicemail_delivery WHERE call_sid = $1', [sid(21)]
    );
    assert.equal(rows[0].escalated_at, null, 'a capped refusal consumes no claim');
  } finally {
    delete process.env.VM_ESCALATION_DAILY_CAP;
  }
});

test('claimEscalationUnderCap admits exactly cap slots under simultaneous pressure', async () => {
  // THE toll-fraud bound. Check-then-claim as two statements admits
  // cap + concurrency legs; the advisory-lock claim must admit exactly cap.
  const base = await esc.countEscalationsSince(24);
  process.env.VM_ESCALATION_DAILY_CAP = String(base + 3);
  try {
    for (let n = 30; n < 40; n += 1) await seed(n, 'zul');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => esc.claimEscalationUnderCap(sid(30 + i)))
    );
    assert.equal(results.filter((r) => r.claim).length, 3, 'the cap is a hard bound, not advisory');
    assert.equal(results.filter((r) => r.capped).length, 7);
  } finally {
    delete process.env.VM_ESCALATION_DAILY_CAP;
  }
});

test('escalationDailyCap defaults to 25 and honors a positive override', () => {
  delete process.env.VM_ESCALATION_DAILY_CAP;
  assert.equal(esc.escalationDailyCap(), 25);
  process.env.VM_ESCALATION_DAILY_CAP = '5';
  assert.equal(esc.escalationDailyCap(), 5);
  process.env.VM_ESCALATION_DAILY_CAP = '0';
  assert.equal(esc.escalationDailyCap(), 25, 'a nonsense value falls back to the default');
  delete process.env.VM_ESCALATION_DAILY_CAP;
});
