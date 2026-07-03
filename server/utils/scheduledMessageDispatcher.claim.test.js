require('dotenv').config();
// Force notifications off regardless of local .env: this test drives dispatchRow
// with a stub handler, but keep the global off so nothing in the pipeline can send.
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const dispatcher = require('./scheduledMessageDispatcher');

if (process.env.NODE_ENV === 'production') {
  throw new Error('scheduledMessageDispatcher.claim.test.js refuses to run against production');
}

// ── Per-row claim: exactly-once send under concurrent dispatch ────────────────
// Before this fix, a batch was SELECTed into memory and dispatchRow sent THEN
// marked the row 'sent'; two overlapping ticks / instances could both select the
// same pending row and both send. The fix claims each row atomically
// ('pending' -> 'processing' via UPDATE ... WHERE status='pending' RETURNING)
// before doing any handler work, so only the worker whose UPDATE returns the row
// sends it.
//
// This is the util-level gate/race the plan asks for: two pool connections
// (dispatchRow uses the shared pool) race the SAME row's claim; exactly one wins
// and the stub handler fires exactly once. Discrimination check: temporarily
// weaken the claim in dispatchRow to `WHERE id = $1` (drop `AND status='pending'`)
// and both racers proceed — the handler fires twice and this test fails.

const PREFIX = 'smd-claim-test-';
const MSG_TYPE = '__smd_claim_test__';

let clientId, proposalId, rowId, rowShape;
let handlerCalls = 0;

before(async () => {
  const cl = await pool.query(
    `INSERT INTO clients (name, email, email_status) VALUES ($1, $2, 'ok') RETURNING id`,
    ['Dispatcher Claim Test Client', `${PREFIX}client@example.com`]
  );
  clientId = cl.rows[0].id;

  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'deposit_paid', 'wedding', '5:00 PM', 4, 3000, 0)
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  const sm = await pool.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ($1, 'proposal', $2, 'client', $3, 'email', NOW(), 'pending')
     RETURNING id, entity_id, entity_type, message_type, recipient_type, recipient_id, channel,
               scheduled_for, suppression_key, payload`,
    [proposalId, MSG_TYPE, clientId]
  );
  rowShape = sm.rows[0];
  rowId = rowShape.id;

  // Register a stub handler that just counts invocations — it is the "send".
  dispatcher.registerHandler(MSG_TYPE, async () => { handlerCalls += 1; }, {
    category: 'operational',
    priority: 3,
  });
});

after(async () => {
  dispatcher._clearHandlersForTest();
  if (rowId) await pool.query('DELETE FROM scheduled_messages WHERE id = $1', [rowId]);
  if (proposalId) await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('two concurrent dispatchRow calls send the row exactly once (claim wins for one)', async () => {
  const dispatchRow = dispatcher._dispatchRowForTest;

  // Race the same row through two concurrent dispatchRow calls. Each independently
  // runs the atomic claim; Postgres serializes the two UPDATE ... WHERE
  // status='pending' statements on the row, so exactly one returns a row and
  // proceeds to the handler; the other gets rowCount 0 and returns early. Pass
  // separate copies so a channel rewrite on the winner cannot touch the loser's
  // object.
  await Promise.all([
    dispatchRow({ ...rowShape }),
    dispatchRow({ ...rowShape }),
  ]);

  assert.equal(handlerCalls, 1, 'the stub handler (the send) must fire exactly once across the race');

  const { rows } = await pool.query('SELECT status FROM scheduled_messages WHERE id = $1', [rowId]);
  assert.equal(rows[0].status, 'sent', 'the winning claim must drive the row to sent exactly once');
});

test('reaper: a stranded processing row is reactivated and dispatched; fresh claims are untouched', async () => {
  // Stranded: claimed 20 minutes ago by a process that died mid-send.
  const { rows: [stranded] } = await pool.query(
    `INSERT INTO scheduled_messages (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, status, claimed_at)
     VALUES ('proposal', 999901, 'claim_test_stranded', 'client', 999901, 'email', NOW() - INTERVAL '30 minutes', 'processing', NOW() - INTERVAL '20 minutes')
     RETURNING id`);
  // Fresh: claimed seconds ago by a (hypothetical) live instance.
  const { rows: [fresh] } = await pool.query(
    `INSERT INTO scheduled_messages (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, status, claimed_at)
     VALUES ('proposal', 999902, 'claim_test_fresh', 'client', 999902, 'email', NOW() - INTERVAL '30 minutes', 'processing', NOW())
     RETURNING id`);
  try {
    // Run only the reaper-bearing tick entry; no handler is registered for these
    // message types, so a reaped row settles via the no-handler terminal path
    // rather than sending anything.
    await dispatcher.dispatchPending();
    const { rows: [s] } = await pool.query('SELECT status, claimed_at FROM scheduled_messages WHERE id = $1', [stranded.id]);
    const { rows: [f] } = await pool.query('SELECT status FROM scheduled_messages WHERE id = $1', [fresh.id]);
    assert.notStrictEqual(s.status, 'processing', 'stranded row was reaped out of processing');
    assert.strictEqual(f.status, 'processing', 'fresh claim untouched');
  } finally {
    await pool.query('DELETE FROM scheduled_messages WHERE id IN ($1, $2)', [stranded.id, fresh.id]);
  }
});
